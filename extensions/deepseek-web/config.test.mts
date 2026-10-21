// config.test.mts — 配置解析的单测（只测纯函数 parseConfig，不碰文件系统）。
//
// 重点覆盖三类：默认值兜底（用户只写 apiKey 就该能用）、baseURL 形状校验（写错协议要
// 早报错）、以及两个开关的两种写法（扁平 / 包在 enabled 里）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BASE_URL, endpoints, parseConfig } from "./config.ts";

const PATH = "/tmp/config.json";

test("只给 apiKey：baseURL 用默认值，两个开关默认开启", () => {
	const config = parseConfig({ apiKey: "sk-abc" }, PATH);
	assert.deepEqual(config, {
		baseURL: DEFAULT_BASE_URL,
		apiKey: "sk-abc",
		enabledSearch: true,
		enabledFetch: true,
	});
});

test("apiKey 前后的空白被 trim", () => {
	assert.equal(parseConfig({ apiKey: "  sk-abc  " }, PATH).apiKey, "sk-abc");
});

test("缺 apiKey 时给空串而不是 undefined", () => {
	assert.equal(parseConfig({}, PATH).apiKey, "");
	assert.equal(parseConfig({ apiKey: 42 }, PATH).apiKey, "");
	assert.equal(parseConfig({ apiKey: null }, PATH).apiKey, "");
});

test("自定义 baseURL 被采用并去掉末尾斜杠", () => {
	assert.equal(parseConfig({ baseURL: "https://proxy.example.com/v1/tools/" }, PATH).baseURL, "https://proxy.example.com/v1/tools");
	assert.equal(parseConfig({ baseURL: "http://127.0.0.1:8080/v1/tools" }, PATH).baseURL, "http://127.0.0.1:8080/v1/tools");
});

test("baseURL 为空串或非字符串时回落到默认值", () => {
	assert.equal(parseConfig({ baseURL: "" }, PATH).baseURL, DEFAULT_BASE_URL);
	assert.equal(parseConfig({ baseURL: "   " }, PATH).baseURL, DEFAULT_BASE_URL);
	assert.equal(parseConfig({ baseURL: 123 }, PATH).baseURL, DEFAULT_BASE_URL);
});

test("baseURL 协议不对时报错并指出字段", () => {
	assert.throws(() => parseConfig({ baseURL: "ftp://example.com/v1/tools" }, PATH), /baseURL.*ftp/);
	assert.throws(() => parseConfig({ baseURL: "not-a-url" }, PATH), /baseURL/);
});

test("开关用扁平写法", () => {
	assert.deepEqual(
		[parseConfig({ search: false }, PATH).enabledSearch, parseConfig({ search: false }, PATH).enabledFetch],
		[false, true],
	);
	assert.deepEqual(
		[parseConfig({ fetch: false }, PATH).enabledSearch, parseConfig({ fetch: false }, PATH).enabledFetch],
		[true, false],
	);
	assert.deepEqual(
		[parseConfig({ search: false, fetch: false }, PATH).enabledSearch, parseConfig({ search: false, fetch: false }, PATH).enabledFetch],
		[false, false],
	);
});

test("开关用 enabled 嵌套写法", () => {
	const config = parseConfig({ enabled: { search: false, fetch: true } }, PATH);
	assert.equal(config.enabledSearch, false);
	assert.equal(config.enabledFetch, true);
});

test("enabled 嵌套写法优先于扁平写法", () => {
	const config = parseConfig({ search: true, enabled: { search: false } }, PATH);
	assert.equal(config.enabledSearch, false);
});

test("开关只认 false，其余真值一律开启", () => {
	// 用户写 "false" 这类字符串时不能当成关闭——那会让配置静默失效
	assert.equal(parseConfig({ search: "false" }, PATH).enabledSearch, true);
	assert.equal(parseConfig({ search: 0 }, PATH).enabledSearch, true);
	assert.equal(parseConfig({ search: null }, PATH).enabledSearch, true);
	assert.equal(parseConfig({ search: true }, PATH).enabledSearch, true);
});

test("非对象内容报错", () => {
	assert.throws(() => parseConfig(null, PATH), /JSON object/);
	assert.throws(() => parseConfig([], PATH), /JSON object/);
	assert.throws(() => parseConfig("sk-abc", PATH), /JSON object/);
});

test("endpoints 在 baseURL 后拼 search / fetch", () => {
	const config = parseConfig({ baseURL: "https://api.deepseek.com/v1/tools", apiKey: "k" }, PATH);
	assert.deepEqual(endpoints(config), {
		search: "https://api.deepseek.com/v1/tools/search",
		fetch: "https://api.deepseek.com/v1/tools/fetch",
	});
});
