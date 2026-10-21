import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	globalConfigPath,
	parseConfig,
	projectConfigPath,
	readConfig,
	resolveSettings,
	serializeConfig,
	writeSetting,
} from "./scope.ts";

test("配置路径遵循约定", () => {
	assert.equal(globalConfigPath("/agent"), path.join("/agent", "extensions", "pi-skills", "config.json"));
	assert.equal(projectConfigPath("/proj"), path.join("/proj", ".pi", "extensions", "pi-skills", "config.json"));
});

test("parseConfig 容忍非法 JSON、结构不符与未知取值", () => {
	assert.deepEqual(parseConfig("not json"), {});
	assert.deepEqual(parseConfig("[]"), {});
	assert.deepEqual(parseConfig('{"skills":null}'), {});
	assert.deepEqual(parseConfig('{"version":1,"skills":{"a":"disabled","b":"on","c":"enabled","d":1}}'), {
		a: "disabled",
		c: "enabled",
	});
});

test("readConfig 对缺失文件返回空表", () => {
	assert.deepEqual(readConfig(path.join(os.tmpdir(), "skill-manager-missing-xyz.json")), {});
});

test("writeSetting 新建文件并保留其他条目", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manager-"));
	try {
		const file = path.join(dir, "nested", "config.json");
		writeSetting(file, "a", "disabled");
		writeSetting(file, "b", "enabled");
		assert.deepEqual(readConfig(file), { a: "disabled", b: "enabled" });
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 1);
		writeSetting(file, "a", "enabled");
		assert.deepEqual(readConfig(file), { a: "enabled", b: "enabled" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveSettings 按 会话 > 项目 > 全局 合并", () => {
	const resolved = resolveSettings(
		{ a: "enabled" },
		{ a: "disabled", b: "disabled" },
		{ a: "disabled", b: "enabled", c: "disabled" },
	);
	assert.deepEqual(resolved.get("a"), { value: "enabled", scope: "session" });
	assert.deepEqual(resolved.get("b"), { value: "disabled", scope: "project" });
	assert.deepEqual(resolved.get("c"), { value: "disabled", scope: "global" });
	assert.equal(resolved.size, 3);
});

test("resolveSettings 不含未提及的 skill", () => {
	assert.equal(resolveSettings({}, {}, {}).size, 0);
});

test("serializeConfig 产出稳定格式", () => {
	assert.equal(serializeConfig({ a: "disabled" }), '{\n\t"version": 1,\n\t"skills": {\n\t\t"a": "disabled"\n\t}\n}\n');
});
