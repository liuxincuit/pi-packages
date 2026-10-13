/**
 * 清单文本表与用量统计表的渲染。
 *
 * 本模块不 import pi 运行时，只用到 `usage.ts` 的窗口定义与类型，因此可以用 `node --test` 直接运行。
 */
import type { SkillEntry } from "./skills.ts";
import type { ResolvedSetting, ScopeName } from "./scope.ts";
import { USAGE_WINDOWS, type StatsEntry, type StatsInput } from "./usage.ts";

const WIDE_RANGES: Array<[number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f300, 0x1f64f],
	[0x1f900, 0x1f9ff],
	[0x20000, 0x3fffd],
];

function isWide(code: number): boolean {
	return WIDE_RANGES.some(([start, end]) => code >= start && code <= end);
}

/** 终端显示宽度：全角与宽字符按 2 计。 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		width += isWide(code) ? 2 : 1;
	}
	return width;
}

function pad(text: string, width: number): string {
	const gap = width - displayWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (displayWidth(flat) <= max) return flat;
	let out = "";
	let width = 0;
	for (const char of flat) {
		const charWidth = displayWidth(char);
		if (width + charWidth > max - 1) break;
		out += char;
		width += charWidth;
	}
	return `${out}…`;
}

const SCOPE_LABELS: Record<ScopeName, string> = {
	session: "会话",
	project: "项目",
	global: "全局",
};

/** skill 的来源标签，用于区分全局、项目与包贡献。 */
export function sourceLabel(entry: SkillEntry): string {
	if (entry.origin === "package") return "package";
	if (entry.scope === "unknown") return "unknown";
	return entry.scope;
}

/** 模型是否可见。作者声明隐藏优先于用户设定。 */
export function isVisible(entry: SkillEntry, resolved: ResolvedSetting | undefined): boolean {
	if (entry.disableModelInvocation) return false;
	return resolved?.value !== "disabled";
}

/** 状态列文本：区分「作者声明隐藏」与「被禁用」两类原因。 */
export function statusLabel(entry: SkillEntry, resolved: ResolvedSetting | undefined): string {
	if (entry.disableModelInvocation) {
		return resolved?.value === "enabled" ? "作者声明隐藏（启用设定无效）" : "作者声明隐藏";
	}
	if (!resolved) return "默认";
	const scope = SCOPE_LABELS[resolved.scope];
	return resolved.value === "disabled" ? `禁用(${scope})` : `启用(${scope})`;
}

export interface TableOptions {
	/** 描述列的最大显示宽度，超出截断。默认 44。 */
	descriptionWidth?: number;
}

/** 渲染清单表格。空列表返回一行提示。 */
export function renderTable(
	entries: SkillEntry[],
	resolved: Map<string, ResolvedSetting>,
	options: TableOptions = {},
): string {
	if (entries.length === 0) return "没有可展示的 skill。";

	const descriptionWidth = options.descriptionWidth ?? 44;
	const rows = entries.map((entry) => {
		const setting = resolved.get(entry.name);
		return {
			name: entry.name,
			visible: isVisible(entry, setting) ? "yes" : "no",
			source: sourceLabel(entry),
			status: statusLabel(entry, setting),
			description: truncate(entry.description, descriptionWidth),
		};
	});

	const width = {
		name: Math.max(displayWidth("名称"), ...rows.map((row) => displayWidth(row.name))),
		visible: Math.max(displayWidth("可见"), ...rows.map((row) => displayWidth(row.visible))),
		source: Math.max(displayWidth("来源"), ...rows.map((row) => displayWidth(row.source))),
		status: Math.max(displayWidth("状态"), ...rows.map((row) => displayWidth(row.status))),
	};

	const lines = [
		`  ${pad("名称", width.name)}  ${pad("可见", width.visible)}  ${pad("来源", width.source)}  ${pad("状态", width.status)}  描述`,
	];
	for (const row of rows) {
		lines.push(
			`  ${pad(row.name, width.name)}  ${pad(row.visible, width.visible)}  ${pad(row.source, width.source)}  ${pad(row.status, width.status)}  ${row.description}`,
		);
	}
	return lines.join("\n");
}

const NAME_HEADER = "名称";
const LAST_USED_HEADER = "最后使用";
const SECTION_LOADED = "当前加载";
const SECTION_UNLOADED = "当前未加载";
const SECTION_UNRECORDED = "当前加载但无记录";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** 一个月按 30 天算；不足一月不进入「个月前」的写法。 */
const MONTH_DAYS = 30;

/** 覆盖时长最长的窗口：起点比它更近时，该窗口的次数必然少于真实值。 */
const LONGEST_WINDOW = USAGE_WINDOWS.reduce((longest, window) => (window.hours > longest.hours ? window : longest));

