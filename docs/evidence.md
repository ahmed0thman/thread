# Evidence

Part of the thread documentation: [index](README.md).

This page lists dated checks that the author ran against real Claude Code and provider CLIs while building thread. It is the author's own evidence, labelled as such: no outside user reports exist yet. It is not a guarantee. A test count is not a passing result, and a dated observation says nothing about the current version unless it is marked current.

The facts below come from the notes on the author's own thread board and from git history. Where a note does not record a version or a step, this page says "not recorded".

## Automated checks

The suite runs with `node --test` and the plugin directory validator with `claude plugin validate .`, both from the repository root. The count of tests is whatever the runner reports on the day you run it; numbers quoted elsewhere on this page are what the author saw on a past date, for example 213 tests at 0.7.0, 264 at 0.9.0, 695 and then 741 on 2026-10-14. The current plugin version is 0.24.2.

On 2026-10-20, at 0.22.0 with the launch changes in the working tree, the suite passed in full (1297 tests; 1298 at the 0.23.0 release) on Node 20.18.1, 22.13.0 and 24.16.0 on macOS, and on Node 20.20.2 in a Linux container; `claude plugin validate .` passed on Claude Code 2.1.299. One timing-sensitive assertion in the repo tests, which failed under load on Node 20 and 22, was corrected the same day. The CI workflow (`.github/workflows/test.yml`: the suite on Ubuntu Node 20, 22 and 24 and macOS Node 24, plus the validator) runs on pushes to main and on pull requests; its first run, on the 0.23.0 release commit (2026-10-20), passed every job: the suite on Ubuntu Node 20, 22 and 24 and macOS Node 24, and the validator. On 2026-10-22 the 0.24.0 release commit (1392 tests) passed every job as well: the suite on Ubuntu Node 20, 22 and 24 and macOS Node 24, and the validator on Claude Code 2.1.304. On 2026-10-23 the 0.24.1 release commit (1394 tests) passed every job too. The 0.24.2 release commit (1419 tests) failed one job, Ubuntu Node 22: a repo linked-run test swept once while the runner was still exiting (the sweep rightly leaves a beating runner alone). The test was fixed to sweep until the runner is gone, and the next commit passed every job.

## Real Claude Code checks

Checks 2 to 5 ran in a scratch repository with a scratch data directory, away from the author's own boards, and the notes record that the scratch session folders were deleted afterwards. Check 1's note does not say where it ran. A fake CLI cannot prove how Claude Code or a provider CLI behaves, which is why these were run for real.

### 1. Lean thread run, 0.7.0

| | |
|---|---|
| Date | 2026-10-13 |
| Plugin | 0.7.0 (commit 7d532fb) |
| Client version | not recorded |
| Run | One real lean thread, run as the haiku-coder agent |
| Expected | not recorded |
| Observed | It ran. 213 tests passed, the plugin validated, the board page was checked in a browser |
| Limits | A single run. The card does not record the prompt, the token numbers or the Claude Code version |

### 2. How Claude Code reports a sub-agent run to a plugin

| | |
|---|---|
| Date | 2026-10-14 |
| Plugin | not recorded (a proof run for the sub-agent run tracking design, card c41) |
| Client version | Claude Code 2.1.289 |
| Run | Three small real `claude` runs, foreground and background sub-agents, with a plugin hook listening |
| Expected | The design could find the card for a run, read its report and count its tokens |

Observed:

- SubagentStart and SubagentStop both fire for a plugin hook, for foreground and background agents. Stop gives the agent id, agent type, the transcript path and the last assistant message, but no description.
- The agent's meta file holds the description from the Agent call (where the `[cN]` card marker goes) and exists before the transcript's first line, so the card can be found at SubagentStart.
- The transcript is written live, a step every 0.1 to 0.3 s. Its first line is the prompt.
- SubagentStop fires about 130 ms before the last transcript line is flushed, so the report must come from the last assistant message, or the transcript must be re-read after a short wait.
- Each response is split into one line per content block, each line repeating its usage. Counting every line double-counts; count each message id once, at its last line.
- For a background agent, PostToolUse fires at launch, not at completion.

Verdict recorded then: the design works with three changes (find the card from the meta description, take the report from the last assistant message, deduplicate tokens by message id).

Not determined: a resumed agent (continued with SendMessage) and nested sub-agents.

### 3. Delegation lane relays, first run per provider

| | |
|---|---|
| Date | 2026-10-14 |
| Plugin | not recorded (lanes were built that day; 0.10.0 is the lanes release) |
| Client versions | codex 0.160.0, agy 1.3.4, opencode 1.18.34, claude 2.1.289 |
| Run | Per provider: a first read-only run, a resume, and a stop test |

