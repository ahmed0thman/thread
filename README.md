# thread

Side threads for Claude Code, with a kanban board.

While Claude is busy on one task, you often think of something else: a question that needs real digging, a doubt about the plan, an idea for later. Asking it in the same session derails the work. Opening a new session loses the context you have built up.

`thread` gives you a third option. A **thread** is a background Claude session with its own tools that works on one task while the main session carries on. Claude gives it a short **brief** of what it needs from your conversation, so it starts cheap, and picks a sub-agent or model that suits how hard the task is. If the task needs everything said so far, a thread can instead be a **full copy** of the session. Nothing it does enters the main session until you ask for its report.

The plugin also keeps a **board** of tasks, ideas, milestones and threads for each project, shown on a local web page where you can read a thread's conversation, see what it did step by step, and send it follow-ups. The columns are yours to define, and if you only want threads, you can switch the task board off.

![The board: milestones with their progress, tasks, ideas and threads in columns, each card tagged with its milestone](docs/board.png)

![A thread opened full-window: its details and brief on the left, the conversation in the centre, the step-by-step trace on the right](docs/thread.png)

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Use cases](#use-cases)
- [Commands](#commands)
- [Tools Claude uses](#tools-claude-uses)
- [Choosing the agent and model](#choosing-the-agent-and-model)
- [Waiting for you](#waiting-for-you)
- [Milestones](#milestones)
- [Delegation lanes](#delegation-lanes)
- [Setup](#setup)
- [Custom stages](#custom-stages)
- [Chat-only mode](#chat-only-mode)
- [Catch-up notes on follow-ups](#catch-up-notes-on-follow-ups)
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

By default the thread does not get your whole conversation. Claude writes it a brief from what you typed, which keeps it cheap. Claude also picks what runs the thread by how hard the task is: a cheaper sub-agent or model for simple work, the session's own model for work that needs judgment (see [Choosing the agent and model](#choosing-the-agent-and-model)). Flags change these defaults:

```text
/thread:new --full ...                   copy the whole session into the thread
/thread:new --agent worker ...           run the thread as this sub-agent
/thread:new --model haiku ...            run the thread on this model
/thread:new --model opus --effort high   run it on this model at this effort
/thread:new --write ...                  let the thread edit files
/thread:new --parent c12 ...             file the thread under milestone c12
```

Everything works with its defaults: a board with six columns and the task board switched on. If you want other columns, or threads only, run `/thread:setup` once (see [Setup](#setup)).

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

A follow-up keeps the thread's own history, so it builds on what it already found. If something changed in the main session since the thread's last turn, Claude opens the message with a short catch-up (see [Catch-up notes on follow-ups](#catch-up-notes-on-follow-ups)).

### 4. Parking instructions and ideas without interrupting

Mid-task you remember two things. Neither should replace what Claude is doing.

```text
/thread:add rename the "moderator" role to "agent" across the app once this ships
/thread:add idea: let users snooze a conversation until a set time
```

Each becomes a card on the board. Claude confirms in a line and returns to its work. You can also add cards on the board page itself; Claude is told about them on your next message and picks them up at a natural stopping point.

During longer work Claude uses the board on its own to keep track of instructions you give or change along the way. It moves cards between the board's stages as the work changes: by default In progress, Review, Blocked and Done. This is the `/thread:track` skill, which Claude loads itself. In [chat-only mode](#chat-only-mode) Claude cannot add cards.

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

Routine work does not need the main session's model, and you do not have to say so. Claude is already writing the brief, so it also chooses what runs the thread, at no extra cost: a sub-agent of yours whose description fits, else `haiku` or `sonnet`, else the session's own model. It tells you what it chose, for example "c7 is running as `worker-high`, the cheapest agent whose description covers reading and listing files". To decide yourself, name the agent or the model:

```text
/thread:new --agent haiku-coder list every file that still mentions the old env variable API_HOST
/thread:new --model opus --effort high review the retry logic for double charges
```

Use `--full` only when a brief would lose too much, for example a judgment that depends on a long discussion:

```text
/thread:new --full which of the options we rejected today should we reconsider, and why
```

Each thread's token use is shown on its card and in `/thread:status`, so you can see what a thread cost. The full rules, including when Claude deliberately does not go cheaper, are in [Choosing the agent and model](#choosing-the-agent-and-model).

### 10. Grouping a piece of work under a milestone

You are building an invoice export. It will take a few tasks, an idea you do not want to lose, and one investigation. Make a milestone first, then put everything under it.

```text
/thread:add --milestone Ship the invoice export
```

Claude answers with the new card's id, say `c12`. Then:

```text
/thread:add --parent c12 write the CSV exporter
/thread:add --parent c12 idea: offer an Excel export too
/thread:new --parent c12 check how the export behaves with 100,000 rows
```

Later, `/thread:board --parent c12` prints the report for the milestone: how many of its cards are done, and every card under it grouped by stage. See [Milestones](#milestones) for the details.

### 11. Setting the plugin up for how you work

Your team does not use "Idea, New, In progress, Review, Blocked, Done". You use To do, Doing, Check and Done.

```text
/thread:setup
```

Claude asks whether the setting is for every project or this one, whether you want threads only or threads plus the task board, and, for the task board, how you work. You describe it in your own words ("I write a task, start it, someone reviews it, then it's finished"). Claude proposes the stages and says which one each part of the plugin will use ("a running thread sits in Doing"). You change the list until you agree, and Claude saves it. See [Setup](#setup) and [Custom stages](#custom-stages).

### 12. Threads only, no task board

You only want side threads and have no use for cards, ideas or milestones. Run `/thread:setup` and choose threads only. Claude stops creating cards, the board page shows only threads, and `/thread:add` is refused with a message that says how to turn the task board back on. See [Chat-only mode](#chat-only-mode).

## Commands

| Command | What it does |
|---|---|
| `/thread:new [--full] [--agent <name>] [--model <name>] [--effort <level>] [--lane <name>] [--write] [--parent <id>] <task>` | Start a thread on the task. By default it gets a brief written by Claude, runs on an agent or model Claude picks for the task, and cannot edit files. `--full` copies the whole session instead. `--agent`, or `--model` with an optional `--effort`, sets what runs it. `--lane` runs it on a [delegation lane](#delegation-lanes) (another provider's CLI) and cannot be combined with `--agent`, `--model`, `--effort` or `--full`. `--write` lets it edit files. `--parent` puts it under a milestone. |
| `/thread:continue <id> <message>` | Send a follow-up to a finished thread (a lane thread continues its provider's session). When the main session has changed something the thread needs to know, Claude opens the message with a "Since your last turn:" note. |
| `/thread:report [id]` | Pull a thread's digest into this session. With no id, picks the one unreported thread this session started. |
| `/thread:status` | List threads with their milestone, state, context, agent or model, turns, tokens used, reported status and who started them. |
| `/thread:end <id>` | End a thread, stopping it if it is running, and mark its card done. |
| `/thread:board [--stop] [--parent <id>]` | List the cards by stage (a card with items waiting for you shows `(2 waiting)`) and print the board link. `--parent <id>` shows the report for one milestone instead. `--stop` stops the board web page. |
| `/thread:add [--milestone] [--parent <id>] [--lane <name>] <task or idea>` | Add a card without acting on it. `--milestone` makes the card a milestone. `--parent` puts the card under a milestone. `--lane` labels a task or idea with a [delegation lane](#delegation-lanes). |
| `/thread:setup [--show] [--reset]` | Choose chat-only or the task board, your own stages, and whether that applies to every project or this one. `--show` prints the current settings. `--reset` deletes a settings file. |
| `/thread:track` | Claude loads this itself, so that an instruction you give mid-task becomes a card, cards move as the work moves, and anything Claude needs from you is put on the card as a [waiting item](#waiting-for-you). You can also invoke it by hand. |

```text
/thread:new --agent critic review the retry logic in src/queue.ts for double charges
/thread:new --full --write apply the rename we discussed to the billing module
/thread:board --parent c12
/thread:add --milestone Ship the invoice export
```

Flags can go anywhere in the line. Thread states map to board stages through the [roles](#custom-stages): running goes to the stage for **working**, finished to **review**, failed to **blocked**, ended to **done**. With the default stages that is In progress, Review, Blocked and Done.

## Tools Claude uses

The commands call these MCP tools. Claude can also call them itself, for example when you ask it in plain words to put a task on the board.

| Tool | What it does |
|---|---|
| `thread_start` | Start a thread (brief or full copy, agent or model or [delegation lane](#delegation-lanes), read or write, optional milestone). |
| `lane_list` | List the project's delegation lanes (provider, model, effort or variant, access, source, and on every line whether it is approved), or say that the delegate skills are not installed. Claude uses it to learn which lanes it may choose. |
| `thread_continue` | Send a follow-up to a finished thread. |
| `thread_status` | Show threads: milestone, state, mode, context, agent, model or lane, turns, tokens, reported or not. |
| `thread_report` | Fetch a thread's digest and mark it reported. |
| `thread_end` | End a thread and move its card to the done stage. |
| `board_add` | Add a task, idea or milestone card, optionally under a milestone and, for a task or idea, with a [delegation lane](#delegation-lanes). Refused when the project is chat-only. The reply reminds Claude to start the description of an Agent call for the card with `[cN]`, so the run [shows on the card](#task-and-idea-pages). |
| `board_update` | Change a card's title, note, stage, milestone or lane. An empty `lane` removes it. |
| `board_remove` | Delete a card. A running thread cannot be removed. |
| `board_list` | List the cards by stage, with milestone tags, lanes (as `{lane: name}`), progress and `(2 waiting)` on a card with items [waiting for you](#waiting-for-you). With `parent`, report on one milestone. |
| `wait_add` | Put something Claude needs from you on a card: a question, a choice, a to-do or a review. Refused on a milestone, inside a side thread and when the project is chat-only. See [Waiting for you](#waiting-for-you). |
| `wait_list` | Read waiting items (one by id, or those of a card or state), with the answer once there is one. Read only. It is how Claude answers "what is c37.w2?". |
| `wait_close` | Close an open item that you did not answer on the board: withdraw it, or note that you answered in the chat. |
| `board_open` | Return the board link. Starts the board again if it was stopped. |
| `board_stop` | Stop the board web page for every session. |
| `config_get` | Show the mode, the stages, the roles, where each came from and the paths of the config files. In [chat-only mode](#chat-only-mode) it shows both the fixed columns and roles and the task board's own stages and roles, which are kept for when it is turned on. |
| `config_set` | Change or reset the settings in the global or the project config file. Claude uses it only when you ask to set up or change the plugin. |

## Choosing the agent and model

A thread does not have to run on your session's model. Routine work, such as listing files or checking a fact, is done well and cheaply by a smaller model or by one of your own sub-agents. Claude decides this for you when it starts a thread, and you can always overrule it.

**Who decides, and when.** The main session. It chooses at the moment it starts the thread, because it is already writing the brief and knows the task; it costs nothing extra. This applies to `/thread:new` and to any thread Claude starts on its own. A thread started from a card on the board is not chosen for you: you pick an agent in the form, or "Same as session".

**A lane comes first when you or the project say so.** If your instructions (for example the project's `CLAUDE.md`) say which [delegation lanes](#delegation-lanes) suit which work, Claude calls `lane_list` and runs the thread on the matching lane, instead of choosing an agent or model. A lane cannot be combined with an agent, a model, an effort or `--full`. Without such instructions Claude never picks a lane on its own.

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

## Waiting for you

Sometimes Claude finishes work and then needs you: to check it, to answer a question, to pick an option, or to do something only you can do. A **waiting item** puts that on the card it belongs to, so the board shows it in one place, with the task and the milestone it belongs to, instead of leaving it in a long chat.

**The four kinds.** Each has its own icon and colour, and the board has a small colour guide (a legend) that appears next to the red pill while the filter is on.

| Kind | Icon, colour | You |
|---|---|---|
| **Question** | speech bubble, blue | type an answer |
| **Choice** | radio dot, purple | pick one option, or several when Claude allowed that (2 to 8 options) |
| **Review** | magnifier, teal | check Claude's work and answer **Approve** or **Request changes** |
| **To do** | empty box, amber | do something yourself, then tick **Done** |

Every kind except a question also takes an optional comment (for a question, the answer is the text). Cards in a Review stage and threads that have not been reported keep their own tags; the red count is for these explicit items only.

**How Claude raises one.** With the `wait_add` tool, on the card for the work (it adds a card first when there is none). It does this when it finished something you must check, has a question, or needs you to do something. So that it does not have to guess, the note every session gets at start (in task-board mode) says so in one sentence, and the `/thread:track` skill, which describes this too, loads when work is finished for you to check as well as on a new instruction. In the chat it gives one line, such as `Waiting on you: c37.w2`, instead of repeating the question. An item has an id made of the card and a number, `c37.w2`; the number is never reused. Claude cannot put an item on a milestone, a side thread cannot add one, and a chat-only project has none. Adding an item does not move the card, change its updated time or mark it as new from you.

**Where you see it.**

- A red pill in the toolbar, **Waiting for you** with a count of the open items in this project. Click it, or press `w`, to show only the cards that have open items; it combines with search, Threads only, the session filter and the milestone filter, and is remembered per project like them. It is hidden when nothing waits, and a filter that is on goes away with the last item.
- A red count on the project's tab, beside the running dot.
- A tag in a card's foot with one small icon per kind and the count, such as `2 waiting`. A milestone shows the total of its cards as a count to look at.
- The card's gear menu has **Answer waiting items (N)**, which opens the card's page at the section.

**Answering.** Open the card. A **Waiting for you** section is at the top of its page (the left pane of a task, idea or thread; on a narrow window, the Card or About tab). Each open item shows its kind, text, the session that asked and when, the control for its kind, and **Send** (Ctrl or Cmd + Enter sends). Once sent, the item folds into a muted line with a tick, your answer, and whether it was delivered. What you typed stays while you look around, and answering never moves the card.

**The id button.** Every item, open or answered, has a **Copy id** button. Paste the id in the main session to ask about it: Claude reads it with `wait_list` (`what is c37.w2?`).

**How an answer reaches Claude.** Nothing is pushed into a session. The board saves the answer, and the next time you send a message in the session that asked, a hook adds a line to it, for example `The user answered c37.w2 on the board ("Which retry limit?"): "5". Continue with it.` Only the session that asked gets it, once, and long answers are cut short with a pointer to `wait_list`. At most five answers go with one message; the rest follow with the next. If you answer in the chat instead, Claude closes the item with `wait_close`.

**When the session is gone** (closed, or cleared with `/clear`, which starts a new session id). The item stays **answered, not yet delivered**; its line says that the answer reaches the session that asked with that session's next message, when that session was last active, and that if it was cleared or closed any session can read the answer with `wait_list`: ask, for example, "what did I answer on c37.w2?". A session that starts in a task-board project also hears about it: if answered items were asked by another session and not delivered, its start note has one line with their count and a pointer to `wait_list`. An item can also be withdrawn by Claude when it is no longer needed.

Items are never deleted, only closed, and a card keeps at most 20 open ones. They are stored in the card's `waits` list in the project's state file; an older plugin version ignores them and keeps them. Waiting items are not shown in [chat-only mode](#chat-only-mode).

## Milestones

A **milestone** is a card that groups other cards. Tasks, ideas and threads can sit under it, so you can see one piece of work as a whole: what is in it, and how much is done. Without milestones the board is a flat list.

![A milestone's page: its cards grouped by stage, its progress, and Copy report](docs/milestone.png)

- **One level only.** A milestone cannot sit under another milestone, and only a milestone can be a parent. Every other card (task, idea or thread) can have at most one milestone.
- **A milestone is a normal card.** It has a title, a note and a stage, and sits in a column. Its own stage is yours to move; it does not move when its cards are done. A milestone cannot be started as a thread.
- **The tag.** A card under a milestone shows the milestone's title in square brackets after its title, such as `[Ship the invoice export]`, clipped to 30 characters. On the board it is a tag you can click to filter the board to that milestone.
- **Progress.** A milestone shows `3/5 done`: the number of cards under it whose stage is the **done** role's stage, out of all cards under it. By default that is Done. With the default roles a thread counts as done once it has ended, not when a turn has finished. (If you point the **review** and **done** roles at the same stage, a finished turn counts too.)
- **Filtering the board.** The toolbar has a **Milestone** select (All, each milestone by title, No milestone). It appears once a milestone exists and combines with search, the session filter and the threads-only filter. It shows the milestone card and the cards under it.
- **The report.** `/thread:board --parent <id>` prints the report for one milestone: a summary line, then the milestone and its cards grouped by stage. On the board, open the milestone: its page lists "Cards in this milestone" grouped by stage, each row linking to that card, and **Copy report** copies the same list as plain text.

### Flags

| Where | Flag | Effect |
|---|---|---|
| `/thread:add` | `--milestone` | The new card is a milestone. |
| `/thread:add` | `--parent <id>` | The new card goes under the milestone with this id. |
| `/thread:new` | `--parent <id>` | The thread goes under the milestone with this id. |
| `/thread:board` | `--parent <id>` | Show the report for this milestone. |

Without `--parent`, you can name a milestone in words ("add this to the invoice export milestone") and Claude finds its id with `board_list`. To put an existing card under a milestone, or take it out, ask Claude, or use the **Milestone** select on the card's page on the board, or **Set milestone** in the card's gear menu. Removing a milestone does not remove its cards; they stay, without a milestone.

### A worked example

```text
/thread:add --milestone Ship the invoice export
/thread:add --parent c12 write the CSV exporter
/thread:add --parent c12 idea: offer an Excel export too
/thread:new --parent c12 check how the export behaves with 100,000 rows
```

The milestone is `c12`. The milestone, the task and the idea start in New. After the thread has run and been ended, and the CSV task has moved to In progress, `/thread:board --parent c12` gives a report built from this list:

```text
Milestone c12 "Ship the invoice export": 1 of 3 done.
New (2)
- c12 [milestone] Ship the invoice export (1/3 done)
- c14 [idea] Offer an Excel export too [Ship the invoice export]
In progress (1)
- c13 [task] Write the CSV exporter [Ship the invoice export]
Done (1)
- c15 [thread:ended] Check how the export behaves with 100,000 rows [Ship the invoice export]

Stages, as id: label [what the plugin uses it for]:
- idea: Idea
- new: New [start]
- in_progress: In progress [working]
- review: Review [review]
- blocked: Blocked [blocked]
- done: Done [done]
```

The last block is how Claude knows your stage ids and which stage is used for what; it is there for every board, including an empty one.

`/thread:board` on its own prints the same kind of list for the whole board, with the milestone's progress and the tags.

The errors are plain: `milestone not found: c9`, `c3 is not a milestone`, `a milestone cannot have a parent`.

## Delegation lanes

A **lane** is a named setting from the separate *delegate* skills: which coding CLI does a job (the provider: `codex`, `agy`, `opencode` or `claude`), on which model, at which effort (or variant), and whether it may only read. Names such as `code-codex` or `ui-design` are yours to choose. A thread can run on a lane, and so can a task card that has one. This plugin only reads the lane config; it never writes it or its approval.

- **Where lanes come from.** The delegate skills keep them in `~/.config/delegate-skills/config.json` (all projects) and `<git root>/.delegate/config.json` (one project). The plugin asks the `delegate-setup` skill's script, `~/.claude/skills/delegate-setup/scripts/config.mjs load`, for the lanes in effect in the project, and keeps the answer for about 30 seconds. Running a thread uses the provider's relay, `~/.claude/skills/<provider>-delegate/scripts/relay.mjs`, which the same skills provide. Set `THREAD_DELEGATE_DIR` if the skills live elsewhere. Lanes whose provider is not one of the four above are left out.
- **They need the delegate skills.** Without them (or when the script fails or takes too long) the board shows nothing about lanes, `lane_list` says they are not installed, and a lane is refused. A card that already has a lane still shows its tag, marked **not found**.
- **A project's lane config must be approved.** A lane that comes from `.delegate/config.json` is usable only after you approve that file with the `delegate-setup` skill. Until then its lanes are **not approved**: nothing can be started or continued on one.

### Starting a thread on a lane

```text
/thread:new --lane code-codex find why the invoice total is off by a cent
/thread:new --lane review-ro --parent c12 review the retry logic
```

`--lane <name>` (the `lane` argument of `thread_start`) runs the thread on that lane. Claude can also choose a lane itself: it calls `lane_list` and passes a lane only when you or the project's instructions (your `CLAUDE.md`, for example) say which lanes suit which work; otherwise it keeps choosing the agent and model as described in [Choosing the agent and model](#choosing-the-agent-and-model).

- **What it runs.** A lane thread starts a fresh session on the lane's provider, with the same brief and task a normal thread gets, read-only unless you ask for write (`--write`). The plugin starts the provider's relay (`node <relay> --brief <file> --cd <project> --lane <name> --out-dir <logs folder> --timeout <the turn limit>`, plus `--read-only` for read mode; a codex lane in write mode passes `--sandbox <the lane's sandbox, or workspace-write>` on every turn, since codex applies a sandbox on a resumed turn only when one is passed) in the background. The plugin passes the brief in a file under the project's logs folder, never in its own arguments. A read-mode turn's prompt also says that the run is read-only and that the answer should come from reading and reporting, without trying to leave plan mode (the `claude` relay enforces read-only with plan mode). The `agy` relay, though, hands the brief to the `agy` program as an argument, so other programs on your machine can see it in the process list while an agy turn runs. The plugin never passes `--skip-git-repo-check` or a flag that skips permissions. When the relay exits, its `result.json` decides the turn: `completed` is a finished turn and its report is the result (or, if the provider wrote none, a one-line stand-in); anything else, or no result at all, is a failed turn. Its error is the status, then the relay's own error, else the last line of the provider's stderr, else the last failure the provider wrote into the turn's `events.jsonl` (codex's `turn.failed`, for example a model your account does not support), else the first line the relay itself printed, for example `codex failed: Not inside a trusted directory and --skip-git-repo-check was not specified.` (codex refuses to run outside a git repository).
- **Files the provider reports.** On a read-only turn, if the provider's relay reports that files may have changed (its read-only check is a tripwire for `agy` and `claude`, and an incomplete check counts too), the turn's report starts with one plain line saying so. On a write turn the report starts with one line, "Uncommitted changes in the working tree after this turn (from the relay): …", and the read-only line carries the same list. The relay builds that list from `git status` after the run, so it is everything uncommitted in the working tree, including changes from earlier turns and other threads, not only what this turn did. It shows up to eight names. `codex` and `opencode` read-only runs are enforced by the provider and report nothing of this kind.
- **Limits.** A lane cannot be combined with `--agent`, `--model`, `--effort` or `--full` (a copy of the conversation), and has no extra folders (`extra_dirs`). A **write** thread needs a lane that can edit files, and **agy lanes are read-only in this version**: agy's headless mode auto-denies every edit, and the only remedy is a flag that skips permissions, which the plugin never passes. A lane whose sandbox is `danger-full-access` is shown as "Full access (no sandbox)". Each of these is refused with a one-line message, as is a lane that is unknown, not approved, or whose provider's relay is not installed.
- **Follow-ups.** `/thread:continue` resumes the provider's own session, whose id is stored when a turn ends (on a failed turn too). The lane is read again at the start of each follow-up, so a changed model or effort applies; a lane that is now unknown, not approved, read-only for a write thread or missing its relay is refused with the same messages as on start, and so is one that now runs on another provider. Some providers can give no session (`agy` sometimes): that thread finishes its turn, but cannot be continued ("start a new thread instead").
- **Report and end.** `/thread:report` gives the digest as for any thread, with the lane named in its header. `/thread:end`, and a stop from the board, send SIGTERM to the relay, which stops the provider's process and writes its result; the thread's card moves to the done stage as usual. A turn also stops at its time limit (`THREAD_TIMEOUT_MS`, 20 minutes by default, passed to the relay as `--timeout`; the plugin's own limit sits a little after it).
- **What you see per provider.** Only a `claude` lane gives the turn its steps and token use, and only after the turn ends (the plugin reads the relay's `events.jsonl`, the same stream a normal thread produces); while it runs the Trace says so. `codex`, `agy` and `opencode` lanes give no steps and no token counts in this version: the Trace shows one line saying there are no live steps and that any steps shown come from the report, which appears when the turn ends.
- **Session hooks.** A claude lane starts a child `claude` session through the relay. It carries the same mark as a thread's own process (`THREAD_DEPTH=1`), so this plugin's hooks do not register it as a main session or show it the setup hint.

### Putting a lane on a card

`/thread:add --lane code-codex fix the rounding bug`, or ask Claude in plain words; `board_update` changes it and an empty lane removes it. Only tasks and ideas can have a lane, not milestones, and not threads (a thread gets its lane when it starts). A name that is not a loaded lane is refused with the list of valid names. The board itself cannot set or change a lane.

When a card with a lane is started as a thread with **Start as thread** on the board, it runs on that lane: the server takes the lane from the card, never from the request. The thread then holds the lane, and the card no longer has a separate one.

### On the board

- **Tag.** A card with a lane has a tag in its foot with a hexagon icon, the lane's name and its provider, such as `code-codex · codex`. For a task or idea whose lane is not in the loaded lanes the tag reads `name · not found`, and if it is not approved `name · not approved` (a long name is cut short, never these words); hover for a sentence about what to do. A thread's tag comes from the lane it started on, whatever the lanes are now. In `board_list` the lane follows the title, as `{lane: code-codex}`.
- **Card page.** The details list shows Lane, Provider, Model, Effort (or Variant, for a lane that has one), Access (**Read-only**, **Can edit files** or **Full access (no sandbox)**; a read-mode thread and every agy lane show Read-only) and Source (**This project** or **All projects**); a thread's page adds **Follow-up** (Possible, or why not: no session from the provider, or a lane that is no longer found, approved, on the same provider or installed, in which case the message box is off too) and shows the provider's session id. For a lane that is not found or not approved it shows the Lane row and a one-line hint. A card without a lane shows none of this. The lane cannot be edited on the page.
- **Start as thread, for a card with a lane.** The step says "Runs on lane `<name>` · `<provider>`" with its model and effort, and that the lane's CLI sends the brief and the files it reads to that provider. It says which provider's session it starts, has no agent choice and no Full copy, and offers only Read-only when the lane is read-only or runs on agy. If the lane is not found or not approved, the Start button is off and says why.
- **Known limits.** A cheap or low-effort lane can answer without doing the work (a low-effort codex lane once replied without reading any file); the report says what the provider said and nothing more, so check it against the working tree. A provider's step map is read whether it is fenced as `thread-map`, `threadmap` or `thread_map`; a map that cannot be read is dropped from the report instead of being shown raw (for every thread, not only lane threads).
- **Known gap.** A session still running an older plugin version ignores `card.lane` in its "Start as thread" and runs the thread on Claude. An older version also refuses a follow-up on a lane thread ("has no session yet"), because the thread's own `sessionId` stays empty. When an older version deletes a lane thread's card it cannot delete the thread's log folders (`cN.tM.lane`, which hold the brief and the provider's own logs), so they stay until a session on this version next sweeps the logs: it does so when a card is removed and when the plugin's server or board starts for a project, removing only log entries of cards that no longer exist. If the plugin process is killed outright while a turn runs, the relay may keep running until it finishes or times out.

## Setup

`/thread:setup` lets you choose how the plugin behaves. You do not have to run it. If you never do, everything works with the defaults: the task board is on, with six stages.

Claude runs it as a short conversation, one question at a time, using Claude Code's question popup when the client has one. Each choice comes with a one-line explanation, and the default is listed first. It asks:

1. **Where the setting applies.** Every project (global), or only this project. Either way, cards and threads are always stored per project; this choice only decides where the *settings* live.
2. **What you use thread for.** Threads only ([chat-only](#chat-only-mode): side threads, no task board), or threads plus the task board (cards, ideas and milestones).
3. **Stages, only for the task board.** The default six, or your own. If your own, you describe how you work in your own words and Claude helps you design the stages. It proposes 2 to 10 stages, each with a short id and a label, and says in plain words which stage each part of the plugin will use: "a new card lands in To do", "a running thread sits in Doing". You change the list until you agree. See [Custom stages](#custom-stages) for the rules.

Then Claude saves the settings, reports the result in a few lines, and tells you that `/thread:setup` can be run again at any time. Setup never changes a card.

```text
/thread:setup            the conversation above
/thread:setup --show     print the current settings and stop
/thread:setup --reset    ask which settings to delete (every project, or this one), delete that file, and stop
```

`--show` prints the mode, the stages in order, the role of each stage, where each setting came from (default, the global file, or the project file), and the paths of both files. `--reset` deletes one settings file; cards and threads are not touched, and the plugin falls back to the other file, or to the defaults.

**The one-time hint.** In the first session after you install the plugin, Claude is told that the plugin has not been set up and, when it does not interrupt your request, mentions `/thread:setup` once. This happens once per machine, and only while no settings file exists. If you ignore it, the plugin carries on with the defaults and does not mention it again.

### Where the settings live

Two optional JSON files, with the same shape:

| File | Applies to |
|---|---|
| `<data dir>/config.json` | Every project that has no setting of its own for that field. |
| `<data dir>/projects/<key>/config.json` | That project only. |

`<data dir>` is the plugin's data directory, otherwise `~/.claude/thread-data` (see [Configuration](#configuration)). `/thread:setup --show` prints both paths, so you do not have to work out `<key>`.

The effective settings for a project are the defaults, then the global file, then the project file. A field in a later file replaces the same field from an earlier one. The `mode` is chosen on its own. `stages` and `roles` always come together from one file, never mixed from two. A file that cannot be read, or that fails the checks below, is ignored, with a line on the plugin's stderr log; it does not stop anything.

Every field is optional. Here is a complete file:

```json
{
  "mode": "tasks",
  "stages": [
    { "id": "todo", "label": "To do" },
    { "id": "doing", "label": "Doing" },
    { "id": "check", "label": "Check" },
    { "id": "done", "label": "Done" }
  ],
  "roles": { "start": "todo", "working": "doing", "review": "check", "blocked": "doing", "done": "done" }
}
```

You can edit these files by hand, but `/thread:setup` checks what you give it and writes the file for you.

## Custom stages

The **stages** are the board's columns. The default six, in order:

![A project with four stages of its own: To do, Doing, Checking, Done](docs/stages.png)

| Id | Label |
|---|---|
| `idea` | Idea |
| `new` | New |
| `in_progress` | In progress |
| `review` | Review |
| `blocked` | Blocked |
| `done` | Done |

You can replace them with your own, set with `/thread:setup` (global or per project). The limits:

- 2 to 10 stages.
- Each **id** is lowercase letters, digits and underscores, starts with a letter, and is at most 24 characters. Ids are unique. `to_do` and `in_review` are valid; `Done`, `2nd` and `in progress` are not.
- Each **label** is the name shown on the board and in lists: 1 to 30 characters after trimming.
- Cards keep the id of the stage they are in, not its label, so you can rename a label without moving any card.

### Roles

Some of the plugin's own behaviour has to know which stage means what. The **roles** say so. Each role points to one stage id.

| Role | Used for |
|---|---|
| `start` | Where a new card lands when no stage is given. Also where a card is shown when its own stage no longer exists. |
| `working` | A thread whose turn is running. |
| `review` | A thread whose turn has finished, waiting for you to look. |
| `blocked` | A thread that failed. |
| `done` | A thread that was ended. Also what counts as done for a milestone's progress. |

Thread cards follow their thread through these roles; you do not move them by hand. Several roles can point to the same stage.

**Default roles.** With the six default ids, in the default order (their labels may differ), the roles are `start` New, `working` In progress, `review` Review, `blocked` Blocked, `done` Done. With your own stages, when you give no roles, the plugin uses the order (n is the number of stages):

| Role | Stage |
|---|---|
| `start` | the first |
| `working` | the second (the first when there are only two) |
| `review` | the second to last when n is more than 2, else the last |
| `blocked` | the same as `working` |
| `done` | the last |

For the four stages in the example above that gives start To do, working Doing, review Check, blocked Doing, done Done. A `roles` object that names only some roles is filled in from this table (or from the default roles, when the stage ids are the six default ids in the default order). Roles belong to the stages in the same file: a file with `roles` must also list its `stages`. Giving new stages without roles drops the old roles, so they are never carried over to stages that may not exist. Changing some roles later keeps the others.

### Cards whose stage was removed

When you change the stages, a card may be left with a stage that no longer exists. It is not moved and nothing in the data is rewritten. It is *shown* in the **start** stage. If you bring the stage id back, the card returns to it. Moving the card yourself writes its new stage. A thread card is different: it is always shown in the stage for its current state, so it follows a change of roles at once. The result of a setup that changes the stages says how many cards of the current project are in this state; a global change can affect other projects too, and those are not counted.

## Chat-only mode

If all you want is side threads, you can switch the task board off. Run `/thread:setup` and choose threads only, for every project or for one.

**What is switched off.**

- Adding cards. `board_add` and `/thread:add` are refused with "The task board is off for this project (chat-only). Run /thread:setup to turn it on." On the board page, adding a card is refused the same way (HTTP status 409), and the **New card** button is not shown.
- Editing and removing task, idea and milestone cards. They give the same message.
- Starting a card as a thread from the board, since no task cards are shown.
- The note on your next message that tells Claude about new cards you added on the board.
- `board_list` lists thread cards only and says in a line that the project is chat-only.

**What still works.** Everything about threads: `/thread:new`, `/thread:continue`, `/thread:report`, `/thread:status`, `/thread:end`, the board page with thread cards, full-window threads, follow-ups from the board, and `/thread:board`. Thread cards can still be updated and removed. On the board, only thread cards are shown, in three fixed columns, **New**, **Review** and **Done**, whatever stages the task board has: a running thread is in New, a thread whose turn finished or failed is in Review, an ended thread is in Done. A one-line note under the toolbar says that the task board is off and `/thread:setup` turns it on. The stages you set for the task board are kept as they are (`config_get` shows both) and come back when you turn the board on. [Waiting items](#waiting-for-you) are not shown.

**Nothing is deleted.** Cards that already exist stay in the project's state file. Turn the board back on and they reappear.

**To turn the task board back on.** Run `/thread:setup` and choose threads plus the task board. If chat-only comes from a settings file you no longer want, `/thread:setup --reset` for that scope also works. `/thread:setup --show` tells you which file the mode came from. Or set `"mode": "tasks"` in the file.

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

## The board

`/thread:board` prints a link such as `http://127.0.0.1:47800/?t=<token>#/<project>`.

- **One board, served by one session.** The first Claude Code session to start serves the page and the others share it. When a session on a newer plugin version starts, or runs `/thread:board`, it replaces a board served by an older version; a session that is already running does the same within a few seconds. So after an update you reload one session's window, then the browser tab. Sessions that were open before the update keep running the old plugin code until their window is reloaded: until then they ignore newer settings such as your own stages or chat-only mode. A board from before 0.8.2 cannot be replaced this way (see [Troubleshooting](#troubleshooting)). `/thread:board --stop` stops the page for every session until someone runs `/thread:board` again; cards and threads are not touched.
- **One board for every project.** Each project has a tab, with a dot when one of its threads is running. A project whose folder was deleted is shown read-only and can be forgotten, which removes its saved cards and logs.
- **Columns follow your stages.** There is one column per stage, in order, labelled with the stage labels. With the defaults there are six; with [custom stages](#custom-stages) there are 2 to 10. In [chat-only mode](#chat-only-mode) there are three fixed columns instead: New, Review and Done.
- **Cards** show their id, kind (task, idea, milestone or thread) and title. A card under a milestone shows a tag with the milestone's title; click it to filter the board to that milestone. A milestone card shows its progress, such as `3/5 done`, with a thin bar. A task or idea with a [delegation lane](#delegation-lanes) shows a lane tag (`code-codex · codex`) in its foot. Thread cards also show their state, the number of turns, the session that started them, a **Not reported** tag when they hold a result the main session has not pulled, the tokens they have used, and their agent when they run as one.
- **Waiting for you:** a red pill in the toolbar, a red count on the project's tab, a tag on each card that has open items and a section on the card's page; see [Waiting for you](#waiting-for-you).
- **Gear menu:** every card with an action has a small gear that opens a menu of its actions, so you do not have to open the card first. Each action does what the same action does on the card's page, with the same confirmation step.
  - A card with open [waiting items](#waiting-for-you) starts its menu with **Answer waiting items (N)**, which opens the card's page at that section.
  - A **thread**: **End thread**, **Report to main session** (or **Cancel queued report**), **Delete**. End thread is not offered once the thread has ended and its confirmation names the stage the card moves to (the one with the done role); Report only while the main session has not pulled the result; Delete is greyed out while a turn is running.
  - A **task or idea**: **Move to** each stage (the current one is marked and cannot be chosen), **Set milestone** (each milestone, or No milestone; shown once a milestone exists), **Start as thread** and **Delete**. Start as thread opens the card's page at the start step, where you choose the session, Brief or Full copy, access and agent.
  - A **milestone**: **Copy report** and **Delete**.
  - A card with nothing to offer has no gear: on a project whose folder is missing (read-only) only a milestone keeps one, for Copy report.
  - With the keyboard, Tab to the gear and press Enter or Space (holding the key does not choose anything); the arrow keys, Home and End move through the menu, which scrolls to the focused item when it is long, Enter chooses, Esc closes it and returns to the gear, and Tab closes it. Clicking elsewhere closes it too. The gear never starts a drag or opens the card.
- **Toolbar:** search by id, title or note; show threads only; **Waiting for you** (the red pill; only while something waits); filter by the session that started them; filter by **Milestone** (shown once a milestone exists; All, each milestone by title, or No milestone); add a card. A button in the header switches between light and dark.
- **Plugin version:** the header shows the version that served the page. If the server changes to a different version while the tab stays open, a note under the toolbar says so. When the board is now served by a newer version, the note shows both versions and a **Reload** button to load the current page. When it is served by an older version (a session that has not been updated took over), the note says so and tells you to run `/thread:board` in an updated session and then reload the page; there is no Reload button, since reloading would only show the older page. The note gives way to the older-session note (about missing stages and milestones) when that one is showing.
- **Task and idea cards** open in the same three-pane workspace as a thread (see [Task and idea pages](#task-and-idea-pages) below). **Milestone cards** open as a full page where you edit the title, note and status, with a list of the milestone's cards, grouped by stage, each row a link to that card, and **Copy report**. Drag a card to another column to move it to that stage. In the new-card form, **Kind** can be task, idea or milestone, and a task or idea can be given a milestone.
- **Start as thread** turns a task or idea card into a thread (a milestone cannot be). You choose the session it reports to, **Brief** or **Full copy**, read-only or able to edit files, and an agent from your `.claude/agents/` (or "Same as session"). With Brief, the title is the task and the note is the brief, since nobody writes one on the board. With Full copy, the title and note are the task.
- **Thread cards** open full-window:
  - **Centre:** the conversation, and a box to send a follow-up. A running turn shows its steps as they happen. A finished turn folds them into one line with its duration and tokens, such as "6 steps · 3m 00s · 48k tokens".
  - **Left:** the thread's session id, the session that started it, a `claude --resume <id>` command that opens the thread as a normal conversation in a terminal, its context (Brief or Full copy), its agent or model and effort (a lane thread: the lane's provider, model, effort or variant, access, source and whether a follow-up is possible, and the provider's session id in place of a `claude --resume` command), its milestone (changed with a select that saves at once), the tokens used, the brief it was given, the latest digest, and every decision across turns. The report command has a copy button. **Report to main session** queues the report: it is delivered with your next message in the session that started the thread, and repeated until that session makes it.
  - **Right:** the trace, a timeline of what the thread did, labelled Did, Found, Decided, Changed and Open, with file references. Clicking a step scrolls the conversation to that turn. For a lane thread it opens with one line about what its provider shows (see [Delegation lanes](#delegation-lanes)).
- **Keys:** `/` focuses search, `n` adds a card, `w` shows or hides only the cards that wait for you, `Esc` closes a panel.

### Task and idea pages

A task or idea card opens the same way a thread does, so you can see what is happening in the task, what an agent is doing, and trace it.

- **Left, "Card":** the editable title, note, status and milestone, with **Save**, **Cancel**, **Start as thread** and **Delete** pinned under them (a card with a lane also lists the lane's provider, model, effort, access and source, read-only). Below the form: a summary of the card's agent runs (agent type, running or finished, tokens, when; click one to jump to it) and the card's **History**.
- **Centre, "Agent runs":** each sub-agent run on the card as a turn: the prompt the main session gave it, its steps live while it runs, then the agent's final report. A finished run folds its steps into one line, such as "4 steps · 12s · 27.4k tokens". A card no agent has worked on says so in one line and how to get one. There is **no message box**: only the main session can talk to a sub-agent. **Start as thread** is how you get an agent you can message.
- **Right, "Trace":** one block per run with a step for each tool call (Read, Ran, Edited, Searched, Fetched), clipped to one line each; a call that failed is marked. Clicking a step scrolls to its run.
- **History:** created, moved between stages, and edited (title, note, milestone, lane), each by You or Claude with the time. It keeps the last 50 entries. It records changes made through the board or Claude's tools; a card made before this feature has only its creation, and a session still running an older plugin version does not add to it.
- On a narrow window the three panes become tabs (Agent runs, Card, Trace); a card with no run opens on Card.

**Linking a run to a card.** The main session starts the Agent tool call's `description` with the card id in brackets, for example `[c24] fix the tax rounding`. The `board_add` reply, `/thread:track`, `/thread:add` and `/thread:board` remind Claude to do this whenever it hands a card's work to a sub-agent; you can also ask for it in words ("delegate c24, and put its id first in the description"). Two small hooks, `SubagentStart` and `SubagentStop`, notice the marker: at start they add a running run to the card, at stop they record the agent's report, step count and tokens and keep a snapshot of its steps (the stop hook waits about half a second for the agent's last transcript line, only for a run that is on a card). Both stay silent, never print into the session, and do nothing for a description without the marker, for a card that does not exist in this project, for a thread's own process, or in [chat-only mode](#chat-only-mode).

What is and is not shown:

- Only runs whose description starts with `[cN]` show. Work the main session does itself, and a delegation without the marker, shows nothing on the card (the card's History still shows its moves and edits).
- A card that has become a thread (Start as thread) or is a milestone does not take runs.
- What the code does for two cases nobody has seen in a live Claude Code session, so both are untested there: an agent that starts again with the same id (for example after it was sent a message) has its run reopened instead of getting a second one, and an agent started by another sub-agent is ignored.
- The steps come from the agent's own transcript, which Claude Code keeps under `~/.claude/projects/` (under `$CLAUDE_CONFIG_DIR/projects/` when that variable is set). That folder layout is not documented, so a future Claude Code version may change it and the page would then show no steps (the prompt, the report and the other figures still come from the hooks). Claude Code can also clean transcripts up, which is why a snapshot of each finished run's steps is kept in the project's logs folder (`cN.rM.activity.jsonl`, removed with the card). A long run keeps its newest 2000 steps and tool results, with a note that earlier ones are not shown; its step count is still the real one.
- The card's record keeps only a short preview of each run's prompt and report, with the step and token figures. The full texts are files in the logs folder (`cN.rM.prompt.txt`, `cN.rM.report.txt`), which the page loads when you open the card, so a card with many runs stays small.
- **Mark as stopped.** A running run shows a small **Mark as stopped** button. If the agent's transcript has had no new activity for 10 minutes, the run also says "No activity for N min; it may have stopped." Use the button when a session was closed or crashed while the agent ran, or its stop was lost: the run becomes Ended, not successful, with a note, and nothing else on the card changes. If the agent's real stop arrives later it closes the run normally.
- The board reads only the transcript file recorded on a run, and only when it is `agent-<id>.jsonl` under `~/.claude/projects/` and not behind a symlink; it never takes a path from the page.

![Starting a card as a thread: session, Brief or Full copy, read-only or editing, and the agent](docs/start-as-thread.png)

![The board in the dark theme](docs/board-dark.png)

## How threads work

- **Context.** By default a thread starts a fresh session and knows only the brief and the task. It also loads the project's `CLAUDE.md` on its own, and sees files as they are on disk when it reads them. With `--full` it starts as a copy of the main session at that moment. A thread on a [delegation lane](#delegation-lanes) is always a brief thread: its provider's CLI knows only the brief and the task. Either way it does not see anything the main session does afterwards, and neither do its follow-ups: a follow-up resumes the thread's own session. Continue a thread for the same task; start a new one for a new task. Claude tells a continued thread what changed with a [catch-up note](#catch-up-notes-on-follow-ups).
- **Model and effort.** With `/thread:new`, Claude chooses a sub-agent or a model by how hard the task is, unless you name one; see [Choosing the agent and model](#choosing-the-agent-and-model). A thread with neither an agent nor a model runs with the same model and effort as the main session. An agent brings its own model, effort and instructions, on every turn.
- **Hand-back.** A thread never writes into the main session. Each of its replies ends with the four-heading digest and an ordered step map. `/thread:report` gives the digest to the main session; the step map is only drawn on the board.
- **Reported status.** A thread counts as reported once the session that started it has pulled its newest result. A follow-up that produces a new result makes it "not reported" again. A follow-up that fails leaves it as it was.
- **Announcements.** When a thread finishes, the session that started it is told on your next message, not in the middle of a turn.
- **Read and write.** A read thread may read and search the project, search and fetch the web, run the read-only shell commands Claude Code allows without asking (`ls`, `cat`, `git log` and the like) and report. It cannot edit files. The plugin guarantees this by passing `--permission-mode dontAsk` (Claude Code refuses everything that would need a prompt) and `--disallowedTools Edit Write NotebookEdit`, whatever your own Claude Code settings say: a default mode that skips prompts, in your user settings, does not reach a read thread, and a deny rule beats any allow rule your settings hold for those tools. It is still not a sandbox: a shell command or MCP tool that your own `permissions.allow` rules (or `THREAD_ALLOW_TOOLS`) approve by name can still change things. Write mode passes `--permission-mode acceptEdits`, so it edits files in the shared working tree.
- **Permissions.** A thread runs headless, so it cannot answer a permission prompt. Anything that would prompt is refused, except web search and web fetch, which are pre-approved, and folders you named in the task.
- **Cost and time.** Every thread turn is a model call over the thread's own conversation. Inside a turn, every step the thread takes sends that conversation again. A brief thread starts small. A full thread starts with the whole main session (after a compaction, with the summary and what followed), so one started late in a long session costs accordingly. Each turn's token counts (input, cache read, cache write, output) are recorded; the board and `/thread:status` show each thread's total. Threads started before version 0.7.0 have no token figures. A turn is stopped after 20 minutes.
- **Limits on threads.** A thread cannot start, continue, report or end threads.

## Several sessions and projects

- Each project has its own cards and its own milestones. Sessions in one project share them.
- Settings can be shared across projects (the global file) or set for one project; cards and threads never are.
- Reporting or ending a thread from a session that did not start it asks for confirmation first.
- A sub-agent run is recorded on the card of the project the main session belongs to; a `[cN]` that names no card in that project is ignored.
- A [waiting item](#waiting-for-you) is answered on the board but delivered only to the session that asked it, with that session's next message. Another session sees it with `wait_list`.
- Thread cards are labelled with the name of the session that started them: Claude Code's title for the session, otherwise the start of its first message, otherwise a short id.

## Security

What the plugin runs, sends and stores:

- **Runs on your machine:** a local MCP server and four hooks (at session start, on each prompt, and when a sub-agent starts or stops), all plain Node scripts in this repository. The two sub-agent hooks run in every session. `SubagentStart` reads the project's `state.json` and settings and, only if the project has a task or idea and is not chat-only, starts a short background Node process and returns at once (Claude Code writes the agent's `agent-<id>.meta.json` file, which holds the description, only after the start hooks have returned, so the hook cannot wait for it). That process waits up to 5 s for the meta file and, when the description starts with `[cN]` for a task or idea of the project, writes the run into `state.json`, plus the prompt file in the logs folder. `SubagentStop` always reads `state.json` to see whether the agent has a run, and reads the meta file when it has none; for a tracked agent it also reads the agent's transcript, then writes the run, the snapshot and the report file. Without a marker they write nothing and print nothing. For each thread turn it starts the `claude` CLI in the background, in your project folder, or, for a thread on a [delegation lane](#delegation-lanes), the provider's relay script from the delegate skills, which starts that provider's CLI. To list [delegation lanes](#delegation-lanes) it runs the `delegate-setup` skill's `config.mjs load` script with Node, without a shell and with a time limit, at most once every 30 seconds per project; the script only reads, and the plugin never writes the lane config or its approval.
- **Flags it passes to a thread:** read mode passes `--permission-mode dontAsk` and `--disallowedTools Edit Write NotebookEdit`, so a read thread stays read-only even when your own Claude Code settings skip permission prompts; write mode passes `--permission-mode acceptEdits`. It never passes a flag that skips permissions. Every thread gets `--allowedTools WebSearch WebFetch` (see `THREAD_ALLOW_TOOLS`), and `--add-dir` for folders you named. It never edits your Claude Code settings.
- **Reads:** the end of the main session's transcript, to get the session's title and its model and effort; for a sub-agent run recorded on a card, that agent's transcript and meta file under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) (read-only, only the file recorded on the run, never a symlink or a path from the board page); the agent files in `.claude/agents/`; the two `config.json` settings files; and the output of the delegate script (lane names, providers, models, efforts and whether a project's lane config is approved).
- **A lane run sends your work to another company.** A thread on a lane runs `codex` (OpenAI), `agy` (Google Antigravity), `opencode` (whatever provider its model uses) or a separate `claude` session, through the delegate skills' relay. That CLI sends the brief, your task and whatever files it reads to its own provider, under that provider's terms; the plugin does not control or see this. A write-mode lane lets that provider's CLI edit files in your project and, for `codex` and `claude` lanes, run shell commands there, under that CLI's own sandbox and permission rules and not Claude Code's; a write-mode `opencode` run approves its own actions without asking, and a codex lane whose sandbox is `danger-full-access` has no sandbox at all. The board can start such a run: **Start as thread** on a card that has a lane runs on that lane, in write mode if you choose it in the start step (the lane comes from the card, not from the page, and the page cannot set one). Use read mode for a lane unless you want edits, and do not give a lane to a card whose note should not leave your machine.
- **Sends nothing itself.** The plugin makes no network requests and has no telemetry. Its only listener is the board on `127.0.0.1`, and the board page loads nothing from the internet. Threads are ordinary Claude Code sessions, so they talk to Anthropic as any session does and can search and fetch the web.
- **Stores,** all in the data directory on your machine:
  - each project's cards, thread replies and logs (`projects/<key>/state.json` and `logs/`), including each card's sub-agent runs (a preview of the prompt and report, tokens, the path of the agent's transcript), its history, and, in the logs folder, each run's full prompt, full report and a snapshot of its steps;
  - each card's [waiting items](#waiting-for-you) and your answers to them, in the same state file;
  - the settings files, `config.json` (global) and `projects/<key>/config.json`, if you ran `/thread:setup`;
  - `setup-hint`, an empty marker file that records that the setup hint was shown;
  - `board.token`, the board's access token;
  - `board.stopped`, a marker that exists while the board is stopped with `/thread:board --stop`.

- **Web access is pre-approved for threads, with no prompt per site.** A full thread holds your whole conversation, and any thread can read the project, so a malicious page could try to talk it into sending that content somewhere. If that matters for your project, set `THREAD_ALLOW_TOOLS=none`.
- **The board is local.** It listens on `127.0.0.1` only, checks the request's host and origin, and requires the access token that is in the link from `/thread:board`. The token is stored in `board.token` in the data directory, readable only by you. The board page cannot change the settings. Its only writes besides cards and threads are your answers to [waiting items](#waiting-for-you), through `POST /api/p/<project>/cards/<card>/waits/<item>`, which passes the same token, host, origin and JSON checks as every write, takes only an answer for an item that is still open (the text, the chosen options, the tick or the verdict, and a comment), validates it for the item's kind and writes nothing else. They change through `/thread:setup` (Claude calls the `config_set` tool, which a side thread is not allowed to use) or by editing the files yourself.
- **Read mode keeps a thread from editing files, but is not a sandbox**, as described in [How threads work](#how-threads-work): a shell command or tool that your own allow rules approve by name still runs.
- **Thread and card contents are stored unencrypted** in the data directory, including each thread's replies. On macOS and Linux the data directory and the folders in it are readable only by you (mode 0700) and the files the plugin writes are 0600: the state, settings, logs, briefs, run prompts and reports, and the board token. The plugin makes the folders owner-only when it creates them and, once each time a session starts its MCP server, narrows the ones an older version made with the default modes. It changes only what you own, follows no symlink, skips hard-linked files and touches nothing outside the data directory; when `THREAD_DATA_DIR` names a folder, only the plugin's own files and its `projects` folder in it are changed, not the folder itself. A session still on an older plugin version writes new files with the default modes until a newer session next starts, so the owner-only folder is what keeps them private in the meantime. On Windows it does nothing of this kind, and a filesystem that ignores modes (some network or FAT-style mounts) keeps whatever it gives.

## Configuration

Behaviour of the board and the stages is set with [`/thread:setup`](#setup). Everything else is set with environment variables, in your shell or under `env` in `~/.claude/settings.json`.

| Variable | Meaning |
|---|---|
| `THREAD_ALLOW_TOOLS` | Tools pre-approved for threads, comma separated. Default `WebSearch,WebFetch`. `none` pre-approves nothing. |
| `THREAD_TIMEOUT_MS` | Longest a single thread turn may run. Default `1200000` (20 minutes). A lane turn passes it to the relay as `--timeout`. |
| `THREAD_BOARD_PORT` | First port the board tries. Default `47800`; up to 20 ports from there. |
| `THREAD_NO_HTTP` | Set to `1` to run without the board page. |
| `THREAD_DATA_DIR` | Where cards, thread results, settings and logs are kept. Default is the plugin's data directory, otherwise `~/.claude/thread-data`. |
| `THREAD_LOCK_WAIT_MS` | How long to wait for the state lock. Default `5000`. |
| `THREAD_CLAUDE_BIN` | Binary to run in place of `claude`. Used by the tests. |
| `CLAUDE_CONFIG_DIR` | Set by Claude Code's own users, not by this plugin: when it is set (to an absolute path), sub-agent transcripts are looked for in `$CLAUDE_CONFIG_DIR/projects` instead of `~/.claude/projects`. |
| `THREAD_CLAUDE_PROJECTS_DIR` | Test-only: replaces both as the only place the board and the sub-agent hooks accept a sub-agent transcript from. Tests and demos set it; leave it unset. |
| `THREAD_DELEGATE_DIR` | The folder that holds the `delegate-setup` skill and the providers' relays (`<provider>-delegate`). Default `~/.claude/skills`. |

Set by the plugin itself, not by you: `THREAD_PROJECT_DIR` (the project a server belongs to) and `THREAD_DEPTH` (marks a thread's own process). `CLAUDE_CODE_SESSION_ID` is used as a fallback when a tool call carries no session id.

Files in the data directory:

```text
<data dir>/
  config.json                  global settings (optional)
  setup-hint                   marker: the setup hint was shown
  board.token                  the board's access token
  board.stopped                exists while the board is stopped
  projects/<key>/
    state.json                 cards and threads of one project
    config.json               settings for that project (optional)
    logs/                      each thread's raw output, and for a card's sub-agent runs cN.rM.activity.jsonl (steps), cN.rM.prompt.txt and cN.rM.report.txt
```

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| A thread fails with "claude CLI not found on PATH" | The standalone CLI is not installed or not on `PATH` for Claude Code. Install it and restart. |
| A full thread fails with "No conversation found with session ID" | The session it was copied from no longer exists, for example after its history was cleared. Start the thread again from the current session. Brief threads do not depend on the old session. |
| A read thread says a command was refused ("permission denied", "don't ask mode") | Read mode runs with `--permission-mode dontAsk`: only reading, searching, web search and fetch, and the read-only shell commands Claude Code allows without asking run; any other command is refused, since a headless thread cannot answer a prompt. Ask for a write thread (`--write`) if the work needs it, or add an allow rule for that exact command to your Claude Code permissions. |
| Another user or a service account of yours cannot read the plugin's data folder, or a backup or sync tool reports permission errors on it | The data folder and what is in it are owner-only (0700 and 0600) on macOS and Linux. Run that tool as the same user, or copy the files out as that user. The plugin does not loosen the modes. On a filesystem that ignores modes (some network shares and FAT-style disks) the modes cannot be applied, and the plugin carries on without them; keep the data folder on a local disk (`THREAD_DATA_DIR`). |
| Starting a thread fails with "Unknown agent" | The name is not a file in the project's `.claude/agents/` or in `~/.claude/agents/`. The message lists the names that exist. Built-in and plugin agents cannot run a thread. |
| Claude picked an agent or model you did not want | Name it yourself with `--agent` or `--model`. If it keeps happening, make the agent's `description` say what it is for and what it is not for; that text is all Claude chooses by. See [Choosing the agent and model](#choosing-the-agent-and-model). |
| Starting a thread fails with "give an agent, or a model and effort, not both" | An agent brings its own model and effort. Drop `--model` and `--effort`, or drop `--agent`. |
| `board_add` or `/thread:add` says "The task board is off for this project (chat-only)" | The project is in [chat-only mode](#chat-only-mode). Run `/thread:setup --show` to see which file sets it, then run `/thread:setup` and choose threads plus the task board, or `/thread:setup --reset` for that file. Existing cards were not deleted. |
| A card moved to another column after I changed the stages | Its stored stage is no longer one of your stages, so it is shown in the start stage. Nothing was rewritten. Bring the stage id back and the card returns, or move the card. Setup's result says how many cards of the current project are affected. A thread card always sits in the stage for its state, so it moves when you change the roles. |
| Setup refuses my stages or roles | A message says why: the list must have 2 to 10 stages; an id must be lowercase letters, digits and underscores, start with a letter and be at most 24 characters, and be used once; a label must be 1 to 30 characters; a role must point to one of the stage ids. Fix the list and run `/thread:setup` again. |
| My settings file seems to be ignored | A file that is not valid JSON, or that fails the checks above, is ignored as a whole. `/thread:setup --show` marks it as ignored and gives the reason. The plugin does not write over a file it could not read: correct it by hand, or run `/thread:setup --reset` for that scope and set it up again. |
| The setup hint never appeared | It is shown once per machine, in the first session after install, and only while no settings file exists. If a session already showed it, `setup-hint` exists in the data directory; delete that file to see it again. Claude is told to mention it when it does not interrupt your request, so it can also pass unnoticed. You never need the hint: run `/thread:setup` whenever you like. |
| An error says "milestone not found", "is not a milestone" or "a milestone cannot have a parent" | `--parent` takes the id of a milestone card in the same project. Check the id with `/thread:board`. A milestone cannot have a parent. |
| A lane is refused, or a card's lane tag says "not found" or "not approved" | Lanes come from the delegate skills; see [Delegation lanes](#delegation-lanes). "delegate skills ... not found": install them (or set `THREAD_DELEGATE_DIR`). "unknown lane": the message lists the valid names. "not approved": approve the project's lane config with the `delegate-setup` skill. "relay ... was not found": install the provider's `<provider>-delegate` skill. Lanes are read again at most every 30 seconds. |
| A lane thread fails, or says "wrote no result" | The error holds the relay's status and the reason: its own error, else the last line of the provider's stderr, else the first line the relay printed (for example `codex failed: Not inside a trusted directory and --skip-git-repo-check was not specified.` when the project is not a git repository, which codex requires; run `git init` or use another lane), or `wrote no result: ...` with the relay's first stderr line, such as an unapproved project config. The relay's artifacts for each turn are in the project's logs folder in the data directory (`cN.tM.lane/`). Fix the cause (login, model name, approval) and send a follow-up, or start a new thread. |
| "agy lanes are read-only in this version" | agy's headless mode cannot ask for permission, so it denies every edit; the plugin offers only read-only runs on an agy lane and never passes a flag that skips permissions. Use a codex, opencode or claude lane for edits. |
| A lane thread's page says a follow-up is "Not possible" and its message box is off | The provider gave no session, or the lane is no longer usable: not found, not approved, now on another provider, read-only for a write thread, or its relay is missing. The page says which. |
| "cannot continue: its lane ..." or "this thread's lane cannot run" | The thread's stored lane record is unusable (an unknown provider, an invalid name). Nothing is run, and `claude` is never used in its place. Start a new thread. |
| `thread_report` says "has no successful turn yet" | The message ends with the last turn's error when that turn failed, for example `its last turn failed: codex failed: ...`. |
| "has no session to continue: the ... provider gave none" | Some providers return no session id for a run (`agy` sometimes). That turn's report is fine, but the thread cannot be continued: start a new thread. |
| "card cN is a milestone and cannot be started as a thread" | Milestones group cards. Start a thread from a task or idea card, or use `/thread:new --parent <id>`. |
| A milestone shows 0 done although its cards are finished | Progress counts cards in the stage that the `done` role points to. With the default roles a thread is done once it has ended (`/thread:end`), not when a turn has finished. Check the roles with `/thread:setup --show`. |
| A thread reports that a tool was refused | It needed a permission prompt it could not answer. Allow the tool in your Claude Code permission rules, add it to `THREAD_ALLOW_TOOLS`, or name the folder it needs in the task. |
| The board shows six fixed columns, or my stages and milestones are missing, after an update | A session that still runs an older plugin version is serving the board. A board tab that was already open says so in a line under the toolbar (the page's version note, or the older-session note about missing stages and milestones); a freshly loaded one shows the older page. Nothing is lost: reload that session's window, or run `/thread:board` in an updated session, then reload the page. Do not reload the page first: it would only show the older page again. |
| The board still shows the old page after a plugin update, or a note says "served by an older session" | A session on an older version is serving it. Run `/thread:board` in a session that has the new version (reload its window first). A board from before 0.8.2 cannot be replaced or stopped this way: reload the window of the session that serves it. |
| The board says it needs its access link | The link was opened without its token, or from an old bookmark. Run `/thread:board` and open the link it prints. |
| `/thread:report` lists threads instead of reporting | This session started none or several unreported threads. Pass the id. |
| A thread shows "running" for a long time | Check its card on the board. A thread whose process died is marked failed the next time the board or a command looks at it. |
| A task's page shows no agent run although an agent worked on it | Only an Agent call whose `description` starts with the card id in brackets, such as `[c24] fix it`, is linked, and only to a task or idea of this project. Ask Claude to put the id first. The hooks need the plugin version with them (reload the window after an update). If Claude Code changes where it keeps sub-agent transcripts, the run still shows its prompt, report and tokens but no steps. |
| A run's steps say "The activity of this run was not kept" | Its snapshot could not be written and Claude Code has since removed the transcript. The prompt and report are still shown. |
| A run shows "Running" long after the agent finished, or says "No activity for N min; it may have stopped" | Claude Code did not send the stop event (the session was closed or crashed while the agent ran, or the stop hook could not get the state lock in time). Press **Mark as stopped** on the run: it becomes Ended, not successful, with a note. |
| The red **Waiting for you** pill is not there | Nothing is waiting, or the project is in [chat-only mode](#chat-only-mode), or the session serving the board runs a plugin version from before waiting items (reload that window; see the older-session note). |
| I answered an item but Claude did not react | Nothing is pushed into a session. The answer arrives with your next message in the session that asked; until then its line says "not yet delivered". Ask in the chat (`what is c37.w2?`) and Claude reads it with `wait_list`. If that session was cleared or closed, ask any session, for example "what did I answer on c37.w2?". |
| `wait_add` is refused | The message says why: the card is a milestone, the project is chat-only, a side thread called it, a choice needs 2 to 8 distinct options, or the card already has 20 open items. |
| A finished thread was not announced | Announcements arrive with your next message to the session that started the thread. |

## What's new

- **0.11.0** [Waiting for you](#waiting-for-you): Claude puts a question, a choice, a to-do or a review on a card, a red pill shows how many wait on you, and you answer on the board; the answer reaches the session that asked with your next message. Task and idea cards open as a [workspace like a thread's](#task-and-idea-pages), showing the sub-agent runs Claude starts for the card (live steps, report, trace) and the card's history. Chat-only mode has three fixed columns: New, Review, Done. The board has a new look. Read threads now always run with `--permission-mode dontAsk` and cannot use edit tools or start sub-agents, whatever your own permission settings say; and the plugin's data folder is owner-only.
- **0.10.0** [Delegation lanes](#delegation-lanes): with the delegate skills installed, a thread can run on another coding CLI (codex, agy, opencode or claude) with the lane's model and effort, follow-ups continue that CLI's session, and a task card with a lane starts on it from the board. Cards show the lane and their page shows its details; `lane_list` lets Claude see and choose lanes. A thread report no longer shows a malformed step map as raw text.
- **0.9.1** A gear on every board card opens a menu of its actions (end or delete a thread, move a task to a stage, set its milestone, start it as a thread, copy a milestone's report) without opening the card. The board header shows the plugin version, and a note says when the page and the session serving it are on different versions.
- **0.9.0** Milestones: a card that groups tasks, ideas and threads, with a tag, progress, a board filter and a report (`/thread:board --parent`). Your own board stages and `/thread:setup` to choose them. A chat-only mode that turns the task board off. Follow-ups open with a "Since your last turn:" note when the main session has changed something the thread needs.
- **0.8.2** `/thread:board --stop` stops the board. A newer plugin version takes over a board served by an older one.
- **0.8.1** Task and idea cards open as a full page, like threads. The plugin has an icon.
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
  config.mjs        settings: mode, stages and roles, and the two config files
  sessions.mjs      session names, and the model a session runs on
  core.mjs          cards, milestones, threads, the wrong-session guard, project listing
  lanes.mjs         delegation lanes: reads the lane settings from the delegate skills
  runs.mjs          sub-agent runs on a card, recorded by hooks, and their transcripts
  waits.mjs         the questions a session asks the user on the board, and their answers
  runner.mjs        the detached process that runs one thread turn
  mcp.mjs           the MCP server and its tools
  http.mjs          the board server
  board.html        the board page
test/               node:test suites, with a stub in place of the claude CLI
  fake-delegate/    fake delegate skills and relay for the lane tests
  fixtures/         data and small scripts the tests run
```

```bash
node --test
claude plugin validate .
```

## License

MIT. See [LICENSE](LICENSE).
