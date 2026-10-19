// api.ts — deepseek-web 的 IO 层：凭据、限速、请求与错误归一化。
//
// 两个认识决定了这里的形状：
//
// 1. Search 与 Fetch 是账户级 5 QPS，且**各自独立计数**（官方文档 + 实测：8 路并发
//    搜索必现 429）。所以限速器分两条通道、状态放在模块级——模块由 pi 的 loader 按
//    路径缓存，父会话与所有子会话共享同一个实例，正好对应"账户级"这个粒度。
//    串行 + 250ms 间隔即 4 QPS，留 20% 余量，代价是 4 个 query 要 ~1.2s，比撞 429 划算。
//
// 2. 429 是"等一会儿就能过"的错误，退避重试一次通常就够（实测 429 出现在瞬时并发，
//    不是配额耗尽）。其余 4xx（400/401/402/403/404）重试没有意义，直接报给模型。

import { endpoints, getConfigPath, loadConfig, type DeepseekWebConfig } from "./config.ts";
import { parseFetchResponse, parseSearchResponse, type SearchItem } from "./logic.ts";

/** 单次 HTTP 请求的超时。实测搜索 0.2-0.6s、抓取 0.1-3.2s，30s 只兜底挂死的连接。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** 同一通道两次请求的最小间隔，对应 4 QPS。 */
const MIN_INTERVAL_MS = 250;

/** 429 的最大重试次数（不含首次）。 */
const MAX_RETRIES = 2;

/** 429 退避基数：第 n 次重试等 n × 该值。 */
const RETRY_BASE_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 让同一通道的请求按最小间隔串行出队。`run` 的返回值/异常原样透传给调用者，
 * 队尾永远挂一个吞掉异常的 promise，避免一次失败卡住后续请求。
 */
class Throttle {
	private last = 0;
	private queue: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const scheduled = this.queue.then(async () => {
			const wait = MIN_INTERVAL_MS - (Date.now() - this.last);
			if (wait > 0) await sleep(wait);
			this.last = Date.now();
			return task();
		});
		this.queue = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	}
}

const searchThrottle = new Throttle();
const fetchThrottle = new Throttle();

/** 把 key 从消息里抹掉，避免它随错误文本进入会话记录。 */
function redact(text: string, key: string): string {
	return key.length < 8 ? text : text.split(key).join("[redacted]");
}

/**
 * 取一份可用的配置。每次请求前都重读文件，所以改 `apiKey` / `baseURL` 不需要
 * `/reload`；开关变更是在注册时读的，那个要 reload（见 index.ts）。
 *
 * 配置缺失或损坏直接抛错——不隐式降级成别的 key 或别的地址。
 */
function requireConfig(): DeepseekWebConfig {
	let config: DeepseekWebConfig;
	try {
		config = loadConfig();
	} catch (error) {
		throw new Error(`deepseek-web config error: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (config.apiKey === "") {
		throw new Error(
			`deepseek-web has no apiKey. Add {"apiKey": "sk-..."} to ${getConfigPath()} ` +
				"(get one at https://platform.deepseek.com/api_keys).",
		);
	}
	return config;
}

/**
 * 解析错误响应。Search / Fetch 用 OpenAI 兼容格式
 * `{ error: { message, type, param, code } }`，`message` 里带 request_id，
 * 对排查有用所以原样保留；解析不出来就退回原始 body。
 */
function describeError(status: number, body: string, key: string): string {
	let message = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null) {
			const error = (parsed as Record<string, unknown>).error;
			if (typeof error === "object" && error !== null) {
				const raw = (error as Record<string, unknown>).message;
				if (typeof raw === "string") message = raw;
			}
		}
	} catch {
		// 非 JSON 错误体（网关 5xx 之类）只能原样透出。
	}
	return redact(message !== "" ? message : body.slice(0, 300), key);
}

/**
 * 发一次 API 请求：限速出队、按需重试 429、统一错误文案。
 *
 * @param endpoint - Search 或 Fetch 的完整地址（由 config 的 baseURL 拼出）。
 * @param throttle - 该端点所属通道的限速器。
 * @param body - 请求体，调用方已构造好。
 * @param parse - 从响应体解析出结果；抛错表示响应损坏。
 * @param signal - 工具调用的取消信号。
 * @param key - 用于脱敏的 API key。
 */
async function call(
	endpoint: string,
	throttle: Throttle,
	body: Record<string, unknown>,
	parse: (raw: unknown) => unknown,
	signal: AbortSignal | undefined,
	key: string,
): Promise<unknown> {
	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted === true) throw new Error("Aborted");
		if (attempt > 0) await sleep(RETRY_BASE_MS * attempt);

		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
		let response: Response;
		try {
			response = await throttle.run(() =>
				fetch(endpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
					signal: combined,
				}),
			);
		} catch (error) {
			if (signal?.aborted === true) throw new Error("Aborted");
			if (timeout.aborted) throw new Error(`DeepSeek request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
			throw new Error(`DeepSeek request failed: ${redact(error instanceof Error ? error.message : String(error), key)}`);
		}

		if (response.ok) {
			const text = await response.text();
			try {
				return parse(JSON.parse(text));
			} catch (error) {
				throw new Error(`DeepSeek returned an unprocessable response: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const detail = describeError(response.status, await response.text(), key);
		if (response.status === 429 && attempt < MAX_RETRIES) continue;
		throw new Error(`DeepSeek error ${response.status}: ${detail}`);
	}
}

export interface SearchOptions {
	count: number;
	needContent: boolean;
	oriQuestion?: string;
	signal?: AbortSignal;
}

/** 执行一次搜索。调用方负责逐个 query 串行调用（限速器会再兜一层）。 */
export async function searchOne(query: string, options: SearchOptions): Promise<SearchItem[]> {
	const config = requireConfig();
	const parsed = await call(
		endpoints(config).search,
		searchThrottle,
		{
			query,
			count: options.count,
			need_content: options.needContent,
			...(options.oriQuestion === undefined ? {} : { ori_question: options.oriQuestion }),
		},
		parseSearchResponse,
		options.signal,
		config.apiKey,
	);
	return parsed as SearchItem[];
}

/** 抓取一个 URL。Fetch API 只返回 `{ title, content }`，没有状态码。 */
export async function fetchOne(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
	const config = requireConfig();
	const parsed = await call(endpoints(config).fetch, fetchThrottle, { url }, parseFetchResponse, signal, config.apiKey);
	return parsed as { title: string; content: string };
}
