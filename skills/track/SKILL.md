---
name: track
description: Use when the user gives a new instruction or changes an earlier one while other work is in progress, so the instruction is kept on the board instead of replacing the current task.
---

Keep the board in step with the work.

- When the user gives a new instruction or changes an old one mid-task, capture it as a card with the `board_add` tool instead of dropping the current task. Say in one line that you noted it.
- Move cards with the `board_update` tool as work changes: `in_progress` when you start, `review` when it needs the user's check, `blocked` when you cannot continue, `done` when it finishes.
- At natural stopping points, call the `board_list` tool to pick up cards the user added on the web page.
- Never mark a card done that you have not verified.
