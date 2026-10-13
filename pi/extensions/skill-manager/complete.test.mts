import assert from "node:assert/strict";
import test from "node:test";

import { completionsFor } from "./complete.ts";

const SKILLS = ["xlsx", "openspec-explore", "openspec-propose", "git-commit"];

test("第一级补全子命令", () => {
	assert.deepEqual(
		completionsFor("", SKILLS).map((item) => item.value),
		["list", "disable", "enable"],
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
});

test("候选带描述", () => {
	assert.equal(completionsFor("disable ", SKILLS)[0].description, "skill");
	assert.equal(completionsFor("disable xlsx ", SKILLS)[0].description, "写入项目配置");
	assert.equal(completionsFor("", SKILLS)[0].description, "列出全部 skill");
});
