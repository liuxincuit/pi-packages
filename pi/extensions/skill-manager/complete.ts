/**
 * /skills 的参数补全候选。
 *
 * 本模块只依赖类型，不 import pi 运行时，因此可以用 `node --test` 直接运行。
 *
 * pi 的补全语义：getArgumentCompletions 收到的是命令名之后的**完整参数串**，
 * 选中的项会替换掉这一整段。所以 value 必须包含完整参数串，而不只是最后一个词。
 */

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

const ACTIONS = ["list", "disable", "enable", "stats"];
const SCOPE_FLAGS = ["--project", "--global"];

const ACTION_DESCRIPTIONS: Record<string, string> = {
	list: "列出全部 skill",
	disable: "禁用某个 skill",
	enable: "启用某个 skill",
	stats: "查看 skill 用量统计",
};

const SCOPE_DESCRIPTIONS: Record<string, string> = {
	"--project": "写入项目配置",
	"--global": "写入全局配置",
};

/**
 * 按已输入的参数串给出补全候选。
 *
 * 分三级：子命令 → skill 名 → 作用域 flag。没有匹配项时返回空数组。
 */
export function completionsFor(prefix: string, skillNames: string[]): CompletionItem[] {
	const tokens = prefix.split(/\s+/).filter(Boolean);
	const endsWithSpace = /\s$/.test(prefix);

	// 已经打完的词，以及正在输入的那一段（结尾是空格时说明上一段已打完）。
	const committed = endsWithSpace ? tokens : tokens.slice(0, -1);
	const current = endsWithSpace ? "" : (tokens[tokens.length - 1] ?? "");
	const base = committed.join(" ");

	const at = (candidate: string, description?: string): CompletionItem => ({
		value: base ? `${base} ${candidate}` : candidate,
		label: candidate,
		...(description ? { description } : {}),
	});

	if (committed.length === 0) {
		return ACTIONS.filter((action) => action.startsWith(current)).map((action) =>
			at(action, ACTION_DESCRIPTIONS[action]),
		);
	}

	const action = committed[0];
	if (action !== "disable" && action !== "enable") return [];

	// 第二级：还没给出 skill 名。
	if (committed.length < 2) {
		return skillNames.filter((name) => name.startsWith(current)).map((name) => at(name, "skill"));
	}

	// 第三级：已经给了 skill 名，补作用域 flag。
	if (!committed.some((token) => token.startsWith("--"))) {
		return SCOPE_FLAGS.filter((flag) => flag.startsWith(current)).map((flag) =>
			at(flag, SCOPE_DESCRIPTIONS[flag]),
		);
	}

	return [];
}
