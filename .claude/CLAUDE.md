# CLAUDE.md

Guidance for Claude Code when working in this repository. `README.md` is the short front page (what it does, install, first use, limits, evidence, an index); the user-facing reference for every feature is the pages in `docs/*.md` (`docs/README.md` is the index). Read the page for the area you are about to change. This file holds what the docs do not: how to work here.

## What this is

`thread` is a Claude Code plugin. It starts side threads (background `claude -p` sessions that get a brief, work on one task and report back only when asked) and serves a local kanban board of tasks, ideas, milestones and threads. Plain Node ES modules, no dependencies, no build step.

```text
.claude-plugin/     plugin.json (the version lives only here; its mcpServers starts server/mcp.mjs as the plugin's MCP server, so the repo
                    root has no .mcp.json, which Claude Code would also read as a broken project server inside this repo), marketplace.json, icon.png
hooks/, scripts/    SessionStart, UserPromptSubmit and Sub-agent hooks (scripts/hook.mjs); the Stop hook's background waiter that wakes an idle session (scripts/waiter.mjs)
skills/             the slash commands; each SKILL.md tells Claude which tool to call
server/
  state.mjs         paths, the state file and its lock; the read and write of a repo-backed project (it joins repo.mjs in)
  repo.mjs          the board kept in the repo (.claude/thread/): the main checkout, card files, the join with this machine's overlay, the one-time copy, drift; imports only fields.mjs
  config.mjs        settings: mode, wake, codeMap, stages and roles, global and per-project files
  sessions.mjs      session names, and the model a session runs on
  core.mjs          cards, milestones, threads, the wrong-session guard, project listing
  lanes.mjs         delegation lanes: reads the lane settings from the delegate skills (never writes them)
  laneevents.mjs    a lane turn's provider events (codex, opencode) turned into thread activity, and the reader that follows the events file as it grows; provider output is data, so it uses only strings and never throws
  runs.mjs          sub-agent runs on a card: recorded by hooks, their transcripts read for the board
  waits.mjs         the questions a session asks the user on the board, and their answers
  wake.mjs          what wakes an idle session from the board (setting `wake`), and the one-waiter-per-session file
  notify.mjs        "Notify Claude" requests on cards Claude has not seen: which are open, and the line the prompt hook adds
  fields.mjs        card fields (type, priority, labels, blockedBy, criteria), history workers, workedBy; no imports
  runner.mjs        the detached process that runs one thread turn
  codemap.mjs       the note a new thread gets when `codeMap` is on and the project has a Graphify map (graphify-out/GRAPH_REPORT.md); only checks the file exists
  update.mjs        the update notices: the per-machine version record (seen-version.json), the opt-in GitHub check (setting `updateCheck`; the plugin's only network call besides the tunnel), the changelog entry for the board's /api/update
  layout.mjs        the Milestones map's dragged positions, per project and per machine (projects/<key>/milestone-layout.json); never in the repo
  mcp.mjs           the MCP server and its tools
  http.mjs          the board server (loopback only, token, Host and Origin checks); the one-time code board_open opens the browser with and its exchange route; also the remote policy and allowlist of the tunnel's listener
  tunnel.mjs        the opt-in Cloudflare tunnel: finds and runs cloudflared, the pid file, the manager (token, lifetime, listener)
  page.mjs          assembleBoardPage(): joins the board pieces into the one page GET / sends; lists them, in order
  board/            the board page's source pieces; no framework
    page.html       markup, the tiny theme script, and placeholders inside <style> and <script>; it also opens and
                    closes the script's `(function () { 'use strict'; ... })();` wrapper around the placeholder
    css/*.css       the style pieces; their order is CSS_PIECES in server/page.mjs
    js/*.js         the script pieces (fragments of one scope, not modules); their order is JS_PIECES in server/page.mjs
test/               node:test suites; fake-claude.mjs stands in for the claude CLI
  fake-delegate/    fake delegate skills and relay for the lane tests
  fixtures/         data and small scripts the tests run; node --test also runs every .mjs here, so a script must exit 0 with no arguments
docs/               the documentation pages (*.md, docs/README.md is the index), the screenshots, evidence.md; demo/capture.mjs makes docs/demo.png and docs/demo.gif
                    from a scripted headless-Chrome run with invented data (not run by node --test)
```

