// Shared library for the MCP server, the board, the runner and the hook: cards, the thread lifecycle,
// hand-back parsing and the project listing. State and sessions live in state.mjs and sessions.mjs and
// are re-exported here. Zero dependencies, node: built-ins only.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, envValue, legacyStores, mainCheckout, nextCardId, now, projectKey, projectPaths, readRepoMark, readLocalState, readState, repoDrift, repoImport, repoRefusal, repoRootOf, runInStore, storeKey, storePinned, updateLocalState, updateState, withLock } from './state.mjs';
import { EFFORTS, cleanEffort, cleanModel, collapse, sameSession, sessionModel } from './sessions.mjs';
import { ChatOnlyError, DEFAULT_STAGES, readConfig } from './config.mjs';
import { openWaits, reviewApproved } from './waits.mjs';
import { notifyActive } from './notify.mjs';
import { CARD_ID_RE, CARD_ID_SRC, FIELD_NAMES, MAX_DEPENDS, addHistory, cardById, claudeCard, cleanDependsOn, cleanFields, cleanLinkNames, cleanWorker, criteriaCut, criteriaHash, finishedStageIds, gatedByCriteria, hasCriteria, leftDoneAt, liveBlockers, liveDependsOn, liveLinkNames, milestoneCardLinks, pinLeftDone as pinExit, threadById, watchFinished } from './fields.mjs';
import { codeMapNote } from './codemap.mjs';
import { RESUME, laneSnapshot, requireRunnableLane, unusableLane } from './lanes.mjs';

export * from './state.mjs';
export * from './sessions.mjs';
export * from './config.mjs';
export * from './waits.mjs';
export * from './notify.mjs';
export * from './fields.mjs';
export * from './layout.mjs';

// The default stage ids. A project's own stages come from readConfig.
export const STATUSES = DEFAULT_STAGES.map((s) => s.id);

export const KINDS = ['task', 'idea', 'milestone'];
export const MODES = ['read', 'write'];
export const CONTEXTS = ['brief', 'full'];
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BRIEF = 50000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[0-9a-f]{12}$/;
export const VERSION = (() => {
  try {
    const v = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
})();
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
    // A folder that a repo-backed board now stands for (a worktree, a sub-folder, a symlinked path) keeps an older store here. It is listed only
    // while it holds a thread that has not ended, and then as what it is, an older store, so that nothing running is hidden.
    const legacy = storeKey(s.projectDir) !== key;
    if (legacy && !s.cards.some((c) => c && c.kind === 'thread' && c.thread && c.thread.runState !== 'ended')) return null;
    // A repo-backed project's cards are the repo's, joined with this store's threads; the store's own task cards are the old copies.
    const cards = !legacy && repoRootOf(s.projectDir) ? readState(s.projectDir).cards : s.cards;
    let newest = NaN;
    let threads = 0;
    let running = 0;
    let waiting = 0;
    let open = 0;
    let done = 0;
    const cfg = legacy ? runInStore(key, () => readConfig(s.projectDir)) : readConfig(s.projectDir);
    for (const c of cards) {
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
      name: (parts.length ? parts[parts.length - 1] : s.projectDir) + (legacy ? ' (older store)' : ''),
      exists: dirExists(s.projectDir),
      cards: cards.length,
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
  return runInStore(key, () => withLock(entry.projectDir, async () => {
    const again = listedProject(key);
    if (!again) throw new Error('unknown project');
    if (again.exists) throw new Error(`project folder still exists: ${again.projectDir}`);
    const state = readState(again.projectDir);
    const busy = state.cards.find((c) => isThread(c) && c.thread.runState === 'running' && runnerAlive(again.projectDir, c));
    if (busy) throw new Error(`thread ${busy.id} is still running; end it before forgetting the project`);
    await rm(target, { recursive: true, force: true });
    return true;
  }));
}

// ---------------------------------------------------------------- the board in the repo

/**
 * What a session needs to know about a project's repo folder (`.claude/thread/`), read-only: { backed, root, notices, drift, mark, legacy, refused }.
 * backed: the project keeps its cards there. notices: card files that could not be read, and ids two cards share ({ file, reason, shown }).
 * drift: the cards an older plugin version added or changed in this machine's older stores since the one-time copy ({ id, why, from }).
 * mark: what is recorded about that copy. legacy: the older per-path stores of this repo's worktrees and sub-folders ({ key, projectDir,
 * cards, active }, active being the threads in them that have not ended). `wasBacked`: not backed now, but it was (the folder is gone, for
 * example on another branch). refused: why a `.claude/thread/` folder that exists is not used (a link, outside the repository, the home folder).
 * ambiguousAliases: old card ids that name no card, because two of the project's older stores had the same one.
 */
export function repoInfo(projectDirArg) {
  const root = repoRootOf(projectDirArg);
  if (!root) {
    const main = mainCheckout(projectDirArg);
    const refused = repoRefusal(projectDirArg);
    const was = !refused && typeof readRepoMark(main).importedAt === 'string';
    return { backed: false, wasBacked: was, refused, root: main, notices: [], drift: [], mark: null, legacy: [], ambiguousAliases: [] };
  }
  const state = readState(projectDirArg);
  const m = state.repo && typeof state.repo === 'object' ? state.repo : {};
  const mark = typeof m.importedAt === 'string' ? { importedAt: m.importedAt, copied: Number(m.copied) || 0, skipped: m.skipped === true, announced: m.announced !== false } : null;
  const legacy = legacyStores(projectDirArg).map((s) => ({
    key: s.key,
    projectDir: s.projectDir,
    cards: s.state.cards.filter((c) => c && c.kind !== 'thread').length,
    active: s.state.cards.filter((c) => c && c.kind === 'thread' && c.thread && c.thread.runState !== 'ended').length,
  }));
  const drift = repoDrift(projectDirArg, state);
  for (const l of legacy) l.pending = drift.filter((d) => d.src === l.key).length;
  return { backed: true, wasBacked: true, refused: null, root, notices: state.notices || [], drift, mark, legacy, ambiguousAliases: state.ambiguousAliases || [] };
}

/** One notice of repoInfo as a sentence: a card file that is not shown, or two cards that share an id (both shown). */
export function repoNoticeLine(n) {
  const file = String(n.file);
  return n.shown ? `${file} ${n.reason}.` : `${file} ${n.reason}, so that card is not on the board. Do not edit or delete the file; tell the user.`;
}

/** The ids of the drift entries of one kind, as the session should name them: the id, and where it is when it is an older per-path store's. */
export function driftLabels(drift, why) {
  const base = (p) => String(p).split(/[\\/]+/).filter(Boolean).pop() || String(p);
  return drift.filter((d) => d.why === why).map((d) => (d.from ? `${d.id} in the older store of ${base(d.from)}` : d.id));
}

/** The sentence about old card ids that name no card (repoInfo().ambiguousAliases), or ''. */
export function ambiguousAliasLine(ids) {
  if (!ids || !ids.length) return '';
  const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` and ${ids.length - 10} more` : '');
  return `${ids.length === 1 ? 'The old card id' : 'The old card ids'} ${shown} no longer name${ids.length === 1 ? 's' : ''} a card: two older boards of this project had ${ids.length === 1 ? 'that id' : 'those ids'} on different cards, and the one-time copy gave them different new ids. Use the new ids (board_list shows them).`;
}

