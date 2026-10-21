// logic.ts — deepseek-web 的纯逻辑层
//
// 查询构建、响应映射、输出格式化与截断都在这里，不碰网络和文件系统，所以
// `node --test logic.test.mts` 能直接覆盖。IO 在 api.ts，工具注册在 index.ts。
//
// 所有对外部数据的解析都是防御性的：Search / Fetch 的响应来自服务端，字段可能
// 缺失或换类型，宁可丢一条结果也不能让整次调用抛在解析上。

/** Search API 的 query 上限（Unicode 字符数，操作符也算在内）。 */
export const MAX_QUERY_CHARS = 128;

/** 单次 web_search 允许的 query 条数。 */
export const MAX_SEARCH_QUERIES = 4;

/** 单次 web_search 每个 query 的结果数上限（API 本身允许 50）。 */
export const MAX_SEARCH_ITEMS = 20;

/** 搜索结果的默认条数。 */
export const DEFAULT_SEARCH_ITEMS = 5;

/** API 对 `count` 的硬上限。补搜的 count 阶梯不能超过它。 */
export const MAX_API_COUNT = 50;

/** 单个 query 的总尝试次数（1 次首搜 + 最多 2 次补搜）。 */
export const MAX_SEARCH_ATTEMPTS = 3;

/**
 * 每条结果的摘要上限。服务端把 `summary` 标称 600-800 字符，实测能到 2600+，
 * 不设上限时 5 条结果就能吃掉两万字符；`snippet`（100-200 字符）作 fallback。
 */
export const MAX_SUMMARY_CHARS = 1200;

/** `includeContent` 时每条结果的正文上限。 */
export const MAX_ITEM_CONTENT_CHARS = 8000;

/** 单次 web_fetch 的每个 URL 正文上限。 */
export const MAX_FETCH_CONTENT_CHARS = 30_000;

/** 把 N 条结果 / N 个页面拼成一个工具输出时的总字符上限。 */
export const MAX_OUTPUT_CHARS = 60_000;

export type RecencyFilter = "day" | "week" | "month" | "year";

const RECENCY_DAYS: Record<RecencyFilter, number> = { day: 1, week: 7, month: 30, year: 365 };

/** 一条搜索结果，字段已归一化（缺失的用空串 / null 补齐）。 */
export interface SearchItem {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	siteName: string | null;
	date: string | null;
	authority: number;
	rerankScore: number;
}

/** 一个 query 的执行结果；`error` 非空表示该 query 失败，其余 query 仍会返回。 */
export interface SearchQueryResult {
	query: string;
	items: SearchItem[];
	error: string | null;
}

/** 一个 URL 的抓取结果；`error` 非空表示失败。 */
export interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

/** 按 Unicode 字符数截断，末尾不留代理对的孤半字符。 */
export function clampChars(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	let end = max;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return { text: text.slice(0, end), truncated: true };
}

/** Unicode 字符数（代理对算一个），用于校验 API 的 128 字符限制。 */
export function unicodeLength(text: string): number {
	return Array.from(text).length;
}

