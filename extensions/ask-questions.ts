import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const OptionSchema = Type.Object({
	label: Type.String({
		minLength: 1,
		maxLength: 80,
		description: "Display label for the option",
	}),
	description: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 160,
			description: "Optional short explanation for the option",
		}),
	),
});

const QuestionSchema = Type.Object({
	header: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 30,
			description:
				"Short label used in progress and review, e.g. Scope or Priority",
		}),
	),
	question: Type.String({
		minLength: 1,
		maxLength: 500,
		description: "Complete question to ask the user",
	}),
	options: Type.Array(OptionSchema, {
		minItems: 1,
		maxItems: 8,
		description: "Available choices. Keep the list short and concrete.",
	}),
	allowCustom: Type.Optional(
		Type.Boolean({
			description:
				"Allow a final 'Type your own answer' option. Defaults to true.",
		}),
	),
});

const AskQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 6,
		description: "Ordered questions to ask. Keep this small.",
	}),
});

type QuestionOption = Static<typeof OptionSchema>;
type InputQuestion = Static<typeof QuestionSchema>;
type DisplayOption = QuestionOption & { isCustom?: true };

interface QuestionDetails {
	header: string;
	question: string;
	options: string[];
	allowCustom: boolean;
}

interface AnswerDetails {
	questionIndex: number;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
}

interface ToolDetails {
	status: "answered" | "cancelled" | "unavailable";
	questions: QuestionDetails[];
	answers: AnswerDetails[];
}

function summarize(details: ToolDetails): string {
	if (details.answers.length === 0) {
		return "No answers were submitted.";
	}

	return details.answers
		.map((answer) => `"${answer.question}"="${answer.answer}"`)
		.join(", ");
}

