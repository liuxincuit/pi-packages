/**
 * logic.ts 的单元测试。零依赖，直接跑：
 *
 *   node --test pi/extensions/tree-summaries/logic.test.mts
 *
 * 用 .mts 后缀是为了让 Node 按 ESM 解析，避免仓库 package.json 缺 "type": "module"
 * 时的重解析警告。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	buildInstructions,
	changedFiles,
	firstUserMessageId,
	GLOBAL_DIR_SEGMENTS,
	hasEntriesAfter,
	lastAssistantAborted,
	parsePlanFile,
	PROJECT_DIR_SEGMENTS,
	scanPlanDirs,
	snapshotDir,
	type SummaryPlan,
} from "./logic.ts";

const STAMP = "2026-01-01T00:00:00.000Z";

/** 造 entry；测试只关心 id / type / message.role 这几个字段。 */
const entry = (value: Record<string, unknown>): SessionEntry => value as unknown as SessionEntry;

const user = (id: string): SessionEntry =>
	entry({ id, parentId: null, timestamp: STAMP, type: "message", message: { role: "user", content: [] } });

const assistant = (id: string, stopReason = "stop"): SessionEntry =>
	entry({ id, parentId: null, timestamp: STAMP, type: "message", message: { role: "assistant", content: [], stopReason } });

const label = (id: string): SessionEntry =>
	entry({ id, parentId: null, timestamp: STAMP, type: "label", targetId: "u1", label: "checkpoint" });

const plan = (raw: string, name = "req.md") => parsePlanFile(raw, `/tmp/tree-summaries/${name}`, "project");

// ---- parsePlanFile ----

test("parsePlanFile: 无 frontmatter 时正文即全部内容，mode 默认 append", () => {
	const result = plan("总结需求和验收标准");
	assert.equal(result?.name, "req");
	assert.equal(result?.commandName, "tree:req");
	assert.equal(result?.kind, "summary");
	assert.equal(result?.mode, "append");
	assert.equal(result?.body, "总结需求和验收标准");
	assert.equal(result?.description, undefined);
	assert.equal(result?.scope, "project");
});

test("parsePlanFile: 解析 frontmatter 的 description / argument-hint / mode", () => {
	const result = plan(
		[
			"---",
			"description: 需求维度交接",
			"argument-hint: [关注点]",
			"mode: replace",
			"---",
			"只保留需求相关的内容",
		].join("\n"),
		"req.md",
	);
	assert.equal(result?.description, "需求维度交接");
	assert.equal(result?.argumentHint, "[关注点]");
	assert.equal(result?.mode, "replace");
	assert.equal(result?.body, "只保留需求相关的内容");
});

test("parsePlanFile: 非法 mode 回落到 append", () => {
	assert.equal(plan("---\nmode: 随便写\n---\n正文")?.mode, "append");
});

test("parsePlanFile: kind=agent 与 output-dir", () => {
	const result = plan(["---", "kind: agent", "output-dir: .pi/handoffs", "---", "写交接文档"].join("\n"));
	assert.equal(result?.kind, "agent");
	assert.equal(result?.outputDir, ".pi/handoffs");
});

test("parsePlanFile: 非法 kind 回落到 summary，未配 output-dir 时为 undefined", () => {
	const result = plan("---\nkind: 随便写\n---\n正文");
	assert.equal(result?.kind, "summary");
	assert.equal(result?.outputDir, undefined);
});

test("parsePlanFile: 空正文返回 null", () => {
	assert.equal(plan("---\ndescription: 只有 frontmatter\n---\n"), null);
	assert.equal(plan("   \n"), null);
});

test("parsePlanFile: 文件名含空白时返回 null（命令名会被空格切开）", () => {
	assert.equal(plan("正文", "my plan.md"), null);
	assert.equal(plan("正文", "  .md"), null);
});

test("parsePlanFile: 保留中文与冒号等可用字符", () => {
	assert.equal(plan("正文", "需求总结.md")?.commandName, "tree:需求总结");
	assert.equal(plan("正文", "a:b.md")?.commandName, "tree:a:b");
});

test("parsePlanFile: frontmatter 里的引号被剥掉", () => {
	assert.equal(plan('---\ndescription: "带引号的说明"\n---\n正文')?.description, "带引号的说明");
});

// ---- buildInstructions ----