/** 折叠空白并 trim；非字符串一律当空串。用于标题、片段这类单行文本。 */
function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/** 只 trim、保留内部换行；用于 `summary` / `content` 这类成段正文。 */
function block(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * 还原 DeepSeek 正文里过度的 CommonMark 转义。
 *
 * Fetch API（以及带 `need_content` 的 Search）返回的 Markdown 把几乎所有 ASCII 标点
 * 都转义了：`#` → `\#`、`/` → `\/`、`,` → `\,`，连 `<`、`=`、`{}` 都不放过。渲染出来
 * 是对的，但纯文本里全是噪音——模型读、引用、人复制粘贴都受影响。这里只还原 CommonMark
 * 定义的 ASCII 标点转义；`\\` 与字母数字前的反斜杠不动（后者本来就不是合法转义，
 * 所以 `C:\path\to` 这类文本安全）。
 */
export function unescapeMarkdown(text: string): string {
	// 四段字符类 [!-/] [:-@] [\[-`] [{-~] 即 CommonMark 的 ASCII punctuation
	return text.replace(/\\([!-/:-@\[-`{-~])/gu, "$1");
}

/**
 * 归一化 `domainFilter` 的一项：去掉协议、路径、端口与 `www.` 前缀。
 * 返回空串表示这一项无效，调用方跳过。
 */
export function normalizeDomain(raw: string): string {
	let domain = raw.trim().toLowerCase();
	if (domain === "") return "";
	domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//u, "");
	domain = domain.split("/")[0] ?? "";
	domain = domain.split("?")[0] ?? "";
	domain = domain.replace(/^www\./u, "");
	domain = domain.replace(/:\d+$/u, "");
	return domain;
}

/** 把时间窗换算成 `after:` 用的 UTC 日期。 */
function recencyDate(filter: RecencyFilter, now: number): string {
	const after = new Date(now - RECENCY_DAYS[filter] * 86_400_000);
	return after.toISOString().slice(0, 10);
}

export interface BuildQueryOptions {
	domainFilter?: readonly string[];
	recencyFilter?: RecencyFilter;
	/** 注入"现在"，便于测试。 */
	now?: number;
}

/**
 * 把工具参数编译成 DeepSeek 的查询串：域过滤走 `site:` / `-site:`（多个用 OR 连接），
 * 时间窗走 `after:`。操作符计数算进 128 字符上限，超了抛错而不是静默截断——截断会
 * 悄悄改变检索范围。
 */
export function buildQuery(query: string, options: BuildQueryOptions = {}): string {
	const parts = [query.trim()];
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of options.domainFilter ?? []) {
		const negative = raw.trim().startsWith("-");
		const domain = normalizeDomain(negative ? raw.trim().slice(1) : raw);
		if (domain === "") continue;
		const target = negative ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	if (include.length > 0) parts.push(include.map((domain) => `site:${domain}`).join(" OR "));
	for (const domain of exclude) parts.push(`-site:${domain}`);
	if (options.recencyFilter !== undefined) {
		parts.push(`after:${recencyDate(options.recencyFilter, options.now ?? Date.now())}`);
	}
	const built = parts.filter((part) => part !== "").join(" ");
	const length = unicodeLength(built);
	if (length > MAX_QUERY_CHARS) {
		throw new Error(
			`query is ${length} Unicode characters with the domain and date operators added; DeepSeek accepts at most ${MAX_QUERY_CHARS}. Shorten the query or drop filters.`,
		);
	}
	return built;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 Search API 的响应。没有 `results` 数组视为响应损坏（抛错），
 * 单条缺 URL 或 URL 非法则跳过——静默丢比整次失败划算。
 */
export function parseSearchResponse(raw: unknown): SearchItem[] {
	if (!isRecord(raw) || !Array.isArray(raw.results)) {
		throw new Error("DeepSeek returned an unexpected search response: no results array");
	}
	const items: SearchItem[] = [];
	const seen = new Set<string>();
	for (const entry of raw.results) {
		if (!isRecord(entry)) continue;
		if (typeof entry.url !== "string" || entry.url === "") continue;
		let url: URL;
		try {
			url = new URL(entry.url);
		} catch {
			continue;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") continue;
		if (seen.has(url.href)) continue;
		seen.add(url.href);
		items.push({
			title: text(entry.title),
			url: url.href,
			snippet: text(entry.snippet),
			summary: unescapeMarkdown(block(entry.summary)),
			content: unescapeMarkdown(block(entry.content)),
			siteName: text(entry.site_name) || null,
			date: text(entry.date) || null,
			authority: typeof entry.authority === "number" ? entry.authority : -1,
			rerankScore: typeof entry.rerank_score === "number" ? entry.rerank_score : 0,
		});
	}
	return items;
}

/** 解析 Fetch API 的响应。`content` 必须是字符串，否则算响应损坏。 */
export function parseFetchResponse(raw: unknown): { title: string; content: string } {
	if (!isRecord(raw) || typeof raw.content !== "string") {
		throw new Error("DeepSeek returned an unexpected fetch response: no content string");
	}
	return { title: text(raw.title), content: unescapeMarkdown(raw.content) };
}

/** 结果条目的元信息行：站点、日期、权威分。全缺时返回空串。 */
function metaLine(item: SearchItem): string {
	const bits: string[] = [];
	if (item.siteName !== null) bits.push(item.siteName);
	if (item.date !== null) bits.push(item.date.slice(0, 10));
	if (item.authority >= 0) bits.push(`authority ${item.authority}`);
	return bits.join(" · ");
}

/** 摘要取 `summary`，没有就用 `snippet`。 */
function digest(item: SearchItem): string {
	return item.summary !== "" ? item.summary : item.snippet;
}

/**
 * 按 `domainFilter` 过滤结果，使“只搜这些域”成为硬保证。
 *
 * 必需的：服务端的 `site:` 是**软过滤**。实测 `site:github.com` 会返回
 * `https://pkg.go.dev/github.com/...`——引擎按 URL 字符串里是否出现 `github.com` 匹配，
 * 而不是只看 host。仅靠查询串无法保证语义，所以拿回结果后再按 host 滤一遍。
 *
 * 匹配规则：host 等于域，或以 `.域` 结尾（`site:` 包含子域）。排除优先于包含——用户
 * 同时写 `github.com` 与 `-gist.github.com` 时，意图是小得多的那个集合。
 *
 * @param items - 已解析的结果。
 * @param domainFilter - 工具参数的原始值（含 `-` 前缀表示排除）。
 * @returns 过滤后的结果；未给 domainFilter 时原样返回。
 */
export function filterByDomain(items: readonly SearchItem[], domainFilter: readonly string[] | undefined): SearchItem[] {
	if (domainFilter === undefined || domainFilter.length === 0) return [...items];
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of domainFilter) {
		const negative = raw.trim().startsWith("-");
		const domain = normalizeDomain(negative ? raw.trim().slice(1) : raw);
		if (domain === "") continue;
		const target = negative ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	if (include.length === 0 && exclude.length === 0) return [...items];

	const matches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

	return items.filter((item) => {
		let host: string;
		try {
			host = new URL(item.url).hostname.toLowerCase();
		} catch {
			return false;
		}
		if (exclude.some((domain) => matches(host, domain))) return false;
		if (include.length > 0 && !include.some((domain) => matches(host, domain))) return false;
		return true;
	});
}

/** 渲染搜索结果。多个 query 各自成节，单条结果形如：
 *
 *     ### 标题
 *     https://url
 *
 *     摘要正文
 *
 * 末尾统一收口到 `MAX_OUTPUT_CHARS`，超出时截断并附一行提示。
 */
export function formatSearchOutput(results: readonly SearchQueryResult[], includeContent: boolean): string {
	const sections: string[] = [];
	for (const result of results) {
		const lines: string[] = [`## Results for: "${result.query}"`, ""];
		if (result.error !== null) {
			lines.push(`Search failed: ${result.error}`, "");
		} else if (result.items.length === 0) {
			lines.push("No results.", "");
		}
		for (const item of result.items) {
			lines.push(`### ${item.title || item.url}`);
			lines.push(item.url);
			const meta = metaLine(item);
			if (meta !== "") lines.push(`_${meta}_`);
			lines.push("");
			const body = digest(item);
			if (body !== "") {
				const clamped = clampChars(body, MAX_SUMMARY_CHARS);
				lines.push(clamped.truncated ? `${clamped.text}...` : clamped.text);
				lines.push("");
			}
			if (includeContent && item.content !== "") {
				const clamped = clampChars(item.content, MAX_ITEM_CONTENT_CHARS);
				lines.push("```", clamped.text, "```", "");
			}
		}
		sections.push(lines.join("\n").trimEnd());
	}
	if (sections.length === 0) return "No results.";
	return sections.join("\n\n");
}

/**
 * 渲染抓取结果。成功时给出标题 + 正文，正文超限截断并提示；失败时只给错误行。
 *
 * 注意：Fetch API 对"目标站返回 404 页面"这类情况照样返回 200（它只反映抓取成功），
 * 所以这里无法也不去判断内容是否有效——交给模型看标题和正文自己判断。
 */
export function formatFetchOutput(results: readonly FetchResult[]): string {
	const sections: string[] = [];
	for (const result of results) {
		const lines: string[] = [`## ${result.url}`, ""];
		if (result.error !== null) {
			lines.push(`Fetch failed: ${result.error}`, "");
			sections.push(lines.join("\n").trimEnd());
			continue;
		}
		if (result.title !== "") {
			lines.push(`**${result.title}**`, "");
		}
		const clamped = clampChars(result.content, MAX_FETCH_CONTENT_CHARS);
		lines.push(clamped.text);
		if (clamped.truncated) {
			lines.push("", `(Content truncated at ${MAX_FETCH_CONTENT_CHARS} characters. Fetch a more specific URL or section for the full text.)`);
		}
		sections.push(lines.join("\n").trimEnd());
	}
	if (sections.length === 0) return "No URLs.";
	return sections.join("\n\n");
}

/** 归一化 query 列表：去空、去重、限条数，保持顺序。 */
export function normalizeQueries(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const query of raw) {
		const trimmed = query.trim();
		if (trimmed === "" || out.includes(trimmed)) continue;
		out.push(trimmed);
		if (out.length >= MAX_SEARCH_QUERIES) break;
	}
	return out;
}

/** 归一化 URL 列表：去空、去重，保持顺序。 */
export function normalizeUrls(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const url of raw) {
		const trimmed = url.trim();
		if (trimmed === "" || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out;
}

/** 结果条数收敛到 [1, MAX_SEARCH_ITEMS]，非法值用默认值。 */
export function normalizeItemCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SEARCH_ITEMS;
	const floored = Math.floor(value);
	if (floored < 1) return 1;
	return Math.min(floored, MAX_SEARCH_ITEMS);
}

/**
 * 算出逐个尝试的 `count` 阶梯：首轮就是目标条数，之后 ×3 递增，封顶 {@link MAX_API_COUNT}。
 *
 * 为什么要递增而不是原样重搜：搜索结果是**有序**的，同 count 再搜拿到的是同一批前 N 条，
 * 被滤掉的那几条会再次被滤掉。只有把 count 放大才能拿到排在后面的新结果。
 *
 * @param target - 本次调用想要的条数。
 * @param maxAttempts - 总尝试次数上限（含首轮）。
 * @returns 递增且去重后的 count 序列；递增值无法再提高时提前结束（避免白花请求）。
 */
export function plannedCounts(target: number, maxAttempts = MAX_SEARCH_ATTEMPTS): number[] {
	const counts: number[] = [];
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const scaled = Math.min(MAX_API_COUNT, target * 3 ** attempt);
		const previous = counts[counts.length - 1];
		if (previous !== undefined && scaled <= previous) break;
		counts.push(scaled);
	}
	return counts;
}

/** 把新一批结果并入已有结果，按 URL 去重（先到的位置保留）。 */
export function mergeItems(previous: readonly SearchItem[], fresh: readonly SearchItem[]): SearchItem[] {
	const seen = new Set(previous.map((item) => item.url));
	const merged = [...previous];
	for (const item of fresh) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		merged.push(item);
	}
	return merged;
}
