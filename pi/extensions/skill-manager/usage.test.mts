import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isSkillFile, normalizeSkillPath, parseEvent, serializeEvent, skillNameOf, usageLogPath } from "./usage.ts";

test("serializeEvent 产出单行 JSON 且以换行结尾", () => {
	const event = { ts: "2026-10-13T03:17:29.722Z", via: "read" as const, path: "/a/b/SKILL.md", session: "s1", cwd: "/a" };
	const line = serializeEvent(event);
	assert.equal(line.endsWith("\n"), true);
	assert.equal(line.trimEnd().includes("\n"), false);
	assert.deepEqual(parseEvent(line.trimEnd()), event);
});

test("parseEvent 对坏输入返回 undefined", () => {
	assert.equal(parseEvent("not json"), undefined);
	assert.equal(parseEvent('{"ts":"x"}'), undefined);
	assert.equal(parseEvent('{"ts":"x","via":"bogus","path":"p","session":"s","cwd":"c"}'), undefined);
});

test("usageLogPath 指向 extensions/pi-skills/usage.jsonl", () => {
	assert.equal(usageLogPath("/agent"), path.join("/agent", "extensions", "pi-skills", "usage.jsonl"));
});

test("isSkillFile 只认以 /SKILL.md 结尾的路径", () => {
	assert.equal(isSkillFile("D:\\a\\b\\SKILL.md"), true);
	assert.equal(isSkillFile("skills/foo/SKILL.md"), true);
	assert.equal(isSkillFile("skills/foo/skill.md"), false);
	assert.equal(isSkillFile("skills/foo/README.md"), false);
	assert.equal(isSkillFile("SKILL.md"), false);
});

test("normalizeSkillPath 把相对与反斜杠写法归一到同一结果", () => {
	const abs = "D:/code/skills/skills/foo/SKILL.md";
	assert.equal(normalizeSkillPath("D:\\code\\skills\\skills\\foo\\SKILL.md", "D:/code"), abs);
	assert.equal(normalizeSkillPath("skills/foo/SKILL.md", "D:/code/skills"), abs);
	assert.equal(normalizeSkillPath("./skills/foo/SKILL.md", "D:/code/skills"), abs);
	assert.equal(normalizeSkillPath(abs, "D:/elsewhere"), abs);
	assert.equal(normalizeSkillPath(abs, ""), abs);
});

test("normalizeSkillPath 不碰大小写", () => {
	assert.equal(normalizeSkillPath("D:/Code/Foo/SKILL.md", "D:/x"), "D:/Code/Foo/SKILL.md");
});

test("skillNameOf 取父目录名", () => {
	assert.equal(skillNameOf("D:/code/skills/skills/foo/SKILL.md"), "foo");
});
