/**
 * tree-summaries — 把「总结当前对话 + 回到会话树开头」做成可配置的预设方案。
 *
 * 一个方案 = 方案目录下的一个 .md 文件，正文是摘要指令，文件名是命令名：
 *   <cwd>/.pi/tree-summaries/req.md                    →  /tree:req
 *   ~/.pi/agent/extensions/tree-summaries/req.md       →  /tree:req   （同名时项目级优先）
 *
 * 执行链路：命令 handler → waitForIdle → navigateTree(分支第一条用户消息)
 * → 内置摘要器拿方案正文当指令生成摘要 → 摘要 entry 落在旧对话之前，成为当前 leaf。
 * 全程同一个 session 文件，旧分支用 /tree 一步回得去。
 *
 * 四个不显然的约束（改代码前先读）：
 * - 会话控制方法（waitForIdle / navigateTree）只挂在 ExtensionCommandContext 上，
 *   事件处理器拿到的 ExtensionContext 没有，所以动作必须由命令触发。
 * - navigateTree 在 streaming 时直接抛错，handler 里必须先 waitForIdle。
 * - 方案文件在 handler 里现读，所以改正文立刻生效；只有增删文件才需要 /reload
 *   （命令列表在 session_start 时扫一次）。
 * - 摘要是增量的：目标取「当前分支第一条用户消息」，所以第二次交接只覆盖上一次
 *   交接之后的内容，不会摘要套摘要。
 */

import os from "node:os";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	buildInstructions,
	firstUserMessageId,
	hasEntriesAfter,
	scanPlanDirs,
	type SummaryPlan,
} from "./logic.js";

const STATUS_KEY = "tree-summaries";

function loadPlans(ctx: ExtensionContext): SummaryPlan[] {
	return scanPlanDirs(ctx.cwd, os.homedir(), { includeProject: ctx.isProjectTrusted() });
}

/** 补全列表里的描述：标注项目级/全局级，并带上参数提示。 */
function describePlan(plan: SummaryPlan): string {
	const scope = plan.scope === "project" ? "项目" : "全局";
	const label = plan.description ?? plan.name;
	return plan.argumentHint ? `[${scope}] ${label} ${plan.argumentHint}` : `[${scope}] ${label}`;
}

async function runPlan(ctx: ExtensionCommandContext, name: string, args: string): Promise<void> {
	await ctx.waitForIdle();

	const plan = loadPlans(ctx).find((item) => item.name === name);
	if (!plan) {
		ctx.ui.notify(`方案「${name}」不存在（可能已删除，或属于另一个项目目录）。`, "warning");
		return;
	}

	const branch = ctx.sessionManager.getBranch();
	const targetId = firstUserMessageId(branch);
	if (!targetId) {
		ctx.ui.notify("当前分支还没有用户消息，没有可交接的内容。", "warning");
		return;
	}
	if (!hasEntriesAfter(branch, targetId)) {
		ctx.ui.notify("当前分支只有一条用户消息，没有可总结的内容。", "warning");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `正在按「${name}」总结当前对话...`);
	try {
		const result = await ctx.navigateTree(targetId, {
			summarize: true,
			customInstructions: buildInstructions(plan, args),
			replaceInstructions: plan.mode === "replace",
		});
		if (result.cancelled) {
			ctx.ui.notify("交接已取消。", "info");
			return;
		}
		ctx.ui.notify(`已按「${name}」总结并回到对话开头。`, "info");
	} catch (error) {
		ctx.ui.notify(`交接失败：${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function (pi: ExtensionAPI): void {
	// 会话开始（含 /new、/resume、/reload）时按当前 cwd 重建命令列表。
	// 重复注册同名命令只是覆盖，不会产生重复项。
	pi.on("session_start", (_event, ctx) => {
		for (const plan of loadPlans(ctx)) {
			pi.registerCommand(plan.commandName, {
				description: describePlan(plan),
				handler: (args, commandCtx) => runPlan(commandCtx, plan.name, args),
			});
		}
	});
}
