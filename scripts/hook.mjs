#!/usr/bin/env node
// Hook entry point for the thread plugin. Any failure exits 0 with no output.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONTEXT = 600; // the notices; report requests are kept whole
const MAX_TOTAL = 1500;

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

const SETUP_HINT = 'The thread plugin has not been set up. Tell the user once, when it does not interrupt their request, that /thread:setup lets them choose chat-only or the task board, their own stages, and whether that applies to every project.';

// Tasks mode only: when to raise a waiting item, and the answers no session has received. Never fails the note.
function waitNote(core, projectDir, sessionId) {
  try {
    if (!core || !projectDir || core.readConfig(projectDir).mode === 'chat') return '';
    let out = '\nWhen you finish work that needs the user\'s check, have a question, or need the user to do something, raise it with wait_add on the card for that work, and say only a one-line pointer in the chat, for example "Waiting on you: c37.w2".';
    const n = core.countUndeliveredElsewhere(projectDir, sessionId);
    if (n > 0) out += `\n${n} answered waiting item${n === 1 ? '' : 's'} on the board ${n === 1 ? 'was' : 'were'} asked by another session and not delivered; wait_list reads ${n === 1 ? 'it' : 'them'} if relevant.`;
    return out;
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

  // Register the session and its name. Never hold up the user's prompt waiting on the state lock.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
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
    const hint = core && projectDir ? setupHint(core, projectDir) : '';
    if (hint) note += `\n${hint}`;
    await emit('SessionStart', note);
    return;
  }

  if (event === 'UserPromptSubmit') {
    if (!core || !projectDir) return;
    const { reconcile, pendingAnnouncements, pendingReportRequests, readState } = core;

    await reconcile(projectDir);
    const announced = await pendingAnnouncements(projectDir, sessionId);
    const requested = await pendingReportRequests(projectDir, sessionId);
    const state = readState(projectDir);
    // Chat-only: the task board is off, so new board cards are not mentioned.
    const unseen = core.readConfig(projectDir).mode === 'chat' ? [] : state.cards.filter((c) => c.seenByClaude === false);
    // Answers to what this session asked the user on the board, marked delivered under the state lock so each is carried once.
    // This is the last step that can wait or fail before the text is printed: an answer must not be marked delivered and then lost.
    let answered = [];
    try { answered = await core.deliverWaitAnswers(projectDir, sessionId); } catch { /* the other notices still go out */ }

    if (!announced.length && !unseen.length && !requested.length && !answered.length) return;

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
    let notices = lines.join('\n');
    if (notices.length > MAX_CONTEXT) notices = notices.slice(0, MAX_CONTEXT - 1) + '…';
    // The user asked for these by clicking, so they come first and are not cut by the notices' cap.
    const asks = requested.map((c) => `The user clicked "Report to main session" on the board for thread ${c.id} "${core.clip(c.title, 50)}". Call thread_report with id "${c.id}" now and give them the digest.`);
    let text = [...asks, notices].filter(Boolean).join('\n');
    if (text.length > MAX_TOTAL) text = text.slice(0, MAX_TOTAL - 1) + '…';
    // The answers go first and outside the cap above (each line is clipped on its own, and at most a few per prompt), so they are never cut off.
    text = [...answered.map(({ item }) => core.deliveryLine(item)), text].filter(Boolean).join('\n');
    await emit('UserPromptSubmit', text);
  }
}

try {
  if (process.argv[2] === 'SubagentStartWorker') await startWorker();
  else await main();
} catch {
  // swallow everything: a hook must never break the session
}
process.exit(0);
