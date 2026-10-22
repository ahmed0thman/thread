# Install and configuration

Part of the thread documentation: [index](README.md).

## Installing, updating and trying a clone

Requirements:

- Claude Code (tested on 2.1.289 and 2.1.299), with the standalone `claude` CLI on your `PATH`. Threads are started by running that CLI in the background, so the IDE extension alone is not enough.
- Node 20 or newer. The test suite passes on Node 20, 22 and 24; the author uses 24.

```bash
claude plugin marketplace add ahmed0thman/thread
claude plugin install thread@thread-marketplace
```

Restart Claude Code, or reload the editor window, so the plugin loads. It then works in the terminal and in the IDE extension's chat panel. It has not been tested in the Claude Desktop app. What has been run, and on which versions, is on the [evidence page](evidence.md).

### Staying up to date

Claude Code does not update a third-party marketplace such as `thread-marketplace` by itself, and nothing tells you a release exists unless you ask for it or turn on the update check (below, off by default). There are two ways to stay current.

**Turn on auto-update.** Only you can: in Claude Code run `/plugin`, open **Marketplaces**, pick `thread-marketplace` and choose **Enable auto-update** (Claude cannot do it for you). Claude Code then updates the plugin some minutes into a session and shows "Plugin updated: thread · Run /reload-plugins to apply".

**Update by hand.** Refresh the marketplace, then update the plugin (**Update now** in `/plugin` does the same), one command at a time:

```bash
claude plugin marketplace update thread-marketplace
```

```bash
claude plugin update thread@thread-marketplace
```

Either way, a session that is already open keeps the version it started with until you run `/reload-plugins` or reload the window, so reload it to use the new one.

**After an update**, thread says so once, with no network call. The first session that starts on the new version tells Claude, which passes it to you in one line, and the board shows a note at the top, **Updated to X.Y.Z · What's new**. **What's new** opens that release's entry from the plugin's own `CHANGELOG.md` (when the file or the entry is missing it shows "See the release notes" and the address of the releases on GitHub). **Dismiss** puts the note away for that version in your browser. The last version this machine announced is in `seen-version.json` in the data directory: a first install records it without announcing anything (a machine that ran an earlier version has no record yet, because no version before 0.24 kept one, so its first session on 0.24 says **Updated to X.Y.Z** without naming the old version), sessions that start at the same moment announce it once, and a version lower than the recorded one is never announced.

