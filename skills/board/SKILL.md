---
name: board
description: Show the project's kanban board and its local web address, the report for one milestone with --parent, open the board to your phone through a tunnel with --tunnel, or stop the board web page with --stop.
argument-hint: "[--stop] [--parent <id>] [--tunnel [stop]]"
---

If the arguments contain `--stop`: call the `board_stop` tool, pass on what it returns, and do nothing else.

If the arguments contain `--tunnel stop`: call the `board_open` tool with `tunnel` set to `stop`, pass on what it returns, and do nothing else.

Otherwise:

1. Call the `board_list` tool. If the arguments contain `--parent <id>`, pass that id as `parent`: the answer is then the report for that milestone, and you show it instead of the full board.
2. Call the `board_open` tool (it opens the browser). If the arguments contain `--tunnel` (without `stop`), pass `tunnel` set to `start`. Opening the remote link puts the board on the internet, so it is never opened on the first call: `board_open` answers "CONFIRMATION REQUIRED" with a `confirm_code` and opens nothing (a link that is already open is shown without a code). Show the user, in your own words, what the answer says the link can read and do, and ask whether to open it. Call `board_open` again with `tunnel` set to `start` and the `confirm_code` only after they agree; if they decline, stop there. A side thread cannot use `tunnel`.
3. Show the cards grouped by stage, using the stage names `board_list` returns, one line per card with its id and title. Keep a card's milestone tag and lane (`{lane: name}`). Milestones have no stage: show them in their own "Milestones" list, as `board_list` returns them, with their state (empty, open or done) and progress. Flag cards the user added on the web page, and keep a card's `(N waiting)`: those are items waiting for the user, which `wait_list` reads.
4. `board_open` opens the board in the user's browser itself and returns the board address without the access token. Show the address it returns, on a line of its own, as it is: never add a token or look for one (the link with the token is in a file the tool names, for the user only). If the tool says it could not open a browser, say so and name the file it gives. If the user only wants the address, call `board_open` with `open` set to `false` and nothing is opened. If the tool says the board is unavailable, say so.
5. With `--tunnel`, once the link is open: say when it expires and what the link allows, in the tool's own words, and that the link is on the board page (the "Phone link" item in the top bar, with a Copy button) and in the file the tool names, for the user only. You are not given the remote link and never ask for it or look for it. If the tool says cloudflared is not installed, or that the board is served by an older plugin version, pass that message on as it is instead.

Do not change any card. When the user asks you to delegate a card's work to a sub-agent, start the Agent call's `description` with the card id in brackets, for example `[c12] fix the rounding`: the card's page on the board then shows that run.
