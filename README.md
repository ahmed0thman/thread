# thread

Side threads for Claude Code, with a kanban board.

While Claude is busy on one task, you often think of something else: a question that needs real digging, a doubt about the plan, an idea for later. Asking it in the same session derails the work. Opening a new session loses the context you have built up.

`thread` gives you a third option. A **thread** is a background Claude session with its own tools that works on one task while the main session carries on. Claude gives it a short **brief** of what it needs from your conversation, so it starts cheap, and picks a sub-agent or model that suits how hard the task is. If the task needs everything said so far, a thread can instead be a **full copy** of the session. Nothing it does enters the main session until you ask for its report.

The plugin also keeps a **board** of tasks, ideas, milestones and threads for each project, shown on a local web page. It opens on a home with one tile per project. Inside a project you get a Summary, the Board with its columns, a List, the Milestones and what is waiting for you, and you can read a thread's conversation, see what it did step by step, and send it follow-ups. The columns are yours to define, and if you only want threads, you can switch the task board off.

A short tour. Every screenshot in this README shows an invented shop, `acme-shop`.

**The Summary** is where a project opens: what is open, in progress, done this week, what bugs are open, what waits for you, who did the work and at what token cost.

![The Summary of a project: five count tiles, cards created and done per week, work by worker with tokens, the items waiting for you and the milestones](docs/summary.png)

**The Board** shows the cards in columns. Each card carries its type, priority, labels, milestone and, when it has them, blocked, acceptance criteria and waiting marks.

![The Board with the columns Idea, New, In progress, Review, Blocked and Done; cards show a bug icon, priority arrows, label chips, a milestone tag, blocked and criteria marks, waiting tags, and a finished thread](docs/board.png)

**A thread** opens full-window: its details and brief on the left, the conversation in the centre, the step-by-step trace on the right.

![A finished thread opened full-window: its session and details on the left, the conversation with its Happened, Decided and Open digest in the centre, and the trace on the right](docs/thread.png)

