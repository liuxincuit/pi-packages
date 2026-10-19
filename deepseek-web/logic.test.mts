// logic.test.mts — 纯逻辑单测。零依赖：`node --test pi/extensions/deepseek-web/*.test.mts`
//
// 覆盖三类容易写错的地方：Unicode 边界（128 字符限制、代理对截断）、外部响应的
// 防御性解析（字段缺失/类型错/非法 URL）、以及操作符编译（site:/after: 的拼法与超长报错）。

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildQuery,
	clampChars,
	filterByDomain,
	formatFetchOutput,
	formatSearchOutput,
	MAX_FETCH_CONTENT_CHARS,
	MAX_QUERY_CHARS,
	mergeItems,
	normalizeDomain,
	normalizeItemCount,
	normalizeQueries,
	normalizeUrls,
	parseFetchResponse,
	parseSearchResponse,
	plannedCounts,
	unescapeMarkdown,
	unicodeLength,
} from "./logic.ts";

// —— clampChars / unicodeLength ——

test("clampChars 原样返回不超限的文本", () => {
	assert.deepEqual(clampChars("abc", 5), { text: "abc", truncated: false });
	assert.deepEqual(clampChars("abcde", 5), { text: "abcde", truncated: false });
});

test("clampChars 截断时不留代理对的孤半字符", () => {
	// "😀" 是 U+1F600，占两个 code unit；上限 3 会切在它中间
	const result = clampChars("ab😀cd", 3);
	assert.equal(result.truncated, true);
	assert.equal(result.text, "ab");
});

test("clampChars 上限正好落在完整代理对之后则不回退", () => {
	const result = clampChars("ab😀cd", 4);
	assert.equal(result.text, "ab😀");
});

test("unicodeLength 把代理对算作一个字符", () => {
	assert.equal(unicodeLength("abc"), 3);
	assert.equal(unicodeLength("😀"), 1);
	assert.equal(unicodeLength("a😀b"), 3);
});

// —— normalizeDomain ——

test("normalizeDomain 去掉协议、路径、端口、www 与大小写", () => {
	assert.equal(normalizeDomain("https://www.GitHub.com/foo/bar"), "github.com");
	assert.equal(normalizeDomain("github.com"), "github.com");
	assert.equal(normalizeDomain("http://example.com:8080/x?y=1"), "example.com");
	assert.equal(normalizeDomain("  docs.python.org  "), "docs.python.org");
	assert.equal(normalizeDomain("   "), "");
});

// —— buildQuery ——

test("buildQuery 只用 query 时不加操作符", () => {
	assert.equal(buildQuery("  React 性能  "), "React 性能");
});

test("buildQuery 把多个 include 域编成 OR 连接的 site:", () => {
	assert.equal(buildQuery("hooks", { domainFilter: ["github.com", "https://www.gitlab.com/x"] }), "hooks site:github.com OR site:gitlab.com");
});

test("buildQuery 把 - 前缀的域编成 -site:", () => {
	assert.equal(buildQuery("hooks", { domainFilter: ["github.com", "-pinterest.com"] }), "hooks site:github.com -site:pinterest.com");
});

test("buildQuery 去重同一个域", () => {
	assert.equal(buildQuery("q", { domainFilter: ["github.com", "https://github.com/a"] }), "q site:github.com");
});

test("buildQuery 忽略空域和无效项", () => {
	assert.equal(buildQuery("q", { domainFilter: ["", "  ", "-"] }), "q");
});

test("buildQuery 把时间窗编成 after:<UTC 日期>", () => {
	const now = Date.UTC(2026, 5, 15); // 2026-06-15
	assert.equal(buildQuery("q", { recencyFilter: "day", now }), "q after:2026-06-14");
	assert.equal(buildQuery("q", { recencyFilter: "week", now }), "q after:2026-06-08");
	assert.equal(buildQuery("q", { recencyFilter: "month", now }), "q after:2026-05-16");
	assert.equal(buildQuery("q", { recencyFilter: "year", now }), "q after:2025-06-15");
});

test("buildQuery 在超过 128 字符时报错而不是静默截断", () => {
	const query = "あ".repeat(MAX_QUERY_CHARS);
	assert.equal(buildQuery(query), query);
	assert.throws(() => buildQuery(`${query}あ`), /128/);
	// 加操作符后超限同样报错
	assert.throws(() => buildQuery("あ".repeat(120), { domainFilter: ["example.com"] }), /128/);
});

