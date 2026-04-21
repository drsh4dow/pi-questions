import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";

const CUSTOM_LABEL = "Type your own answer";
const CUSTOM_DESCRIPTION = "Write a short custom answer.";
const UNAVAILABLE_TEXT =
	"ask_questions requires the interactive TUI. Ask the user in chat instead.";
const CANCELLED_TEXT =
	"The user dismissed the questions without submitting answers.";

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

/** Normalized question shape used internally by the TUI flow. */
interface NormalizedQuestion {
	header: string;
	question: string;
	options: QuestionOption[];
	allowCustom: boolean;
}

/** Serializable question metadata persisted in tool results. */
interface QuestionDetails {
	header: string;
	question: string;
	options: string[];
	allowCustom: boolean;
}

/** Serializable answer metadata persisted in tool results. */
interface AnswerDetails {
	questionIndex: number;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
}

/** Full persisted result shape for the ask_questions tool. */
interface ToolDetails {
	status: "answered" | "cancelled" | "unavailable";
	questions: QuestionDetails[];
	answers: AnswerDetails[];
}

/**
 * Normalizes tool arguments into the shape used by rendering and result storage.
 */
function normalizeQuestions(input: InputQuestion[]): NormalizedQuestion[] {
	return input.map((question, index) => ({
		header: question.header?.trim() || `Q${index + 1}`,
		question: question.question,
		options: question.options,
		allowCustom: question.allowCustom !== false,
	}));
}

/** Converts normalized questions into persisted tool metadata. */
function toQuestionDetails(questions: NormalizedQuestion[]): QuestionDetails[] {
	return questions.map((question) => ({
		header: question.header,
		question: question.question,
		options: question.options.map((option) => option.label),
		allowCustom: question.allowCustom,
	}));
}

/**
 * Builds the standard text content for a tool result.
 */
function textResult(
	text: string,
	details: ToolDetails,
): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

/** Summarizes submitted answers into a compact model-friendly sentence fragment. */
function summarize(details: ToolDetails): string {
	if (details.answers.length === 0) {
		return "No answers were submitted.";
	}

	return details.answers
		.map((answer) => `"${answer.question}"="${answer.answer}"`)
		.join(", ");
}

/**
 * Runs the interactive ask_questions flow.
 *
 * Keymap:
 * - `j` / `k` or arrow keys move through options
 * - `h` or left arrow returns to the previous screen
 * - `Enter` confirms the current option or submits the review screen
 * - `Esc` cancels the flow
 */