More screens are in [The board](#the-board) and in the [use cases](#use-cases).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Use cases](#use-cases)
- [Commands](#commands)
- [Tools Claude uses](#tools-claude-uses)
- [Choosing the agent and model](#choosing-the-agent-and-model)
- [Waiting for you](#waiting-for-you)
  - [Waking the session](#waking-the-session)
- [Milestones](#milestones)
- [Delegation lanes](#delegation-lanes)
- [Setup](#setup)
- [Custom stages](#custom-stages)
- [Chat-only mode](#chat-only-mode)
- [Catch-up notes on follow-ups](#catch-up-notes-on-follow-ups)
- [The board](#the-board)
  - [Projects home and top bar](#projects-home-and-top-bar)
  - [The Summary view](#the-summary-view)
  - [The Board view](#the-board-view)
  - [The List view](#the-list-view)
  - [The Milestones view](#the-milestones-view)
  - [Task and idea pages](#task-and-idea-pages)
  - [Card fields, workers and the done gate](#card-fields-workers-and-the-done-gate)
- [Opening the board from your phone (tunnel)](#opening-the-board-from-your-phone-tunnel)
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

The link it prints opens your project on its Summary. **Board** in the top bar shows the cards in their columns.

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

Open the board with `/thread:board`, choose **Board** in the top bar and click a thread card (a row in the **List** opens it too). The thread opens full-window: its conversation in the centre with a message box, its ids, digest and decisions on the left, and a step-by-step trace on the right. Type a follow-up there and the thread runs another turn. While a turn runs, the conversation shows what the thread is doing as it happens: its messages and each tool it uses. This is the way to read or continue a thread without putting anything into the main session.

A task or idea card can become a thread from there too. Open the card, press **Start as thread**, and choose the session it reports to, Brief or Full copy, and an agent. When it has finished, **Report to main session** queues its digest for your next message in that session (or wakes the session at once, with [waking](#waking-the-session) turned on).

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

Later, `/thread:board --parent c12` prints the report for the milestone: its state (open or done), how many of its cards are done, and every card under it grouped by stage. See [Milestones](#milestones) for the details.

### 11. Setting the plugin up for how you work

Your team does not use "Idea, New, In progress, Review, Blocked, Done". You use To do, Doing, Check and Done.

```text
/thread:setup
```

Claude asks whether the setting is for every project or this one, whether you want threads only or threads plus the task board, for the task board how you work, and whether the board may wake an idle session. You describe it in your own words ("I write a task, start it, someone reviews it, then it's finished"). Claude proposes the stages and says which one each part of the plugin will use ("a running thread sits in Doing"). You change the list until you agree, and Claude saves it. See [Setup](#setup) and [Custom stages](#custom-stages).

### 12. Threads only, no task board

You only want side threads and have no use for cards, ideas or milestones. Run `/thread:setup` and choose threads only. Claude stops creating cards, the board page shows only threads, and `/thread:add` is refused with a message that says how to turn the task board back on. See [Chat-only mode](#chat-only-mode).

### 13. Tracking AI work end to end: acceptance criteria and the done gate

You want a bug fixed, and you want to be the one who says it is fixed. Tell Claude in plain words; there is no command for the fields:

```text
Add a bug: the cart total is 0.01 lower than the order total when two percent-off coupons are applied. High priority, labels checkout and payments. It is done when the cart and checkout show the same total with any coupons, a regression test covers two stacked coupons, and rounding happens once, on the order total.
```

Claude adds the card with `board_add` (type `bug`, priority `high`, the labels and three `criteria`) and replies with its id, say `c13`. Claude then hands the work to sub-agents, starting each Agent call's description with `[c13]` so the runs show on the card, and passing `worker` so the card lists who did what. Open the card on the board: the bug and priority are in the header, the fields on the left, **Worked by** under them, each run in the centre with its prompt, steps and report, and the trace on the right.

![The bug c13 Cart total drifts with two coupons: its type, priority, labels, blocked by and three acceptance criteria on the left, four sub-agent runs in the centre, the trace on the right](docs/card.png)

When the work is finished, Claude does not move the card to done. It raises a review item with `wait_add` and tells you in one line, such as `Waiting on you: c13.w1`. The card gets a red **waiting** tag and the project's Waiting view gets a count. Open the card, read the review, and answer **Approve** or **Request changes** (with a comment) and **Send**. This is what a review looks like, here on another card, c11:

![A Review item on the card Shipping rates for the EU: Approve and Request changes, a comment box and Send, with the card's sub-agent runs beside it](docs/waiting.png)

Your answer reaches Claude with your next message in that session. After **Approve**, Claude moves the card to done with `board_update`. If it tried before, the tool refused: a card with criteria cannot go to done until you approve a review. After **Request changes**, Claude carries on with your comment, and the card still needs an approved review before Claude can move it to done. See [Waiting for you](#waiting-for-you) and [Card fields, workers and the done gate](#card-fields-workers-and-the-done-gate).

### 14. Seeing that a card was closed without your approval

The gate holds Claude, not you. You are in a hurry and drag a card that has acceptance criteria to **Done** (or a stage after it, such as Released) yourself, from the Board, from **Move to** in its gear menu, or with the Status select on its page. It moves, and from then on it says so everywhere:

- on the Board its face has a red **not verified** tag;
- in the List, `done, not verified` sits under its title, and the **Done, not verified** button shows only such cards;
- on its page, a **Done, not verified** note says that Claude may not move it to done or a later stage until you approve a review item, and that you moved it yourself;
- in `/thread:board`, the line has `(done, not verified)`.

![The card Invoice PDF for every order, in Done, with the Done, not verified note and its three acceptance criteria](docs/not-verified.png)

To check it properly, ask Claude to review the card and raise a review item on it. When you answer **Approve**, the mark goes away. Moving the card out of the finished stages (Done and every stage after it) and back takes the approval away again; moving it from Done to a later stage such as Released does not.

### 15. Triaging bugs and priorities in the List

You have 36 cards and want to know which bugs to look at first. Open the board with `/thread:board`, then **List** in the top bar. Click the **Priority** header to put High first, set **Type** to Bug, or pick a **Label** such as `payments`. The **Blocked** button leaves only the cards that wait for something that is not done yet, and a line beside the toolbar says how many cards match, with **Clear filters**. The Type, Priority and Label selects offer only values some card has.

![The List of acme-shop filtered to the milestone Launch v1 and sorted by priority, with Bug and Task rows, blocked by marks on two cards and done, not verified under another, and the Worked by column](docs/list.png)

Each row shows the stage, the priority, the labels, the milestone, who worked on it (**Worked by**) and how many items wait for you. A card that is blocked says `blocked by c11, c14` under its title. Click a row, or focus it and press Enter, to open the card; `Esc` returns to the List with your filters as you left them. The screenshot is filtered by milestone, not by type. See [The List view](#the-list-view).

### 16. A Monday look at a project

At the start of the week you want to know where a project stands without reading every card. Open the board with `/thread:board`; the project opens on its **Summary**.

![The Summary of acme-shop with its count tiles, the chart of cards created and done per week, and the work by worker](docs/summary.png)

Read it from the top. The tiles give open cards, cards in progress, cards done in the last 7 days and open bugs. The chart shows cards created against cards done for each of the last 8 weeks, which tells you whether the backlog is growing. **Work by worker** shows, for each worker, how many done cards it worked on and how many tokens it used, so you can see which sub-agent or lane did the work and what it cost. Tokens come from sub-agent runs and thread turns, and the main session shows a dash there. **Waiting for you** lists the oldest open items; click one to open its card and answer. Under it are the milestones with their progress. A panel at the bottom, **About these numbers**, says what the figures cannot know. See [The Summary view](#the-summary-view).

### 17. Many projects at once

You work in several repositories, each with its own board, and want to know which one needs you. Open any board link, then **All projects**, or go to the address with no project (`#/`).

![The projects home with a tile for acme-shop, acme-admin and acme-docs; acme-shop shows 6 waiting in red and 1 running](docs/home.png)

Each tile shows the project's open and done cards, the items waiting for you (in red when there are some) and the threads that are running. Here `acme-shop` has 6 items waiting and one thread running, and the other two have nothing waiting, so you start there. Click the tile and the project opens on its Summary. Inside a project, the select next to **All projects** moves you to another one; it reads `acme-shop · 6 waiting` for a project with something waiting. See [Projects home and top bar](#projects-home-and-top-bar) and [Several sessions and projects](#several-sessions-and-projects).

### 18. Planning a release with milestones and blockers

You are shipping a first version. Make a milestone and put the work under it (Claude answers with the milestone's id, here `c1`):

```text
/thread:add --milestone Launch v1
/thread:add --parent c1 guest checkout
/thread:add --parent c1 shipping rates for the EU
```

Say which card has to wait for which: "c13 is blocked by c11 and c14". Claude sets `blocked_by` with `board_update`. You can do the same on the card's page, in the **Blocked by** field, with ids separated by commas. While c11 or c14 is not in the Done stage or a later one (such as Released), c13 carries a red **blocked** tag on the Board and `blocked by c11, c14` in the List, naming only the blockers still open. A blocker is a mark, not a lock: nothing stops you or Claude moving the card, and the one thing it does stop is **Start as thread** on that card.

Check progress in the **Milestones** view: each milestone shows its state (Open, Empty or Done), its progress bar, its to do, in progress and done counts, and its open cards. A milestone has no stage of its own: it is open until every card in it is done.

![The Milestones view with Launch v1 at 7 of 15 done, Holiday sale at 1 of 7 and Beta storefront at 2 of 2 with every card done](docs/milestones.png)

Click a milestone's title to open its page, with the cards grouped by stage and **Copy report** for a plain-text version to paste into a message. `/thread:board --parent c1` prints the same report in the chat.

![The page of the milestone Launch v1: its note, progress at 7 of 15 done, Copy report and its cards by stage](docs/milestone.png)

See [Milestones](#milestones) and [Card fields, workers and the done gate](#card-fields-workers-and-the-done-gate).

## Commands

| Command | What it does |
|---|---|
| `/thread:new [--full] [--agent <name>] [--model <name>] [--effort <level>] [--lane <name>] [--write] [--parent <id>] <task>` | Start a thread on the task. By default it gets a brief written by Claude, runs on an agent or model Claude picks for the task, and cannot edit files. `--full` copies the whole session instead. `--agent`, or `--model` with an optional `--effort`, sets what runs it. `--lane` runs it on a [delegation lane](#delegation-lanes) (another provider's CLI) and cannot be combined with `--agent`, `--model`, `--effort` or `--full`. `--write` lets it edit files. `--parent` puts it under a milestone. |
| `/thread:continue <id> <message>` | Send a follow-up to a finished thread (a lane thread continues its provider's session). When the main session has changed something the thread needs to know, Claude opens the message with a "Since your last turn:" note. |
| `/thread:report [id]` | Pull a thread's digest into this session. With no id, picks the one unreported thread this session started. |
| `/thread:status` | List threads with their milestone, state, context, agent or model, turns, tokens used, reported status and who started them. |
| `/thread:end <id>` | End a thread, stopping it if it is running, and mark its card done. |
| `/thread:board [--stop] [--parent <id>] [--tunnel [stop]]` | List the cards by stage (a card with items waiting for you shows `(2 waiting)`) and print the board link, which opens the project on its Summary. `--parent <id>` shows the report for one milestone instead. Milestones are listed in their own section, with their state. `--stop` stops the board web page (and a tunnel). `--tunnel` also prints a remote link for your phone, through a Cloudflare tunnel that lasts 12 hours, after asking you first; `--tunnel stop` closes it. See [Opening the board from your phone](#opening-the-board-from-your-phone-tunnel). |
| `/thread:add [--milestone] [--parent <id>] [--lane <name>] <task or idea>` | Add a card without acting on it. `--milestone` makes the card a milestone. `--parent` puts the card under a milestone. `--lane` labels a task or idea with a [delegation lane](#delegation-lanes). |
| `/thread:setup [--show] [--reset]` | Choose chat-only or the task board, your own stages, whether an answer or report click on the board [wakes an idle session](#waking-the-session), and whether that applies to every project or this one. `--show` prints the current settings. `--reset` deletes a settings file. |
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
| `board_add` | Add a task, idea or milestone card (a milestone takes no `status`: it has no stage), optionally under a milestone and, for a task or idea, with a [delegation lane](#delegation-lanes) and the [card fields](#card-fields-workers-and-the-done-gate) `type`, `priority`, `labels`, `blocked_by` and `criteria`, and a `worker` (Claude passes `main`, `agent:<type>`, `thread:<id>` or `lane:<name>`). Refused when the project is chat-only. The reply reminds Claude to start the description of an Agent call for the card with `[cN]`, so the run [shows on the card](#task-and-idea-pages). |
| `board_update` | Change a card's title, note, stage, `kind`, milestone, lane or [card fields](#card-fields-workers-and-the-done-gate) (`type`, `priority`, `labels`, `blocked_by`, `criteria`). An empty value removes a field, except `criteria`: once a card has them Claude can add lines but not remove or change them. A card with `criteria` cannot be moved to the done stage, or any stage after it, until you have approved a review item on it, and a card moved back out of the finished stages needs a new approval. `kind` is `task` or `idea`: it turns a task into an idea or an idea into a task (the change is in the card's history). A thread or a milestone never changes kind, and no card becomes a milestone. A `status` on a milestone is refused: a milestone has no stage. Takes a `worker` too; an update that changes nothing but the `worker` is noted in the card's history, once per worker in a row. |
| `board_remove` | Delete a card. A running thread cannot be removed, and Claude cannot remove a card that has `criteria` unless it is in the done stage or a later one, or you approved it; you remove such a card on the board. |
| `board_list` | List the cards by stage. Milestones are not in the stage groups: they have their own **Milestones** section after them, one line each with the id, `[milestone:open]` (or `empty`, `done`), the title and the progress `(5/14 done)`. After a card's title come the marks of its [fields](#card-fields-workers-and-the-done-gate), in this order and only when it has them: `(bug)`, `!high` or `!low`, `#label` for each label, `{blocked by c4, c7}` (only the blockers that are not finished yet, in the done stage or a later one, and nothing when all are), `[criteria 3]` and `(done, not verified)`. Then come its milestone tag, lane (as `{lane: name}`) and `(2 waiting)` for items [waiting for you](#waiting-for-you). With `parent`, report on one milestone, with its state in the summary line. |
| `wait_add` | Put something Claude needs from you on a card: a question, a choice, a to-do or a review. Refused on a milestone, inside a side thread and when the project is chat-only. An optional `worker` (same forms as above) is noted in the card's history. See [Waiting for you](#waiting-for-you). |
| `wait_list` | Read waiting items (one by id, or those of a card or state), with the answer once there is one. Read only. It is how Claude answers "what is c37.w2?". |
| `wait_close` | Close an open item that you did not answer on the board: withdraw it, or note that you answered in the chat. |
| `board_open` | Return the board link. Starts the board again if it was stopped. With `tunnel: "start"` it also opens, or shows, the [remote link](#opening-the-board-from-your-phone-tunnel); opening needs your agreement (`confirm_code`), showing an open one does not. `tunnel: "stop"` closes it. |
| `board_stop` | Stop the board web page for every session, and the remote tunnel if one is open. |
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

**The four kinds.** Each has its own icon and colour, and the board has a small colour guide (a legend) that appears next to the red pill while the filter is on, and on the Waiting view.

| Kind | Icon, colour | You |
|---|---|---|
| **Question** | speech bubble, blue | type an answer |
| **Choice** | radio dot, purple | pick one option, or several when Claude allowed that (2 to 8 options) |
| **Review** | magnifier, teal | check Claude's work and answer **Approve** or **Request changes** |
| **To do** | empty box, amber | do something yourself, then tick **Done** |

Every kind except a question also takes an optional comment (for a question, the answer is the text). Cards in a Review stage and threads that have not been reported keep their own tags; the red count is for these explicit items only.

**How Claude raises one.** With the `wait_add` tool, on the card for the work (it adds a card first when there is none). It does this when it finished something you must check, has a question, or needs you to do something. So that it does not have to guess, the note every session gets at start (in task-board mode) says so in one sentence, and the `/thread:track` skill, which describes this too, loads when work is finished for you to check as well as on a new instruction. In the chat it gives one line, such as `Waiting on you: c37.w2`, instead of repeating the question. An item has an id made of the card and a number, `c37.w2`; the number is never reused. Claude cannot put an item on a milestone, a side thread cannot add one, and a chat-only project has none. Adding an item does not move the card, change its updated time or mark it as new from you.

**Where you see it.**

- A red pill in the toolbar, **Waiting for you** with a count of the open items in this project. On the Board, click it, or press `w`, to show only the cards that have open items; it combines with search, Threads only, the session filter and the milestone filter, and is remembered per project like them. On the List, the pill and `w` open the Waiting view instead. The pill is hidden when nothing waits, and a filter that is on goes away with the last item.
- The **Waiting** view in the project's top bar, with a red count. It is the Board with that filter always on (the pill is not shown there, since the view is the filter); `w` on it goes back to the Board. From the Summary, the List or the Milestones, `w` goes to Waiting. When nothing waits, `w` does nothing.
- On the Summary, a **Waiting for you** tile (it opens the Waiting view when something waits) and a list of the oldest open items; each opens its card at the Waiting for you section.
- In the header's project switcher, a project with open items reads `name · 2 waiting`, and on the projects home its tile shows the count in red.
- A tag in a card's foot with one small icon per kind and the count, such as `2 waiting`. A milestone shows the total of its cards as a count to look at, in the Milestones view (a milestone is not on the Board).
- The card's gear menu has **Answer waiting items (N)**, which opens the card's page at the section.

![The Waiting view: the Board with only the cards that have open items, in In progress, Review and Blocked, each with a waiting tag, and a legend for Question, Choice, Review and To do](docs/waiting-view.png)

**Answering.** Open the card. A **Waiting for you** section is at the top of its page (the left pane of a task, idea or thread; on a narrow window, the Card or About tab). Each open item shows its kind, text, the session that asked and when, the control for its kind, and **Send** (Ctrl or Cmd + Enter sends). Once sent, the item folds into a muted line with a tick, your answer, and whether it was delivered. What you typed stays while you look around, and answering never moves the card.

![The card Shipping rates for the EU opened at Waiting for you: a Review item with the choices Approve and Request changes, a comment box and Send, next to the card's two sub-agent runs and their trace](docs/waiting.png)

**The id button.** Every item, open or answered, has a **Copy id** button. Paste the id in the main session to ask about it: Claude reads it with `wait_list` (`what is c37.w2?`).

**How an answer reaches Claude.** By default nothing is pushed into a session (to have an idle session wake up and act at once, see [Waking the session](#waking-the-session)). The board saves the answer, and the next time you send a message in the session that asked, a hook adds a line to it, for example `The user answered c37.w2 on the board ("Which retry limit?"): "5". Continue with it.` Only the session that asked gets it, once, and long answers are cut short with a pointer to `wait_list`. At most five answers go with one message; the rest follow with the next. If you answer in the chat instead, Claude closes the item with `wait_close`.

**When the session is gone** (closed, or cleared with `/clear`, which starts a new session id). The item stays **answered, not yet delivered**; its line says that the answer reaches the session that asked with that session's next message, when that session was last active, and that if it was cleared or closed any session can read the answer with `wait_list`: ask, for example, "what did I answer on c37.w2?". A session that starts in a task-board project also hears about it: if answered items were asked by another session and not delivered, its start note has one line with their count and a pointer to `wait_list`. An item can also be withdrawn by Claude when it is no longer needed.

Items are never deleted, only closed, and a card keeps at most 20 open ones. They are stored in the card's `waits` list in the project's state file; an older plugin version ignores them and keeps them. Waiting items are not shown in [chat-only mode](#chat-only-mode), which has no Waiting view.

### Waking the session

By default an answer to a waiting item, or a click on **Report to main session**, reaches the session only when you next type in it. With **waking** turned on, an idle session wakes by itself within a second or two, with no typing, and acts on it: it continues with your answer, or pulls the thread's report and shows you the digest.

**It is opt-in.** Waking is off until you turn it on, with `/thread:setup` (one question: "Should an answer or a report click on the board wake an idle session?") or with the `config_set` tool (`wake: true`, for every project with `scope: "global"` or for this one with `scope: "project"`). Without a setting it is off. It is meant to become the default in a later version. `/thread:setup --show` and `config_get` say whether it is on and which file says so.

**What wakes a session.** Two things, each only for the session they belong to:

- you answer a waiting item that this session asked, and the answer has not been delivered yet;
- you click **Report to main session** on a thread this session started. Each click wakes once; if the session already handled it, or you click again later, the new click is a new wake.

**How it works.** When a turn ends, a small background process (a `Stop` hook marked `asyncRewake`, `scripts/waiter.mjs`) starts and watches the project's state file. When one of the two things above happens, it ends with exit code 2, which Claude Code treats as a wake-up: the session starts a turn, and the process's message tells Claude to act on what you did on the board. The content itself arrives the normal way, from the prompt hook that runs on every turn (the same one that carries answers today), so an answer is still delivered exactly once, by one path. There is at most one such process per session: a newer one replaces an older one, and a turn that starts (typed, or woken) stops it, since it only waits while the session is idle. In a session you sit at, Claude Code runs it in the background, so it does not hold a turn up. It ends quietly on any error, ends when Claude Code or the session closes (it checks that both are still there), gives up after 12 hours idle (the next turn starts a new one) and uses no busy loop (it watches the file and checks it every second or so; a check that finds the settings and state files unchanged reads nothing). Turning waking off while it waits ends it. Its hook timeout is set to 24 hours.

**Headless runs never wake.** In `claude -p`, scripts, CI, the Agent SDK and the delegation relays there is nobody to wake, and Claude Code does not run an `asyncRewake` hook in the background there: it waits for it like for any other turn-end hook, which would hold the run up for as long as the process lives. The process therefore ends at once when Claude Code says the session is not attended (the `CLAUDE_CODE_SESSION_ATTENDED` setting it gives every hook, or, on a version that does not set it, an `sdk-...` entry point), before it reads the settings or the state. The prompt hook of such a run writes nothing either. A run like that is not slowed down and leaves no file behind.

**How a woken turn is recognised.** When the process wakes the session it writes the time into its small file. The prompt hook of the turn that follows takes that note (and clears it) and treats the turn as woken only if it is less than two minutes old and waking is on. Nothing in the prompt text counts, so a message you type that quotes the wake-up text is a normal message. In a woken turn only your answers and report clicks are marked "act on this now"; anything else the prompt hook mentions (new cards you added, a thread that finished) is listed below them as information only.

**When Claude is busy.** An answer given while a turn is running is delivered when that turn ends: the process waits only between turns (a turn that starts stops it, and one that started while it was still starting makes it leave at once), and if something is already pending when a turn ends, the new process wakes the session at once.

**What to know before you turn it on.**

- **A woken session acts at once, and that costs tokens while you are away.** An answer makes it continue its work; a report click makes it call `thread_report` and write out the digest. It does what it would do if you had typed the answer yourself.
- **Sessions in bypass-permissions mode also wake, and then act without permission prompts**, exactly as they do for anything you type.
- **Anyone with the board link can now start a turn.** An answer saved on the board is what wakes the session, and the board's access token is what guards the board (see [Security](#security)). Treat the link like a key to your sessions, and do not share it.
- **It only wakes the session that asked** (or started the thread). Another session in the project is not woken, and a session that is gone is not either; its answer stays "not yet delivered" as described above.
- **A side thread is never woken**, and neither is a project in [chat-only mode](#chat-only-mode) that has no threads. In chat-only mode a report click still wakes the session; waiting items do not exist there.
- **Claude Desktop is not checked yet.** Waking was verified with the Claude Code terminal. It should work in Claude Desktop sessions too, since they run the same hooks, but that has not been tested; if a session there does not wake, [Troubleshooting](#troubleshooting) lists the checks.
- A woken session that cannot deliver (the prompt hook failed) is woken for that answer only once. The woken turn then has no note to act on and does nothing, and the answer reaches the session with your next message, as it does with waking off.
- **Claude Code version.** Waking needs a Claude Code that supports `asyncRewake` hooks. It was tested with 2.1.289 (the headless behaviour above was checked with 2.1.299). A version that ignores `asyncRewake` would run the process as an ordinary turn-end hook and hold every turn up, so leave waking off there.
- **Only you can turn it on.** `config_set` with `wake: true` is never saved on the first call: it answers "CONFIRMATION REQUIRED" and a code, and Claude has to show you what waking does and ask you; only a second call with that code, after you agree, saves it. Turning it off needs no question. A side thread cannot change settings at all.
- Older plugin versions ignore the setting and the waiting; the fields a click leaves on the thread (`reportPushedFor`, `reportPushedAt`) are kept by them. An older version that saves the settings file drops the `wake` line from it, so set it again after such a save.

## Milestones

A **milestone** is a card that groups other cards. Tasks, ideas and threads can sit under it, so you can see one piece of work as a whole: what is in it, and how much is done. Without milestones the board is a flat list.

![The page of the milestone Launch v1: its title and note, its state and progress bar at 7 of 15 done, Copy report, and its cards grouped by stage](docs/milestone.png)

- **One level only.** A milestone cannot sit under another milestone, and only a milestone can be a parent. Every other card (task, idea or thread) can have at most one milestone.
- **A milestone has no stage.** It has a title and a note, and its state comes from its cards: **Empty** when it has no counted card, **Open** while some counted card is not finished, **Done** when every counted card is finished. It reopens by itself when a card is added to it or a card leaves done. Nobody sets a state by hand: `board_update` and the board refuse a `status` on a milestone ("a milestone has no stage: it is done when all its cards are done"). A milestone is not on the Board's columns; the Milestones view, the List and the Summary show it. A milestone cannot be started as a thread.
- **The tag.** A card under a milestone shows the milestone's title in square brackets after its title, such as `[Ship the invoice export]`, clipped to 30 characters. On the board it is a tag you can click to filter the board to that milestone.
- **Progress.** A milestone shows `3/5 done`: the cards under it that are finished, out of the cards that count. **Ideas do not count** until they become tasks. A card is finished when it is in the **done** role's stage (by default Done) or in any stage after it in your stage order (for example Released). A thread is finished once it has ended, not when a turn has finished. (If you point the **review** and **done** roles at the same stage, a finished turn counts too.) Milestones that an older version stored with a stage keep it in the data, and it is ignored.
- **Filtering the board.** The toolbar has a **Milestone** select (All, each milestone by title, No milestone). It appears once a milestone exists and combines with search, the session filter and the threads-only filter. It shows the cards under the milestone. The Waiting view and the List have the same select.
- **The Milestones view.** The top bar's **Milestones** view shows every milestone at a glance, with its state, its progress and its open cards; see [The Milestones view](#the-milestones-view).
- **The report.** `/thread:board --parent <id>` prints the report for one milestone: a summary line with its state, then the milestone and its cards grouped by stage. On the board, open the milestone: its page lists "Cards in this milestone" grouped by stage, each row linking to that card, and **Copy report** copies the same list as plain text.

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

The milestone is `c12`. The task and the idea start in New. The idea does not count towards the milestone, so it is 1 of 2 done: the thread and the CSV task. After the thread has run and been ended, and the CSV task has moved to In progress, `/thread:board --parent c12` gives a report built from this list:

```text
Milestone c12 "Ship the invoice export": open, 1 of 2 done.
New (1)
- c14 [idea] Offer an Excel export too [Ship the invoice export]
In progress (1)
- c13 [task] Write the CSV exporter [Ship the invoice export]
Done (1)
- c15 [thread:ended] Check how the export behaves with 100,000 rows [Ship the invoice export]
Milestones (1)
- c12 [milestone:open] Ship the invoice export (1/2 done)

Stages, as id: label [what the plugin uses it for]:
- idea: Idea
- new: New [start]
- in_progress: In progress [working]
- review: Review [review]
- blocked: Blocked [blocked]
- done: Done [done]
```

The last block is how Claude knows your stage ids and which stage is used for what; it is there for every board, including an empty one.

`/thread:board` on its own prints the same kind of list for the whole board: the stages, then the **Milestones** section with each milestone's state and progress, and the tags.

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

4. **Waking.** Whether an answer or a report click on the board should wake an idle session at once (default: no). See [Waking the session](#waking-the-session) before you say yes: a woken session acts without you. If you say yes, Claude shows you what it does once more and saves only after you agree again.

Then Claude saves the settings, reports the result in a few lines, and tells you that `/thread:setup` can be run again at any time. Setup never changes a card.

```text
/thread:setup            the conversation above
/thread:setup --show     print the current settings and stop
/thread:setup --reset    ask which settings to delete (every project, or this one), delete that file, and stop
```

`--show` prints the mode, whether waking is on, the stages in order, the role of each stage, where each setting came from (default, the global file, or the project file), and the paths of both files. `--reset` deletes one settings file; cards and threads are not touched, and the plugin falls back to the other file, or to the defaults.

**The one-time hint.** In the first session after you install the plugin, Claude is told that the plugin has not been set up and, when it does not interrupt your request, mentions `/thread:setup` once. This happens once per machine, and only while no settings file exists. If you ignore it, the plugin carries on with the defaults and does not mention it again.

### Where the settings live

Two optional JSON files, with the same shape:

| File | Applies to |
|---|---|
| `<data dir>/config.json` | Every project that has no setting of its own for that field. |
| `<data dir>/projects/<key>/config.json` | That project only. |

`<data dir>` is the plugin's data directory, otherwise `~/.claude/thread-data` (see [Configuration](#configuration)). `/thread:setup --show` prints both paths, so you do not have to work out `<key>`.

The effective settings for a project are the defaults, then the global file, then the project file. A field in a later file replaces the same field from an earlier one. The `mode` and `wake` are each chosen on their own. `stages` and `roles` always come together from one file, never mixed from two. A file that cannot be read, or that fails the checks below, is ignored, with a line on the plugin's stderr log; it does not stop anything.

Every field is optional. Here is a complete file:

```json
{
  "mode": "tasks",
  "wake": false,
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

![The Board of a project with four stages of its own: To do, Doing, Checking and Done](docs/stages.png)

### Roles

Some of the plugin's own behaviour has to know which stage means what. The **roles** say so. Each role points to one stage id.

| Role | Used for |
|---|---|
| `start` | Where a new card lands when no stage is given. Also where a card is shown when its own stage no longer exists. |
| `working` | A thread whose turn is running. |
| `review` | A thread whose turn has finished, waiting for you to look. |
| `blocked` | A thread that failed. |
| `done` | A thread that was ended. Also where a milestone counts a card as finished: this stage and any stage after it. |

Thread cards follow their thread through these roles; you do not move them by hand. Several roles can point to the same stage.

**Default roles.** With the six default ids, in the default order (their labels may differ), the roles are `start` New, `working` In progress, `review` Review, `blocked` Blocked, `done` Done. With your own stages, when you give no roles, the plugin uses the order (n is the number of stages):

| Role | Stage |
|---|---|
| `start` | the first |
| `working` | the second (the first when there are only two) |
| `review` | the second to last when n is more than 2, else the last |
| `blocked` | the same as `working` |
| `done` | the last |

For the four stages in the example above that gives start To do, working Doing, review Checking, blocked Doing, done Done. A `roles` object that names only some roles is filled in from this table (or from the default roles, when the stage ids are the six default ids in the default order). Roles belong to the stages in the same file: a file with `roles` must also list its `stages`. Giving new stages without roles drops the old roles, so they are never carried over to stages that may not exist. Changing some roles later keeps the others.

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

**What still works.** Everything about threads: `/thread:new`, `/thread:continue`, `/thread:report`, `/thread:status`, `/thread:end`, the board page with thread cards, full-window threads, follow-ups from the board, and `/thread:board`. Thread cards can still be updated and removed. On the board, only thread cards are shown, in three fixed columns, **New**, **Review** and **Done**, whatever stages the task board has: a running thread is in New, a thread whose turn finished or failed is in Review, an ended thread is in Done. The project has no Summary, List, Milestones or Waiting view, so its top bar has **Board** only, and its tile on the projects home is marked chat-only once you have opened the project. A one-line note under the toolbar says that the task board is off and `/thread:setup` turns it on. The stages you set for the task board are kept as they are (`config_get` shows both) and come back when you turn the board on. [Waiting items](#waiting-for-you) are not shown.

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

`/thread:board` prints a link such as `http://127.0.0.1:47800/?t=<token>#/<project>`, which opens that project on its Summary.

- **From your phone:** `/thread:board --tunnel` also gives a remote link through a Cloudflare tunnel, with a **Remote** badge and fewer controls; see [Opening the board from your phone](#opening-the-board-from-your-phone-tunnel).
- **One board, served by one session.** The first Claude Code session to start serves the page and the others share it. When a session on a newer plugin version starts, or runs `/thread:board`, it replaces a board served by an older version; a session that is already running does the same within a few seconds. So after an update you reload one session's window, then the browser tab. Sessions that were open before the update keep running the old plugin code until their window is reloaded: until then they ignore newer settings such as your own stages or chat-only mode. A board from before 0.8.2 cannot be replaced this way (see [Troubleshooting](#troubleshooting)). `/thread:board --stop` stops the page for every session until someone runs `/thread:board` again; cards and threads are not touched.
- **Plugin version:** the header shows the version that served the page. If the server changes to a different version while the tab stays open, a note under the toolbar says so. When the board is now served by a newer version, the note shows both versions and a **Reload** button to load the current page. When it is served by an older version (a session that has not been updated took over), the note says so and tells you to run `/thread:board` in an updated session and then reload the page; there is no Reload button, since reloading would only show the older page. The note gives way to the older-session note (about missing stages and milestones) when that one is showing.

### Projects home and top bar

One page serves every project.

![The projects home: three project tiles, acme-shop with 20 open, 13 done, 6 waiting in red and 1 running, acme-admin and acme-docs with nothing waiting](docs/home.png)

- **Projects home.** The address without a project (`#/`) opens a home with one tile per project: its name and folder, how many cards are open and done (milestones are not counted; a chat-only project counts its threads), how many items [wait for you](#waiting-for-you) (in red when there are some), how many threads are running, and when it was last active. The tiles are in order of last activity when the page loads and do not move while you look at them. Click a tile to open the project. A tile says **folder missing** when the project's folder was deleted, and **chat-only** for a [chat-only](#chat-only-mode) project once you have opened it on this page.
- **Switching.** Inside a project, the header has an **All projects** link back to the home and a select to move to another project, which opens on its Summary. The select shows `name · 2 waiting` for a project with items waiting for you, `(folder missing)` for one whose folder is gone, and the parent folder's name when two projects share a name.
- **Top bar.** A project has five views: **Summary**, **Board**, **List**, **Milestones** and **Waiting**, the last with a red count while something waits for you. A project opens on its Summary. A chat-only project has **Board** only. Waiting is the Board with only the cards that have items waiting for you; while something waits, `w` goes there from the Summary, the List and the Milestones, and back to the Board from Waiting. The search box works on the Board, Waiting and the List. **New card** and `n` work in every view. A card's page opens over the view you came from, and **Back** (or `Esc`) returns to it.
- **Addresses.** Every place has its own address, so Back, Forward and bookmarks work. `#/` is the projects home. `#/<project>` is a project's first view (Summary; Board for a chat-only project). `#/<project>/summary`, `/board`, `/list`, `/milestones` and `/waiting` are the views. `#/<project>/<card id>` is a card's page, and `#/<project>/new` is the new-card form. The old `#<card id>` form still works and opens the card in the selected project. An address for a project the board does not know opens the project of the session that serves the board.
- **A missing folder.** A project whose folder was deleted is shown read-only and can be forgotten, which removes its saved cards and logs. The bar above its view says so and has the button.

### The Summary view

A project opens on its Summary, a page of work analytics (a chat-only project has the Board only). It is worked out in your browser from the cards the page already has. Milestones are not counted as work.

![The Summary of acme-shop: 20 open, 5 in progress, 4 done in the last 7 days, 6 open bugs and 6 waiting; a chart of cards created and done over 8 weeks; work by worker with done counts and tokens; the oldest waiting items and the milestones](docs/summary.png)

- **Five tiles.** The open cards (not in the Done stage or a later one), the cards in the working stage (the tile takes that stage's name, In progress by default), the cards completed in the last 7 days (a card's completion date is the last time it moved into Done or a later stage from an earlier one; a move from Done to Released does not change it, and reopening a card and finishing it again gives it a new date), the open bugs, and the items waiting for you. The waiting tile opens the Waiting view when something waits.
- **Created and done per week.** Bars for the last 8 weeks (a hollow bar for cards created, a solid one for cards done, counted on each card's completion date). Weeks start on Monday, in your browser's time zone.
- **Work by worker.** For each worker, the number of done cards it worked on and the tokens it used, with up to 8 rows and "and N more". The done count comes from the [workers](#card-fields-workers-and-the-done-gate) listed on each done card. The tokens come from sub-agent runs on cards and from thread turns, and not from the main session. Tokens of a thread that runs with no agent or lane are listed under `thread`.
- **Waiting for you.** The oldest open items, up to 8, each with its kind, card and age; click one to open its card at the Waiting for you section.
- **Milestones.** Up to 6 milestones, open ones first, then empty ones, then done ones (the order of the Milestones view), with their state (Open, Empty or Done) and progress bars, each linking to its page, and "and N more" linking to the Milestones view.
- **Time in a stage.** The median time a card stayed in each stage (except the Done stage and the stages after it) before it was moved on, and how many moves that is based on.

A panel at the bottom, **About these numbers**, says what the figures cannot know: a card keeps the last 50 entries of its history, so an older card may show only when it was created and a move that fell out of the history is not counted; a card counts as done on the day it last moved into the Done stage or a later one from an earlier stage (for a thread, when its last turn ended), or on the day it was last updated when that move is not in the history; and work by the main session shows only where Claude recorded a worker. A project with no cards shows zeros and a link to the Board.

### The Board view

The Board shows the cards in columns. The Waiting view is the same page with only the cards that have items waiting for you.

![The Board of acme-shop in six columns from Idea to Done, with bug icons, priority arrows, label chips, milestone tags, blocked, criteria and waiting marks on the cards, and a finished thread in Review](docs/board.png)

The same page in the dark theme, which the button in the header switches to:

![The Board in the dark theme](docs/board-dark.png)

- **Columns follow your stages.** There is one column per stage, in order, labelled with the stage labels. With the defaults there are six; with [custom stages](#custom-stages) there are 2 to 10. In [chat-only mode](#chat-only-mode) there are three fixed columns instead: New, Review and Done.
- **Cards** show their id, kind (task, idea, milestone or thread) and title. A card under a milestone shows a tag with the milestone's title; click it to filter the board to that milestone. A milestone is not drawn on the Board: it has no stage, so it has no column (the columns and their counts leave milestones out). A task or idea with a [delegation lane](#delegation-lanes) shows a lane tag (`code-codex · codex`) in its foot. Thread cards also show their state, the number of turns, the session that started them, a **Not reported** tag when they hold a result the main session has not pulled, the tokens they have used, and their agent when they run as one.
- **Card fields on a face.** A task, idea or thread shows its [fields](#card-fields-workers-and-the-done-gate) when it has them, and a card without them looks as it always did. A bug has a bug icon beside the kind. A priority mark sits at the right of the top line: two red arrows pointing up for high, two quiet arrows pointing down for low, nothing for normal. Up to three label chips follow the title, with `+2` for the rest (hover for all of them). The foot can carry a red **blocked** tag while any blocker is not yet in the Done stage or a later one (hover for the blockers and their stages), a quiet `3 criteria` tag, and a red **not verified** tag on a card in the Done stage or a later one that nobody approved.
- **Waiting for you:** a red pill in the toolbar, the Waiting view with a red count in the top bar, a tag on each card that has open items and a section on the card's page; see [Waiting for you](#waiting-for-you).
- **Gear menu:** every card with an action has a small gear that opens a menu of its actions, so you do not have to open the card first. Each action does what the same action does on the card's page, with the same confirmation step.
  - A card with open [waiting items](#waiting-for-you) starts its menu with **Answer waiting items (N)**, which opens the card's page at that section.
  - A **thread**: **End thread**, **Report to main session** (or **Cancel queued report**), **Delete**. End thread is not offered once the thread has ended and its confirmation names the stage the card moves to (the one with the done role); Report only while the main session has not pulled the result; Delete is greyed out while a turn is running.
  - A **task or idea**: **Move to** each stage (the current one is marked and cannot be chosen), **Set milestone** (each milestone, or No milestone; shown once a milestone exists), **Start as thread** (greyed out, with the reason as its hover text, when the card has acceptance criteria or a Blocked by list) and **Delete**. Start as thread opens the card's page at the start step, where you choose the session, Brief or Full copy, access and agent.
  - A card with nothing to offer has no gear: on a project whose folder is missing (read-only) no card has one. A milestone is not on the Board, so it has none; its own page has **Copy report** and **Delete**.
  - With the keyboard, Tab to the gear and press Enter or Space (holding the key does not choose anything); the arrow keys, Home and End move through the menu, which scrolls to the focused item when it is long, Enter chooses, Esc closes it and returns to the gear, and Tab closes it. Clicking elsewhere closes it too. The gear never starts a drag or opens the card.
- **Toolbar:** search by id, title or note; show threads only; **Waiting for you** (the red pill; only while something waits); filter by the session that started them; filter by **Milestone** (shown once a milestone exists; All, each milestone by title, or No milestone); add a card. The search, session and milestone filters are shared by the Board, Waiting and the List. A button in the header switches between light and dark.
- **Task and idea cards** open in the same three-pane workspace as a thread (see [Task and idea pages](#task-and-idea-pages) below). **Milestone cards** (opened from the Milestones view, the List or the Summary) open as a full page where you edit the title and note, with the milestone's state beside its progress and a list of its cards, grouped by stage, each row a link to that card, and **Copy report**. A milestone page has no Status. Drag a card to another column to move it to that stage. In the new-card form, **Type** is Task, Bug, Idea or Milestone (a bug is a task with the type bug), and a task, bug or idea can be given a milestone, a priority and labels. When Type is Milestone the form hides Status and Milestone: a milestone has no stage and cannot be in another milestone.
- **Start as thread** turns a task or idea card into a thread (a milestone cannot be). You choose the session it reports to, **Brief** or **Full copy**, read-only or able to edit files, and an agent from your `.claude/agents/` (or "Same as session"). With Brief, the title is the task and the note is the brief, since nobody writes one on the board. With Full copy, the title and note are the task.
- **Thread cards** open full-window:
  - **Centre:** the conversation, and a box to send a follow-up. A running turn shows its steps as they happen. A finished turn folds them into one line with its duration and tokens, such as "6 steps · 3m 00s · 48k tokens".
  - **Left:** the thread's session id, the session that started it, a `claude --resume <id>` command that opens the thread as a normal conversation in a terminal, its context (Brief or Full copy), its agent or model and effort (a lane thread: the lane's provider, model, effort or variant, access, source and whether a follow-up is possible, and the provider's session id in place of a `claude --resume` command), its milestone (changed with a select that saves at once), the tokens used, the brief it was given, the latest digest, and every decision across turns. The report command has a copy button. **Report to main session** queues the report: it is delivered with your next message in the session that started the thread, and repeated until that session makes it.
  - **Right:** the trace, a timeline of what the thread did, labelled Did, Found, Decided, Changed and Open, with file references. Clicking a step scrolls the conversation to that turn. For a lane thread it opens with one line about what its provider shows (see [Delegation lanes](#delegation-lanes)).
- **Keys:** `/` focuses search, `n` adds a card, `w` shows or hides only the cards that wait for you (on the other views it goes to Waiting, and from Waiting back to the Board), `Esc` closes a panel.

### The List view

**List** shows every card of the project as a table, threads and milestones included. A chat-only project has no List.

![The List of acme-shop filtered to the milestone Launch v1 and sorted by priority: a table with ID, Type, Title, Stage, Priority, Labels, Milestone, Worked by, Waiting and Updated, with blocked and done, not verified tags under some titles](docs/list.png)

| Column | Shows |
|---|---|
| ID | The card id. |
| Type | Task, Bug, Idea, Thread or Milestone. |
| Title | The title. A card with a blocker that is not done yet shows `blocked by c4` under it (only the open blockers are named), and a card in Done or a later stage that nobody approved shows `done, not verified`. |
| Stage | The stage's label. A milestone has no stage, so it shows its state and progress instead, such as `Open · 5/14` or `Done · 3/3` (`Empty` with no counted card). Sorting by Stage puts the milestones after every stage: open, then empty, then done. |
| Priority | High, Normal or Low. |
| Labels | The first two, with `+N` for the rest. |
| Milestone | The title of the milestone the card is under. |
| Worked by | The last worker the card lists, with `+N` for the others. |
| Waiting | The number of items waiting for you, in red. |
| Updated | When the card last changed. |

- **Sorting.** Click a column header to sort by it, and click it again to reverse. The table starts sorted by Updated, newest first. Priority and Waiting start with the most important first, and Stage follows the order of your board columns. A card with nothing in the sorted column goes last, whichever way you sort. Each project keeps its own sort and filters while the page is open.
- **Filtering.** The search box (id, title or note) and the Session and Milestone selects work as on the Board. **Type**, **Priority** and **Label** selects offer only values some card has, and appear when there is something to choose between. **Blocked** shows the cards that have at least one blocker not yet in the Done stage or a later one (the **Blocked by** field; a card whose blockers are all finished is not blocked, as on the board), the **Bug** type shows every card whose type field is `bug`, an idea or a thread included, and **Done, not verified** shows the cards in the Done stage or a later one with acceptance criteria that nobody approved. A line beside the toolbar says how many cards match, with **Clear filters**. The Threads only button is not shown, because Type does that job.
- **Opening a card.** Click a row, or focus it and press Enter or Space, to open the card's page. `Esc` or the browser's Back button returns to the List.
- **Narrow windows.** The Labels, Milestone and Worked by columns are hidden, and Updated too on a very narrow one; if the rest still does not fit, the table scrolls inside its own box.

### The Milestones view

![The Milestones view of acme-shop: Launch v1 at 7 of 15 done, Holiday sale at 1 of 7 and Beta storefront at 2 of 2, each with its to do, in progress and done counts and its open cards](docs/milestones.png)

**Milestones** shows each milestone as a block: its title (a link to its page) with a state tag (**Open**, **Empty** or **Done**), a progress bar, a tag with the items waiting for you on its cards (to look at; answer them on the card), the number of its cards to do, in progress and done, and up to five of its open cards, each linking to its page. Open milestones come first, then empty ones, then done ones, each group in its own order. Ideas are left out of every count and of the open cards. In progress counts the cards in the working and review stages, to do counts every other stage that is not finished, and done counts the stage with the done role and any stage after it. When there are more open cards, "and N more" opens the List filtered to that milestone. A milestone whose cards are all done says so. See [Milestones](#milestones) for what a milestone is.

### Task and idea pages

A task or idea card opens the same way a thread does, so you can see what is happening in the task, what an agent is doing, and trace it.

- **Left, "Card":** the editable title, note, status, milestone and [card fields](#card-fields-workers-and-the-done-gate) (type, priority, labels, blocked by, acceptance criteria), with **Save**, **Cancel**, **Start as thread** and **Delete** pinned under them. Under the fields is a details list: kind, who added the card, when it was created and updated, and **Worked by** (a card with a lane also lists the lane's provider, model, effort, access and source, read-only). Below the form: a summary of the card's agent runs (agent type, running or finished, tokens, when; click one to jump to it) and the card's **History**.
- **Centre, "Agent runs":** each sub-agent run on the card as a turn: the prompt the main session gave it, its steps live while it runs, then the agent's final report. A finished run folds its steps into one line, such as "4 steps · 12s · 27.4k tokens". A card no agent has worked on says so in one line and how to get one. There is **no message box**: only the main session can talk to a sub-agent. **Start as thread** is how you get an agent you can message.
- **Right, "Trace":** one block per run with a step for each tool call (Read, Ran, Edited, Searched, Fetched), clipped to one line each; a call that failed is marked. Clicking a step scrolls to its run.
- **History:** newest first. It lists when the card was created, moved between stages and edited (title, note, milestone, lane and the [card fields](#card-fields-workers-and-the-done-gate)), when a worker was noted on it, and when Claude raised an item [waiting for you](#waiting-for-you) on it and named a worker, each by You or Claude with the time. When Claude named the worker, it is in brackets: "Claude (agent:worker) moved it from New to Review", "Worked on by Claude (lane:code-codex)", "Claude (thread:c4) asked you to review it". It keeps the last 50 entries. It records changes made through the board or Claude's tools; a card made before this feature has only its creation, and a session still running an older plugin version does not add to it.
- On a narrow window the three panes become tabs (Agent runs, Card, Trace); a card with no run opens on Card.

**Start as thread.** Pressing it (or **Start as thread** in the card's gear menu) opens a form at the bottom of the left pane, in place of the buttons. A card no agent has worked on shows "No agent has worked on this card" in the centre.

![The card Address autocomplete with the Start as thread form open: the session it reports to, Brief or Full copy, read-only or can edit files, and the agent worker, with Start and Cancel](docs/start-as-thread.png)

**Linking a run to a card.** The main session starts the Agent tool call's `description` with the card id in brackets, for example `[c24] fix the tax rounding`. The `board_add` reply, `/thread:track`, `/thread:add` and `/thread:board` remind Claude to do this whenever it hands a card's work to a sub-agent; you can also ask for it in words ("delegate c24, and put its id first in the description"). Two small hooks, `SubagentStart` and `SubagentStop`, notice the marker: at start they add a running run to the card, at stop they record the agent's report, step count and tokens and keep a snapshot of its steps (the stop hook waits about half a second for the agent's last transcript line, only for a run that is on a card). Both stay silent, never print into the session, and do nothing for a description without the marker, for a card that does not exist in this project, for a thread's own process, or in [chat-only mode](#chat-only-mode).

What is and is not shown:

- Only runs whose description starts with `[cN]` show. Work the main session does itself, and a delegation without the marker, shows nothing on the card (the card's History still shows its moves and edits).
- A card that has become a thread (Start as thread) or is a milestone does not take runs.
- What the code does for two cases nobody has seen in a live Claude Code session, so both are untested there: an agent that starts again with the same id (for example after it was sent a message) has its run reopened instead of getting a second one, and an agent started by another sub-agent is ignored.
- The steps come from the agent's own transcript, which Claude Code keeps under `~/.claude/projects/` (under `$CLAUDE_CONFIG_DIR/projects/` when that variable is set). That folder layout is not documented, so a future Claude Code version may change it and the page would then show no steps (the prompt, the report and the other figures still come from the hooks). Claude Code can also clean transcripts up, which is why a snapshot of each finished run's steps is kept in the project's logs folder (`cN.rM.activity.jsonl`, removed with the card). A long run keeps its newest 2000 steps and tool results, with a note that earlier ones are not shown; its step count is still the real one.
- The card's record keeps only a short preview of each run's prompt and report, with the step and token figures. The full texts are files in the logs folder (`cN.rM.prompt.txt`, `cN.rM.report.txt`), which the page loads when you open the card, so a card with many runs stays small.
- **Mark as stopped.** A running run shows a small **Mark as stopped** button. If the agent's transcript has had no new activity for 10 minutes, the run also says "No activity for N min; it may have stopped." Use the button when a session was closed or crashed while the agent ran, or its stop was lost: the run becomes Ended, not successful, with a note, and nothing else on the card changes. If the agent's real stop arrives later it closes the run normally.
- The board reads only the transcript file recorded on a run, and only when it is `agent-<id>.jsonl` under `~/.claude/projects/` and not behind a symlink; it never takes a path from the page.

### Card fields, workers and the done gate

A task or idea card can carry more than a title and a note. Claude sets these with `board_add` and `board_update`, and you set them on the card's page on the board; none is required, and a card without them looks and works as before. Milestones take none of them. A thread card can have a type, a priority and labels, but no blockers or criteria, so a card that has acceptance criteria or a **Blocked by** list cannot be started as a thread, even when all its blockers are done (**Start as thread** is greyed out on its page, with the line "A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first." under it; clear them, or keep it as a task). The board's List and `board_list` call a card blocked only while one of its blockers is not in the done stage or a later one.

| Field | Values |
|---|---|
| `type` | `task` (the default) or `bug`. |
| `priority` | `high`, `normal` (the default) or `low`. |
| `labels` | Up to 8 labels, each 1 to 24 characters. They are lowercased and trimmed. A repeated label is refused; the board's form drops repeats for you. |
| `blocked_by` | Up to 10 ids of other cards in the project that must be finished first. A card cannot be blocked by itself or by a milestone. A repeated id is refused. If a blocking card is deleted later, it simply drops out of the list. |
| `criteria` | Up to 10 acceptance criteria, each one line of up to 200 characters (a line break inside one is refused; give each line as its own criterion). Once a card has criteria, Claude can only add lines at the end: it cannot remove, reword or reorder them, because they are your test of the work. You change them on the board. |

Only values that differ from the default are stored. An empty value (an empty list, or an empty string) removes a field. A refused value is not saved, and the message says what is wrong. `board_list` shows the fields as short marks after the title (see [Tools Claude uses](#tools-claude-uses)). The board's card route (`PATCH /api/cards/<id>`, and `POST /api/cards` for a new card) takes the same five fields with the same checks, under the JSON keys `type`, `priority`, `labels`, `blockedBy` (camelCase, not `blocked_by`) and `criteria`, besides `title`, `note`, `status` and `parent` (and `kind` for `POST`). Both answer 400 for any other key, and the messages name the key you sent. The board may change or remove criteria freely.

**Editing the fields on the board.** A task or idea's page has the fields under Status and Milestone:

![The card Cart total drifts with two coupons: Type Bug, Priority High, labels checkout and payments, Blocked by c11 and c14 with their stages, three acceptance criteria and a Worked by list; in the centre four sub-agent runs (the analyst finds the rounding difference, the worker fixes it, the critic finds a gap with fixed-amount coupons, and a fourth run covers that gap) and the trace on the right](docs/card.png)

- **Type** (Task, Bug or Idea) and **Priority** (High, Normal or Low). Idea turns the card into an idea and Task or Bug turns an idea back into a task: Save sends `kind` (and `type`) with the other changes, and the Kind row in the details list follows. Choosing Idea changes only the kind: a bug that you turn into an idea keeps its bug type, so it stays a bug idea (it keeps its bug mark on the Board and in the List, and counts as an open bug while it is not finished). Choosing Task clears the bug type, and choosing Bug on an idea makes it a bug task. An idea does not count towards its milestone until it is a task.
- **Labels**, separated by commas. The labels show as chips under the box as you type, lowercased and without repeats.
- **Blocked by**, the ids of the cards that must be finished first, separated by commas. Each id shows below as a link to its card with the card's stage, plus "(done)" when that stage has the done role under another name, and an id that is not a card on the board shows "No card with this id".
- **Acceptance criteria**, one line each: **Add criterion** (or Enter in a filled line) adds a line and the **×** beside a line removes it, up to 10 lines of 200 characters.

**Save** sends only the fields you changed. A value the server refuses (see [Troubleshooting](#troubleshooting)) shows its message in the error banner, saves nothing and keeps what you typed. A milestone has none of these fields (nor a Status). A thread's page has no card form, so it lists its type, priority, labels and workers as read-only rows. The new-card form takes a priority and labels, and its **Type** select (Task, Bug, Idea or Milestone) sets the type: Bug makes a task of type bug. The List sorts and filters by these fields (see [The List view](#the-list-view)), and the Summary counts open bugs.

**Who worked on a card.** The card's page shows the workers as chips in its details list (**Worked by**, read-only; hover a chip for what it is), and the List has a Worked by column. `board_add`, `board_update` and `wait_add` take an optional `worker`: `main` (the session itself), `agent:<type>` (a sub-agent), `thread:<card id>` (a side thread) or `lane:<name>` (a [delegation lane](#delegation-lanes)). Claude is told to pass it every time. It is written into the history entries that call creates; `wait_add` adds an entry only when it is given a worker, and a `board_update` that changes nothing but the worker adds an entry of type `worked`, unless the latest entry already names that worker (thread cards get none). (A page of version 0.11.0 or earlier skips history entries of a type it does not know, so these are safe to leave in the data.) The board's data for each card also carries a `workedBy` list, built from those entries, from the sub-agent runs linked to the card, and for a thread from its agent or lane: each worker once, in the order they first appear. A very long agent or lane name is cut to fit the 64 characters a worker may have rather than left out.

**The done gate.** A card that has `criteria` cannot be moved by Claude into the stage with the **done** role until you have approved it:

- the card's latest closed review item (see [Waiting for you](#waiting-for-you)) must have been answered **Approve** on the board, and
- no review item on the card may still be open.

"Closed" means answered or withdrawn, and the latest one by the time it was closed decides. So if you approved one review, Claude then opened a second and withdrew it, the card is not approved; it needs a new approval. A review answered with **Request changes**, or closed with "answered in the chat" (which holds no verdict), does not count either. Only reviews closed after the card last left the finished stages count, so moving an approved card back out of Done and the stages after it (by you or by Claude) takes the approval away. Moving it from Done to Released, or between any two finished stages, does not. The card itself records when it left the finished stages (`leftDoneAt`), so this does not depend on its history, which keeps only the last 50 entries; for a move that an older plugin version made, which leaves no such record, the history is read as well. Version 0.12.1 and older recorded `leftDoneAt` for a move from Done to Released too, so such a card needs a new approval here: stricter, never looser. If an approval and a withdrawal are closed in the very same millisecond, the withdrawal wins. Changing the criteria does not take an approval away. Claude's way through is to raise a review item with `wait_add` (kind `review`) and to move the card after you approve. The gate follows your stages: it covers the stage with the done role, whatever it is called, and every stage after it. Claude cannot move a card with criteria into any of them, or add one there, until you approve it, and cannot move a card you dragged there unverified from one of them to another.

The board itself is never held to the gate: you can drag a card with criteria to the done column at any time. Such a card (in the Done stage or a later one) is shown as **not verified** (`verified: false` in the board's data, and `(done, not verified)` in `board_list`) until a review of it is approved. On the board its face has a **not verified** tag, its page has a **Done, not verified** note ("Claude may not move it to done or a later stage until you approve a review item; you moved it yourself."), and the List's **Done, not verified** button finds such cards. A card moved there by a session on an older plugin version is marked the same way, and so is a thread card that has criteria and has ended (version 0.11.0 could start a thread from a card with criteria; `board_remove` holds such a thread to the same rule as a task, while `thread_end` is not held). The mark is worked out when the card is read, never stored.

![The card Invoice PDF for every order in the Done stage, with the note Done, not verified above its Milestone field, and three acceptance criteria below](docs/not-verified.png)

Each project in the board's project list also carries counts of its cards: `open` (not in the Done stage or a later one, milestones left out), `done` and `waiting`. They fill the tiles on the [projects home](#projects-home-and-top-bar).

## Opening the board from your phone (tunnel)

`/thread:board --tunnel` opens the board to the internet for 12 hours, through a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), so you can look at it from your phone while you are away from your desk. It is off unless you ask for it.

**Set up (once).** Install `cloudflared`, Cloudflare's tunnel program. You need no Cloudflare account, and the plugin never downloads anything itself.

| System | Install |
|---|---|
| macOS | `brew install cloudflared` |
| Windows | `winget install --id Cloudflare.cloudflared` |
| Linux | Cloudflare's package repository, or the direct download from [developers.cloudflare.com/tunnel/downloads](https://developers.cloudflare.com/tunnel/downloads/). A plain `apt install cloudflared` does not work on every system. |

The plugin finds `cloudflared` on your `PATH`, or in the usual install places (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, and `%ProgramFiles%\cloudflared` on Windows). When it is missing, `--tunnel` tells you the line for your system; run the command again afterwards.

**Use.**

- `/thread:board --tunnel` asks you first (see below), then starts the tunnel and prints a remote link, the time it stops working, and what the link allows. The link looks like `https://<words>.trycloudflare.com/#t=<token>/<project>`. Open it on your phone.
- Run it again to see the same link and expiry. Asking again does not extend it.
- `/thread:board --tunnel stop` closes it at once. `/thread:board --stop` closes it too, as does anything that ends the board: closing the Claude Code window that serves it, or a newer plugin version taking the board over. A takeover does not carry the tunnel over; run `--tunnel` again.
- The tunnel runs from the session that serves the board. From another session, `--tunnel` asks that session to start it, so it works from any window. If the board is served by a session on an older plugin version, `--tunnel` says so: run `/thread:board` in an updated session first (it takes the board over), then `--tunnel`.

The page shows a **Remote** badge in its header with the time the link stops working. The cards, the Waiting view and the thread pages work as they do at your desk, and the page polls for changes as usual.

**What the link allows.** Whoever has the link acts as you on this board, from anywhere on the internet.

- **It can read:** every project on the board with its absolute path (which contains your username), every thread's reports and transcripts, sub-agent run prompts, reports and steps, the session list, the agents list and the lane settings.
- **It can do:** create and edit cards (which gives Claude new instructions, like a card you add yourself), answer or close [waiting items](#waiting-for-you) (which can approve a review, and wake Claude when [waking](#waking-the-session) is on, which may then change code), and ask for a thread's report to go to the main session (or take the request back). It acts as you, so it can also move a card that has criteria to done, or edit those criteria, as you can on the local board.
- **It cannot:** start a thread from a card, message a thread, end a thread, delete a card, mark a run as stopped, forget a project, stop the board, or change settings. These are refused with "not allowed through the tunnel", and the page hides those controls. The server enforces this; hiding the controls is only for convenience.

**Treat the link like a password.** Do not paste it into chats or issue trackers, and close the tunnel with `--tunnel stop` when you are done. The link carries its token after a `#`, which a browser never sends to a server, so Cloudflare does not see it in the address; it does carry all the traffic of the page, because Cloudflare is the path between your phone and your computer.

**Opening it needs your yes.** Claude does not open the tunnel on the first call: `board_open` answers "CONFIRMATION REQUIRED" with a code and opens nothing, Claude tells you what the link allows (the lists above), and it calls again with the code only after you agree. The code works once and expires after 10 minutes. Showing a link that is already open, and closing it, need no code. A side thread cannot open or close the tunnel at all.

**What it needs.**

- The computer awake, and the Claude Code session that serves the board still open. If the computer sleeps or goes offline, the link does not load until it is back (the 12 hours still run out on the clock). If the session closes, the tunnel is closed with it.
- Outbound access from the computer to Cloudflare on port 7844 (QUIC over UDP, or HTTP/2 over TCP). A work network or a firewall may block it.
- No uptime guarantee. A quick tunnel is a free service meant for tests; it can drop, and its address changes every time.

**How it is kept safe.** Everything below is the same on every system.

- The tunnel never points at the board's normal port. The plugin opens a second listener, on `127.0.0.1` and a free port of its own, which only the tunnel reaches.
- That listener accepts only a fresh random token made for this tunnel (at least 32 bytes, new each time the tunnel starts, compared in constant time). It never accepts your `board.token`, and the normal listener never accepts the tunnel's token.
- It requires the tunnel's own host name in the `Host` header, requires every write to come from exactly `https://<that host>`, and believes no `X-Forwarded-*` header.
- It answers at most 32 requests at once (then 503) and 60 changes a minute (then 429).
- The 12 hours are checked on every request, by a timer, and once a minute against the clock (a timer stands still while a computer sleeps); a late request gets "the tunnel has expired". At the end, or on `--tunnel stop`, the plugin revokes the token, closes the listener and stops `cloudflared`. It also stops `cloudflared` when its own process ends. A board that has been closed starts no new tunnel.
- `cloudflared` runs under a small watchdog (`scripts/tunnel-watchdog.mjs`) that ends it when the session that owns it ends, even if that session is killed outright, and at the expiry. After a hard kill, `cloudflared` is gone within a few seconds. The plugin records the watchdog, `cloudflared` and the owning session in `tunnel.pid` in the data directory. If a record is left whose owning session is gone, the next time the board starts or a tunnel is opened the plugin ends what it names, but only a process that is still `cloudflared` started with this plugin's arguments. It never touches the tunnel of a session that is still running.
- Responses carry `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

## How threads work

A thread opens full-window on the board (see [The Board view](#the-board-view)):

![The thread c34 opened full-window: its session id, Resume command, milestone, context, agent and tokens on the left; the conversation with a Happened, Decided and Open digest in the centre; the trace on the right](docs/thread.png)

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

- **Runs on your machine:** a local MCP server and five hooks (at session start, on each prompt, when a turn ends, and when a sub-agent starts or stops), all plain Node scripts in this repository. The turn-end hook starts a tiny Node process after every turn, whatever the setting; it exits at once when [waking](#waking-the-session) is off, when the session is a headless run, or in a side thread, having read at most the project's settings. Only when waking is on and someone is at the session does it stay, watch the project's settings and state file, and write one small `waiter-<session>.json` file; it makes no network request. The two sub-agent hooks run in every session. `SubagentStart` reads the project's `state.json` and settings and, only if the project has a task or idea and is not chat-only, starts a short background Node process and returns at once (Claude Code writes the agent's `agent-<id>.meta.json` file, which holds the description, only after the start hooks have returned, so the hook cannot wait for it). That process waits up to 5 s for the meta file and, when the description starts with `[cN]` for a task or idea of the project, writes the run into `state.json`, plus the prompt file in the logs folder. `SubagentStop` always reads `state.json` to see whether the agent has a run, and reads the meta file when it has none; for a tracked agent it also reads the agent's transcript, then writes the run, the snapshot and the report file. Without a marker they write nothing and print nothing. For each thread turn it starts the `claude` CLI in the background, in your project folder, or, for a thread on a [delegation lane](#delegation-lanes), the provider's relay script from the delegate skills, which starts that provider's CLI. To list [delegation lanes](#delegation-lanes) it runs the `delegate-setup` skill's `config.mjs load` script with Node, without a shell and with a time limit, at most once every 30 seconds per project; the script only reads, and the plugin never writes the lane config or its approval.
- **Flags it passes to a thread:** read mode passes `--permission-mode dontAsk` and `--disallowedTools Edit Write NotebookEdit`, so a read thread stays read-only even when your own Claude Code settings skip permission prompts; write mode passes `--permission-mode acceptEdits`. It never passes a flag that skips permissions. Every thread gets `--allowedTools WebSearch WebFetch` (see `THREAD_ALLOW_TOOLS`), and `--add-dir` for folders you named. It never edits your Claude Code settings.
- **Reads:** the end of the main session's transcript, to get the session's title and its model and effort; for a sub-agent run recorded on a card, that agent's transcript and meta file under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`) (read-only, only the file recorded on the run, never a symlink or a path from the board page); the agent files in `.claude/agents/`; the two `config.json` settings files; and the output of the delegate script (lane names, providers, models, efforts and whether a project's lane config is approved).
- **A lane run sends your work to another company.** A thread on a lane runs `codex` (OpenAI), `agy` (Google Antigravity), `opencode` (whatever provider its model uses) or a separate `claude` session, through the delegate skills' relay. That CLI sends the brief, your task and whatever files it reads to its own provider, under that provider's terms; the plugin does not control or see this. A write-mode lane lets that provider's CLI edit files in your project and, for `codex` and `claude` lanes, run shell commands there, under that CLI's own sandbox and permission rules and not Claude Code's; a write-mode `opencode` run approves its own actions without asking, and a codex lane whose sandbox is `danger-full-access` has no sandbox at all. The board can start such a run: **Start as thread** on a card that has a lane runs on that lane, in write mode if you choose it in the start step (the lane comes from the card, not from the page, and the page cannot set one). Use read mode for a lane unless you want edits, and do not give a lane to a card whose note should not leave your machine.
- **Sends nothing itself, unless you turn on the tunnel.** The plugin makes no network requests and has no telemetry. Its only listener is the board on `127.0.0.1`, and the board page loads nothing from the internet. The exception is [the tunnel](#opening-the-board-from-your-phone-tunnel), which you start yourself with `/thread:board --tunnel`: it runs `cloudflared`, which connects to Cloudflare, and a second listener on `127.0.0.1` that only that tunnel reaches. Threads are ordinary Claude Code sessions, so they talk to Anthropic as any session does and can search and fetch the web.
- **Stores,** all in the data directory on your machine:
  - each project's cards, thread replies and logs (`projects/<key>/state.json` and `logs/`), including each card's sub-agent runs (a preview of the prompt and report, tokens, the path of the agent's transcript), its history, and, in the logs folder, each run's full prompt, full report and a snapshot of its steps;
  - each card's [waiting items](#waiting-for-you) and your answers to them, in the same state file;
  - the settings files, `config.json` (global) and `projects/<key>/config.json`, if you ran `/thread:setup`;
  - `setup-hint`, an empty marker file that records that the setup hint was shown;
  - `board.token`, the board's access token;
  - `board.stopped`, a marker that exists while the board is stopped with `/thread:board --stop`;
  - `tunnel.pid`, only while a [tunnel](#opening-the-board-from-your-phone-tunnel) is open: the process ids of its watchdog, its `cloudflared` and the session that owns them, so a leftover one can be ended. The tunnel's token is never written to disk;
  - `projects/<key>/waiter-<session>.json`, one small file per session while [waking](#waking-the-session) is on: the background waiter's id, the answers that already woke the session, when it last woke the session and when a turn last started. Files not touched for a week are removed.

- **Web access is pre-approved for threads, with no prompt per site.** A full thread holds your whole conversation, and any thread can read the project, so a malicious page could try to talk it into sending that content somewhere. If that matters for your project, set `THREAD_ALLOW_TOOLS=none`.
- **The board is local, unless you turn on the tunnel.** It listens on `127.0.0.1` only, checks the request's host and origin, and requires the access token that is in the link from `/thread:board`. With `/thread:board --tunnel` a second listener, also on `127.0.0.1`, is reached through a Cloudflare tunnel; it has its own short-lived token, a fixed list of allowed routes and limits, and is described in [Opening the board from your phone](#opening-the-board-from-your-phone-tunnel). The token is stored in `board.token` in the data directory, readable only by you. The board page cannot change the settings. Its only writes besides cards and threads are your answers to [waiting items](#waiting-for-you), through `POST /api/p/<project>/cards/<card>/waits/<item>`, which passes the same token, host, origin and JSON checks as every write, takes only an answer for an item that is still open (the text, the chosen options, the tick or the verdict, and a comment), validates it for the item's kind and writes nothing else. They change through `/thread:setup` (Claude calls the `config_set` tool, which a side thread is not allowed to use) or by editing the files yourself.
- **Read mode keeps a thread from editing files, but is not a sandbox**, as described in [How threads work](#how-threads-work): a shell command or tool that your own allow rules approve by name still runs.
- **Thread and card contents are stored unencrypted** in the data directory, including each thread's replies. On macOS and Linux the data directory and the folders in it are readable only by you (mode 0700) and the files the plugin writes are 0600: the state, settings, logs, briefs, run prompts and reports, and the board token. The plugin makes the folders owner-only when it creates them and, once each time a session starts its MCP server, narrows the ones an older version made with the default modes. It changes only what you own, follows no symlink, skips hard-linked files and touches nothing outside the data directory; when `THREAD_DATA_DIR` names a folder, only the plugin's own files and its `projects` folder in it are changed, not the folder itself. A session still on an older plugin version writes new files with the default modes until a newer session next starts, so the owner-only folder is what keeps them private in the meantime. On Windows it does nothing of this kind, and a filesystem that ignores modes (some network or FAT-style mounts) keeps whatever it gives.

## Configuration

Behaviour of the board, the stages and [waking the session](#waking-the-session) (the `wake` setting, off by default) is set with [`/thread:setup`](#setup). Everything else is set with environment variables, in your shell or under `env` in `~/.claude/settings.json`.

| Variable | Meaning |
|---|---|
| `THREAD_ALLOW_TOOLS` | Tools pre-approved for threads, comma separated. Default `WebSearch,WebFetch`. `none` pre-approves nothing. |
| `THREAD_TIMEOUT_MS` | Longest a single thread turn may run. Default `1200000` (20 minutes). A lane turn passes it to the relay as `--timeout`. |
| `THREAD_BOARD_PORT` | First port the board tries. Default `47800`; up to 20 ports from there. |
| `THREAD_NO_HTTP` | Set to `1` to run without the board page. |
| `THREAD_DATA_DIR` | Where cards, thread results, settings and logs are kept. Default is the plugin's data directory, otherwise `~/.claude/thread-data`. |
| `THREAD_LOCK_WAIT_MS` | How long to wait for the state lock. Default `5000`. |
| `THREAD_CLAUDE_BIN` | Binary to run in place of `claude`. Used by the tests. |
| `THREAD_CLOUDFLARED_BIN` | Binary to run in place of `cloudflared` for the [tunnel](#opening-the-board-from-your-phone-tunnel). When set, it is the only place looked at. Used by the tests. |
| `CLAUDE_CONFIG_DIR` | Set by Claude Code's own users, not by this plugin: when it is set (to an absolute path), sub-agent transcripts are looked for in `$CLAUDE_CONFIG_DIR/projects` instead of `~/.claude/projects`. |
| `THREAD_CLAUDE_PROJECTS_DIR` | Test-only: replaces both as the only place the board and the sub-agent hooks accept a sub-agent transcript from. Tests and demos set it; leave it unset. |
| `THREAD_WAKE_POLL_MS`, `THREAD_WAKE_IDLE_MS` | Test-only: how often the [waking](#waking-the-session) waiter checks the state file (default `1500`) and how long it waits before giving up (default 12 hours). Leave them unset. |
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
    waiter-<session>.json     the waiting process of a session, only while waking is on
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
| A milestone shows 0 done although its cards are finished, or stays open | Progress counts the cards that are in the stage the `done` role points to or in a later stage. With the default roles a thread is done once it has ended (`/thread:end`), not when a turn has finished. Ideas do not count: turn an idea into a task to count it. Check the roles with `/thread:setup --show`. |
| "a milestone has no stage: it is done when all its cards are done" | A milestone's state comes from its cards. Move its cards instead; there is no status to set. |
| "c3 is a milestone: its kind cannot be changed", "c3 is a thread: its kind cannot be changed" or "a card can only become a task or an idea" | Only a task and an idea can swap kind (`board_update` with `kind`, or the Type select on the card's page). A thread or a milestone keeps its kind, and no card becomes a milestone. |
| A thread reports that a tool was refused | It needed a permission prompt it could not answer. Allow the tool in your Claude Code permission rules, add it to `THREAD_ALLOW_TOOLS`, or name the folder it needs in the task. |
| The board shows six fixed columns, or my stages and milestones are missing, after an update | A session that still runs an older plugin version is serving the board. A board tab that was already open says so in a line under the toolbar (the page's version note, or the older-session note about missing stages and milestones); a freshly loaded one shows the older page. Nothing is lost: reload that session's window, or run `/thread:board` in an updated session, then reload the page. Do not reload the page first: it would only show the older page again. |
| The board still shows the old page after a plugin update, or a note says "served by an older session" | A session on an older version is serving it. Run `/thread:board` in a session that has the new version (reload its window first). A board from before 0.8.2 cannot be replaced or stopped this way: reload the window of the session that serves it. |
| `/thread:board --tunnel` says cloudflared is not installed | Install it once (macOS `brew install cloudflared`, Windows `winget install --id Cloudflare.cloudflared`, Linux [Cloudflare's download page](https://developers.cloudflare.com/tunnel/downloads/)), then run the command again. It needs no account. |
| `--tunnel` says cloudflared did not give an address within 30 s | The computer is offline, or a firewall blocks outbound traffic to Cloudflare on port 7844 (QUIC over UDP, or HTTP/2 over TCP). Try another network, such as a phone hotspot. The message ends with the last lines `cloudflared` printed. If you already use `cloudflared` with a config file in `~/.cloudflared`, it can stop a quick tunnel from starting. |
| The remote link shows "This remote link has expired", or the page says the tunnel has expired | A tunnel lasts 12 hours, or it was closed (`--tunnel stop`, `--stop`, the serving session closed or replaced by a newer version). Run `/thread:board --tunnel` again for a new link. The old one never works again. |
| The remote link does not load, or Cloudflare shows an error page | The computer is asleep or offline, or the session that serves the board was closed. Quick tunnels have no uptime guarantee. Run `/thread:board --tunnel` again. |
| `--tunnel` says the board is served by an older plugin version | The session that serves the board runs a version from before the tunnel. Run `/thread:board` in an updated session first (it takes the board over, after reloading that window), then `--tunnel`. |
| A control on the remote page is missing, or a request says "not allowed through the tunnel" | The tunnel allows only reading, cards, waiting items and report requests. Starting or messaging threads, ending threads, deleting and stopping are possible only on the computer itself, in the normal board link. |
| The board says it needs its access link | The link was opened without its token, or from an old bookmark. Run `/thread:board` and open the link it prints. |
| `/thread:report` lists threads instead of reporting | This session started none or several unreported threads. Pass the id. |
| A thread shows "running" for a long time | Check its card on the board. A thread whose process died is marked failed the next time the board or a command looks at it. |
| A task's page shows no agent run although an agent worked on it | Only an Agent call whose `description` starts with the card id in brackets, such as `[c24] fix it`, is linked, and only to a task or idea of this project. Ask Claude to put the id first. The hooks need the plugin version with them (reload the window after an update). If Claude Code changes where it keeps sub-agent transcripts, the run still shows its prompt, report and tokens but no steps. |
| A run's steps say "The activity of this run was not kept" | Its snapshot could not be written and Claude Code has since removed the transcript. The prompt and report are still shown. |
| A run shows "Running" long after the agent finished, or says "No activity for N min; it may have stopped" | Claude Code did not send the stop event (the session was closed or crashed while the agent ran, or the stop hook could not get the state lock in time). Press **Mark as stopped** on the run: it becomes Ended, not successful, with a note. |
| The red **Waiting for you** pill is not there | Nothing is waiting, or you are on the Waiting view (which is that filter, so it has no pill), or the project is in [chat-only mode](#chat-only-mode), or the session serving the board runs a plugin version from before waiting items (reload that window; see the older-session note). |
| The Waiting view is empty | Nothing is waiting for you: it is the Board with only the cards that have open [waiting items](#waiting-for-you), and a note says so. A chat-only project has no Waiting view. |
| I answered an item but Claude did not react | Nothing is pushed into a session. The answer arrives with your next message in the session that asked; until then its line says "not yet delivered". Ask in the chat (`what is c37.w2?`) and Claude reads it with `wait_list`. If that session was cleared or closed, ask any session, for example "what did I answer on c37.w2?". |
| `board_update` says "cN has acceptance criteria: raise a review item with wait_add (kind review) and move it to done after the owner approves" | The card has acceptance criteria, and Claude may not move it to the done stage, or any stage after it, before you approve it. Claude should raise a review item on the card with `wait_add` (kind `review`); answer it with **Approve** on the board, and Claude can then move the card. A later review that you answered with **Request changes**, that was withdrawn, or that is still open, takes the approval away, and so does moving the card back out of the finished stages (Done and every stage after it). You can always move the card yourself on the board; it then shows as not verified. To drop the requirement, remove the criteria on the board (`PATCH /api/cards/<id>` with `criteria` set to `null`); Claude cannot remove or reword them. |
| `board_update` says "cN's acceptance criteria can only be changed by the owner on the board; you may add lines" | Claude tried to remove, reword or reorder the criteria of a card that has some. It may only add lines at the end. Change them yourself on the board, or tell Claude what to add. `board_remove` refuses a card with criteria the same way unless it is done or approved. |
| **Start as thread** is greyed out and shows "A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first." | A thread cannot hold criteria or a Blocked by list, and the list counts even when all its blockers are done. Clear them on the card's page, or keep it as a task. |
| Cards show **not verified** after I changed which stage has the done role (`config_set`) | The mark and the done gate follow the stage with the done role and the stages after it. A card with criteria that now sits in the new done stage or a later one without an approved review is marked, because nobody approved it for that stage. Approve a review of the card on the board and the mark goes. |
| Creating a milestone fails with "a milestone has no stage" | A board tab from version 0.12.x is still open after a newer version took over the board. That page still sends a stage with the new milestone, and milestones no longer have one. Reload the tab. |
| The board's card route answers 400 "unknown key blocked_by" (or another key) | `PATCH` and `POST` take `blockedBy`, in camelCase, and only the keys `title`, `note`, `status`, `parent`, `type`, `priority`, `labels`, `blockedBy` and `criteria` (`POST` also `kind`). |
| A card field is refused ("labels has too many entries", "blocked_by: card not found", "a milestone cannot have criteria" and so on), or **Save** on a card's page shows such a message in the red banner | The message is the server's (the board calls the key `blockedBy`) and names the field and the limit: up to 8 labels of 1 to 24 characters, 10 blockers (existing cards of this project, not itself and not a milestone), 10 criteria of up to 200 characters, a type of `task` or `bug`, a priority of `high`, `normal` or `low`, and a `worker` of the form `main`, `agent:<type>`, `thread:<card id>` or `lane:<name>`. Milestones take no fields; a thread takes no blockers or criteria. Nothing was saved: on the card's page the fields keep what you typed, so fix the one the message names and save again. |
| The tiles on the projects home show a dash for open, done or waiting | The board is now served by a session on an older plugin version, which does not send those counts. When the page notices, it says so in a line of its own. Run `/thread:board` in an updated session and reload the page. |
| A project shows only **Board** in its top bar, or has no Summary, List, Milestones or Waiting | The project is in [chat-only mode](#chat-only-mode), which shows threads on the Board only. `/thread:setup` turns the task board on. A tile for it on the home says chat-only once you have opened it on this page. |
| A link opens a different project than the one in it | The project in the link is not known to the board (it was forgotten, or the link is from another data folder), so the board opens the project of the session that serves it. Open the project from the projects home (`#/`). |
| The Summary shows little or nothing for old cards | A card keeps its last 50 history entries and older cards may have only their creation. Done time falls back to the card's last update, and time in a stage skips moves that are no longer in the history. Work by the main session appears only where Claude recorded a worker (a `worker` passed to `board_add`, `board_update` or `wait_add`), and tokens come only from sub-agent runs and thread turns. |
| A List row has no Labels, Milestone or Worked by | The window is narrow: those columns are hidden below about 760 px. Widen the window, or open the card. |
| My session did not wake when I answered or clicked **Report to main session** | Check, in this order. (1) Waking is off by default: `/thread:setup --show` should say it is on, and it must be on for the project the session works in. (2) Only the session that asked, or started the thread, wakes; another session does not. (3) The session must have finished at least one turn since waking was turned on, and must have been loaded after you updated the plugin (reload the window): the waiter starts when a turn ends. (4) A turn that is still running delivers at its end, not at once. (5) A side thread is never woken, nor a chat-only project without threads. (6) After 12 hours idle the waiter gives up; your next message starts a new one, and the answer reaches the session with that message anyway. (7) A headless run (`claude -p`, the Agent SDK) never wakes. (8) In Claude Desktop, waking has not been checked yet. |
| The session woke on its own and did something I did not expect | Waking was on and you answered an item or clicked **Report to main session** (perhaps from a stale tab). The session acts on it as if you had typed it. Turn waking off with `/thread:setup`; see [Waking the session](#waking-the-session). |
| `wait_add` is refused | The message says why: the card is a milestone, the project is chat-only, a side thread called it, a choice needs 2 to 8 distinct options, or the card already has 20 open items. |
| A finished thread was not announced | Announcements arrive with your next message to the session that started the thread. |

## What's new

- **0.13.0** [Opening the board from your phone](#opening-the-board-from-your-phone-tunnel): `/thread:board --tunnel` opens a remote link through a Cloudflare quick tunnel (cloudflared installed once, no account), after asking you first. It lasts 12 hours, uses its own key, and cannot start, message, end or delete threads or stop the board. Milestones have no stage: a milestone is open until every card in it is finished, then done, and it reopens when a card is added; ideas do not count. Milestones are no longer on the kanban; the Milestones view, the List and the Summary show their state. A card in Done or any later stage (such as Released) counts as finished everywhere: blockers, counts, the Summary and the review gate. The new-card form has one **Type** select (Task, Bug, Idea or Milestone), and a task can be turned into an idea and back, keeping its bug mark, from its page or with `board_update`.
- **0.12.1** The Summary view is centred on wide windows instead of sitting at the left.
- **0.12.0** The board is a project manager. It opens on a [projects home](#projects-home-and-top-bar) with a tile per project, and each project has a top bar with a [Summary](#the-summary-view) (work analytics), the Board, a sortable [List](#the-list-view), [Milestones](#the-milestones-view) and Waiting, in place of project tabs; a switcher in the header moves between projects. Cards can carry a [type, a priority, labels, blockers and acceptance criteria](#card-fields-workers-and-the-done-gate), which you edit on the card's page and which show on the card faces and in `board_list`. Claude can say who did the work (`worker`) and the card shows **Worked by**; its history says who did each step. A card with criteria cannot be moved to done by Claude until you approve a review of it (a new approval is needed after the card leaves done, and a withdrawn review counts as closed), Claude can only add lines to criteria, and a card with criteria or blockers cannot be started as a thread. A done card without that approval is shown as not verified. [Waking the session](#waking-the-session): with the new opt-in `wake` setting (`/thread:setup`), an answer to a waiting item or a click on **Report to main session** wakes an idle session at once, so it acts without waiting for your next message. Off by default, and turning it on through Claude needs your yes.
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
hooks/, scripts/    session-start and prompt hooks; waiter.mjs is the turn-end waiter of waking
skills/             the slash commands
server/
  state.mjs         paths, the state file and its lock
  config.mjs        settings: mode, wake, stages and roles, and the two config files
  sessions.mjs      session names, and the model a session runs on
  core.mjs          cards, milestones, threads, the wrong-session guard, project listing
  fields.mjs        the optional card fields (type, priority, labels, blocked-by, criteria), workers and card history
  lanes.mjs         delegation lanes: reads the lane settings from the delegate skills
  runs.mjs          sub-agent runs on a card, recorded by hooks, and their transcripts
  waits.mjs         the questions a session asks the user on the board, and their answers
  wake.mjs          what wakes an idle session from the board, and the one-waiter-per-session file
  runner.mjs        the detached process that runs one thread turn
  mcp.mjs           the MCP server and its tools
  http.mjs          the board server
  page.mjs          joins the board page's pieces into the one page the server sends
  board/            the board page: page.html (markup), css/ and js/ pieces that page.mjs joins into one page
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
