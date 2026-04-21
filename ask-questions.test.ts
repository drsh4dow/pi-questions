import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

import askQuestionsExtension from "./extensions/ask-questions.ts";

type AskQuestionsTool = Parameters<ExtensionAPI["registerTool"]>[0];

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

test("registers a planning-first ask_questions tool with tight schema limits", () => {
	const tool = getTool();
	const questions = (
		tool.parameters as unknown as {
			properties: { questions: { minItems?: number; maxItems?: number } };
		}
	).properties.questions;

	expect(tool.name).toBe("ask_questions");
	expect(tool.label).toBe("Ask Questions");
	expect(tool.executionMode).toBe("sequential");
	expect(tool.description).toContain("Prefer this over free-form chat");
	expect(tool.promptSnippet).toContain("unblock planning or implementation");
	expect(tool.promptGuidelines).toContain(
		"When planning, ask this tool first for missing requirements, tradeoffs, constraints, or preferences before finalizing the plan.",
	);
	expect(tool.promptGuidelines).toContain(
		"If you are about to ask the user a question in natural language, strongly prefer this tool instead.",
	);
	expect(questions.minItems).toBe(1);
	expect(questions.maxItems).toBe(6);
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
				allowCustom: true,
			},
		],
		answers: [],
	});
});

test("uses j to move while l does not submit", async () => {
	const tool = getTool();
	const result = await tool.execute(
		"call-2",
		{
			questions: [
				{
					question: "Pick one",
					options: [
						{ label: "First", description: "First option" },
						{ label: "Second", description: "Second option" },
					],
					allowCustom: false,
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
						) => { handleInput: (data: string) => void }
					)({ requestRender() {} }, createTheme(), {}, (value) => {
						submitted = value;
					});

					component.handleInput("j");
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
		text: 'User answers: "Pick one"="Second".',
	});
	expect(result.details).toEqual({
		status: "answered",
		questions: [
			{
				header: "Q1",
				question: "Pick one",
				options: ["First", "Second"],
				allowCustom: false,
			},
		],
		answers: [
			{
				questionIndex: 0,
				header: "Q1",
				question: "Pick one",
				answer: "Second",
				wasCustom: false,
				optionIndex: 2,
			},
		],
	});
});
