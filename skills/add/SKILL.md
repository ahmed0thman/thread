---
name: add
description: Add a task, idea or milestone to the project's kanban board without acting on it.
argument-hint: "[--milestone] [--parent <id>] the task or idea"
---

Call the `board_add` tool for the task or idea in the arguments.

- `title`: a short title.
- `note`: the detail the user gave, in their words.
- `kind`: `idea` when the user is musing or exploring, `task` otherwise. With `--milestone` in the arguments, `milestone`: a card that groups other cards.
- `parent`: the id of a milestone, with `--parent <id>`. Without `--parent`, when the user names a milestone in words, find it with `board_list` and use its id. A milestone cannot have a parent.

Flags may appear anywhere in the arguments. Remove them from the text. If the tool says the task board is off, pass that on and stop.

Confirm in one line with the card id, then return to the current work. Do not start working on the card.
