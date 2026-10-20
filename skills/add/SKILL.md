---
name: add
description: Add a task, bug, idea or milestone card to the project's kanban board without acting on it.
argument-hint: "[--bug] [--idea] [--milestone] [--priority high|low] [--label <x>] [--blocked-by <ids>] [--agent <name>] [--parent <id>] [--lane <name>] [--criteria \"<line>\"] the card"
---

Call the `board_add` tool for the card in the arguments. The default is a task. Flags win over what the words suggest.

- `title`: a short title.
- `note`: the detail the user gave, in their words.
- `kind`: `task` by default. `idea` with `--idea`, or when the user is musing or exploring. `milestone` with `--milestone`: a card that groups other cards.
- `type`: `bug` with `--bug`, or when the text starts with "bug:" or plainly says something is broken ("the export button is broken"); leave it out for anything else. Not for a milestone.
- `priority`: `high` or `low` with `--priority high|low`; leave it out for normal. Not for a milestone.
- `labels`: one entry per `--label <x>`; the flag may repeat or take a comma list (`--label ui,export`). Up to 8. Not for a milestone.
- `blocked_by`: the card ids after `--blocked-by`, comma or space separated (`--blocked-by c4,c7`). Not for a milestone.
- `criteria`: one acceptance criterion per `--criteria "<line>"`; the flag may repeat. A card with criteria needs the user's approval of a review item before it can be done. Not for a milestone.
- `parent`: the id of a milestone, with `--parent <id>`. Without `--parent`, when the user names a milestone in words, find it with `board_list` and use its id. A milestone cannot have a parent.
- `lane`: the name of a delegation lane, with `--lane <name>`. Only a task or idea can have one. You may also set a lane yourself when the user or the project's instructions say which lane suits the work; otherwise leave it out. A card with a lane runs on that lane when it is started as a thread from the board (**Start as thread**); no tool starts an existing card as a thread, and `/thread:new --lane <name>` starts a new thread card on a lane instead. So only set a lane on a card when the work should run there. If the tool refuses the lane (unknown name, not approved, or no delegate skills), pass its message on and ask whether to add the card without a lane.
- `agent`: the name of a sub-agent, with `--agent <name>`. Only a task or idea can have one, and a card has a lane or an agent, never both. If the tool refuses the name, pass its message on.
- `worker`: who is adding it: `main` from the main session, `agent:<type>` from a sub-agent, `thread:<id>` from a side thread, or `lane:<name>` from a lane run.

Flags may appear anywhere in the arguments. Remove them from the text. If the tool says the task board is off, pass that on and stop. If the tool refuses a value (an unknown card in `--blocked-by`, a flag a milestone cannot have), pass its message on.

Confirm in one line with the card id, then return to the current work. Do not start working on the card. If the user then asks you to hand the card to a sub-agent, start the Agent call's description with the card id in brackets, for example `[c12] fix the rounding`: the board shows that agent's prompt, steps and report on the card.
