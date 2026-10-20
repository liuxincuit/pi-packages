// config.ts — 扩展配置的读取与校验。
//
// 配置文件固定放在 pi 的用户级扩展数据目录：
//
//     ~/.pi/agent/extensions/deepseek-web/config.json
//
// 这个位置是仓库约定（用户级数据用 `~/.pi/agent/extensions/<扩展名>/`）。该目录里没有
// index.ts，pi 扫描扩展时只认一层子目录里的入口文件，所以它不会被误当成扩展加载。
//
// 与 pi 其他配置（~/.pi/web-search.json、auth.json）**完全不共享**：apiKey 只从这里读，
// 缺了就是缺了，不会隐式借用登录态。这让"用哪个 key、连哪个地址"始终是可预测的。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认端点，已含 `/v1/tools`（代码会再拼 `/search` 与 `/fetch`）。 */
export const DEFAULT_BASE_URL = "https://api.deepseek.com/v1/tools";

export interface DeepseekWebConfig {
	/** 到 `/v1/tools` 这一级；`/search` 与 `/fetch` 由代码拼接。 */
	baseURL: string;
	/** DeepSeek API key；为空表示未配置。 */
	apiKey: string;
	/** `enabled.search !== false` 时注册 web_search。 */
	enabledSearch: boolean;
	/** `enabled.fetch !== false` 时注册 web_fetch。 */
	enabledFetch: boolean;
}

function configPath(): string {
	return join(homedir(), ".pi", "agent", "extensions", "deepseek-web", "config.json");
}

/** 对外暴露路径，供错误信息与 README 引用，避免两处写死。 */
export function getConfigPath(): string {
	return configPath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把配置文件内容解释成配置对象。拆成纯函数是为了能单测（不碰文件系统）。
 *
 * 容错尺度：字段类型不对就用默认值（用户写错一个字段不该让整个扩展挂掉），但
 * `baseURL` 形状不对要报错（连不上是运行时问题，写错协议是配置问题，早点说清楚）。
 *
 * 开关注入上同时接受扁平写法（`search` / `fetch`）与包在 `enabled` 里的写法。
 * @param raw - `JSON.parse` 的结果。
 * @param path - 配置文件路径，只用于报错文案。
 */
export function parseConfig(raw: unknown, path: string): DeepseekWebConfig {
	if (!isRecord(raw)) {
		throw new Error(`${path} must contain a JSON object.`);
	}

	const rawBase = raw.baseURL;
	const baseURL = typeof rawBase === "string" && rawBase.trim() !== "" ? rawBase.trim() : DEFAULT_BASE_URL;
	assertBaseUrl(baseURL, path);

	const rawKey = raw.apiKey;
	const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";

	const enabled = isRecord(raw.enabled) ? raw.enabled : undefined;
	const search = enabled?.search ?? raw.search;
	const fetch = enabled?.fetch ?? raw.fetch;

	return {
		baseURL: baseURL.replace(/\/+$/u, ""),
		apiKey,
		enabledSearch: search !== false,
		enabledFetch: fetch !== false,
	};
}

/**
 * 读配置。文件不存在时返回"未配置"的默认值（不抛错——首次使用就是这种状态，
 * 由调用方决定报错还是提示）；文件存在但内容坏了则抛错，因为静默使用默认值会让
 * 用户以为配置生效了。
 */
export function loadConfig(): DeepseekWebConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return { baseURL: DEFAULT_BASE_URL, apiKey: "", enabledSearch: true, enabledFetch: true };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseConfig(parsed, path);
}

/**
 * 校验 baseURL。只管形状，不管连通性——地址连不上是运行时错误，不该在加载扩展时
 * 抛出去（那会让整个扩展加载失败，用户连"改配置"的机会都没有）。
 */
function assertBaseUrl(baseURL: string, path: string): void {
	try {
		const url = new URL(baseURL);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("must use http or https");
		}
	} catch (error) {
		throw new Error(`"baseURL" in ${path} is not a usable URL (${baseURL}): ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 拼出 Search / Fetch 端点。 */
export function endpoints(config: DeepseekWebConfig): { search: string; fetch: string } {
	return { search: `${config.baseURL}/search`, fetch: `${config.baseURL}/fetch` };
}
