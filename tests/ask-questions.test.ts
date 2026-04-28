import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import askQuestionsExtension from "../extensions/ask-questions.ts";

type AskQuestionsTool = Parameters<ExtensionAPI["registerTool"]>[0];
type RenderableComponent = {
	handleInput: (data: string) => void;
	render: (width: number) => string[];
};

function getTool(): AskQuestionsTool {
	let tool: unknown;

	askQuestionsExtension({
		registerTool(definition) {
			tool = definition;
		},
	} as ExtensionAPI);

	if (!tool) {
		throw new Error("ask_questions tool was not registered");
	}

	return tool as AskQuestionsTool;
}

function createTheme() {
	return {
		bold(text: string) {
			return text;
		},
		fg(_color: string, text: string) {
			return text;
		},
	};
}

test("registers a small broadly positioned ask_questions tool without exposing custom-answer config", () => {
	const tool = getTool();
	const parameters = tool.parameters as unknown as {
		properties: {
			questions: {
				minItems?: number;
				maxItems?: number;
				items: {
					properties: Record<string, unknown> & {
						header: { maxLength?: number };
						question: { maxLength?: number };
						allowCustom?: unknown;
						options: {
							items: {
								properties: {
									label: { maxLength?: number };
									description: { maxLength?: number };
								};
							};
						};
					};
				};
			};
		};
	};
	const questions = parameters.properties.questions;
	const questionProps = questions.items.properties;
	const optionProps = questionProps.options.items.properties;
	const promptGuidelines = tool.promptGuidelines ?? [];
	const promptGuidelineText = promptGuidelines.join(" ").toLowerCase();

	expect(tool.name).toBe("ask_questions");
	expect(tool.label).toBe("Ask Questions");
	expect(tool.executionMode).toBe("sequential");
	expect(tool.description).toContain("structured questions");
	expect(tool.description).toContain("interactive TUI");
	expect(tool.description).toContain("direct user questions");
	expect(tool.promptSnippet).toContain("missing user input");
	expect(promptGuidelines).toHaveLength(2);
	expect(
		promptGuidelines.every((guideline) => guideline.includes("ask_questions")),
	).toBe(true);
	expect(promptGuidelineText).toContain("trivial");
	expect(promptGuidelineText).toContain("rhetorical");
	expect(promptGuidelineText).toContain("lightweight next-step question");
	expect(promptGuidelineText).toContain("batch");
	expect(promptGuidelineText).toContain("recommended option first");
	expect(promptGuidelineText).not.toContain("planning");
	expect(questions.minItems).toBe(1);
	expect(questions.maxItems).toBe(6);
	expect(questionProps.header.maxLength).toBe(50);
	expect(questionProps.question.maxLength).toBe(500);
	expect(optionProps.label.maxLength).toBe(120);
	expect(optionProps.description.maxLength).toBe(240);
	expect(questionProps.allowCustom).toBeUndefined();
});

test("registers no lifecycle hooks or background work", () => {
	const calls: string[] = [];
	askQuestionsExtension({
		on(event: string) {
			calls.push(`on:${event}`);
		},
		registerTool(definition: AskQuestionsTool) {
			calls.push(`tool:${definition.name}`);
		},
	} as unknown as ExtensionAPI);

	expect(calls).toEqual(["tool:ask_questions"]);
});

test("package metadata follows Pi package distribution conventions", async () => {
	const pkg = (await Bun.file("package.json").json()) as {
		files?: string[];
		pi?: { extensions?: string[] };
		peerDependencies?: Record<string, string>;
	};

	expect(pkg.pi?.extensions).toEqual(["./extensions/ask-questions.ts"]);
	expect(pkg.files).toEqual(["extensions", "README.md"]);
	expect(pkg.peerDependencies).toEqual({
		"@mariozechner/pi-ai": "*",
		"@mariozechner/pi-coding-agent": "*",
		"@mariozechner/pi-tui": "*",
	});
});

test("returns a graceful unavailable result when interactive UI is missing", async () => {
	const tool = getTool();
	const result = await tool.execute(
		"call-1",
		{
			questions: [
				{
					question: "Which stack should we use?",
					options: [{ label: "Bun", description: "Use Bun end to end" }],
				},
			],
		},
		undefined,
		undefined,
		{ hasUI: false } as ExtensionContext,
	);

	expect(result.content[0]).toEqual({
		type: "text",
		text: "ask_questions requires the interactive TUI. Ask the user in chat instead.",
	});
	expect(result.details).toEqual({
		status: "unavailable",
		questions: [
			{
				header: "Q1",
				question: "Which stack should we use?",
				options: ["Bun"],
			},
		],
		answers: [],
	});
});

