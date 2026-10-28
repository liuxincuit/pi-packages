/**
 * claude-skills：把 Claude Code 的项目技能目录接进 pi。
 *
 * pi 只自动发现 <cwd>/.pi/skills 与 .agents/skills；本扩展在 resources_discover
 * 时把 <项目根>/.claude/skills 追加进去，让同一个仓库里 Claude 用的 SKILL.md
 * 也能被 pi 加载。
 *
 * 发现范围：从会话 cwd 向上到 git 根（含），每层找 .claude/skills。
 * 没有 git 根时只查 cwd，避免一路扫到 home 里不属于本项目的技能。
 *
 * 信任：未受信任的项目不返回任何路径，与 pi 对 .pi/skills、.agents/skills
 * 的处理保持一致。
 *
 * 同名冲突：pi 先加载的赢，所以 .pi/skills、.agents/skills 与用户级技能优先于
 * .claude/skills。冲突会出现在 pi 的资源诊断里，但不会阻止加载。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CLAUDE_SKILLS = join(".claude", "skills");

function findGitRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** 从 startDir 到 stopDir（含）逐层给出 .claude/skills；stopDir 为 null 时只给 startDir。 */
export function ancestorSkillDirs(startDir: string, stopDir: string | null): string[] {
	const dirs: string[] = [];
	let dir = resolve(startDir);
	const stop = stopDir ? resolve(stopDir) : null;
	while (true) {
		dirs.push(join(dir, CLAUDE_SKILLS));
		if (!stop || dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

/** 当前会话可能用到的 .claude/skills 目录，已过滤不存在的。 */
export function collectClaudeSkillDirs(
	cwd: string,
	findRoot: (dir: string) => string | null = findGitRoot,
): string[] {
	const start = resolve(cwd);
	const root = findRoot(start);
	return ancestorSkillDirs(start, root).filter((dir) => existsSync(dir));
}

export default function claudeSkills(pi: ExtensionAPI) {
	pi.on("resources_discover", (event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		const skillPaths = collectClaudeSkillDirs(event.cwd);
		if (skillPaths.length === 0) return;
		return { skillPaths };
	});
}
