// Shared library for the MCP server, the board, the runner and the hook: cards, the thread lifecycle,
// hand-back parsing and the project listing. State and sessions live in state.mjs and sessions.mjs and
// are re-exported here. Zero dependencies, node: built-ins only.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, envValue, now, projectKey, projectPaths, readState, updateState, withLock } from './state.mjs';
import { EFFORTS, cleanEffort, cleanModel, collapse, sameSession, sessionModel } from './sessions.mjs';
import { ChatOnlyError, DEFAULT_STAGES, readConfig } from './config.mjs';
import { openWaits, reviewApproved } from './waits.mjs';
import { notifyActive } from './notify.mjs';
import { FIELD_NAMES, addHistory, cleanFields, cleanWorker, finishedStageIds, hasCriteria, liveBlockers } from './fields.mjs';
import { RESUME, laneSnapshot, requireRunnableLane, unusableLane } from './lanes.mjs';

export * from './state.mjs';
export * from './sessions.mjs';
export * from './config.mjs';
export * from './waits.mjs';
export * from './notify.mjs';
export * from './fields.mjs';

// The default stage ids. A project's own stages come from readConfig.
export const STATUSES = DEFAULT_STAGES.map((s) => s.id);

export const KINDS = ['task', 'idea', 'milestone'];
export const MODES = ['read', 'write'];
export const CONTEXTS = ['brief', 'full'];
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BRIEF = 50000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[0-9a-f]{12}$/;
const CARD_ID_RE = /^c[0-9]+$/;
export const VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
})();
const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url));
const HEARTBEAT_STALE_MS = 15000;

// ---------------------------------------------------------------- project listing

