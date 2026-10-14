// Waking an idle session from the board: what the waiter (scripts/waiter.mjs) looks for in the state file, and the
// one-waiter-per-session file. The waiter never carries the content itself: it only wakes the session, and the
// UserPromptSubmit hook of the woken turn delivers the answers and report requests through its usual path.
// An older plugin version ignores everything here: `reportPushedFor` and `reportPushedAt` on a thread, and the waiter files, which are not in the state file.
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_FILE, mkdirPrivate, now, projectPaths, readState, updateState } from './state.mjs';
import { sameSession } from './sessions.mjs';
import { configPaths, readConfig } from './config.mjs';
import { waitsOf } from './waits.mjs';

const WAITER_FILE_RE = /^waiter-[0-9a-z-]{8,64}\.json$/;
const WAITER_FILE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_FIRED = 50;

/**
 * True in a session nobody sits at (`claude -p`, the SDKs). Claude Code gives every hook CLAUDE_CODE_SESSION_ATTENDED: "1" for a
 * session with a person at it (the terminal, the editor extensions, the desktop app), "0" otherwise. A version that does not set it
 * has an entry point that says "sdk-..." for those.
 */
export function unattended() {
  const attended = process.env.CLAUDE_CODE_SESSION_ATTENDED;
  if (attended !== undefined) return attended === '0';
  return String(process.env.CLAUDE_CODE_ENTRYPOINT || '').startsWith('sdk');
}

export const wakeEnabled = (projectDirArg) => readConfig(projectDirArg).wake === true;

const isThreadCard = (c) => c && c.thread && typeof c.thread === 'object';

// A report click that has not been pushed yet: asked for by the board, the parent is `sessionId`, and no wake came for this click.
// A second click sets a different reportRequestedAt, so it wakes again. A push is remembered as the request it was for
// (`reportPushedFor`), and compared for equality, so a clock that steps backwards cannot wake the same click again. The older
// `reportPushedAt` (a time, compared with the request time) is still read for a thread that has no `reportPushedFor`.
function reportWaiting(card, sessionId) {
  if (!isThreadCard(card)) return false;
  const th = card.thread;
  if (!th.reportRequestedAt || th.lastResult == null || th.reported || !sameSession(th.parentSessionId, sessionId)) return false;
  if (typeof th.reportPushedFor === 'string') return th.reportPushedFor !== th.reportRequestedAt;
  return !(typeof th.reportPushedAt === 'string' && th.reportPushedAt >= th.reportRequestedAt);
}

/** The key that tells one answer from another, so a wake is never made twice for it. */
const answerKey = (item) => `${item.id}@${item.answeredAt || ''}`;

/**
 * What would wake `sessionId` now, read-only: { answers: [wait keys], reports: [card ids] }. Answers need the task board;
 * `skip` is the list of answer keys that already woke this session once and must not do so again.
 */
export function pendingWake(projectDirArg, sessionId, skip = []) {
  const state = readState(projectDirArg);
  const tasks = readConfig(projectDirArg).mode !== 'chat';
  const answers = [];
  const reports = [];
  for (const card of state.cards) {
    if (tasks) {
      for (const item of waitsOf(card)) {
        if (item.state === 'answered' && !item.deliveredAt && sameSession(item.askedBy, sessionId) && !skip.includes(answerKey(item))) answers.push(answerKey(item));
      }
    }
    if (reportWaiting(card, sessionId)) reports.push(card.id);
  }
  return { answers, reports };
}

/** True when the project has a thread card; a chat-only project without one has nothing a wake could be for. */
export function hasThreads(projectDirArg) {
  return readState(projectDirArg).cards.some(isThreadCard);
}

/**
 * Mark the report clicks for `sessionId` as pushed, under the state lock. Returns the card ids that were still waiting.
 * With the waiter's `token`, the waiter file also records that this waiter is waking the session (see `stopWaiter`).
 */
export async function claimReportPushes(projectDirArg, sessionId, token) {
  const out = await updateState(projectDirArg, (state) => {
    const ids = [];
    for (const card of state.cards) {
      if (!reportWaiting(card, sessionId)) continue;
      card.thread.reportPushedFor = card.thread.reportRequestedAt;
      card.thread.reportPushedAt = now();
      ids.push(card.id);
    }
    return ids;
  });
  if (out.length && token) await markWoke(projectDirArg, sessionId, token, []).catch(() => {});   // the push is made either way: the wake must still go out
  return out;
}

/** A cheap fingerprint of the files `pendingWake` reads, so a poll that finds them unchanged need not parse them. */
export function filesSignature(projectDirArg) {
  const paths = [projectPaths(projectDirArg).state, configPaths(projectDirArg).global, configPaths(projectDirArg).project];
  return paths.map((p) => {
    try {
      const st = statSync(p);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return '-';
    }
  }).join('|');
}

// ---------------------------------------------------------------- one waiter per session

const waiterPath = (projectDirArg, sessionId) => join(projectPaths(projectDirArg).dir, `waiter-${String(sessionId).toLowerCase()}.json`);

