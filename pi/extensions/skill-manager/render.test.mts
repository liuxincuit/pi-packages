import assert from "node:assert/strict";
import test from "node:test";

import { displayWidth, isVisible, renderTable, sourceLabel, statusLabel } from "./render.ts";
import { resolveSettings } from "./scope.ts";
import type { SkillEntry } from "./skills.ts";

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
