/**
 * 技能用量日志的事件类型与单行序列化。
 *
 * 本模块只依赖 node 标准库，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 */
import fs from "node:fs";
import path from "node:path";

import { EXTENSION_DIR_NAME } from "./scope.ts";

/** 触达通道：模型读 SKILL.md 记为 read，用户 `/skill:` 显式调用记为 explicit。 */
export type UsageVia = "read" | "explicit";

export interface UsageEvent {
	ts: string;
	via: UsageVia;
	path: string;
	session: string;
	cwd: string;
}

/** 全局日志：<agentDir>/extensions/pi-skills/usage.jsonl */
export function usageLogPath(agentDir: string): string {
	return path.join(agentDir, "extensions", EXTENSION_DIR_NAME, "usage.jsonl");
}

function isVia(value: unknown): value is UsageVia {
	return value === "read" || value === "explicit";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** 把 Windows 分隔符换成 `/`，其余字符原样保留。 */
function toPosix(target: string): string {
	return target.replaceAll("\\", "/");
}

/** 只认以 /SKILL.md 结尾的路径；`SKILL.md` 本身（无父目录）不算。 */
export function isSkillFile(rawPath: string): boolean {
	return toPosix(rawPath).endsWith("/SKILL.md");
}

/** 绝对路径：以 `/` 开头，或以盘符（如 `D:`）开头。 */
function isAbsolutePath(posixPath: string): boolean {
	return posixPath.startsWith("/") || posixPath[1] === ":";
}

/**
 * 归一化为 `/` 分隔的路径：相对路径按 cwd 展开，绝对路径原样处理。
 * 不做大小写转换，也不解析符号链接。绝对路径分支不使用 cwd，允许传空串。
 */
export function normalizeSkillPath(rawPath: string, cwd: string): string {
	const posixPath = toPosix(rawPath);
	const joined = isAbsolutePath(posixPath) ? posixPath : path.posix.join(toPosix(cwd), posixPath);
	return path.posix.normalize(joined);
}

/** 取 SKILL.md 的父目录名作为技能名。入参须已归一化。 */
export function skillNameOf(normalizedPath: string): string {
	const segments = normalizedPath.split("/");
	return segments[segments.length - 2] ?? "";
}

/** 序列化为单行 JSON，含行尾换行，便于追加写入。 */
export function serializeEvent(event: UsageEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/** 解析一行日志；非法 JSON 或字段缺失、类型不符时返回 undefined。 */
export function parseEvent(line: string): UsageEvent | undefined {
	let data: unknown;
	try {
		data = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object") return undefined;
	const event = data as Record<string, unknown>;
	if (!isNonEmptyString(event.ts)) return undefined;
	if (!isVia(event.via)) return undefined;
	if (!isNonEmptyString(event.path)) return undefined;
	if (!isNonEmptyString(event.session)) return undefined;
	if (!isNonEmptyString(event.cwd)) return undefined;
	return {
		ts: event.ts,
		via: event.via,
		path: event.path,
		session: event.session,
		cwd: event.cwd,
	};
}

/**
 * 读取全部事件。文件不存在或不可读时返回空数组；
 * 无法解析的行（含末尾未写完的截断行）被跳过，其余记录照常返回。
 */
export function readEvents(filePath: string): UsageEvent[] {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const events: UsageEvent[] = [];
	for (const line of text.split("\n")) {
		const event = parseEvent(line);
		if (event) events.push(event);
	}
	return events;
}

/**
 * 追加一条事件。日志是尽力而为的旁路：
 * 目录缺失时自动创建，任何写入失败都静默忽略，不向调用方抛错。
 */
export function appendEvent(filePath: string, event: UsageEvent): void {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.appendFileSync(filePath, serializeEvent(event), "utf8");
	} catch {
		// 记不上就算了，技能本身照常工作。
	}
}

/** 五个累积窗口，`counts` 与下标同序。 */
export const USAGE_WINDOWS: readonly { label: string; hours: number }[] = [
	{ label: "3天", hours: 72 },
	{ label: "7天", hours: 168 },
	{ label: "1月", hours: 720 },
	{ label: "3月", hours: 2160 },
	{ label: "半年", hours: 4320 },
];

export interface UsageStats {
	/** 与 `USAGE_WINDOWS` 同序的累积次数。 */
	counts: number[];
	/** 全部窗口之外的调用也计入。 */
	total: number;
	lastUsed?: string;
}

function statsOf(stats: Map<string, UsageStats>, name: string): UsageStats {
	const existing = stats.get(name);
	if (existing) return existing;
	const created: UsageStats = { counts: USAGE_WINDOWS.map(() => 0), total: 0 };
	stats.set(name, created);
	return created;
}

/**
 * 按 `skillNameOf(path)` 聚合事件。窗口按距 `now` 的滚动小时算，累积计数。
 * `ts` 无法解析的事件整条丢弃：既不进任何窗口，也不计 `total`，
 * 单独出现时也不会在结果里留下该 skill 的条目。
 */
export function aggregate(events: UsageEvent[], now: Date): Map<string, UsageStats> {
	const stats = new Map<string, UsageStats>();
	for (const event of events) {
		const time = Date.parse(event.ts);
		if (Number.isNaN(time)) continue;
		const entry = statsOf(stats, skillNameOf(event.path));
		entry.total += 1;
		const ageHours = (now.getTime() - time) / 3600_000;
		USAGE_WINDOWS.forEach((window, i) => {
			if (ageHours <= window.hours) entry.counts[i] += 1;
		});
		if (entry.lastUsed === undefined || time > Date.parse(entry.lastUsed)) entry.lastUsed = event.ts;
	}
	return stats;
}

/**
 * 统计起点：最早一条事件的 `ts` 原文，没有可用记录时返回 undefined。
 * 时间戳无法解析的事件被跳过（它们不可能成为最小值），返回的字符串保持原写法。
 */
export function statsStart(events: UsageEvent[]): string | undefined {
	let start: string | undefined;
	let earliest = Number.POSITIVE_INFINITY;
	for (const event of events) {
		const time = Date.parse(event.ts);
		if (time < earliest) {
			earliest = time;
			start = event.ts;
		}
	}
	return start;
}

/** 统计表里的一行：显示名、与 `USAGE_WINDOWS` 同序的次数、最后使用时间。 */
export interface StatsEntry {
	name: string;
	counts: number[];
	lastUsed?: string;
}

/** 统计表的三段：已加载且有记录、有记录但当前未加载、已加载但无记录。 */
export interface StatsInput {
	loaded: StatsEntry[];
	unloaded: StatsEntry[];
	unrecorded: string[];
}

/** 排序主键所在的窗口下标：最长的「半年」窗口。 */
const HALF_YEAR_INDEX = USAGE_WINDOWS.length - 1;

function byName(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** 半年次数降序，次数相同按显示名升序。 */
function byUsage(a: StatsEntry, b: StatsEntry): number {
	const diff = (b.counts[HALF_YEAR_INDEX] ?? 0) - (a.counts[HALF_YEAR_INDEX] ?? 0);
	return diff !== 0 ? diff : byName(a.name, b.name);
}

/**
 * 把日志聚合结果与当前已加载的 skill 对照，分成三段。
 *
 * 配对键两侧同源，都是 SKILL.md 的父目录名：事件侧由 `aggregate` 保证，已加载侧用
 * `skillNameOf(normalizeSkillPath(filePath, ""))` 算出。不拿 pi 的 `name` 配对——
 * `name` 允许与目录名不同，两个来源的键一旦错开，同一个 skill 的调用会被拆到两行。
 * 显示名则反过来：已加载的行有 pi 的 `name` 可用，未加载的行（幽灵）没有，只能用目录名。
 */
export function buildStats(
	events: UsageEvent[],
	loadedSkills: Array<{ name: string; filePath: string }>,
	now: Date,
): StatsInput {
	const stats = aggregate(events, now);
	/** 已加载 skill 的配对键 → 显示名。 */
	const loadedNames = new Map(
		loadedSkills.map((skill) => [skillNameOf(normalizeSkillPath(skill.filePath, "")), skill.name]),
	);

	const loaded: StatsEntry[] = [];
	const unloaded: StatsEntry[] = [];
	for (const [key, usage] of stats) {
		const name = loadedNames.get(key);
		const entry: StatsEntry = { name: name ?? key, counts: usage.counts, lastUsed: usage.lastUsed };
		(name === undefined ? unloaded : loaded).push(entry);
	}
	loaded.sort(byUsage);
	unloaded.sort(byUsage);

	const unrecorded = loadedSkills
		.filter((skill) => !stats.has(skillNameOf(normalizeSkillPath(skill.filePath, ""))))
		.map((skill) => skill.name)
		.sort(byName);

	return { loaded, unloaded, unrecorded };
}

/** `tool_execution_end` 事件里与本判定相关的字段。 */
export interface ReadEnd {
	durationMs?: number;
	isError: boolean;
}

/**
 * read 通道的提交判据：只有真的执行过且没出错才记为一次使用。
 *
 * `tool_execution_start` 在工具执行**之前**发出，被 block、工具不存在、中途中断的调用同样有 start 事件，
 * 所以「有 start」不等于「跑过」。这些没跑成的路径都不填 `durationMs`（只有真执行完的才带上），
 * 因此 `durationMs === undefined` 是「没执行」的精确信号，再用 `isError` 把「跑了但读失败」挡掉。
 */
export function shouldCommitRead(end: ReadEnd): boolean {
	return end.durationMs !== undefined && end.isError === false;
}

/**
 * 尚未配对的 read 调用：`tool_execution_start` 记账，`tool_execution_end` 取走。
 * 取走即删除，同一个 toolCallId 不会被提交两次；会话结束时整体 `clear`。
 */
export class PendingReads {
	private readonly paths = new Map<string, string>();

	record(toolCallId: string, skillPath: string): void {
		this.paths.set(toolCallId, skillPath);
	}

	take(toolCallId: string): string | undefined {
		const skillPath = this.paths.get(toolCallId);
		this.paths.delete(toolCallId);
		return skillPath;
	}

	clear(): void {
		this.paths.clear();
	}

	get size(): number {
		return this.paths.size;
	}
}

/**
 * explicit 通道的判据：user 消息里是否触发了 `/skill:<name>`，命中则给出归一化后的 SKILL.md 路径。
 *
 * `parse` 由调用方注入（生产代码传 pi 的 `parseSkillBlock`），本模块因此不必 import pi 运行时。
 * 只认第一个能解出字符串 `location` 的文本块，其余情况（非 user、content 不是数组、没有 skill 块）
 * 一律返回 undefined。
 */
export function explicitSkillPath(
	message: { role?: unknown; content?: unknown },
	parse: (text: string) => { location?: unknown } | null,
	cwd: string,
): string | undefined {
	if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		const text = (block as { text?: unknown } | null)?.text;
		if (typeof text !== "string") continue;
		const location = parse(text)?.location;
		if (typeof location !== "string") continue;
		return normalizeSkillPath(location, cwd);
	}
	return undefined;
}
