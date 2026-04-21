# pi-questions

[![npm version](https://img.shields.io/npm/v/pi-questions.svg)](https://www.npmjs.com/package/pi-questions)

Minimal Pi package that adds a structured `ask_questions` tool.

## Install

```bash
pi install npm:pi-questions
```

## Philosophy

Small, obvious, boring.

This package gives Pi one compact way to ask users structured questions in a TUI. The stable contract is the bounded schema and interaction flow. Prompt copy stays intentionally small and tunable.

## Non-goals

- survey engine
- workflow builder
- forms platform
- feature growth that adds more surface area than it removes

## What it does

- asks one or more structured questions in Pi's interactive TUI
- supports single-choice options plus an optional custom answer
- uses a final review step for multi-question runs
- returns graceful non-error results for cancel and non-interactive sessions

## Tool shape

`ask_questions` accepts a small ordered list of questions. Each question has:

- `question`: full prompt shown to the user
- `header?`: short review/progress label
- `options`: short concrete choices
- `allowCustom?`: whether to add `Write your own answer`

Example:

```ts
{
  questions: [
    {
      header: "Stack",
      question: "Which stack should we use?",
      options: [
        { label: "Bun + TypeScript (Recommended)", description: "Smallest path" },
        { label: "Node + TypeScript", description: "Use the more common runtime" }
      ]
    }
  ]
}
```
