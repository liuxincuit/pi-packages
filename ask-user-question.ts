/**
 * ask-user-question — 让模型把选择题交给用户，而不是自己猜。
 *
 * 交互骨架取自 pi 示例 examples/extensions/questionnaire.ts，按"保持简洁"砍掉了
 * 社区版 @juicesharp/rpiv-ask-user-question 的选项预览面板、每题备注、折叠快捷键、
 * i18n 与 RPC 降级，只保留：选项列表 + `Type something.` 自由输入、多问题时的
 * tab 切换与 Submit 复核。
 *
 * 设计要点：
 * - 参数用数组下标定位问题，不用 id —— 模型给出重复 id 是一类白送的 bug，而下标
 *   让答案与问题天然对齐。
 * - 所有状态封在 execute 闭包内。本仓库的模块由 loader 按路径缓存，父会话与所有
 *   子代理会话共享同一个模块实例，模块级可变状态会被并发子会话互相踩。
 * - `ctx.mode !== "tui"` 直接返回错误文本。子代理会话用 `bindExtensions({})` 绑定，
 *   pi 的 runner 里是 `setUIContext(uiContext, mode = "print")`，所以子会话恒为
 *   print 模式、`ctx.ui` 是 noOpUIContext：不拦的话 `custom()` 返回 undefined，
 *   读 `result.cancelled` 会直接抛 TypeError。子代理要问用户应走核心协议 ask_parent
 *   （本工具默认也不在子代理的工具白名单里，除非某个 agent frontmatter 显式列出）。
 * - `executionMode: "sequential"`：等 UI 时不能与其他工具调用并发。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

/** 归一化后的问题：label 与 allowOther 都已填好默认值。 */
interface Question {
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	questionIndex: number;
	value: string;
	label: string;
	wasCustom: boolean;
	optionIndex?: number;
}

interface AskUserQuestionDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(
		Type.String({ description: "One-line explanation of what this option means or costs" }),
	),
});

