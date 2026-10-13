---
name: board
description: Show the project's kanban board and its local web address, or stop the board web page with --stop.
argument-hint: "[--stop]"
---

If the arguments contain `--stop`: call the `board_stop` tool, pass on what it returns, and do nothing else.

Otherwise:

1. Call the `board_list` tool.
2. Call the `board_open` tool.
3. Show the cards grouped by status (Idea, New, In progress, Review, Blocked, Done), one line per card with its id and title. Flag cards the user added on the web page.
4. Give the board URL. If the tool says the board is unavailable, say so.

Do not change any card.
