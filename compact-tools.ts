import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	createBashTool,
	createEditTool,
	createLocalBashOperations,
	createReadTool,
	createWriteTool,
	formatSize,
	keyHint,
	type BashOperations,
} from "@earendil-works/pi-coding-agent";

const BORDER = "\u2502 "; // │

const ENV_FILE = join(homedir(), ".pi", "agent", ".env");

/** 解析 KEY=VALUE 格式，支持 # 注释、空行、引号；文件不存在或为空返回 {} */
function parseEnvFile(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(file)) return out;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq <= 0) continue;
		const key = t.slice(0, eq).trim();
		let value = t.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** bash 工具专属环境：移除代理变量并注入 ~/.pi/agent/.env；无 .env 时不改变 env */
function bashEnvHook({ command, cwd, env }: { command: string; cwd: string; env: Record<string, string> }) {
	if (!existsSync(ENV_FILE)) return { command, cwd, env };
	const clean = { ...env };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
		delete clean[key];
	}
	Object.assign(clean, parseEnvFile(ENV_FILE));
	return { command, cwd, env: clean };
}

/**
 * bash 默认超时：LLM 未显式传 timeout 时按默认时长执行，防止 find 全盘搜索
 * 之类的长驻命令无限阻塞；LLM 显式传入的 timeout 原样透传并保持 pi 原生
 * 错误格式，只有默认注入触发的超时消息附加说明。
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export function createBashTimeoutOps(
	base: BashOperations,
	defaultTimeoutSeconds = DEFAULT_BASH_TIMEOUT_SECONDS,
): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const injected = options.timeout === undefined;
			const timeout = injected ? defaultTimeoutSeconds : options.timeout;
			try {
				return await base.exec(command, cwd, { ...options, timeout });
			} catch (err) {
				// pi 层把 "timeout:<n>" 错误渲染为 "Command timed out after <n> seconds"，
				// 在 <n> 后附带默认超时说明，让 LLM 区分自己设的超时和默认超时。
				if (injected && err instanceof Error && err.message.startsWith("timeout:")) {
					throw new Error(
						`timeout:${defaultTimeoutSeconds} (default timeout; no explicit timeout was provided)`,
					);
				}
				throw err;
			}
		},
	};
}

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 200;

interface SpinnerState {
	frame: number;
	start: number;
	timer?: ReturnType<typeof setInterval>;
}

// Per-tool-call spinner state; keyed by toolCallId so concurrent tools spin independently.
const spinnerStates = new Map<string, SpinnerState>();

const MAX_TITLE_LEN = 100;
const MAX_CONTENT_LINE_LEN = 80;

// Commands whose successful completion normally produces no output.
const QUIET_COMMAND_PREFIXES = [
	"cd", "mkdir", "rmdir", "rm", "mv", "cp", "touch", "chmod", "chown",
	"git add", "git checkout", "git switch", "git restore", "git reset", "git clean",
	"npm install", "pnpm install", "yarn install", "bun install",
	"pip install", "poetry install", "cargo fetch", "go mod tidy",
] as const;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
	return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function getOrCreateSpinnerState(toolCallId: string): SpinnerState {
	let state = spinnerStates.get(toolCallId);
	if (!state) {
		state = { frame: 0, start: Date.now() };
		spinnerStates.set(toolCallId, state);
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined): void {
	if (!toolCallId) return;
	const state = spinnerStates.get(toolCallId);
	if (!state) return;
	if (state.timer) clearInterval(state.timer);
	spinnerStates.delete(toolCallId);
}

function titleLine(
	label: string,
	detail: string,
	t: any,
	color: string,
	parts?: Array<{ text: string; color?: string }>,
): string {
	const border = t.fg(color, t.bold(BORDER));
	const suffix = (parts ?? []).map((p) => " " + t.fg(p.color ?? "muted", p.text)).join("");
	if (color === "error") {
		return border + t.fg(color, t.bold(label + " ")) + t.fg(color, detail) + suffix;
	}
	return border + t.fg(color, t.bold(label + " ")) + detail + suffix;
}

function addBorder(text: string, t: any, color?: string): string {
	const borderColor = color ? t.fg(color, BORDER) : t.fg("border", BORDER);
	return text.split("\n").map((l: string) => borderColor + l).join("\n");
}

function truncateDetail(detail: string): string {
	const firstLine = detail.split("\n")[0] || "";
	if (firstLine.length <= MAX_TITLE_LEN) return firstLine;
	return firstLine.slice(0, MAX_TITLE_LEN - 1) + "…";
}

/** Ensure every line in text is at most maxLen characters, hard-break if needed */
function hardWrap(text: string, maxLen: number): string {
	return text.split("\n").map((line) => {
		if (line.length <= maxLen) return line;
		const chunks: string[] = [];
		for (let i = 0; i < line.length; i += maxLen) {
			chunks.push(line.slice(i, i + maxLen));
		}
		return chunks.join("\n");
	}).join("\n");
}

