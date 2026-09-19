/**
 * tree-summaries 的纯逻辑：方案文件扫描、frontmatter 解析、指令拼接。
 *
 * 单独成文件是为了能脱离 pi 运行时直接测（`node --test logic.test.mts`）：
 * 这里只有 type-only import，运行时被类型剥离全部擦除。
 *
 * 一个方案 = 目录下的一个 .md 文件：
 *   <cwd>/.pi/tree-summaries/<name>.md     项目级（项目受信任时才扫描）
 *   ~/.pi/agent/tree-summaries/<name>.md   全局级
 * 文件名即命令名（foo.md → /tree:foo），正文是摘要指令。
 * 同名时项目级覆盖全局级。
 *
 * frontmatter（可选）：
 *   description:   补全列表里的说明
 *   argument-hint: 补全列表里的参数提示
 *   mode:          append（默认，拼在内置摘要模板之后）| replace（完全接管摘要 prompt）
 */

import fs from "node:fs";
import path from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type PlanMode = "append" | "replace";
export type PlanScope = "project" | "global";

export interface SummaryPlan {
	/** 执行用的命令名，形如 tree:req */
	commandName: string;
	/** 方案名，即文件名去掉 .md */
	name: string;
	description?: string;
	argumentHint?: string;
	mode: PlanMode;
	/** 正文：frontmatter 之后的摘要指令 */
	body: string;
	filePath: string;
	scope: PlanScope;
}

/** 项目级与全局级方案目录，相对仓库/用户主目录。 */
export const PROJECT_DIR_SEGMENTS = [".pi", "tree-summaries"];
export const GLOBAL_DIR_SEGMENTS = [".pi", "agent", "tree-summaries"];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 方案名里出现空白会让命令无法输入——pi 按第一个空格切分命令名，
 * `/tree:my plan x` 会被解析成命令 `tree:my` 加参数 `plan x`。
 */
function isUsableName(name: string): boolean {
	return name.length > 0 && !/\s/.test(name);
}

function unquote(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "");
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
	const match = raw.match(FRONTMATTER_RE);
	if (!match) return { data: {}, body: raw.trim() };

	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim();
		if (key) data[key] = unquote(line.slice(separator + 1));
	}
	return { data, body: raw.slice(match[0].length).trim() };
}

/** 解析单个方案文件；文件名不可用或正文为空时返回 null。 */
export function parsePlanFile(raw: string, filePath: string, scope: PlanScope): SummaryPlan | null {
	const name = path.basename(filePath).replace(/\.md$/i, "");
	if (!isUsableName(name)) return null;

	const { data, body } = parseFrontmatter(raw);
	if (!body) return null;

	return {
		commandName: `tree:${name}`,
		name,
		description: data.description || undefined,
		argumentHint: data["argument-hint"] || undefined,
		mode: data.mode === "replace" ? "replace" : "append",
		body,
		filePath,
		scope,
	};
}

function listPlanFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // 目录不存在或不可读：这个 scope 没有方案
	}
	return entries
		.filter((entry) => !entry.name.startsWith(".") && /\.md$/i.test(entry.name))
		.map((entry) => path.join(dir, entry.name))
		.sort();
}

/** 扫描项目级与全局级目录。同名方案项目级优先。 */
export function scanPlanDirs(cwd: string, homeDir: string, options: { includeProject: boolean }): SummaryPlan[] {
	const scopes: Array<{ dir: string; scope: PlanScope }> = [];
	if (options.includeProject) {
		scopes.push({ dir: path.join(cwd, ...PROJECT_DIR_SEGMENTS), scope: "project" });
	}
	scopes.push({ dir: path.join(homeDir, ...GLOBAL_DIR_SEGMENTS), scope: "global" });

	const byName = new Map<string, SummaryPlan>();
	for (const { dir, scope } of scopes) {
		for (const filePath of listPlanFiles(dir)) {
			let raw: string;
			try {
				raw = fs.readFileSync(filePath, "utf8");
			} catch {
				continue;
			}
			const plan = parsePlanFile(raw, filePath, scope);
			if (plan && !byName.has(plan.name)) byName.set(plan.name, plan);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 合成最终摘要指令：方案正文 + 用户在命令后追加的文字。 */
export function buildInstructions(plan: SummaryPlan, args: string): string {
	const extra = args.trim();
	if (!extra) return plan.body;
	return `${plan.body}\n\n## 补充要求\n\n${extra}`;
}

/**
 * 当前分支上最靠前的一条用户消息。
 *
 * navigateTree 对它按「用户消息」处理：leaf 移到它的父节点（对话从根开始时即 null），
 * 摘要因此挂在它之前，覆盖它之后的全部内容。
 */
export function firstUserMessageId(branch: readonly SessionEntry[]): string | undefined {
	return branch.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
}

/**
 * 目标 entry 之后是否还有 entry。
 *
 * navigateTree 只在 entriesToSummarize 非空时生成摘要，否则静默重置 leaf——
 * 刚发出第一条消息就交接时会踩到，得提前拦下来告诉用户。
 */
export function hasEntriesAfter(branch: readonly SessionEntry[], entryId: string): boolean {
	const index = branch.findIndex((entry) => entry.id === entryId);
	return index !== -1 && index < branch.length - 1;
}
