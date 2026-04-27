# pi-questions

[![npm version](https://img.shields.io/npm/v/pi-questions.svg)](https://www.npmjs.com/package/pi-questions)
[![CI](https://github.com/drsh4dow/pi-questions/actions/workflows/ci.yml/badge.svg)](https://github.com/drsh4dow/pi-questions/actions/workflows/ci.yml)

One Pi tool for asking the user.

Sometimes Pi needs input from the user. The user - yes, you - does not want to type it into chat. This is the tool for that.

## Install

```bash
pi install npm:pi-questions
```

## What it does

`pi-questions` adds `ask_questions`.

The tool opens a small TUI flow, asks one or more questions, and returns the answers as structured data.

Each question can have short options. A custom answer is always available.

## Behavior

- asks questions in the interactive TUI
- supports selectable options
- always includes `Write your own answer`
- supports a review step for multiple questions
- returns normal results for cancel and non-interactive sessions

## Controls

- `j/k` or arrows: move
- `1-9`: pick option
- `Enter`: select or submit
- `h/←`: back
- `l`: select
- `Esc`: cancel
