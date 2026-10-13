# thread

Side threads for Claude Code, with a kanban board.

While Claude is busy on one task, you often think of something else: a question that needs real digging, a doubt about the plan, an idea for later. Asking it in the same session derails the work. Opening a new session loses the context you have built up.

`thread` gives you a third option. A **thread** is a background Claude session with its own tools that works on one task while the main session carries on. Claude gives it a short **brief** of what it needs from your conversation, so it starts cheap, and picks a sub-agent or model that suits how hard the task is. If the task needs everything said so far, a thread can instead be a **full copy** of the session. Nothing it does enters the main session until you ask for its report.

The plugin also keeps a **board** of tasks, ideas and threads for each project, shown on a local web page where you can read a thread's conversation, see what it did step by step, and send it follow-ups.

![The board: tasks, ideas and threads in six columns, with each thread's state, tokens and agent](docs/board.png)

![A thread opened full-window: its details and brief on the left, the conversation in the centre, the step-by-step trace on the right](docs/thread.png)

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
- [What's new](#whats-new)
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

By default the thread does not get your whole conversation. Claude writes it a brief from what you typed, which keeps it cheap. Claude also picks what runs the thread by how hard the task is: a cheaper sub-agent or model for simple work, the session's own model for work that needs judgment. Flags change these defaults:

```text
/thread:new --full ...           copy the whole session into the thread
/thread:new --agent worker ...   run the thread as this sub-agent
/thread:new --model haiku ...    run the thread on this model
/thread:new --write ...          let the thread edit files
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

Claude puts the plan's decisions and the file paths into the thread's brief, so you do not have to explain the plan again. If the plan is spread over a long conversation and a brief would lose too much, add `--full` to give the thread the whole session.

```text
/thread:new review the migration plan we just agreed. Look for steps that cannot be rolled back and for anything that assumes the old column still exists. Be critical.
/thread:new --full review the migration plan, including the options we rejected earlier
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
/thread:new --write add unit tests for parseHandback covering a reply with no headings and a broken step map. Do not touch other files.
```

A write-mode thread edits the same working tree as the main session, at the same time. Give it work that does not overlap with what the main session is editing, and review its changes like any others.

### 6. Comparing with another repository or folder

A thread can read the project. To let it read somewhere else, name the folder in the task and Claude grants the thread that folder only:

```text
/thread:new compare our webhook handler with the one in /Users/me/code/billing-service and list what theirs validates that ours does not
```

### 7. Talking to a thread from the board

Open the board with `/thread:board` and click a thread card. The thread opens full-window: its conversation in the centre with a message box, its ids, digest and decisions on the left, and a step-by-step trace on the right. Type a follow-up there and the thread runs another turn. While a turn runs, the conversation shows what the thread is doing as it happens: its messages and each tool it uses. This is the way to read or continue a thread without putting anything into the main session.

A task or idea card can become a thread from there too. Open the card, press **Start as thread**, and choose the session it reports to, Brief or Full copy, and an agent. When it has finished, **Report to main session** queues its digest for your next message in that session.

### 8. Several sessions in one project

You have two Claude sessions open in the same project. Session A started thread `c3`. In session B you type `/thread:report c3` by mistake.

Nothing is reported. Claude Code's question popup appears, headed "Wrong session", naming the session that started the thread and the one you are in, with **Cancel (Recommended)** and **Report here**. The digest is handed over only if you choose to report there.

### 9. Keeping a thread cheap: a brief, and a model that fits the task

A thread pays for its context again on every step it takes, so what it starts with matters more than what it writes. In one long session, threads that were full copies re-read 1.35 to 2.86 million input tokens each. A brief thread in the same project used about 91 thousand for a small task.

So the default is the brief. You type what you need, and Claude writes the thread the goal, the decisions and constraints that apply, the file paths and what was already ruled out:

```text
/thread:new check that every handoff trigger in section 12 of the plan has a test
```

Routine work does not need the main session's model, and you do not have to say so. Claude is already writing the brief, so it also chooses what runs the thread, at no extra cost:

- If you have sub-agents in `.claude/agents/`, it picks the cheapest one whose description fits the task. The thread then runs with that agent's model, effort and instructions.
- If you have none, it picks a model: `haiku` for lookups and mechanical work, `sonnet` for routine, well-specified work.
- For judgment, design or review, when it is unsure, and with `--full`, it keeps the session's own model and effort.

Claude tells you what it chose and why, for example "c7 is running as `worker-high`, the cheapest agent whose description covers reading and listing files". The choice is only as good as your agents' descriptions, so say in each one what it is for. To decide yourself, name the agent or the model:

```text
/thread:new --agent haiku-coder list every file that still mentions the old env variable API_HOST
/thread:new --model opus --effort high review the retry logic for double charges
```

Use `--full` only when a brief would lose too much, for example a judgment that depends on a long discussion:

```text
/thread:new --full which of the options we rejected today should we reconsider, and why
```

Each thread's token use is shown on its card and in `/thread:status`, so you can see what a thread cost.

## Commands

| Command | What it does |
|---|---|
| `/thread:new [--full] [--agent <name>] [--model <name>] [--effort <level>] [--write] <task>` | Start a thread on the task. By default it gets a brief written by Claude, runs on an agent or model Claude picks for the task, and cannot edit files. `--full` copies the whole session instead, `--agent` or `--model` (with an optional `--effort`) sets what runs it, `--write` lets it edit files. |
| `/thread:continue <id> <message>` | Send a follow-up to a finished thread. |
| `/thread:report [id]` | Pull a thread's digest into this session. With no id, picks the one unreported thread this session started. |
| `/thread:status` | List threads with their state, context, agent or model, turns, tokens used, reported status and who started them. |
| `/thread:end <id>` | End a thread, stopping it if it is running, and mark its card done. |
| `/thread:board` | List the cards and print the board link. |
| `/thread:add <task or idea>` | Add a card without acting on it. |

```text
/thread:new --agent critic review the retry logic in src/queue.ts for double charges
/thread:new --full --write apply the rename we discussed to the billing module
```

Flags can go anywhere in the line. Thread states map to board columns: running is **In progress**, finished is **Review**, failed is **Blocked**, ended is **Done**.

## The board

`/thread:board` prints a link such as `http://127.0.0.1:47800/?t=<token>#/<project>`.

- **One board for every project.** Each project has a tab, with a dot when one of its threads is running. A project whose folder was deleted is shown read-only and can be forgotten, which removes its saved cards and logs.
- **Cards** show their id, kind and title. Thread cards also show their state, the number of turns, the session that started them, a **Not reported** tag when they hold a result the main session has not pulled, the tokens they have used, and their agent when they run as one.
- **Toolbar:** search by id, title or note; show threads only; filter by the session that started them; add a card. A button in the header switches between light and dark.
- **Task and idea cards** open in a side panel where you edit the title, note and status. Drag a card to another column to move it. **Start as thread** turns the card into a thread. You choose the session it reports to, **Brief** or **Full copy**, read-only or able to edit files, and an agent from your `.claude/agents/` (or "Same as session"). With Brief, the title is the task and the note is the brief, since nobody writes one on the board. With Full copy, the title and note are the task.
- **Thread cards** open full-window:
  - **Centre:** the conversation, and a box to send a follow-up. A running turn shows its steps as they happen. A finished turn folds them into one line with its duration and tokens, such as "6 steps · 3m 00s · 48k tokens".
  - **Left:** the thread's session id, the session that started it, a `claude --resume <id>` command that opens the thread as a normal conversation in a terminal, its context (Brief or Full copy), its agent or model and effort, the tokens used, the brief it was given, the latest digest, and every decision across turns. The report command has a copy button. **Report to main session** queues the report: it is delivered with your next message in the session that started the thread, and repeated until that session makes it.
  - **Right:** the trace, a timeline of what the thread did, labelled Did, Found, Decided, Changed and Open, with file references. Clicking a step scrolls the conversation to that turn.
- **Keys:** `/` focuses search, `n` adds a card, `Esc` closes a panel.

![Starting a card as a thread: session, Brief or Full copy, read-only or editing, and the agent](docs/start-as-thread.png)

![The board in the dark theme](docs/board-dark.png)

## How threads work

- **Context.** By default a thread starts a fresh session and knows only the brief and the task. It also loads the project's `CLAUDE.md` on its own, and sees files as they are on disk when it reads them. With `--full` it starts as a copy of the main session at that moment. Either way it does not see anything the main session does afterwards, and neither do its follow-ups: a follow-up resumes the thread's own session. Continue a thread for the same task; start a new one for a new task.
- **Model and effort.** With `/thread:new`, Claude chooses a sub-agent or a model by how hard the task is, unless you name one with `--agent` or `--model`. A thread with neither runs with the same model and effort as the main session, read from the session's transcript when it starts; if they cannot be found, the CLI's defaults apply. A named model does not inherit the session's effort; add `--effort` to set one. An agent brings its own model, effort and instructions, on every turn, and cannot be combined with `--model` or `--effort`. A thread started from the board is not chosen automatically: you pick an agent there, or "Same as session". Agents are the Markdown files in `.claude/agents/` of the project and in `~/.claude/agents/` (top level only; the project's wins on the same name).
- **Hand-back.** A thread never writes into the main session. Each of its replies ends with the four-heading digest and an ordered step map. `/thread:report` gives the digest to the main session; the step map is only drawn on the board.
- **Reported status.** A thread counts as reported once the session that started it has pulled its newest result. A follow-up that produces a new result makes it "not reported" again. A follow-up that fails leaves it as it was.
- **Announcements.** When a thread finishes, the session that started it is told on your next message, not in the middle of a turn.
- **Read and write.** Read mode blocks the Edit, Write and NotebookEdit tools. It does not sandbox the thread: shell commands and MCP tools you have already allowed can still change things. Write mode allows edits in the shared working tree.
- **Permissions.** A thread runs headless, so it cannot answer a permission prompt. Anything that would prompt is refused, except web search and web fetch, which are pre-approved, and folders you named in the task.
- **Cost and time.** Every thread turn is a model call over the thread's own conversation. Inside a turn, every step the thread takes sends that conversation again. A brief thread starts small. A full thread starts with the whole main session (after a compaction, with the summary and what followed), so one started late in a long session costs accordingly. Each turn's token counts (input, cache read, cache write, output) are recorded; the board and `/thread:status` show each thread's total. Threads started before version 0.7.0 have no token figures. A turn is stopped after 20 minutes.
- **Limits on threads.** A thread cannot start, continue, report or end threads.

## Several sessions and projects

- Each project has its own cards. Sessions in one project share them.
- Reporting or ending a thread from a session that did not start it asks for confirmation first.
- Thread cards are labelled with the name of the session that started them: Claude Code's title for the session, otherwise the start of its first message, otherwise a short id.

## Security

What the plugin runs, sends and stores:

- **Runs on your machine:** a local MCP server and two hooks (at session start and on each prompt), all plain Node scripts in this repository. For each thread turn it starts the `claude` CLI in the background, in your project folder.
- **Flags it passes to a thread:** read mode passes `--disallowedTools Edit Write NotebookEdit`; write mode passes `--permission-mode acceptEdits`. Every thread gets `--allowedTools WebSearch WebFetch` (see `THREAD_ALLOW_TOOLS`), and `--add-dir` for folders you named. It never edits your Claude Code settings.
- **Reads:** the end of the main session's transcript, to get the session's title and its model and effort, and the agent files in `.claude/agents/`.
- **Sends nothing.** The plugin makes no network requests and has no telemetry. Its only listener is the board on `127.0.0.1`, and the board page loads nothing from the internet. Threads are ordinary Claude Code sessions, so they talk to Anthropic as any session does and can search and fetch the web.
- **Stores:** cards, thread replies and logs in the data directory on your machine.

- **Web access is pre-approved for threads, with no prompt per site.** A full thread holds your whole conversation, and any thread can read the project, so a malicious page could try to talk it into sending that content somewhere. If that matters for your project, set `THREAD_ALLOW_TOOLS=none`.
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
| A full thread fails with "No conversation found with session ID" | The session it was copied from no longer exists, for example after its history was cleared. Start the thread again from the current session. Brief threads do not depend on the old session. |
| Starting a thread fails with "Unknown agent" | The name is not a file in the project's `.claude/agents/` or in `~/.claude/agents/`. The message lists the names that exist. Built-in and plugin agents cannot run a thread. |
| Claude picked an agent or model you did not want | Name it yourself with `--agent` or `--model`. If it keeps happening, make the agent's `description` say what it is for and what it is not for; that text is all Claude chooses by. |
| Starting a thread fails with "give an agent, or a model and effort, not both" | An agent brings its own model and effort. Drop `--model` and `--effort`, or drop `--agent`. |
| A thread reports that a tool was refused | It needed a permission prompt it could not answer. Allow the tool in your Claude Code permission rules, add it to `THREAD_ALLOW_TOOLS`, or name the folder it needs in the task. |
| The board says it needs its access link | The link was opened without its token, or from an old bookmark. Run `/thread:board` and open the link it prints. |
| `/thread:report` lists threads instead of reporting | This session started none or several unreported threads. Pass the id. |
| A thread shows "running" for a long time | Check its card on the board. A thread whose process died is marked failed the next time the board or a command looks at it. |
| A finished thread was not announced | Announcements arrive with your next message to the session that started the thread. |

## What's new

- **0.8.0** Claude picks the sub-agent or model for a thread by how hard the task is. `--model` and `--effort` set them by hand.
- **0.7.0** Threads start from a brief instead of a copy of the session; `--full` keeps the copy. `--agent` runs a thread as a sub-agent. Token use is recorded per turn and shown on the board.
- **0.6.0** The board shows a thread's steps live, starts a card as a thread, and can queue a report to the main session.

## Development

No dependencies and no build step: plain Node ES modules.

```text
.claude-plugin/     plugin and marketplace manifests
hooks/, scripts/    session-start and prompt hooks
skills/             the slash commands
server/
  state.mjs         paths, the state file and its lock
  sessions.mjs      session names, and the model a session runs on
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

MIT. See [LICENSE](LICENSE).
