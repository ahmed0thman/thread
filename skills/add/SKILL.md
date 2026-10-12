---
name: add
description: Add a task or idea to the project's kanban board without acting on it.
argument-hint: the task or idea
---

Call the `board_add` tool for the task or idea in the arguments.

- `title`: a short title.
- `note`: the detail the user gave, in their words.
- `kind`: `idea` when the user is musing or exploring, `task` otherwise.

Confirm in one line with the card id, then return to the current work. Do not start working on the card.
