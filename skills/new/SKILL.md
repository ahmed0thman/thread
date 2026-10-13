---
name: new
description: Start a side thread, a background Claude session that gets a short brief from this one, works on a separate task and reports back only when asked.
argument-hint: "[--full] [--agent <name>] [--model <name>] [--write] what the thread should do"
---

Start a side thread for the task the user described in the arguments.

Flags may appear anywhere in the arguments. Remove them from the task text.

- `--full`: pass `context: "full"`. The thread is then a copy of this whole session, which costs far more tokens. Say so in one clause when you report. No brief is needed.
- `--agent <name>`: pass `agent` with that name. If the tool answers that the agent is unknown, show the names it lists and ask the user which to use.
- `--model <name>`, optionally with `--effort <level>`: pass `model` and `effort` as given.
- `--write`, or the user plainly asking for file changes: pass `mode: "write"`, which edits the same working tree as this session. Otherwise `mode: "read"`.

Without `--full` the thread is a fresh session (`context: "brief"`). It has not seen this conversation and knows only what you write:

1. `title`: a few words.
2. `task`: what to do, written so it stands alone: the user's request plus any constraint they gave.
3. `brief`: what the thread needs from this conversation. Give the goal, the decisions and constraints that apply, exact file paths, what was already tried or ruled out, and what any project term in the task means. Leave out what the task does not need, and do not repeat CLAUDE.md, which the thread loads itself. Be as long as the task needs and no longer.

Who runs the thread. When the user gave neither `--agent` nor `--model`, choose by how hard the task is:

- If this project or the user defines sub-agents in `.claude/agents`, pass as `agent` the cheapest one whose description fits the task. Follow each description's own limits, such as an agent reserved for the user's explicit request. Built-in agents (Explore, Plan, general-purpose) and plugin agents are not accepted.
- If none is defined, pass `model`: `haiku` for lookups, listings and mechanical work; `sonnet` for routine, well-specified work in several steps.
- Pass neither, so the thread runs with this session's model and effort, when the task needs judgment, design or review, when a wrong answer would be costly, when you are unsure, and always with `--full` (a copy on another model cannot reuse this session's cache).

The thread cannot answer permission prompts. It can read the project and use web search and fetch. If the task needs files in a folder outside the project, pass that folder's absolute path in `extra_dirs`; list only folders the task requires.

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

Call the `thread_start` tool with `title`, `task`, `session_id`, `mode`, and `context`, `brief`, `agent` or `model`, and `extra_dirs` as above.

After the tool returns, tell the user in one sentence the card id and what runs the thread, with the reason in a few words when you chose it, then carry on with the main task. Do not wait for the thread and do not poll it.