test("buildQuery 按 Unicode 字符数而不是 UTF-16 长度判断超限", () => {
	// 64 个 emoji = 64 字符（UTF-16 长度 128），不应触发超限
	assert.equal(unicodeLength("😀".repeat(64)), 64);
	assert.doesNotThrow(() => buildQuery("😀".repeat(64)));
});

// —— unescapeMarkdown ——

test("unescapeMarkdown 还原被过度转义的 ASCII 标点", () => {
	assert.equal(unescapeMarkdown("\\# 标题"), "# 标题");
	assert.equal(unescapeMarkdown("Search \\/ Fetch"), "Search / Fetch");
	assert.equal(unescapeMarkdown("已上线\\, 使用"), "已上线, 使用");
	assert.equal(unescapeMarkdown("values\\:non\\-empty and \\<\\= 8192"), "values:non-empty and <= 8192");
	assert.equal(unescapeMarkdown("\\{a\\}"), "{a}");
	assert.equal(unescapeMarkdown("\\[\\]\\`"), "[]`");
});

test("unescapeMarkdown 不动字母数字前的反斜杠（Windows 路径安全）", () => {
	assert.equal(unescapeMarkdown("C:\\path\\to\\file"), "C:\\path\\to\\file");
	assert.equal(unescapeMarkdown("a\\nb"), "a\\nb");
});

test("unescapeMarkdown 把双反斜杠还原成单个", () => {
	assert.equal(unescapeMarkdown("a\\\\b"), "a\\b");
});

test("unescapeMarkdown 对没有转义的文本是恒等变换", () => {
	assert.equal(unescapeMarkdown("普通正文，无转义。"), "普通正文，无转义。");
});

// —— filterByDomain ——

test("filterByDomain 未给 domainFilter 时原样返回", () => {
	const items = parseSearchResponse({ results: [{ url: "https://a.com/x" }, { url: "https://b.com/y" }] });
	assert.equal(filterByDomain(items, undefined).length, 2);
	assert.equal(filterByDomain(items, []).length, 2);
});

test("filterByDomain 只留 include 域（实测 service 的 site: 是软过滤）", () => {
	// 真实场景：site:github.com 会把 pkg.go.dev/github.com/... 也当成命中
	const items = parseSearchResponse({
		results: [
			{ url: "https://pkg.go.dev/github.com/entireio/cli" },
			{ url: "https://pkg.go.dev/github.com/other/x" },
			{ url: "https://github.com/laurigates/y" },
		],
	});
	const kept = filterByDomain(items, ["github.com"]);
	assert.deepEqual(
		kept.map((item) => item.url),
		["https://github.com/laurigates/y"],
	);
});

test("filterByDomain 包含子域（site: 的语义）", () => {
	const items = parseSearchResponse({ results: [{ url: "https://gist.github.com/a" }, { url: "https://github.com/b" }] });
	assert.equal(filterByDomain(items, ["github.com"]).length, 2);
});

test("filterByDomain 排除优先于包含", () => {
	const items = parseSearchResponse({
		results: [{ url: "https://gist.github.com/a" }, { url: "https://github.com/b" }],
	});
	assert.deepEqual(
		filterByDomain(items, ["github.com", "-gist.github.com"]).map((item) => item.url),
		["https://github.com/b"],
	);
});

test("filterByDomain 只给排除时不设 include 限制", () => {
	const items = parseSearchResponse({ results: [{ url: "https://a.com/x" }, { url: "https://b.com/y" }] });
	assert.deepEqual(
		filterByDomain(items, ["-a.com"]).map((item) => item.url),
		["https://b.com/y"],
	);
});

test("filterByDomain 按 host 匹配而不是看 URL 路径", () => {
	// example.com/redirect/github.com 不应被当成 github.com
	const items = parseSearchResponse({ results: [{ url: "https://example.com/redirect/github.com" }] });
	assert.equal(filterByDomain(items, ["github.com"]).length, 0);
});

test("filterByDomain 忽略无效项", () => {
	const items = parseSearchResponse({ results: [{ url: "https://a.com/x" }] });
	assert.equal(filterByDomain(items, ["", "-", "  "]).length, 1);
});

// —— parseSearchResponse ——

test("parseSearchResponse 保留 summary 与 content 的换行", () => {
	const items = parseSearchResponse({ results: [{ url: "https://e.com", summary: "# 标题\n\n正文", content: "行1\n行2" }] });
	assert.equal(items[0].summary, "# 标题\n\n正文");
	assert.equal(items[0].content, "行1\n行2");
});

test("parseSearchResponse 对 summary 与 content 做反转义", () => {
	const items = parseSearchResponse({ results: [{ url: "https://e.com", content: "\\# 标题\\, 后文" }] });
	assert.equal(items[0].content, "# 标题, 后文");
});

