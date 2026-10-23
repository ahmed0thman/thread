# thread documentation

Back to the [project README](../README.md). This is the full index: every feature, command, setting and troubleshooting entry is linked from here, grouped by what you want to do. Every screenshot in these pages shows an invented shop, `acme-shop`.

thread gives the work of Claude, its sub-agents, side threads and agents on your delegation lanes a local board: tasks with workers, stages and milestones, with questions and reviews on the cards they belong to. You manage the project; they do the work.

## Get started

- [Install, update, or try it from a clone](configuration.md#installing-updating-and-trying-a-clone): requirements, the two install commands, [staying up to date](configuration.md#staying-up-to-date) (auto-update, the "Updated" note, the optional daily check), `claude --plugin-dir`.
- [Quick start with a side thread](threads.md#quick-start): `/thread:new`, `/thread:report`, `/thread:board` and the flags that change a thread's defaults.
- [Setup](board.md#setup): `/thread:setup` chooses chat-only or the task board, your own stages, waking, code maps, the update check and where the cards live. You never have to run it; the defaults work.
- [Workflows](workflows.md): eighteen worked examples, from a side question to planning a release.

## Keep track of the work

- [The board](board.md#the-board): one page for every project. Open it with `/thread:board`.
  - [Projects home and top bar](board.md#projects-home-and-top-bar): a tile per project, the five views, the addresses.
  - [The Summary view](board.md#the-summary-view): open work, a line chart of cards created, done and open, work by worker with token use, the oldest waiting items, filters.
  - [The Board view](board.md#the-board-view): columns that follow your stages; a pulse marks cards with a running sub-agent or thread; each card's gear menu.
  - [The List view](board.md#the-list-view): a sortable table with filters for type, priority, label, blocked and done, not verified.
  - [The Milestones view](board.md#the-milestones-view): the route to each milestone as a map; drag to arrange it, link milestones by hand, name or remove any line.
  - [Task and idea pages](board.md#task-and-idea-pages): the card form, sub-agent runs linked to the card with their prompt, steps and report, the History timeline, long text and code blocks with a Copy button.
  - [Notify Claude](board.md#notify-claude): point a session at a card you added.
  - [Card fields, workers and the done gate](board.md#card-fields-workers-and-the-done-gate): type, priority, labels, blocked by, acceptance criteria, **Worked by**, and the done gate.
  - [Full access](board.md#full-access): the **Allow full access** switch on a card, which lets a worker run with no sandbox and no permission checks; only you can turn it on, on this machine.
  - [Card and waiting item links](board.md#card-and-waiting-item-links): a card or item id in any text is a link with a preview.
- [Add cards from the chat](commands.md#commands): `/thread:add` takes `--bug`, `--idea`, `--milestone`, `--priority`, `--label`, `--blocked-by`, `--criteria`, `--parent`, `--lane` and `--agent`.
- [Milestones](board.md#milestones): group cards under a milestone; its state comes from its cards. [Flags](board.md#flags) and [a worked example](board.md#a-worked-example).
- [Custom stages](board.md#custom-stages) and their [roles](board.md#roles); [cards whose stage was removed](board.md#cards-whose-stage-was-removed).
- [Chat-only mode](board.md#chat-only-mode): side threads without the task board.

## Answer questions and approve work

- [Waiting for you](reviews-and-waking.md#waiting-for-you): the four kinds (question, choice, review, to-do), drafts, one **Send** for every answer, and how an answer reaches Claude.
- [Waking the session](reviews-and-waking.md#waking-the-session): opt-in; an answer, a report click or a Notify Claude click wakes an idle session.
- [The done gate](board.md#card-fields-workers-and-the-done-gate): a card with acceptance criteria cannot be moved to done by Claude until you approve a review; what is enforced and what is only an instruction is in [Instructed or enforced](agent-behavior.md#instructed-or-enforced).

## Run work on the side

- [How threads work](threads.md#how-threads-work): brief or full copy, model and effort, the digest, read and write mode, permissions, cost and time.
- [Code maps (Graphify)](threads.md#code-maps-graphify) and [several sessions and projects](threads.md#several-sessions-and-projects).
- [Choosing the agent and model](agent-behavior.md#choosing-the-agent-and-model) and [catch-up notes on follow-ups](agent-behavior.md#catch-up-notes-on-follow-ups).
- [Delegation lanes](delegation.md): run a thread on Codex, OpenCode, Antigravity or another Claude session. [Starting a thread on a lane](delegation.md#starting-a-thread-on-a-lane), [putting a lane on a card](delegation.md#putting-a-lane-on-a-card), [choosing a worker on the board](delegation.md#choosing-a-worker-on-the-board).

## How Claude uses the board

- [How Claude uses the board](agent-behavior.md#how-claude-uses-the-board): the guide Claude is given.
- [Instructed or enforced](agent-behavior.md#instructed-or-enforced), and [the tools Claude uses](agent-behavior.md#tools-claude-uses).

## Keep the board with the project, or check it from your phone

- [Keeping the board in your repo](storage-and-sync.md#keeping-the-board-in-your-repo-claudethread): [what is in the repo and what stays on the machine](storage-and-sync.md#what-is-in-the-repo-and-what-stays-on-the-machine), [turning it on](storage-and-sync.md#turning-it-on), [committing the folder](storage-and-sync.md#committing-the-folder), [worktrees and sub-folders](storage-and-sync.md#worktrees-and-sub-folders), [card ids](storage-and-sync.md#card-ids), [conflicts](storage-and-sync.md#conflicts), [older sessions and the import hint](storage-and-sync.md#older-sessions-and-the-import-hint).
- [The update check](security.md#the-update-check): opt-in, once a day, what it sends and keeps.
- [Opening the board from your phone (tunnel)](security.md#opening-the-board-from-your-phone-tunnel): `/thread:board --tunnel`, opt-in, 12 hours, what the link allows.

## Settings, security and help

- [Configuration](configuration.md#configuration): environment variables and the files in the data directory. [Where the settings live](configuration.md#where-the-settings-live): the two settings files and their fields.
- [Security](security.md#security): what runs, what is sent and what is stored.
- [Full access](security.md#full-access): what a thread in mode `full` is allowed to do, who can allow it, and the limit of that.
- [Commands](commands.md#commands): every slash command and flag.
- [Troubleshooting](troubleshooting.md#troubleshooting): what you see, the cause and the fix.
- [Evidence](evidence.md): the author's dated checks and the measured token result.
- [Changelog](../CHANGELOG.md) and [Contributing](../CONTRIBUTING.md).
