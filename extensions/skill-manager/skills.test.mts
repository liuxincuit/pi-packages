import assert from "node:assert/strict";
import test from "node:test";

import { fromOptions, fromSystemPrompt, mergeSkills, readSkills, toEntry } from "./skills.ts";
import type { SkillEntry } from "./skills.ts";

const PROMPT = `some preamble

<available_skills>
  <skill>
    <name>pdf-tools</name>
    <description>Extract text &amp; tables from PDF</description>
    <location>/tmp/pdf-tools/SKILL.md</location>
  </skill>
  <skill>
    <name>xlsx</name>
    <description>表格处理</description>
    <location>/tmp/xlsx/SKILL.md</location>
  </skill>
</available_skills>`;

function entry(over: Partial<SkillEntry>): SkillEntry {
	return {
		name: "n",
		description: "",
		filePath: "",
		scope: "user",
		origin: "top-level",
		disableModelInvocation: false,
		...over,
	};
}

test("toEntry 归一化 pi 的 Skill 对象", () => {
	assert.deepEqual(
		toEntry({
			name: "xlsx",
			description: "表格",
			filePath: "/a/SKILL.md",
			sourceInfo: { scope: "user", origin: "package" },
			disableModelInvocation: true,
		}),
		{
			name: "xlsx",
			description: "表格",
			filePath: "/a/SKILL.md",
			scope: "user",
			origin: "package",
			disableModelInvocation: true,
		},
	);
});

test("toEntry 缺 name 时丢弃，缺 sourceInfo 时记为 unknown", () => {
	assert.equal(toEntry({ description: "无名字" }), undefined);
	assert.equal(toEntry({ name: "a" })?.scope, "unknown");
	assert.equal(toEntry({ name: "a" })?.disableModelInvocation, false);
});

test("fromOptions 处理非数组与无效条目", () => {
	assert.deepEqual(fromOptions(undefined), []);
	assert.deepEqual(fromOptions({ skills: "nope" }), []);
	assert.equal(fromOptions({ skills: [{ name: "a" }, {}, { name: "b" }] }).length, 2);
});

test("fromSystemPrompt 解析 XML 并还原转义", () => {
	const entries = fromSystemPrompt(PROMPT);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].name, "pdf-tools");
	assert.equal(entries[0].description, "Extract text & tables from PDF");
	assert.equal(entries[0].filePath, "/tmp/pdf-tools/SKILL.md");
	assert.equal(entries[0].disableModelInvocation, false);
	assert.equal(entries[1].name, "xlsx");
	assert.deepEqual(fromSystemPrompt("nothing here"), []);
});

test("mergeSkills 补齐字段并保留 supplement 独有的 skill", () => {
	const primary = fromSystemPrompt(PROMPT);
	const supplement = [
		entry({ name: "pdf-tools", scope: "user", origin: "package" }),
		entry({ name: "hidden", description: "作者隐藏", disableModelInvocation: true }),
	];
	const merged = mergeSkills(primary, supplement);
	assert.deepEqual(
		merged.map((item) => item.name),
		["pdf-tools", "xlsx", "hidden"],
	);
	assert.equal(merged[0].scope, "user");
	assert.equal(merged[0].origin, "package");
	assert.equal(merged[2].disableModelInvocation, true);
});

test("readSkills 优先用 getSystemPromptOptions", () => {
	const ctx = {
		getSystemPromptOptions: () => ({ skills: [{ name: "from-options" }] }),
		getSystemPrompt: () => PROMPT,
	};
	assert.deepEqual(
		readSkills(ctx).map((item) => item.name),
		["from-options"],
	);
});

test("readSkills 无 options 时降级解析系统提示并用 loadSkills 补齐", () => {
	const ctx = { getSystemPrompt: () => PROMPT };
	const entries = readSkills(ctx, {
		loadSkills: () => [
			entry({ name: "xlsx", description: "表格处理", scope: "project" }),
			entry({ name: "hidden", disableModelInvocation: true }),
		],
	});
	assert.deepEqual(
		entries.map((item) => item.name),
		["pdf-tools", "xlsx", "hidden"],
	);
	assert.equal(entries.find((item) => item.name === "xlsx")?.scope, "project");
});

test("readSkills 在两种来源都不可用时返回兜底结果", () => {
	assert.deepEqual(readSkills({}), []);
	assert.deepEqual(
		readSkills({}, { loadSkills: () => [entry({ name: "only" })] }).map((item) => item.name),
		["only"],
	);
});
