---
name: setup
description: "Set up the thread plugin: chat-only or the task board, your own stages, and whether that applies to every project or just this one."
argument-hint: "[--show] [--reset]"
---

Set the plugin up through a short conversation. Ask one question at a time. Use the question tool when this client has one, otherwise ask in plain text. Give the default choice first, with a one-line explanation of each choice. Do not ask anything the arguments already answer. Do not change any card.

1. Call the `config_get` tool and show the current settings in a few lines: the mode, the stages in order, which stage each role uses, where each came from, and the two config file paths. If a file is marked as ignored, say so and why.
   - With `--show` in the arguments, stop there.
   - With `--reset`, ask which scope to reset (global, meaning the setting for every project, or project, meaning this project only), call `config_set` with that `scope` and `reset: true`, tell the user the result in a line or two, and stop.
2. Otherwise ask, in this order:
   - Where the setting applies: every project (`scope: "global"`) or only this project (`scope: "project"`). Say that cards and threads are always stored per project either way.
   - What to use thread for: threads only (`mode: "chat"`: side threads, no task board), or threads plus the task board (`mode: "tasks"`: cards, ideas and milestones).
   - Stages, only for the task board: the default six (Idea, New, In progress, Review, Blocked, Done), or their own. For their own, ask how they work in their own words, then propose a list of 2 to 10 stages. Give each a short id (lowercase letters, digits and underscores, starting with a letter) and a label of up to 30 characters. Say in plain words which stage each role uses: where a new card lands (start), where a running thread sits (working), where a finished turn waits for a look (review), where a failed thread sits (blocked), and where an ended thread goes, which is also what counts as done for a milestone's progress (done). For example "a running thread sits in Doing". Change the list until they agree.
3. Call `config_set` once with the agreed values: `scope`, `mode`, and for their own stages `stages` and `roles` together. For the default stages with `scope: "global"`, pass `stages: null`, which removes an older choice from that file. For the default stages with `scope: "project"`, pass the six default stages themselves (`idea` Idea, `new` New, `in_progress` In progress, `review` Review, `blocked` Blocked, `done` Done), because `null` there falls back to whatever the global file says. Report the result in a few lines and say they can run `/thread:setup` again at any time.
