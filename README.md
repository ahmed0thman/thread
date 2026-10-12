# thread

Thread is a Claude Code plugin that lets you start side threads from a main session. A thread is a headless copy of the session that has the full conversation context, runs in the background, and hands back a short digest only when you ask for it. The plugin also keeps a per-project kanban board of tasks, ideas and threads, which Claude edits through tools and you edit on a local web page.

## Requirements

- Node 20 or newer. It has only been run on Node 24.
- The standalone `claude` CLI on `PATH`. Each thread turn runs `claude -p --resume <id> --fork-session`.

## Try it

```
claude --plugin-dir <path-to-this-directory>
```

## Commands

| Command | What it does |
|---|---|
| `/thread:new <task>` | Start a side thread for the task. |
| `/thread:continue <id> <message>` | Send a follow-up to an existing thread. |
| `/thread:report [id]` | Pull a finished thread's digest into the main session. |
| `/thread:end <id>` | End a thread and mark its card done. |
| `/thread:status` | List all threads and their states. |
| `/thread:board` | Show the board and its local URL. |
| `/thread:add <task or idea>` | Add a card to the board without acting on it. |

The `track` skill has no command of its own; Claude uses it to capture changed instructions on the board during longer work.

## How threads work

- Threads are read-only by default in a narrow sense: the Edit, Write and NotebookEdit tools are disallowed. Bash and MCP tools still follow your own permission rules, so a command you have allowed can still change files. Write mode lets the thread edit the same working tree as the main session, so use it deliberately.
- Each thread turn is a full model call over the whole conversation, so it costs accordingly.
- Web access is pre-approved for threads, without a prompt per site. A thread holds your whole conversation and can read the project, so a malicious page could try to make it send that content out. Set `THREAD_ALLOW_TOOLS=none` to turn web access off, or to a comma-separated list of tool rules to choose your own.
- A thread only sees the conversation up to the moment it starts. Later messages in the main session are not visible to it, and that stays true for follow-ups: `/thread:continue` resumes the thread's own copy and never re-reads the main session. Continue a thread for the same task; start a new thread for a new task.
- Each reply ends with a four-heading digest (Happened, Decided, Changed, Open) and an ordered step map. `/thread:report` hands the digest to the main session; the step map is only used by the board.
- A thread never writes into the main session. Its result reaches the main session only through `/thread:report`.

## Several sessions and projects

- Each project has its own cards and its own state file.
- Sessions in one project share those cards.
- A finished thread is announced only to the session that started it.
- Reporting or ending a thread from another session asks for confirmation first, through Claude Code's question popup. Nothing is reported or ended until you agree.
- `/thread:report` with no id only picks threads the current session started. A thread from another session has to be requested by id.
- Thread cards are labelled with the parent session's name: the session title when Claude Code gives one, otherwise the generated title in the transcript, otherwise the start of the first message, otherwise the short session id.

## The board

One board serves every project. `/thread:board` gives a link such as `http://127.0.0.1:47800/?t=<token>#/<project>`; it opens that project's tab, and the other projects have a tab each.

- The first session to start takes port 47800 (set `THREAD_BOARD_PORT` to change it); later sessions, in any project, share that board. If the owning session closes, a surviving session takes the port over.
- The access token is in the link. A URL without it shows no data. The token is kept in `<data dir>/board.token`.
- A project whose folder was deleted becomes read-only on the board and can be forgotten there, which removes its saved cards and thread logs.
- Every card shows its id. Clicking a card opens a detail panel.
- Task and idea cards: edit the title, note and status, or delete the card.
- Thread cards open a full-window workspace. The conversation is in the centre, with a box to send the thread a follow-up. On the left are the thread's session ids, a `claude --resume <id>` command, the latest digest and every decision across turns. On the right is the trace, a timeline of what the thread did step by step; clicking a step scrolls the conversation to that turn. Either side pane can be collapsed, and on a narrow window the three panes become tabs.

A follow-up sent from the board starts a real thread turn, the same as `/thread:continue`.

## Where data lives

| Variable | Meaning |
|---|---|
| `THREAD_DATA_DIR` | Overrides the data directory. Otherwise `CLAUDE_PLUGIN_DATA`, otherwise `~/.claude/thread-data`. |
| `THREAD_PROJECT_DIR` | Project directory. Otherwise `CLAUDE_PROJECT_DIR`, otherwise the current directory. |
| `THREAD_CLAUDE_BIN` | Binary to run instead of `claude` (used by tests). |
| `THREAD_ALLOW_TOOLS` | Tools pre-approved for threads, comma separated. Default `WebSearch,WebFetch`. `none` pre-approves nothing. |
| `THREAD_TIMEOUT_MS` | Maximum duration of one thread turn. Default 1200000. |
| `THREAD_DEPTH` | Set to `1` inside a thread's process; threads cannot start threads and the hooks stay silent. |
| `THREAD_BOARD_PORT` | First port the shared board tries. Default 47800; up to 20 ports from there are tried. |
| `THREAD_NO_HTTP` | Set to `1` to keep the MCP server from starting the board page. |

State is one file per project at `<data dir>/projects/<12 hex chars of sha1(project dir)>/state.json`, with thread logs in `logs/<card id>.out` and `.err` beside it.

## Known limits

- A thread cannot start, continue, report or end threads.
- A thread runs headless and cannot answer a permission prompt, so a tool that would prompt is refused. Two things are pre-approved: web search and web fetch. Folders outside the project are readable only when they are passed as `extra_dirs` when the thread starts.
- The board page is local only; it listens on 127.0.0.1.
- A finished thread is announced to the main session on the next prompt you send, not in the middle of a turn.

## Running tests

```
node --test test/*.test.mjs
```
