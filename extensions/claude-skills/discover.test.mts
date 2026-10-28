import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ancestorSkillDirs, CLAUDE_SKILLS } from "./index.ts";

const skills = (dir: string) => join(resolve(dir), CLAUDE_SKILLS);

test("有 git 根时只走到根，不越过它", () => {
	const dirs = ancestorSkillDirs("/repo/packages/app", "/repo");
	assert.deepEqual(dirs, [
		skills("/repo/packages/app"),
		skills("/repo/packages"),
		skills("/repo"),
	]);
});

test("cwd 就是根时只返回一层", () => {
	assert.deepEqual(ancestorSkillDirs("/repo", "/repo"), [skills("/repo")]);
});

test("没有 git 根时只查 cwd", () => {
	assert.deepEqual(ancestorSkillDirs("/somewhere/deep", null), [skills("/somewhere/deep")]);
});