**The update check (optional, off by default).** With the `updateCheck` setting on, the plugin asks GitHub once every 24 hours which release is the latest, and when a newer one exists it says so once per version in the session note and on the board (**thread X.Y.Z is out**, with the two commands above, each with a **Copy** button). Turn it on with `/thread:setup` (one question) or with `config_set`; Claude must have your yes first, as for waking. An older plugin session (0.23 or earlier) that saves any setting drops `updateCheck` from the config file, because its validator removes keys it does not know: turn the check on again once every window runs 0.24 or later. It is the only network call thread makes besides the optional tunnel: [what it sends and when](security.md#the-update-check).

To try it from a clone without installing: `claude --plugin-dir <path to this folder>`. A clone of a project that keeps its board in the repo needs no setup; see [Keeping the board in your repo](storage-and-sync.md#turning-it-on). The one-time choices (stages, chat-only, waking, where the cards live) are made with [`/thread:setup`](board.md#setup).

## Configuration

Behaviour of the board, the stages and [waking the session](reviews-and-waking.md#waking-the-session) (the `wake` setting, off by default) and the [Graphify code map note](threads.md#code-maps-graphify) for new threads (the `codeMap` setting, off by default) are set with [`/thread:setup`](board.md#setup), and so is the [daily check for a new release](#staying-up-to-date) (the `updateCheck` setting, off by default). Everything else is set with environment variables, in your shell or under `env` in `~/.claude/settings.json`.

| Variable | Meaning |
|---|---|
| `THREAD_ALLOW_TOOLS` | Tools pre-approved for threads, comma separated. Default `WebSearch,WebFetch`. `none` pre-approves nothing. |
| `THREAD_TIMEOUT_MS` | Longest a single thread turn may run. Default `1200000` (20 minutes). A lane turn passes it to the relay as `--timeout`. |
| `THREAD_BOARD_PORT` | First port the board tries. Default `47800`; up to 20 ports from there. |
| `THREAD_NO_HTTP` | Set to `1` to run without the board page. |
| `THREAD_NO_OPEN` | Set to `1` so `board_open` never opens a browser (it answers with the address only). |
| `THREAD_OPENER` | A command to run instead of the platform's opener (`open`, `xdg-open`, `cmd /c start`); it gets the board link (with a one-time code, not the token) as its one argument. An exit code other than 0 counts as a failure; a process still running after 3 seconds counts as success. Used by the tests. |
| `THREAD_DATA_DIR` | Where cards, thread results, settings and logs are kept. Default is the plugin's data directory, otherwise `~/.claude/thread-data`. |
| `THREAD_LOCK_WAIT_MS` | How long to wait for the state lock. Default `5000`. |
| `THREAD_CLAUDE_BIN` | Binary to run in place of `claude`. Used by the tests. |
| `THREAD_CLOUDFLARED_BIN` | Binary to run in place of `cloudflared` for the [tunnel](security.md#opening-the-board-from-your-phone-tunnel). When set, it is the only place looked at. Used by the tests. |
| `CLAUDE_CONFIG_DIR` | Set by Claude Code's own users, not by this plugin: when it is set (to an absolute path), sub-agent transcripts are looked for in `$CLAUDE_CONFIG_DIR/projects` instead of `~/.claude/projects`. |
| `THREAD_CLAUDE_PROJECTS_DIR` | Test-only: replaces both as the only place the board and the sub-agent hooks accept a sub-agent transcript from. Tests and demos set it; leave it unset. |
| `THREAD_UPDATE_URL` | Test-only: the address the [update check](#staying-up-to-date) asks instead of GitHub (it also lets the check run under `THREAD_NO_HTTP=1`). Leave it unset. |
| `THREAD_WAKE_POLL_MS`, `THREAD_WAKE_IDLE_MS` | Test-only: how often the [waking](reviews-and-waking.md#waking-the-session) waiter checks the state file (default `1500`) and how long it waits before giving up (default 12 hours). Leave them unset. |
| `THREAD_DELEGATE_DIR` | The folder that holds the `delegate-setup` skill and the providers' relays (`<provider>-delegate`). Default `~/.claude/skills`. |

Set by the plugin itself, not by you: `THREAD_PROJECT_DIR` (the project a server belongs to) and `THREAD_DEPTH` (marks a thread's own process). `CLAUDE_CODE_SESSION_ID` is used as a fallback when a tool call carries no session id.

Files in the data directory:

```text
<data dir>/
  config.json                  global settings (optional)
  setup-hint                   marker: the setup hint was shown
  seen-version.json            the plugin version this machine last announced (see Staying up to date); older versions never read it
  update-check.json            only with updateCheck on: when GitHub was last asked and the latest release it named
  board.token                  the board's access token (replaced when the board is stopped)
  board-link.txt               the board link with the token, for you to open by hand (never shown to Claude)
  tunnel-link.txt              only while a tunnel is open: the remote link with the tunnel's token (removed whenever the tunnel ends; never shown to Claude)
  board.stopped                exists while the board is stopped
  projects/<key>/
    state.json                 cards and threads of one project
    config.json               settings for that project (optional); for a project kept in the repo, its wake setting
    repo.json                 only for a project kept in the repo: the record of the one-time copy and this machine's side of each card
    waiter-<session>.json     the waiting process of a session, only while waking is on
    logs/                      each thread's raw output, and for a card's sub-agent runs cN.rM.activity.jsonl (steps), cN.rM.prompt.txt and cN.rM.report.txt
```

## Where the settings live

Two optional JSON files, with the same shape:

| File | Applies to |
|---|---|
| `<data dir>/config.json` | Every project that has no setting of its own for that field. |
| `<data dir>/projects/<key>/config.json` | That project only. |
| `<repo>/.claude/thread/config.json` | That project only, when its board is [kept in the repo](storage-and-sync.md#keeping-the-board-in-your-repo-claudethread): the `mode`, `codeMap`, `stages` and `roles` (the repo file wins over the project file in the data directory, which keeps working for a project that was set up before it moved). `wake` and `updateCheck` are never read from it (both stay on this machine). |

`<data dir>` is the plugin's data directory, otherwise `~/.claude/thread-data` (see [Configuration](#configuration)). `/thread:setup --show` prints both paths, so you do not have to work out `<key>`.

The effective settings for a project are the defaults, then the global file, then the project file. A field in a later file replaces the same field from an earlier one. The `mode`, `wake`, `codeMap` and `updateCheck` are each chosen on their own. `stages` and `roles` always come together from one file, never mixed from two. A file that cannot be read, or that fails the checks below, is ignored, with a line on the plugin's stderr log; it does not stop anything.

Every field is optional. Here is a complete file:

```json
{
  "mode": "tasks",
  "wake": false,
  "codeMap": false,
  "updateCheck": false,
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
