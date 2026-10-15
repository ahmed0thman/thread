#!/usr/bin/env node
// The Stop hook's background waiter (asyncRewake) of the thread plugin. While the session is idle it watches the project's
// state file; when the user answers a waiting item this session asked, clicks "Report to main session" for one of its
// threads, or clicks "Notify Claude" on a card for it, it waits a moment (so what the user sends in quick separate steps arrives as one
// turn) and then exits with code 2, which wakes the session. Claude Code then runs the UserPromptSubmit hook on that turn, and
// that hook (scripts/hook.mjs) delivers the answers and requests. Off unless the `wake` setting is on.
// Any failure exits 0 with no output: a waiter must never break the session.
// Claude Code runs an asyncRewake hook in the background only in an interactive session (or one with streaming input). In a
// plain `claude -p` run it waits for the hook to end like for any other Stop hook, so a waiter there would hold the run up for
// as long as it lives: it leaves at once when the session is not attended.

import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

const MESSAGE = '[thread] Not an error: the user acted on the thread board while you were idle. Their answers and requests are in the thread plugin\'s note on this turn; act on them now, as if they had typed them. If that note has nothing left to act on, there is nothing to do.';
const DEFAULT_POLL_MS = 1500;
const DEFAULT_IDLE_MS = 12 * 3600 * 1000;   // a waiter that has seen nothing for this long gives up; the next turn starts a new one
const DEBOUNCE_MS = 100;
const DEFAULT_SETTLE_MS = 2000;   // from the first trigger it sees to the wake: what else the user sends meanwhile rides on the same turn
const STARTED_AT = Date.now() - process.uptime() * 1000;   // when this process started: the Stop hook ran then, not when the claim below is made

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

const numberEnv = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function leave(code) {
  if (code !== 2) process.exit(code);
  process.stderr.write(MESSAGE + '\n', () => process.exit(2));
}

async function main() {
  // A side thread (or anything run for one) answers to the main session: it is never woken.
  if (process.env.THREAD_DEPTH) return 0;
  process.env.THREAD_LOCK_WAIT_MS = '3000';
  const wake = await import(new URL('../server/wake.mjs', import.meta.url).href);
  // Nobody is there to wake, and the run would wait for this process (see the top of the file).
  if (wake.unattended()) return 0;

  let input;
  try { input = JSON.parse(await readStdin(2000)); } catch { return 0; }
  if (!input || typeof input !== 'object') return 0;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!/^[0-9A-Za-z-]{8,64}$/.test(sessionId)) return 0;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!projectDir) return 0;

  const { projectPaths, repoRootOf, cardsFolder } = await import(new URL('../server/state.mjs', import.meta.url).href);
  const { readConfig } = await import(new URL('../server/config.mjs', import.meta.url).href);
  if (!wake.wakeEnabled(projectDir)) return 0;
  if (readConfig(projectDir).mode === 'chat' && !wake.hasThreads(projectDir)) return 0;

  const { token, fired } = await wake.claimWaiter(projectDir, sessionId, STARTED_AT);
  if (!token) return 0;   // a turn started after this process did: the session is busy again
  const pollMs = numberEnv('THREAD_WAKE_POLL_MS', DEFAULT_POLL_MS);
  const idleMs = numberEnv('THREAD_WAKE_IDLE_MS', DEFAULT_IDLE_MS);
  const settleMs = process.env.THREAD_WAKE_SETTLE_MS === '0' ? 0 : numberEnv('THREAD_WAKE_SETTLE_MS', DEFAULT_SETTLE_MS);
  const startedAt = Date.now();
  const parent = process.ppid;
  const claudePid = Number(process.env.CLAUDE_PID);   // Claude Code's own process: the parent may be a shell wrapper that outlives it
  const stateFile = projectPaths(projectDir).state;
  const repoRoot = repoRootOf(projectDir);   // a repo-backed project's cards are files in its repo folder: the answers are written there
  let seen = null;   // the files' fingerprint at the last look: unchanged files are not parsed again

  return new Promise((resolve) => {
    let finished = false;
    let busy = false;
    let again = false;
    let debounce = null;
    let watcher = null;
    let cardsWatcher = null;
    let poll = null;
    let settle = null;      // the timer that looks again once the settle time since the first trigger is over
    let triggeredAt = null; // when a trigger was first seen (performance.now(): a clock that cannot step back, as the wall clock can), null while there is none
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(debounce);
      clearInterval(poll);
      clearTimeout(settle);
      try { if (watcher) watcher.close(); } catch { /* ignore */ }
      try { if (cardsWatcher) cardsWatcher.close(); } catch { /* ignore */ }
      resolve(code);
    };
    const gone = (pid) => {
      try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    };
    const parentGone = () => {
      if (process.ppid !== parent || gone(parent)) return true;
      return Number.isInteger(claudePid) && claudePid > 1 && gone(claudePid);
    };

    async function check() {
      if (finished) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          if (!wake.waiterOwns(projectDir, sessionId, token, STARTED_AT) || parentGone() || Date.now() - startedAt > idleMs) return finish(0);
          const print = wake.filesSignature(projectDir);
          if (print === seen) continue;
          if (!wake.wakeEnabled(projectDir)) return finish(0);   // switched off while waiting
          const pending = wake.pendingWake(projectDir, sessionId, fired);
          if (pending.answers.length || pending.reports.length || pending.notifies.length) {
            // Not at the first sight: wait the settle time, then read again (this very loop does, with `seen` left empty), so a second
            // answer, a click or a batch that follows closely lands in the same turn.
            if (triggeredAt === null) triggeredAt = performance.now();
            const left = settleMs - (performance.now() - triggeredAt);
            if (left > 0) {
              clearTimeout(settle);
              settle = setTimeout(check, left);
              seen = null;
              continue;
            }
            // The claim re-reads everything under the state lock the prompt hook takes when a turn starts: it wakes only if this waiter
            // still owns the session and something is still pending then (see claimWake).
            if (await wake.claimWake(projectDir, sessionId, token, STARTED_AT)) return finish(2);
          }
          triggeredAt = null;
          seen = print;
        } while (again && !finished);
      } catch {
        // a busy lock or a half-written file: the next poll looks again
        seen = null;
      } finally {
        busy = false;
      }
    }

    const soon = () => { clearTimeout(debounce); debounce = setTimeout(check, DEBOUNCE_MS); };
    try {
      watcher = watch(dirname(stateFile), (_event, name) => { if (!name || name === 'state.json') soon(); });
      watcher.on('error', () => {});
    } catch { /* the poll alone then */ }
    if (repoRoot) {
      try {
        cardsWatcher = watch(cardsFolder(repoRoot), () => soon());
        cardsWatcher.on('error', () => {});
      } catch { /* the poll alone then */ }
    }
    poll = setInterval(check, pollMs);
    check();
  });
}

let code = 0;
try { code = await main(); } catch { code = 0; }
leave(code === 2 ? 2 : 0);