/** The sentence about the older per-path stores of a repo-backed project (repoInfo().legacy), or ''. */
export function legacyLine(legacy) {
  legacy = (legacy || []).filter((l) => l.active || l.pending);   // one that is copied and has nothing running is not worth a line
  if (!legacy.length) return '';
  const parts = legacy.slice(0, 5).map((l) => `${l.projectDir} (${l.cards} card${l.cards === 1 ? '' : 's'}${l.active ? `, ${l.active} thread${l.active === 1 ? '' : 's'} not ended` : ''})`);
  return `Older stores of this machine belong to this repo's worktrees or sub-folders: ${parts.join('; ')}${legacy.length > 5 ? `; and ${legacy.length - 5} more` : ''}. Their cards are copied into the repo by board_import. Threads in them finish where they are and show on the board's projects home while they are not ended; they are not in this session's thread tools.`;
}

/** The SessionStart note has told the session about the copy: it is not told again. */
export async function markRepoAnnounced(projectDirArg) {
  if (!repoRootOf(projectDirArg)) return;
  await updateState(projectDirArg, (state) => { if (state.repo && state.repo.announced === false) state.repo.announced = true; });
}

/**
 * `board_import`: brings the cards an older plugin version added to this machine's older stores since the one-time copy into the repo's
 * `cards/`, with new random ids (shared fields only). A card changed there is reported, not copied over the repo's version. With `dismiss`,
 * nothing is copied and those cards are no longer mentioned. Returns { copied, changed } (the cards' old ids).
 */
