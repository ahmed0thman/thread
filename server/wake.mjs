// Waking an idle session from the board: what the waiter (scripts/waiter.mjs) looks for in the state file, and the
// one-waiter-per-session file. The waiter never carries the content itself: it only wakes the session, and the
// UserPromptSubmit hook of the woken turn delivers the answers, report requests and notify requests through its usual path.
// What wakes a session is read from the joined state, so an answer written to a repo card file counts too. An older plugin version ignores everything here: `reportPushedFor` and `reportPushedAt` on a thread, `notifyPushedFor` on a card (the
// request id it was for, see notify.mjs),
// and the waiter files, which are not in the state file.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_FILE, mkdirPrivate, now, projectPaths, readState, repoSignature, updateState, withLock } from './state.mjs';
import { sameSession } from './sessions.mjs';
import { configPaths, readConfig } from './config.mjs';
import { waitsOf } from './waits.mjs';
import { notifyActive, notifyPushed } from './notify.mjs';

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

// A notify click that has not been pushed yet: asked for the session `sessionId`, and no wake or prompt hook carried this request. Like a report
// click, a push is remembered as the request it was for (`notifyPushedFor` is the request's `notifyId`) and compared for equality, so a clock
// that steps backwards cannot wake the same click again, and a second click (a new notifyId) wakes again.
function notifyWaiting(card, sessionId) {
  return notifyActive(card) && sameSession(card.notifySession, sessionId) && !notifyPushed(card);
}

// An answer that wakes a session, or is left over for one: given on this machine's board (or closed here), for an item that session asked, not
// delivered yet. An answer that only the repo file has (`fromFile`, see repo.mjs) wakes nothing: it comes with the next prompt, as information.
const isWakeAnswer = (item, sessionId) => item.state === 'answered' && !item.deliveredAt && !item.fromFile && sameSession(item.askedBy, sessionId);

/** The key that tells one answer from another, so a wake is never made twice for it. */
const answerKey = (item) => `${item.id}@${item.answeredAt || ''}`;

/**
 * What would wake `sessionId` now, read-only: { answers: [wait keys], reports: [card ids], notifies: [card ids] }. Answers and notifies need
 * the task board; `skip` is the list of answer keys that already woke this session once and must not do so again.
 */
export function pendingWake(projectDirArg, sessionId, skip = []) {
  return pendingIn(readState(projectDirArg), readConfig(projectDirArg).mode !== 'chat', sessionId, skip);
}

// pendingWake on a state already read (the waiter's claim reads it under the state lock).
function pendingIn(state, tasks, sessionId, skip) {
  const answers = [];
  const reports = [];
  const notifies = [];
  for (const card of state.cards) {
    if (tasks) {
      for (const item of waitsOf(card)) {
        if (isWakeAnswer(item, sessionId) && !skip.includes(answerKey(item))) answers.push(answerKey(item));
      }
      if (notifyWaiting(card, sessionId)) notifies.push(card.id);
    }
    if (reportWaiting(card, sessionId)) reports.push(card.id);
  }
  return { answers, reports, notifies };
}

/** The keys of the answers `sessionId` has not been delivered yet (whether or not they already woke it). Read-only; none in a chat-only project. */
export function undeliveredAnswerKeys(projectDirArg, sessionId) {
  if (readConfig(projectDirArg).mode === 'chat') return [];
  const keys = [];
  for (const card of readState(projectDirArg).cards) {
    for (const item of waitsOf(card)) if (isWakeAnswer(item, sessionId)) keys.push(answerKey(item));
  }
  return keys;
}

/** True when the project has a thread card; a chat-only project without one has nothing a wake could be for. */
export function hasThreads(projectDirArg) {
  return readState(projectDirArg).cards.some(isThreadCard);
}

// Marks the report clicks and the notify clicks for `sessionId` in `state` as pushed (the kinds asked for). Returns { reports: card ids,
// notifies: card ids } that were still waiting. The caller holds the state lock.
function applyClaims(state, tasks, sessionId, { reports: wantReports, notifies: wantNotifies }) {
  const reports = [];
  const notifies = [];
  for (const card of state.cards) {
    if (wantReports && reportWaiting(card, sessionId)) {
      card.thread.reportPushedFor = card.thread.reportRequestedAt;
      card.thread.reportPushedAt = now();
      reports.push(card.id);
    }
    if (wantNotifies && tasks && notifyWaiting(card, sessionId)) {
      card.notifyPushedFor = card.notifyId;
      notifies.push(card.id);
    }
  }
  return { reports, notifies };
}

