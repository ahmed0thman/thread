---
name: add
description: Add a task, idea or milestone to the project's kanban board without acting on it.
argument-hint: "[--milestone] [--parent <id>] [--lane <name>] the task or idea"
---

Call the `board_add` tool for the task or idea in the arguments.

- `title`: a short title.
- `note`: the detail the user gave, in their words.
- `kind`: `idea` when the user is musing or exploring, `task` otherwise. With `--milestone` in the arguments, `milestone`: a card that groups other cards.
- `parent`: the id of a milestone, with `--parent <id>`. Without `--parent`, when the user names a milestone in words, find it with `board_list` and use its id. A milestone cannot have a parent.
- `lane`: the name of a delegation lane, with `--lane <name>`. Only a task or idea can have one. You may also set a lane yourself when the user or the project's instructions say which lane suits the work; otherwise leave it out. A card with a lane runs on that lane when it is started as a thread from the board (**Start as thread**); no tool starts an existing card as a thread, and `/thread:new --lane <name>` starts a new thread card on a lane instead. So only set a lane on a card when the work should run there. If the tool refuses the lane (unknown name, not approved, or no delegate skills), pass its message on and ask whether to add the card without a lane.

Flags may appear anywhere in the arguments. Remove them from the text. If the tool says the task board is off, pass that on and stop.

Confirm in one line with the card id, then return to the current work. Do not start working on the card.
