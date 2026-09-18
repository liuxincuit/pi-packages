/**
 * logic.ts 的单元测试。零依赖，直接跑：
 *
 *   node --test pi/extensions/next-phase/logic.test.mts
 *
 * 用 .mts 后缀是为了让 Node 按 ESM 解析，避免仓库 package.json 缺 "type": "module"
 * 时的重解析警告。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	HANDOFF_TYPE,
	START_TYPE,
	findFreshTargetId,
	findPendingHandoff,
	hasPhaseStart,
} from "./logic.ts";

const STAMP = "2026-01-01T00:00:00.000Z";

/** 造 entry；测试只关心 id / parentId / type / data 这几个字段。 */
const entry = (value: Record<string, unknown>): SessionEntry =>
	value as unknown as SessionEntry;

const setup = (id: string, parentId: string | null): SessionEntry =>
	entry({ id, parentId, timestamp: STAMP, type: "model_change", provider: "p", modelId: "m" });

const message = (id: string, parentId: string | null): SessionEntry =>
	entry({ id, parentId, timestamp: STAMP, type: "message", message: { role: "user", content: [] } });

const custom = (
	id: string,
	parentId: string | null,
	customType: string,
	data?: unknown,
): SessionEntry => entry({ id, parentId, timestamp: STAMP, type: "custom", customType, data });

const handoff = (id: string, parentId: string | null, title = "阶段1"): SessionEntry =>
	custom(id, parentId, HANDOFF_TYPE, { title, prompt: `${title} 的任务` });

const start = (id: string, parentId: string | null, handoffId: string): SessionEntry =>
	custom(id, parentId, START_TYPE, { handoffId });

test("findFreshTargetId: 空分支返回 null", () => {
	assert.equal(findFreshTargetId([]), null);
});

test("findFreshTargetId: 取第一条 model-visible entry 的父节点", () => {
	const branch = [setup("s1", null), message("u1", "s1"), message("a1", "u1")];
	assert.equal(findFreshTargetId(branch), "s1");
});

test("findFreshTargetId: 跳过 setup 与数据型 custom entry", () => {
	const branch = [
		setup("s1", null),
		custom("c1", "s1", "some-other-extension", { x: 1 }),
		message("u1", "c1"),
	];
	assert.equal(findFreshTargetId(branch), "c1");
});

test("findFreshTargetId: 对话从根开始时退到分支根", () => {
	const branch = [message("u1", null), message("a1", "u1")];
	assert.equal(findFreshTargetId(branch), "u1");
});

test("hasPhaseStart: 无标记为初始阶段", () => {
	const branch = [setup("s1", null), message("u1", "s1")];
	assert.equal(hasPhaseStart(branch), false);
});

test("hasPhaseStart: 分支上有标记即后续阶段", () => {
	const branch = [setup("s1", null), message("u1", "s1"), start("p1", "u1", "h1")];
	assert.equal(hasPhaseStart(branch), true);
});

test("findPendingHandoff: 无交接返回 null", () => {
	const branch = [setup("s1", null), message("u1", "s1")];
	assert.equal(findPendingHandoff(branch, branch), null);
});

test("findPendingHandoff: 末尾未消费的交接被取回", () => {
	const branch = [setup("s1", null), message("u1", "s1"), handoff("h1", "u1", "需求分析")];
	assert.deepEqual(findPendingHandoff(branch, branch), {
		id: "h1",
		title: "需求分析",
		prompt: "需求分析 的任务",
	});
});

test("findPendingHandoff: START 引用了该交接则视为已消费（跨分支）", () => {
	const branch = [setup("s1", null), message("u1", "s1"), handoff("h1", "u1")];
	const newBranch = [setup("s1", null), start("p1", "s1", "h1"), message("u2", "p1")];
	const all = [...branch, ...newBranch.slice(1)];
	assert.equal(findPendingHandoff(branch, all), null);
});

test("findPendingHandoff: 老交接已消费后新排队一个，取新的", () => {
	const branch = [setup("s1", null), handoff("h1", "s1"), handoff("h2", "h1", "复审")];
	const all = [...branch, start("p1", "s1", "h1")];
	assert.equal(findPendingHandoff(branch, all)?.id, "h2");
});

test("findPendingHandoff: 交接不在当前分支（用户回退到更早节点）时为 null", () => {
	const branch = [setup("s1", null), message("u1", "s1"), handoff("h1", "u1")];
	const rewound = [setup("s1", null), message("u1", "s1")];
	assert.equal(findPendingHandoff(rewound, branch), null);
});

test("findPendingHandoff: 交接数据缺字段视为无效", () => {
	const branch = [setup("s1", null), custom("h1", "s1", HANDOFF_TYPE, { title: "只有标题" })];
	assert.equal(findPendingHandoff(branch, branch), null);
});