export default function askQuestionsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_questions",
		label: "Ask Questions",
		description:
			"Ask the user one or more structured questions in the interactive TUI. Use when you need an explicit decision, preference, or clarification before continuing.",
		promptSnippet:
			"Ask the user structured questions in the interactive TUI and wait for their answers.",
		promptGuidelines: [
			"Use this tool when the request is ambiguous and a short structured choice is better than guessing.",
			"Keep questionnaires short and concrete. Prefer a few high-signal options over broad open-ended prompts.",
			"Put the recommended option first and append '(Recommended)' to its label when you have a strong default.",
		],
		parameters: AskQuestionsParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions.map((question, index) => ({
				header: question.header?.trim() || `Q${index + 1}`,
				question: question.question,
				options: question.options,
				allowCustom: question.allowCustom !== false,
			}));
			const detailsQuestions: QuestionDetails[] = questions.map((question) => ({
				header: question.header,
				question: question.question,
				options: question.options.map((option) => option.label),
				allowCustom: question.allowCustom,
			}));

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "ask_questions requires the interactive TUI. Ask the user in chat instead.",
						},
					],
					details: {
						status: "unavailable",
						questions: detailsQuestions,
						answers: [],
					} satisfies ToolDetails,
				};
			}

			const result = await ctx.ui.custom<ToolDetails>(
				(tui, theme, _kb, done) => {
					const single = questions.length === 1;
					const answers: Array<AnswerDetails | undefined> = new Array(
						questions.length,
					);
					const selectedIndices = new Array<number>(questions.length).fill(0);
					const drafts = new Array<string>(questions.length).fill("");
					let screenIndex = 0;
					let editing = false;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (text) => theme.fg("accent", text),
						selectList: {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						},
					};
					const editor = new Editor(tui, editorTheme);

					const refresh = () => {
						cachedLines = undefined;
						tui.requestRender();
					};

					const isReview = () => !single && screenIndex === questions.length;

					const getOptions = (questionIndex: number): DisplayOption[] => {
						const question = questions[questionIndex];
						if (!question) {
							return [];
						}

						return question.allowCustom
							? [
									...question.options,
									{
										label: "Type your own answer",
										description: "Write a short custom answer.",
										isCustom: true,
									},
								]
							: [...question.options];
					};

					const finish = (status: ToolDetails["status"]) => {
						done({
							status,
							questions: detailsQuestions,
							answers: answers.filter(
								(answer): answer is AnswerDetails => answer !== undefined,
							),
						});
					};

					const moveBack = () => {
						if (screenIndex === 0) {
							return;
						}

						editing = false;
						screenIndex = Math.max(0, screenIndex - 1);
						refresh();
					};

					const answerQuestion = (
						questionIndex: number,
						optionIndex: number,
					) => {
						const question = questions[questionIndex];
						const option = getOptions(questionIndex)[optionIndex];
						if (!question || !option) {
							return;
						}

						selectedIndices[questionIndex] = optionIndex;
						if (option.isCustom) {
							editing = true;
							editor.setText(
								drafts[questionIndex] ||
									(answers[questionIndex]?.wasCustom
										? answers[questionIndex]?.answer
										: "") ||
									"",
							);
							refresh();
							return;
						}

						answers[questionIndex] = {
							questionIndex,
							header: question.header,
							question: question.question,
							answer: option.label,
							wasCustom: false,
							optionIndex: optionIndex + 1,
						};

						if (single) {
							finish("answered");
							return;
						}

						screenIndex =
							questionIndex === questions.length - 1
								? questions.length
								: questionIndex + 1;
						refresh();
					};

					editor.onSubmit = (value) => {
						const question = questions[screenIndex];
						const trimmed = value.trim();
						if (!question) {
							editing = false;
							editor.setText("");
							refresh();
							return;
						}

						if (!trimmed) {
							editing = false;
							editor.setText("");
							refresh();
							return;
						}

						drafts[screenIndex] = trimmed;
						answers[screenIndex] = {
							questionIndex: screenIndex,
							header: question.header,
							question: question.question,
							answer: trimmed,
							wasCustom: true,
						};
						editor.setText("");
						editing = false;

						if (single) {
							finish("answered");
							return;
						}

						screenIndex =
							screenIndex === questions.length - 1
								? questions.length
								: screenIndex + 1;
						refresh();
					};

					const renderQuestion = (width: number) => {
						const question = questions[screenIndex];
						const options = getOptions(screenIndex);
						const selectedIndex = selectedIndices[screenIndex] ?? 0;
						const lines: string[] = [];
						const add = (text: string) => {
							lines.push(truncateToWidth(text, width));
						};

						if (!question) {
							return lines;
						}

						add(theme.fg("accent", "─".repeat(width)));
						add(
							theme.fg("toolTitle", theme.bold(" ask_questions ")) +
								theme.fg(
									"muted",
									`${screenIndex + 1}/${questions.length} • ${question.header}`,
								),
						);
						add(theme.fg("text", ` ${question.question}`));
						lines.push("");

						for (let index = 0; index < options.length; index++) {
							const option = options[index];
							if (!option) {
								continue;
							}

							const active = index === selectedIndex;
							const picked = option.isCustom
								? answers[screenIndex]?.wasCustom === true
								: answers[screenIndex]?.answer === option.label;
							const prefix = active ? theme.fg("accent", "> ") : "  ";
							const label = option.isCustom
								? `${index + 1}. ${option.label}`
								: `${index + 1}. ${option.label}`;
							const color = active ? "accent" : picked ? "success" : "text";

							add(prefix + theme.fg(color, label));
							if (option.description) {
								add(`   ${theme.fg("muted", option.description)}`);
							}
							if (option.isCustom && !editing) {
								const draft = drafts[screenIndex] ?? "";
								if (draft) {
									add(`   ${theme.fg("muted", draft)}`);
								}
							}
							if (option.isCustom && editing && active) {
								for (const line of editor.render(width - 3)) {
									add(`   ${line}`);
								}
							}
						}

						lines.push("");
						if (editing) {
							add(theme.fg("dim", " Enter submit • Esc back"));
						} else {
							const backHint = screenIndex > 0 ? " • ← back" : "";
							add(
								theme.fg(
									"dim",
									` ↑↓ navigate • 1-9 select • Enter choose${backHint} • Esc cancel`,
								),
							);
						}
						add(theme.fg("accent", "─".repeat(width)));

						return lines;
					};

					const renderReview = (width: number) => {
						const lines: string[] = [];
						const add = (text: string) => {
							lines.push(truncateToWidth(text, width));
						};

						add(theme.fg("accent", "─".repeat(width)));
						add(
							theme.fg("toolTitle", theme.bold(" ask_questions ")) +
								theme.fg("muted", "Review"),
						);
						add(theme.fg("text", " Review your answers before submitting."));
						lines.push("");

						for (let index = 0; index < questions.length; index++) {
							const question = questions[index];
							const answer = answers[index];
							if (!question) {
								continue;
							}

							add(theme.fg("muted", ` ${question.header}`));
							add(theme.fg("text", ` ${answer?.answer || "(unanswered)"}`));
							lines.push("");
						}

						add(theme.fg("dim", " Enter submit • ← back • Esc cancel"));
						add(theme.fg("accent", "─".repeat(width)));
						return lines;
					};

					function handleInput(data: string) {
						if (editing) {
							if (matchesKey(data, Key.escape)) {
								editing = false;
								editor.setText("");
								refresh();
								return;
							}

							editor.handleInput(data);
							refresh();
							return;
						}

						if (isReview()) {
							if (matchesKey(data, Key.enter)) {
								finish("answered");
								return;
							}
							if (matchesKey(data, Key.left)) {
								moveBack();
								return;
							}
							if (matchesKey(data, Key.escape)) {
								finish("cancelled");
							}
							return;
						}

						const options = getOptions(screenIndex);
						const selectedIndex = selectedIndices[screenIndex] ?? 0;
						for (let index = 0; index < Math.min(options.length, 9); index++) {
							if (data === String(index + 1)) {
								answerQuestion(screenIndex, index);
								return;
							}
						}

						if (matchesKey(data, Key.up)) {
							selectedIndices[screenIndex] = Math.max(0, selectedIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							selectedIndices[screenIndex] = Math.min(
								options.length - 1,
								selectedIndex + 1,
							);
							refresh();
							return;
						}
						if (matchesKey(data, Key.left)) {
							moveBack();
							return;
						}
						if (matchesKey(data, Key.enter)) {
							answerQuestion(screenIndex, selectedIndex);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							finish("cancelled");
						}
					}

					return {
						render(width: number) {
							if (!cachedLines) {
								cachedLines = isReview()
									? renderReview(width)
									: renderQuestion(width);
							}
							return cachedLines;
						},
						invalidate() {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			if (result.status === "cancelled") {
				return {
					content: [
						{
							type: "text",
							text: "The user dismissed the questions without submitting answers.",
						},
					],
					details: result,
				};
			}

			return {
				content: [
					{ type: "text", text: `User answers: ${summarize(result)}.` },
				],
				details: result,
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions)
				? (args.questions as InputQuestion[])
				: [];
			const count = questions.length;
			const preview = questions[0]?.question;
			const text =
				theme.fg("toolTitle", theme.bold("ask_questions ")) +
				theme.fg(
					"muted",
					`${count} question${count === 1 ? "" : "s"}${preview ? ` • ${preview}` : ""}`,
				);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ToolDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", "UI unavailable"), 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				const label = answer.wasCustom
					? `${answer.header}: ${answer.answer}`
					: `${answer.header}: ${answer.optionIndex}. ${answer.answer}`;
				return theme.fg("success", "✓ ") + theme.fg("accent", label);
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