Observed:

- Resume works on all four: each follow-up recalled the word given in the first run. The session id sits under a different key per provider (codex `threadId`; agy `conversationId`; opencode and claude `sessionId`).
- Stop works on all four: SIGTERM to the relay gives exit 143, a result file with status "aborted", and no child process left.
- codex, opencode and claude write a live event log, each in its own format. agy writes no events, only a diagnostic log (which contains an account email, so it is never shown raw).
- Usage in the result file: claude gives usage and cost; opencode gives cost only; codex gives none there but has token counts in its turn-completed event; agy gives none.
- A claude relay run starts the thread plugin's own SessionStart hook in the child session.

Not tested: write-capable runs, a relay timeout, a run that fails on a bad model name, Windows. agy left a project entry in its own config folder.

### 4. Delegation lanes, end to end through the plugin

| | |
|---|---|
| Date | 2026-10-14 |
| Plugin | the working tree's MCP server, version not recorded |
| Client versions | not recorded separately; same CLIs as check 3 |
| Run | Real relays through the plugin's MCP server, one scratch repository, its own data directory, no board server |

Observed:

- Read turn and follow-up recall worked on codex, claude, opencode and agy.
- Write turn and write follow-up worked on codex, claude and opencode (a file created, then edited in the follow-up). codex's sandbox was re-applied on resume.
- agy write was refused on every agy lane. Refusals for a lane combined with model, agent, effort, full copy, extra_dirs and an unknown lane all gave clear messages.
- `thread_end` on a running codex turn: the relay aborted with exit 143, no process was left, the card ended.
- With the lane config not approved, lanes showed as not approved and start and follow-up were refused; re-approval restored them.
- On the claude lane, trace and tokens were present after the turn, tokens were counted once, and the child session did not register itself.

Defects found and sent for fixing: a codex failure showed only "codex failed" (the reason was in the event log); "touched files" listed the whole dirty working tree rather than what the turn touched; a malformed step map was shown raw; `lane_list` did not say "approved"; a claude read lane tried to leave plan mode. One small extra read thread ran on a global lane by mistake (a slip by the worker, recorded as such).

Not run: a relay timeout, the board's Start as thread with a real relay, concurrent turns.

### 5. Waking an idle session from the board

| | |
|---|---|
| Date | 2026-10-14 (owner's Desktop check ticked 2026-10-15) |
| Plugin | built on 2026-10-14; the commit that added waking is 0.12.0. The check ran on the code before release |
| Client version | Claude Code 2.1.299, model haiku |
| Run | A real session in a scratch project with the `wake` setting on (a Stop hook starts a background waiter after each turn) |

Observed on the final code:

- An answer given on the board woke the idle session in 2 s. Claude acted on it, and it was delivered once.
- A Report click woke the session once; Claude called `thread_report` and summarised.
- A typed prompt that quoted the wake marker was treated as a normal prompt.
- After `/exit` no waiter was left.
- Headless `claude -p` from a plain terminal exited in 6 s and left no waiter file.

Known edge: a `claude -p` started from inside an editor session, with the child-session marker removed by hand, counts as attended and hangs at exit. Normal nested runs keep the marker and are skipped.

The board shows the owner ticked "Done" on the follow-up asking whether a Claude Desktop session woke by itself, on 2026-10-15. The tick carries no comment, so what that check looked like in detail is not recorded here.

### 6. Smoke test of the promoted workflow on 0.22.0

This is the check that covers the workflow the README leads with. One run, marked current for 0.22.0. Its facts come from the run's saved outputs and transcript (kept by the author, not published), summarised on card cgvs12.

| | |
|---|---|
| Date | 2026-10-20 |
| Plugin | 0.22.0 (the installed copy) |
| Client version | Claude Code 2.1.299, Node 24.16, model Claude Fable 5.1 |
| Where | A scratch project (an invented shop) with its own data directory and board port; five `claude -p` turns, the second to fifth resumed from the first; no permission-skipping flag, the plugin's board tools and the edit tools allowed by name |
| Waking | Off (the default): answers arrive with the next message |
| Cost | About $2.21 for the five turns |

What was asked, and what happened:

1. **Does the guide arrive?** Asked whether its instructions include a guide from a "thread" plugin. Claude quoted the guide's first sentence, and repeated the one-time setup hint the SessionStart hook adds. The session transcript holds the plugin's instructions. This turn also primed the session: the tasks that follow were given to a session that had just been asked about the plugin.
2. **Two tasks, one with acceptance criteria, with no mention of the board.** Asked for a coupon rounding fix "done when the cart and order totals match with stacked coupons and a regression test covers two coupons", and a second small question about the files. Claude listed the board, added both cards before editing (the fix as a bug with the two criteria; the question as a plain task), made the fix with a regression test, moved the fix card to review and raised a review item on it, and moved the question card to done itself, which the gate allows because it has no criteria. One waiting item, not two: the question needed none.
3. **Answer on the board, continue the session.** The answer went in through the board's Send route (the board only runs while a session is open, so it was started by hand for the request), as "request changes" with a comment asking for a one-coupon case (the tester's own choice, so that the gate could still be tried in step 4; a manual correction). The next turn's prompt carried the plugin's line "The user answered c1.w1 on the board ... asked for changes". Claude added the test, moved the card back to review and raised a second review item.
4. **The done gate.** Asked in the chat to "mark the coupon fix card done now". Claude closed the open review item as answered in the chat and called the stage change; the plugin refused it: a card with acceptance criteria moves to done only after an approval given on the board. Claude did not retry: it raised a third review item asking for Approve on the board. After that approval, the next turn moved the card to done, confirmed from the stored state rather than from the chat.

