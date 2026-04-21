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

const TOOL_NAME = "ask_questions";
const TOOL_TITLE = ` ${TOOL_NAME} `;
const CUSTOM_LABEL = "Write your own answer";
const CUSTOM_DESCRIPTION = "Open a small text box.";
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

/** Question shape used internally by the TUI flow. */
interface NormalizedQuestion {
	header: string;
	question: string;
	options: QuestionOption[];
	allowCustom: boolean;
}

/** Question metadata persisted in tool results. */
interface QuestionDetails {
	header: string;
	question: string;
	options: string[];
	allowCustom: boolean;
}

/** Answer metadata persisted in tool results. */
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
 * Normalizes tool input and derives the persisted question metadata in one pass.
 */
function prepareQuestions(input: InputQuestion[]) {
	const questions = input.map(
		(question, index) =>
			({
				header: question.header?.trim() || `Q${index + 1}`,
				question: question.question,
				options: question.options,
				allowCustom: question.allowCustom !== false,
			}) satisfies NormalizedQuestion,
	);
	return {
		questions,
		details: questions.map(
			(question) =>
				({
					header: question.header,
					question: question.question,
					options: question.options.map((option) => option.label),
					allowCustom: question.allowCustom,
				}) satisfies QuestionDetails,
		),
	};
}

/** Builds the standard text content for a tool result. */
function textResult(
	text: string,
	details: ToolDetails,
): AgentToolResult<ToolDetails> {
	return { content: [{ type: "text", text }], details };
}

/** Summarizes submitted answers into a compact model-friendly sentence fragment. */
function summarize(details: ToolDetails): string {
	return details.answers.length === 0
		? "No answers were submitted."
		: details.answers
				.map((answer) => `"${answer.question}"="${answer.answer}"`)
				.join(", ");
}

/** Formats a persisted answer for compact result rendering. */
function formatAnswer(answer: AnswerDetails): string {
	return answer.wasCustom
		? `${answer.header}: ${answer.answer}`
		: `${answer.header}: ${answer.optionIndex}. ${answer.answer}`;
}

/**
 * Runs the interactive ask_questions flow.
 *
 * Keymap:
 * - `j` / `k` or arrow keys move through options
 * - `h` or left arrow returns to the previous screen
 * - `Enter` confirms the current option or submits the review screen
 * - `l` confirms the current option, except on the review screen
 * - `Esc` cancels the flow
 */
