/**
 * pi-graph — 一条斜杠命令看清「插件 × 生命周期」的注册全貌。
 *
 * 输出两张表，追加成一条 custom entry 进对话流（不弹临时窗口，重启会话仍可回看）：
 *   1. 生命周期 × 插件：每个生命周期事件节点下挂监听它的插件，顺序就是真实派发顺序
 *   2. 插件贡献清单：每个插件注册的工具 / 命令 / 快捷键 / flags / 渲染器 / 资源声明
 *
 * 数据为什么必须这么取：
 *   pi 的公共 API（getAllTools / getCommands）带 sourceInfo，能把工具和命令归因到插件；
 *   但「哪个插件监听了哪个生命周期事件」没有任何公共出口——它只在 ExtensionRunner 的
 *   extensions[i].handlers 里（Map<事件名, handler[]>）。所以工厂期给 ExtensionRunner
 *   构造之后的回调打补丁，抓住存活的 runner 实例：扩展工厂在 runner 构造之前运行，来得及。
 *   前提是补丁打在与 pi 同一份类对象上——pi 用原生 ESM 加载扩展 import 的本体包，
 *   已实测成立（pi 1.1.0）。补丁与抓到的实例挂在 globalThis 的 Symbol 上，/reload 换掉
 *   模块实例后仍能复用，也不会重复套娃。
 *
 * 降级：抓不到实例时改用公共 API 的数据（按 owner 分组的工具与命令），表头写明降级原因，
 *   事件归属那一节消失但图仍然出得来，不空白、不抛错。pi 升级改内部字段时走这条路径。
 *
 * 有意接受的代价：
 *   - 会再跑一遍各插件的 resources_discover 钩子（reason 传 "reload"）以采集资源声明，
 *     该钩子按设计只返回路径，代价很小，采集失败不影响出图
 *   - 走的是内部字段，pi 大版本升级可能需要跟着改（改不动就降级）
 *   - 表是「注册时的快照」，不含本次会话实际触发了哪些 handler
 *   - 渲染出口一律夹到终端宽度（pi-tui 对超宽行是抛异常，不是截断），窄终端会改堆叠排版或截断
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { ExtensionRunner, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-graph";
const FORMAT = 1;

/** 阶段划分与节点顺序按真实执行次序排，不是类型声明顺序。 */
const PHASES: { label: string; events: string[] }[] = [
	{ label: "启动与信任", events: ["project_trust", "resources_discover", "session_start", "session_info_changed"] },
	{ label: "输入进入", events: ["input", "user_bash", "before_agent_start"] },
	{ label: "每轮边界", events: ["agent_start", "turn_start", "turn_end", "agent_end", "agent_before_settle", "agent_settled"] },
	{
		label: "上下文与模型请求",
		events: [
			"context",
			"context_with_system",
			"cache_warming_decision",
			"before_provider_request",
			"before_provider_headers",
			"after_provider_response",
			"provider_stream_event",
		],
	},
	{ label: "消息流", events: ["message_start", "message_update", "message_end"] },
	{ label: "工具执行", events: ["tool_call", "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result"] },
	{
		label: "会话与杂项",
		events: [
			"session_before_switch",
			"session_before_fork",
			"session_before_tree",
			"session_tree",
			"session_before_compact",
			"session_compact",
			"session_compact_failed",
			"session_shutdown",
			"mcp_servers_change",
			"model_select",
			"thinking_level_select",
			"ui_prompt_start",
			"ui_prompt_end",
		],
	},
];

const LIFECYCLE: string[] = PHASES.flatMap((phase) => phase.events);

/**
 * 钩子类型：告诉读者这个节点上的插件是「只能看」还是「能改东西」。
 * O 只观察 / P 改提示词 / C 改消息或工具结果 / R 改模型请求 / G 可阻断或取消 /
 * S 可续跑 / K 资源声明 / T 信任决策
 */