const QuestionSchema = Type.Object({
	label: Type.Optional(
		Type.String({ description: "Short label for the tab bar and the answer report, e.g. 'Scope' (defaults to Q1, Q2)" }),
	),
	prompt: Type.String({ description: "The question text shown above the options" }),
	options: Type.Array(QuestionOptionSchema, { description: "Choices to offer; 2-4 options read best" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Append a 'Type something.' row for an answer in the user's own words (default: true)" }),
	),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask; one call asks them all" }),
});

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: AskUserQuestionDetails } {
	return { content: [{ type: "text", text: message }], details: { questions: [], answers: [], cancelled: true } };
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more multiple-choice questions and get the answers back as structured data. Use it when the answer changes what you would do and the repository cannot tell you. Each question shows its options, with descriptions where they help, and offers a 'Type something.' row for an answer in the user's own words.",
		promptSnippet: "Ask the user structured questions and get their choices back",
		promptGuidelines: [
			"Use ask_user_question when the answer changes what you do; state your assumption and continue when it does not.",
			"Put everything you need answered into a single ask_user_question call instead of interrupting the user repeatedly.",
			"Give an option a description when its label alone would not show the trade-off.",
		],
		parameters: AskUserQuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return errorResult(
					"No interactive UI in this session (non-TUI, e.g. a subagent). A subagent that needs user input should ask its parent via ask_parent.",
				);
			}
			if (params.questions.length === 0) {
				return errorResult("Error: no questions provided");
			}

			const questions: Question[] = params.questions.map((question, index) => ({
				label: question.label || `Q${index + 1}`,
				prompt: question.prompt,
				options: question.options,
				allowOther: question.allowOther !== false,
			}));

			const unanswerable = questions.findIndex((question) => question.options.length === 0 && !question.allowOther);
			if (unanswerable >= 0) {
				return errorResult(
					`Error: question ${unanswerable + 1} has no options and no other-row, so it cannot be answered. Give it options, or drop allowOther: false.`,
				);
			}

			const isMulti = questions.length > 1;
			const submitTab = questions.length;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<AskUserQuestionDetails>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let cachedLines: string[] | undefined;
				const answers = new Map<number, Answer>();

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function finish(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function allAnswered() {
					return answers.size === questions.length;
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const question = currentQuestion();
					if (!question) return [];
					const options: RenderOption[] = [...question.options];
					if (question.allowOther) options.push({ label: "Type something.", isOther: true });
					return options;
				}

				function advance() {
					if (!isMulti) {
						finish(false);
						return;
					}
					currentTab = currentTab < submitTab ? currentTab + 1 : submitTab;
					optionIndex = 0;
					refresh();
				}

				editor.onSubmit = (value) => {
					if (!inputMode) return;
					const trimmed = value.trim();
					inputMode = false;
					editor.setText("");
					if (!trimmed) {
						refresh();
						return;
					}
					answers.set(currentTab, {
						questionIndex: currentTab,
						value: trimmed,
						label: trimmed,
						wasCustom: true,
					});
					advance();
				};

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					if (currentTab === submitTab) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							finish(false);
						} else if (matchesKey(data, Key.escape)) {
							finish(true);
						}
						return;
					}

					const options = currentOptions();

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(options.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const option = options[optionIndex];
						if (!option) return;
						if (option.isOther) {
							inputMode = true;
							editor.setText("");
							refresh();
							return;
						}
						answers.set(currentTab, {
							questionIndex: currentTab,
							value: option.label,
							label: option.label,
							wasCustom: false,
							optionIndex: optionIndex + 1,
						});
						advance();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						finish(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const active = i === currentTab;
							const answered = answers.has(i);
							const text = ` ${answered ? "■" : "□"} ${questions[i].label} `;
							const styled = active
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(answered ? "success" : "muted", text);
							tabs.push(`${styled} `);
						}
						const submitText = " ✓ Submit ";
						tabs.push(
							currentTab === submitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(allAnswered() ? "success" : "dim", submitText),
						);
						tabs.push("→");
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					if (currentTab === submitTab) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (let i = 0; i < questions.length; i++) {
							const answer = answers.get(i);
							if (!answer) continue;
							const chosen = answer.wasCustom ? "(wrote) " : `${answer.optionIndex}. `;
							addWrappedWithPrefix(
								" ",
								theme.fg("muted", `${questions[i].label}: `) + theme.fg("text", chosen + answer.label),
							);
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((question, index) => !answers.has(index))
								.map((question) => question.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Still unanswered: ${missing}`));
						}
					} else {
						const question = currentQuestion();
						const options = currentOptions();
						if (question) {
							addWrappedWithPrefix(" ", theme.fg("text", question.prompt));
							lines.push("");
						}
						for (let i = 0; i < options.length; i++) {
							const option = options[i];
							const selected = i === optionIndex;
							const isOther = option.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${option.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";
							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (option.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", option.description));
							}
						}
						if (inputMode) {
							lines.push("");
							addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, renderWidth - 2))) {
								lines.push(` ${line}`);
							}
						}
					}

					lines.push("");
					if (inputMode) {
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
					} else {
						const help = isMulti
							? "Tab/←→ switch • ↑↓ move • Enter confirm • Esc cancel"
							: "↑↓ move • Enter select • Esc cancel";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			const lines = result.answers.map((answer) => {
				const label = questions[answer.questionIndex].label;
				return answer.wasCustom
					? `${label}: user wrote: ${answer.label}`
					: `${label}: ${answer.optionIndex}. ${answer.label}`;
			});
			if (result.cancelled) {
				lines.push(lines.length > 0 ? "User cancelled before answering the rest." : "User cancelled the questionnaire.");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { questions, answers: result.answers, cancelled: result.cancelled },
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text +=
				questions.length === 1
					? theme.fg("muted", questions[0].prompt ?? "")
					: theme.fg("muted", `${questions.length} questions`);
			for (let i = 0; i < questions.length; i++) {
				const label = questions[i].label || `Q${i + 1}`;
				const options = (Array.isArray(questions[i].options) ? questions[i].options : []).map(
					(option: QuestionOption) => option.label,
				);
				const other = questions[i].allowOther === false ? "" : " + Type something.";
				text += `\n${theme.fg("dim", `  ${label} · ${options.join(" / ")}${other}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionDetails | undefined;
			const first = result.content[0];
			if (!details || details.questions.length === 0) {
				return new Text(first?.type === "text" ? theme.fg("warning", first.text) : "", 0, 0);
			}

			const lines = details.answers.map((answer) => {
				const label = details.questions[answer.questionIndex]?.label ?? `Q${answer.questionIndex + 1}`;
				const chosen = answer.wasCustom
					? `${theme.fg("muted", "(wrote) ")}${answer.label}`
					: `${answer.optionIndex}. ${answer.label}`;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${chosen}`;
			});
			if (details.cancelled) {
				lines.push(theme.fg("warning", details.answers.length > 0 ? "Cancelled before finishing" : "Cancelled"));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
