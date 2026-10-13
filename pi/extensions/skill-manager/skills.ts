/**
 * skill 清单的读取与归一化。
 *
 * 本模块只依赖类型，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 */

export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	scope: string;
	origin: string;
	disableModelInvocation: boolean;
}

/** pi 的 Skill 对象，只声明本扩展用到的字段。 */
interface RawSkill {
	name?: unknown;
	description?: unknown;
	filePath?: unknown;
	disableModelInvocation?: unknown;
	sourceInfo?: { scope?: unknown; origin?: unknown } | undefined;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 把 pi 的 Skill 归一化为 SkillEntry；没有 name 时返回 undefined。 */
export function toEntry(raw: RawSkill): SkillEntry | undefined {
	const name = str(raw.name);
	if (!name) return undefined;
	return {
		name,
		description: str(raw.description),
		filePath: str(raw.filePath),
		scope: str(raw.sourceInfo?.scope) || "unknown",
		origin: str(raw.sourceInfo?.origin) || "unknown",
		disableModelInvocation: raw.disableModelInvocation === true,
	};
}

/** 归一化 pi 的 systemPromptOptions.skills。 */
export function fromOptions(options: { skills?: unknown } | undefined): SkillEntry[] {
	const list = Array.isArray(options?.skills) ? options.skills : [];
	const out: SkillEntry[] = [];
	for (const raw of list) {
		const entry = toEntry(raw as RawSkill);
		if (entry) out.push(entry);
	}
	return out;
}

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

function unescapeXml(text: string): string {
	return text.replace(/&(amp|lt|gt|quot|apos);/g, (match) => XML_ENTITIES[match] ?? match);
}

const SKILL_BLOCK =
	/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;

/**
 * 解析系统提示 `<available_skills>` 段里的 skill。
 *
 * 该来源与模型实际所见一致，但不含 `disable-model-invocation` 标记，
 * 也缺少来源信息（pi 的提示段只写 name / description / location）。
 */
export function fromSystemPrompt(prompt: string): SkillEntry[] {
	const out: SkillEntry[] = [];
	SKILL_BLOCK.lastIndex = 0;
	for (let match = SKILL_BLOCK.exec(prompt); match; match = SKILL_BLOCK.exec(prompt)) {
		const name = unescapeXml(match[1].trim());
		if (!name) continue;
		out.push({
			name,
			description: unescapeXml(match[2].trim()),
			filePath: unescapeXml(match[3].trim()),
			scope: "unknown",
			origin: "unknown",
			disableModelInvocation: false,
		});
	}
	return out;
}

/**
 * 以 primary 为准，用 supplement 补齐缺失的字段与 skill。
 *
 * primary 通常来自系统提示（与模型实际所见一致），supplement 来自 pi 的
 * 加载结果（含作者声明隐藏的 skill 与来源信息）。
 */
export function mergeSkills(primary: SkillEntry[], supplement: SkillEntry[]): SkillEntry[] {
	const byName = new Map(supplement.map((entry) => [entry.name, entry]));
	const seen = new Set<string>();
	const out: SkillEntry[] = [];
	for (const entry of primary) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		const extra = byName.get(entry.name);
		out.push({
			name: entry.name,
			description: entry.description || extra?.description || "",
			filePath: entry.filePath || extra?.filePath || "",
			scope: entry.scope !== "unknown" ? entry.scope : (extra?.scope ?? "unknown"),
			origin: entry.origin !== "unknown" ? entry.origin : (extra?.origin ?? "unknown"),
			disableModelInvocation: entry.disableModelInvocation || (extra?.disableModelInvocation ?? false),
		});
	}
	for (const entry of supplement) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		out.push(entry);
	}
	return out;
}

/** 读取清单所需的最小上下文，由命令上下文满足。 */
export interface SkillsContext {
	getSystemPromptOptions?: () => { skills?: unknown } | undefined;
	getSystemPrompt?: () => string;
}

export interface SkillsDeps {
	/** 前两个数据源都不可用时用它兜底，对应 pi 的 loadSkills。 */
	loadSkills?: () => SkillEntry[] | undefined;
}

/**
 * 读取当前已加载的 skill 清单。
 *
 * 优先用命令上下文的 getSystemPromptOptions()（信息最全），
 * 其次解析系统提示（公开 API，但缺 disable-model-invocation），
 * 最后用 loadSkills 兜底。
 */
export function readSkills(ctx: SkillsContext, deps: SkillsDeps = {}): SkillEntry[] {
	const direct = fromOptions(ctx.getSystemPromptOptions?.());
	if (direct.length > 0) return direct;

	const fromPrompt = fromSystemPrompt(ctx.getSystemPrompt?.() ?? "");
	const supplement = deps.loadSkills?.() ?? [];
	if (fromPrompt.length === 0) return supplement;
	if (supplement.length === 0) return fromPrompt;
	return mergeSkills(fromPrompt, supplement);
}