const HOOK: Record<string, string> = {
	project_trust: "T",
	resources_discover: "K",
	session_start: "O",
	session_info_changed: "O",
	input: "G",
	user_bash: "G",
	before_agent_start: "P",
	agent_start: "O",
	turn_start: "O",
	turn_end: "S",
	agent_end: "O",
	agent_before_settle: "S",
	agent_settled: "O",
	context: "C",
	context_with_system: "C",
	message_end: "C",
	cache_warming_decision: "R",
	before_provider_request: "R",
	before_provider_headers: "R",
	after_provider_response: "O",
	provider_stream_event: "O",
	message_start: "O",
	message_update: "O",
	tool_call: "G",
	tool_result: "C",
	tool_execution_start: "O",
	tool_execution_update: "O",
	tool_execution_end: "O",
	session_before_switch: "G",
	session_before_fork: "G",
	session_before_tree: "G",
	session_before_compact: "G",
	session_compact: "O",
	session_compact_failed: "O",
	session_tree: "O",
	session_shutdown: "O",
	mcp_servers_change: "O",
	model_select: "O",
	thinking_level_select: "O",
	ui_prompt_start: "O",
	ui_prompt_end: "O",
};

const LEGEND: { mark: string; label: string; token: ThemeColor }[] = [
	{ mark: "O", label: "只观察", token: "muted" },
	{ mark: "P", label: "改提示词", token: "accent" },
	{ mark: "C", label: "改消息/结果", token: "accent" },
	{ mark: "R", label: "改模型请求", token: "accent" },
	{ mark: "G", label: "可阻断/取消", token: "warning" },
	{ mark: "S", label: "可续跑", token: "warning" },
	{ mark: "K", label: "资源声明", token: "success" },
	{ mark: "T", label: "信任决策", token: "warning" },
];

const HOOK_TOKEN: Record<string, ThemeColor> = {
	O: "muted",
	P: "accent",
	C: "accent",
	R: "accent",
	G: "warning",
	S: "warning",
	K: "success",
	T: "warning",
};

interface GraphTool {
	name: string;
	exposure: string;
	/** 同名工具先注册者胜；false 表示这一份被别的注册盖住了，模型看不到它 */
	effective: boolean;
	/** 只对 direct 曝光有意义：注册了但没进当前激活集，模型这次看不到 */
	inactive: boolean;
}

interface GraphResources {
	skills: number;
	prompts: number;
	themes: number;
}

interface GraphExt {
	index: number;
	name: string;
	path: string;
	source: string;
	hidden: boolean;
	events: string[];
	tools: GraphTool[];
	commands: string[];
	shortcuts: string[];
	flags: string[];
	renderers: string[];
	resources: GraphResources;
}

interface GraphEvent {
	name: string;
	/** 扩展下标，按加载顺序；同一扩展注册多个 handler 时重复出现 */
	listeners: number[];
}

interface GraphModel {
	format: number;
	piVersion: string;
	capturedAt: string;
	/** 有值即降级模式，内容是降级原因 */
	degraded?: string;
	extensions: GraphExt[];
	events: GraphEvent[];
}

// ── 抓 runner 实例 ────────────────────────────────────────────────────────────

const STATE_KEY = Symbol.for("pi-graph.state");
const PATCHED_KEY = Symbol.for("pi-graph.patched");

interface GraphState {
	runner?: unknown;
	error?: string;
}

function graphState(): GraphState {
	const holder = globalThis as unknown as Record<symbol, GraphState>;
	holder[STATE_KEY] ??= {};
	return holder[STATE_KEY];
}

/** 构造之后的回调都会被调用一次，谁先来都能抓到实例。 */
function installProbe(): void {
	const state = graphState();
	const proto = (ExtensionRunner as unknown as { prototype: Record<PropertyKey, unknown> }).prototype;
	if (proto[PATCHED_KEY]) return;
	const methods = ["bindCore", "setUIContext", "bindCommandContext", "createCommandContext"];
	let wrapped = 0;
	for (const method of methods) {
		const original = proto[method];
		if (typeof original !== "function") continue;
		proto[method] = function (this: unknown, ...args: unknown[]) {
			state.runner = this;
			return (original as (...inner: unknown[]) => unknown).apply(this, args);
		};
		wrapped += 1;
	}
	if (wrapped === 0) {
		state.error = `ExtensionRunner 上找不到可挂的构造后回调（${methods.join(" / ")}）`;
	} else {
		state.error = undefined;
		proto[PATCHED_KEY] = true;
	}
}

