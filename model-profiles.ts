// model-profiles.ts — /profile 档案切换插件
//
// 按会话加载/卸载"档案"（~/.pi/agent/profiles/<name>/）：
//   - AGENTS.md（存在时）通过 before_agent_start 注入 systemPrompt
//   - settings.json（可选）声明资源，全部相对档案目录解析：
//       packages   — 本地目录包（读其 package.json 的 pi 字段）或 git: 包（自动 clone 到 ~/.pi/agent/git/），npm: 暂不支持
//       extensions — 直接列出的扩展文件/目录
//       skills     — 技能目录（通过 resources_discover 贡献）
//       prompts    — 提示词目录
//       themes     — 主题目录
//
// 状态模型（仅会话级）：档案名通过 pi.appendEntry 持久化到当前会话文件，
// /new /resume /fork 触发扩展重建时从会话条目自动恢复；卸载由重建天然完成
// （注册进扩展对象的工具/事件/命令随旧实例丢弃）。
//
// 命令：
//   /profile          — 弹出选择器（含"无档案"选项）
//   /profile <name>   — 切换档案（写入会话状态 + reload）
//   /profile off      — 清除会话档案
//
// 扩展加载：绝对路径 import pi 包的 loader.js，调 loadExtensions(paths)（官方
// jiti + alias），再把注册内容"迁移"到本扩展 API 上。不要用 discoverAndLoad
// Extensions——它会自动发现并执行全局/项目扩展目录的工厂，产生重复副作用。

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Extension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const PROFILES_DIR = path.join(getAgentDir(), "profiles");
const GIT_PACKAGES_DIR = path.join(getAgentDir(), "git");
const ENTRY_TYPE = "pi-profile";
const SETTINGS_FILE = "settings.json";
const AGENTS_FILE = "AGENTS.md";
const NO_PROFILE = "(无档案)";

interface ProfileSettings {
	packages?: string[];
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/** 当前会话档案名（模块级，session_start 时刷新；null = 无档案） */
let activeProfile: string | null = null;
let contributedResources: { skillPaths: string[]; promptPaths: string[]; themePaths: string[] } = {
	skillPaths: [],
	promptPaths: [],
	themePaths: [],
};

function warn(message: string) {
	process.stderr.write(`[model-profiles] ${message}\n`);
}

// ---- 档案发现 ----

function listProfileNames(): string[] {
	try {
		return fs
			.readdirSync(PROFILES_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

function profileDir(name: string): string {
	return path.join(PROFILES_DIR, name);
}

function readProfileSettings(name: string): ProfileSettings {
	const file = path.join(profileDir(name), SETTINGS_FILE);
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const strArr = (v: unknown): string[] | undefined =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
		const p = parsed as Record<string, unknown>;
		return {
			packages: strArr(p.packages),
			extensions: strArr(p.extensions),
			skills: strArr(p.skills),
			prompts: strArr(p.prompts),
			themes: strArr(p.themes),
		};
	} catch (error) {
		warn(`cannot read ${file}: ${String(error)}`);
		return {};
	}
}

function readPiManifest(dir: string): PiManifest {
	try {
		const pkg: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
		const pi = (typeof pkg === "object" && pkg !== null && (pkg as Record<string, unknown>).pi) ?? {};
		const strArr = (v: unknown): string[] | undefined =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
		const p = pi as Record<string, unknown>;
		return {
			extensions: strArr(p.extensions),
			skills: strArr(p.skills),
			prompts: strArr(p.prompts),
			themes: strArr(p.themes),
		};
	} catch {
		return {};
	}
}

function resolveRelative(base: string, entries: string[] | undefined): string[] {
	if (!entries) return [];
	return entries.filter((p) => p.trim().length > 0).map((p) => path.resolve(base, p));
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/** 目录 → 入口文件（语义与 pi 的 resolveExtensionEntries 一致） */
function resolveDirEntries(dir: string): string[] | null {
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(dir);
		if (manifest.extensions && manifest.extensions.length > 0) {
			return resolveRelative(dir, manifest.extensions).filter((p) => fs.existsSync(p));
		}
	}
	for (const index of ["index.ts", "index.js"]) {
		const indexPath = path.join(dir, index);
		if (fs.existsSync(indexPath)) return [indexPath];
	}
	return null;
}

/** 目录内展开（语义与 pi 的 discoverExtensionsInDir 一致：单层，不递归） */
function discoverExtensionFiles(dir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const discovered: string[] = [];
	for (const entry of entries) {
		const entryPath = path.join(dir, entry.name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
			discovered.push(entryPath);
			continue;
		}
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			const resolved = resolveDirEntries(entryPath);
			if (resolved) discovered.push(...resolved);
		}
	}
	return discovered;
}

/** 把扩展路径（文件或目录）展开成可加载的文件列表 */
function expandExtensionPaths(paths: string[]): string[] {
	const expanded: string[] = [];
	for (const p of paths) {
		if (!fs.existsSync(p)) {
			warn(`extension path not found: ${p}`);
			continue;
		}
		if (fs.statSync(p).isDirectory()) {
			const entries = resolveDirEntries(p);
			if (entries && entries.length > 0) {
				expanded.push(...entries);
			} else {
				expanded.push(...discoverExtensionFiles(p));
			}
		} else if (isExtensionFile(p)) {
			expanded.push(p);
		}
	}
	return expanded;
}

// ---- 会话状态（仅会话级） ----

/** 读当前会话文件里最后一条档案记录；无记录或记录为空 = 无档案 */
function readActiveProfile(ctx: ExtensionContext): string | null {
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			const name = (entry.data as { name?: unknown } | undefined)?.name;
			return typeof name === "string" && name.length > 0 ? name : null;
		}
	}
	return null;
}

