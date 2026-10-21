import assert from "node:assert/strict";
import test from "node:test";

import { completionsFor } from "./complete.ts";

const SKILLS = ["xlsx", "openspec-explore", "openspec-propose", "git-commit"];

test("第一级补全子命令", () => {
	assert.deepEqual(
		completionsFor("", SKILLS).map((item) => item.value),
		["list", "disable", "enable", "stats"],
	);
	// ACTIONS 与 ACTION_DESCRIPTIONS 是两张平行的表，漏掉描述时 value 断言照样通过，
	// 所以这里把每个子命令的描述一起钉住。
	assert.deepEqual(
		completionsFor("", SKILLS).map((item) => item.description),
		["列出全部 skill", "禁用某个 skill", "启用某个 skill", "查看 skill 用量统计"],
	);
	assert.deepEqual(
		completionsFor("d", SKILLS).map((item) => item.value),
		["disable"],
	);
	assert.deepEqual(
		completionsFor("en", SKILLS).map((item) => item.value),
		["enable"],
	);
	assert.deepEqual(completionsFor("zzz", SKILLS), []);
});

test("补全 stats 子命令", () => {
	const items = completionsFor("st", SKILLS);
	assert.deepEqual(
		items.map((item) => item.value),
		["stats"],
	);
	assert.equal(items[0].description, "查看 skill 用量统计");
});

test("第二级补全 skill 名，value 含完整参数串", () => {
	const items = completionsFor("disable ", SKILLS);
	assert.deepEqual(
		items.map((item) => item.label),
		SKILLS,
	);
	assert.equal(items[0].value, "disable xlsx");

	assert.deepEqual(
		completionsFor("disable open", SKILLS).map((item) => item.value),
		["disable openspec-explore", "disable openspec-propose"],
	);
});

test("第三级补全作用域 flag", () => {
	assert.deepEqual(
		completionsFor("disable xlsx ", SKILLS).map((item) => item.value),
		["disable xlsx --project", "disable xlsx --global"],
	);
	assert.deepEqual(
		completionsFor("enable xlsx --g", SKILLS).map((item) => item.value),
		["enable xlsx --global"],
	);
});

test("参数已给全或动作不支持补全时不给候选", () => {
	assert.deepEqual(completionsFor("disable xlsx --project ", SKILLS), []);
	assert.deepEqual(completionsFor("list ", SKILLS), []);
	assert.deepEqual(completionsFor("list x", SKILLS), []);
	assert.deepEqual(completionsFor("stats ", SKILLS), []);
	// 第三级要用「已经给了 skill 名」的输入来探：`stats --` 里的 `--` 自己就会让 flag 分支
	// 不产出候选，区分不出「守卫拦住 stats」和「碰巧没有候选」。
	assert.deepEqual(completionsFor("stats xlsx ", SKILLS), []);
});

test("候选带描述", () => {
	assert.equal(completionsFor("disable ", SKILLS)[0].description, "skill");
	assert.equal(completionsFor("disable xlsx ", SKILLS)[0].description, "写入项目配置");
	assert.equal(completionsFor("", SKILLS)[0].description, "列出全部 skill");
});