test("keeps the cancelled flow unchanged", async () => {
	const tool = getTool();
	const result = await tool.execute(
		"call-cancel",
		{
			questions: [
				{
					question: "Pick one",
					options: [{ label: "A" }],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					component.handleInput("\u001b");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	expect(result.content[0]).toEqual({
		type: "text",
		text: "The user dismissed the questions without submitting answers.",
	});
	expect(result.details).toEqual({
		status: "cancelled",
		questions: [
			{
				header: "Q1",
				question: "Pick one",
				options: ["A"],
			},
		],
		answers: [],
	});
});

test("returns full question text in the agent-facing result", async () => {
	const tool = getTool();
	const longQuestion =
		"Pick the safer path when migrating the prompt builder so the full question survives end to end and the agent does not drift on hidden truncation boundaries.";
	const result = await tool.execute(
		"call-2",
		{
			questions: [
				{
					question: longQuestion,
					options: [
						{ label: "First", description: "First option" },
						{ label: "Second", description: "Second option" },
					],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					component.handleInput("j");
					component.handleInput("l");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	expect(result.content[0]).toEqual({
		type: "text",
		text: `User answers:\n1. Question: ${longQuestion}\n   Answer: Second`,
	});
	expect(result.details).toEqual({
		status: "answered",
		questions: [
			{
				header: "Q1",
				question: longQuestion,
				options: ["First", "Second"],
			},
		],
		answers: [
			{
				questionIndex: 0,
				header: "Q1",
				question: longQuestion,
				answer: "Second",
				wasCustom: false,
				optionIndex: 2,
			},
		],
	});
});

test("always offers a typed answer path", async () => {
	const tool = getTool();
	const result = await tool.execute(
		"call-custom",
		{
			questions: [
				{
					question: "Which runtime should we use?",
					options: [{ label: "Bun", description: "Default pick" }],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					component.handleInput("j");
					component.handleInput("l");
					for (const char of "Custom stack") {
						component.handleInput(char);
					}
					component.handleInput("\r");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	expect(result.content[0]).toEqual({
		type: "text",
		text: "User answers:\n1. Question: Which runtime should we use?\n   Answer: Custom stack",
	});
	expect(result.details).toEqual({
		status: "answered",
		questions: [
			{
				header: "Q1",
				question: "Which runtime should we use?",
				options: ["Bun"],
			},
		],
		answers: [
			{
				questionIndex: 0,
				header: "Q1",
				question: "Which runtime should we use?",
				answer: "Custom stack",
				wasCustom: true,
			},
		],
	});
});

test("does not use l like enter on the review screen", async () => {
	const tool = getTool();
	const result = await tool.execute(
		"call-3",
		{
			questions: [
				{
					header: "First",
					question: "Pick first",
					options: [{ label: "A", description: "First answer" }],
				},
				{
					header: "Second",
					question: "Pick second",
					options: [{ label: "B", description: "Second answer" }],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					component.handleInput("l");
					component.handleInput("l");
					expect(submitted).toBeUndefined();
					component.handleInput("\r");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	expect(result.content[0]).toEqual({
		type: "text",
		text: "User answers:\n1. Question: Pick first\n   Answer: A\n\n2. Question: Pick second\n   Answer: B",
	});
	const details = result.details as {
		status: string;
		answers: Array<{ answer: string }>;
	};
	expect(details.status).toBe("answered");
	expect(details.answers.map((answer) => answer.answer)).toEqual(["A", "B"]);
});

test("rerenders cached TUI lines when the available width changes", async () => {
	const tool = getTool();
	const question = "A question that fits when the terminal is wide";
	let narrow: string[] = [];
	let wide: string[] = [];

	await tool.execute(
		"call-width-cache",
		{
			questions: [
				{
					question,
					options: [{ label: "Ship it" }],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					narrow = component.render(24);
					wide = component.render(80);
					component.handleInput("\r");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	const normalizedNarrow = narrow.join(" ").replace(/\s+/g, " ").trim();

	expect(normalizedNarrow).toContain(question);
	expect(narrow.some((line) => line.includes(question))).toBe(false);
	expect(wide.some((line) => line.includes(question))).toBe(true);
});

test("wraps long questions in the TUI instead of truncating them", async () => {
	const tool = getTool();
	const longQuestion =
		"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda MU_SENTINEL omega";
	let rendered: string[] = [];
	await tool.execute(
		"call-4",
		{
			questions: [
				{
					question: longQuestion,
					options: [{ label: "Ship it" }],
				},
			],
		},
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				async custom(factory: unknown) {
					let submitted: unknown;
					const component = (
						factory as (
							tui: { requestRender: () => void },
							theme: ReturnType<typeof createTheme>,
							keybindings: unknown,
							done: (value: unknown) => void,
						) => RenderableComponent
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					rendered = component.render(24);
					component.handleInput("\r");
					return submitted;
				},
			},
		} as ExtensionContext,
	);

	const normalized = rendered.join(" ").replace(/\s+/g, " ").trim();
	expect(normalized).toContain(longQuestion);
	expect(normalized).toContain("MU_SENTINEL");
	expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
});