// ---- 包解析 ----

/**
 * 解析 settings.json 里的包 spec。
 * git:github.com/user/repo[@version] → 确保 ~/.pi/agent/git/<repo> 已 clone（含 package.json 时装依赖）
 * 其他（本地路径）→ 相对档案目录解析
 */
async function resolvePackage(spec: string, baseDir: string, pi: ExtensionAPI): Promise<string | null> {
	if (spec.startsWith("git:")) {
		const repoPath = spec.slice(4).replace(/@[^/]+$/, "");
		if (!/^[^/\s]+\/[^/\s]+(\/[^/\s]+)*$/.test(repoPath)) {
			warn(`invalid git package spec: ${spec}`);
			return null;
		}
		const dir = path.join(GIT_PACKAGES_DIR, repoPath);
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		try {
			warn(`cloning git package ${repoPath} ...`);
			await pi.exec("git", ["clone", `https://${repoPath}`, dir], { timeout: 120_000 });
			if (fs.existsSync(path.join(dir, "package.json"))) {
				warn(`installing dependencies for ${repoPath} ...`);
				await pi.exec("npm", ["install"], { cwd: dir, timeout: 300_000 });
			}
			return dir;
		} catch (error) {
			warn(`cannot fetch git package ${spec}: ${String(error)}`);
			return null;
		}
	}
	if (spec.startsWith("npm:")) {
		warn(`npm packages are not supported yet: ${spec}`);
		return null;
	}
	return path.resolve(baseDir, spec);
}

// ---- 扩展加载与迁移注册 ----

interface ProfileLoader {
	loadExtensions: (paths: string[], cwd: string) => Promise<LoadExtensionsResult>;
}

let loader: ProfileLoader | null = null;

