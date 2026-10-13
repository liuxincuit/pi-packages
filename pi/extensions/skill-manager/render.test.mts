import assert from "node:assert/strict";
import test from "node:test";

import { displayWidth, isVisible, renderTable, renderStats, sourceLabel, statusLabel } from "./render.ts";
import { resolveSettings } from "./scope.ts";
import type { SkillEntry } from "./skills.ts";
import type { StatsEntry, StatsInput } from "./usage.ts";

function entry(over: Partial<SkillEntry>): SkillEntry {
	return {
		name: "n",
		description: "",
		filePath: "",
		scope: "user",
		origin: "top-level",
		disableModelInvocation: false,
		...over,
	};
}

/** 取一行中显示宽度区间 [startWidth, startWidth + cellWidth) 的文本。 */
function cellAt(line: string, startWidth: number, cellWidth: number): string {
	let width = 0;
	let out = "";
	for (const char of line) {
		const charWidth = displayWidth(char);
		if (width >= startWidth + cellWidth) break;
		if (width >= startWidth) out += char;
		width += charWidth;
	}
	return out;
}

test("displayWidth 区分半角与全角", () => {
	assert.equal(displayWidth("abc"), 3);
	assert.equal(displayWidth("中文"), 4);
	assert.equal(displayWidth("a中文"), 5);
});

test("sourceLabel 区分包与本地来源", () => {
	assert.equal(sourceLabel(entry({ scope: "user", origin: "package" })), "package");
	assert.equal(sourceLabel(entry({ scope: "project", origin: "top-level" })), "project");
	assert.equal(sourceLabel(entry({ scope: "user", origin: "top-level" })), "user");
	assert.equal(sourceLabel(entry({ scope: "unknown", origin: "unknown" })), "unknown");
});

test("statusLabel 区分两类不可见原因", () => {
	const hidden = entry({ name: "h", disableModelInvocation: true });
	assert.equal(statusLabel(hidden, undefined), "作者声明隐藏");
	assert.equal(statusLabel(hidden, { value: "enabled", scope: "session" }), "作者声明隐藏（启用设定无效）");
	assert.equal(statusLabel(entry({ name: "a" }), undefined), "默认");
	assert.equal(statusLabel(entry({ name: "a" }), { value: "disabled", scope: "global" }), "禁用(全局)");
	assert.equal(statusLabel(entry({ name: "a" }), { value: "enabled", scope: "project" }), "启用(项目)");
});

test("isVisible 中作者声明优先于用户设定", () => {
	assert.equal(isVisible(entry({ disableModelInvocation: true }), { value: "enabled", scope: "session" }), false);
	assert.equal(isVisible(entry({}), { value: "disabled", scope: "session" }), false);
	assert.equal(isVisible(entry({}), undefined), true);
});

test("renderTable 空列表给出提示", () => {
	assert.equal(renderTable([], new Map()), "没有可展示的 skill。");
});

test("renderTable 列对齐且中文名字不导致串列", () => {
	const entries = [
		entry({ name: "pdf-tools", description: "提取 PDF 文本与表格", scope: "user", origin: "package" }),
		entry({ name: "中文名字很长", description: "纯中文描述", scope: "project" }),
		entry({ name: "x", description: "被作者隐藏", disableModelInvocation: true }),
	];
	const resolved = resolveSettings({ "pdf-tools": "disabled" }, {}, {});
	const lines = renderTable(entries, resolved).split("\n");
	assert.equal(lines.length, 4);

	const nameWidth = Math.max(displayWidth("名称"), ...entries.map((item) => displayWidth(item.name)));
	const visibleStart = 2 + nameWidth + 2;
	assert.deepEqual(
		lines.slice(1).map((line) => cellAt(line, visibleStart, 3).trim()),
		["no", "yes", "no"],
	);

	const sourceStart = visibleStart + displayWidth("可见") + 2;
	assert.deepEqual(
		lines.slice(1).map((line) => cellAt(line, sourceStart, 7).trim()),
		["package", "project", "user"],
	);
});

test("renderTable 截断过长描述", () => {
	const long = "这是一段非常长的描述".repeat(5);
	const table = renderTable([entry({ name: "a", description: long })], new Map(), { descriptionWidth: 10 });
	const dataLine = table.split("\n")[1];
	assert.ok(dataLine.endsWith("…"));
	assert.ok(displayWidth(dataLine) < displayWidth(long));
});

