/**
 * skill-manager：查看并切换 skill 的模型可见性。
 *
 * 禁用发生在提示构建层：pi 在每次模型请求前把 systemPromptOptions 交给我们，其中
 * skills 是可写的副本（pi 每次请求都会重建），过滤它不会污染 pi 的基础状态，也不需要 /reload。
 *
 * 所有输出只走 ctx.ui.notify。这里绝不能改用 pi.sendMessage()：那会把整张表写进模型上下文。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { completionsFor } from "./complete.ts";
import { renderTable } from "./render.ts";
import { readSkills, type SkillsContext } from "./skills.ts";
import {
	globalConfigPath,
	projectConfigPath,
	readConfig,
	resolveSettings,
	writeSetting,
	type ScopeName,
	type ScopeSetting,
	type SettingsMap,
} from "./scope.ts";
import {
	appendEvent,
	isSkillFile,
	normalizeSkillPath,
	PendingReads,
	shouldCommitRead,
	usageLogPath,
} from "./usage.ts";

/**
 * 会话层设定，按 sessionId 隔离。
 *
 * 扩展 factory 在父会话与每个子代理会话各执行一次，但模块只 import 一次；
 * 用模块级单例 Map 会让并发子代理互相覆盖，所以键必须是 sessionId。
 */
const sessionSettings = new Map<string, SettingsMap>();

/**
 * 已经开始、但还没结束的 read 调用，按 toolCallId 索引。
 *
 * start 事件在工具执行之前发出，被拦下或没跑成的调用同样会留下条目，所以要在 end 时
 * 用 `shouldCommitRead` 复核。这里只存归一化后的 skill 路径，落盘交给 end。
 */
const pendingReads = new PendingReads();

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId();
}

function loadLayers(ctx: ExtensionContext): {
	session: SettingsMap;
	project: SettingsMap;
	global: SettingsMap;
} {
	const session = sessionSettings.get(sessionKey(ctx)) ?? {};
	// 未受信任的项目不允许用配置文件影响模型所见。
	const project = ctx.isProjectTrusted() ? readConfig(projectConfigPath(ctx.cwd)) : {};
	const global = readConfig(globalConfigPath(getAgentDir()));
	return { session, project, global };
}

function skillsOf(ctx: ExtensionContext) {
	return readSkills(ctx as unknown as SkillsContext);
}

/**
 * 补全用的 skill 名缓存。
 *
 * getArgumentCompletions 拿不到 ctx，所以只能在会话建立、模型请求前与命令执行时刷新。
 */
let knownSkillNames: string[] = [];

function refreshSkillNames(entries: Array<{ name: string }>): void {
	if (entries.length > 0) knownSkillNames = entries.map((entry) => entry.name);
}

function renderCurrent(ctx: ExtensionContext): string {
	const { session, project, global } = loadLayers(ctx);
	return renderTable(skillsOf(ctx), resolveSettings(session, project, global));
}

const SCOPE_FLAGS: Record<string, ScopeName> = {
	"--project": "project",
	"--global": "global",
};

/** 解析作用域参数；省略时落到会话层，未知 flag 返回 undefined。 */
function parseScope(tokens: string[]): ScopeName | undefined {
	for (const token of tokens) {
		if (!token.startsWith("--")) continue;
		const scope = SCOPE_FLAGS[token];
		if (!scope) return undefined;
		return scope;
	}
	return "session";
}

function scopeLabel(scope: ScopeName): string {
	return scope === "session" ? "会话" : scope === "project" ? "项目" : "全局";
}

async function applySetting(
	scope: ScopeName,
	name: string,
	value: ScopeSetting,
	ctx: ExtensionContext,
): Promise<string> {
	if (scope === "session") {
		const key = sessionKey(ctx);
		const settings = sessionSettings.get(key) ?? {};
		settings[name] = value;
		sessionSettings.set(key, settings);
		return `已在会话层把 ${name} 设为${value === "disabled" ? "禁用" : "启用"}`;
	}

	const file = scope === "global" ? globalConfigPath(getAgentDir()) : projectConfigPath(ctx.cwd);
	await withFileMutationQueue(file, async () => {
		writeSetting(file, name, value);
	});
	return `已在${scopeLabel(scope)}层把 ${name} 设为${value === "disabled" ? "禁用" : "启用"}（${file}）`;
}

export default function (pi: ExtensionAPI) {
	// 补全缓存的首个来源：会话刚建立时系统提示里已经有 skill 段了。
	pi.on("session_start", async (_event, ctx) => {
		try {
			refreshSkillNames(readSkills({ getSystemPrompt: () => ctx.getSystemPrompt() }));
		} catch {
			// 拿不到也不影响使用：模型请求前还会再刷一次。
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const skills = event.systemPromptOptions.skills;
		if (Array.isArray(skills)) refreshSkillNames(skills);

		const { session, project, global } = loadLayers(ctx);
		const resolved = resolveSettings(session, project, global);
		if (resolved.size === 0) return;
		if (!Array.isArray(skills)) return;

		const kept = skills.filter((skill) => resolved.get(skill.name)?.value !== "disabled");
		if (kept.length !== skills.length) event.systemPromptOptions.skills = kept;
	});

	// read 通道：模型自己读 SKILL.md 也算一次使用。
	pi.on("tool_execution_start", (event, ctx) => {
		try {
			if (event.toolName !== "read") return;
			const raw = (event.args as { path?: unknown } | undefined)?.path;
			if (typeof raw !== "string" || !isSkillFile(raw)) return;
			pendingReads.record(event.toolCallId, normalizeSkillPath(raw, ctx.cwd));
		} catch {
			// 采集是旁路：这里抛错会连带让这次工具调用失败。
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		try {
			const skillPath = pendingReads.take(event.toolCallId);
			if (!skillPath) return;
			if (!shouldCommitRead({ durationMs: event.durationMs, isError: event.isError })) return;
			appendEvent(usageLogPath(getAgentDir()), {
				ts: new Date().toISOString(),
				via: "read",
				path: skillPath,
				session: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
			});
		} catch {
			// 同上：记不上就算了，技能本身照常工作。
		}
	});

	pi.registerCommand("skills", {
		description: "查看 skill 清单，或切换某个 skill 的模型可见性",
		getArgumentCompletions: (prefix: string) => {
			const items = completionsFor(prefix, knownSkillNames);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] ?? "list";

			if (action === "disable" || action === "enable") {
				const name = tokens.slice(1).find((token) => !token.startsWith("-"));
				if (!name) {
					ctx.ui.notify(`用法：/skills ${action} <name> [--project | --global]`, "warning");
					return;
				}

				const scope = parseScope(tokens.slice(1));
				if (!scope) {
					ctx.ui.notify("未知作用域参数。可用：--project、--global（省略则作用于当前会话）", "warning");
					return;
				}

				const known = skillsOf(ctx);
				refreshSkillNames(known);
				if (known.length > 0 && !known.some((entry) => entry.name === name)) {
					ctx.ui.notify(`没有名为 ${name} 的 skill，未做改动。`, "warning");
					return;
				}

				const value: ScopeSetting = action === "disable" ? "disabled" : "enabled";
				const summary = await applySetting(scope, name, value, ctx);
				ctx.ui.notify(`${summary}\n\n${renderCurrent(ctx)}`, "info");
				return;
			}

			if (action !== "list") {
				ctx.ui.notify("用法：/skills [list | disable <name> | enable <name>] [--project | --global]", "warning");
				return;
			}

			ctx.ui.notify(renderCurrent(ctx), "info");
		},
	});
}
