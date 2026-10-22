# Side threads

Part of the thread documentation: [index](README.md).

A side thread is a background Claude session that gets a short brief, works on one task and reports back only when you ask. This page covers starting one, what it knows, what it may do and what it costs. How Claude chooses what runs a thread is in [How Claude uses thread](agent-behavior.md#choosing-the-agent-and-model); threads on another provider are in [Delegation lanes](delegation.md).

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

It opens your project on its Summary in your browser. **Board** in the top bar shows the cards in their columns.

By default the thread does not get your whole conversation. Claude writes it a brief from what you typed, so it starts with far less context than a full copy ([How threads work](#how-threads-work) says what that costs). Claude also picks what runs the thread by how hard the task is: a smaller sub-agent or model for simple work, the session's own model for work that needs judgment (see [Choosing the agent and model](agent-behavior.md#choosing-the-agent-and-model)). Flags change these defaults:

```text
/thread:new --full ...                   copy the whole session into the thread
/thread:new --agent worker ...           run the thread as this sub-agent
/thread:new --model haiku ...            run the thread on this model
/thread:new --model opus --effort high   run it on this model at this effort
/thread:new --write ...                  let the thread edit files
/thread:new --parent c12 ...             file the thread under milestone c12
```

Everything works with its defaults: a board with six columns and the task board switched on. If you want other columns, or threads only, run `/thread:setup` once (see [Setup](board.md#setup)).

## How threads work

A thread opens full-window on the board (see [The Board view](board.md#the-board-view)):

![The thread c34 opened full-window: its session id, Resume command, milestone, context, agent and tokens on the left; the conversation with a Happened, Decided and Open digest in the centre; the trace on the right](thread.png)

- **Context.** By default a thread starts a fresh session and knows only the brief and the task. It also loads the project's `CLAUDE.md` on its own, and sees files as they are on disk when it reads them. With `--full` it starts as a copy of the main session at that moment. A thread on a [delegation lane](delegation.md#delegation-lanes) is always a brief thread: its provider's CLI knows only the brief and the task. Either way it does not see anything the main session does afterwards, and neither do its follow-ups: a follow-up resumes the thread's own session. Continue a thread for the same task; start a new one for a new task. Claude tells a continued thread what changed with a [catch-up note](agent-behavior.md#catch-up-notes-on-follow-ups).
- **Model and effort.** With `/thread:new`, Claude chooses a sub-agent or a model by how hard the task is, unless you name one; see [Choosing the agent and model](agent-behavior.md#choosing-the-agent-and-model). A thread with neither an agent nor a model runs with the same model and effort as the main session. An agent brings its own model, effort and instructions, on every turn.
- **For a card.** A thread can do the work of a task or idea (`card` in `thread_start`, `--card` in `/thread:new`): the card then shows each turn as a run with its live steps and report, as for a sub-agent, and stays a task. See [Running a lane for a card](delegation.md#running-a-lane-for-a-card).
- **Hand-back.** A thread never writes into the main session. Each of its replies ends with the four-heading digest and an ordered step map. `/thread:report` gives the digest to the main session; the step map is only drawn on the board. Reporting does not need your approval: the digest enters the main session as it is, and a thread card cannot carry acceptance criteria, so the [done gate](board.md#card-fields-workers-and-the-done-gate) does not cover it.
- **Reported status.** A thread counts as reported once the session that started it has pulled its newest result. A follow-up that produces a new result makes it "not reported" again. A follow-up that fails leaves it as it was.
- **Announcements.** When a thread finishes, the session that started it is told on your next message, not in the middle of a turn.
- **Read and write.** A read thread may read and search the project, search and fetch the web, run the read-only shell commands Claude Code allows without asking (`ls`, `cat`, `git log` and the like) and report. It cannot edit files. The plugin enforces this by passing `--permission-mode dontAsk` (Claude Code refuses everything that would need a prompt) and `--disallowedTools Edit Write NotebookEdit`, whatever your own Claude Code settings say: a default mode that skips prompts, in your user settings, does not reach a read thread, and a deny rule beats any allow rule your settings hold for those tools. It is still not a sandbox: a shell command or MCP tool that your own `permissions.allow` rules (or `THREAD_ALLOW_TOOLS`) approve by name can still change things. Write mode passes `--permission-mode acceptEdits`, so it edits files in the shared working tree.
- **Permissions.** A thread runs headless, so it cannot answer a permission prompt. Anything that would prompt is refused, except web search and web fetch, which are pre-approved, and folders you named in the task.
- **Cost and time.** Every thread turn is a model call over the thread's own conversation. Inside a turn, every step the thread takes sends that conversation again. A brief thread starts small: in one long session of the author's, threads that were full copies re-read 1.35 to 2.86 million input tokens each, and a brief thread in the same project used about 91 thousand for a small task. A full thread starts with the whole main session (after a compaction, with the summary and what followed), so one started late in a long session costs accordingly. Each turn's token counts (input, cache read, cache write, output) are recorded; the board and `/thread:status` show each thread's total. Threads started before version 0.7.0 have no token figures. A turn is stopped after 20 minutes. In the author's one real cost test (two runs each, one repository, one model), a side thread cost about 66% more than answering a medium side question inline, and about 29% less than a fresh built-in sub-agent on a big audit with two follow-ups; the scope and caveats are on the [evidence page](evidence.md#token-use-measured-once).
- **Limits on threads.** A thread cannot start, continue, report or end threads, and its card cannot carry acceptance criteria or a Blocked by list. A write thread edits the same working tree as the main session, at the same time.

## Code maps (Graphify)

If your project has a [Graphify](https://github.com/Graphify-Labs/graphify) code map, thread can tell a new thread to use it to find where to look instead of opening many files. **It is off by default**, because a map built before recent changes can be out of date. Turn it on with `/thread:setup` (the last question: should new threads use a code map when the project has one) or by asking Claude to call `config_set` with `codeMap: true` (`scope: "global"` for every project, `"project"` for one; `null` removes it from that scope; `config_get` shows the value and where it came from).

With it on, when a thread starts (from `/thread:new`, from a card with **Start as thread**, or on a [delegation lane](delegation.md#delegation-lanes)), thread checks whether `graphify-out/GRAPH_REPORT.md` exists in the folder the thread runs in, or else at the root of that folder's git repository, and if it does, adds a short note to the thread's first prompt. A follow-up turn does not repeat it. With the setting off, or with no map, the prompt is exactly what it was before, even if a map exists.

The note says the project has a code map in `graphify-out/`, to start with `GRAPH_REPORT.md` (and the `/graphify` skill, if installed), and to use the map to decide which files matter. It also says the map is an index and not the source of truth: the thread must read the actual code before deciding or changing anything, the code wins when they disagree, and a result missing from the map does not prove something does not exist, so it should confirm with a text search. When `GRAPH_REPORT.md` is older than the project's last commit (`git log -1`), the note adds that the map may be out of date.

**What thread does and does not do.** It only looks for a file that already exists (a regular file; a symlinked `graphify-out/` or `GRAPH_REPORT.md` is ignored). It does not install, run or build Graphify, does not read the map itself and sends nothing anywhere new.

**Getting a map.** Install Graphify yourself: `uv tool install graphifyy`, then `graphify install`, then build the map by running its `/graphify` skill in the project. Rebuild it when the code has changed a lot. A map can be wrong or incomplete, which is why the note tells the thread to check the code.

**The setting and older versions.** `codeMap` is shared like the mode: for a project [kept in the repo](storage-and-sync.md#keeping-the-board-in-your-repo-claudethread) it goes in `.claude/thread/config.json` (it only adds a note to a prompt, unlike `wake`). An older plugin version ignores it, and if an older version rewrites that file it drops the field.

## Several sessions and projects

- Each project has its own cards and its own milestones. Sessions in one project share them. A project [kept in the repo](storage-and-sync.md#keeping-the-board-in-your-repo-claudethread) has one board per repository: its worktrees and sub-folders share it, and so do its clones, through git.
- Settings can be shared across projects (the global file) or set for one project; cards and threads never are.
- Reporting or ending a thread from a session that did not start it asks for confirmation first.
- A sub-agent run is recorded on the card of the project the main session belongs to; a `[cN]` that names no card in that project is ignored.
- A [waiting item](reviews-and-waking.md#waiting-for-you) is answered on the board but delivered only to the session that asked it, with that session's next message. Another session sees it with `wait_list`.
- Thread cards are labelled with the name of the session that started them: Claude Code's title for the session, otherwise the start of its first message, otherwise a short id.
