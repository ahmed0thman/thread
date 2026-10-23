#!/usr/bin/env node
// Hook entry point for the thread plugin. Any failure exits 0 with no output.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONTEXT = 600; // the notices; report requests are kept whole
const MAX_TOTAL = 1500;
const WOKEN_LEAD = 'This turn was started by the thread board, not typed by the user.';

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, ms);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

function emit(eventName, additionalContext) {
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
  return new Promise((resolve) => process.stdout.write(out + '\n', () => resolve()));
}

const SETUP_HINT = 'The thread plugin has not been set up. Tell the user once, when it does not interrupt their request, that /thread:setup lets them choose chat-only or the task board, their own stages, and whether that applies to every project. Updates arrive by themselves only when the user turns on auto-update in /plugin, under Marketplaces, thread-marketplace (Claude cannot do that for them).';

// Tasks mode only: when to raise a waiting item, and the answers no session has received. Never fails the note.
function waitNote(core, projectDir, sessionId) {
  try {
    if (!core || !projectDir || core.readConfig(projectDir).mode === 'chat') return '';
    let out = '\nPut each task on the board before you start it (board_add, or board_update the card). Every question, choice, review request or to-do for the user goes through wait_add on that card, with one line in the chat such as "Waiting on you: c37.w2" (as wait_add returns it); never only in the chat. CRITICAL: a lane does a card\'s work only through thread_start (lane, card), never a delegate relay you run in the shell.';
    const n = core.countUndeliveredElsewhere(projectDir, sessionId);
    if (n > 0) out += `\n${n} answered waiting item${n === 1 ? '' : 's'} on the board ${n === 1 ? 'was' : 'were'} asked by another session and not delivered; wait_list reads ${n === 1 ? 'it' : 'them'} if relevant.`;
    return out;
  } catch {
    return '';
  }
}

