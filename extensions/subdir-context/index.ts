// subdir-context.ts — 子目录上下文自动注入
//
// 当 read 工具读取文件时，沿目标文件的父目录链向上查找 AGENTS.override.md /
// AGENTS.md / CLAUDE.md，找到即注入为 <system-reminder>，让子目录的局部约定生效。
//
// 搜索范围：
//   - 当前会话 cwd 及其子目录（默认，即原扩展语义）
//   - 配置文件中 extraRoots 声明的额外根目录及其子目录（可选）
//   其余位置的文件不触发注入——例如 ~/.pi、技能目录、插件目录、~/.claude 等
//   生态目录里的 AGENTS/CLAUDE.md 不再被自动加载。
//
// 配置文件（可选，不存在则跳过），项目级与全局的 extraRoots 合并并集生效：
//   .pi/extensions/subdir-context/config.json              （项目级，优先）
//   ~/.pi/agent/extensions/subdir-context/config.json      （全局）
//   {
//     "extraRoots": ["~/projects/foo", "D:/docs/team", "sub/dir"]
//   }
//   extraRoots 为字符串数组：支持绝对路径、~ 展开、相对路径（相对会话 cwd）。
//   配置文件在每次 read 时重新读取，改动即时生效，无需重启会话。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TextContent = { type: "text"; text: string };

const AGENTS_FILENAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"];
const CONFIG_ENV = "PI_SUBDIR_CONTEXT_CONFIG";

/** 项目级与全局配置路径；环境变量仅用于测试覆盖全局路径，正常走用户级默认路径 */
export function configPaths(cwd: string): string[] {
	return [
		path.join(cwd, ".pi", "extensions", "subdir-context", "config.json"),
		process.env[CONFIG_ENV] ||
			path.join(os.homedir(), ".pi", "agent", "extensions", "subdir-context", "config.json"),
	];
}

/** 合并项目级与全局配置的 extraRoots（并集，去重） */
export function readExtraRoots(cwd: string): string[] {
	const roots: string[] = [];
	for (const file of configPaths(cwd)) {
		let data: unknown;
		try {
			data = JSON.parse(fs.readFileSync(file, "utf-8"));
		} catch {
			continue;
		}
		roots.push(...resolveExtraRoots((data as { extraRoots?: unknown }).extraRoots, cwd));
	}
	return [...new Set(roots)];
}

function resolvePath(targetPath: string, baseDir: string) {
	const absolute = path.isAbsolute(targetPath)
		? path.normalize(targetPath)
		: path.resolve(baseDir, targetPath);
	try {
		return fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
	} catch {
		return absolute;
	}
}

/** 展开开头的 ~ 为用户主目录 */
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) {
		return path.resolve(os.homedir(), p.slice(2));
	}
	return p;
}

/** 解析配置中的 extraRoots 为绝对路径列表（过滤无效项） */
export function resolveExtraRoots(entries: unknown, cwd: string): string[] {
	if (!Array.isArray(entries)) return [];

	const roots: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string" || entry.trim() === "") continue;
		const expanded = expandHome(entry.trim());
		const absolute = path.isAbsolute(expanded)
			? expanded
			: path.resolve(cwd, expanded);
		roots.push(resolvePath(absolute, cwd));
	}
	return roots;
}

function isInsideRoot(rootDir: string, targetPath: string) {
	if (!rootDir) return false;
	const relative = path.relative(rootDir, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getAgentsFileFromDir(dir: string) {
	for (const filename of AGENTS_FILENAMES) {
		const candidate = path.join(dir, filename);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return "";
}

export default function autoloadSubdirContext(pi: ExtensionAPI) {
	const loadedAgents = new Set<string>();
	let currentCwd = "";
	let cwdAgentsPath = "";

	function resetSession(cwd: string) {
		currentCwd = resolvePath(cwd, process.cwd());
		cwdAgentsPath = getAgentsFileFromDir(currentCwd);
		loadedAgents.clear();
		if (cwdAgentsPath) {
			loadedAgents.add(path.normalize(cwdAgentsPath));
		}
	}

	function findAgentsFiles(filePath: string, rootDir: string) {
		if (!rootDir) return [] as string[];

		const agentsFiles: string[] = [];
		let dir = path.dirname(filePath);

		while (isInsideRoot(rootDir, dir)) {
			const candidate = getAgentsFileFromDir(dir);
			if (candidate && candidate !== cwdAgentsPath) {
				agentsFiles.push(candidate);
			}

			if (dir === rootDir) break;

			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		return agentsFiles.reverse();
	}

	/** 选择搜索根：当前 cwd 优先，其次配置的额外根目录 */
	function pickSearchRoot(targetAbs: string, roots: string[]) {
		for (const root of roots) {
			if (isInsideRoot(root, targetAbs)) return root;
		}
		return "";
	}

	const handleSessionChange = (_event: unknown, ctx: ExtensionContext) => {
		resetSession(ctx.cwd);
	};

	pi.on("session_start", handleSessionChange);

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return undefined;

		const pathInput = event.input.path as string | undefined;
		if (!pathInput) return undefined;

		if (!currentCwd) resetSession(ctx.cwd);

		const absolutePath = resolvePath(pathInput, currentCwd);

		const extraRoots = readExtraRoots(currentCwd);
		const searchRoot = pickSearchRoot(absolutePath, [currentCwd, ...extraRoots]);
		if (!searchRoot) return undefined;

		if (AGENTS_FILENAMES.includes(path.basename(absolutePath))) {
			loadedAgents.add(path.normalize(absolutePath));
			return undefined;
		}

		const agentFiles = findAgentsFiles(absolutePath, searchRoot);
		const additions: TextContent[] = [];

		for (const agentsPath of agentFiles) {
			const normalizedAgentsPath = path.normalize(agentsPath);
			if (loadedAgents.has(normalizedAgentsPath)) continue;

			try {
				const content = await fs.promises.readFile(agentsPath, "utf-8");
				loadedAgents.add(normalizedAgentsPath);
				additions.push({
					type: "text",
					text: `\n<system-reminder>\nLoaded subdirectory context from ${agentsPath}\n\n${content}\n</system-reminder>\n`,
				});
				if (ctx.hasUI) ctx.ui.notify(`加载子目录上下文: ${agentsPath}`, "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Failed to load ${agentsPath}: ${String(error)}`, "warning");
			}
		}

		if (!additions.length) return undefined;

		const baseContent = event.content ?? [];
		return { content: [...baseContent, ...additions], details: event.details };
	});
}