function splitLines(text: string): string[] {
	if (!text) return [];
	return text.replace(/\r/g, "").split("\n").map((line) => line.replace(/\t/g, "    "));
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	const next = [...lines];
	while (next.length > 0 && next[next.length - 1]?.trim().length === 0) {
		next.pop();
	}
	return next;
}

function collapseConsecutiveEmptyLines(lines: string[], maxAllowed: number): string[] {
	if (maxAllowed <= 0) {
		return lines.filter((line) => line.trim().length > 0);
	}
	const compacted: string[] = [];
	let consecutiveEmpty = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			consecutiveEmpty++;
			if (consecutiveEmpty > maxAllowed) continue;
		} else {
			consecutiveEmpty = 0;
		}
		compacted.push(line);
	}
	return compacted;
}

function prepareOutputLines(text: string, expanded: boolean): string[] {
	const lines = trimTrailingEmptyLines(splitLines(text));
	return expanded ? lines : collapseConsecutiveEmptyLines(lines, 1);
}

function countNonEmptyLines(lines: string[]): number {
	return lines.filter((line) => line.trim().length > 0).length;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function shortenPath(inputPath: string | undefined): string {
	if (!inputPath) return "";
	const home = homedir();
	return inputPath.startsWith(home) ? `~${inputPath.slice(home.length)}` : inputPath;
}

function extractTextOutput(result: any): string {
	const blocks = Array.isArray(result?.content) ? result.content : [];
	return blocks
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n");
}

function toRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

// --- ANSI sanitization (adapted from pi-tool-display, MIT) ---
// Strip background SGR parameters from raw tool output so themed output
// does not get background-color artifacts, while foreground colors survive.

const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;

function expandSgrReset(param: number): readonly number[] | undefined {
	return param === 0 ? STYLE_RESET_PARAMS : undefined;
}

function toSgrParams(rawParams: string): number[] {
	if (!rawParams.trim()) return [0];
	return rawParams
		.split(";")
		.map((token) => Number.parseInt(token, 10))
		.filter((value) => Number.isFinite(value));
}

function readSgrColorSequence(params: readonly number[], index: number): number[] | undefined {
	const param = params[index];
	if (param !== 38 && param !== 48) return undefined;
	const colorMode = params[index + 1];
	if (colorMode === 5) {
		const colorValue = params[index + 2];
		return typeof colorValue === "number" && Number.isFinite(colorValue) ? [param, colorMode, colorValue] : undefined;
	}
	if (colorMode === 2) {
		const [red, green, blue] = [params[index + 2], params[index + 3], params[index + 4]];
		return [red, green, blue].every((v) => typeof v === "number" && Number.isFinite(v))
			? [param, colorMode, red, green, blue]
			: undefined;
	}
	return undefined;
}

function stripBackgroundSgrParams(params: readonly number[]): number[] {
	const sanitized: number[] = [];
	for (let index = 0; index < params.length; index++) {
		const param = params[index] ?? 0;
		if (param === 0) {
			sanitized.push(...(expandSgrReset(param) ?? []));
			continue;
		}
		if (param === 49 || (param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
			continue;
		}
		if (param === 38 || param === 48) {
			const sequence = readSgrColorSequence(params, index);
			if (sequence) {
				if (param === 38) sanitized.push(...sequence);
				index += sequence.length - 1;
				continue;
			}
			const advance = params[index + 1] === 5 ? 2 : params[index + 1] === 2 ? 4 : 0;
			if (advance > 0) {
				index += advance;
				if (param === 38) sanitized.push(param);
				continue;
			}
		}
		sanitized.push(param);
	}
	return sanitized;
}

function sanitizeAnsiForThemedOutput(text: string): string {
	if (!text || !text.includes("\x1b[")) return text;
	return text.replace(ANSI_SGR_PATTERN, (_sequence, rawParams: string) => {
		const parsed = toSgrParams(rawParams);
		if (parsed.length === 0) return "";
		const sanitized = stripBackgroundSgrParams(parsed);
		if (sanitized.length === 0) return "";
		return `\x1b[${sanitized.join(";")}m`;
	});
}

function isLikelyQuietCommand(command: string | undefined): boolean {
	if (!command) return false;
	const normalized = command.trim().toLowerCase();
	const primarySegment = normalized
		.split(/&&|\|\||;/)
		.map((segment) => segment.trim())
		.find((segment) => segment.length > 0);
	if (!primarySegment) return false;
	for (const prefix of QUIET_COMMAND_PREFIXES) {
		if (primarySegment === prefix || primarySegment.startsWith(`${prefix} `)) return true;
	}
	return false;
}

function countTextLines(value: unknown): number {
	return typeof value === "string" ? splitLines(value).length : 0;
}

function countEditLines(args: any): number {
	const record = toRecord(args);
	const edits = Array.isArray(record.edits) ? record.edits : [];
	if (edits.length > 0) {
		return edits.reduce<number>((total, edit) => total + countTextLines(toRecord(edit).newText), 0);
	}
	return countTextLines(record.newText);
}

function countWriteContentLines(value: unknown): number {
	if (typeof value !== "string") return 0;
	const lines = value.replace(/\r/g, "").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

function getWriteContentSizeBytes(value: unknown): number {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function expandHint(): string {
	return keyHint("app.tools.expand", "to expand");
}

function isToolError(r: any, c: any): boolean {
	return c?.isError === true || r?.isError === true;
}

function isTruncated(r: any): boolean {
	return toRecord(toRecord(r?.details).truncation).truncated === true;
}

/** Partial (in-progress) header: spinner + elapsed while executing, streamed text on expansion. */
function renderPartialText(
	label: string,
	detail: string,
	parts: Array<{ text: string; color?: string }> | undefined,
	t: any,
	c: any,
): Text {
	const text = c?.lastComponent instanceof Text ? c.lastComponent : new Text("", 0, 0);
	const toolCallId = typeof c?.toolCallId === "string" ? c.toolCallId : undefined;
	const animating = toolCallId !== undefined && c?.executionStarted === true;

	const build = () => {
		let spinnerAndElapsed = "";
		if (animating && toolCallId !== undefined) {
			const state = getOrCreateSpinnerState(toolCallId);
			spinnerAndElapsed = t.fg("warning", SPINNER_CHARS[state.frame]) + " " + t.fg("muted", "· " + formatElapsed(Date.now() - state.start));
		}
		const suffix = (parts ?? []).map((p) => " " + t.fg(p.color ?? "muted", p.text)).join("");
		const det = detail ? " " + truncateDetail(detail) : "";
		text.setText(t.fg("dim", BORDER) + spinnerAndElapsed + t.bold(label + " ") + det + suffix);
	};

	if (animating && toolCallId !== undefined) {
		const state = getOrCreateSpinnerState(toolCallId);
		if (!state.timer && typeof c?.invalidate === "function") {
			state.timer = setInterval(() => {
				if (spinnerStates.get(toolCallId) !== state) {
					clearInterval(state.timer);
					return;
				}
				state.frame = (state.frame + 1) % SPINNER_CHARS.length;
				build();
				c.invalidate();
			}, SPINNER_INTERVAL_MS);
		}
	}

	build();
	return text;
}

export default function (pi: any) {
	const cwd = process.cwd();

	type ToolDetail = { detail: string; parts?: Array<{ text: string; color?: string }> };

	function registerTool(
		tool: any,
		label: string,
		getDetail: (a: any, t: any) => ToolDetail,
		getSummary?: (r: any, o: any, t: any, a: any, isError: boolean) => string | undefined,
	) {
		pi.registerTool({
			name: tool.name, label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			renderShell: "self",
			async execute(toolCallId: string, ...args: any[]) {
				try {
					return await tool.execute(toolCallId, ...args);
				} finally {
					stopSpinner(toolCallId);
				}
			},
			renderCall() { return new Container(); },
			renderResult(r: any, o: any, t: any, c: any) {
				const { detail, parts } = getDetail(c?.args || {}, t);
				const err = isToolError(r, c);
				// Partial (in-progress): spinner + any streamed text
				if (o.isPartial) {
					const streamed = r.content?.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("") || "";
					if (!o.expanded || (!detail && !streamed)) {
						return renderPartialText(label, detail, parts, t, c);
					}
					const lines = [];
					if (detail) {
						lines.push(addBorder(t.bold(label + " ") + hardWrap(detail, MAX_CONTENT_LINE_LEN), t, "dim"));
					}
					if (streamed) {
						lines.push(addBorder(sanitizeAnsiForThemedOutput(streamed), t, "dim"));
					}
					return new Text(lines.join("\n"), 0, 0);
				}
				stopSpinner(c?.toolCallId); // ensure no timer survives a cancelled call
				const tailParts: Array<{ text: string; color?: string }> = [...(parts ?? [])];
				if (isTruncated(r)) tailParts.push({ text: "• truncated", color: "warning" });
				const color = err ? "error" : "success";
				if (!o.expanded) {
					const title = titleLine(label, truncateDetail(detail), t, color, tailParts);
					const summary = getSummary?.(r, o, t, c?.args || {}, err);
					if (summary) {
						return new Text(title + "\n" + t.fg("muted", "  " + summary), 0, 0);
					}
					return new Text(title, 0, 0);
				}
				// Expanded: full detail + output, all lines use state color (dim/success/error)
				const contentLines = [];
				if (detail) {
					contentLines.push(addBorder(t.bold(label + " ") + hardWrap(detail, MAX_CONTENT_LINE_LEN), t, color));
				}
				const partsText = r.content?.filter((c: any) => c?.type === "text").map((c: any) => c.text) || [];
				if (r.details?.diff) partsText.push(r.details.diff);
				for (const p of partsText) {
					contentLines.push(addBorder(prepareOutputLines(sanitizeAnsiForThemedOutput(p), o.expanded).join("\n"), t, color));
				}
				return new Text(contentLines.join("\n"), 0, 0);
			},
		});
	}

	registerTool(createReadTool(cwd), "read", (a) => {
		const path = shortenPath(a.path || "");
		const offset = typeof a.offset === "number" ? a.offset : undefined;
		const limit = typeof a.limit === "number" ? a.limit : undefined;
		let range: string | undefined;
		if (offset !== undefined || limit !== undefined) {
			const from = offset ?? 1;
			const to = limit !== undefined ? from + limit - 1 : undefined;
			range = to !== undefined ? `:${from}-${to}` : `:${from}`;
		}
		return { detail: path, parts: range ? [{ text: range }] : undefined };
	}, (r, o, t, _a, _err) => {
		if (_err) return undefined;
		const lineCount = prepareOutputLines(extractTextOutput(r), true).length;
		if (lineCount === 0) return "↳ (empty)";
		return `↳ loaded ${lineCount} ${pluralize(lineCount, "line")} · ${expandHint()}`;
	});

	registerTool(createBashTool(cwd, {
		spawnHook: bashEnvHook,
		operations: createBashTimeoutOps(createLocalBashOperations()),
	}), "$", (a) => {
		return { detail: a.command || "" };
	}, (r, o, t, a, err) => {
		if (err) return "↳ command failed";
		const lines = prepareOutputLines(extractTextOutput(r), false);
		if (lines.length === 0) {
			return isLikelyQuietCommand(toRecord(a).command)
				? "↳ command completed (no output)"
				: "↳ (no output)";
		}
		const count = countNonEmptyLines(lines);
		return `↳ ${count} ${pluralize(count, "line")} returned · ${expandHint()}`;
	});

	registerTool(createEditTool(cwd), "edit", (a) => {
		const lineCount = countEditLines(a);
		const parts = lineCount > 0 ? [{ text: `(${lineCount} ${pluralize(lineCount, "line")})` }] : undefined;
		return { detail: shortenPath(a.path || ""), parts };
	});

	registerTool(createWriteTool(cwd), "write", (a) => {
		const content = typeof a.content === "string" ? a.content : undefined;
		let parts;
		if (content !== undefined) {
			const lineCount = countWriteContentLines(content);
			parts = [{ text: `(${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(getWriteContentSizeBytes(content))})` }];
		}
		return { detail: shortenPath(a.path || ""), parts };
	});
}
