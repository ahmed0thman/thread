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
- A thread only sees the conversation up to the moment it starts. Later messages in the main session are not visible to it, and that stays true for follow-ups: `/thread:continue` resumes the thread's own copy and never re-reads the main session. Continue a thread for the same task; start a new thread for a new task.
- Each reply ends with a four-heading digest (Happened, Decided, Changed, Open) and an ordered step map. `/thread:report` hands the digest to the main session; the step map is only used by the board.
- A thread never writes into the main session. Its result reaches the main session only through `/thread:report`.

## The board

`/thread:board` gives the address of a local page. Every card shows its id. Clicking a card opens a detail panel:

- Task and idea cards: edit the title, note and status, or delete the card.
- Thread cards: the thread's session ids and a `claude --resume <id>` command, then three tabs. Trace is a timeline of what the thread did, step by step. Conversation is the full exchange, with a box to send the thread a follow-up. Digest shows the latest hand-back and every decision across turns.

A follow-up sent from the board starts a real thread turn, the same as `/thread:continue`.

## Where data lives

| Variable | Meaning |
|---|---|
| `THREAD_DATA_DIR` | Overrides the data directory. Otherwise `CLAUDE_PLUGIN_DATA`, otherwise `~/.claude/thread-data`. |
| `THREAD_PROJECT_DIR` | Project directory. Otherwise `CLAUDE_PROJECT_DIR`, otherwise the current directory. |
| `THREAD_CLAUDE_BIN` | Binary to run instead of `claude` (used by tests). |
| `THREAD_TIMEOUT_MS` | Maximum duration of one thread turn. Default 1200000. |
| `THREAD_DEPTH` | Set to `1` inside a thread's process; threads cannot start threads and the hooks stay silent. |
| `THREAD_NO_HTTP` | Set to `1` to keep the MCP server from starting the board page. |

State is one file per project at `<data dir>/projects/<12 hex chars of sha1(project dir)>/state.json`, with thread logs in `logs/<card id>.out` and `.err` beside it.

## Known limits

- A thread cannot start, continue or end threads.
- A thread cannot read outside the project folder unless your permission rules already allow it: it runs headless and cannot answer a permission prompt.
- The board page is local only; it listens on 127.0.0.1.
- A finished thread is announced to the main session on the next prompt you send, not in the middle of a turn.

## Running tests

```
node --test test/*.test.mjs
```