const makePlan = (body: string, mode: SummaryPlan["mode"] = "append"): SummaryPlan => ({
	commandName: "tree:x",
	name: "x",
	kind: "summary",
	mode,
	body,
	filePath: "/tmp/tree-summaries/x.md",
	scope: "project",
});

test("buildInstructions: 无附加文字时返回正文", () => {
	assert.equal(buildInstructions(makePlan("关注并发安全"), ""), "关注并发安全");
	assert.equal(buildInstructions(makePlan("关注并发安全"), "   \n  "), "关注并发安全");
});

test("buildInstructions: 附加文字另起一节拼在后面", () => {
	const result = buildInstructions(makePlan("关注并发安全"), "  重点总结多线程并发访问问题  ");
	assert.equal(result, "关注并发安全\n\n## 补充要求\n\n重点总结多线程并发访问问题");
});

// ---- firstUserMessageId ----

test("firstUserMessageId: 取最靠前的一条用户消息", () => {
	const branch = [assistant("a0"), user("u1"), assistant("a1"), user("u2")];
	assert.equal(firstUserMessageId(branch), "u1");
});

test("firstUserMessageId: 忽略非消息 entry 与 assistant 消息", () => {
	assert.equal(firstUserMessageId([label("l1"), assistant("a1")]), undefined);
	assert.equal(firstUserMessageId([]), undefined);
});

// ---- hasEntriesAfter ----

test("hasEntriesAfter: 目标之后还有 entry", () => {
	const branch = [user("u1"), assistant("a1")];
	assert.equal(hasEntriesAfter(branch, "u1"), true);
});

test("hasEntriesAfter: 目标就是最后一条（刚发完第一条消息）", () => {
	assert.equal(hasEntriesAfter([user("u1")], "u1"), false);
});

test("hasEntriesAfter: 目标不在分支上", () => {
	assert.equal(hasEntriesAfter([user("u1")], "nope"), false);
});

// ---- lastAssistantAborted ----

test("lastAssistantAborted: 最后一条 assistant 被中断", () => {
	assert.equal(lastAssistantAborted([user("u1"), assistant("a1", "aborted")]), true);
});

test("lastAssistantAborted: 取最后一条 assistant，忽略其后的用户消息", () => {
	const branch = [assistant("a1", "aborted"), assistant("a2", "stop"), user("u2")];
	assert.equal(lastAssistantAborted(branch), false);
});

test("lastAssistantAborted: 没有 assistant 消息时不算中断", () => {
	assert.equal(lastAssistantAborted([user("u1")]), false);
	assert.equal(lastAssistantAborted([]), false);
});

// ---- snapshotDir / changedFiles ----

test("snapshotDir: 目录不存在时返回空表", () => {
	const { cwd } = makeDirs();
	assert.equal(snapshotDir(path.join(cwd, "nope")).size, 0);
});

test("snapshotDir: 只记录文件，忽略子目录", () => {
	const { cwd, write } = makeDirs();
	write("project/notes/a.md", "A");
	fs.mkdirSync(path.join(cwd, "notes", "sub"), { recursive: true });

	const snapshot = snapshotDir(path.join(cwd, "notes"));
	assert.deepEqual([...snapshot.keys()], ["a.md"]);
	assert.equal(typeof snapshot.get("a.md"), "number");
});

test("changedFiles: 只返回新增或被修改的文件，最近的在前", () => {
	const before = new Map([
		["old.md", 100],
		["touched.md", 100],
	]);
	const after = new Map([
		["old.md", 100],
		["touched.md", 300],
		["new.md", 200],
	]);

	assert.deepEqual(changedFiles(before, after), ["touched.md", "new.md"]);
});

test("changedFiles: 什么都没变时返回空", () => {
	const snapshot = new Map([["a.md", 100]]);
	assert.deepEqual(changedFiles(snapshot, snapshot), []);
});

// ---- scanPlanDirs ----