async function getLoader(): Promise<ProfileLoader> {
	if (loader) return loader;
	const loaderPath = path.join(getPackageDir(), "dist", "core", "extensions", "loader.js");
	if (!fs.existsSync(loaderPath)) {
		throw new Error(`pi extension loader not found at ${loaderPath}`);
	}
	const mod = (await import(loaderPath)) as { loadExtensions?: (paths: string[], cwd: string) => Promise<LoadExtensionsResult> };
	if (typeof mod.loadExtensions !== "function") {
		throw new Error(`pi extension loader at ${loaderPath} has no loadExtensions export`);
	}
	loader = { loadExtensions: mod.loadExtensions };
	return loader;
}

/** 把官方 loader 加载出的扩展注册内容"迁移"到本扩展的 API 上 */
function migrateExtension(ext: Extension, pi: ExtensionAPI): void {
	for (const [event, handlers] of ext.handlers) {
		for (const fn of handlers) pi.on(event as never, fn as never);
	}
	for (const tool of ext.tools.values()) {
		pi.registerTool(tool.definition);
	}
	for (const cmd of ext.commands.values()) {
		pi.registerCommand(cmd.name, {
			description: cmd.description,
			getArgumentCompletions: cmd.getArgumentCompletions,
			handler: cmd.handler,
		});
	}
	for (const flag of ext.flags.values()) {
		if (flag.type === "boolean") {
			pi.registerFlag(flag.name, { type: "boolean", default: flag.default === true, description: flag.description });
		} else {
			pi.registerFlag(flag.name, { type: "string", default: typeof flag.default === "string" ? flag.default : undefined, description: flag.description });
		}
	}
	for (const [key, shortcut] of ext.shortcuts) {
		pi.registerShortcut(key, { description: shortcut.description, handler: shortcut.handler });
	}
	for (const [customType, renderer] of ext.messageRenderers) {
		pi.registerMessageRenderer(customType, renderer);
	}
	if (ext.markdownTransformer) {
		pi.registerMarkdownTransformer(ext.markdownTransformer);
	}
	for (const [customType, renderer] of ext.entryRenderers ?? new Map()) {
		pi.registerEntryRenderer(customType, renderer);
	}
}

interface LoadedResources {
	extCount: number;
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
	errors: string[];
}

/** 加载一个档案：解析 settings + 包 manifest → 加载扩展并迁移注册；返回可贡献的资源 */
async function loadProfile(name: string, pi: ExtensionAPI, ctx: ExtensionContext): Promise<LoadedResources> {
	const baseDir = profileDir(name);
	const settings = readProfileSettings(name);

	const extPaths: string[] = [];
	const skillPaths: string[] = [];
	const promptPaths: string[] = [];
	const themePaths: string[] = [];
	const errors: string[] = [];

	for (const spec of settings.packages ?? []) {
		const pkgDir = await resolvePackage(spec, baseDir, pi);
		if (!pkgDir) continue;
		const manifest = readPiManifest(pkgDir);
		extPaths.push(...resolveRelative(pkgDir, manifest.extensions));
		skillPaths.push(...resolveRelative(pkgDir, manifest.skills));
		promptPaths.push(...resolveRelative(pkgDir, manifest.prompts));
		themePaths.push(...resolveRelative(pkgDir, manifest.themes));
	}

	extPaths.push(...resolveRelative(baseDir, settings.extensions));
	skillPaths.push(...resolveRelative(baseDir, settings.skills));
	promptPaths.push(...resolveRelative(baseDir, settings.prompts));
	themePaths.push(...resolveRelative(baseDir, settings.themes));

	const extFilePaths = expandExtensionPaths(extPaths);

	if (extFilePaths.length > 0) {
		try {
			const extLoader = await getLoader();
			const result = await extLoader.loadExtensions(extFilePaths, ctx.cwd);
			for (const ext of result.extensions) {
				migrateExtension(ext, pi);
			}
			for (const err of result.errors) {
				errors.push(`${err.path}: ${err.error}`);
			}
			// provider 注册：loader 的 runtime 只是 stub，pending 队列里的注册在此落地
			for (const p of result.runtime.pendingProviderRegistrations) {
				pi.registerProvider(p.name as never, p.config as never);
			}
			for (const p of result.runtime.pendingNativeProviderRegistrations) {
				pi.registerProvider(p.provider as never);
			}
		} catch (error) {
			errors.push(`extension loading failed: ${String(error)}`);
		}
	}

	return {
		extCount: extFilePaths.length,
		skillPaths,
		promptPaths,
		themePaths,
		errors,
	};
}