// A repo-backed project (its board is the folder .claude/thread/ in the repo): tells the session once that its cards are committed files, and
// names what needs the user: card files that cannot be read (a git conflict), cards an older plugin version left in this machine's old store,
// and a folder that has gone missing. Says nothing for a project that keeps its board on the machine. Never fails the note.
async function repoNote(core, projectDir) {
  try {
    if (!core || !projectDir) return '';
    try { await core.startRepo(projectDir); } catch { /* the note is made from what is there */ }
    const info = core.repoInfo(projectDir);
    if (!info.backed) {
      if (info.refused) return `The folder .claude/thread/ of this repo is not used as the board: ${info.refused}. Tell the user once if it matters.`;
      return info.wasBacked ? 'This project\'s board used to be kept in the repo (.claude/thread/), but that folder is missing now (another branch checked out, or deleted). The board shows this machine\'s older cards until it is back; tell the user once if it matters.' : '';
    }
    const lines = [];
    if (info.mark && !info.mark.announced) {
      lines.push(`This project keeps its board in the repo, in .claude/thread/: every task, idea and milestone card is a file in cards/ that the user commits with the rest of the project${info.mark.copied ? ` (${info.mark.copied} card${info.mark.copied === 1 ? ' was' : 's were'} copied there from this machine's board)` : ''}${info.mark.skipped ? ' (the folder already had cards from another device, so this machine\'s older cards were not copied)' : ''}. Tell the user once that the new files are to be committed.`);
      try { await core.markRepoAnnounced(projectDir); } catch { /* it is said again next time */ }
    }
    for (const n of info.notices.slice(0, 5)) lines.push(core.repoNoticeLine(n));
    const added = core.driftLabels(info.drift, 'added');
    const changed = core.driftLabels(info.drift, 'changed');
    if (added.length) lines.push(`${added.length} card${added.length === 1 ? '' : 's'} (${added.slice(0, 10).join(', ')}) on this machine's older board ${added.length === 1 ? 'is' : 'are'} not in the repo: an older plugin version in another session added ${added.length === 1 ? 'it' : 'them'}. Call board_import to copy ${added.length === 1 ? 'it' : 'them'} over.`);
    if (changed.length) lines.push(`${changed.length} card${changed.length === 1 ? '' : 's'} (${changed.slice(0, 10).join(', ')}) ${changed.length === 1 ? 'was' : 'were'} changed on this machine's older board after the copy; the repo keeps its own version. board_import reports ${changed.length === 1 ? 'it' : 'them'} and stops mentioning ${changed.length === 1 ? 'it' : 'them'}.`);
    const legacy = core.legacyLine(info.legacy);
    if (legacy) lines.push(legacy);
    const ambiguous = core.ambiguousAliasLine(info.ambiguousAliases);
    if (ambiguous) lines.push(ambiguous);
    return lines.join('\n');
  } catch {
    return '';
  }
}

// The line that points a new install at /thread:setup: only while no config file exists, and once
// per machine (a marker file in the data dir). A marker that cannot be written must not break the hook.
function setupHint(core, projectDir) {
  try {
    const marker = join(core.dataDir(), 'setup-hint');
    if (existsSync(marker) || core.readConfig(projectDir).configured) return '';
    try {
      core.mkdirPrivateSync(core.dataDir());
      writeFileSync(marker, '', { mode: core.PRIVATE_FILE });
    } catch { /* the hint then shows again next time */ }
    return SETUP_HINT;
  } catch {
    return '';
  }
}

// Once per update, said by the first session after it (the record is seen-version.json in the data dir, see server/update.mjs): the plugin
// was updated, and, when the opt-in update check knows of a newer release, that it is out. A first install says nothing. Never fails the note.
async function updateNote(core, projectDir) {
  try {
    if (!core || !core.VERSION) return '';
    const u = await import(new URL('../server/update.mjs', import.meta.url).href);
    const on = !!projectDir && core.readConfig(projectDir).updateCheck;
    const r = u.announce(core.VERSION, on ? u.readCheck().latest : null);
    const lines = [];
    if (r.updated) lines.push(`thread was updated to ${core.VERSION}. Tell the user once, in one line, and point them to the board's What's new.`);
    if (r.out) lines.push(`thread ${r.out} is out (this is ${core.VERSION}): tell the user once and how to update (claude plugin marketplace update thread-marketplace, then claude plugin update thread@thread-marketplace, then reload the window).`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

// A sub-agent started or stopped: the runs module records it on the card named in the Agent call's description
// ("[c24] ..."), and does nothing when the description has no such marker. Prints nothing, ever.
async function subagent(event, input, projectDir) {
  if (!projectDir) return;
  // A start never holds the session up waiting on the state lock. A stop waits longer (its timeout is 10 s): losing it leaves the run open.
  process.env.THREAD_LOCK_WAIT_MS = event === 'SubagentStop' ? '5000' : '1000';
  const runs = await import(new URL('../server/runs.mjs', import.meta.url).href);
  if (event === 'SubagentStart') {
    // Claude Code writes the agent's meta file, which holds the description, only after this hook has returned: waiting here is
    // pointless and would hold the agent up. A detached worker waits for it and records the run; this hook returns at once.
    if (!runs.canTrack(projectDir)) return;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'SubagentStartWorker'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, THREAD_HOOK_INPUT: JSON.stringify(input), THREAD_HOOK_PROJECT: projectDir, THREAD_HOOK_AT: String(Date.now()) },
    });
    child.on('error', () => {});
    child.unref();
  } else await runs.stopRun(projectDir, input);
}

// The background worker of a SubagentStart: waits for the meta file, records the run, exits. Silent, whatever happens.
async function startWorker() {
  const input = JSON.parse(process.env.THREAD_HOOK_INPUT);
  process.env.THREAD_LOCK_WAIT_MS = '5000';
  const runs = await import(new URL('../server/runs.mjs', import.meta.url).href);
  await runs.startRun(process.env.THREAD_HOOK_PROJECT, input, { retryMs: runs.META_WAIT_MS, eventAt: Number(process.env.THREAD_HOOK_AT) || 0 });
}

async function main() {
  if (process.env.THREAD_DEPTH) return;

  const raw = await readStdin(2000);
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== 'object') return;

  const event = process.argv[2] || input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit' && event !== 'SubagentStart' && event !== 'SubagentStop') return;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  // Checked here, not through core, so the SessionStart note survives a core that fails to load.
  if (!/^[0-9A-Za-z-]{8,64}$/.test(sessionId)) return;

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    await subagent(event, input, process.env.CLAUDE_PROJECT_DIR || input.cwd);
    return;
  }

  let core = null;
  try { core = await import(new URL('../server/core.mjs', import.meta.url).href); } catch { /* the note below does not need it */ }

  // Before the session is registered (which makes the project's state file): the update note asks whether this machine has run the plugin
  // before, and a first session's own state file would answer yes.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const update = event === 'SessionStart' ? await updateNote(core, projectDir) : '';

  // Register the session and its name. Never hold up the user's prompt waiting on the state lock.
  if (core && projectDir) {
    process.env.THREAD_LOCK_WAIT_MS = '1000';
    try {
      await core.touchSession(projectDir, sessionId, {
        transcriptPath: input.transcript_path,
        sessionTitle: input.session_title,
      });
    } catch {
      // naming is best effort
    }
  }

  if (event === 'SessionStart') {
    let note = `[thread plugin] This session's id is ${sessionId}. Pass it as session_id to thread_start, thread_report, thread_end, thread_continue and thread_status.`;
    note += waitNote(core, projectDir, sessionId);
    const repo = await repoNote(core, projectDir);
    if (repo) note += `\n${repo}`;
    const hint = core && projectDir ? setupHint(core, projectDir) : '';
    if (hint) note += `\n${hint}`;
    if (update) note += `\n${update}`;
    await emit('SessionStart', note);
    return;
  }

  if (event === 'UserPromptSubmit') {
    if (!core || !projectDir) return;
    const { reconcile, pendingAnnouncements, pendingReportRequests, readState } = core;

    // A turn is starting, so the session is no longer idle: the background waiter (scripts/waiter.mjs) stops. The next Stop starts a new one.
    // It also says whether this is the turn the waiter woke the session for: it recorded that a moment ago. What the prompt says proves
    // nothing, since a user can type the waiter's own words.
    let woken = false;
    let wake = null;
    try {
      wake = await import(new URL('../server/wake.mjs', import.meta.url).href);
      woken = await wake.stopWaiter(projectDir, sessionId);
    } catch { /* best effort */ }

    await reconcile(projectDir);
    const announced = await pendingAnnouncements(projectDir, sessionId);
    const requested = await pendingReportRequests(projectDir, sessionId);
    const state = readState(projectDir);
    const cfg = core.readConfig(projectDir);
    // The cards the user clicked "Notify Claude" on for this session and that it has not listed yet (read-only: a request ends when this
    // session lists the board). Their lines and the answers' share one budget (core.HOOK_BUDGET): at most a few requests, within half of it,
    // and the ones left over are named in a line, not dropped; the ones not carried before come first, so each reaches the session in turn.
    let open = [];
    try { open = core.pendingNotifies(projectDir, sessionId); } catch { /* the other notices still go out */ }
    const looks = [];
    const carried = [];
    const heldBack = [];
    let used = 0;
    for (const c of open) {
      const stage = cfg.taskStages.find((x) => x.id === core.effectiveStatus(c, cfg));
      const line = core.notifyLine(c, stage ? stage.label : String(c.status), sessionId);
      if (looks.length >= core.MAX_NOTIFIED_AT_ONCE || (looks.length && used + line.length + 1 > core.HOOK_BUDGET / 2)) { heldBack.push(c); continue; }
      looks.push(line);
      carried.push({ id: c.id, notifyId: c.notifyId });
      used += line.length + 1;
    }
    // The requests above are carried by this prompt: a turn end does not wake the session for them again. Marked before the answers are, so that
    // nothing that can wait lies between delivering an answer and printing it; if this fails the requests are still open and come again.
    try { await core.markNotifyCarried(projectDir, carried); } catch { /* a wake may then repeat them once */ }
    // Chat-only: the task board is off, so new board cards are not mentioned. A card with a request has its own line.
    const unseen = cfg.mode === 'chat' ? [] : state.cards.filter((c) => c.seenByClaude === false && !open.some((n) => n.id === c.id));
    // A card of a repo-backed project that this machine has no record of having shown to Claude came with a pull (another device, or a collaborator):
    // nothing in a file proves the user wrote it, so it is only pointed out, never called new from the user.
    const fresh = cfg.mode === 'chat' ? [] : state.cards.filter((c) => c.newInRepo === true && c.seenByClaude !== false && !open.some((n) => n.id === c.id));
    // Answers to what this session asked the user on the board, marked delivered under the state lock so each is carried once, and only as
    // many as fit in what is left of the budget (some room is kept for the lines about what is left over).
    // This is the last step that can wait or fail before the text is printed: an answer must not be marked delivered and then lost.
    let answered = [];
    try { answered = await core.deliverWaitAnswers(projectDir, sessionId, { budget: core.HOOK_BUDGET - used - 400 }); } catch { /* the other notices still go out */ }
    // Answers that did not fit stay undelivered. They must still reach the session: with the next prompt, and, when waking is on, with a wake,
    // which a waiter makes only for answers that have not woken the session yet.
    const leftover = [];
    let left = [];
    try {
      left = wake ? wake.undeliveredAnswerKeys(projectDir, sessionId) : [];
      if (left.length) leftover.push(`${left.length} more answer${left.length === 1 ? ' is' : 's are'} waiting; ${left.length === 1 ? 'it comes' : 'they come'} with your next message.`);
    } catch { /* the line is a courtesy; the answers follow anyway */ }
    const heldLine = heldBack.length ? core.notifyMoreLine(heldBack) : '';

    if (!announced.length && !unseen.length && !fresh.length && !requested.length && !answered.length && !looks.length) {
      // Woken by the board but nothing is left to carry (it was delivered meanwhile): say so, so the turn does not go looking.
      if (woken) await emit('UserPromptSubmit', `${WOKEN_LEAD} What the user did there has already reached you; there is nothing more to act on. Say nothing about it and stop.`);
      return;
    }

    const lines = [];
    for (const c of announced) {
      const verb = c.thread.runState === 'failed' ? 'failed' : 'finished';
      const tail = verb === 'failed'
        ? 'call thread_status for details if relevant'
        : 'not yet reported; call thread_report only if the user asks or it is relevant';
      lines.push(`Thread ${c.id} "${core.clip(c.title, 50)}" ${verb} — ${tail}`);
    }
    if (unseen.length) {
      lines.push(`${unseen.length} new board card${unseen.length === 1 ? '' : 's'} from the user — call board_list when the current task allows`);
    }
    if (fresh.length) {
      lines.push(`${fresh.length} card${fresh.length === 1 ? ' is' : 's are'} new in the repo (another device or a collaborator) — board_list shows ${fresh.length === 1 ? 'it' : 'them'}`);
    }
    let notices = lines.join('\n');
    if (notices.length > MAX_CONTEXT) notices = notices.slice(0, MAX_CONTEXT - 1) + '…';
    // The user asked for these by clicking, so they come first and are not cut by the notices' cap.
    const asks = requested.map((c) => `The user clicked "Report to main session" on the board for thread ${c.id} "${core.clip(c.title, 50)}". Call thread_report with id "${c.id}" now and give them the digest.`);
    // The requests carried above are quoted as data (see core.notifyLine), outside the cap, like the answers.
    const cap = (t) => (t.length > MAX_TOTAL ? t.slice(0, MAX_TOTAL - 1) + '…' : t);
    // The answers go first and outside the cap (each line is clipped on its own, and at most a few per prompt), so they are never cut off.
    // An answer that only the repo file has is information (framed so by deliveryLine): it never rides in the lines the user is taken to have typed.
    const replies = [...answered.filter(({ item }) => !item.fromFile).map(({ item }) => core.deliveryLine(item)), ...leftover];
    const pushed = answered.filter(({ item }) => item.fromFile).map(({ item }) => core.deliveryLine(item));
    let text;
    if (!woken) {
      text = [...replies, ...pushed, ...looks, heldLine, cap([...asks, notices].filter(Boolean).join('\n'))].filter(Boolean).join('\n');
    } else {
      // Only what the user did on the board (the answers and the report and notify clicks) is to be acted on as if they had typed it. Any other
      // notice that happens to ride on this turn is information, as on any other turn.
      const act = [...replies, ...looks, heldLine, cap(asks.join('\n'))].filter(Boolean);
      const head = act.length
        ? `${WOKEN_LEAD} They acted there while you were idle, so act on these lines now, as if they had typed them:\n${act.join('\n')}`
        : `${WOKEN_LEAD} What the user did there has already reached you; there is nothing to act on from it.`;
      const info = [...pushed, notices].filter(Boolean).join('\n');
      text = info ? `${head}\nOther notices, for information only; act on them only if the user asks or the work calls for it:\n${info}` : head;
    }
    await emit('UserPromptSubmit', text);
    // Printed. The answers left over are taken out of the record of those that woke the session, so a waiter wakes it for them again.
    if (left.length) { try { await wake.forgetFired(projectDir, sessionId, left); } catch { /* they still come with the next prompt */ } }
  }
}

try {
  if (process.argv[2] === 'SubagentStartWorker') await startWorker();
  else await main();
} catch {
  // swallow everything: a hook must never break the session
}
process.exit(0);
