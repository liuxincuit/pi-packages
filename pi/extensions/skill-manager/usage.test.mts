import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	aggregate,
	appendEvent,
	isSkillFile,
	normalizeSkillPath,
	parseEvent,
	readEvents,
	serializeEvent,
	skillNameOf,
	USAGE_WINDOWS,
	usageLogPath,
	type UsageEvent,
} from "./usage.ts";

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

const E1 = { ts: "2026-10-13T01:00:00.000Z", via: "read" as const, path: "/a/one/SKILL.md", session: "s", cwd: "/a" } satisfies UsageEvent;
const E2 = { ts: "2026-10-13T02:00:00.000Z", via: "read" as const, path: "/a/two/SKILL.md", session: "s", cwd: "/a" } satisfies UsageEvent;
const tmpFile = (name = "log.jsonl") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), name);

test("readEvents 对缺失文件、空文件返回空数组", () => {
	assert.deepEqual(readEvents(tmpFile("nope.jsonl")), []);
	const empty = tmpFile("empty.jsonl");
	fs.writeFileSync(empty, "");
	assert.deepEqual(readEvents(empty), []);
});

test("readEvents 跳过坏行与末行截断，其余完整返回", () => {
	const file = tmpFile();
	fs.writeFileSync(file, [
		serializeEvent(E1).trimEnd(),
		"not json",
		serializeEvent(E2).trimEnd(),
		'{"ts":"2026-10-13T05:00:00.000Z","via":"read"',   // 末行截断，且无结尾换行
	].join("\n"));
	assert.deepEqual(readEvents(file), [E1, E2]);
});

test("appendEvent 在目录不存在时自动创建", () => {
	const file = tmpFile("nested/log.jsonl");
	assert.doesNotThrow(() => appendEvent(file, E1));
	assert.deepEqual(readEvents(file), [E1]);
});

test("appendEvent 在写入失败时不抛异常", () => {
	const file = tmpFile("as-dir.jsonl");
	fs.mkdirSync(file);
	assert.doesNotThrow(() => appendEvent(file, E1));
});

const NOW = new Date("2026-10-13T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const ev = (hoursAgo: number, name: string): UsageEvent =>
	({ ts: at(hoursAgo), via: "read", path: `D:/s/${name}/SKILL.md`, session: "s", cwd: "D:/s" });

test("USAGE_WINDOWS 是五个递增的累积窗口", () => {
	assert.deepEqual(USAGE_WINDOWS.map((w) => w.label), ["3天", "7天", "1月", "3月", "半年"]);
	assert.deepEqual(USAGE_WINDOWS.map((w) => w.hours), [72, 168, 720, 2160, 4320]);
});

test("aggregate 的窗口是累积的", () => {
	const m = aggregate([ev(10, "foo"), ev(10, "foo"), ev(10, "foo"), ev(120, "foo"), ev(120, "foo")], NOW);
	assert.deepEqual(m.get("foo")!.counts, [3, 5, 5, 5, 5]);
	assert.equal(m.get("foo")!.total, 5);
});

test("aggregate 的结果不随时间戳的时区写法变化", () => {
	// 71 小时贴着 3 天窗口（72 小时）内沿：把时间戳按本地时区误解析会跨窗口。
	const utc = ev(71, "foo");
	// 同一时刻，但字面时间按 +08:00 写：解析后相等，字符串不等。
	const shifted = { ...utc, ts: new Date(Date.parse(utc.ts) + 8 * 3600_000).toISOString().replace("Z", "+08:00") };
	assert.notEqual(shifted.ts, utc.ts);
	assert.equal(Date.parse(shifted.ts), Date.parse(utc.ts));
	assert.deepEqual(aggregate([utc], NOW).get("foo")!.counts, [1, 1, 1, 1, 1]);
	assert.deepEqual(aggregate([shifted], NOW).get("foo")!.counts, aggregate([utc], NOW).get("foo")!.counts);
});

test("aggregate 记录最后使用时间", () => {
	const m = aggregate([ev(100, "foo"), ev(5, "foo")], NOW);
	assert.equal(m.get("foo")!.lastUsed, at(5));
	// 字面时间更晚但实际更早的带偏移写法，不能顶掉真正的最后使用时间。
	const olderAsOffset = { ...ev(2, "foo"), ts: new Date(Date.parse(at(2)) + 8 * 3600_000).toISOString().replace("Z", "+08:00") };
	assert.equal(aggregate([ev(1, "foo"), olderAsOffset], NOW).get("foo")!.lastUsed, at(1));
});

test("aggregate 丢弃时间戳无法解析的事件", () => {
	const broken = { ...ev(1, "foo"), ts: "x" };
	assert.equal(aggregate([broken], NOW).size, 0);
	const mixed = aggregate([broken, ev(100, "bar")], NOW);
	assert.equal(mixed.has("foo"), false);
	assert.equal(mixed.get("bar")!.total, 1);
	assert.deepEqual(mixed.get("bar")!.counts, [0, 1, 1, 1, 1]);
});
