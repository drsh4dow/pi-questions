# pi-questions

Minimal Pi package that adds an opencode-lite `ask_questions` tool.

## What it does

- asks one or more structured questions in Pi's interactive TUI
- keeps the flow tight: `j/k` or arrows move, `h` goes back, `Enter` selects, `Esc` cancels
- supports single-choice options plus an optional custom answer
- uses a final review step for multi-question runs
- returns graceful non-error results for cancel and non-interactive sessions
- documents the extension code with TSDoc comments for quick maintenance

## Local development

This repo includes a project-local extension wrapper at `.pi/extensions/ask-questions.ts`, so Pi can pick it up and hot-reload it with `/reload` while you work in this project.

```bash
bun install
```

Then start Pi in this repo and run `/reload` after changes.

## Package shape

The package exposes the extension via `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/ask-questions.ts"]
  }
}
```

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
