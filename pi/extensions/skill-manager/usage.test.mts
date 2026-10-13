import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseEvent, serializeEvent, usageLogPath } from "./usage.ts";

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
