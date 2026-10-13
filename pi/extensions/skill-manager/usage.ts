/**
 * 技能用量日志的事件类型与单行序列化。
 *
 * 本模块只依赖 node 标准库，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 */
import path from "node:path";

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
	return path.join(agentDir, "extensions", "pi-skills", "usage.jsonl");
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
