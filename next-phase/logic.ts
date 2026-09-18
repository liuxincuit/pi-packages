/**
 * next-phase 的判定逻辑，全是纯函数。
 *
 * 单独成文件是为了能脱离 pi 运行时直接测（`node --test logic.test.mts`）：这里
 * 只有 type-only import，运行时被类型剥离全部擦除。
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "next_phase";

/** 工具排队的阶段交接；派发前处于待执行状态。 */
export const HANDOFF_TYPE = "next-phase-handoff";

/** 新分支上的阶段标记。分支上有它，说明已进入后续阶段（工具该隐藏）。 */
export const START_TYPE = "next-phase-start";

export interface HandoffData {
	title: string;
	prompt: string;
}

export interface PendingHandoff extends HandoffData {
	id: string;
}

type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

/** 参与 LLM 上下文的 entry 类型。新分支起点取第一条这类 entry 的父节点。 */
const MODEL_VISIBLE_TYPES = new Set(["message", "compaction", "branch_summary", "custom_message"]);

/**
 * 找新分支的起点：第一条 model-visible entry 的父节点。那个位置之后的对话全部留在
 * 旧分支上，新分支只有系统提示与工具。
 */
export function findFreshTargetId(branch: readonly SessionEntry[]): string | null {
	const first = branch[0];
	if (!first) return null;

	const firstVisible = branch.find((entry) => MODEL_VISIBLE_TYPES.has(entry.type));
	if (firstVisible?.parentId) return firstVisible.parentId;

	// 对话直接从根节点开始（前面没有 model_change 之类的设置 entry）时退到分支根，
	// 让 navigateTree 至少有一个可落脚的节点。
	return first.parentId ?? first.id;
}

/** 当前分支是否已进入后续阶段。 */
export function hasPhaseStart(branch: readonly SessionEntry[]): boolean {
	return branch.some((entry) => isCustom(entry, START_TYPE));
}

/**
 * 取待派发的交接：分支上最后一个 handoff entry，且它没有被任何 START entry 引用过。
 *
 * START 落在新分支上，所以消费状态要查全会话而不只是当前分支——否则用户用 /tree
 * 回到旧分支时，同一个交接会被再派发一次。
 */
export function findPendingHandoff(
	branch: readonly SessionEntry[],
	entries: readonly SessionEntry[],
): PendingHandoff | null {
	const consumed = new Set<string>();
	for (const entry of entries) {
		if (!isCustom(entry, START_TYPE)) continue;
		const handoffId = readString(entry.data, "handoffId");
		if (handoffId) consumed.add(handoffId);
	}

	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isCustom(entry, HANDOFF_TYPE)) continue;
		if (consumed.has(entry.id)) return null;

		const title = readString(entry.data, "title");
		const prompt = readString(entry.data, "prompt");
		return title && prompt ? { id: entry.id, title, prompt } : null;
	}

	return null;
}

function isCustom(entry: SessionEntry | undefined, customType: string): entry is CustomEntry {
	return entry?.type === "custom" && entry.customType === customType;
}

function readString(data: unknown, key: string): string | null {
	if (typeof data !== "object" || data === null) return null;

	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}
