---
name: new
description: Start a side thread, a background Claude session that gets a short brief from this one, works on a separate task and reports back only when asked.
argument-hint: "[--full] [--agent <name>] [--model <name>] [--effort <level>] [--lane <name>] [--write] [--parent <id>] what the thread should do"
---

Start a side thread for the task the user described in the arguments. For a card that should not start a thread now, use `/thread:add` instead.

Flags may appear anywhere in the arguments. Remove them from the task text.

- `--full`: pass `context: "full"`. The thread is then a copy of this whole session, which costs far more tokens. Say so in one clause when you report. No brief is needed.
- `--agent <name>`: pass `agent` with that name. If the tool answers that the agent is unknown, show the names it lists and ask the user which to use.
- `--model <name>`, optionally with `--effort <level>`: pass `model` and `effort` as given.
- `--lane <name>`: pass `lane` with that delegation lane's name (call `lane_list` first if you need the names), so another coding CLI (codex, agy, opencode or claude) runs the thread with the lane's own model and effort. It cannot be combined with `--agent`, `--model`, `--effort` or `--full`: if the arguments have both, say so and ask which one the user wants. If the tool refuses the lane (unknown name, not approved, no delegate skills, relay missing, read-only lane, or an agy lane, with `--write`), pass its message on. The lane's CLI sends the brief and the files it reads to its own provider; say so in one clause when you report. Extra folders (`extra_dirs`) are not supported with a lane.
- `--parent <id>`: pass `parent` with that milestone card id, so the thread belongs to the milestone.
- `--write`, or the user plainly asking for file changes: pass `mode: "write"`, which edits the same working tree as this session. Otherwise `mode: "read"`.

Without `--full` the thread is a fresh session (`context: "brief"`). It has not seen this conversation and knows only what you write:

1. `title`: a few words.
2. `task`: what to do, written so it stands alone: the user's request plus any constraint they gave.
3. `brief`: what the thread needs from this conversation. Give the goal, the decisions and constraints that apply, exact file paths, what was already tried or ruled out, and what any project term in the task means. Leave out what the task does not need, and do not repeat CLAUDE.md, which the thread loads itself. Be as long as the task needs and no longer.

Who runs the thread. When the user gave none of `--agent`, `--model` and `--lane`, check the project's instructions (CLAUDE.md, for example) and what the user said: only if they mention lanes, or say which lanes suit which kind of work and this task is of that kind, call `lane_list` and pass `lane`. Do not call `lane_list` otherwise, and never pick a lane just because one exists. When no lane applies, choose by how hard the task is, as below:

- If this project or the user defines sub-agents in `.claude/agents`, pass as `agent` the cheapest one whose description fits the task. Follow each description's own limits, such as an agent reserved for the user's explicit request. Built-in agents (Explore, Plan, general-purpose) and plugin agents are not accepted.
- If none is defined, pass `model`: `haiku` for lookups, listings and mechanical work; `sonnet` for routine, well-specified work in several steps.
- Pass neither, so the thread runs with this session's model and effort, when the task needs judgment, design or review, when a wrong answer would be costly, when you are unsure, and always with `--full` (a copy on another model cannot reuse this session's cache).

The thread cannot answer permission prompts. It can read the project and use web search and fetch. If the task needs files in a folder outside the project, pass that folder's absolute path in `extra_dirs`; list only folders the task requires.

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

Call the `thread_start` tool with `title`, `task`, `session_id`, `mode`, and `context`, `brief`, `agent` or `model`, or `lane`, `extra_dirs` and `parent` as above.

After the tool returns, tell the user in one sentence the card id and what runs the thread, with the reason in a few words when you chose it, then carry on with the main task. Do not wait for the thread and do not poll it.