// What the file holds: `token` (the waiter that owns the session now, or null), `fired` (answer keys that already woke it),
// `wokeAt` (ms: the waiter woke the session at this time, and the woken turn's prompt hook has not taken it yet) and
// `turnStartedAt` (ms: the last time a turn started, by the prompt hook).
function readWaiterFile(path) {
  const empty = { token: null, fired: [], wokeAt: null, turnStartedAt: null };
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (!o || typeof o !== 'object') return empty;
    const ms = (v) => (Number.isFinite(v) ? v : null);
    return { token: typeof o.token === 'string' ? o.token : null, fired: Array.isArray(o.fired) ? o.fired.filter((k) => typeof k === 'string') : [], wokeAt: ms(o.wokeAt), turnStartedAt: ms(o.turnStartedAt) };
  } catch {
    return empty;
  }
}

async function writeWaiterFile(path, cur) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const body = { token: cur.token, pid: process.pid, at: now(), fired: cur.fired.slice(-MAX_FIRED) };
    if (cur.wokeAt != null) body.wokeAt = cur.wokeAt;
    if (cur.turnStartedAt != null) body.turnStartedAt = cur.turnStartedAt;
    await writeFile(tmp, JSON.stringify(body), { encoding: 'utf8', mode: PRIVATE_FILE });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Waiter files of sessions that are long gone.
function sweepWaiterFiles(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (!WAITER_FILE_RE.test(name)) continue;
      const p = join(dir, name);
      if (Date.now() - statSync(p).mtimeMs > WAITER_FILE_MAX_AGE_MS) unlinkSync(p);
    }
  } catch { /* best effort */ }
}

/** A woken turn is recognised for this long after the waiter woke the session. */
export const WOKE_WINDOW_MS = 2 * 60 * 1000;

const turnSince = (cur, startedAtMs) => startedAtMs != null && cur.turnStartedAt != null && cur.turnStartedAt >= startedAtMs;

/**
 * Become the waiter of the session: any waiter before this one sees the changed token and exits. `startedAtMs` is when the
 * waiter's process started. Returns the token and the answer keys that already woke it, or null token when a turn has started
 * since (the prompt hook ran between the Stop hook and this claim): the session is busy again and there is nothing to wait for.
 */
export async function claimWaiter(projectDirArg, sessionId, startedAtMs = Date.now()) {
  const dir = projectPaths(projectDirArg).dir;
  await mkdirPrivate(dir);
  sweepWaiterFiles(dir);
  const path = waiterPath(projectDirArg, sessionId);
  const cur = readWaiterFile(path);
  if (turnSince(cur, startedAtMs)) return { token: null, fired: cur.fired };
  const token = randomBytes(8).toString('hex');
  await writeWaiterFile(path, { ...cur, token, wokeAt: null });
  return { token, fired: cur.fired };
}

/** True while this waiter is still the session's waiter and no turn has started since its process did. */
export function waiterOwns(projectDirArg, sessionId, token, startedAtMs = null) {
  const cur = readWaiterFile(waiterPath(projectDirArg, sessionId));
  return cur.token === token && !turnSince(cur, startedAtMs);
}

async function markWoke(projectDirArg, sessionId, token, keys) {
  const path = waiterPath(projectDirArg, sessionId);
  const cur = readWaiterFile(path);
  if (cur.token !== token) return;
  await writeWaiterFile(path, { ...cur, fired: [...cur.fired, ...keys], wokeAt: Date.now() });
}

/** The waiter is about to wake the session for these answers: remember them, so a turn that fails to deliver them does not wake it again and again, and that it woke it now. */
export async function recordFired(projectDirArg, sessionId, token, keys) {
  await markWoke(projectDirArg, sessionId, token, keys);
}

/**
 * A turn is starting (UserPromptSubmit): the waiter stops, and the start of the turn is written even when no waiter holds the
 * session, so a waiter whose process started before it (and claims later) sees it and leaves. The record of answers that woke the
 * session stays. Returns true when this turn is the one the waiter woke the session for (it woke it in the last two minutes
 * and waking is on); the record of that is cleared, so a prompt typed later is never taken for it.
 */
export async function stopWaiter(projectDirArg, sessionId) {
  if (unattended()) return false;   // no waiter runs there, so there is no race and nothing to record
  const path = waiterPath(projectDirArg, sessionId);
  const cur = readWaiterFile(path);
  const on = wakeEnabled(projectDirArg);
  const woke = on && cur.wokeAt != null && Date.now() - cur.wokeAt >= 0 && Date.now() - cur.wokeAt < WOKE_WINDOW_MS;
  let exists = true;
  try { statSync(path); } catch { exists = false; }
  if (on || exists) {
    await mkdirPrivate(projectPaths(projectDirArg).dir);
    await writeWaiterFile(path, { ...cur, token: null, wokeAt: null, turnStartedAt: Date.now() });
  }
  return woke;
}
