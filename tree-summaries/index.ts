/**
 * tree-summaries — 把「干活（可选）+ 回到会话树开头 + 留下上下文」做成可配置的预设方案。
 *
 * 一个方案 = 方案目录下的一个 .md 文件，正文是指令，文件名是命令名：
 *   <cwd>/.pi/tree-summaries/req.md                    →  /tree:req
 *   ~/.pi/agent/extensions/tree-summaries/req.md       →  /tree:req   （同名时项目级优先）
 *
 * 两种执行方式，由 frontmatter 的 kind 决定：
 * - summary（默认）：navigateTree 拿方案正文当自定义指令，交内置摘要器生成一条摘要
 *   entry，挂在旧对话之前。
 * - agent：方案正文发给当前 agent 执行（它有全套工具，能写文件、能引用 skill），
 *   干完后切回**分支最前端**，把产出文件的路径填进编辑器（不直接发出去）。
 *
 * 全程同一个 session 文件，旧分支用 /tree 一步回得去。
 *
 * 几个不显然的约束（改代码前先读）：
 * - 会话控制方法（waitForIdle / navigateTree）只挂在 ExtensionCommandContext 上，
 *   事件处理器拿到的 ExtensionContext 没有，所以动作必须由命令触发。
 * - navigateTree 在 streaming 时直接抛错，handler 里必须先 waitForIdle。
 * - 方案文件在 handler 里现读，所以改正文立刻生效；只有增删文件才需要 /reload
 *   （命令列表在 session_start 时扫一次）。
 * - summary 型的摘要是增量的：目标取「当前分支第一条用户消息」，所以第二次交接
 *   只覆盖上一次交接之后的内容，不会摘要套摘要。
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	buildInstructions,
	changedFiles,
	firstUserMessageId,
	hasEntriesAfter,
	lastAssistantAborted,
	scanPlanDirs,
	snapshotDir,
	type PlanScope,
	type SummaryPlan,
} from "./logic.js";

const STATUS_KEY = "tree-summaries";

const SCOPE_LABELS: Record<PlanScope, string> = { project: "项目", global: "全局", builtin: "内置" };

/** 内置方案目录，随扩展文件走；项目和全局目录里都没有同名文件时才用它。 */
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

/**
 * 等 agent 干完活的 waiter 队列，由 agent_settled 事件清空。
 *
 * pi.sendUserMessage 是 fire-and-forget（不返回 Promise），而 prompt 内部要走过
 * 若干异步步骤才会把 agent 标记为运行中；紧跟着调 ctx.waitForIdle() 会因此刻
 * 仍然空闲而立刻返回。只有 agent_settled 能可靠地表示「这一轮跑完了」。
 *
 * 用队列而不是单个变量：agent 干活期间用户再敲一次命令时，两个 handler 都会
 * 等这一轮结束，单个变量会被后者覆盖，前一个永远等不到。
 */
let settleWaiters: Array<() => void> = [];

function loadPlans(ctx: ExtensionContext): SummaryPlan[] {
	return scanPlanDirs(ctx.cwd, os.homedir(), {
		includeProject: ctx.isProjectTrusted(),
		builtinDir: BUILTIN_DIR,
	});
}

/** 补全列表里的描述：标注项目级/全局级/内置，并带上参数提示。 */
function describePlan(plan: SummaryPlan): string {
	const label = plan.description ?? plan.name;
	const scope = SCOPE_LABELS[plan.scope];
	return plan.argumentHint ? `[${scope}] ${label} ${plan.argumentHint}` : `[${scope}] ${label}`;
}