## Done test

Run both from the repository root after every change, and report the real output:

```bash
node --test
claude plugin validate .
```

A change to a file in `server/board/` also needs a look in a browser (see "Checking the board page"); the page tests only read its source. So does a CSS-only change: no test sees it.

A test never passes an inline script to `node -e`; put the script in `test/fixtures/` (the plugin directory's validator flags it).

## Rules that are easy to break

- **The running plugin is not this folder.** Sessions load the installed copy under `~/.claude/plugins/cache/thread-marketplace/thread/<version>/`. An edit here changes nothing for a running session until it is released and installed (see "Releasing"). To try the working tree without releasing, start a separate session with `claude --plugin-dir .`.
- **Never test against the owner's real data or boards.** Real data is in the plugin's data directory (`~/.claude/plugins/data/thread-thread-marketplace`, or `~/.claude/thread-data`). Tests and probe scripts set `THREAD_DATA_DIR` to a temporary folder (`setupThreadEnv` in `test/helpers.mjs` does it). Ports from 47800 up are the owner's live boards: use port 0 or another free port, and stop any server you start.
- **Never run the real `claude` CLI from tests.** Set `THREAD_CLAUDE_BIN` to `test/fake-claude.mjs`. If a check truly needs the real CLI, say so first; it costs tokens and leaves a session file under `~/.claude/projects/` that must be deleted afterwards.
- **Several plugin versions share one data directory.** Each open Claude Code session keeps the plugin version it started with until its window is reloaded, so an old process and a new one read and write the same state file. A new field must be safe for an older version to ignore, a stored value an older version writes must still be handled, and nothing may be migrated in place. The board is served by one session; from 0.8.2 a newer version replaces an older board.
- **The data directory is owner-only.** A folder the plugin makes there goes through `mkdirPrivate`/`mkdirPrivateSync` and a file it writes gets `mode: PRIVATE_FILE` (both in `server/state.mjs`); `tightenDataDir()` narrows older ones at MCP start. Do not write into the data directory with the default modes.
- **A repo-backed project** (the folder `.claude/thread/` at the main checkout's root, see `docs/storage-and-sync.md`): its task, idea and milestone cards are files in `cards/`; threads, runs, `seenByClaude`/notify fields, who asked a wait (`askedBy`) and the wake setting stay in the data directory. `state.json` is the old store older versions write: the one-time copy and the overlay live in `projects/<key>/repo.json`, never in `state.json` (the copy leaves it byte-identical). Never write an absolute path, a session id or a pid into a repo file (a test scans for them); a card file with conflict markers or bad JSON is skipped and never rewritten or deleted; a new field of a card must be sorted into `LOCAL_KEYS` or shared in `server/repo.mjs`; `wake` is never read from the repo's `config.json`. A card id is `CARD_ID_RE`/`CARD_ID_SRC` in `server/fields.mjs` (`c37` or `c8k2x1`): do not write a new `c[0-9]+` regex. A repo file is never believed about local things: `stripLocal` removes them on read, and the done gate counts only approvals in this machine's overlay (`approvals`). A write re-checks the file on disk first (merge or refuse, `RepoConflictError`); card files are created exclusively and never overwritten by a copy or import. The store key is the real path of the main checkout.
- **Stages are not fixed.** Never hard-code `in_progress`, `done` and so on outside the defaults in `server/config.mjs`. Use the project's effective config (`readConfig`) and its roles. A thread card's stage is always derived from its run state.
- **The board's guarantees:** it listens on `127.0.0.1` only, requires the access token, checks Host and Origin on writes, makes no network calls, and cannot change settings. Do not weaken any of them. The one exception is the tunnel (`/thread:board --tunnel`), which is opt-in and token-gated: a second `127.0.0.1` listener (own port, fresh token, exact tunnel Host and Origin, a route allowlist that defaults to deny, limits) that `cloudflared` points at, which lasts 12 hours and never carries over. The tunnel never points at the normal port, never accepts `board.token`, and a new route is closed to it until it is added to the allowlist in `server/http.mjs`. The cloudflared pid file and the child must be cleaned up on every way the tunnel or the process can end.
- **Text that reaches the page is set as text, never as HTML.** The board page (`server/board/`) has no `innerHTML` sinks; keep it that way.
- **Cross-version tests run released code.** They take it from a git tag or a release commit (`RELEASED_REFS` in `test/helpers.mjs`), never `HEAD`, which stops meaning a release once new work is committed. A missing ref fails the test; only a checkout with no git history skips.
- **No over-engineering.** Build what was asked. If a request is unclear or turns out to need a design decision, stop and ask.
- **Secrets:** never print or log environment values, tokens or the contents of `board.token`.

## Working agreements with the owner

- **Commit or push only when the owner asks.** Work in the tree, verify, report, then wait for the word. Never push without it.
- **The docs change with the feature.** Any change that adds, removes or alters a feature updates the docs in the same piece of work: the feature's own page in `docs/`, `docs/commands.md`, `docs/troubleshooting.md`, the index `docs/README.md`, and the README's "Documentation" list when a page or section is new. Keep them comprehensive: a reader should find every feature and be able to use it from the docs alone. The README front page says only what is instructed and what is enforced, so never add a guarantee there that the code does not enforce. Internal changes (tests, refactors) need no docs change.
- **Real CLI checks.** When correctness depends on how Claude Code or a provider CLI behaves (hooks, transcripts and their timing, permissions, session continuation, relays), a fake is not proof: run the real CLI, at most a few runs. Set `THREAD_DATA_DIR` to a scratch folder and `THREAD_NO_HTTP=1`, work in a scratch project, never pass a permission-skipping flag, and afterwards delete the scratch session folders under `~/.claude/projects/` and check the listing is back as it was.
- **Report plainly.** Say what was tested and what was not. A claim of "works" needs a run behind it.
- **Delegation.** The owner prefers the lead to split work into bounded briefs for the sub-agents in `.claude/agents/` (`worker`, `worker-high`, `analyst`, `critic`; the models and efforts fixed in their files are the maintainer's defaults, change them to suit your own plan), run a `critic` pass on each finished chunk, and track each delegated task as a card on this project's board (`board_add`, `board_update`; never `done` unless verified). Write briefs that stand alone: files to touch, behaviour, the done test, and what not to do.
- **Routing.** The delegation lanes are in `.delegate/config.json` (git-ignored; run through the `*-delegate` skills). Most work goes to the Claude sub-agents; the Codex lanes get a small share, for a hard problem a sub-agent got stuck on or an independent read-only second opinion. Never use the opencode "go" lanes (that plan is gone). No review or debate through the astra model unless the owner asks. Google models only for low-stakes bulk work.
- **Side questions** the owner starts with `/thread:new` run as threads; do not wait for them or poll them.

## Checking the board page

The page is checked with headless Chrome against a demo server, never against the live board:

1. A small script outside the repository sets `THREAD_DATA_DIR` to its own folder, writes a state file with invented data, and calls `startBoardServer(projectDir, { port, token })` from `server/http.mjs`.
2. Screenshot: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --user-data-dir=<temp> --window-size=1440,900 --virtual-time-budget=4000 --screenshot=<file>.png "http://127.0.0.1:<port>/?t=<token>#/<project key>"`. The address is a hash: `#/` is the projects home, `#/<project key>` a project's default view (Summary, or Board when it is chat-only), `#/<project key>/<view>` one of `summary`, `board`, `list`, `milestones`, `waiting`, and `#/<project key>/<card id>` a card's page (`cN` or `new`). Headless Chrome will not go narrower than about 500 px; `Emulation.setDeviceMetricsOverride` over the DevTools protocol goes narrower, and `Emulation.setEmulatedMedia` picks light or dark (the system theme decides otherwise).
3. Clicks and typing need Chrome's DevTools protocol (`--remote-debugging-port`); plain screenshots cannot do them. Say what was not exercised.
4. Check light and dark, a narrow width, a project with custom stages, and a chat-only project.

Screenshots for `docs/` use invented data only (a fictional shop), and the header path is replaced with a neutral one such as `~/code/acme-shop`. Look at every image before it is committed: no real project names, paths, session ids or usernames.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` (the only place it lives). Keep the `description` there and in `.claude-plugin/marketplace.json` in step.
2. Add the release to `CHANGELOG.md` (newest first) and replace the README's "Latest release" section with it (version, date, two or three changes). Every file stays under 256,000 bytes (the validator's limit is 256 KiB per file).
3. **Every release reflects its changes everywhere a user reads about the plugin** (the owner's rule): the README's opening, "What installing changes", "Short tour" and "Limits and data flow", the screenshots in `docs/` that show a changed screen (retake them with invented data; `node docs/demo/capture.mjs` remakes the demo image and GIF), each feature's own docs page, `docs/commands.md` and the tools section of `docs/agent-behavior.md`, the `description` in `plugin.json` and `marketplace.json`, and the GitHub About text and topics (`gh repo edit`, `gh api .../topics`). Check each one against the release's changes before tagging, and say in the release report which were updated.
4. Run the done test.
5. When the owner asks: commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z` and `gh release create vX.Y.Z` with notes written for users.
6. Update the owner's install: `claude plugin marketplace update thread-marketplace`, then `claude plugin update thread@thread-marketplace`. Tell them which sessions still run the old version (`pgrep -fl "server/mcp.mjs"` shows the version folder of each) and that those windows need a reload.

The repository is also submitted to Anthropic's plugin directory, whose validator scans every file in it. What it has flagged before, so do not reintroduce it: an inline `node -e` script in a test (use a file), a remote-looking URL next to a `${...}` placeholder, a missing icon. Keep every non-image file under 256 KiB and the repository under 512 files. The board page is split into the pieces in `server/board/` for this reason (the server joins them, so the browser still gets one self-contained page): each piece must stay under 256 KiB (`wc -c server/board/page.html server/board/css/* server/board/js/*`; the limit is 262144 bytes per file), and a test holds each to 200 KB so there is room left. `server/board/js/thread.js` is the largest, about 60 KB when this was written: when a piece gets near 150 KB, split it. The pieces are joined in the order listed in `server/page.mjs` (`CSS_PIECES`, `JS_PIECES`) with nothing between them, so the order is part of the page: **a new piece must be added to that list**, and a test fails when a file in `css/` or `js/` is not listed (or a listed one is missing). The script pieces are fragments of one scope, each starting at a line boundary, so a cut may only be made between top-level statements. No script piece may contain `</script` nor a style piece `</style`; a test checks that too.

## Not yet tested

Known gaps, so nobody assumes otherwise: real drag and drop between custom stages; a real clipboard write for "Copy report"; `/thread:setup` and the one-time setup hint in a live session; `--full` together with `--agent`; threads started from the board with the real CLI; a real browser opener launch on each platform; real codex and opencode lanes with live steps (the relays are fakes); screen readers; Windows.

## What is planned

Ideas and their notes are cards on this project's board (`/thread:board`), grouped under the milestone "Project management in thread". None is started; each needs the owner's go, and the larger ones need a design agreed first.