export function dirExists(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// One listing entry for the folder `key`, or null when it must not be listed.
// Reads the state file without a lock and never writes.
function listedProject(key) {
  try {
    if (!KEY_RE.test(key)) return null;
    const file = join(dataDir(), 'projects', key, 'state.json');
    const st = statSync(file);
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object' || Array.isArray(s) || !Array.isArray(s.cards)) return null;
    if (typeof s.projectDir !== 'string' || !s.projectDir || projectKey(s.projectDir) !== key) return null;
    let newest = NaN;
    let threads = 0;
    let running = 0;
    let waiting = 0;
    let open = 0;
    let done = 0;
    const cfg = readConfig(s.projectDir);
    for (const c of s.cards) {
      if (!c || typeof c !== 'object') continue;
      waiting += openWaits(c).length;
      // open: not finished (see isFinished), milestones left out; a chat-only board shows threads only
      if (c.kind !== 'milestone' && (cfg.mode !== 'chat' || c.kind === 'thread')) {
        if (isFinished(c, cfg)) done += 1;
        else open += 1;
      }
      const t = Date.parse(c.updatedAt);
      if (Number.isFinite(t) && !(t <= newest)) newest = t;
      if (c.kind === 'thread') {
        threads += 1;
        if (c.thread && c.thread.runState === 'running') running += 1;
      }
    }
    const parts = s.projectDir.split(/[\\/]+/).filter(Boolean);
    return {
      key,
      projectDir: s.projectDir,
      name: parts.length ? parts[parts.length - 1] : s.projectDir,
      exists: dirExists(s.projectDir),
      cards: s.cards.length,
      threads,
      running,
      // cards not done (milestones left out), cards done, and items waiting for the user; chat-only projects do not show waiting items
      open,
      done,
      waiting: cfg.mode === 'chat' ? 0 : waiting,
      lastActivity: new Date(Number.isFinite(newest) ? newest : st.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

export function listProjects() {
  let names;
  try { names = readdirSync(join(dataDir(), 'projects')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const p = listedProject(n);
    if (p) out.push(p);
  }
  out.sort((a, b) => Date.parse(b.lastActivity) - Date.parse(a.lastActivity));
  return out;
}

export function projectDirForKey(key) {
  const p = typeof key === 'string' ? listedProject(key) : null;
  return p ? p.projectDir : null;
}

// Remove the data folder of a project whose own folder is gone. Never touches
// anything outside <data dir>/projects/<key>.
export async function forgetProject(key) {
  const entry = typeof key === 'string' ? listedProject(key) : null;
  if (!entry) throw new Error('unknown project');
  if (entry.exists) throw new Error(`project folder still exists: ${entry.projectDir}`);
  const root = join(dataDir(), 'projects');
  const target = join(root, key);
  if (!KEY_RE.test(key) || resolve(target) !== target) throw new Error('unknown project');
  return withLock(entry.projectDir, async () => {
    const again = listedProject(key);
    if (!again) throw new Error('unknown project');
    if (again.exists) throw new Error(`project folder still exists: ${again.projectDir}`);
    const state = readState(again.projectDir);
    const busy = state.cards.find((c) => isThread(c) && c.thread.runState === 'running' && runnerAlive(again.projectDir, c));
    if (busy) throw new Error(`thread ${busy.id} is still running; end it before forgetting the project`);
    await rm(target, { recursive: true, force: true });
    return true;
  });
}

// ---------------------------------------------------------------- cards and run state

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// A runner is alive only if its pid exists and it has written a recent
// heartbeat naming that pid. The pid alone is not enough: after a crash the
// number can be reused by an unrelated process.
function runnerAlive(projectDirArg, card) {
  const th = card && card.thread;
  if (!th || !isAlive(th.pid)) return false;
  const turn = th.turns[th.turns.length - 1];
  const started = turn ? Date.parse(turn.startedAt) : NaN;
  // Grace period: a runner that has only just been launched has no heartbeat yet.
  if (Number.isFinite(started) && Date.now() - started < HEARTBEAT_STALE_MS) return true;
  try {
    const hb = JSON.parse(readFileSync(join(projectPaths(projectDirArg).logs, `${card.id}.alive`), 'utf8'));
    return hb.pid === th.pid && Date.now() - hb.at < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

export const isThread = (card) => !!card && card.kind === 'thread' && !!card.thread;

function findCard(state, id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) throw new Error(`card not found: ${id}`);
  return card;
}

export function findThread(state, id) {
  const card = findCard(state, id);
  if (!isThread(card)) throw new Error(`card ${id} is not a thread`);
  return card;
}

function checkStatus(cfg, status) {
  const ids = cfg.stages.map((s) => s.id);
  if (!ids.includes(status)) {
    throw new Error(`invalid status "${status}" (use one of: ${ids.join(', ')})`);
  }
}

// A task board that is switched off still has its threads.
function requireTasks(cfg) {
  if (cfg.mode === 'chat') throw new ChatOnlyError();
}

function statusForRunState(roles, runState) {
  switch (runState) {
    case 'idle': return roles.review;
    case 'failed': return roles.blocked;
    case 'ended': return roles.done;
    default: return roles.working;
  }
}

export function setRunState(projectDirArg, card, runState) {
  card.thread.runState = runState;
  // The stored stage is always one of the task board's own, also in chat-only mode (which shows other columns): an older plugin version reads it.
  card.status = statusForRunState(readConfig(projectDirArg).taskRoles, runState);
  card.updatedAt = now();
}

// The stage a card is shown in. A thread: always the stage for its run state, so it follows a
// change of roles and a status written by an older plugin version. Any other card: its own
// stage when that is still one of the task board's, else its start stage (in chat-only mode too: those cards
// are hidden there, and the stage they come back in is the task board's). The stored status is not rewritten.
export function effectiveStatus(card, cfg) {
  if (isThread(card)) return statusForRunState(cfg.roles, card.thread.runState);
  return cfg.taskStages.some((s) => s.id === card.status) ? card.status : cfg.taskRoles.start;
}

// One meaning of "finished" for the whole plugin. A card that is not a thread is finished when its stage is the task board's done
// stage or any stage after it, in the task board's order (Done and Released are both finished). A thread is finished when its run
// state maps to the done role. The page has the same rule (finishedIn, in server/board/js/model.js).
export function stageFinished(cfg, stageId) {
  return finishedStageIds(cfg).includes(stageId);
}
export function isFinished(card, cfg) {
  const st = effectiveStatus(card, cfg);
  // A thread is done in the stage its run state maps to, in chat-only mode too.
  return isThread(card) ? st === cfg.roles.done : stageFinished(cfg, st);
}

// The ids of the cards `card` is blocked by that still exist and are not finished: the ones that hold it up.
export function openBlockers(card, cards, cfg) {
  return liveBlockers(card, cards).filter((id) => !isFinished(cards.find((c) => c.id === id), cfg));
}

// A milestone has no stage of its own: its state follows its cards. The cards that count are its children except ideas (an
// idea counts once it becomes a task). A counted card is finished as isFinished says. done and total are over the counted cards.
export function milestoneProgress(cards, milestoneId, cfg) {
  const kids = cards.filter((c) => c.parent === milestoneId && c.kind !== 'idea');
  return { done: kids.filter((c) => isFinished(c, cfg)).length, total: kids.length };
}

// 'empty' (no counted cards), 'open' (a counted card is not finished) or 'done' (all are). Derived on each read, never stored.
export function milestoneState(cards, milestoneId, cfg) {
  const p = milestoneProgress(cards, milestoneId, cfg);
  return p.total === 0 ? 'empty' : p.done === p.total ? 'done' : 'open';
}

export const NO_MS_STAGE = 'a milestone has no stage: it is done when all its cards are done';

// Checks a parent for `card` (kind, or null when not known yet) against the state.
function checkParent(state, parentId, kind) {
  if (kind === 'milestone') throw new Error('a milestone cannot have a parent');
  const m = state.cards.find((c) => c.id === parentId);
  if (!m) throw new Error(`milestone not found: ${parentId}`);
  if (m.kind !== 'milestone') throw new Error(`${parentId} is not a milestone`);
}

const cleanParent = (parent) => {
  if (parent === undefined) return undefined;
  if (parent === null || (typeof parent === 'string' && !parent.trim())) return null;
  if (typeof parent !== 'string') throw new Error('parent must be a milestone card id');
  return parent.trim();
};

// A lane (see lanes.mjs) belongs to a task or an idea. undefined: not given; null: given empty, which removes it.
const cleanLane = (lane) => {
  if (lane === undefined) return undefined;
  if (lane === null || (typeof lane === 'string' && !lane.trim())) return null;
  if (typeof lane !== 'string') throw new Error('lane must be a lane name');
  return lane.trim();
};
export function checkLaneKind(kind) {
  if (kind === 'milestone') throw new Error('a milestone cannot have a lane');
  if (kind === 'thread') throw new Error('a thread\'s lane is chosen when it starts (thread_start with lane, or start a card that has one)');
}

// The first n characters of a collapsed text, with an ellipsis when cut.
export function clip(s, n) {
  const t = collapse(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// The last n characters of a collapsed text: for error text, where the end matters.
export const tail = (s, n = 500) => collapse(s).slice(-n);

// ---------------------------------------------------------------- board cards

const FIELD_LABEL = { type: 'type', priority: 'priority', labels: 'labels', blockedBy: 'blocked by', criteria: 'criteria' };

// Each blocker must be another card of the project, and not a milestone.
function checkBlockers(state, card, ids) {
  for (const id of ids) {
    if (id === card.id) throw new Error(`${id} cannot be blocked by itself`);
    const b = state.cards.find((c) => c.id === id);
    if (!b) throw new Error(`blocked_by: card not found: ${id}`);
    if (b.kind === 'milestone') throw new Error(`blocked_by: ${id} is a milestone; a card is blocked by tasks, ideas or threads`);
  }
}

// Sets the cleaned fields (see cleanFields) on `card`: null removes one, undefined leaves it. A milestone takes none, and a
// thread takes no blockers or criteria. Returns the labels of the fields that changed.
function setFields(state, card, fields) {
  const changed = [];
  for (const k of FIELD_NAMES) {
    const v = fields[k];
    if (v === undefined) continue;
    if (v !== null) {
      if (card.kind === 'milestone') throw new Error(`a milestone cannot have ${FIELD_LABEL[k]}`);
      if (isThread(card) && (k === 'blockedBy' || k === 'criteria')) throw new Error(`a thread cannot have ${FIELD_LABEL[k]}`);
      if (k === 'blockedBy') checkBlockers(state, card, v);
    }
    if (v === null) {
      if (card[k] !== undefined) { delete card[k]; changed.push(FIELD_LABEL[k]); }
    } else if (JSON.stringify(card[k]) !== JSON.stringify(v)) { card[k] = v; changed.push(FIELD_LABEL[k]); }
  }
  return changed;
}

// Moving a card that has acceptance criteria into a finished stage (the done stage or a later one) needs the owner's approval of a
// review item; so does a move from one finished stage to another when the card was never approved (the owner dragged it there). Only
// Claude's own changes are held to it; the board's are not (its views show such a card as not verified).
function gateDone(card, cfg, to) {
  if (!stageFinished(cfg, to) || !hasCriteria(card) || reviewApproved(card, finishedStageIds(cfg))) return;
  throw new Error(`${card.id} has acceptance criteria: raise a review item with wait_add (kind review) and move it to ${to} after the owner approves.`);
}

// Claude may add acceptance criteria to a card but not take them away or reword them: they are the owner's test of the work.
// The existing lines must stay as they are, in order; only the board (source user) may change them freely.
function guardCriteria(card, next) {
  if (next === undefined || !hasCriteria(card)) return;
  const kept = Array.isArray(next) && next.length >= card.criteria.length && card.criteria.every((c, i) => c === next[i]);
  if (!kept) throw new Error(`${card.id}'s acceptance criteria can only be changed by the owner on the board; you may add lines.`);
}

export async function addCard(projectDirArg, { title, note = '', status, kind = 'task', source = 'claude', parent, lane, type, priority, labels, blockedBy, criteria, worker } = {}) {
  const cfg = readConfig(projectDirArg);
  requireTasks(cfg);
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) throw new Error('title must not be empty');
  if (kind === 'milestone' && status !== undefined) throw new Error(NO_MS_STAGE);
  // A milestone has no stage, but older plugin versions read its status, so it stores the start stage.
  if (status === undefined) status = cfg.roles.start;
  checkStatus(cfg, status);
  if (kind === 'thread') throw new Error('thread cards are created with thread_start');
  if (!KINDS.includes(kind)) throw new Error(`invalid kind "${kind}" (use ${KINDS.join(', ')})`);
  if (source !== 'claude' && source !== 'user') throw new Error(`invalid source "${source}"`);
  const parentId = cleanParent(parent);
  const laneName = cleanLane(lane);
  if (laneName) checkLaneKind(kind);
  const fields = cleanFields({ type, priority, labels, blockedBy, criteria });
  const by = cleanWorker(worker);
  return updateState(projectDirArg, (state) => {
    if (parentId) checkParent(state, parentId, kind);
    state.seq += 1;
    const ts = now();
    const card = {
      id: `c${state.seq}`,
      kind,
      title: t,
      note: note == null ? '' : String(note),
      status,
      source,
      seenByClaude: source !== 'user',
      createdAt: ts,
      updatedAt: ts,
    };
    if (parentId) card.parent = parentId;
    if (laneName) card.lane = laneName;
    setFields(state, card, fields);
    if (source === 'claude') gateDone(card, cfg, status);
    addHistory(card, source, { type: 'created', to: status }, ts, by);
    state.cards.push(card);
    return card;
  });
}

// Turning a card into another kind: only a task and an idea can swap. A thread is made with thread_start, and a card never
// becomes a milestone or stops being one. The other rules that depend on kind (a lane, fields, criteria, blockers, waits) take a
// task and an idea alike, so none is in the way.
function checkKindChange(card, kind) {
  if (typeof kind !== 'string') throw new Error('kind must be "task" or "idea"');
  if (card.kind === 'thread' || card.kind === 'milestone') throw new Error(`${card.id} is a ${card.kind}: its kind cannot be changed`);
  if (kind !== 'task' && kind !== 'idea') throw new Error(`a card can only become a task or an idea, not "${kind.slice(0, 40)}"`);
}

export async function updateCard(projectDirArg, id, { title, note, status, kind, parent, lane, type, priority, labels, blockedBy, criteria, worker } = {}, { source = 'claude' } = {}) {
  const cfg = readConfig(projectDirArg);
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must not be empty');
  }
  // Chat-only has its own columns; a task card's stage is refused there (below) for the board being off, not for its name.
  if (status !== undefined && cfg.mode !== 'chat') checkStatus(cfg, status);
  const parentId = cleanParent(parent);
  const laneName = cleanLane(lane);
  const cleaned = cleanFields({ type, priority, labels, blockedBy, criteria });
  const by = cleanWorker(worker);
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, id);
    if (!isThread(card)) requireTasks(cfg);
    // A thread card is shown in the stage for its run state when its stored one is gone; sending that back is no change.
    if (card.kind === 'thread' && status !== undefined && status !== card.status && status !== effectiveStatus(card, cfg)) {
      throw new Error('thread status follows the thread');
    }
    if (card.kind === 'milestone' && status !== undefined) throw new Error(NO_MS_STAGE);
    let changed = false;
    const fields = [];
    if (kind !== undefined && kind !== card.kind) { checkKindChange(card, kind); card.kind = kind; changed = true; fields.push('kind'); }
    if (parentId) {
      if (card.parent !== parentId) { checkParent(state, parentId, card.kind); card.parent = parentId; changed = true; fields.push('milestone'); }
    } else if (parentId === null && card.parent !== undefined) { delete card.parent; changed = true; fields.push('milestone'); }
    if (laneName) {
      if (card.lane !== laneName) { checkLaneKind(card.kind); card.lane = laneName; changed = true; fields.push('lane'); }
    } else if (laneName === null && card.lane !== undefined) { delete card.lane; changed = true; fields.push('lane'); }
    if (source === 'claude') guardCriteria(card, cleaned.criteria);
    const setNow = setFields(state, card, cleaned);
    if (setNow.length) { changed = true; fields.push(...setNow); }
    if (title !== undefined && title.trim() !== card.title) { card.title = title.trim(); changed = true; fields.push('title'); }
    if (note !== undefined && String(note) !== card.note) { card.note = String(note ?? ''); changed = true; fields.push('note'); }
    const from = card.status;
    // A thread's stored stage is set by its run state only: a status it may be sent (its own, or the one it is shown in) is no change.
    if (status !== undefined && !isThread(card) && status !== card.status) {
      if (source === 'claude') gateDone(card, cfg, status);   // after the fields above, so criteria set in the same call count
      card.status = status;
      changed = true;
    }
    const last = Array.isArray(card.history) ? card.history[card.history.length - 1] : null;
    if (!changed && by && !isThread(card) && !(last && last.worker === by)) {
      // nothing else changed: the call only says who did the work (once, not again for the worker the latest entry already names)
      addHistory(card, source, { type: 'worked' }, now(), by);
    }
    if (changed) {
      const ts = now();
      card.updatedAt = ts;
      if (source === 'user') card.seenByClaude = false;
      // a thread's own page shows its turns, not this
      if (!isThread(card)) {
        // The card's own record of leaving the finished stages (a finished stage to an unfinished one; Done to Released is no exit):
        // the capped history cannot be trusted to keep the move (see leftDoneAt).
        if (card.status !== from && stageFinished(cfg, from) && !stageFinished(cfg, card.status)) card.leftDoneAt = ts;
        if (card.status !== from) addHistory(card, source, { type: 'moved', from, to: card.status }, ts, by);
        if (fields.length) addHistory(card, source, { type: 'edited', fields }, ts, by);
      }
    }
    return card;
  });
}

export async function removeCard(projectDirArg, id, { source = 'claude' } = {}) {
  const cfg = readConfig(projectDirArg);
  await updateState(projectDirArg, (state) => {
    const card = findCard(state, id);
    if (!isThread(card)) requireTasks(cfg);
    // Removing a card with acceptance criteria that is neither done nor approved would also remove the owner's test of it.
    // A thread can carry them too: 0.11.0 turned cards into threads without checking.
    if (source === 'claude' && hasCriteria(card) && !isFinished(card, cfg) && !reviewApproved(card, finishedStageIds(cfg))) {
      throw new Error(`${card.id} has acceptance criteria and is not done or approved, so only the owner can remove it, on the board.`);
    }
    if (isThread(card) && card.thread.runState === 'running' && isAlive(card.thread.pid)) {
      throw new Error(`thread ${id} is still running; end it before removing the card`);
    }
    // The cards under a milestone stay, without a parent.
    if (card.kind === 'milestone') for (const c of state.cards) if (c.parent === id) delete c.parent;
    state.cards = state.cards.filter((c) => c.id !== id);
    return true;
  });
  // Logs and activity files would otherwise outlive the card. Best effort. The dot
  // keeps c1 from matching the files of c10.
  const { logs } = projectPaths(projectDirArg);
  try {
    for (const name of await readdir(logs)) {
      if (name.startsWith(`${id}.`)) await rm(join(logs, name), { recursive: true, force: true });
    }
  } catch { /* no logs folder, or a file that cannot be removed */ }
  await sweepOrphanLogs(projectDirArg).catch(() => {});
  return true;
}

// Log files and folders of cards that are no longer in the state: an older plugin version deletes a card without a lane thread's folders.
// Only entries named c<digits>.<anything> whose card id is not in the state are removed, under the state lock; a symlink is removed itself, never followed.
const CARD_LOG_RE = /^(c[0-9]+)\./;
export async function sweepOrphanLogs(projectDirArg) {
  const { logs, state: stateFile } = projectPaths(projectDirArg);
  if (!existsSync(logs) || !existsSync(stateFile)) return 0;   // no state: nothing says which logs are orphans
  return withLock(projectDirArg, async () => {
    if (!existsSync(stateFile)) return 0;   // gone since the check above: readState would report no cards
    const ids = new Set(readState(projectDirArg).cards.map((c) => c.id));
    let n = 0;
    for (const name of await readdir(logs)) {
      const m = CARD_LOG_RE.exec(name);
      if (!m || ids.has(m[1])) continue;
      await rm(join(logs, name), { recursive: true, force: true });
      n += 1;
    }
    return n;
  });
}

// Listing the board marks the cards the user added or edited as seen by Claude, for every session. A "Notify Claude" request is different:
// it ends only when the session that was picked lists the board (`sessionId`, the caller's), so another session's listing leaves it open.
export async function markSeen(projectDirArg, sessionId) {
  return updateState(projectDirArg, (state) => {
    const unseen = [];
    for (const card of state.cards) {
      if (card.seenByClaude === false) {
        unseen.push(JSON.parse(JSON.stringify(card)));
        card.seenByClaude = true;
      }
      if (sessionId && notifyActive(card) && sameSession(card.notifySession, sessionId)) card.notifySeenFor = card.notifyId;
    }
    return unseen;
  });
}

// ---------------------------------------------------------------- threads

const LANE_READ_NOTE = 'This run is read-only: answer from reading and reporting, without editing files and without trying to leave plan mode.';
const MAP_INSTRUCTION = 'After the digest, add a fenced code block tagged thread-map holding a JSON array of at most 12 steps in the order they happened, each {"kind":"did|found|decided|changed|open","text":"one short sentence","ref":"optional path:line"}.';
// The step map's fence: `thread-map`, and the spellings other providers wrote (`threadmap`, `thread_map`). A fence that is never closed runs to the end.
const MAP_BLOCK_RE = /```thread[-_]?map[^\n]*\n([\s\S]*?)(?:```|$)/i;
const MAP_KINDS = ['did', 'found', 'decided', 'changed', 'open'];
const SECTION_KEYS = ['happened', 'decided', 'changed', 'open'];

// Split a thread reply into its free text, the four digest sections and the
// ordered step map. Tolerant by design: a reply that follows none of the format
// comes back as body only.
export function parseHandback(text) {
  const out = { body: '', sections: { happened: '', decided: '', changed: '', open: '' }, map: [] };
  if (typeof text !== 'string') return out;
  let rest = text;
  const block = MAP_BLOCK_RE.exec(rest);
  if (block) {
    rest = rest.replace(MAP_BLOCK_RE, '');
    try {
      const arr = JSON.parse(block[1]);
      if (Array.isArray(arr)) {
        for (const item of arr.slice(0, 20)) {
          if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) continue;
          const step = { kind: MAP_KINDS.includes(item.kind) ? item.kind : 'did', text: item.text.trim().slice(0, 400) };
          if (typeof item.ref === 'string' && item.ref.trim()) step.ref = item.ref.trim().slice(0, 200);
          out.map.push(step);
        }
      }
    } catch { /* not valid JSON: ignore the block */ }
  }
  const re = /^##\s+(Happened|Decided|Changed|Open)\s*$/gim;
  const marks = [];
  let m;
  while ((m = re.exec(rest)) !== null) marks.push({ key: m[1].toLowerCase(), start: m.index, end: re.lastIndex });
  if (!marks.length) {
    out.body = rest.trim();
    return out;
  }
  out.body = rest.slice(0, marks[0].start).trim();
  marks.forEach((mk, i) => {
    const chunk = rest.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : rest.length).trim();
    if (SECTION_KEYS.includes(mk.key)) out.sections[mk.key] = chunk;
  });
  return out;
}

function stripMap(text) {
  return typeof text === 'string' ? text.replace(MAP_BLOCK_RE, '').trimEnd() : text;
}

// A thread runs headless, so it cannot answer a permission prompt: any tool that
// would prompt is refused. These tools are pre-approved so research threads can
// reach the web. THREAD_ALLOW_TOOLS replaces the list (comma separated); "none"
// turns pre-approval off.
const DEFAULT_ALLOW_TOOLS = ['WebSearch', 'WebFetch'];
const MAX_EXTRA_DIRS = 5;

function allowedTools() {
  const raw = envValue('THREAD_ALLOW_TOOLS');
  if (!raw) return DEFAULT_ALLOW_TOOLS;
  if (/^(none|off)$/i.test(raw)) return [];
  // An entry is passed as one argv item, never through a shell; a leading dash
  // is still refused so it cannot be read as another CLI flag.
  return raw.split(',').map((x) => x.trim()).filter((x) => x && !x.startsWith('-')).slice(0, 30);
}

// Folders outside the project that a thread may read. Each must be an existing
// absolute directory; anything else is an error the caller can show.
function normalizeDirs(dirs) {
  if (dirs == null) return [];
  if (!Array.isArray(dirs)) throw new Error('extra folders must be a list of paths');
  const out = [];
  for (const d of dirs) {
    const p = typeof d === 'string' ? d.trim() : '';
    if (!p) continue;
    if (p.startsWith('-') || !isAbsolute(p)) throw new Error(`extra folders must be absolute paths: ${p}`);
    let st;
    try { st = statSync(p); } catch { throw new Error(`extra folder not found: ${p}`); }
    if (!st.isDirectory()) throw new Error(`extra folder is not a folder: ${p}`);
    const r = resolve(p);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > MAX_EXTRA_DIRS) throw new Error(`at most ${MAX_EXTRA_DIRS} extra folders are allowed`);
  return out;
}

// A thread stored before contexts existed was a full copy.
export const threadContext = (t) => (t.context === 'brief' ? 'brief' : 'full');

// ---------------------------------------------------------------- agents

const frontmatterValue = (head, key) => {
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(head);
  return m ? m[1].replace(/^(["'])(.*)\1$/, '$2').trim() : '';
};

function agentsIn(dir, scope) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    let head;
    try { head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!head) continue;
    const name = frontmatterValue(head[1], 'name') || f.slice(0, -3);
    if (!AGENT_RE.test(name)) continue;
    out.push({
      name,
      description: clip(frontmatterValue(head[1], 'description'), 300),
      model: cleanModel(frontmatterValue(head[1], 'model')),
      // Shown on the board only, never passed to the CLI, so the agent file's own wording is kept.
      effort: clip(frontmatterValue(head[1], 'effort'), 20) || null,
      scope,
    });
  }
  return out;
}

// Sub-agents a thread can run as: <project>/.claude/agents and the user folder, top level only.
// The project's definition wins when both have the same name.
export function listAgents(projectDirArg, userDir = join(homedir(), '.claude', 'agents')) {
  const out = agentsIn(join(projectDirArg, '.claude', 'agents'), 'project');
  for (const a of agentsIn(userDir, 'user')) {
    if (!out.some((x) => x.name === a.name)) out.push(a);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function buildClaudeArgs(card) {
  const t = card.thread;
  // Read mode names its permission mode too, since the CLI otherwise takes the user's own default (a settings file may skip prompts
  // altogether). dontAsk refuses everything that would prompt; the deny rule beats any allow rule the user's settings add for an edit tool.
  const modeArgs = t.mode === 'write'
    ? ['--permission-mode', 'acceptEdits']
    : ['--permission-mode', 'dontAsk', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Agent'];
  const allow = allowedTools();
  const allowArgs = allow.length ? ['--allowedTools', ...allow] : [];
  const dirs = Array.isArray(t.dirs) ? t.dirs.filter((d) => typeof d === 'string' && isAbsolute(d)) : [];
  const dirArgs = dirs.length ? ['--add-dir', ...dirs] : [];
  // A brief thread starts a fresh session; a full one forks the main session. Follow-ups resume the thread's own.
  const base = t.sessionId
    ? ['-p', '--resume', t.sessionId]
    : threadContext(t) === 'brief' ? ['-p'] : ['-p', '--resume', t.parentSessionId, '--fork-session'];
  const model = cleanModel(t.model);
  const effort = cleanEffort(t.effort);
  const who = typeof t.agent === 'string' && AGENT_RE.test(t.agent)
    ? ['--agent', t.agent]
    : [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  // The prompt goes in on stdin, so the variadic flags at the end cannot swallow it.
  return [...base, '--output-format', 'stream-json', '--verbose', ...who, ...modeArgs, ...allowArgs, ...dirArgs];
}

// The arguments for a lane thread's relay. The brief goes in a file, never in argv. A follow-up resumes the provider's session.
export function buildRelayArgs(projectDirArg, card, { brief, outDir, timeoutMs }) {
  const t = card.thread;
  const l = t.lane;
  const args = ['--brief', brief, '--cd', projectDirArg, '--lane', l.name, '--out-dir', outDir, '--timeout', `${Math.max(1, Math.round(timeoutMs / 1000))}s`];
  if (t.mode !== 'write') args.push('--read-only');
  // codex applies its sandbox on a resumed turn only when one is passed, so every turn passes it.
  else if (l.implementer === 'codex') args.push('--sandbox', l.sandbox || 'workspace-write');
  if (l.session) args.push(RESUME[l.implementer].flag, l.session);
  return args;
}

// One turn's activity file. Shared by the runner (writes) and readActivity (reads).
export function activityPath(projectDirArg, cardId, turnNumber) {
  if (!CARD_ID_RE.test(String(cardId))) throw new Error(`invalid card id: ${cardId}`);
  if (!Number.isInteger(turnNumber) || turnNumber < 1) throw new Error(`invalid turn number: ${turnNumber}`);
  return join(projectPaths(projectDirArg).logs, `${cardId}.t${turnNumber}.activity.jsonl`);
}

// What a turn did, from its activity file. A line that does not parse (the
// runner may be mid-write) is skipped.
export function readActivity(projectDirArg, cardId, turnNumber) {
  let text;
  try { text = readFileSync(activityPath(projectDirArg, cardId, turnNumber), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const events = [];
  for (const line of text.split('\n')) {
    try { events.push(JSON.parse(line)); } catch { /* partial or empty line */ }
  }
  return events;
}

export function buildPrompt(card) {
  const t = card.thread;
  const turn = t.turns[t.turns.length - 1];
  const text = turn ? turn.prompt : '';
  // A lane's read-only turn runs in the provider's plan or read-only mode: say what that asks of the answer.
  const laneRead = t.lane != null && t.mode !== 'write' ? [LANE_READ_NOTE] : [];
  if (!t.sessionId && !(t.lane && t.lane.session)) {
    const brief = threadContext(t) === 'brief';
    const context = brief && typeof t.brief === 'string' && t.brief.trim() ? ['## Context', t.brief.trim()] : [];
    return [
      `[side thread ${card.id}: ${card.title}]`,
      brief
        ? 'You are a side thread started from a main session. You have not been given that session\'s conversation; everything you know about it is in the brief below. The main session continues separately and cannot see anything you do here unless it asks for your report.'
        : 'You are now a side thread copied from the main session. The main session continues separately and cannot see anything you do here unless it asks for your report.',
      ...context,
      `Task: ${text}`,
      t.mode === 'write'
        ? 'You may edit files. Keep changes limited to this task.'
        : 'Do not modify any files. Read, search and analyse only.',
      ...laneRead,
      'End your reply with a hand-back digest using exactly these headings: "## Happened", "## Decided", "## Changed", "## Open".',
      MAP_INSTRUCTION,
    ].join('\n');
  }
  return [
    `[side thread ${card.id}: follow-up]`,
    text,
    ...laneRead,
    'End your reply with the same four-heading hand-back digest.',
    MAP_INSTRUCTION,
  ].join('\n');
}

// A side thread runs with THREAD_DEPTH set and must not manage threads itself.
function refuseInsideThread(verb) {
  if (process.env.THREAD_DEPTH) throw new Error(`a side thread cannot ${verb} threads`);
}

function closeOpenTurn(card, error) {
  const turn = card.thread.turns[card.thread.turns.length - 1];
  if (turn && turn.finishedAt == null) {
    turn.finishedAt = now();
    turn.ok = false;
    turn.error = error;
  }
}

function markFailed(projectDirArg, card, error) {
  closeOpenTurn(card, error);
  card.thread.pid = null;
  setRunState(projectDirArg, card, 'failed');
}

// A shared board server may launch a turn for a project other than its own,
// so the child must not inherit this process's project variables.
function childEnv() {
  const env = { ...process.env };
  delete env.THREAD_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

// Called inside updateState so the runner (which reads under the same lock)
// never sees the card before its pid is recorded.
function launchRunner(projectDirArg, card) {
  let child;
  try {
    child = spawn(process.execPath, [RUNNER_PATH, projectDirArg, card.id], {
      detached: true,
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (e) {
    markFailed(projectDirArg, card, `could not start runner: ${tail(e.message, 300)}`);
    return;
  }
  const pid = child.pid ?? null;
  card.thread.pid = pid;
  child.on('error', (e) => {
    // Async spawn failure: record it unless the runner already took over.
    updateState(projectDirArg, (state) => {
      const c = state.cards.find((x) => x.id === card.id);
      if (isThread(c) && c.thread.runState === 'running' && (c.thread.pid === pid || c.thread.pid == null)) {
        markFailed(projectDirArg, c, `could not start runner: ${tail(e.message, 300)}`);
      }
    }).catch(() => {});
  });
  child.unref();
}

// The checks both ways of starting a thread share. Returns what beginThread stores.
async function launchOptions(projectDirArg, { sessionId, mode, extraDirs, context = 'brief', brief, agent, model, effort, lane }) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new Error('session_id must be a UUID (the main session id)');
  }
  if (!MODES.includes(mode)) throw new Error(`invalid mode "${mode}" (use read or write)`);
  if (!CONTEXTS.includes(context)) throw new Error(`invalid context "${context}" (use brief or full)`);
  const text = context === 'brief' && typeof brief === 'string' ? brief.trim() : '';
  if (text.length > MAX_BRIEF) {
    throw new Error(`brief is too long (${text.length} characters, the limit is ${MAX_BRIEF}); shorten it, or use context "full" to copy the whole conversation`);
  }
  const dirs = normalizeDirs(extraDirs);
  const name = typeof agent === 'string' ? agent.trim() : '';
  const laneName = typeof lane === 'string' ? lane.trim() : '';
  if (laneName) {
    const given = (v) => typeof v === 'string' && v.trim();
    if (name || given(model) || given(effort)) throw new Error('a lane brings its own provider, model and effort: give lane without agent, model or effort');
    if (context === 'full') throw new Error('a lane thread cannot be a full copy of the conversation: use context "brief" with a lane');
    if (dirs.length) throw new Error('a lane thread cannot take extra_dirs: the provider\'s relay has no option for them');
    const l = await requireRunnableLane(projectDirArg, laneName, mode);
    return { context: 'brief', brief: text, dirs, agent: null, model: null, effort: null, lane: laneSnapshot(l) };
  }
  if (name) {
    const known = listAgents(projectDirArg).map((a) => a.name);
    if (!known.includes(name)) {
      throw new Error(`Unknown agent "${clip(name, 60)}". ${known.length ? `Available: ${known.join(', ')}.` : 'No agents are defined in .claude/agents.'}`);
    }
  }
  const wantModel = typeof model === 'string' ? model.trim() : '';
  const wantEffort = typeof effort === 'string' ? effort.trim() : '';
  if (wantModel && !cleanModel(wantModel)) throw new Error(`invalid model "${clip(wantModel, 60)}"`);
  if (wantEffort && !cleanEffort(wantEffort)) throw new Error(`invalid effort "${clip(wantEffort, 20)}" (use ${EFFORTS.join(', ')})`);
  if (name && (wantModel || wantEffort)) throw new Error('give an agent, or a model and effort, not both: an agent brings its own');
  // An agent brings its own model. Otherwise a named model wins over the main session's, and
  // then the session's effort is not inherited either: not every model takes every level.
  let runsWith = { model: null, effort: null };
  if (!name) {
    const base = wantModel ? { model: wantModel, effort: null } : await sessionModel(projectDirArg, sessionId);
    runsWith = { model: base.model, effort: wantEffort || base.effort };
  }
  return { context, brief: text, dirs, agent: name || null, ...runsWith };
}

// Gives `card` its thread and launches the first turn. Called inside updateState.
function beginThread(projectDirArg, card, { sessionId, mode, prompt, ...opts }) {
  card.thread = {
    parentSessionId: sessionId.toLowerCase(),
    sessionId: null,
    ...opts,
    mode,
    runState: 'running',
    pid: null,
    turns: [{ prompt, startedAt: now(), finishedAt: null, ok: null, result: null, error: null }],
    lastResult: null,
    reported: false,
    announced: false,
  };
  setRunState(projectDirArg, card, 'running');
  launchRunner(projectDirArg, card);
}

export async function startThread(projectDirArg, { title, task, sessionId, mode = 'read', extraDirs, context, brief, agent, model, effort, parent, lane } = {}) {
  refuseInsideThread('start');
  const t = typeof title === 'string' ? title.trim() : '';
  const k = typeof task === 'string' ? task.trim() : '';
  const opts = await launchOptions(projectDirArg, { sessionId, mode, extraDirs, context, brief, agent, model, effort, lane });
  if (!t) throw new Error('title must not be empty');
  if (!k) throw new Error('task must not be empty');
  const parentId = cleanParent(parent);
  return updateState(projectDirArg, (state) => {
    if (parentId) checkParent(state, parentId, 'thread');
    state.seq += 1;
    const ts = now();
    const card = {
      id: `c${state.seq}`,
      kind: 'thread',
      title: t,
      note: '',
      status: readConfig(projectDirArg).taskRoles.working,
      source: 'claude',
      seenByClaude: true,
      createdAt: ts,
      updatedAt: ts,
    };
    if (parentId) card.parent = parentId;
    state.cards.push(card);
    beginThread(projectDirArg, card, { sessionId, mode, prompt: k, ...opts });
    return card;
  });
}

// A thread takes no acceptance criteria or blockers (setFields refuses them), so a card that has some cannot become one. The
// Blocked by list counts whole, finished blockers included (a thread card cannot hold the field at all); only a blocker whose
// card was removed is not counted, as the board does not show it either.
function refuseThreadFields(card, cards) {
  const has = [hasCriteria(card) ? 'acceptance criteria' : '', liveBlockers(card, cards).length ? 'a Blocked by list' : ''].filter(Boolean);
  if (has.length) throw new Error(`A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first (${card.id} has ${has.join(' and ')}).`);
}

// Turns a task or idea card into a thread in place: same id, title, note and source.
// Nobody writes a brief on the board, so in brief mode the card's note is the brief.
// A card that has a lane runs on it; the lane is read from the card, never from the caller.
export async function startThreadFromCard(projectDirArg, cardId, { sessionId, mode = 'read', extraDirs, context, agent } = {}) {
  refuseInsideThread('start');
  requireTasks(readConfig(projectDirArg));
  const existing = readState(projectDirArg).cards.find((c) => c.id === cardId);
  if (existing && existing.kind !== 'thread' && existing.kind !== 'milestone') refuseThreadFields(existing, readState(projectDirArg).cards);
  const cardLane = existing && existing.kind !== 'thread' && existing.kind !== 'milestone' && typeof existing.lane === 'string' ? existing.lane : '';
  const opts = await launchOptions(projectDirArg, { sessionId, mode, extraDirs, context, brief: existing && existing.note, agent, lane: cardLane });
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, cardId);
    if (card.kind === 'thread') throw new Error(`card ${cardId} is already a thread`);
    if (card.kind === 'milestone') throw new Error(`card ${cardId} is a milestone and cannot be started as a thread`);
    if ((typeof card.lane === 'string' ? card.lane : '') !== cardLane) throw new Error(`card ${cardId} changed while it was starting; try again`);
    refuseThreadFields(card, state.cards);
    const text = typeof card.note === 'string' ? card.note.trim() : '';
    card.kind = 'thread';
    // In brief mode the note already travels as the brief, so the task is the title alone.
    const prompt = text && opts.context === 'full' ? `${card.title}\n\n${text}` : card.title;
    beginThread(projectDirArg, card, { sessionId, mode, prompt, ...opts });
    delete card.lane;   // the thread holds it now
    return card;
  });
}

export async function continueThread(projectDirArg, id, message, { sessionId } = {}) {
  refuseInsideThread('continue');
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new Error('message must not be empty');
  // A lane thread is checked against the lanes as they are now, before the lock is taken (loading them can take seconds).
  let fresh = null;
  const before = readState(projectDirArg).cards.find((c) => c.id === id);
  if (isThread(before) && before.thread.lane != null && (before.thread.runState === 'idle' || before.thread.runState === 'failed')) {
    const l = before.thread.lane;
    const bad = unusableLane(l);
    if (bad) throw new Error(`thread ${id} cannot continue: ${bad}; start a new thread instead`);
    if (!l.session) throw new Error(`thread ${id} has no session to continue: the ${l.implementer} provider gave none; start a new thread instead`);
    fresh = await requireRunnableLane(projectDirArg, l.name, before.thread.mode);
    if (fresh.implementer !== l.implementer) {
      throw new Error(`lane "${l.name}" now runs on ${fresh.implementer}, which cannot continue a ${l.implementer} session; start a new thread instead`);
    }
  }
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.runState === 'running') throw new Error(`thread ${id} is still running`);
    if (th.runState === 'ended') throw new Error(`thread ${id} has ended`);
    if (th.lane != null) {
      if (!fresh) throw new Error(`thread ${id} changed while the follow-up was starting; try again`);
      if (!th.lane.session) throw new Error(`thread ${id} has no session to continue: the ${th.lane.implementer} provider gave none; start a new thread instead`);
      th.lane = laneSnapshot(fresh, th.lane.session);
    } else if (!th.sessionId) throw new Error(`thread ${id} has no session yet (its first turn did not finish); start a new thread instead`);
    const turn = { prompt: m, startedAt: now(), finishedAt: null, ok: null, result: null, error: null };
    if (typeof sessionId === 'string' && sessionId && !sameSession(sessionId, th.parentSessionId)) turn.sentBy = sessionId.toLowerCase();
    th.turns.push(turn);
    // `reported` is about the newest successful result, so it is left alone here:
    // the runner clears it only when this turn produces a new result. A follow-up
    // that fails leaves an already-reported thread reported.
    th.announced = false;
    th.pid = null;
    setRunState(projectDirArg, card, 'running');
    launchRunner(projectDirArg, card);
    return card;
  });
}

const CONFIRM_TTL_MS = 10 * 60 * 1000;

// Guard for a call made by a session other than the one that started the thread.
// Returns null when the call may go ahead (the caller is the parent, or the
// confirm code is valid and has been used up); otherwise issues a fresh code.
// `other` tells the caller which of the two cases it is.
function checkCaller(th, action, sessionId, confirmCode) {
  if (sameSession(sessionId, th.parentSessionId)) return { ok: true, other: false };
  const p = th.pendingConfirm;
  const given = typeof confirmCode === 'string' ? confirmCode.trim().toLowerCase() : '';
  const valid = !!p && !!given && p.code === given && p.action === action
    && sameSession(p.sessionId, sessionId) && Date.parse(p.expiresAt) > Date.now();
  if (valid) {
    delete th.pendingConfirm;
    return { ok: true, other: true };
  }
  const code = randomBytes(4).toString('hex');
  th.pendingConfirm = { code, action, sessionId: String(sessionId).toLowerCase(), expiresAt: new Date(Date.now() + CONFIRM_TTL_MS).toISOString() };
  return { ok: false, code };
}

export async function reportThread(projectDirArg, id, { sessionId, confirmCode } = {}) {
  refuseInsideThread('report');
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    const th = card.thread;
    if (th.lastResult == null) {
      const last = th.turns[th.turns.length - 1];
      throw new Error(`thread ${id} has no successful turn yet (state: ${th.runState})${last && last.ok === false && last.error ? `; its last turn failed: ${clip(last.error, 300)}` : ''}`);
    }
    let otherSession = false;
    if (sessionId != null) {
      const g = checkCaller(th, 'report', sessionId, confirmCode);
      if (!g.ok) return { card, needsConfirm: true, action: 'report', code: g.code };
      otherSession = g.other;
    }
    if (otherSession) {
      if (!Array.isArray(th.reports)) th.reports = [];
      th.reports.push({ sessionId: String(sessionId).toLowerCase(), at: now() });
    } else {
      th.reported = true;
      delete th.reportRequestedAt;
    }
    const last = th.turns[th.turns.length - 1];
    const digest = stripMap(th.lastResult);
    let text = digest;
    if (th.runState === 'running') {
      text = `(a newer turn of thread ${id} is still running; this is the previous result)\n${digest}`;
    } else if (last && last.ok === false) {
      text = `(the newest turn of thread ${id} failed: ${last.error || 'unknown error'}; this is the last successful result)\n${digest}`;
    }
    return otherSession ? { card, text, otherSession: true } : { card, text };
  });
}

export async function endThread(projectDirArg, id, { sessionId, confirmCode } = {}) {
  refuseInsideThread('end');
  let pidToKill = null;
  const result = await updateState(projectDirArg, (state) => {
    const c = findThread(state, id);
    const th = c.thread;
    if (th.runState === 'ended') return { card: c };
    if (sessionId != null) {
      const g = checkCaller(th, 'end', sessionId, confirmCode);
      if (!g.ok) return { card: c, needsConfirm: true, action: 'end', code: g.code };
    }
    const wasRunning = th.runState === 'running';
    const pid = th.pid;
    if (wasRunning) {
      if (runnerAlive(projectDirArg, c)) pidToKill = pid; // runner records the turn when it exits
      else closeOpenTurn(c, 'ended by user');
    }
    th.pid = null;
    delete th.reportRequestedAt;
    setRunState(projectDirArg, c, 'ended');
    return { card: c };
  });
  if (pidToKill) {
    try { process.kill(pidToKill, 'SIGTERM'); } catch { /* already gone */ }
  }
  return result;
}

// The board cannot write into a session, so "Report to main session" only stores
// a request; the hook tells the parent session on its next prompt.
export async function requestReport(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    if (card.thread.lastResult == null) throw new Error(`thread ${id} has nothing to report yet`);
    if (card.thread.reported) throw new Error(`thread ${id} is already reported`);
    card.thread.reportRequestedAt = now();
    return card;
  });
}