/** 造一套项目目录 + 全局目录，返回 { cwd, home, write } 供测试使用。 */
function makeDirs(): { cwd: string; home: string; write: (rel: string, content: string) => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-summaries-"));
	const cwd = path.join(root, "project");
	const home = path.join(root, "home");
	const write = (rel: string, content: string) => {
		const target = path.join(root, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	};
	return { cwd, home, write };
}

const projectDir = (cwd: string) => path.join(cwd, ...PROJECT_DIR_SEGMENTS);
const globalDir = (home: string) => path.join(home, ...GLOBAL_DIR_SEGMENTS);

test("scanPlanDirs: 目录不存在时返回空", () => {
	const { cwd, home } = makeDirs();
	assert.deepEqual(scanPlanDirs(cwd, home, { includeProject: true }), []);
});

test("scanPlanDirs: 按文件名排序并扫描两个 scope", () => {
	const { cwd, home, write } = makeDirs();
	write("project/.pi/tree-summaries/zeta.md", "Z 正文");
	write("home/.pi/agent/extensions/tree-summaries/alpha.md", "A 正文");

	const plans = scanPlanDirs(cwd, home, { includeProject: true });
	assert.deepEqual(
		plans.map((plan) => plan.commandName),
		["tree:alpha", "tree:zeta"],
	);
	assert.equal(plans[0].scope, "global");
	assert.equal(plans[1].scope, "project");
});

test("scanPlanDirs: 同名时项目级优先", () => {
	const { cwd, home, write } = makeDirs();
	write("project/.pi/tree-summaries/req.md", "项目级正文");
	write("home/.pi/agent/tree-summaries/req.md", "全局正文");

	const plans = scanPlanDirs(cwd, home, { includeProject: true });
	assert.equal(plans.length, 1);
	assert.equal(plans[0].body, "项目级正文");
	assert.equal(plans[0].scope, "project");
});

test("scanPlanDirs: includeProject=false 时不读项目目录", () => {
	const { cwd, home, write } = makeDirs();
	write("project/.pi/tree-summaries/req.md", "项目级正文");

	assert.deepEqual(scanPlanDirs(cwd, home, { includeProject: false }), []);
});

test("scanPlanDirs: 全局方案目录在 ~/.pi/agent/extensions/ 下", () => {
	const { cwd, home, write } = makeDirs();
	write("home/.pi/agent/extensions/tree-summaries/req.md", "全局正文");

	const plans = scanPlanDirs(cwd, home, { includeProject: true });
	assert.equal(plans.length, 1);
	assert.equal(plans[0].body, "全局正文");
	assert.equal(plans[0].scope, "global");
});

test("scanPlanDirs: 内置方案优先级最低，依次被全局、项目覆盖", () => {
	const { cwd, home, write } = makeDirs();
	const builtinDir = path.join(path.dirname(cwd), "builtin");
	write("builtin/req.md", "内置正文");
	write("builtin/handoff.md", "内置 handoff 正文");

	let plans = scanPlanDirs(cwd, home, { includeProject: true, builtinDir });
	assert.deepEqual(
		plans.map((plan) => plan.name),
		["handoff", "req"],
	);
	assert.equal(plans.find((plan) => plan.name === "req")?.scope, "builtin");

	write("home/.pi/agent/extensions/tree-summaries/req.md", "全局正文");
	plans = scanPlanDirs(cwd, home, { includeProject: true, builtinDir });
	assert.equal(plans.find((plan) => plan.name === "req")?.body, "全局正文");
	assert.equal(plans.find((plan) => plan.name === "req")?.scope, "global");

	write("project/.pi/tree-summaries/req.md", "项目级正文");
	plans = scanPlanDirs(cwd, home, { includeProject: true, builtinDir });
	assert.equal(plans.find((plan) => plan.name === "req")?.body, "项目级正文");
	assert.equal(plans.find((plan) => plan.name === "req")?.scope, "project");
});

test("scanPlanDirs: 不传 builtinDir 时不读内置目录", () => {
	const { cwd, home, write } = makeDirs();
	write("builtin/req.md", "内置正文");

	assert.deepEqual(scanPlanDirs(cwd, home, { includeProject: true }), []);
});

test("scanPlanDirs: 跳过非 .md、隐藏文件、含空格名称与空正文", () => {
	const { cwd, home, write } = makeDirs();
	const dir = projectDir(cwd);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "notes.txt"), "不是 md");
	fs.writeFileSync(path.join(dir, ".hidden.md"), "隐藏文件");
	fs.writeFileSync(path.join(dir, "my plan.md"), "含空格");
	fs.writeFileSync(path.join(dir, "empty.md"), "---\ndescription: 只有 frontmatter\n---\n");
	fs.writeFileSync(path.join(dir, "ok.md"), "可用正文");

	const plans = scanPlanDirs(cwd, home, { includeProject: true });
	assert.deepEqual(
		plans.map((plan) => plan.name),
		["ok"],
	);
});
