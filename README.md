# thread

Side threads for Claude Code, with a kanban board.

While Claude is busy on one task, you often think of something else: a question that needs real digging, a doubt about the plan, an idea for later. Asking it in the same session derails the work. Opening a new session loses the context you have built up.

`thread` gives you a third option. A **thread** is a background copy of your current session. It knows everything the session knew at that moment, it has tools, and it works on its own task while the main session carries on. Nothing it does enters the main session until you ask for its report.

The plugin also keeps a **board** of tasks, ideas and threads for each project, shown on a local web page where you can read a thread's conversation, see what it did step by step, and send it follow-ups.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Use cases](#use-cases)
- [Commands](#commands)
- [The board](#the-board)
- [How threads work](#how-threads-work)
- [Several sessions and projects](#several-sessions-and-projects)
- [Security](#security)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Install

Requirements:

- Claude Code, with the standalone `claude` CLI on your `PATH`. Threads are started by running that CLI in the background, so the IDE extension alone is not enough.
- Node 20 or newer. It has only been run on Node 24.

```bash
claude plugin marketplace add ahmed0thman/thread
claude plugin install thread@thread-marketplace
```

Restart Claude Code, or reload the editor window, so the plugin loads. It then works in the terminal and in the IDE extension's chat panel. It has not been tested in the Claude Desktop app.

To update later:

```bash
claude plugin marketplace update thread-marketplace
claude plugin update thread@thread-marketplace
```

To try it from a clone without installing: `claude --plugin-dir <path to this folder>`.

## Quick start

```text
/thread:new check whether our retry logic can double-charge a customer
```

Claude replies with a card id, for example `c4`, and goes back to what it was doing. The thread runs in the background.

On your next message, Claude is told when the thread has finished. Then:

```text
/thread:report c4
```

The thread's digest appears under four headings, **Happened**, **Decided**, **Changed** and **Open**, and becomes part of the main session's context. To look without pulling anything into the main session, open the board:

```text
/thread:board
```

## Use cases

### 1. A side question that needs real work

You are halfway through a refactor and wonder whether a library you depend on has a known problem. Asking in the main session would interrupt the refactor and fill its context with search results.

```text
/thread:new find out whether pg-boss has open issues about jobs being lost on failover, and whether Graphile Worker handles that case better. Cite what you find.
```

The thread can search the web and read the project. The main session keeps refactoring. When the thread finishes:

```text
/thread:report c7
```

```text
## Happened
- Read the pg-boss and Graphile Worker issue trackers and both projects' docs on failover.
- Found two open pg-boss issues describing jobs left in "active" after a primary failover.

## Decided
- Graphile Worker's locking makes the lost-job case less likely, but neither tool removes the need for idempotent jobs.

## Changed
- Nothing; this thread was read-only.

## Open
- Neither project documents behaviour under a network partition. Worth a test before choosing.
```

Only this digest enters the main session, not the pages the thread read.

### 2. A second opinion on the plan you are in the middle of

Because a thread starts with the whole conversation, you do not have to explain the plan again.

```text
/thread:new review the migration plan we just agreed. Look for steps that cannot be rolled back and for anything that assumes the old column still exists. Be critical.
```

Carry on implementing. Report when the thread is done, or read it on the board first and decide whether the main session needs to hear it at all.

### 3. Investigating something unrelated while work continues

A failing test catches your eye, but it is not what you are working on.

```text
/thread:new the test "sync resumes after a dropped connection" fails about one run in five. Find out why. Do not fix it; tell me the cause and the smallest fix.
```

The thread reads and runs what your permission rules already allow. Later you can ask it for more without restarting:

```text
/thread:continue c9 does the same race exist in the upload path?
```

A follow-up keeps the thread's own history, so it builds on what it already found.

### 4. Parking instructions and ideas without interrupting

Mid-task you remember two things. Neither should replace what Claude is doing.

```text
/thread:add rename the "moderator" role to "agent" across the app once this ships
/thread:add idea: let users snooze a conversation until a set time
```

Each becomes a card on the board. Claude confirms in a line and returns to its work. You can also add cards on the board page itself; Claude is told about them on your next message and picks them up at a natural stopping point.

During longer work Claude uses the board on its own to keep track of instructions you give or change along the way, moving cards through In progress, Review, Blocked and Done.

### 5. Handing a contained change to a thread

Threads are read-only unless you say otherwise. When you explicitly ask a thread to change files, it runs in write mode:

```text
/thread:new in write mode: add unit tests for parseHandback covering a reply with no headings and a broken step map. Do not touch other files.
```

A write-mode thread edits the same working tree as the main session, at the same time. Give it work that does not overlap with what the main session is editing, and review its changes like any others.

### 6. Comparing with another repository or folder

A thread can read the project. To let it read somewhere else, name the folder in the task and Claude grants the thread that folder only:

```text
/thread:new compare our webhook handler with the one in /Users/me/code/billing-service and list what theirs validates that ours does not
```

### 7. Talking to a thread from the board

Open the board with `/thread:board` and click a thread card. The thread opens full-window: its conversation in the centre with a message box, its ids, digest and decisions on the left, and a step-by-step trace on the right. Type a follow-up there and the thread runs another turn. This is the way to read or continue a thread without putting anything into the main session.

### 8. Several sessions in one project

You have two Claude sessions open in the same project. Session A started thread `c3`. In session B you type `/thread:report c3` by mistake.

Nothing is reported. Claude Code's question popup appears, headed "Wrong session", naming the session that started the thread and the one you are in, with **Cancel (Recommended)** and **Report here**. The digest is handed over only if you choose to report there.

## Commands

| Command | What it does |
|---|---|
| `/thread:new <task>` | Start a thread on the task. Read-only unless you ask for it to change files. |
| `/thread:continue <id> <message>` | Send a follow-up to a finished thread. |
| `/thread:report [id]` | Pull a thread's digest into this session. With no id, picks the one unreported thread this session started. |
| `/thread:status` | List threads with their state, turns, reported status and who started them. |
| `/thread:end <id>` | End a thread, stopping it if it is running, and mark its card done. |
| `/thread:board` | List the cards and print the board link. |
| `/thread:add <task or idea>` | Add a card without acting on it. |

Thread states map to board columns: running is **In progress**, finished is **Review**, failed is **Blocked**, ended is **Done**.

## The board

`/thread:board` prints a link such as `http://127.0.0.1:47800/?t=<token>#/<project>`.

- **One board for every project.** Each project has a tab, with a dot when one of its threads is running. A project whose folder was deleted is shown read-only and can be forgotten, which removes its saved cards and logs.
- **Cards** show their id, kind and title. Thread cards also show their state, the number of turns, the session that started them, and a **Not reported** tag when they hold a result the main session has not pulled.
- **Toolbar:** search by id, title or note; show threads only; filter by the session that started them; add a card. A button in the header switches between light and dark.
- **Task and idea cards** open in a side panel where you edit the title, note and status. Drag a card to another column to move it.
- **Thread cards** open full-window:
  - **Centre:** the conversation, and a box to send a follow-up.
  - **Left:** the thread's session id, the session that started it, a `claude --resume <id>` command that opens the thread as a normal conversation in a terminal, the latest digest, and every decision across turns. The report command has a copy button.
  - **Right:** the trace, a timeline of what the thread did, labelled Did, Found, Decided, Changed and Open, with file references. Clicking a step scrolls the conversation to that turn.
- **Keys:** `/` focuses search, `n` adds a card, `Esc` closes a panel.

## How threads work

- **Context.** A thread starts as a copy of the session at that moment. It does not see anything the main session does afterwards, and neither do its follow-ups: a follow-up resumes the thread's own copy. It does see files as they are on disk when it reads them. Continue a thread for the same task; start a new one for a new task.
- **Hand-back.** A thread never writes into the main session. Each of its replies ends with the four-heading digest and an ordered step map. `/thread:report` gives the digest to the main session; the step map is only drawn on the board.
- **Reported status.** A thread counts as reported once the session that started it has pulled its newest result. A follow-up that produces a new result makes it "not reported" again. A follow-up that fails leaves it as it was.
- **Announcements.** When a thread finishes, the session that started it is told on your next message, not in the middle of a turn.
- **Read and write.** Read mode blocks the Edit, Write and NotebookEdit tools. It does not sandbox the thread: shell commands and MCP tools you have already allowed can still change things. Write mode allows edits in the shared working tree.
- **Permissions.** A thread runs headless, so it cannot answer a permission prompt. Anything that would prompt is refused, except web search and web fetch, which are pre-approved, and folders you named in the task.
- **Cost and time.** Every thread turn is a full model call over the whole conversation, so a thread started late in a long session costs accordingly. A turn is stopped after 20 minutes.
- **Limits on threads.** A thread cannot start, continue, report or end threads.

## Several sessions and projects

- Each project has its own cards. Sessions in one project share them.
- Reporting or ending a thread from a session that did not start it asks for confirmation first.
- Thread cards are labelled with the name of the session that started them: Claude Code's title for the session, otherwise the start of its first message, otherwise a short id.

## Security

- **Web access is pre-approved for threads, with no prompt per site.** A thread holds your whole conversation and can read the project, so a malicious page could try to talk it into sending that content somewhere. If that matters for your project, set `THREAD_ALLOW_TOOLS=none`.
- **The board is local.** It listens on `127.0.0.1` only, checks the request's host and origin, and requires the access token that is in the link from `/thread:board`. The token is stored in `board.token` in the data directory, readable only by you.
- **Read mode is not a sandbox**, as described above.
- **Thread and card contents are stored unencrypted** in the data directory, including each thread's replies.

## Configuration

Set these in your shell, or under `env` in `~/.claude/settings.json`.

| Variable | Meaning |
|---|---|
| `THREAD_ALLOW_TOOLS` | Tools pre-approved for threads, comma separated. Default `WebSearch,WebFetch`. `none` pre-approves nothing. |
| `THREAD_TIMEOUT_MS` | Longest a single thread turn may run. Default `1200000` (20 minutes). |
| `THREAD_BOARD_PORT` | First port the board tries. Default `47800`; up to 20 ports from there. |
| `THREAD_NO_HTTP` | Set to `1` to run without the board page. |
| `THREAD_DATA_DIR` | Where cards, thread results and logs are kept. Default is the plugin's data directory, otherwise `~/.claude/thread-data`. |
| `THREAD_LOCK_WAIT_MS` | How long to wait for the state lock. Default `5000`. |
| `THREAD_CLAUDE_BIN` | Binary to run in place of `claude`. Used by the tests. |

Set by the plugin itself, not by you: `THREAD_PROJECT_DIR` (the project a server belongs to) and `THREAD_DEPTH` (marks a thread's own process). `CLAUDE_CODE_SESSION_ID` is used as a fallback when a tool call carries no session id.

State is one file per project: `<data dir>/projects/<key>/state.json`, with each thread's raw output beside it in `logs/`.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| A thread fails with "claude CLI not found on PATH" | The standalone CLI is not installed or not on `PATH` for Claude Code. Install it and restart. |
| A thread fails with "No conversation found with session ID" | The session it was started from no longer exists, for example after its history was cleared. Start the thread again from the current session. |
| A thread reports that a tool was refused | It needed a permission prompt it could not answer. Allow the tool in your Claude Code permission rules, add it to `THREAD_ALLOW_TOOLS`, or name the folder it needs in the task. |
| The board says it needs its access link | The link was opened without its token, or from an old bookmark. Run `/thread:board` and open the link it prints. |
| `/thread:report` lists threads instead of reporting | This session started none or several unreported threads. Pass the id. |
| A thread shows "running" for a long time | Check its card on the board. A thread whose process died is marked failed the next time the board or a command looks at it. |
| A finished thread was not announced | Announcements arrive with your next message to the session that started the thread. |

## Development

No dependencies and no build step: plain Node ES modules.

```text
.claude-plugin/     plugin and marketplace manifests
hooks/, scripts/    session-start and prompt hooks
skills/             the slash commands
server/
  state.mjs         paths, the state file and its lock
  sessions.mjs      session names
  core.mjs          cards, threads, the wrong-session guard, project listing
  runner.mjs        the detached process that runs one thread turn
  mcp.mjs           the MCP server and its tools
  http.mjs          the board server
  board.html        the board page
test/               node:test suites, with a stub in place of the claude CLI
```

```bash
node --test test/*.test.mjs
claude plugin validate .
```

## License

MIT.
