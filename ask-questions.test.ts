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

test("registers the ask_questions tool with tight schema limits", () => {
	const tool = getTool();
	const questions = (
		tool.parameters as unknown as {
			properties: { questions: { minItems?: number; maxItems?: number } };
		}
	).properties.questions;

	expect(tool.name).toBe("ask_questions");
	expect(tool.label).toBe("Ask Questions");
	expect(tool.executionMode).toBe("sequential");
	expect(tool.promptSnippet).toContain("structured questions");
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