const NOW = new Date("2026-10-13T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

const STATS_FIXTURE: StatsInput = {
	loaded: [{ name: "foo", counts: [1, 1, 1, 1, 1], lastUsed: at(2) }],
	unloaded: [{ name: "ghost", counts: [0, 0, 0, 0, 1], lastUsed: at(24 * 100) }],
	unrecorded: ["bar"],
};

/** 表头里 `label` 的起始显示列。 */
const colOf = (header: string, label: string) => displayWidth(header.slice(0, header.indexOf(label)));

/** 表头里「3天」的起始显示列。 */
const firstCol = (header: string) => colOf(header, "3天");

/** 三段标题，逐字写死：测试与实现同名同序，不引实现的常量。 */
const TITLES = ["当前加载", "当前未加载", "当前加载但无记录"];

/** 输出里出现的段标题行，按出现顺序。 */
const titleLines = (out: string) => out.split("\n").filter((line) => TITLES.includes(line));

test("renderStats 输出三段标题与表头列", () => {
	const out = renderStats(STATS_FIXTURE, { now: NOW, start: at(24 * 200) });
	assert.match(out, /3天\s+7天\s+1月\s+3月\s+半年/);
	assert.match(out, /最后使用/);
	// 三段各自一行、按固定顺序出现：漏段、多段、顺序错位都会在这里露出来。
	assert.deepEqual(titleLines(out), TITLES);
});

test("renderStats 的数字列与表头同列对齐", () => {
	const lines = renderStats(STATS_FIXTURE, { now: NOW, start: at(24 * 200) }).split("\n");
	const header = lines.find((l) => l.includes("3天"))!;
	assert.equal(cellAt(lines.find((l) => l.includes("foo"))!, firstCol(header), 3).trim(), "1");
	assert.equal(cellAt(lines.find((l) => l.includes("ghost"))!, firstCol(header), 3).trim(), "0");
});

test("renderStats 的数字列右对齐且不窄于表头", () => {
	const input: StatsInput = {
		loaded: [],
		unloaded: [
			{ name: "big", counts: [123, 1, 1, 1, 1], lastUsed: at(1) },
			{ name: "wide", counts: [1234, 1, 1, 1, 1], lastUsed: at(1) },
			{ name: "small", counts: [1, 1, 1, 1, 1], lastUsed: at(1) },
		],
		unrecorded: [],
	};
	const lines = renderStats(input, { now: NOW }).split("\n");
	const header = lines.find((l) => l.includes("3天"))!;
	const row = (name: string) => lines.find((l) => l.includes(name))!;
	const start = firstCol(header);
	// 列宽跟着最宽的数字（4 位）走，个位数右对齐到同一右缘；左对齐会写成「1   」。
	assert.equal(cellAt(row("wide"), start, 4), "1234");
	assert.equal(cellAt(row("big"), start, 4), " 123");
	assert.equal(cellAt(row("small"), start, 4), "   1");
	// 「半年」表头显示宽度 4 > 数字宽度 1：列宽不窄于表头，数字右对齐到右缘。
	assert.equal(cellAt(row("small"), colOf(header, "半年"), 4), "   1");
	// 三行最后使用文案相同（都是「今天」），行尾必须对齐：
	// 列宽漏算数字宽度时，「1234」会溢出本列，把那一行撑宽一格。
	const rowWidths = new Set(["big", "wide", "small"].map((name) => displayWidth(row(name))));
	assert.equal(rowWidths.size, 1);
});

test("renderStats 跳过没有行的段", () => {
	const out = renderStats({ loaded: [], unloaded: [STATS_FIXTURE.unloaded[0]!], unrecorded: [] }, { now: NOW });
	assert.deepEqual(titleLines(out), ["当前未加载"]);
	const onlyUnrecorded = renderStats({ loaded: [], unloaded: [], unrecorded: ["bar"] }, { now: NOW });
	assert.deepEqual(titleLines(onlyUnrecorded), ["当前加载但无记录"]);
});

test("renderStats 最后使用按天数量级格式化", () => {
	// 名字之间互不为前缀，免得按子串找行时找到别的行。
	const rows: StatsEntry[] = [
		{ name: "today", counts: [0, 0, 0, 0, 0], lastUsed: at(0) },
		{ name: "yesterday", counts: [0, 0, 0, 0, 0], lastUsed: at(24) },
		{ name: "d29", counts: [0, 0, 0, 0, 0], lastUsed: at(24 * 29) },
		{ name: "d30", counts: [0, 0, 0, 0, 0], lastUsed: at(24 * 30) },
		{ name: "d100", counts: [0, 0, 0, 0, 0], lastUsed: at(24 * 100) },
		{ name: "none", counts: [0, 0, 0, 0, 0] },
	];
	const lines = renderStats({ loaded: [], unloaded: rows, unrecorded: [] }, { now: NOW }).split("\n");
	const lastCell = (name: string) => lines.find((l) => l.includes(name))!.trimEnd().split(/\s+/).pop();
	assert.deepEqual(
		["today", "yesterday", "d29", "d30", "d100", "none"].map(lastCell),
		["今天", "昨天", "29天前", "1个月前", "3个月前", "-"],
	);
});

test("renderStats 按 nameWidth 截断名称且数字列仍对齐", () => {
	const input: StatsInput = {
		loaded: [],
		unloaded: [{ name: "a".repeat(40), counts: [1, 2, 3, 4, 5], lastUsed: at(24 * 3) }],
		unrecorded: [],
	};
	const lines = renderStats(input, { now: NOW, nameWidth: 12 }).split("\n");
	const header = lines.find((l) => l.includes("3天"))!;
	const row = lines.find((l) => l.includes("aaa"))!;
	assert.equal(cellAt(row, 2, 12), `${"a".repeat(11)}…`);
	assert.equal(cellAt(row, firstCol(header), 3).trim(), "1");
	assert.equal(cellAt(row, colOf(header, "半年"), 4).trim(), "5");

	// nameWidth 比「名称」表头还窄时以表头为准，否则表头与数字列会错位。
	const narrowLines = renderStats(input, { now: NOW, nameWidth: 1 }).split("\n");
	const narrowHeader = narrowLines.find((l) => l.includes("3天"))!;
	assert.equal(cellAt(narrowLines.find((l) => l.includes("aaa"))!, firstCol(narrowHeader), 3).trim(), "1");
});
