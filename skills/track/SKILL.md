---
name: track
description: Use when the user gives a new instruction or changes an earlier one while other work is in progress, so the instruction is kept on the board instead of replacing the current task.
---

Keep the board in step with the work.

- When the user gives a new instruction or changes an old one mid-task, capture it as a card with the `board_add` tool instead of dropping the current task. Say in one line that you noted it.
- Move cards with the `board_update` tool as work changes. The stage ids come from `board_list` (a board can have its own stages): the stage for work in progress when you start, the stage for the user's check when it needs that, the blocked stage when you cannot continue, the done stage when it finishes.
- When the work belongs to a milestone, add the card under it with `parent` (find the milestone with `board_list`).
- At natural stopping points, call the `board_list` tool to pick up cards the user added on the web page.
- Never mark a card done that you have not verified.
