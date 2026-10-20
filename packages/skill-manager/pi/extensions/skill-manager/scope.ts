/**
 * 三层作用域配置的读写与合并。
 *
 * 本模块只依赖 node 标准库，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 */
import fs from "node:fs";
import path from "node:path";

export type ScopeSetting = "disabled" | "enabled";
export type ScopeName = "session" | "project" | "global";
export type SettingsMap = Record<string, ScopeSetting>;

export interface ResolvedSetting {
	value: ScopeSetting;
	scope: ScopeName;
}

export const CONFIG_DIR_NAME = ".pi";
export const EXTENSION_DIR_NAME = "pi-skills";

/** 全局配置：<agentDir>/extensions/pi-skills/config.json */
export function globalConfigPath(agentDir: string): string {
	return path.join(agentDir, "extensions", EXTENSION_DIR_NAME, "config.json");
}

/** 项目配置：<cwd>/.pi/extensions/pi-skills/config.json */
export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_DIR_NAME, "config.json");
}

function isSetting(value: unknown): value is ScopeSetting {
	return value === "disabled" || value === "enabled";
}

/** 解析配置文本；非法 JSON、结构不符或取值未知时，只保留可识别的条目。 */
export function parseConfig(text: string): SettingsMap {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return {};
	}
	if (!data || typeof data !== "object") return {};
	const skills = (data as { skills?: unknown }).skills;
	if (!skills || typeof skills !== "object") return {};
	const out: SettingsMap = {};
	for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
		if (isSetting(value)) out[name] = value;
	}
	return out;
}

/** 读取配置文件；文件缺失或不可读时返回空表（视为未提及）。 */
export function readConfig(filePath: string): SettingsMap {
	try {
		return parseConfig(fs.readFileSync(filePath, "utf8"));
	} catch {
		return {};
	}
}

export function serializeConfig(settings: SettingsMap): string {
	return `${JSON.stringify({ version: 1, skills: settings }, null, "\t")}\n`;
}

/** 读-改-写整个配置文件，只改动目标 skill 一项。 */
export function writeSetting(filePath: string, name: string, value: ScopeSetting): void {
	const settings = readConfig(filePath);
	settings[name] = value;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, serializeConfig(settings), "utf8");
}

/**
 * 按 会话 > 项目 > 全局 合并三层设定。
 *
 * 只保留被显式设定的 skill；未提及的一律不出现在结果里。
 */
export function resolveSettings(
	session: SettingsMap,
	project: SettingsMap,
	global: SettingsMap,
): Map<string, ResolvedSetting> {
	const layers: Array<[ScopeName, SettingsMap]> = [
		["session", session],
		["project", project],
		["global", global],
	];
	const out = new Map<string, ResolvedSetting>();
	for (const [scope, settings] of layers) {
		for (const [name, value] of Object.entries(settings)) {
			if (!out.has(name)) out.set(name, { value, scope });
		}
	}
	return out;
}
