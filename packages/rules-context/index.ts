// rules-context.ts — 路径规则注入插件（@the-forge-flow/pi-rules 的单文件精简版）
//
// 从规则目录加载带 frontmatter 的 .md 规则；当 read/edit/write 操作的文件路径
// 命中规则的 paths 模式时，把规则正文前置注入该工具的结果。
//
// 规则目录（存在才扫描，项目 + 用户级）：
//   <cwd>/.pi/rules/     <cwd>/.claude/rules/
//   ~/.pi/rules/         ~/.claude/rules/
//
// 规则格式：
//   ---
//   description: 可选，仅作说明
//   paths: "src/**/*.ts, lib/**/*.ts"   # 可选；逗号分隔字符串 / "- item" 列表 / [a, b] 数组；省略 = 全局生效
//   ---
//   正文 markdown，命中时以 <system-reminder> 包裹后前置注入。
//
// 语义：无优先级，所有命中的规则都注入；无 paths 的规则对所有文件生效；
// 会话内每个规则文件只注入一次。无热重载：修改规则后需重启会话。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TextContent = { type: "text"; text: string };

interface Rule {
	id: string;
	description?: string;
	paths: string[];
	body: string;
}

const TRIGGER_TOOLS = new Set(["read", "edit", "write"]);
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function warn(message: string) {
	process.stderr.write(`[rules-context] ${message}\n`);
}

// ---- 路径工具 ----

/** 绝对路径转相对 cwd 的 posix 路径；在 cwd 之外或等于 cwd 时返回 null */
export function toRelativePosix(absPath: string, cwd: string): string | null {
	const rel = path.relative(cwd, absPath);
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
	return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}

// ---- frontmatter 解析（零依赖） ----

function unquote(s: string): string {
	return s.replace(/^["']|["']$/g, "");
}

function parsePathsValue(value: string): string[] {
	let v = value.trim();
	if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
	return v
		.split(",")
		.map((s) => unquote(s.trim()))
		.filter((s) => s.length > 0);
}

function parseFrontmatter(raw: string): { description?: string; paths?: string[] } | null {
	const result: { description?: string; paths?: string[] } = {};
	let listKey: string | null = null;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;

		if (trimmed.startsWith("- ")) {
			if (!listKey) return null;
			result[listKey] = [...(result[listKey] ?? []), unquote(trimmed.slice(2).trim())];
			continue;
		}

		listKey = null;
		const colon = trimmed.indexOf(":");
		if (colon === -1) return null;
		const key = trimmed.slice(0, colon).trim();
		const value = trimmed.slice(colon + 1).trim();
		if (key === "description") {
			result.description = unquote(value);
		} else if (key === "paths") {
			if (value === "") {
				listKey = key;
				result.paths = [];
			} else {
				result.paths = parsePathsValue(value);
			}
		}
	}

	return result;
}

/** 解析单个规则文件内容；无 frontmatter 返回 null（跳过），格式错误返回 null 并警告 */
export function parseRuleFile(id: string, content: string): Rule | null {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return null;
	const fm = parseFrontmatter(match[1]);
	if (!fm) {
		warn(`invalid frontmatter in ${id}`);
		return null;
	}
	return {
		id,
		description: fm.description,
		paths: fm.paths ?? [],
		body: content.slice(match[0].length).replace(/^\n/, ""),
	};
}

// ---- glob 匹配（支持 *、**、?、{a,b}，* 不跨 /，** 跨 /） ----

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (c === "{") {
			const end = glob.indexOf("}", i + 1);
			if (end === -1) {
				re += "\\{";
			} else {
				re += `(?:${glob
					.slice(i + 1, end)
					.split(",")
					.map(escapeRegExp)
					.join("|")})`;
				i = end;
			}
		} else {
			re += escapeRegExp(c);
		}
	}
	return new RegExp(`^${re}$`);
}

function matchesRule(rule: Rule, relPosix: string): boolean {
	return rule.paths.length === 0 || rule.paths.some((p) => globToRegExp(p).test(relPosix));
}

// ---- 规则发现 ----

function ruleRootCandidates(cwd: string): string[] {
	const home = os.homedir();
	return [
		path.join(home, ".pi", "rules"),
		path.join(home, ".claude", "rules"),
		path.join(cwd, ".pi", "rules"),
		path.join(cwd, ".claude", "rules"),
	];
}

async function discoverRules(cwd: string): Promise<Rule[]> {
	const rules: Rule[] = [];
	const seen = new Set<string>();

	for (const root of ruleRootCandidates(cwd)) {
		if (!fs.existsSync(root)) continue;

		let entries: string[];
		try {
			entries = await fs.promises.readdir(root);
		} catch (error) {
			warn(`cannot read ${root}: ${String(error)}`);
			continue;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const absPath = path.join(root, entry);
			const id = await fs.promises.realpath(absPath).catch(() => absPath);
			if (seen.has(id)) continue;
			seen.add(id);

			try {
				const content = await fs.promises.readFile(absPath, "utf-8");
				const rule = parseRuleFile(id, content);
				if (rule) rules.push(rule);
			} catch (error) {
				warn(`cannot read ${absPath}: ${String(error)}`);
			}
		}
	}

	return rules;
}

// ---- 插件入口 ----

export default function rulesContext(pi: ExtensionAPI) {
	let rules: Rule[] = [];
	const injectedIds = new Set<string>();

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		injectedIds.clear();
		rules = await discoverRules(ctx.cwd);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return undefined;
		if (!TRIGGER_TOOLS.has(event.toolName)) return undefined;

		const rawPath = event.input?.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;

		const relPath = toRelativePosix(path.resolve(ctx.cwd, rawPath), ctx.cwd);
		if (relPath === null) return undefined;

		const fresh = rules.filter((r) => !injectedIds.has(r.id) && matchesRule(r, relPath));
		if (fresh.length === 0) return undefined;

		for (const r of fresh) injectedIds.add(r.id);

		if (ctx.hasUI) {
			for (const r of fresh) {
				const label = r.description ?? toRelativePosix(r.id, ctx.cwd) ?? r.id;
				ctx.ui.notify(`应用规则: ${label}`, "info");
			}
		}

		const additions: TextContent[] = fresh.map((r) => ({
			type: "text",
			text: `\n<system-reminder>\nLoaded rule from ${r.id}\n\n${r.body}\n</system-reminder>\n`,
		}));
		return {
			content: [...additions, ...(event.content ?? [])],
			details: event.details,
		};
	});
}