test("parseSearchResponse 归一化字段", () => {
	const items = parseSearchResponse({
		results: [
			{
				title: " 标题 ",
				url: "https://example.com/a",
				snippet: "片段",
				summary: "长摘要",
				content: "# 正文",
				site_name: "Example",
				date: "2026-02-04T16:00:00+00:00",
				authority: 3,
				rerank_score: 2.5,
			},
		],
	});
	assert.equal(items.length, 1);
	assert.deepEqual(items[0], {
		title: "标题",
		url: "https://example.com/a",
		snippet: "片段",
		summary: "长摘要",
		content: "# 正文",
		siteName: "Example",
		date: "2026-02-04T16:00:00+00:00",
		authority: 3,
		rerankScore: 2.5,
	});
});

test("parseSearchResponse 对缺字段的结果补默认值", () => {
	const items = parseSearchResponse({ results: [{ url: "https://example.com" }] });
	assert.deepEqual(items[0], {
		title: "",
		url: "https://example.com/",
		snippet: "",
		summary: "",
		content: "",
		siteName: null,
		date: null,
		authority: -1,
		rerankScore: 0,
	});
});

test("parseSearchResponse 跳过缺 URL、非法 URL 与非 http(s) 的结果", () => {
	const items = parseSearchResponse({
		results: [
			{ url: "" },
			{ title: "没有 url" },
			{ url: "not a url" },
			{ url: "ftp://example.com/f" },
			{ url: "https://ok.example.com" },
		],
	});
	assert.deepEqual(
		items.map((item) => item.url),
		["https://ok.example.com/"],
	);
});

test("parseSearchResponse 按规范化后的 URL 去重", () => {
	const items = parseSearchResponse({
		results: [{ url: "https://example.com/a" }, { url: "https://example.com/a" }, { url: "https://example.com/b" }],
	});
	assert.equal(items.length, 2);
});

test("parseSearchResponse 在没有 results 数组时抛错", () => {
	assert.throws(() => parseSearchResponse({}), /results/);
	assert.throws(() => parseSearchResponse({ results: "nope" }), /results/);
	assert.throws(() => parseSearchResponse(null), /results/);
});

test("parseSearchResponse 接受空结果列表", () => {
	assert.deepEqual(parseSearchResponse({ results: [] }), []);
});

// —— parseFetchResponse ——

test("parseFetchResponse 取 title 与 content", () => {
	assert.deepEqual(parseFetchResponse({ title: "  标题 ", content: "正文" }), { title: "标题", content: "正文" });
});

test("parseFetchResponse 允许缺 title", () => {
	assert.deepEqual(parseFetchResponse({ content: "正文" }), { title: "", content: "正文" });
});

test("parseFetchResponse 在 content 不是字符串时抛错", () => {
	assert.throws(() => parseFetchResponse({ title: "x" }), /content/);
	assert.throws(() => parseFetchResponse({ content: 42 }), /content/);
});

// —— formatSearchOutput ——

