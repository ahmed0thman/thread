---
name: track
description: Use when the user gives a new instruction or changes an earlier one while other work is in progress, so it is kept on the board; also when you finish work that needs the user to check it, have a question for them, or need them to do something, so it is raised as a waiting item.
---

Keep the board in step with the work.

- When the user gives a new instruction or changes an old one mid-task, capture it as a card with the `board_add` tool instead of dropping the current task. Say in one line that you noted it.
- Move cards with the `board_update` tool as work changes. The stage ids come from `board_list` (a board can have its own stages): the stage for work in progress when you start, the stage for the user's check when it needs that, the blocked stage when you cannot continue, the done stage when it finishes.
- When the work belongs to a milestone, add the card under it with `parent` (find the milestone with `board_list`).
- At natural stopping points, call the `board_list` tool to pick up cards the user added on the web page.
- Whenever you hand the work of a card to a sub-agent (the Agent tool), start the call's `description` with the card id in brackets, for example `[c12] fix the rounding`. The board then shows that agent's prompt, live steps and report on the card's page. A delegation without the marker shows nothing there.
- When you finished work that needs the user's check (`review`), have a question (`question`, or `choice` with 2 to 8 options), or need the user to do something themselves (`todo`), record it on the card for that work with the `wait_add` tool (add a card first with `board_add` when there is none). The board then shows it under "Waiting for you". In the chat give only a one-line pointer such as "Waiting on you: c37.w2", not the whole question again. The answer reaches you, and only you, with the user's next message here as a line starting "The user answered c37.w2 on the board"; act on it. When the user answers in the chat instead, call `wait_close` with `answered_in_chat`; call it with `withdraw` when you no longer need the answer. `wait_list` reads an item when the user asks "what is c37.w2?". An item does not move the card: move it yourself when the work moves. This is not available when the task board is off.
- When you record work with `board_add`, `board_update` or `wait_add`, pass `worker` so the card shows who did it: `main` from the main session, `agent:<type>` from a sub-agent, `thread:<id>` from a side thread, or `lane:<name>` from a lane run. A `board_update` that changes nothing but `worker` is noted in the card's history.
- Acceptance criteria you add to a card can later only be extended by you, never removed or reworded; only the user can on the board. A card with criteria moves to done only after the user approves a review item on it, and a card moved back out of done needs a new approval.
- Never mark a card done that you have not verified.