// ── 采集 ──────────────────────────────────────────────────────────────────────

/** 这些目录只是产物/依赖容器，不是插件身份，短名与上级目录都要穿过它们。 */
const CONTAINER_DIRS = new Set(["dist", "src", "lib", "build", "out", "esm", "cjs", "es", "bin", "node_modules"]);

/**
 * 短名：builtin:<name> 原样保留；入口文件取所在目录，且穿过 dist/src 这类容器目录
 * （npm 包常是 <pkg>/dist/index.js，取到 dist 就没法认人）。
 */
function stemOf(path: string): string {
	if (path.startsWith("builtin:") || path.startsWith("<")) return path;
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	const base = (parts.pop() ?? path).replace(/\.(ts|tsx|js|mjs|cjs)$/i, "");
	let stem = base;
	if (base === "index" || base === "main") stem = parts.pop() ?? base;
	while (CONTAINER_DIRS.has(stem) && parts.length > 0) stem = parts.pop() ?? stem;
	return stem;
}

/** 短来源标记：一眼看出插件从哪来，不用去读整条路径。 */
function originTag(source: string, hidden: boolean): string {
	if (hidden) return source.includes("builtin") ? "builtin" : "hidden";
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:") || source.startsWith("github:")) return "git";
	if (source.includes("builtin")) return "builtin";
	if (source.includes("temporary")) return "cli";
	if (source === "cli") return "cli";
	if (/^[A-Za-z]:\//.test(source) || source.startsWith("/") || source.startsWith(".")) return "local";
	if (source === "local" || source.startsWith("<")) return "local";
	return "pkg";
}

/** 短名的上级目录链，从近到远；跳过容器目录，也跳过短名自己（入口是 index/main 时短名就是目录名）。 */
function ancestorChain(path: string, stem: string): string[] {
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	parts.pop();
	while (parts.length > 0 && (CONTAINER_DIRS.has(parts[parts.length - 1]) || parts[parts.length - 1] === stem)) parts.pop();
	const chain: string[] = [];
	for (let i = parts.length - 1; i >= 0; i -= 1) chain.push(parts[i]);
	return chain;
}

/**
 * 重名时逐级补上级目录（跳容器目录），补到没有更多上级仍撞车才加序号。
 * 只补一级不够用：两个仓库各有一份 pi/extensions/foo，要补到 pi 之上才分得开。
 */
function assignNames(paths: string[]): string[] {
	const stems = paths.map(stemOf);
	const groups = new Map<string, number[]>();
	stems.forEach((stem, index) => {
		const bucket = groups.get(stem);
		if (bucket) bucket.push(index);
		else groups.set(stem, [index]);
	});
	const names = [...stems];
	for (const [stem, indexes] of groups) {
		if (indexes.length <= 1) continue;
		const chains = indexes.map((index) => ancestorChain(paths[index], stem));
		const depth = Math.max(...chains.map((chain) => chain.length));
		for (let level = 1; level <= depth; level += 1) {
			indexes.forEach((index, i) => {
				const chain = chains[i].slice(0, level).reverse();
				names[index] = chain.length > 0 ? `${chain.join("/")}/${stem}` : stem;
			});
			if (new Set(indexes.map((index) => names[index])).size === indexes.length) break;
		}
	}
	// 上溯到底仍撞车（路径只差在盘符之类）才用序号兜底
	const used = new Map<string, number>();
	return names.map((name) => {
		const seen = (used.get(name) ?? 0) + 1;
		used.set(name, seen);
		return seen > 1 ? `${name}#${seen}` : name;
	});
}

function toolLabel(tool: GraphTool): string {
	const flags: string[] = [];
	if (!tool.effective) flags.push("被覆盖");
	if (tool.inactive) flags.push("未激活");
	return flags.length > 0 ? `${tool.name}(${flags.join(" ")})` : tool.name;
}

function emptyResources(): GraphResources {
	return { skills: 0, prompts: 0, themes: 0 };
}

/** 再跑一遍 resources_discover 认领技能/提示词/主题；失败不影响出图。 */
async function collectResources(runner: unknown, cwd: string): Promise<Map<string, GraphResources>> {
	const byPath = new Map<string, GraphResources>();
	const emitter = (runner as { emitResourcesDiscover?: (cwd: string, reason: string) => Promise<unknown> } | undefined)
		?.emitResourcesDiscover;
	if (typeof emitter !== "function") return byPath;
	try {
		const result = (await emitter.call(runner, cwd, "reload")) as
			| { skillPaths?: { extensionPath?: string }[]; promptPaths?: { extensionPath?: string }[]; themePaths?: { extensionPath?: string }[] }
			| undefined;
		const buckets: [keyof GraphResources, { extensionPath?: string }[] | undefined][] = [
			["skills", result?.skillPaths],
			["prompts", result?.promptPaths],
			["themes", result?.themePaths],
		];
		for (const [field, items] of buckets) {
			for (const item of items ?? []) {
				const owner = item?.extensionPath;
				if (!owner) continue;
				const entry = byPath.get(owner) ?? emptyResources();
				entry[field] += 1;
				byPath.set(owner, entry);
			}
		}
	} catch {
		// 采集资源是加分项，拿不到就当作没有
	}
	return byPath;
}

/** 降级路径：只用公共 API 的数据，按 owner 分组，没有事件归属。 */
function extensionsFromPublicApi(pi: ExtensionAPI): GraphExt[] {
	const groups = new Map<string, GraphExt>();
	const ensure = (path: string, source: string): GraphExt => {
		let group = groups.get(path);
		if (!group) {
			group = {
				index: groups.size,
				name: stemOf(path),
				path,
				source,
				hidden: false,
				events: [],
				tools: [],
				commands: [],
				shortcuts: [],
				flags: [],
				renderers: [],
				resources: emptyResources(),
			};
			groups.set(path, group);
		}
		return group;
	};

	const active = new Set(pi.getActiveTools());
	for (const tool of pi.getAllTools()) {
		const info = tool.sourceInfo;
		ensure(info?.path ?? "(unknown)", String(info?.source ?? "local")).tools.push({
			name: tool.name,
			exposure: tool.exposure ?? "direct",
			// 公共 API 每个工具名只回一份（就是生效的那份），所以这里必然是 true；
			// 代价是被盖住的那份根本不出现，降级表看不到「被覆盖」关系
			effective: true,
			inactive: tool.exposure === "direct" && !active.has(tool.name),
		});
	}
	for (const command of pi.getCommands()) {
		if (command.source !== "extension") continue;
		const info = command.sourceInfo;
		ensure(info?.path ?? "(unknown)", String(info?.source ?? "local")).commands.push(command.name);
	}
	const list = [...groups.values()];
	// 公共 API 只给来源路径，同名插件（两份 prompt-kit 之类）仍得消歧
	const names = assignNames(list.map((group) => group.path));
	list.forEach((group, index) => {
		group.name = names[index];
	});
	return list;
}

async function collectModel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<GraphModel> {
	const state = graphState();
	const model: GraphModel = {
		format: FORMAT,
		piVersion: String(VERSION ?? "?"),
		capturedAt: new Date().toLocaleString(),
		extensions: [],
		events: [],
	};

	const raw = (state.runner as { extensions?: unknown } | undefined)?.extensions;
	if (!Array.isArray(raw) || raw.length === 0) {
		model.degraded = state.error ?? "没抓到存活的 ExtensionRunner（pi 内部结构可能已变）";
		model.extensions = extensionsFromPublicApi(pi);
		return model;
	}

	const paths = raw.map((ext) => String((ext as { path?: unknown })?.path ?? "(unknown)"));
	const names = assignNames(paths);
	const resources = await collectResources(state.runner, ctx.cwd);

	const activeTools = new Set(pi.getActiveTools());
	const winnerByTool = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const listenerMap = new Map<string, number[]>();

	raw.forEach((rawExt, index) => {
		const ext = rawExt as Record<string, unknown>;
		const handlers = ext.handlers as Map<string, unknown[]> | undefined;
		const events = handlers ? [...handlers.keys()] : [];
		for (const [event, list] of handlers ?? new Map<string, unknown[]>()) {
			const bucket = listenerMap.get(event) ?? [];
			for (let i = 0; i < (list?.length ?? 0); i++) bucket.push(index);
			listenerMap.set(event, bucket);
		}

		const tools: GraphTool[] = [];
		for (const registered of ((ext.tools as Map<string, { definition?: { name?: string; exposure?: string } }>) ?? new Map()).values()) {
			const name = String(registered?.definition?.name ?? "?");
			const winner = winnerByTool.get(name);
			const exposure = String(winner?.exposure ?? registered?.definition?.exposure ?? "direct");
			const effective = winner ? winner.sourceInfo?.path === paths[index] : false;
			tools.push({
				name,
				exposure,
				effective,
				// 被盖住的那份谈不上激活与否：模型看到的激活状态属于盖住它的那份
				inactive: effective && exposure === "direct" && !activeTools.has(name),
			});
		}

		const renderers: string[] = [];
		if (((ext.messageRenderers as Map<string, unknown>)?.size ?? 0) > 0) renderers.push(`消息×${(ext.messageRenderers as Map<string, unknown>).size}`);
		if (((ext.entryRenderers as Map<string, unknown>)?.size ?? 0) > 0) renderers.push(`条目×${(ext.entryRenderers as Map<string, unknown>).size}`);
		if ((ext.toolRenderers as unknown[] | undefined)?.length) renderers.push(`工具×${(ext.toolRenderers as unknown[]).length}`);
		if (ext.markdownTransformer) renderers.push("markdown");

		model.extensions.push({
			index,
			name: names[index],
			path: paths[index],
			source: String((ext.sourceInfo as { source?: string })?.source ?? "local"),
			hidden: ext.hidden === true,
			events,
			tools,
			commands: [...((ext.commands as Map<string, unknown>) ?? new Map()).keys()],
			shortcuts: [...((ext.shortcuts as Map<string, unknown>) ?? new Map()).keys()],
			flags: [...((ext.flags as Map<string, unknown>) ?? new Map()).keys()],
			renderers,
			resources: resources.get(paths[index]) ?? emptyResources(),
		});
	});

	const extras = [...listenerMap.keys()].filter((event) => !LIFECYCLE.includes(event));
	for (const event of [...LIFECYCLE, ...extras]) {
		const listeners = listenerMap.get(event);
		if (listeners?.length) model.events.push({ name: event, listeners });
	}
	return model;
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

function pad(text: string, to: number): string {
	const width = visibleWidth(text);
	return width >= to ? text : text + " ".repeat(to - width);
}

/** 把一段超宽文本按空格切成每段都塞得进 width 的小段。 */
function splitLongItem(item: string, width: number): string[] {
	const pieces: string[] = [];
	let current = "";
	for (const word of item.split(" ")) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (current !== "" && visibleWidth(candidate) > width) {
			pieces.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current !== "") pieces.push(current);
	return pieces;
}

/** 同一扩展为同一事件注册多个 handler 时聚合成 `名字×N`。 */
function listenerLabels(listeners: number[], names: string[]): string[] {
	const labels: string[] = [];
	let i = 0;
	while (i < listeners.length) {
		let j = i;
		while (j + 1 < listeners.length && listeners[j + 1] === listeners[i]) j += 1;
		const label = names[listeners[i]] ?? "?";
		labels.push(j > i ? `${label}×${j - i + 1}` : label);
		i = j + 1;
	}
	return labels;
}

/** pi-tui 对超宽行是抛异常（不是截断），渲染出口统一夹一次宽度。 */
function clampLine(line: string, limit: number): string {
	return visibleWidth(line) > limit ? truncateToWidth(line, limit) : line;
}

function renderGraph(model: GraphModel, theme: Theme, width: number): string[] {
	// 不设最小宽度：pi-tui 对超宽行是抛异常，硬撑一个「最小可读宽度」只会把 TUI 搞崩
	const limit = Math.max(1, Math.floor(width));
	/** 前缀胖到把内容列挤没时就改堆叠排版，而不是把内容硬塞成 1 列。 */
	const minContentWidth = 24;
	const lines: string[] = [];
	const mark = (hook: string) => theme.fg(HOOK_TOKEN[hook] ?? "muted", hook);
	/**
	 * 按项换行，而不是按字符换行：字符级换行会把 ` · ` 分隔符劈到下一行开头，读起来很脏。
	 * 单项本身就超宽时（工具/命令清单那种长串），再按空格把它切成塞得下的段，
	 * 段与段之间用空格而不是 ` · `，让它看得出仍是一整项。续行缩进对齐到内容列；
	 * 前缀自己就吃掉整行时（窄终端）放弃对齐，改成前缀独占一行、条目另起一行。
	 */
	const row = (prefix: string, items: string[], separator = " · ") => {
		const prefixWidth = visibleWidth(prefix);
		const stacked = prefixWidth + minContentWidth > limit;
		if (stacked) lines.push(prefix);
		const indentWidth = stacked ? 2 : prefixWidth;
		const inner = Math.max(1, limit - indentWidth);
		const indent = " ".repeat(indentWidth);
		let current = "";
		let started = stacked;
		const emit = () => {
			if (current === "") return;
			lines.push((started ? indent : prefix) + current);
			started = true;
			current = "";
		};
		for (const item of items) {
			if (visibleWidth(item) > inner) {
				for (const piece of splitLongItem(item, inner)) {
					const candidate = current === "" ? piece : `${current} ${piece}`;
					if (current !== "" && visibleWidth(candidate) > inner) {
						emit();
						current = piece;
					} else {
						current = candidate;
					}
				}
				continue;
			}
			const candidate = current === "" ? item : current + separator + item;
			if (current !== "" && visibleWidth(candidate) > inner) {
				emit();
				current = item;
			} else {
				current = candidate;
			}
		}
		emit();
	};

	if (model.degraded) {
		row(`${theme.fg("warning", theme.bold("pi-graph"))} `, [theme.fg("muted", `降级模式 · ${model.degraded}`)]);
		row(
			"  ",
			[
				theme.fg("dim", "拿不到事件归属与覆盖关系，只能画生效的工具与命令"),
				theme.fg("dim", "pi 升级后这里会自愈或被修好"),
			],
			theme.fg("dim", "；"),
		);
	} else {
		row(
			`${theme.fg("accent", theme.bold("pi-graph"))} `,
			[
				theme.fg("muted", `${model.extensions.length} 插件`),
				theme.fg("muted", `${model.events.length}/${LIFECYCLE.length} 个生命周期事件有人监听`),
				theme.fg("muted", `pi ${model.piVersion}`),
			],
			theme.fg("muted", " · "),
		);
	}
	row(
		"  ",
		[theme.fg("dim", `采集 ${model.capturedAt}`), theme.fg("dim", "注册快照，不含运行时实际触发情况")],
		theme.fg("dim", " · "),
	);
	lines.push("");

	const names = model.extensions.map((ext) => ext.name);
	const byEvent = new Map(model.events.map((event) => [event.name, event.listeners]));

	if (model.events.length > 0) {
		lines.push(theme.fg("accent", theme.bold("▍生命周期 × 插件")));
		row(
			"  ",
			LEGEND.map((item) => `${mark(item.mark)} ${theme.fg("dim", item.label)}`),
			"  ",
		);
		for (const phase of PHASES) {
			const rows = phase.events.filter((event) => byEvent.has(event));
			if (rows.length === 0) continue;
			lines.push(theme.fg("muted", phase.label));
			for (const event of rows) {
				row(`  ${event} ${mark(HOOK[event] ?? "O")}  `, listenerLabels(byEvent.get(event) ?? [], names));
			}
		}
		const extras = model.events.filter((event) => !LIFECYCLE.includes(event.name));
		if (extras.length > 0) {
			lines.push(theme.fg("muted", "其他（本版本 pi 新增的节点）"));
			for (const event of extras) {
				row(`  ${event.name} ${mark(HOOK[event.name] ?? "O")}  `, listenerLabels(event.listeners, names));
			}
		}
		const missing = LIFECYCLE.filter((event) => !byEvent.has(event));
		if (missing.length > 0) {
			lines.push("");
			lines.push(`${theme.fg("accent", theme.bold("▍无人监听"))}${theme.fg("dim", ` ${missing.length}/${LIFECYCLE.length} 个节点没有插件挂载`)}`);
			row("  ", missing.map((event) => theme.fg("dim", event)));
		}
		lines.push("");
	}

	if (model.extensions.length > 0) {
		lines.push(`${theme.fg("accent", theme.bold("▍插件贡献清单"))}${theme.fg("dim", "  按加载顺序 = 事件派发顺序")}`);
		// 名字列按最长名取宽（19–30）：消歧后的长名不至于把后面的来源/内容列顶歪
		const nameWidth = Math.min(30, Math.max(19, ...model.extensions.map((ext) => visibleWidth(ext.name))));
		for (const ext of model.extensions) {
			const bits: string[] = [ext.events.length > 0 ? `${ext.events.length} 事件` : theme.fg("dim", "无事件")];
			if (ext.tools.length > 0) {
				const labels = ext.tools.map((tool) =>
					tool.effective && !tool.inactive ? tool.name : theme.fg(tool.effective ? "dim" : "warning", toolLabel(tool)),
				);
				bits.push(`工具 ${ext.tools.length} ${labels.join(" ")}`);
			}
			if (ext.commands.length > 0) bits.push(`命令 ${ext.commands.map((name) => `/${name}`).join(" ")}`);
			if (ext.shortcuts.length > 0) bits.push(`快捷键 ${ext.shortcuts.join(" ")}`);
			if (ext.flags.length > 0) bits.push(`flags ${ext.flags.join(" ")}`);
			if (ext.renderers.length > 0) bits.push(`渲染 ${ext.renderers.join(" ")}`);
			const resources = ext.resources;
			const resourceBits = ([
				["skills", resources.skills],
				["prompts", resources.prompts],
				["themes", resources.themes],
			] as [string, number][])
				.filter(([, count]) => count > 0)
				.map(([label, count]) => `${label}:${count}`);
			if (resourceBits.length > 0) bits.push(`资源 ${resourceBits.join(" ")}`);
			const title = pad(truncateToWidth(ext.name, nameWidth, "…"), nameWidth) + " " + theme.fg("dim", pad(originTag(ext.source, ext.hidden), 7));
			row(` ${String(ext.index + 1).padStart(2)} ${title} `, bits);
		}
	}
	// 宁可截断，不能崩 TUI
	return lines.map((line) => clampLine(line, limit));
}

// ── 注册 ──────────────────────────────────────────────────────────────────────

/**
 * entry 渲染器的组件外壳：按宽度缓存行，主题变化时 pi 会调 invalidate() 清掉缓存。
 * Component 接口里 invalidate() 是必填的。
 */
function graphComponent(theme: Theme, build: (width: number) => string[]) {
	let cached: { width: number; lines: string[] } | undefined;
	return {
		render(width: number): string[] {
			if (cached?.width !== width) cached = { width, lines: build(width) };
			return cached.lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

export default function piGraph(pi: ExtensionAPI) {
	try {
		installProbe();
	} catch (error) {
		graphState().error = error instanceof Error ? error.message : String(error);
	}

	pi.registerEntryRenderer<GraphModel>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data || data.format !== FORMAT) {
			const warn = theme.fg("warning", "pi-graph: 这条记录来自另一个版本的 pi-graph，格式对不上，跳过");
			return graphComponent(theme, (width) => [clampLine(warn, Math.max(1, Math.floor(width)))]);
		}
		return graphComponent(theme, (width) => renderGraph(data, theme, width));
	});

	pi.registerCommand("pi-graph", {
		description: "画一张「插件 × 生命周期」注册表：事件归属、工具、命令、快捷键、资源",
		handler: async (_args, ctx) => {
			const model = await collectModel(pi, ctx);
			pi.appendEntry<GraphModel>(ENTRY_TYPE, model);

			const summary = model.degraded
				? `pi-graph 降级模式（${model.degraded}）· ${model.extensions.length} 个来源`
				: `pi-graph：${model.extensions.length} 插件 · ${model.events.length}/${LIFECYCLE.length} 个生命周期节点有人监听`;
			// TUI 的整张图由 entry 渲染器负责，通知只报摘要；print / json 模式的 notify 是空实现，
			// 推全文没人看；只有 RPC 客户端看不到 entry 渲染器，才需要把整张图推过去
			const text = ctx.mode === "rpc" ? renderGraph(model, ctx.ui.theme, 100).join("\n") : summary;
			ctx.ui.notify(text, "info");
		},
	});
}