export async function cancelReportRequest(projectDirArg, id) {
  return updateState(projectDirArg, (state) => {
    const card = findThread(state, id);
    delete card.thread.reportRequestedAt;
    return card;
  });
}

// Read-only: the request stays until the report is made, so the hook repeats it on each prompt.
export async function pendingReportRequests(projectDirArg, sessionId) {
  return readState(projectDirArg).cards.filter((c) => {
    const th = isThread(c) && c.thread;
    return th && th.reportRequestedAt && th.lastResult != null && !th.reported && sameSession(th.parentSessionId, sessionId);
  });
}

// Finished threads with a result nobody has pulled yet, split by whether the
// given session started them.
export async function pickReportable(projectDirArg, sessionId) {
  const state = readState(projectDirArg);
  const mine = [];
  const others = [];
  for (const card of state.cards) {
    if (!isThread(card)) continue;
    const th = card.thread;
    if (th.lastResult == null || th.reported || th.runState === 'running') continue;
    (sameSession(sessionId, th.parentSessionId) ? mine : others).push(card);
  }
  return { mine, others };
}

export async function reconcile(projectDirArg) {
  return updateState(projectDirArg, (state) => {
    for (const card of state.cards) {
      if (!isThread(card)) continue;
      if (card.thread.runState === 'running' && !runnerAlive(projectDirArg, card)) {
        markFailed(projectDirArg, card, 'runner exited without a result');
      }
    }
    return state;
  });
}

export async function pendingAnnouncements(projectDirArg, sessionId) {
  return updateState(projectDirArg, (state) => {
    const out = [];
    for (const card of state.cards) {
      if (!isThread(card)) continue;
      const th = card.thread;
      if (!sameSession(th.parentSessionId, sessionId)) continue;
      if ((th.runState === 'idle' || th.runState === 'failed') && th.announced === false) {
        th.announced = true;
        out.push(JSON.parse(JSON.stringify(card)));
      }
    }
    return out;
  });
}
