# Contributing

thread has no dependencies and no build step: plain Node ES modules, and `node:test` for the tests. For what the plugin does, start with the [documentation index](docs/README.md).

## Layout

```text
.claude-plugin/     plugin and marketplace manifests
hooks/, scripts/    session-start and prompt hooks (hook.mjs); waiter.mjs is the turn-end waiter of waking; tunnel-watchdog.mjs ends cloudflared with its session
skills/             the slash commands
server/
  state.mjs         paths, the state file and its lock; the read and write of a project kept in the repo
  repo.mjs          the board kept in the repo: finding the main checkout, the card files, the join with the machine's side, the copy and the old-version hint
  config.mjs        settings: mode, wake, codeMap, stages and roles, and the two config files
  sessions.mjs      session names, and the model a session runs on
  core.mjs          cards, milestones, threads, the wrong-session guard, project listing
  fields.mjs        the optional card fields (type, priority, labels, blocked-by, criteria), workers and card history
  layout.mjs        where you dragged the milestones on the Milestones map: a private file per project in the data folder
  lanes.mjs         delegation lanes: reads the lane settings from the delegate skills
  runs.mjs          sub-agent runs on a card, recorded by hooks, and their transcripts
  waits.mjs         the questions a session asks the user on the board, and their answers
  wake.mjs          what wakes an idle session from the board, and the one-waiter-per-session file
  notify.mjs        "Notify Claude" requests on cards Claude has not seen
  codemap.mjs       the note a new thread gets when `codeMap` is on and the project has a Graphify map
  runner.mjs        the detached process that runs one thread turn
  mcp.mjs           the MCP server and its tools
  http.mjs          the board server
  tunnel.mjs        the opt-in Cloudflare tunnel
  page.mjs          joins the board page's pieces into the one page the server sends
  board/            the board page: page.html (markup), css/ and js/ pieces that page.mjs joins into one page
test/               node:test suites, with a stub in place of the claude CLI
  fake-delegate/    fake delegate skills and relay for the lane tests
  fixtures/         data and small scripts the tests run
docs/               the documentation, and the screenshots it shows
```

## The done test

Run both from the repository root after every change:

```bash
node --test
claude plugin validate .
```

A change to a file in `server/board/` also needs a look in a browser: the page tests only read its source, and no test sees CSS.

## Trying the working tree

Sessions load the installed copy of the plugin, not this folder. To try your changes without installing them, start a separate session with `claude --plugin-dir .`.

Tests and probe scripts must not touch your real boards. Set `THREAD_DATA_DIR` to a temporary folder (`setupThreadEnv` in `test/helpers.mjs` does it), use port 0 or another free port for a board server, and set `THREAD_CLAUDE_BIN` to `test/fake-claude.mjs` so no test runs the real `claude` CLI. The environment variables are listed in [Configuration](docs/configuration.md#configuration).

## Documentation

A change that adds, removes or alters a feature updates the documentation in the same change: the feature's page under `docs/`, the [commands](docs/commands.md) and [troubleshooting](docs/troubleshooting.md) pages where they apply, and the release line in the [README](README.md) and the [changelog](CHANGELOG.md). Screenshots show invented data only (a fictional shop, `acme-shop`).

## Reporting a problem

Open an issue on [GitHub](https://github.com/ahmed0thman/thread/issues) with the plugin version, your Claude Code version, what you did and what you saw. Leave out tokens, the contents of `board.token` and anything private from your cards.
