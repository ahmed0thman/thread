---
name: board
description: Show the project's kanban board and its local web address, the report for one milestone with --parent, or stop the board web page with --stop.
argument-hint: "[--stop] [--parent <id>]"
---

If the arguments contain `--stop`: call the `board_stop` tool, pass on what it returns, and do nothing else.

Otherwise:

1. Call the `board_list` tool. If the arguments contain `--parent <id>`, pass that id as `parent`: the answer is then the report for that milestone, and you show it instead of the full board.
2. Call the `board_open` tool.
3. Show the cards grouped by stage, using the stage names `board_list` returns, one line per card with its id and title. Keep a card's milestone tag and lane (`{lane: name}`), and a milestone's progress. Flag cards the user added on the web page, and keep a card's `(N waiting)`: those are items waiting for the user, which `wait_list` reads.
4. Give the board URL. If the tool says the board is unavailable, say so.

Do not change any card. When the user asks you to delegate a card's work to a sub-agent, start the Agent call's `description` with the card id in brackets, for example `[c12] fix the rounding`: the card's page on the board then shows that run.