async function askQuestionsInTui(
	ctx: ExtensionContext,
	questions: NormalizedQuestion[],
	details: QuestionDetails[],
): Promise<ToolDetails> {
	return ctx.ui.custom<ToolDetails>((tui, theme, _kb, done) => {
		const answers: Array<AnswerDetails | undefined> = Array(questions.length);
		const drafts = Array(questions.length).fill("");
		const selections = Array(questions.length).fill(0);
		const single = questions.length === 1;
		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		} satisfies EditorTheme);
		let screen = 0;
		let editing = false;
		let cache: string[] | undefined;

		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		const isUp = (data: string) => matchesKey(data, Key.up) || data === "k";
		const isDown = (data: string) => matchesKey(data, Key.down) || data === "j";
		const isBack = (data: string) => matchesKey(data, Key.left) || data === "h";
		const isConfirm = (data: string) => matchesKey(data, Key.enter);
		const isSelect = (data: string) =>
			matchesKey(data, Key.enter) || data === "l";
		const inReview = () => !single && screen === questions.length;
		const question = () => questions[screen];
		const answer = () => answers[screen];
		const selection = () => selections[screen] ?? 0;
		const options = (index = screen): DisplayOption[] => {
			const item = questions[index];
			return !item
				? []
				: item.allowCustom
					? [
							...item.options,
							{
								label: CUSTOM_LABEL,
								description: CUSTOM_DESCRIPTION,
								isCustom: true,
							},
						]
					: [...item.options];
		};
		const addResult = (status: ToolDetails["status"]) =>
			done({
				status,
				questions: details,
				answers: answers.filter(
					(value): value is AnswerDetails => value !== undefined,
				),
			});
		const title = (text: string) =>
			theme.fg("toolTitle", theme.bold(TOOL_TITLE)) + theme.fg("muted", text);
		const resetEditor = () => {
			editing = false;
			editor.setText("");
		};
		const submit = (next: AnswerDetails) => {
			answers[next.questionIndex] = next;
			if (single) {
				addResult("answered");
				return;
			}
			screen = Math.min(questions.length, next.questionIndex + 1);
			refresh();
		};
		const select = () => {
			const current = question();
			const index = selection();
			const option = options()[index];
			if (!current || !option) {
				return;
			}
			selections[screen] = index;
			if (option.isCustom) {
				editing = true;
				editor.setText(
					drafts[screen] || (answer()?.wasCustom ? answer()?.answer : "") || "",
				);
				refresh();
				return;
			}
			submit({
				questionIndex: screen,
				header: current.header,
				question: current.question,
				answer: option.label,
				wasCustom: false,
				optionIndex: index + 1,
			});
		};

		editor.onSubmit = (value) => {
			const current = question();
			const next = value.trim();
			if (!current || !next) {
				resetEditor();
				refresh();
				return;
			}
			drafts[screen] = next;
			resetEditor();
			submit({
				questionIndex: screen,
				header: current.header,
				question: current.question,
				answer: next,
				wasCustom: true,
			});
		};

		function render(width: number) {
			const lines = [theme.fg("accent", "─".repeat(width))];
			const add = (text = "") => lines.push(truncateToWidth(text, width));

			if (inReview()) {
				add(title("Review answers"));
				add(theme.fg("text", " One last look before submitting."));
				add();
				for (const [index, item] of questions.entries()) {
					add(theme.fg("muted", ` ${item.header}`));
					add(theme.fg("text", ` ${answers[index]?.answer || "(unanswered)"}`));
					add();
				}
				add(theme.fg("dim", " Enter submit • h/← back • Esc cancel"));
				lines.push(theme.fg("accent", "─".repeat(width)));
				return lines;
			}

			const current = question();
			if (!current) {
				return lines;
			}

			add(title(`${screen + 1}/${questions.length} • ${current.header}`));
			add(theme.fg("text", ` ${current.question}`));
			add();
			for (const [index, option] of options().entries()) {
				const active = index === selection();
				const picked = option.isCustom
					? answer()?.wasCustom === true
					: answer()?.answer === option.label;
				add(
					(active ? theme.fg("accent", "> ") : "  ") +
						theme.fg(
							active ? "accent" : picked ? "success" : "text",
							`${index + 1}. ${option.label}`,
						),
				);
				if (option.description) {
					add(`   ${theme.fg("muted", option.description)}`);
				}
				if (option.isCustom && !editing && drafts[screen]) {
					add(`   ${theme.fg("muted", drafts[screen] ?? "")}`);
				}
				if (option.isCustom && editing && active) {
					for (const line of editor.render(width - 3)) {
						add(`   ${line}`);
					}
				}
			}
			add();
			add(
				theme.fg(
					"dim",
					editing
						? " Type answer • Enter save • Esc back"
						: ` jk/↑↓ move • 1-9 pick • Enter/l select${screen > 0 ? " • h/← back" : ""} • Esc cancel`,
				),
			);
			lines.push(theme.fg("accent", "─".repeat(width)));
			return lines;
		}

		function handleInput(data: string) {
			if (editing) {
				if (matchesKey(data, Key.escape)) {
					resetEditor();
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (inReview()) {
				if (isConfirm(data)) {
					addResult("answered");
					return;
				}
				if (isBack(data)) {
					screen -= 1;
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					addResult("cancelled");
				}
				return;
			}
			for (let index = 0; index < Math.min(options().length, 9); index++) {
				if (data === String(index + 1)) {
					selections[screen] = index;
					select();
					return;
				}
			}
			if (isUp(data)) {
				selections[screen] = Math.max(0, selection() - 1);
				refresh();
				return;
			}
			if (isDown(data)) {
				selections[screen] = Math.min(options().length - 1, selection() + 1);
				refresh();
				return;
			}
			if (isBack(data)) {
				if (screen > 0) {
					screen -= 1;
					refresh();
				}
				return;
			}
			if (isSelect(data)) {
				select();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				addResult("cancelled");
			}
		}

		return {
			render(width: number) {
				if (!cache) {
					cache = render(width);
				}
				return cache;
			},
			invalidate() {
				cache = undefined;
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
		name: TOOL_NAME,
		label: "Ask Questions",
		description:
			"Ask the user one or more structured questions in the interactive TUI. Prefer this over free-form chat whenever requirements, preferences, constraints, confirmations, or plan-shaping decisions are missing.",
		promptSnippet:
			"Ask the user structured questions to clarify requirements, gather preferences, and unblock planning or implementation.",
		promptGuidelines: [
			"Use this tool whenever user input would change the plan, implementation, priorities, or acceptance criteria. Do not guess when a short question can resolve uncertainty.",
			"When planning, ask this tool first for missing requirements, tradeoffs, constraints, or preferences before finalizing the plan.",
			"Batch related questions into one ask_questions call instead of asking them one-by-one in chat.",
			"Prefer short concrete option lists. Put your recommended option first and append '(Recommended)' when applicable.",
			"If you are about to ask the user a question in natural language, strongly prefer this tool instead.",
		],
		parameters: AskQuestionsParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const prepared = prepareQuestions(params.questions);
			if (!ctx.hasUI) {
				return textResult(UNAVAILABLE_TEXT, {
					status: "unavailable",
					questions: prepared.details,
					answers: [],
				});
			}
			const details = await askQuestionsInTui(
				ctx,
				prepared.questions,
				prepared.details,
			);
			return textResult(
				details.status === "cancelled"
					? CANCELLED_TEXT
					: `User answers: ${summarize(details)}.`,
				details,
			);
		},
		renderCall(args, theme) {
			const questions = Array.isArray(args.questions)
				? (args.questions as InputQuestion[])
				: [];
			const preview = questions[0]?.question;
			return new Text(
				theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) +
					theme.fg(
						"muted",
						`${questions.length} question${questions.length === 1 ? "" : "s"}${preview ? ` • ${preview}` : ""}`,
					),
				0,
				0,
			);
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
			return new Text(
				details.answers
					.map(
						(answer) =>
							theme.fg("success", "✓ ") +
							theme.fg("accent", formatAnswer(answer)),
					)
					.join("\n"),
				0,
				0,
			);
		},
	});
}