async function askQuestionsInTui(
	ctx: ExtensionContext,
	questions: NormalizedQuestion[],
	detailsQuestions: QuestionDetails[],
): Promise<ToolDetails> {
	return ctx.ui.custom<ToolDetails>((tui, theme, _kb, done) => {
		const answers: Array<AnswerDetails | undefined> = new Array(
			questions.length,
		);
		const drafts = new Array<string>(questions.length).fill("");
		const selections = new Array<number>(questions.length).fill(0);
		const single = questions.length === 1;
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
		let screenIndex = 0;
		let editing = false;
		let cachedLines: string[] | undefined;

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const inReview = () => !single && screenIndex === questions.length;
		const currentQuestion = () => questions[screenIndex];
		const currentAnswer = () => answers[screenIndex];
		const currentSelection = () => selections[screenIndex] ?? 0;
		const currentOptions = (): DisplayOption[] => {
			const question = currentQuestion();
			if (!question) {
				return [];
			}

			return question.allowCustom
				? [
						...question.options,
						{
							label: CUSTOM_LABEL,
							description: CUSTOM_DESCRIPTION,
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

		const submitAnswer = (answer: AnswerDetails) => {
			answers[answer.questionIndex] = answer;
			if (single) {
				finish("answered");
				return;
			}

			screenIndex = Math.min(questions.length, answer.questionIndex + 1);
			refresh();
		};

		const goBack = () => {
			if (screenIndex === 0) {
				return;
			}

			editing = false;
			screenIndex -= 1;
			refresh();
		};

		const chooseSelection = () => {
			const question = currentQuestion();
			const optionIndex = currentSelection();
			const option = currentOptions()[optionIndex];
			if (!question || !option) {
				return;
			}

			selections[screenIndex] = optionIndex;
			if (option.isCustom) {
				editing = true;
				editor.setText(
					drafts[screenIndex] ||
						(currentAnswer()?.wasCustom ? currentAnswer()?.answer : "") ||
						"",
				);
				refresh();
				return;
			}

			submitAnswer({
				questionIndex: screenIndex,
				header: question.header,
				question: question.question,
				answer: option.label,
				wasCustom: false,
				optionIndex: optionIndex + 1,
			});
		};

		editor.onSubmit = (value) => {
			const question = currentQuestion();
			const answer = value.trim();
			if (!question || !answer) {
				editing = false;
				editor.setText("");
				refresh();
				return;
			}

			drafts[screenIndex] = answer;
			editing = false;
			editor.setText("");
			submitAnswer({
				questionIndex: screenIndex,
				header: question.header,
				question: question.question,
				answer,
				wasCustom: true,
			});
		};

		const frame = (width: number, body: string[], footer: string) => {
			const lines = [theme.fg("accent", "─".repeat(width)), ...body, ""];
			lines.push(truncateToWidth(theme.fg("dim", footer), width));
			lines.push(theme.fg("accent", "─".repeat(width)));
			return lines;
		};

		const renderQuestion = (width: number) => {
			const question = currentQuestion();
			if (!question) {
				return [];
			}

			const selectedIndex = currentSelection();
			const body = [
				truncateToWidth(
					theme.fg("toolTitle", theme.bold(" ask_questions ")) +
						theme.fg(
							"muted",
							`${screenIndex + 1}/${questions.length} • ${question.header}`,
						),
					width,
				),
				truncateToWidth(theme.fg("text", ` ${question.question}`), width),
				"",
			];

			for (const [index, option] of currentOptions().entries()) {
				const active = index === selectedIndex;
				const picked = option.isCustom
					? currentAnswer()?.wasCustom === true
					: currentAnswer()?.answer === option.label;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				const color = active ? "accent" : picked ? "success" : "text";
				body.push(
					truncateToWidth(
						prefix + theme.fg(color, `${index + 1}. ${option.label}`),
						width,
					),
				);
				if (option.description) {
					body.push(
						truncateToWidth(
							`   ${theme.fg("muted", option.description)}`,
							width,
						),
					);
				}
				if (option.isCustom && !editing && drafts[screenIndex]) {
					body.push(
						truncateToWidth(
							`   ${theme.fg("muted", drafts[screenIndex] ?? "")}`,
							width,
						),
					);
				}
				if (option.isCustom && editing && active) {
					for (const line of editor.render(width - 3)) {
						body.push(truncateToWidth(`   ${line}`, width));
					}
				}
			}

			const footer = editing
				? " Enter submit • Esc back"
				: ` ↑↓/jk navigate • 1-9 select • Enter choose${screenIndex > 0 ? " • ←/h back" : ""} • Esc cancel`;
			return frame(width, body, footer);
		};

		const renderReview = (width: number) => {
			const body = [
				truncateToWidth(
					theme.fg("toolTitle", theme.bold(" ask_questions ")) +
						theme.fg("muted", "Review"),
					width,
				),
				truncateToWidth(
					theme.fg("text", " Review your answers before submitting."),
					width,
				),
				"",
			];

			for (const [index, question] of questions.entries()) {
				body.push(
					truncateToWidth(theme.fg("muted", ` ${question.header}`), width),
				);
				body.push(
					truncateToWidth(
						theme.fg("text", ` ${answers[index]?.answer || "(unanswered)"}`),
						width,
					),
				);
				body.push("");
			}

			return frame(width, body, " Enter submit • ←/h back • Esc cancel");
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

			if (inReview()) {
				if (matchesKey(data, Key.enter)) {
					finish("answered");
					return;
				}
				if (matchesKey(data, Key.left) || data === "h") {
					goBack();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish("cancelled");
				}
				return;
			}

			const selectedIndex = currentSelection();
			const options = currentOptions();
			for (let index = 0; index < Math.min(options.length, 9); index++) {
				if (data === String(index + 1)) {
					selections[screenIndex] = index;
					chooseSelection();
					return;
				}
			}

			if (matchesKey(data, Key.up) || data === "k") {
				selections[screenIndex] = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				selections[screenIndex] = Math.min(
					options.length - 1,
					selectedIndex + 1,
				);
				refresh();
				return;
			}
			if (matchesKey(data, Key.left) || data === "h") {
				goBack();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				chooseSelection();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				finish("cancelled");
			}
		}

		return {
			render(width: number) {
				if (!cachedLines) {
					cachedLines = inReview()
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
	});
}

/**
 * Registers the minimal `ask_questions` Pi extension.
 *
 * The tool is intentionally narrow: single-choice questions, optional custom
 * answers, small input limits, and a compact blocking TUI flow.
 */
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
			const questions = normalizeQuestions(params.questions);
			const detailsQuestions = toQuestionDetails(questions);
			if (!ctx.hasUI) {
				return textResult(UNAVAILABLE_TEXT, {
					status: "unavailable",
					questions: detailsQuestions,
					answers: [],
				});
			}

			const details = await askQuestionsInTui(ctx, questions, detailsQuestions);
			if (details.status === "cancelled") {
				return textResult(CANCELLED_TEXT, details);
			}

			return textResult(`User answers: ${summarize(details)}.`, details);
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