// The same under the state lock, for the kinds asked for. With the waiter's `token` the waiter file also records that it is waking the session.
async function claimPushes(projectDirArg, sessionId, token, want) {
  const tasks = readConfig(projectDirArg).mode !== 'chat';
  const out = await updateState(projectDirArg, (state) => applyClaims(state, tasks, sessionId, want));
  if ((out.reports.length || out.notifies.length) && token) await markWoke(projectDirArg, sessionId, token, []).catch(() => {});   // the push is made either way: the wake must still go out
  return out;
}

/**
 * Mark the report clicks for `sessionId` as pushed, under the state lock. Returns the card ids that were still waiting.
 * With the waiter's `token`, the waiter file also records that this waiter is waking the session (see `stopWaiter`).
 */
export async function claimReportPushes(projectDirArg, sessionId, token) {
  return (await claimPushes(projectDirArg, sessionId, token, { reports: true, notifies: false })).reports;
}

/** The same for the notify clicks: the card ids that were still waiting. */
export async function claimNotifyPushes(projectDirArg, sessionId, token) {
  return (await claimPushes(projectDirArg, sessionId, token, { reports: false, notifies: true })).notifies;
}

/** Both at once, in one write: { reports, notifies }. The waiter uses this when it wakes the session. */
export async function claimAllPushes(projectDirArg, sessionId, token) {
  return claimPushes(projectDirArg, sessionId, token, { reports: true, notifies: true });
}

/**
 * The waiter's last step before it wakes the session, all under the state lock that `stopWaiter` takes too: the waiter must still own the
 * session (no turn started since its process did), and something must still be pending. Only then are the report and notify clicks marked
 * as pushed and the answers recorded as having woken the session. Returns true when the session is to be woken. A turn that started
 * while the claim waited for the lock has written its start under the same lock, so it is seen here and nothing wakes.
 */
export async function claimWake(projectDirArg, sessionId, token, startedAtMs = null) {
  const tasks = readConfig(projectDirArg).mode !== 'chat';
  return updateState(projectDirArg, async (state) => {
    const path = waiterPath(projectDirArg, sessionId);
    const cur = readWaiterFile(path);
    if (cur.token !== token || turnSince(cur, startedAtMs)) return false;
    const pending = pendingIn(state, tasks, sessionId, cur.fired);
    if (!pending.answers.length && !pending.reports.length && !pending.notifies.length) return false;
    applyClaims(state, tasks, sessionId, { reports: true, notifies: true });
    await writeWaiterFile(path, { ...cur, fired: [...cur.fired, ...pending.answers], wokeAt: Date.now() });
    return true;
  });
}

/**
 * A cheap fingerprint of the files `pendingWake` reads, so a poll that finds them unchanged need not parse them. A repo-backed project's cards are
 * files in its repo folder (an answer is written there): the card files and the folder are part of it.
 */
export function filesSignature(projectDirArg) {
  const cp = configPaths(projectDirArg);
  const paths = [projectPaths(projectDirArg).state, cp.global, cp.project, cp.local];
  return [...paths.map((p) => {
    try {
      const st = statSync(p);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return '-';
    }
  }), repoSignature(projectDirArg)].join('|');
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
  if (!wakeEnabled(projectDirArg) && !existsSync(waiterPath(projectDirArg, sessionId))) return false;   // nothing to record, nothing to race
  // Under the state lock, which the waiter's claim (claimWake) holds too: a claim that comes after this sees the turn, and one that came
  // first has woken the session before the turn started. Without the lock (it is held for over a second) the write is still made.
  let locked = false;
  try {
    return await withLock(projectDirArg, async () => { locked = true; return await recordTurnStart(projectDirArg, sessionId); });
  } catch (e) {
    if (locked) throw e;
    return recordTurnStart(projectDirArg, sessionId);
  }
}

// The body of stopWaiter; the caller holds the state lock when it can. Exported for the test that plays the other side of the race.
export async function recordTurnStart(projectDirArg, sessionId) {
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

/**
 * Take answers out of the record of those that already woke the session, so that a waiter wakes it for them again. The prompt hook does this
 * for the answers it had no room for: they were not delivered, and they must still reach the session with a wake when waking is on.
 * Nothing happens when there is no waiter file (waking was never on for this session).
 */
export async function forgetFired(projectDirArg, sessionId, keys) {
  if (!keys.length || unattended()) return;
  const path = waiterPath(projectDirArg, sessionId);
  try { statSync(path); } catch { return; }
  const cur = readWaiterFile(path);
  const fired = cur.fired.filter((k) => !keys.includes(k));
  if (fired.length !== cur.fired.length) await writeWaiterFile(path, { ...cur, fired });
}