/** agent 型：把正文当任务交给当前 agent，等它干完再切分支。 */
async function runAgentPlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	plan: SummaryPlan,
	args: string,
	targetId: string,
): Promise<void> {
	// 只有配了 output-dir 才追踪产物：开工前扫一次，收工后扫一次，差集就是交接写出的文件
	const outputDir = plan.outputDir ? path.join(ctx.cwd, plan.outputDir) : undefined;
	const before = outputDir ? snapshotDir(outputDir) : undefined;

	const settled = new Promise<void>((resolve) => settleWaiters.push(resolve));
	pi.sendUserMessage(buildInstructions(plan, args));
	await settled;

	// 用户中途按 ESC：别在人家没要求的时候突然跳走
	if (lastAssistantAborted(ctx.sessionManager.getBranch())) {
		ctx.ui.notify("已中断，未切换分支。", "info");
		return;
	}

	let artifact: string | undefined;
	if (outputDir && before) {
		const changed = changedFiles(before, snapshotDir(outputDir));
		if (changed.length === 0) {
			ctx.ui.notify(`没有在 ${plan.outputDir} 下找到新写的文件，未切换分支。`, "warning");
			return;
		}
		artifact = path.relative(ctx.cwd, path.join(outputDir, changed[0]));
	}

	const result = await ctx.navigateTree(targetId, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("交接已取消。", "info");
		return;
	}

	// 切完后分支是空的，交接文档是唯一上下文：把路径填进编辑器而不是直接发出去，
	// 用户可以先过目/改一句再回车，也可能压根不想接着干。
	if (artifact) {
		ctx.ui.setEditorText(`继续之前的工作，先读 ${artifact}。`);
	}
	ctx.ui.notify(`已按「${plan.name}」交接并回到对话开头。`, "info");
}

/** summary 型：正文交给内置摘要器，生成一条挂在旧对话之前的摘要 entry。 */
async function runSummaryPlan(
	ctx: ExtensionCommandContext,
	plan: SummaryPlan,
	args: string,
	targetId: string,
): Promise<void> {
	const result = await ctx.navigateTree(targetId, {
		summarize: true,
		customInstructions: buildInstructions(plan, args),
		replaceInstructions: plan.mode === "replace",
	});
	if (result.cancelled) {
		ctx.ui.notify("交接已取消。", "info");
		return;
	}
	ctx.ui.notify(`已按「${plan.name}」总结并回到对话开头。`, "info");
}

async function runPlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	name: string,
	args: string,
): Promise<void> {
	await ctx.waitForIdle();

	const plan = loadPlans(ctx).find((item) => item.name === name);
	if (!plan) {
		ctx.ui.notify(`方案「${name}」不存在（可能已删除，或属于另一个项目目录）。`, "warning");
		return;
	}

	const branch = ctx.sessionManager.getBranch();
	const firstUser = firstUserMessageId(branch);
	if (!firstUser) {
		ctx.ui.notify("当前分支还没有用户消息，没有可交接的内容。", "warning");
		return;
	}
	if (!hasEntriesAfter(branch, firstUser)) {
		ctx.ui.notify("当前分支只有一条用户消息，没有可交接的内容。", "warning");
		return;
	}

	// 切割点两种 kind 不同：
	// - summary 落在「第一条用户消息之前」，新摘要接在链上旧摘要之后，形成增量摘要链
	// - agent 落在「分支最前端」——它不生成摘要，链上那些旧摘要属于上一次交接，
	//   留着只会让接手者误以为那是本次交接的内容
	const targetId = plan.kind === "agent" ? branch[0].id : firstUser;

	ctx.ui.setStatus(
		STATUS_KEY,
		plan.kind === "agent" ? `正在按「${name}」执行交接任务...` : `正在按「${name}」总结当前对话...`,
	);
	try {
		if (plan.kind === "agent") {
			await runAgentPlan(pi, ctx, plan, args, targetId);
		} else {
			await runSummaryPlan(ctx, plan, args, targetId);
		}
	} catch (error) {
		ctx.ui.notify(`交接失败：${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

export default function (pi: ExtensionAPI): void {
	// agent 型方案的收工信号：一轮 agent 彻底跑完（含重试、压缩、follow-up）才触发
	pi.on("agent_settled", () => {
		const waiters = settleWaiters;
		settleWaiters = [];
		for (const resolve of waiters) resolve();
	});

	// 会话开始（含 /new、/resume、/reload）时按当前 cwd 重建命令列表。
	// 重复注册同名命令只是覆盖，不会产生重复项。
	pi.on("session_start", (_event, ctx) => {
		for (const plan of loadPlans(ctx)) {
			pi.registerCommand(plan.commandName, {
				description: describePlan(plan),
				handler: (args, commandCtx) => runPlan(pi, commandCtx, plan.name, args),
			});
		}
	});
}