export interface StatsRenderOptions {
	/** 当前时刻，用来算「最后使用」的距今时长。 */
	now: Date;
	/** 统计起点（ISO 时间串）。缺省表示日志里没有任何可用记录。 */
	start?: string;
	/** 名称列的最大显示宽度。缺省取全部行里最长的名称。 */
	nameWidth?: number;
}

/** 「最后使用」列的文案：今天 / 昨天 / `<n>天前` / `<n>个月前`。 */
function lastUsedLabel(lastUsed: string | undefined, now: Date): string {
	const time = lastUsed === undefined ? Number.NaN : Date.parse(lastUsed);
	if (Number.isNaN(time)) return "-";
	// 时钟回拨时差值可能为负，按「今天」处理，不出现「-1 天前」。
	const days = Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
	if (days === 0) return "今天";
	if (days === 1) return "昨天";
	if (days < MONTH_DAYS) return `${days}天前`;
	return `${Math.floor(days / MONTH_DAYS)}个月前`;
}

/** 右对齐：把 `text` 顶到 `width` 的右缘。 */
function padLeft(text: string, width: number): string {
	const gap = width - displayWidth(text);
	return gap > 0 ? " ".repeat(gap) + text : text;
}

/**
 * 统计起点标注：`统计自 <时间> 起`，起点距今短于最长窗口时补一句该窗口覆盖不完整。
 *
 * 短于最长窗口时，该窗口的次数必然少算：日志里 0 的含义是「自起点起没记录过」，
 * 而窗口没被覆盖满时连这一句都不成立，不说清楚用户会把 0 读成「从未使用」。
 * 起点缺省（日志里没有任何可用记录）或无法解析时不输出该行。
 */
function startLine(start: string | undefined, now: Date): string | undefined {
	if (start === undefined) return undefined;
	const time = Date.parse(start);
	if (Number.isNaN(time)) return undefined;
	// 用 UTC 的 `YYYY-MM-DD HH:MM`，不引入本机时区与 locale 依赖。
	const shown = new Date(time).toISOString().slice(0, 16).replace("T", " ");
	if (now.getTime() - time >= LONGEST_WINDOW.hours * HOUR_MS) return `统计自 ${shown} 起`;
	return `统计自 ${shown} 起（不足${LONGEST_WINDOW.label}，${LONGEST_WINDOW.label}窗口覆盖不完整）`;
}

/**
 * 渲染用量统计表：三段各自「标题 + 表头 + 数据行」，空段整段跳过。
 *
 * 名称列宽与五个数字列宽在三段之间统一算，数字列宽取该列表头与全部数字的较大者，
 * 这样同一列在「当前加载」与「当前未加载」两段里对齐。
 * 起点已知时，表尾再追加一行统计起点标注（见 `startLine`）。
 */
export function renderStats(input: StatsInput, options: StatsRenderOptions): string {
	const recorded = [...input.loaded, ...input.unloaded];
	const cells = recorded.map((entry) => USAGE_WINDOWS.map((_, i) => String(entry.counts[i] ?? 0)));
	const numberWidths = USAGE_WINDOWS.map((window, col) =>
		cells.reduce((max, row) => Math.max(max, displayWidth(row[col] ?? "")), displayWidth(window.label)),
	);
	const longestName = recorded.reduce((max, entry) => Math.max(max, displayWidth(entry.name)), 0);
	const nameWidth = Math.max(displayWidth(NAME_HEADER), options.nameWidth ?? longestName);

	const header = `  ${pad(NAME_HEADER, nameWidth)}  ${USAGE_WINDOWS.map((window, col) => pad(window.label, numberWidths[col]!)).join("  ")}  ${LAST_USED_HEADER}`;
	const drawRow = (entry: StatsEntry, index: number): string => {
		const numbers = cells[index]!.map((cell, col) => padLeft(cell, numberWidths[col]!)).join("  ");
		const name = pad(truncate(entry.name, nameWidth), nameWidth);
		return `  ${name}  ${numbers}  ${lastUsedLabel(entry.lastUsed, options.now)}`;
	};

	const lines: string[] = [];
	const section = (title: string, rows: string[]): void => {
		if (rows.length > 0) lines.push(title, header, ...rows);
	};
	section(SECTION_LOADED, input.loaded.map((entry, i) => drawRow(entry, i)));
	section(SECTION_UNLOADED, input.unloaded.map((entry, i) => drawRow(entry, input.loaded.length + i)));
	if (input.unrecorded.length > 0) lines.push(SECTION_UNRECORDED, `  ${input.unrecorded.join("、")}`);

	const body = lines.length > 0 ? lines.join("\n") : "没有可展示的统计。";
	const footer = startLine(options.start, options.now);
	return footer === undefined ? body : `${body}\n${footer}`;
}