test("formatSearchOutput 单条结果含标题、URL 与摘要", () => {
	const out = formatSearchOutput(
		[
			{
				query: "q",
				error: null,
				items: [
					{
						title: "标题",
						url: "https://example.com/a",
						snippet: "片段",
						summary: "长摘要",
						content: "正文",
						siteName: "Example",
						date: "2026-02-04T16:00:00+00:00",
						authority: 3,
						rerankScore: 2,
					},
				],
			},
		],
		false,
	);
	assert.match(out, /## Results for: "q"/);
	assert.match(out, /### 标题/);
	assert.match(out, /https:\/\/example\.com\/a/);
	assert.match(out, /长摘要/);
	assert.match(out, /Example · 2026-02-04 · authority 3/);
	// 默认不带正文
	assert.doesNotMatch(out, /正文/);
});

test("formatSearchOutput 在 summary 缺失时回退到 snippet", () => {
	const out = formatSearchOutput(
		[{ query: "q", error: null, items: [item({ snippet: "只有片段", summary: "" })] }],
		false,
	);
	assert.match(out, /只有片段/);
});

test("formatSearchOutput 的 includeContent 用代码块带出正文", () => {
	const out = formatSearchOutput([{ query: "q", error: null, items: [item({ content: "# 正文" })] }], true);
	assert.match(out, /```\n# 正文\n```/);
});

test("formatSearchOutput 渲染失败与空结果", () => {
	const failed = formatSearchOutput([{ query: "q", items: [], error: "DeepSeek error 429: slow down" }], false);
	assert.match(failed, /Search failed: DeepSeek error 429/);
	const empty = formatSearchOutput([{ query: "q", items: [], error: null }], false);
	assert.match(empty, /No results\./);
});

test("formatSearchOutput 用标题缺失时退回 URL", () => {
	const out = formatSearchOutput([{ query: "q", error: null, items: [item({ title: "" })] }], false);
	assert.match(out, /### https:\/\/example\.com\/a/);
});

test("formatSearchOutput 多 query 各自成节", () => {
	const out = formatSearchOutput(
		[
			{ query: "q1", error: null, items: [item({})] },
			{ query: "q2", error: null, items: [item({})] },
		],
		false,
	);
	assert.equal(out.match(/## Results for:/g)?.length, 2);
});

// —— formatFetchOutput ——

test("formatFetchOutput 输出 URL、标题与正文", () => {
	const out = formatFetchOutput([{ url: "https://example.com/a", title: "标题", content: "# 正文", error: null }]);
	assert.match(out, /## https:\/\/example\.com\/a/);
	assert.match(out, /\*\*标题\*\*/);
	assert.match(out, /# 正文/);
});

test("formatFetchOutput 对超长正文截断并附提示", () => {
	const out = formatFetchOutput([{ url: "https://example.com", title: "", content: "x".repeat(MAX_FETCH_CONTENT_CHARS + 100), error: null }]);
	assert.match(out, /Content truncated at 30000 characters/);
});

test("formatFetchOutput 渲染错误行", () => {
	const out = formatFetchOutput([{ url: "https://example.com", title: "", content: "", error: "DeepSeek error 404: nope" }]);
	assert.match(out, /Fetch failed: DeepSeek error 404/);
});

// —— 列表归一化 ——

test("normalizeQueries 去空、去重、限 4 条", () => {
	assert.deepEqual(normalizeQueries(["a", " ", "b", "a", "c", "d", "e"]), ["a", "b", "c", "d"]);
	assert.deepEqual(normalizeQueries([]), []);
});

test("normalizeUrls 去空去重但不限条数", () => {
	assert.deepEqual(normalizeUrls(["a", "b", "a", " "]), ["a", "b"]);
});

// —— plannedCounts / mergeItems（补搜）——

test("plannedCounts 目标 5 给出 5 → 15 → 45", () => {
	assert.deepEqual(plannedCounts(5), [5, 15, 45]);
});

test("plannedCounts 封顶在 API 的 50", () => {
	assert.deepEqual(plannedCounts(20), [20, 50]);
	assert.deepEqual(plannedCounts(30), [30, 50]);
	assert.deepEqual(plannedCounts(50), [50]);
});

test("plannedCounts 目标为 1 时阶梯仍是递增的", () => {
	assert.deepEqual(plannedCounts(1), [1, 3, 9]);
});

test("plannedCounts 受 maxAttempts 限制", () => {
	assert.deepEqual(plannedCounts(5, 1), [5]);
	assert.deepEqual(plannedCounts(5, 2), [5, 15]);
});

test("mergeItems 按 URL 去重且保留先到的位置", () => {
	const a = parseSearchResponse({ results: [{ url: "https://a.com/1" }, { url: "https://a.com/2" }] });
	const b = parseSearchResponse({ results: [{ url: "https://a.com/2" }, { url: "https://a.com/3" }] });
	assert.deepEqual(
		mergeItems(a, b).map((item) => item.url),
		["https://a.com/1", "https://a.com/2", "https://a.com/3"],
	);
});

test("mergeItems 对空输入不炸", () => {
	assert.deepEqual(mergeItems([], []), []);
	const a = parseSearchResponse({ results: [{ url: "https://a.com/1" }] });
	assert.equal(mergeItems(a, []).length, 1);
	assert.equal(mergeItems([], a).length, 1);
});

test("normalizeItemCount 收敛到 [1, 20] 并用默认值兜底", () => {
	assert.equal(normalizeItemCount(undefined), 5);
	assert.equal(normalizeItemCount(0), 1);
	assert.equal(normalizeItemCount(-3), 1);
	assert.equal(normalizeItemCount(7.9), 7);
	assert.equal(normalizeItemCount(999), 20);
	assert.equal(normalizeItemCount(Number.NaN), 5);
});

function item(overrides: Partial<Parameters<typeof formatSearchOutput>[0][number]["items"][number]> = {}) {
	return {
		title: "标题",
		url: "https://example.com/a",
		snippet: "片段",
		summary: "长摘要",
		content: "正文",
		siteName: null,
		date: null,
		authority: -1,
		rerankScore: 1,
		...overrides,
	};
}
