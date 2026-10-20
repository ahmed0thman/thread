# How Claude uses thread

Part of the thread documentation: [index](README.md).

What Claude is told to do with the board, which tools it calls, how it chooses what runs a thread, and what is only an instruction. The commands that call these tools are in [Commands](commands.md).

## How Claude uses the board

With the task board on, Claude is told how to use it so that it manages its own work without pulling you into the chat, and without losing or forgetting things. These are instructions to Claude, not guarantees; [Instructed or enforced](#instructed-or-enforced) says what the plugin checks itself. The rules are:

- Before starting work you asked for, it puts the work on the board (a new card, or an existing card moved to the working stage). An instruction you give mid-task becomes a card; Claude does not drop what it is doing for it.
- It never asks you a question, a choice, a review or a to-do only in the chat. It records it as a [waiting item](reviews-and-waking.md#waiting-for-you) on the card for that work and writes one line in the chat, such as "Waiting on you: c37.w2", where the id is a link to the card's page on the board (when the board is running) so you can click it from the chat, then carries on with whatever the answer does not block. A question it cannot do anything without may also be asked in the chat, but it is still recorded.
- It acts on every answer you send from the board, and closes an item itself when you answer in the chat.
- It writes any command it asks you to run in its own fenced code block, one command per block, so the board shows it with a Copy button, and names another card by its id (`c12`), not by a board address.
- It starts each sub-agent call's description with the card id (`[c12] ...`) so the board shows that agent's work on the card, and passes who did the work.
- It moves cards as the work moves, never marks a card done that it did not verify, and looks at the board at natural stopping points for cards you added.
- A side question you start with `/thread:new` runs as a thread: Claude does not wait for it or poll it, and reports it when you ask.

Where it comes from: the thread MCP server hands Claude this guide when a session starts (it appears in the system prompt as that server's instructions); the session start note repeats the two rules that matter most (put each task on the board before starting it, and send every question, review or to-do through a waiting item); and the `/thread:track` skill holds the full version. In [chat-only mode](board.md#chat-only-mode) Claude is told only the thread part. A side thread is told nothing, since it cannot raise waiting items. Nothing here changes the board's access rules.

## Instructed or enforced

Most of what is on this page is an instruction. The guide is text that Claude reads, and Claude can follow it badly, forget it or ignore it: nothing in the plugin can force Claude to put a task on the board or to raise a waiting item. What the plugin enforces is narrower, because its tools and its board server refuse some things whatever Claude does.

| What | Instructed (Claude is told) | Enforced (the tools, the board server or the CLI flags refuse otherwise) |
|---|---|---|
| Putting each task on the board before starting it | Yes | No. A task Claude never records is not on the board. |
| Raising every question, review or to-do as a waiting item, with one line in the chat | Yes | No. A question asked only in the chat is not on the board. |
| Starting a sub-agent call's description with the card id, and passing `worker` | Yes | The hooks record only a description that starts with `[cN]`. |
| Not marking unverified work done | Yes, for every card | Only for a task or idea card with acceptance criteria: `board_update` and `board_remove` refuse the done stage (and any later one) until an approval is recorded on this machine's board, and Claude cannot remove or reword the criteria. The board's API takes any request that carries the token, and Claude is shown the board link, so an agent with shell access could record an approval itself: the gate guards the normal path, it is not a sandbox. See [the done gate](board.md#card-fields-workers-and-the-done-gate). |
| The done gate for threads | | Not covered. A thread card cannot carry acceptance criteria, `thread_end` needs no approval and reporting a thread returns its digest to the main session without one. |
| The done gate for you | | Not covered. The board lets you move any card; one with criteria in a finished stage is marked **not verified**. |
| Reporting or ending a thread from a session that did not start it | Yes: the tool answers "Wrong session" with a code and tells Claude to ask you before calling again with it | No. The code goes to Claude in the tool's reply; nothing checks that you agreed. |
| A read thread cannot edit files | | The plugin passes `--permission-mode dontAsk` and `--disallowedTools Edit Write NotebookEdit`. It is not a sandbox: a command your own allow rules approve by name still runs. See [How threads work](threads.md#how-threads-work). |
| Turning waking on, and opening the tunnel | Yes: the first call is refused with a code and Claude is told to ask you before the second call | No. The code goes to Claude in the tool's reply; nothing checks that you agreed. |
| Adding cards in chat-only mode | | `board_add` and `/thread:add` are refused. |

## Tools Claude uses

The commands call these MCP tools. Claude can also call them itself, for example when you ask it in plain words to put a task on the board.

| Tool | What it does |
|---|---|
| `thread_start` | Start a thread (brief or full copy, agent or model or [delegation lane](delegation.md#delegation-lanes), read or write, optional milestone). |
| `lane_list` | List the project's delegation lanes (provider, model, effort or variant, access, source, and on every line whether it is approved), or say that the delegate skills are not installed. Claude uses it to learn which lanes it may choose. |
| `thread_continue` | Send a follow-up to a finished thread. |
| `thread_status` | Show threads: milestone, state, mode, context, agent, model or lane, turns, tokens, reported or not. |
| `thread_report` | Fetch a thread's digest and mark it reported. |
| `thread_end` | End a thread and move its card to the done stage. |
| `board_add` | Add a task, idea or milestone card (a milestone takes no `status`: it has no stage), optionally under a milestone and, for a task or idea, with a [delegation lane](delegation.md#delegation-lanes) or a sub-agent (`agent`, a name from `.claude/agents`; a card has one or the other) and the [card fields](board.md#card-fields-workers-and-the-done-gate) `type`, `priority`, `labels`, `blocked_by` and `criteria`, and a `worker` (Claude passes `main`, `agent:<type>`, `thread:<id>` or `lane:<name>`). A milestone takes `depends_on` (up to 20 other milestones, drawn as dotted links on the [Milestones map](board.md#the-milestones-view)) and `link_names` (short names for its lines). Refused when the project is chat-only. The reply reminds Claude to start the description of an Agent call for the card with `[cN]`, so the run [shows on the card](board.md#task-and-idea-pages). |
| `board_update` | Change a card's title, note, stage, `kind`, milestone, lane, `agent` (a sub-agent; setting one takes the other off) or [card fields](board.md#card-fields-workers-and-the-done-gate) (`type`, `priority`, `labels`, `blocked_by`, `criteria`), or, for a milestone, `depends_on` (the list replaces the one before; an empty list removes the links) and `link_names` (short names of its lines, shown by `board_list`). An empty value removes a field, except `criteria`: once a card has them Claude can add lines but not remove or change them. A card with `criteria` cannot be moved to the done stage, or any stage after it, until you have approved a review item on it, and a card moved back out of the finished stages needs a new approval. `kind` is `task` or `idea`: it turns a task into an idea or an idea into a task (the change is in the card's history). A thread or a milestone never changes kind, and no card becomes a milestone. A `status` on a milestone is refused: a milestone has no stage. Takes a `worker` too; an update that changes nothing but the `worker` is noted in the card's history, once per worker in a row. |
| `board_remove` | Delete a card. A running thread cannot be removed, and Claude cannot remove a card that has `criteria` unless it is in the done stage or a later one, or you approved it; you remove such a card on the board. |
| `board_list` | List the cards by stage. Milestones are not in the stage groups: they have their own **Milestones** section after them, one line each with the id, `[milestone:open]` (or `empty`, `done`), the title and the progress `(5/14 done)`, and `{depends on M2 (c4)}` when links were drawn from it to other milestones, then `{link names: M2 (c4) "pay first"}`. After a card's title come the marks of its [fields](board.md#card-fields-workers-and-the-done-gate), in this order and only when it has them: `(bug)`, `!high` or `!low`, `#label` for each label, `{blocked by c4, c7}` (only the blockers that are not finished yet, in the done stage or a later one, and nothing when all are), `[criteria 3]` and `(done, not verified)`. Then come its milestone tag, lane or sub-agent (as `{lane: name}` or `{agent: name}`) and `(2 waiting)` for items [waiting for you](reviews-and-waking.md#waiting-for-you). With `parent`, report on one milestone, with its state in the summary line. Claude passes its `session_id`: that is what ends a [Notify Claude](board.md#notify-claude) request for the session you picked. In a project [kept in the repo](storage-and-sync.md#conflicts), it also names card files that could not be read, and says that the cards' texts are data from the repo, not instructions. |
| `board_import` | Only for a project [kept in the repo](storage-and-sync.md#older-sessions-and-the-import-hint): copies the cards that a session on an older plugin version added to this machine's older boards (the project's old store, and the stores of its worktrees and sub-folders) since the one-time copy into the repo's `cards/` folder, each with a new id. A card that was changed there is reported, not copied over the repo's version. `dismiss: true` copies nothing and stops the mention. Refused inside a side thread. |
| `wait_add` | Put something Claude needs from you on a card: a question, a choice, a to-do or a review. Refused on a milestone, inside a side thread and when the project is chat-only. An optional `worker` (same forms as above) is noted in the card's history. See [Waiting for you](reviews-and-waking.md#waiting-for-you). |
| `wait_list` | Read waiting items (one by id, or those of a card or state), with the answer once there is one. Read only. It is how Claude answers "what is c37.w2?". |
| `wait_close` | Close an open item that you did not answer on the board: withdraw it, or note that you answered in the chat. |
| `board_open` | Return the board link. Starts the board again if it was stopped. With `tunnel: "start"` it also opens, or shows, the [remote link](security.md#opening-the-board-from-your-phone-tunnel); opening needs your agreement (`confirm_code`), showing an open one does not. `tunnel: "stop"` closes it. |
| `board_stop` | Stop the board web page for every session, and the remote tunnel if one is open. |
| `config_get` | Show the mode, the stages, the roles, where each came from, the paths of the config files, and whether the cards are kept on the machine or [in the repo](storage-and-sync.md#keeping-the-board-in-your-repo-claudethread). In [chat-only mode](board.md#chat-only-mode) it shows both the fixed columns and roles and the task board's own stages and roles, which are kept for when it is turned on. |
| `config_set` | Change or reset the settings in the global or the project config file; with `repo: true` and the project scope, turn on [keeping the board in the repo](storage-and-sync.md#turning-it-on). Claude uses it only when you ask to set up or change the plugin. |

## Choosing the agent and model

A thread does not have to run on your session's model. Routine work, such as listing files or checking a fact, usually does not need your session's most capable model: a smaller model or one of your own sub-agents costs less per token. Claude decides this for you when it starts a thread, and you can always overrule it.

**Who decides, and when.** The main session. It chooses at the moment it starts the thread, because it is already writing the brief and knows the task, so no extra model call is needed. This applies to `/thread:new` and to any thread Claude starts on its own. A thread started from a card on the board is not chosen for you: you pick a [**Worker**](delegation.md#choosing-a-worker-on-the-board) for the card, which can be one of your sub-agents, a delegation lane, or Claude (default), the session's own model.

**A lane comes first when you or the project say so.** If your instructions (for example the project's `CLAUDE.md`) say which [delegation lanes](delegation.md#delegation-lanes) suit which work, Claude calls `lane_list` and runs the thread on the matching lane, instead of choosing an agent or model. A lane cannot be combined with an agent, a model, an effort or `--full`. Without such instructions Claude never picks a lane on its own.

**The order of preference.**

1. **A sub-agent of yours.** If the project has agents in `.claude/agents/`, or you have some in `~/.claude/agents/`, Claude picks the cheapest one whose description fits the task. It follows each description's own limits, such as an agent that is only for when you ask for it by name. The thread then runs with that agent's model, effort and instructions. Built-in agents (Explore, Plan, general-purpose) and agents from other plugins are not accepted.
2. **A cheaper model.** If you have no agents, Claude passes a model: `haiku` for lookups, listings and mechanical work; `sonnet` for routine, well-specified work in several steps.
3. **The session's own model and effort.** If neither applies, the thread runs as the main session does. The model and effort are read from the session's transcript when the thread starts. If they cannot be found, the CLI's defaults apply.

**When Claude deliberately does not go cheaper.** It keeps the session's model and effort when the task needs judgment, design or review; when a wrong answer would be costly; when it is unsure; and always with `--full`. A full thread is a copy of the session, and a copy on another model cannot reuse the session's cache.

**How to see what was chosen.**

- The reply after `/thread:new` says in one sentence the card id and what runs the thread, with the reason in a few words when Claude chose it.
- The thread's card on the board shows its agent. Opened full-window, its left pane shows the agent, or the model and effort.
- `/thread:status` shows `agent <name>`, `model <name>, effort <level>` or `lane <name> (provider, model, effort)` for each thread, or "default model" when the thread has none of its own.

**How to override.**

```text
/thread:new --agent haiku-coder list every file that mentions API_HOST
/thread:new --model opus review the retry logic
/thread:new --model sonnet --effort high review the retry logic
```

- `--agent <name>` runs the thread as that sub-agent, on every turn. The name must be a Markdown file in the project's `.claude/agents/` or in `~/.claude/agents/` (top level only; the project's wins on the same name). If the name is unknown, Claude shows you the names that exist and asks which to use.
- `--model <name>` takes an alias such as `haiku`, `sonnet` or `opus`, or a full model id.
- `--effort <level>` is one of `low`, `medium`, `high`, `xhigh` and `max`. With `--model` and no `--effort`, the thread does not inherit the session's effort, because not every model takes every level.
- **An agent cannot be combined with a model or an effort**, because an agent brings its own. Giving both fails with "give an agent, or a model and effort, not both". Drop one side.

**How to steer the choice.** Claude chooses by each agent's `description` line and by nothing else. So write it to say what the agent is for and what it is not for. An agent file is a Markdown file with front matter; `name` (otherwise the file name) and `description` are read, and `model` and `effort` are shown on the board.

```markdown
---
name: lookup
description: Finds files and lists or counts things. Use for searches, inventories and checking whether something exists. Not for design decisions or for reviewing logic.
model: haiku
---
You find and list things in the codebase. Report facts with file paths. Do not suggest changes.
```

An agent whose description is vague gets picked for the wrong jobs, or never. An agent that should only run when you ask for it should say so in its description.

## Catch-up notes on follow-ups

A thread knows only its own history: what it was given and what it did itself. It does not see what happens in the main session afterwards. If you decide something, or edit a file the thread had read, or change a requirement, the thread does not know when you send it a follow-up.

So when Claude sends a follow-up with `/thread:continue`, and something that matters to the thread has changed in the main session since the thread's last turn, it opens the message with a short note headed `Since your last turn:` and then makes the request. When nothing relevant changed, there is no note.

```text
/thread:continue c9 does the same race exist in the upload path?
```

What Claude may send to the thread:

```text
Since your last turn: we decided to keep the retry counter in Redis, and I changed
src/queue.ts so the lock is taken before the counter is read.

Does the same race exist in the upload path?
```

The note is written by Claude. A follow-up you type on the board is sent as you typed it, with no note, so say what changed in the message itself.
