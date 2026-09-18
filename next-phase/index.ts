/**
 * next-phase — 让模型在阶段完成后把下一步交接给一个干净的上下文。
 *
 * 链路：工具 next_phase（确认 + 落盘交接）→ agent_settled 派发 /next-phase-run
 * → 命令里 navigateTree 切到新分支 → 注入任务 prompt。新分支与原分支同一棵 session
 * 树，用 /tree 一步回去。
 *
 * 三个不显然的约束（改代码前先读）：
 * - 工具 ctx 是 ExtensionContext，没有 waitForIdle / navigateTree；会话控制只在
 *   ExtensionCommandContext 上，所以切换必须由命令执行。
 * - 工具里派发命令是"立即执行"（pi 的 prompt() 先处理 slash 命令，再判 streaming），
 *   而 navigateTree 在 streaming 时直接抛错，所以派发只能等 agent_settled。
 * - 扩展注册的工具会被 pi 自动激活，所以"默认禁用"要在 session_start 里主动摘掉。
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	HANDOFF_TYPE,
	START_TYPE,
	TOOL_NAME,
	findFreshTargetId,
	findPendingHandoff,
	hasPhaseStart,
	type HandoffData,
} from "./logic.js";

/**
 * 用户开关，按 sessionId 隔离。
 *
 * 放在模块顶层而不是工厂函数里：扩展模块被 loader 按路径缓存，父会话与子代理会话
 * 共享同一份模块状态，共用布尔量会被并发会话互相踩。
 */
const enabledSessions = new Set<string>();

/** 按当前分支状态对齐工具显隐。状态没变时不动 pi，避免无谓地重建系统提示。 */
function syncTool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId();
	const wanted = enabledSessions.has(sessionId) && !hasPhaseStart(ctx.sessionManager.getBranch());

	const active = pi.getActiveTools();
	const isActive = active.includes(TOOL_NAME);
	if (wanted === isActive) return;

	pi.setActiveTools(wanted ? [...active, TOOL_NAME] : active.filter((name) => name !== TOOL_NAME));
}

/** 把排队的交接落到新分支上执行。 */
async function runHandoff(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();

	const branch = ctx.sessionManager.getBranch();
	const pending = findPendingHandoff(branch, ctx.sessionManager.getEntries());
	if (!pending) {
		ctx.ui.notify("没有待派发的阶段交接。", "warning");
		return;
	}

	const target = findFreshTargetId(branch);
	if (!target) {
		ctx.ui.notify("找不到可切换的新起点，交接保留在队列里。", "warning");
		return;
	}

	const result = await ctx.navigateTree(target, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("切换被取消，交接仍在队列里，下次 agent 结束后会重试。", "warning");
		return;
	}

	// 消费标记写在新分支上：它在 fresh target 之后，所以既标记了后续阶段（工具隐藏），
	// 又让旧分支上那条 handoff 不再是待派发状态。
	pi.appendEntry<{ handoffId: string }>(START_TYPE, { handoffId: pending.id });
	// navigateTree 刚触发过 session_tree，那时新分支上还没有 START，工具可能已被重新
	// 激活，所以这里要再同步一次。
	syncTool(pi, ctx);
	pi.sendUserMessage(pending.prompt);
}

export default function nextPhase(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// 默认禁用：新会话与恢复的会话都回到关闭状态，要用得显式 /next-phase on。
		enabledSessions.delete(ctx.sessionManager.getSessionId());
		syncTool(pi, ctx);
	});

	// /tree 切分支后重算：回到阶段标记之前的分支就恢复工具。
	pi.on("session_tree", async (_event, ctx) => {
		syncTool(pi, ctx);
	});

	/**
	 * 派发点。agent_settled 时 isIdle() 为 true（pi 先把 _isAgentRunActive 置 false
	 * 再发事件），命令里的 waitForIdle / navigateTree 才是安全的。
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		if (!ctx.hasUI || !ctx.isIdle()) return;

		const pending = findPendingHandoff(ctx.sessionManager.getBranch(), ctx.sessionManager.getEntries());
		if (!pending) return;

		pi.sendUserMessage("/next-phase-run", { expandPromptTemplates: true });
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Next Phase",
		description:
			"Hand the next phase of work off to a fresh context. Queues a task that starts in a new branch with no conversation history, after the user confirms. Use it when the current phase is finished and the next step deserves a clean context.",
		promptSnippet: "Hand off the next phase to a fresh context (user confirms first)",
		promptGuidelines: [
			"Call next_phase only when the current phase is actually finished, and write its output to a file first — the next phase cannot see this conversation.",
			"Put everything the next phase needs into `prompt`: which files to read, what to build, and the acceptance criteria.",
			"Queue one handoff per phase boundary; do not queue several at once.",
		],
		parameters: Type.Object({
			title: Type.String({
				description: "Short label for the phase being handed off, shown in the confirmation dialog",
			}),
			prompt: Type.String({
				description:
					"The prompt the next phase starts from. Must be self-contained: files to read, goal, acceptance criteria",
			}),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "No interactive UI in this session, so the handoff cannot be confirmed. Nothing was queued; continue the current phase.",
						},
					],
					details: { queued: false },
				};
			}

			const confirmed = await ctx.ui.confirm(
				`开始下一阶段：${params.title}？`,
				"将保存检查点并切换到干净上下文执行这一步。对话历史不会带过去，需要交接的内容请先落盘。",
			);
			if (!confirmed) {
				return {
					content: [{ type: "text", text: "User declined the handoff. Continue the current phase." }],
					details: { queued: false },
				};
			}

			pi.appendEntry<HandoffData>(HANDOFF_TYPE, { title: params.title, prompt: params.prompt });
			return {
				content: [
					{
						type: "text",
						text: `Handoff "${params.title}" queued. The switch happens automatically as soon as this turn settles.`,
					},
				],
				details: { queued: true, title: params.title },
				terminate: true,
			};
		},
	});

	pi.registerCommand("next-phase", {
		description: "启用/禁用 next_phase 工具（默认禁用）。用法: /next-phase [on|off|status]",
		getArgumentCompletions: (prefix) =>
			[
				{ value: "on", label: "on", description: "启用 next_phase 工具" },
				{ value: "off", label: "off", description: "禁用 next_phase 工具" },
				{ value: "status", label: "status", description: "查看当前状态" },
			].filter((item) => item.value.startsWith(prefix.trim())),
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const action = args.trim().toLowerCase() || "status";

			if (action === "on") {
				enabledSessions.add(sessionId);
			} else if (action === "off") {
				enabledSessions.delete(sessionId);
			} else if (action !== "status") {
				ctx.ui.notify(`未知参数 "${action}"，用法: /next-phase [on|off|status]`, "warning");
				return;
			}

			syncTool(pi, ctx);

			const branch = ctx.sessionManager.getBranch();
			const active = pi.getActiveTools().includes(TOOL_NAME);
			const pending = findPendingHandoff(branch, ctx.sessionManager.getEntries());
			ctx.ui.notify(
				[
					`next_phase: ${active ? "已启用" : "已隐藏"}`,
					hasPhaseStart(branch) ? "当前分支处于后续阶段" : "当前分支处于初始阶段",
					pending ? `待派发交接: ${pending.title}` : "无待派发交接",
				].join(" | "),
				"info",
			);
		},
	});

	pi.registerCommand("next-phase-run", {
		description: "内部命令：执行已排队的阶段交接（由扩展在 agent_settled 时自动派发）",
		handler: async (_args, ctx) => {
			await runHandoff(pi, ctx);
		},
	});
}
