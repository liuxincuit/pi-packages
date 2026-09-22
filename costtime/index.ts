// costtime.ts — 每轮耗时显示插件
//
// 运行中：输入框里的 working 行显示 `Working 12s`，每秒刷新
// 结束：往会话追加一条 custom entry，在对话流里渲染成 `Worked 75s`
//
// 计时口径是整个用户轮次：agent_start → agent_before_settle（含工具执行、重试、
// 自动继续）。中途 agent_end 不停表——它之后可能还有重试或继续，只有 settle
// 边界才是真的结束。
//
// 用 working 行而不是输入框上方的 widget：working 行本来就占位（流式期间显示），
// 不额外占行；它在 dock 里排在所有 widget 之前（pendingMessages → status →
// widgetsAbove → editor），天然位于 rpiv-todos、agents 之上，也就不必靠扩展加载
// 顺序去抢位置。`setWorkingMessage` 内部走 Loader.setMessage → 自带
// requestRender，所以每秒重写就能跳动（pi 自己的重试倒计时也是这个模式）。

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-costtime";
const TICK_MS = 1000;

// 结束后的条目颜色：耗时是辅助信息，用灰色。写语义色名而不是 hex，深浅主题各自解析。
const COLOR: ThemeColor = "muted";

function formatSeconds(ms: number): string {
	return `${Math.floor(ms / 1000)}s`;
}

export default function costtime(pi: ExtensionAPI): void {
	let startedAt: number | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let ui: ExtensionContext["ui"] | undefined;

	const paint = (): void => {
		if (startedAt === undefined) return;
		ui?.setWorkingMessage(`Working ${formatSeconds(Date.now() - startedAt)}`);
	};

	const stopTicker = (): void => {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	/** 停表；本轮在计时时返回耗时（毫秒）。 */
	const stop = (): number | undefined => {
		const ms = startedAt === undefined ? undefined : Date.now() - startedAt;
		startedAt = undefined;
		stopTicker();
		ui?.setWorkingMessage();
		return ms;
	};

	pi.on("agent_start", (_event, ctx) => {
		ui = ctx.ui;
		if (startedAt !== undefined) return; // 重试、自动继续不重置起点
		startedAt = Date.now();
		paint();
		ticker ??= setInterval(paint, TICK_MS);
	});

	pi.on("agent_before_settle", (event) => {
		const ms = stop();
		if (ms === undefined) return;
		return {
			entries: [...event.entries, { type: "custom", customType: ENTRY_TYPE, data: { ms } }],
		};
	});

	// 兜底：settle 边界没走到时也要停表，别让 working 行挂着上一轮的耗时。
	pi.on("agent_settled", () => {
		stop();
	});

	// 会话在运行中被换掉时清掉定时器；这里不碰 UI，避免用到已经失效的 ctx。
	pi.on("session_shutdown", () => {
		startedAt = undefined;
		stopTicker();
	});

	pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { ms?: unknown } | undefined;
		if (typeof data?.ms !== "number") return undefined;
		return new Text(theme.fg(COLOR, `Worked ${formatSeconds(data.ms)}`), 1, 0);
	});
}