Not exercised: the Send and Approve clicks in a real browser (only the routes they call); two items answered in one batch (only one existed); a question or choice item; a long interactive session rather than resumed `-p` turns. One run on one model: what Claude did on its own here is an observation, not a guarantee.

## Token use, measured once

Measured on 2026-10-17 with real runs, after the author asked for a real test of whether the plugin saves tokens. The plugin version is not recorded. Total spend on the two tests was about $10.50.

**Test 1, a thread against doing the work inline.** Two pairs, one medium side question, no follow-ups, about $2.40 in all. The thread cost about 66% more in total ($0.70 against $0.42). The main session stayed a little cleaner. The model for this test is not recorded on the card.

**Test 2, a thread against a built-in sub-agent on big side work.** Two runs each, a big audit plus two follow-ups, $8.12 in all. Every sub-agent and thread ran on Sonnet 5.5. All four runs found the same write paths.

| | Sub-agent | Thread |
|---|---|---|
| Grand cost (mean, range) | $2.37 ($2.01 to $2.73) | $1.69 ($1.49 to $1.89) |
| Fresh tokens | 495k | 267k |
| Big audit | $0.76 | $0.68 |
| Follow-up 1 | $0.51 | $0.29 |
| Follow-up 2 | $0.59 | $0.22 |
| Main session time spent on the side work | 590 s | 71 s |

The thread cost 29% less overall and the ranges do not overlap. The main session's context and cost were about equal. The difference comes from follow-ups: a sub-agent reads the files again for each one, while a thread resumes its own session.

Caveats: n = 2 per arm, one repository, one model. Continuing the same sub-agent with SendMessage was not tested, and that may narrow the gap.

Plain conclusion: a side thread costs more than doing small work inline, and less than a fresh sub-agent on big side work with follow-ups. It is never a reason on its own to install thread.

## One episode from building thread with thread

Two reviews of the done gate and the board page changed a patch before it landed. On 2026-10-14 the card c1i021 collected the findings of a second review by Codex (c65) and of the final Claude critic into one fix round, which took about 20 minutes on the board. A worker sub-agent made the changes and the lead re-ran the whole suite (695 pass, 0 fail) and the plugin validator.

The findings were specific, not stylistic. The done gate could be fooled: the time a card left done was only read from history, so it is now stored on the card. Threads made from cards with acceptance criteria lacked the not-verified mark. If an approval and its withdrawal were recorded in the same millisecond, the withdrawal now wins. `POST /api/cards` now answers 400 for unknown keys. A new-card address on a chat-only project showed a blank page and now shows the default view, and two weak tests were rewritten to prove what they claimed. In all, the card lists 15 items.

Browser probes passed for five of the page fixes; middle-click and ctrl-click in a real browser were not exercised. The card was in review when last updated, and its note does not name the release it shipped in. The other candidates were left out because their notes record less: c0hn5y says only that a critic found 8 defects, and c11z96 holds the plan, not the outcome.

## What is not yet shown

- No outside user reports exist. Everything above is the author's own.
- Not tested: real drag and drop between custom stages; a real clipboard write for "Copy report"; `/thread:setup` and the one-time setup hint in a live session; `--full` together with `--agent`; threads started from the board with the real CLI; screen readers; Windows.