// ---- 档案切换 ----

async function applyProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string | null): Promise<void> {
	pi.appendEntry(ENTRY_TYPE, { name: name ?? "" });
	if (ctx.hasUI) {
		ctx.ui.notify(`切换档案: ${name ?? "(无)"}，正在重载…`, "info");
	}
	await ctx.reload();
}

// ---- 插件入口 ----

export default function modelProfiles(pi: ExtensionAPI) {
	// 每次会话启动（startup / reload / new / resume / fork）都从会话条目恢复档案。
	// 旧实例的注册已随重建丢弃，这里重新加载当前档案 = 天然卸载旧的。
	pi.on("session_start", async (_event, ctx) => {
		const name = readActiveProfile(ctx);
		activeProfile = name;
		contributedResources = { skillPaths: [], promptPaths: [], themePaths: [] };
		if (!name) return;

		try {
			const loaded = await loadProfile(name, pi, ctx);
			contributedResources = {
				skillPaths: loaded.skillPaths,
				promptPaths: loaded.promptPaths,
				themePaths: loaded.themePaths,
			};
			if (ctx.hasUI) {
				ctx.ui.notify(
					`档案 ${name} 已加载（${loaded.extCount} 扩展 / ${loaded.skillPaths.length} 技能 / ${loaded.promptPaths.length} 提示词 / ${loaded.themePaths.length} 主题）`,
					"info",
				);
			}
			for (const err of loaded.errors) {
				warn(`profile ${name}: ${err}`);
			}
		} catch (error) {
			warn(`profile ${name} failed to load: ${String(error)}`);
			if (ctx.hasUI) {
				ctx.ui.notify(`档案 ${name} 加载失败: ${String(error)}`, "error");
			}
		}
	});

	// 贡献当前档案的技能/提示词/主题路径（仅 reload/startup 触发，切换后自动撤销）
	pi.on("resources_discover", async () => {
		return {
			skillPaths: contributedResources.skillPaths,
			promptPaths: contributedResources.promptPaths,
			themePaths: contributedResources.themePaths,
		};
	});

	// 注入档案 AGENTS.md 作为上下文
	pi.on("before_agent_start", async (event, ctx) => {
		if (!activeProfile) return undefined;
		const agentsPath = path.join(profileDir(activeProfile), AGENTS_FILE);
		let content: string;
		try {
			content = fs.readFileSync(agentsPath, "utf-8");
		} catch {
			return undefined;
		}
		if (!content.trim()) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<system-reminder>\nProfile "${activeProfile}" context loaded from ${agentsPath}\n\n${content}\n</system-reminder>\n`,
		};
	});

	pi.registerCommand("profile", {
		description: "加载或切换会话档案（~/.pi/agent/profiles/<name>/）；off 清除",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const names = listProfileNames();
			const filtered = names.filter((n) => n.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((n) => ({ value: n, label: n })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "") {
				const options = [NO_PROFILE, ...listProfileNames()];
				const choice = await ctx.ui.select("选择档案（第一项 = 无档案）:", options);
				if (!choice) return;
				await applyProfile(pi, ctx, choice === NO_PROFILE ? null : choice);
				return;
			}

			if (arg === "off" || arg === "none") {
				await applyProfile(pi, ctx, null);
				return;
			}

			if (listProfileNames().includes(arg)) {
				await applyProfile(pi, ctx, arg);
				return;
			}

			const available = listProfileNames();
			ctx.ui.notify(`未知档案 "${arg}"。可用档案: ${available.length > 0 ? available.join(", ") : "(无)"}`, "error");
		},
	});
}