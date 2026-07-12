import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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

function interactiveContext(
	interact: (component: RenderableComponent, submitted: () => unknown) => void,
): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			async custom(factory: unknown) {
				let submitted: unknown;
				const component = (
					factory as (
						tui: {
							requestRender: () => void;
							terminal: { rows: number };
						},
						theme: ReturnType<typeof createTheme>,
						keybindings: unknown,
						done: (value: unknown) => void,
					) => RenderableComponent
				)(
					{ requestRender() {}, terminal: { rows: 24 } },
					createTheme(),
					{},
					(value) => {
						submitted = value;
					},
				);

				interact(component, () => submitted);
				return submitted;
			},
		},
	} as ExtensionContext;
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
						header: { minLength?: number; maxLength?: number };
						question: { minLength?: number; maxLength?: number };
						allowCustom?: unknown;
						options: {
							items: {
								properties: {
									label: { minLength?: number; maxLength?: number };
									description: {
										minLength?: number;
										maxLength?: number;
									};
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
	expect(promptGuidelineText).toContain("question concise");
	expect(promptGuidelineText).toContain("recommended option first");
	expect(promptGuidelineText).not.toContain("planning");
	expect(questions.minItems).toBe(1);
	expect(questions.maxItems).toBe(6);
	expect(questionProps.header.minLength).toBe(1);
	expect(questionProps.question.minLength).toBe(1);
	expect(optionProps.label.minLength).toBe(1);
	expect(optionProps.description.minLength).toBe(1);
	expect(questionProps.header.maxLength).toBeUndefined();
	expect(questionProps.question.maxLength).toBeUndefined();
	expect(optionProps.label.maxLength).toBeUndefined();
	expect(optionProps.description.maxLength).toBeUndefined();
	expect(questionProps.question).toMatchObject({
		description: expect.stringContaining("aim for 120 characters"),
	});
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
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
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
		interactiveContext((component) => {
			component.handleInput("\u001b");
		}),
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
		interactiveContext((component) => {
			component.handleInput("j");
			component.handleInput("l");
		}),
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
		interactiveContext((component) => {
			component.handleInput("j");
			component.handleInput("l");
			for (const char of "Custom stack") {
				component.handleInput(char);
			}
			component.handleInput("\r");
		}),
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

test("keeps the custom editor open when the answer is blank", async () => {
	const tool = getTool();
	let rendered: string[] = [];
	const result = await tool.execute(
		"call-blank-custom",
		{
			questions: [
				{
					question: "Which runtime should we use?",
					options: [{ label: "Bun" }],
				},
			],
		},
		undefined,
		undefined,
		interactiveContext((component) => {
			component.handleInput("j");
			component.handleInput("l");
			component.handleInput("\r");
			rendered = component.render(80);
			expect(() => component.render(2)).not.toThrow();
			component.handleInput("\u001b");
			component.handleInput("\u001b");
		}),
	);

	expect(rendered.join("\n")).toContain("Type answer");
	expect(result.details).toMatchObject({ status: "cancelled" });
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
		interactiveContext((component, submitted) => {
			component.handleInput("l");
			component.handleInput("l");
			expect(submitted()).toBeUndefined();
			component.handleInput("\r");
		}),
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
		interactiveContext((component) => {
			narrow = component.render(24);
			wide = component.render(80);
			component.handleInput("\r");
		}),
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
		interactiveContext((component) => {
			rendered = component.render(24);
			component.handleInput("\r");
		}),
	);

	const normalized = rendered.join(" ").replace(/\s+/g, " ").trim();
	expect(normalized).toContain(longQuestion);
	expect(normalized).toContain("MU_SENTINEL");
	expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
});
