/**
 * 清单文本表的渲染。
 *
 * 本模块只依赖类型，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 */
import type { SkillEntry } from "./skills.ts";
import type { ResolvedSetting, ScopeName } from "./scope.ts";

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