export async function importOldCards(projectDirArg, { dismiss = false } = {}) {
  refuseInsideThread('import cards for');
  const root = repoRootOf(projectDirArg);
  if (!root) throw new Error('this project does not keep its board in the repo (there is no .claude/thread/ folder at the main checkout\'s root); there is nothing to import into');
  return updateState(projectDirArg, (state) => repoImport(projectDirArg, state, { dismiss }));
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

// The card with this id (a repo card before a thread of the same id, see fields.cardById). A card that was copied into the repo under a new id
// is also found by the id it had before (state.aliases), when no card has that id now. `aliasFirst` (the calls Claude makes, which may name a
// card by the id it had before the copy) resolves the id as fields.claudeCard does: the alias comes before a card file that anyone pushed under
// that old id, and a thread on this machine with that id comes before both. The board names a card by the id it shows, so its calls take the
// card that has that id.
function findCard(state, id, aliasFirst = false) {
  const card = aliasFirst
    ? claudeCard(state, id)
    : cardById(state.cards, id) ?? (state.aliases && state.aliases.has(id) ? cardById(state.cards, state.aliases.get(id)) : undefined);
  if (!card) throw new Error(`card not found: ${id}`);
  return card;
}

export function findThread(state, id) {
  const card = threadById(state.cards, id);
  if (card) return card;
  findCard(state, id);
  throw new Error(`card ${id} is not a thread`);
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
  return liveBlockers(card, cards).filter((id) => !isFinished(cardById(cards, id), cfg));
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
  const m = state.cards.find((c) => c.id === parentId && c.kind === 'milestone') ?? cardById(state.cards, parentId);
  if (!m) throw new Error(`milestone not found: ${parentId}`);
  if (m.kind !== 'milestone') throw new Error(`${parentId} is not a milestone`);
}

// The ids Claude gave for a parent and for blockers, as the ids of the cards they name (fields.claudeCard): an id a card had before it was
// copied into the repo is stored as the id it has now. An id that names nothing stays as given, and the checks refuse it.
const claudeId = (state, id) => (typeof id === 'string' ? claudeCard(state, id)?.id ?? id : id);
const claudeIds = (state, ids) => (Array.isArray(ids) ? ids.map((id) => claudeId(state, id)) : ids);

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
// A sub-agent (a file in .claude/agents) is the card's other kind of worker: starting the card as a thread runs it as that agent. A card holds
// a lane or an agent, never both. Same rules as the lane: undefined not given, null given empty (removes it).
const cleanAgent = (agent) => {
  if (agent === undefined) return undefined;
  if (agent === null || (typeof agent === 'string' && !agent.trim())) return null;
  if (typeof agent !== 'string') throw new Error('agent must be a sub-agent name');
  return agent.trim();
};
export function checkAgentKind(kind) {
  if (kind === 'milestone') throw new Error('a milestone cannot have an agent');
  if (kind === 'thread') throw new Error('a thread\'s agent is chosen when it starts (thread_start with agent, or start a card that has one)');
}
const ONE_WORKER = 'a card has one worker: give a lane or an agent, not both';

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
    const b = cardById(state.cards, id);
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

// The links drawn by hand on the Milestones map (`dependsOn`, milestone cards only): the milestones a milestone waits for. They are a picture of
// the plan, not a rule: they gate nothing (no thread start, no done gate). Each must be another milestone of the project, and the links among
// milestones make no loop (a loop of card links is allowed and shown on the map; one of hand links is refused, because the owner or Claude
// just drew it).
const msName = (c) => `${c.id} "${clip(c.title, 30)}"`;
const milestoneOf = (state, id) => state.cards.find((c) => c.id === id && c.kind === 'milestone');
function checkDependsOn(state, card, ids) {
  if (card.kind !== 'milestone') throw new Error('depends_on is only for milestones: a task or idea is blocked by other cards with blocked_by');
  for (const id of ids) {
    if (id === card.id) throw new Error(`depends_on: ${id} cannot depend on itself`);
    const m = milestoneOf(state, id);
    if (!m) {
      if (cardById(state.cards, id)) throw new Error(`depends_on: ${id} is not a milestone`);
      throw new Error(`depends_on: milestone not found: ${id}`);
    }
  }
  const links = new Map(state.cards.filter((c) => c.kind === 'milestone').map((c) => [c.id, c.id === card.id ? ids : liveDependsOn(c, state.cards, state.aliases)]));
  // Only a link that is new can close a loop: a loop that is already there (two clones each drew one, and git merged them) never blocks a change
  // of the other links, nor taking a link away.
  const kept = new Set(liveDependsOn(card, state.cards, state.aliases));
  for (const id of ids) {
    if (kept.has(id)) continue;
    // a way from the new dependency back to the card: that is the loop
    const from = new Map([[id, null]]);
    const todo = [id];
    while (todo.length && !from.has(card.id)) {
      const at = todo.shift();
      for (const next of links.get(at) || []) if (!from.has(next)) { from.set(next, at); todo.push(next); }
    }
    if (from.has(card.id)) {
      const path = [];
      for (let x = card.id; x !== null; x = from.get(x)) path.unshift(x);
      const name = (x) => msName(milestoneOf(state, x));
      throw new Error(`depends_on: that would make a loop of milestone links: ${name(card.id)} would depend on ${path.map(name).join(', which depends on ')}`);
    }
  }
}
// Sets (or, with an empty list, removes) a milestone's `dependsOn` after checking it. True when the card changed.
function setDependsOn(state, card, ids) {
  if (ids.length) checkDependsOn(state, card, ids);
  if (JSON.stringify(card.dependsOn ?? []) === JSON.stringify(ids)) return false;
  if (ids.length) card.dependsOn = ids; else delete card.dependsOn;
  return true;
}

// The names a milestone gives its lines (`linkNames`, see fields.cleanLinkNames): a name goes with a line that runs between the two milestones, a
// hand link or a card link. `changes` is the cleaned object: a text sets a name, null takes it away. True when the card changed.
function setLinkNames(state, card, changes) {
  if (card.kind !== 'milestone') {
    if (Object.values(changes).some((v) => v !== null)) throw new Error('link_names is only for milestones: it names the lines of the Milestones map');
    return false;
  }
  const names = liveLinkNames(card, state.cards, state.aliases);
  for (const [raw, text] of Object.entries(changes)) {
    const id = !milestoneOf(state, raw) && state.aliases && state.aliases.has(raw) ? state.aliases.get(raw) : raw;
    if (text === null) { delete names[id]; continue; }
    if (id === card.id) throw new Error(`link_names: ${id} cannot have a line to itself`);
    if (!milestoneOf(state, id)) throw new Error(`link_names: milestone not found: ${id}`);
    const line = liveDependsOn(card, state.cards, state.aliases).includes(id) || milestoneCardLinks(state.cards).some((e) => e.from === card.id && e.to === id);
    if (!line) throw new Error(`link_names: no line runs from ${msName(milestoneOf(state, id))} to ${msName(card)}; a name needs a link drawn by hand (depends_on) or a card link (blocked_by)`);
    names[id] = text;
  }
  if (Object.keys(names).length > MAX_DEPENDS) throw new Error(`a milestone can name ${MAX_DEPENDS} lines at most`);
  if (JSON.stringify(card.linkNames ?? {}) === JSON.stringify(names)) return false;
  if (Object.keys(names).length) card.linkNames = names; else delete card.linkNames;
  return true;
}
// Drops the names of a milestone whose lines are gone (the last link taken away). Quiet: no history, no time.
// Never while the state reports a card file it could not read (state.notices): a line may come from a card that cannot be seen now.
function pruneLinkNames(state, card) {
  if (!isObject(card.linkNames) || (Array.isArray(state.notices) && state.notices.length)) return;
  const names = liveLinkNames(card, state.cards, state.aliases);
  if (Object.keys(names).length) card.linkNames = names; else delete card.linkNames;
}

// The same for every milestone: run by a write that can end a line (a blocker taken off, a card moved to another milestone or turned into an idea,
// a card or a milestone removed).
function pruneAllLinkNames(state) {
  for (const c of state.cards) if (c.kind === 'milestone') pruneLinkNames(state, c);
}

// Moving a card that has acceptance criteria into a finished stage (the done stage or a later one) needs the owner's approval of a
// review item; so does a move from one finished stage to another when the card was never approved (the owner dragged it there). Only
// Claude's own changes are held to it; the board's are not (its views show such a card as not verified).
function gateDone(state, card, cfg, to) {
  pinLeftDone(state, card, cfg);
  if (!stageFinished(cfg, to) || !gatedByCriteria(card) || reviewApproved(card, finishedStageIds(cfg))) return;
  if (criteriaCut(card)) {
    throw new Error(`${card.id} had acceptance criteria on this machine's board and the repo file now has ${hasCriteria(card) ? 'fewer' : 'none'}: that is a change from outside, and only the owner can accept it, by editing the criteria on the board. Until then the card needs an approval of a review item (wait_add, kind review) like any card with criteria.`);
  }
  throw new Error(`${card.id} has acceptance criteria: raise a review item with wait_add (kind review) and move it to ${to} after the owner approves.`);
}

// A card of a repo-backed project keeps its own record of when it last left the finished stages (`localLeftDoneAt`, in the overlay, never in the
// repo file), taken from the card as this write sees it: a file that a pull replaces cannot then drop the moves from its history and the
// card's leftDoneAt to make an approval given before the card was reopened count again. Run inside the write, before the gate is asked. The
// record also notices an exit that left no trace in the file at all (fields.watchFinished). A time a little ahead of now is pinned as now
// (fields.pinLeftDone); one far ahead is no exit (fields.leftDoneAt).
function pinLeftDone(state, card, cfg) {
  if (state.repoBacked) pinExit(card, cfg, now());
}

// Claude may add acceptance criteria to a card but not take them away or reword them: they are the owner's test of the work.
// The existing lines must stay as they are, in order; only the board (source user) may change them freely.
function guardCriteria(card, next) {
  if (next === undefined || !gatedByCriteria(card)) return;
  if (criteriaCut(card)) throw new Error(`${card.id}'s acceptance criteria were cut or removed in the repo file: only the owner can accept that, by editing them on the board.`);
  const kept = Array.isArray(next) && next.length >= card.criteria.length && card.criteria.every((c, i) => c === next[i]);
  if (!kept) throw new Error(`${card.id}'s acceptance criteria can only be changed by the owner on the board; you may add lines.`);
}

export async function addCard(projectDirArg, { title, note = '', status, kind = 'task', source = 'claude', parent, lane, agent, type, priority, labels, blockedBy, criteria, dependsOn, linkNames, worker } = {}) {
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
  const parentId0 = cleanParent(parent);
  const laneName = cleanLane(lane);
  if (laneName) checkLaneKind(kind);
  const agentName = cleanAgent(agent);
  if (agentName) {
    if (laneName) throw new Error(ONE_WORKER);
    checkAgentKind(kind);
    requireAgent(projectDirArg, agentName);
  }
  const fields = cleanFields({ type, priority, labels, blockedBy, criteria });
  const depends = cleanDependsOn(dependsOn);
  const names = cleanLinkNames(linkNames);
  const by = cleanWorker(worker);
  return updateState(projectDirArg, (state) => {
    const claude = source === 'claude';
    const parentId = claude ? claudeId(state, parentId0) : parentId0;
    if (claude && fields.blockedBy) fields.blockedBy = claudeIds(state, fields.blockedBy);
    if (parentId) checkParent(state, parentId, kind);
    const dependIds = depends && claude ? claudeIds(state, depends) : depends;
    const ts = now();
    const card = {
      id: nextCardId(state),
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
    if (agentName) card.agent = agentName;
    setFields(state, card, fields);
    if (dependIds) setDependsOn(state, card, dependIds);
    if (names && Object.keys(names).length) setLinkNames(state, card, names);
    if (source === 'claude') gateDone(state, card, cfg, status);
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

export async function updateCard(projectDirArg, id, { title, note, status, kind, parent, lane, agent, type, priority, labels, blockedBy, criteria, dependsOn, linkNames, worker } = {}, { source = 'claude' } = {}) {
  const cfg = readConfig(projectDirArg);
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must not be empty');
  }
  // Chat-only has its own columns; a task card's stage is refused there (below) for the board being off, not for its name.
  if (status !== undefined && cfg.mode !== 'chat') checkStatus(cfg, status);
  const parentId0 = cleanParent(parent);
  const laneName = cleanLane(lane);
  const agentName = cleanAgent(agent);
  if (agentName) {
    if (laneName) throw new Error(ONE_WORKER);
    requireAgent(projectDirArg, agentName);
  }
  const cleaned = cleanFields({ type, priority, labels, blockedBy, criteria });
  const depends = cleanDependsOn(dependsOn);
  const names = cleanLinkNames(linkNames);
  const by = cleanWorker(worker);
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, id, source === 'claude');
    const parentId = source === 'claude' ? claudeId(state, parentId0) : parentId0;
    if (source === 'claude' && cleaned.blockedBy) cleaned.blockedBy = claudeIds(state, cleaned.blockedBy);
    if (!isThread(card)) requireTasks(cfg);
    pinLeftDone(state, card, cfg);
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
    if (agentName) {
      if (card.agent !== agentName) { checkAgentKind(card.kind); card.agent = agentName; changed = true; fields.push('agent'); }
    } else if (agentName === null && card.agent !== undefined) { delete card.agent; changed = true; fields.push('agent'); }
    // one worker: setting a lane takes the agent off, and setting an agent takes the lane off
    if (laneName && card.agent !== undefined) { delete card.agent; changed = true; fields.push('agent'); }
    if (agentName && card.lane !== undefined) { delete card.lane; changed = true; fields.push('lane'); }
    if (source === 'claude') guardCriteria(card, cleaned.criteria);
    const setNow = setFields(state, card, cleaned);
    if (setNow.length) { changed = true; fields.push(...setNow); }
    if (depends !== undefined && (depends !== null || card.kind === 'milestone')) {
      if (setDependsOn(state, card, depends === null ? [] : source === 'claude' ? claudeIds(state, depends) : depends)) { changed = true; fields.push('depends on'); }
    }
    // after the links, so a link and its name can come in one call; a link taken away takes its name
    if (card.kind === 'milestone' && depends !== undefined) pruneLinkNames(state, card);
    if (names !== undefined && Object.keys(names).length) {
      const mapped = {};
      for (const [k, v] of Object.entries(names)) mapped[source === 'claude' ? claudeId(state, k) : k] = v;
      if (setLinkNames(state, card, mapped)) { changed = true; fields.push('link names'); }
    }
    // the owner changing the criteria on the board is what this machine's record of them follows (fields.criteriaCut); Claude's lines are
    // recorded by the write itself
    if (source === 'user' && state.repoBacked && cleaned.criteria !== undefined && card.kind !== 'milestone') {
      if (hasCriteria(card)) card.localCriteria = { n: card.criteria.length, hash: criteriaHash(card) }; else delete card.localCriteria;
    }
    if (title !== undefined && title.trim() !== card.title) { card.title = title.trim(); changed = true; fields.push('title'); }
    if (note !== undefined && String(note) !== card.note) { card.note = String(note ?? ''); changed = true; fields.push('note'); }
    const from = card.status;
    // A thread's stored stage is set by its run state only: a status it may be sent (its own, or the one it is shown in) is no change.
    if (status !== undefined && !isThread(card) && status !== card.status) {
      if (source === 'claude') gateDone(state, card, cfg, status);   // after the fields above, so criteria set in the same call count
      card.status = status;
      changed = true;
    }
    // a write that can end a line takes the names of the lines that are gone
    if (fields.some((f) => f === 'blocked by' || f === 'milestone' || f === 'kind')) pruneAllLinkNames(state);
    const last = Array.isArray(card.history) ? card.history[card.history.length - 1] : null;
    if (!changed && by && !isThread(card) && !(last && last.worker === by)) {
      // nothing else changed: the call only says who did the work (once, not again for the worker the latest entry already names)
      addHistory(card, source, { type: 'worked' }, now(), by);
    }
    if (changed) {
      const ts = now();
      card.updatedAt = ts;
      if (source === 'user') card.seenByClaude = false;
      else if (card.newInRepo) card.seenByClaude = true;   // Claude changed it, so it has it
      // a thread's own page shows its turns, not this
      if (!isThread(card)) {
        // The card's own record of leaving the finished stages (a finished stage to an unfinished one; Done to Released is no exit):
        // the capped history cannot be trusted to keep the move (see leftDoneAt).
        if (card.status !== from && stageFinished(cfg, from) && !stageFinished(cfg, card.status)) {
          card.leftDoneAt = ts;
          if (state.repoBacked) {
            // this machine's own record, and the approvals it holds from before are over with it
            card.localLeftDoneAt = ts;
            if (isObject(card.approvals)) for (const k of Object.keys(card.approvals)) delete card.approvals[k];
          }
        }
        // this machine saw the card in a finished stage (see fields.watchFinished)
        if (state.repoBacked) watchFinished(card, cfg, ts);
        if (card.status !== from) addHistory(card, source, { type: 'moved', from, to: card.status }, ts, by);
        if (fields.length) addHistory(card, source, { type: 'edited', fields }, ts, by);
      }
    }
    return card;
  });
}

/**
 * Adds or removes one link drawn by hand on the Milestones map: `add` or `remove` is the id of the milestone that milestone `id` depends on. This
 * is what the board's two routes call: one link at a time, read and written under the lock, so two drags never undo each other. It gates nothing.
 * Resolves to the milestone card.
 */
export async function changeMilestoneLink(projectDirArg, id, { add, remove } = {}, { source = 'user' } = {}) {
  const cfg = readConfig(projectDirArg);
  requireTasks(cfg);
  if ((add === undefined) === (remove === undefined)) throw new Error('give the milestone to add or the one to remove, not both');
  const other = add === undefined ? remove : add;
  if (typeof other !== 'string' || !CARD_ID_RE.test(other.trim())) throw new Error('the milestone must be given as a card id like "c4"');
  return updateState(projectDirArg, (state) => {
    const card = milestoneOf(state, id);
    if (!card) throw new Error(`milestone not found: ${id}`);
    const dep = other.trim();
    const cur = liveDependsOn(card, state.cards, state.aliases);
    let next;
    if (add !== undefined) {
      if (cur.includes(dep)) throw new Error(`${msName(card)} already depends on ${dep} by a link drawn by hand`);
      next = [...cur, dep];
      if (next.length > MAX_DEPENDS) throw new Error(`a milestone can have ${MAX_DEPENDS} links of its own at most`);
    } else {
      if (!cur.includes(dep)) throw new Error(`${msName(card)} has no link of its own to ${dep} (a link that comes from cards is changed by editing those cards)`);
      next = cur.filter((x) => x !== dep);
    }
    // a link to a milestone that is gone is dropped by the same write: it is rebuilt from the live ones
    const hadNames = JSON.stringify(card.linkNames ?? {});
    const linked = setDependsOn(state, card, next);
    pruneLinkNames(state, card);
    if (linked || hadNames !== JSON.stringify(card.linkNames ?? {})) {
      const ts = now();
      card.updatedAt = ts;
      if (source === 'user') card.seenByClaude = false;
      addHistory(card, source, { type: 'edited', fields: ['depends on'] }, ts);
    }
    return card;
  });
}

/**
 * Names (or, with an empty `name`, unnames) the line from milestone `link` to milestone `id` (the one `id` waits for): what the board's rename calls.
 * A line is a hand link or a card link. Resolves to the milestone card.
 */
export async function setLinkName(projectDirArg, id, { link, name } = {}, { source = 'user' } = {}) {
  requireTasks(readConfig(projectDirArg));
  if (typeof link !== 'string' || !CARD_ID_RE.test(link.trim())) throw new Error('the line must be given as the card id of the milestone it comes from, like "c4"');
  if (typeof name !== 'string') throw new Error('name must be given: a short text, or an empty string to take the name away');
  const changes = cleanLinkNames({ [link.trim()]: name });
  return updateState(projectDirArg, (state) => {
    const card = milestoneOf(state, id);
    if (!card) throw new Error(`milestone not found: ${id}`);
    if (setLinkNames(state, card, changes)) {
      const ts = now();
      card.updatedAt = ts;
      if (source === 'user') card.seenByClaude = false;
      addHistory(card, source, { type: 'edited', fields: ['link names'] }, ts);
    }
    return card;
  });
}

/**
 * Takes card links off their cards: `pairs` are the [card, blocker] pairs the owner confirmed for the line from milestone `id` to milestone `dep`.
 * All in ONE state update (one lock, and in a project kept in the repo one write that is undone as a whole when a file cannot be written): each
 * pair is taken out of the card's CURRENT blockers (a blocker added meanwhile stays), and a pair that no longer makes the line (the card moved,
 * its blockers changed, a milestone is gone) is skipped, so nothing the owner did not see is removed and nothing throws halfway. The edit is
 * what an edit of the card's Blocked by on the board does: its time, "new from user", the history entry, the watch of the finished stages.
 * Resolves to { removed: [{ card, by }], skipped: n, cards: the cards that changed }.
 */
export async function removeCardLinks(projectDirArg, id, dep, pairs, { source = 'user' } = {}) {
  const cfg = readConfig(projectDirArg);
  requireTasks(cfg);
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('give the [card, blocker] pairs to take off');
  if (pairs.length > 200 || !pairs.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')) throw new Error('the pairs must be lists of a card id and a blocker id, at most 200');
  return updateState(projectDirArg, (state) => {
    if (!milestoneOf(state, id)) throw new Error(`milestone not found: ${id}`);
    const line = milestoneCardLinks(state.cards).find((e) => e.from === id && e.to === dep);
    const live = new Set((line ? line.links : []).map((l) => `${l.card}\n${l.by}`));
    const gone = new Map();
    let skipped = 0;
    for (const [cardId, by] of pairs) {
      if (!live.has(`${cardId}\n${by}`)) { skipped += 1; continue; }
      gone.set(cardId, [...(gone.get(cardId) || []), by]);
    }
    const removed = [];
    const changed = [];
    const ts = now();
    for (const [cardId, list] of gone) {
      const card = state.cards.find((c) => c.id === cardId && c.kind !== 'milestone');
      if (!card) { skipped += list.length; continue; }
      pinLeftDone(state, card, cfg);
      const kept = (card.blockedBy || []).filter((x) => !list.includes(x));
      if (kept.length === (card.blockedBy || []).length) { skipped += list.length; continue; }
      if (kept.length) card.blockedBy = kept; else delete card.blockedBy;
      card.updatedAt = ts;
      if (source === 'user') card.seenByClaude = false;
      if (!isThread(card)) {
        if (state.repoBacked) watchFinished(card, cfg, ts);
        addHistory(card, source, { type: 'edited', fields: ['blocked by'] }, ts);
      }
      for (const by of list) removed.push({ card: cardId, by });
      changed.push(card);
    }
    if (removed.length) pruneAllLinkNames(state);
    return { removed, skipped, cards: [...changed, milestoneOf(state, id)] };
  });
}

/**
 * Removes one card. In a repo-backed project a thread on this machine and a card from the repo can share an id (a card from another device
 * that took a free thread number, or a file named by hand): both are shown, and the card tools take the card. Only the card that is found is
 * removed, never the other; the board's delete cannot tell which one the owner means, so it is refused then. A thread that was started from
 * a repo card stands for it (the card is hidden behind it), so that id is not shared. Removing such a thread removes the card's file too,
 * unless the file changed since the thread was started: then the file stays, and the result says so.
 * Resolves true, or { keptFile: true } when the card's file was kept.
 */
export async function removeCard(projectDirArg, id, { source = 'claude' } = {}) {
  const cfg = readConfig(projectDirArg);
  const { removed, shared, keptFile } = await updateState(projectDirArg, (state) => {
    const card = findCard(state, id, source === 'claude');
    if (!isThread(card)) requireTasks(cfg);
    const shared = state.cards.some((c) => c !== card && c.id === card.id);
    if (shared && source === 'user') {
      throw new Error(`${card.id} is the id of a thread on this machine and of a card from the repo: the board cannot tell which of the two to delete. End and remove the thread with Claude's thread tools, or ask Claude to remove the card (board_remove takes the card), or delete the card's file in the repo.`);
    }
    // Removing a card with acceptance criteria that is neither done nor approved would also remove the owner's test of it.
    // A thread can carry them too: 0.11.0 turned cards into threads without checking.
    if (source === 'claude' && gatedByCriteria(card) && !isFinished(card, cfg) && !reviewApproved(card, finishedStageIds(cfg))) {
      throw new Error(`${card.id} has acceptance criteria and is not done or approved, so only the owner can remove it, on the board.`);
    }
    // the thread of that id, not the card the lookup preferred
    const th = isThread(card) ? card : threadById(state.cards, card.id);
    if (th && th.thread.runState === 'running' && isAlive(th.thread.pid)) {
      throw new Error(`thread ${card.id} is still running; end it before removing the card`);
    }
    let keptFile = false;
    if (state.repoBacked && isThread(card) && card.fromRepo === card.id && state.base.shadowed.has(card.id)) {
      const now = state.base.snap.get(card.id);
      const rec = state.repo && state.repo.overlay && state.repo.overlay[card.id];
      // the file as it was when the thread was started; a thread with no record of it leaves the file alone
      if (now && !(isObject(rec) && rec.startedHash === now.hash)) { state.base.keepFiles.add(card.id); keptFile = true; }
    }
    // The cards under a milestone stay, without a parent (a thread is a card of this machine: it keeps what it has).
    if (card.kind === 'milestone') {
      for (const c of state.cards) if (c.parent === card.id && !isThread(c)) delete c.parent;
      // and the links drawn to it by hand
      const ts = now();
      for (const c of state.cards) if (c.kind === 'milestone' && Array.isArray(c.dependsOn) && c.dependsOn.some((x) => x === card.id || (state.aliases && state.aliases.get(x) === card.id))) {
        c.dependsOn = c.dependsOn.filter((x) => x !== card.id && !(state.aliases && state.aliases.get(x) === card.id));
        if (!c.dependsOn.length) delete c.dependsOn;
        c.updatedAt = ts;
      }
    }
    state.cards = state.cards.filter((c) => c !== card);
    pruneAllLinkNames(state);
    return { removed: card.id, shared, keptFile };
  });
  // Logs and activity files would otherwise outlive the card; a thread that has this id keeps its own. Best effort. The dot
  // keeps c1 from matching the files of c10.
  if (!shared) {
    const { logs } = projectPaths(projectDirArg);
    try {
      for (const name of await readdir(logs)) {
        if (name.startsWith(`${removed}.`)) await rm(join(logs, name), { recursive: true, force: true });
      }
    } catch { /* no logs folder, or a file that cannot be removed */ }
    await sweepOrphanLogs(projectDirArg).catch(() => {});
  }
  return keptFile ? { keptFile: true } : true;
}

// Log files and folders of cards that are no longer in the state: an older plugin version deletes a card without a lane thread's folders, and a
// card of a repo-backed project is removed by a git pull, which this plugin does not see. Entries named c<digits>.<anything> whose card id is not
// in the state are removed; in a repo-backed project so are those named by a random id (c8k2x1.<anything>), but only when the id is in no card
// file, no card of this machine's stores and no copy record, and the entry is a week old (a card can be on another branch). All under the state
// lock; a symlink is removed itself, never followed.
const CARD_LOG_RE = /^(c[0-9]+)\./;
const ANY_CARD_LOG_RE = new RegExp(`^(${CARD_ID_SRC})\\.`);
export const ORPHAN_LOG_MIN_AGE_MS = 7 * 24 * 3600 * 1000;
export async function sweepOrphanLogs(projectDirArg) {
  const { logs, state: stateFile } = projectPaths(projectDirArg);
  if (!existsSync(logs) || !existsSync(stateFile)) return 0;   // no state: nothing says which logs are orphans
  return withLock(projectDirArg, async () => {
    if (!existsSync(stateFile)) return 0;   // gone since the check above: readState would report no cards
    const state = readState(projectDirArg);
    const backed = !!state.repoBacked;
    // the ids of cards in files that could not be read, and of an older version's cards, still have their logs
    const ids = new Set([...state.cards.map((c) => c.id), ...(state.takenIds || [])]);
    if (backed && state.aliases) for (const id of state.aliases.values()) ids.add(id);
    let n = 0;
    for (const name of await readdir(logs)) {
      const m = (backed ? ANY_CARD_LOG_RE : CARD_LOG_RE).exec(name);
      if (!m || ids.has(m[1])) continue;
      if (!/^c[0-9]+$/.test(m[1])) {
        let age = 0;
        try { age = Date.now() - lstatSync(join(logs, name)).mtimeMs; } catch { continue; }
        if (age < ORPHAN_LOG_MIN_AGE_MS) continue;
      }
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
      // a card from a pull that this machine has not listed yet is listed (and marked `newInRepo` in the copy that is returned)
      if (card.seenByClaude === false || card.newInRepo === true) {
        unseen.push({ ...JSON.parse(JSON.stringify(card)), ...(card.newInRepo === true ? { newInRepo: true } : {}) });
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

// The sub-agent called `name`, or an Error that lists the ones there are.
export function requireAgent(projectDirArg, name) {
  const known = listAgents(projectDirArg).map((a) => a.name);
  if (!known.includes(name)) {
    throw new Error(`Unknown agent "${clip(name, 60)}". ${known.length ? `Available: ${known.join(', ')}.` : 'No agents are defined in .claude/agents.'}`);
  }
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

// projectDirArg (the folder the thread runs in) is given by the runner. Without it, or with the codeMap setting off (the default), there is no code map note.
export function buildPrompt(card, projectDirArg) {
  const t = card.thread;
  const turn = t.turns[t.turns.length - 1];
  const text = turn ? turn.prompt : '';
  // A lane's read-only turn runs in the provider's plan or read-only mode: say what that asks of the answer.
  const laneRead = t.lane != null && t.mode !== 'write' ? [LANE_READ_NOTE] : [];
  if (!t.sessionId && !(t.lane && t.lane.session)) {
    const brief = threadContext(t) === 'brief';
    const mapNote = projectDirArg && readConfig(projectDirArg).codeMap ? codeMapNote(projectDirArg) : '';
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
      ...(mapNote ? [mapNote] : []),
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
    child = spawn(process.execPath, [RUNNER_PATH, projectDirArg, card.id, card.thread.store || storeKey(projectDirArg)], {
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
      const c = threadById(state.cards, card.id);
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
  if (name) requireAgent(projectDirArg, name);
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
    // the store the thread lives in: its runner keeps working there if the folder's board moves into the repo meanwhile (see state.pinStore)
    store: storeKey(projectDirArg),
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
  const parentId0 = cleanParent(parent);
  return updateState(projectDirArg, (state) => {
    const parentId = claudeId(state, parentId0);
    if (parentId) checkParent(state, parentId, 'thread');
    const ts = now();
    const card = {
      id: nextCardId(state, { thread: true }),
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
  const has = [gatedByCriteria(card) ? 'acceptance criteria' : '', liveBlockers(card, cards).length ? 'a Blocked by list' : ''].filter(Boolean);
  if (has.length) throw new Error(`A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first (${card.id} has ${has.join(' and ')}).`);
}

// The page showed one worker (a lane or a sub-agent) and the card has another by now. The board maps it to HTTP 409.
export class StaleCardError extends Error {
  constructor(message) { super(message); this.status = 409; }
}

// What a card runs as when it is started: its lane, else its agent (a card file written by hand or by an older version can hold both: the lane
// wins, as the page shows it), else neither. Only a task or an idea has one. Always strings, '' for none.
function cardWorker(card) {
  if (!card || card.kind === 'thread' || card.kind === 'milestone') return { lane: '', agent: '' };
  const lane = typeof card.lane === 'string' ? card.lane : '';
  return { lane, agent: !lane && typeof card.agent === 'string' ? card.agent : '' };
}

// Turns a task or idea card into a thread in place: same id, title, note and source.
// Nobody writes a brief on the board, so in brief mode the card's note is the brief.
// A card that has a lane or an agent runs on it; they are read from the card, never from the caller (`agent` only stands in when the card has neither, and a different one is refused as stale).
// `expectLane` and `expectAgent` are what the caller was shown ('' for none): the start is refused when the card's worker is another. Left out, nothing is checked.
export async function startThreadFromCard(projectDirArg, cardId, { sessionId, mode = 'read', extraDirs, context, agent, expectLane, expectAgent } = {}) {
  refuseInsideThread('start');
  requireTasks(readConfig(projectDirArg));
  const existing = cardById(readState(projectDirArg).cards, cardId);
  if (existing && existing.kind !== 'thread' && existing.kind !== 'milestone') refuseThreadFields(existing, readState(projectDirArg).cards);
  const worker = cardWorker(existing);
  if ((expectLane !== undefined && expectLane !== worker.lane) || (expectAgent !== undefined && expectAgent !== worker.agent)) {
    throw new StaleCardError('the card\'s worker (lane or agent) changed since you looked at it; look at it again and then start it');
  }
  // an agent in the request is what the caller means to run: it must be the card's (a 0.16.0 page names it; the card is what it was shown)
  const asked = typeof agent === 'string' ? agent.trim() : '';
  if (asked && worker.agent && asked !== worker.agent) throw new StaleCardError('the card\'s agent is not the one in the request; look at the card again and then start it');
  const opts = await launchOptions(projectDirArg, { sessionId, mode, extraDirs, context, brief: existing && existing.note, agent: worker.agent || agent, lane: worker.lane });
  return updateState(projectDirArg, (state) => {
    const card = findCard(state, cardId);
    if (card.kind === 'thread') throw new Error(`card ${cardId} is already a thread`);
    if (card.kind === 'milestone') throw new Error(`card ${cardId} is a milestone and cannot be started as a thread`);
    const now = cardWorker(card);
    if (now.lane !== worker.lane || now.agent !== worker.agent) throw new Error(`card ${cardId} changed while it was starting; try again`);
    refuseThreadFields(card, state.cards);
    const text = typeof card.note === 'string' ? card.note.trim() : '';
    // A card from a file in the repo: the thread stands for it on this machine, hides it, and only it may delete the file when it is removed.
    if (state.repoBacked && state.base.shared.has(card.id)) {
      card.fromRepo = card.id;
      card.fromRepoHash = (state.base.snap.get(card.id) || {}).hash;   // the file as it is now; commitState moves it into the overlay
    }
    card.kind = 'thread';
    // In brief mode the note already travels as the brief, so the task is the title alone.
    const prompt = text && opts.context === 'full' ? `${card.title}\n\n${text}` : card.title;
    beginThread(projectDirArg, card, { sessionId, mode, prompt, ...opts });
    delete card.lane;   // the thread holds them now
    delete card.agent;
    return card;
  });
}

export async function continueThread(projectDirArg, id, message, { sessionId } = {}) {
  refuseInsideThread('continue');
  const m = typeof message === 'string' ? message.trim() : '';
  if (!m) throw new Error('message must not be empty');
  // A lane thread is checked against the lanes as they are now, before the lock is taken (loading them can take seconds).
  let fresh = null;
  const before = threadById(readState(projectDirArg).cards, id);
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
  return readLocalState(projectDirArg).cards.filter((c) => {
    const th = isThread(c) && c.thread;
    return th && th.reportRequestedAt && th.lastResult != null && !th.reported && sameSession(th.parentSessionId, sessionId);
  });
}

// Finished threads with a result nobody has pulled yet, split by whether the
// given session started them.
export async function pickReportable(projectDirArg, sessionId) {
  const state = readLocalState(projectDirArg);
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

/**
 * A repo-backed project's first write makes the one-time copy of this machine's cards (and finishes one that was interrupted). This makes it
 * when there is nothing else to write: a no-op update. Does nothing for a project that is not repo-backed, or whose copy is done.
 */
export async function startRepo(projectDirArg) {
  const root = storePinned() ? null : repoRootOf(projectDirArg);
  if (!root) return;
  const mark = readRepoMark(root);
  if (typeof mark.importedAt !== 'string' || mark.copy) await updateState(projectDirArg, () => {});
}

// Threads whose runner is gone are marked failed; this only touches the local state. Returns the project's state (with the repo's cards).
export async function reconcile(projectDirArg) {
  await startRepo(projectDirArg);
  await updateLocalState(projectDirArg, (state) => {
    for (const card of state.cards) {
      if (!isThread(card)) continue;
      if (card.thread.runState === 'running' && !runnerAlive(projectDirArg, card)) {
        markFailed(projectDirArg, card, 'runner exited without a result');
      }
    }
  });
  return readState(projectDirArg);
}

export async function pendingAnnouncements(projectDirArg, sessionId) {
  return updateLocalState(projectDirArg, (state) => {
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
