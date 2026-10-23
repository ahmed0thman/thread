// The optional project-management fields of a task or idea card (type, priority, labels, blockedBy, criteria), who did
// the work on a card (the `worker` of a history entry), and whether a card's acceptance criteria have been approved.
// Pure checks (and the history writer): nothing here reads or writes the state file. A field is stored only when it differs
// from its default, and an older plugin version ignores all of them and keeps them. Imports only node:crypto.
import { createHash } from 'node:crypto';

export const TYPES = ['task', 'bug'];
export const PRIORITIES = ['high', 'normal', 'low'];
export const MAX_LABELS = 8;
export const MAX_LABEL = 24;
export const MAX_BLOCKERS = 10;
export const MAX_DEPENDS = 20;
export const MAX_LINK_NAME = 40;
export const MAX_CRITERIA = 10;
export const MAX_CRITERION = 200;
export const MAX_WORKER = 64;
export const FIELD_NAMES = ['type', 'priority', 'labels', 'blockedBy', 'criteria'];

// A card id: `c` and lowercase letters and digits, with at least one digit. Cards of a project that keeps its board on the machine are
// c1, c2, ... (the digit is the count); cards of a repo-backed project get a random one such as c8k2x1 (see repo.mjs), so two
// devices never hand out the same id. The digit keeps an id apart from the words of the board's addresses and of the log files.
export const CARD_ID_SRC = 'c(?=[a-z]*[0-9])[0-9a-z]+';
export const CARD_ID_RE = new RegExp(`^${CARD_ID_SRC}$`);
const WORKER_RE = new RegExp(`^(?:main|agent:[A-Za-z0-9][A-Za-z0-9:_.-]*|thread:${CARD_ID_SRC}|lane:[A-Za-z0-9][A-Za-z0-9._-]*)$`);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const sha16 = (text) => createHash('sha1').update(text).digest('hex').slice(0, 16);
// JSON with the keys of every object in order, so the same value is always the same text.
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'null');

/** A short fingerprint of a waiting item's answer (the answer and the comment): a repo-backed project records it for an answer given on this machine's board. */
export const answerHash = (item) => sha16(canonical({ answer: item && item.answer, comment: item && item.comment }));

/** A short fingerprint of a waiting item as it was asked (when and what): the record of who asked it is for that question, not for a later one with the same id. */
export const askFingerprint = (item) => sha16(`${item && item.askedAt}\n${item && item.text}`);

/** A short fingerprint of a card's acceptance criteria: an approval recorded on this machine is for the criteria it was given for. */
export const criteriaHash = (card) => sha16(JSON.stringify(Array.isArray(card && card.criteria) ? card.criteria : []));

/** A short fingerprint of what a worker is told to do for a task or idea: its title and note. Full access is allowed for that text (see fullAllowed). */
export const contentHash = (card) => sha16(JSON.stringify([card && card.title, card && card.note]));

/**
 * Whether the user's full-access switch counts for `card`: `allowFull` is true and, for a task or idea, the title and note are still the ones it was
 * allowed for (`allowFullHash`, kept on this machine only, set by the board when the user allows it). A collaborator's push or Claude editing the note
 * after that makes it need the user's yes again. A thread card (one started from a card) has no such binding: its task was fixed when it started.
 */
export const fullAllowed = (card) => !!card && card.allowFull === true && (card.kind === 'thread' || card.allowFullHash === contentHash(card));

/**
 * The card with this id. Two cards can have one id in a repo-backed project (a repo card and an unrelated thread on this machine, see
 * repo.mjs mergeState): this takes the card that is not a thread, else the thread. `threadById` takes the thread.
 */
export function cardById(cards, id) {
  let found;
  for (const c of cards) if (c && c.id === id) { if (c.kind !== 'thread') return c; found = found ?? c; }
  return found;
}
export const threadById = (cards, id) => cards.find((c) => c && c.id === id && c.kind === 'thread' && c.thread);
/**
 * The card a call from Claude means by `id` (board_update, board_remove, wait_add, wait_close, wait_list, a parent or blocker, a [cN] run
 * marker). A card that was copied into the repo under a new id is also named by the id it had before (`state.aliases`, old id -> id now).
 * When the id is such an old id, a thread on this machine with that id wins (an older plugin version turned its own copy of the card into a
 * thread in place, so that id is the thread now), unless the thread stands for a card file of that id (`fromRepo`). When the old id is also
 * the id of a card file that was pushed under it (or of a thread that stands for one) while the card it was copied to is still there, the id
 * names two cards and it throws (oldIdClash): it never guesses, and the card file stays reachable from the board only. With no alias the id
 * names the card that has it (cardById). The board's own routes do not use this: they take the card that has the id the board shows.
 */
export function claudeCard(state, id) {
  if (!(state.aliases && state.aliases.has(id))) return cardById(state.cards, id);
  const thread = threadById(state.cards, id);
  if (thread && !thread.fromRepo) return thread;
  const target = cardById(state.cards, state.aliases.get(id));
  const other = state.cards.find((c) => c && c.id === id && c !== target);
  if (target && other) {
    throw new Error(`${id} names two cards: the card that was copied to ${target.id} and a card file ${id}.json that is in the repo now. Use ${target.id} for the copied card; the card file ${id}.json can only be changed on the board.`);
  }
  return target ?? thread;
}

/**
 * The id a card was copied to when this card has the old id of that copy (a card file pushed under it, or a thread that stands for one) and
 * the copy is still there: the two share the id as far as Claude's calls go (claudeCard refuses it). undefined for any other card.
 */
export function oldIdClash(state, card) {
  if (!card || !state.aliases || !state.aliases.has(card.id) || (card.kind === 'thread' && !card.fromRepo)) return undefined;
  const target = cardById(state.cards, state.aliases.get(card.id));
  return target && target !== card ? target.id : undefined;
}
// "no value": the field is removed
const isEmpty = (v) => v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

// Every cleaner returns undefined (not given), null (given empty, or equal to the default: the field is removed) or the value to store.
function cleanChoice(v, what, allowed, fallback) {
  if (v === undefined) return undefined;
  if (isEmpty(v)) return null;
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!allowed.includes(t)) throw new Error(`${what} must be one of: ${allowed.join(', ')}`);
  return t === fallback ? null : t;
}
export const cleanType = (v) => cleanChoice(v, 'type', TYPES, 'task');
export const cleanPriority = (v) => cleanChoice(v, 'priority', PRIORITIES, 'normal');

function cleanList(v, what, max) {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`);
  if (v.length > max) throw new Error(`${what} has too many entries (${v.length}, the limit is ${max})`);
  return v;
}

export function cleanLabels(v) {
  if (v === undefined) return undefined;
  if (isEmpty(v)) return null;
  const out = [];
  for (const x of cleanList(v, 'labels', MAX_LABELS)) {
    const t = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (!t || t.length > MAX_LABEL) throw new Error(`each label must be 1 to ${MAX_LABEL} characters`);
    if (out.includes(t)) throw new Error(`the label "${t}" is given twice`);
    out.push(t);
  }
  return out;
}

// The shape only; that the cards exist is checked against the state (checkBlockers in core.mjs).
export function cleanBlockedBy(v) {
  if (v === undefined) return undefined;
  if (isEmpty(v)) return null;
  const out = [];
  for (const x of cleanList(v, 'blocked_by', MAX_BLOCKERS)) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (!CARD_ID_RE.test(t)) throw new Error(`blocked_by takes card ids like "c4" or "c8k2x1", not "${String(x).slice(0, 40)}"`);
    if (out.includes(t)) throw new Error(`${t} is given twice in blocked_by`);
    out.push(t);
  }
  return out;
}

// A milestone's links drawn by hand on the Milestones map (`dependsOn`: the milestones it waits for). The shape only; that the milestones
// exist and that the links make no loop is checked against the state (checkDependsOn in core.mjs). It is not one of FIELD_NAMES: it belongs
// to a milestone alone and has routes of its own on the board. An older plugin version ignores the field and keeps it.
export function cleanDependsOn(v) {
  if (v === undefined) return undefined;
  if (isEmpty(v)) return null;
  const out = [];
  for (const x of cleanList(v, 'depends_on', MAX_DEPENDS)) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (!CARD_ID_RE.test(t)) throw new Error(`depends_on takes milestone card ids like "c4" or "c8k2x1", not "${String(x).slice(0, 40)}"`);
    if (out.includes(t)) throw new Error(`${t} is given twice in depends_on`);
    out.push(t);
  }
  return out;
}

// The short names a milestone gives the lines on the Milestones map that run to the milestones it waits for (`linkNames`: { <the milestone the
// line comes from>: "text" }). The shape only; that the milestone is one and that a line runs to it is checked against the state (setLinkNames in
// core.mjs). An empty text (or null) takes a name away. Not one of FIELD_NAMES, like dependsOn. An older plugin version ignores it and keeps it.
export function cleanLinkNames(v) {
  if (v === undefined) return undefined;
  if (v === null) return {};
  if (!isObject(v)) throw new Error('link_names must be an object of milestone ids and short names');
  const keys = Object.keys(v);
  if (keys.length > MAX_DEPENDS) throw new Error(`link_names has too many entries (${keys.length}, the limit is ${MAX_DEPENDS})`);
  const out = {};
  for (const k of keys) {
    const id = k.trim();
    if (!CARD_ID_RE.test(id)) throw new Error(`link_names takes milestone card ids like "c4" as keys, not "${k.slice(0, 40)}"`);
    const x = v[k];
    if (x === null || x === undefined || (typeof x === 'string' && !x.trim())) { out[id] = null; continue; }
    const t = typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '';
    if (!t || t.length > MAX_LINK_NAME || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(typeof x === 'string' ? x.trim() : '')) {
      throw new Error(`a link name must be 1 to ${MAX_LINK_NAME} characters on one line, not "${String(x).slice(0, 40)}"`);
    }
    out[id] = t;
  }
  return out;
}

export function cleanCriteria(v) {
  if (v === undefined) return undefined;
  if (isEmpty(v)) return null;
  const out = [];
  for (const x of cleanList(v, 'criteria', MAX_CRITERIA)) {
    const t = typeof x === 'string' ? x.trim() : '';
    if (!t || t.length > MAX_CRITERION) throw new Error(`each criterion must be 1 to ${MAX_CRITERION} characters`);
    if (/[\r\n]/.test(t)) throw new Error('a criterion must be one line: it cannot contain a line break (give each line as its own criterion)');
    out.push(t);
  }
  return out;
}

/** The five fields of a call, cleaned. */
export function cleanFields(input = {}) {
  return {
    type: cleanType(input.type),
    priority: cleanPriority(input.priority),
    labels: cleanLabels(input.labels),
    blockedBy: cleanBlockedBy(input.blockedBy),
    criteria: cleanCriteria(input.criteria),
  };
}

// ---------------------------------------------------------------- who did the work

export const isWorker = (w) => typeof w === 'string' && w.length <= MAX_WORKER && WORKER_RE.test(w);

/** A history entry's worker: 'main', 'agent:<type>', 'thread:<id>' or 'lane:<name>'. undefined when not given. */
export function cleanWorker(w) {
  if (w === undefined || w === null || (typeof w === 'string' && !w.trim())) return undefined;
  const t = typeof w === 'string' ? w.trim() : '';
  if (!isWorker(t)) throw new Error(`worker must be "main", "agent:<type>", "thread:<card id>" or "lane:<name>" (at most ${MAX_WORKER} characters), not "${String(w).slice(0, 40)}"`);
  return t;
}

/**
 * Who worked on a card, each once, in the order they first appear: the history's workers, the sub-agents that ran on it,
 * and for a thread card its agent or lane. Derived on each read, never stored.
 */
export function workedBy(card) {
  if (!isObject(card)) return [];
  const seen = [];   // [{ worker, at }]
  const add = (worker, at) => { if (isWorker(worker)) seen.push({ worker, at: Date.parse(at) }); };
  // A name taken from a run or a thread is not checked as strictly as one a caller sent: a run keeps an agent type cut at 60
  // characters with "…", which would not fit here, so the "…" goes and the name is cut to fit instead of being dropped.
  const derived = (prefix, name) => `${prefix}${name.replace(/…$/, '').slice(0, MAX_WORKER - prefix.length)}`;
  if (isObject(card.thread)) {
    const th = card.thread;
    if (typeof th.agent === 'string' && th.agent) add(derived('agent:', th.agent), card.createdAt);
    else if (isObject(th.lane) && typeof th.lane.name === 'string') add(derived('lane:', th.lane.name), card.createdAt);
  }
  if (Array.isArray(card.history)) for (const h of card.history) if (isObject(h)) add(h.worker, h.at);
  // A run of a thread that does the card's work (runs.openLinkedRun) is named as the thread card is: its agent, else its lane, else the thread
  // itself (its agentType is the agent, else the lane, else 'thread'). A sub-agent run is named after its agent type.
  if (Array.isArray(card.runs)) {
    for (const r of card.runs) {
      if (!isObject(r)) continue;
      const type = typeof r.agentType === 'string' ? r.agentType : '';
      if (typeof r.thread === 'string' && CARD_ID_RE.test(r.thread)) {
        if (typeof r.lane === 'string' && r.lane) add(derived('lane:', r.lane), r.startedAt);
        else if (type && type !== 'thread') add(derived('agent:', type), r.startedAt);
        else add(`thread:${r.thread}`, r.startedAt);
      } else if (type) add(derived('agent:', type), r.startedAt);
    }
  }
  // by time; an entry without a usable time goes after the dated ones, and ties keep the order above
  const key = (x) => (Number.isFinite(x.at) ? x.at : Infinity);
  const out = [];
  for (const x of seen.map((s, i) => ({ ...s, i })).sort((a, b) => (key(a) === key(b) ? a.i - b.i : key(a) < key(b) ? -1 : 1))) {
    if (!out.includes(x.worker)) out.push(x.worker);
  }
  return out;
}

// ---------------------------------------------------------------- the done gate (reviewApproved is in waits.mjs)

/**
 * The ids of the task board's finished stages: its done stage and every stage after it, in stage order. [] when the done role
 * names no stage. `cfg` is the effective config (taskStages and taskRoles).
 */
export function finishedStageIds(cfg) {
  const stages = cfg && Array.isArray(cfg.taskStages) ? cfg.taskStages : [];
  const at = stages.findIndex((s) => s && cfg.taskRoles && s.id === cfg.taskRoles.done);
  return at < 0 ? [] : stages.slice(at).map((s) => s.id);
}

// A time read from a repo file is believed only up to now (plus a little for clocks that differ): a file can say what it likes, and a date
// far ahead would otherwise sit above every later exit and review. NaN for what is not a time, or is later than now + 5 minutes.
export const FUTURE_SLACK_MS = 5 * 60 * 1000;
export function fileTime(iso) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t <= Date.now() + FUTURE_SLACK_MS ? t : NaN;
}

/**
 * When the card last left the finished range (a finished stage to an unfinished one), in ms: the later of the card's own
 * `leftDoneAt` (written whenever a card moves out of the range, so the capped history cannot lose it) and the latest `moved`
 * entry of its history that went from a finished stage to one that is not (a move an older plugin version made leaves no
 * field). `finished` is the list of finished stage ids (finishedStageIds), or one id. A move between two finished stages
 * (Done to Released) is no exit. An older version wrote `leftDoneAt` for any move out of the done stage, Done to Released
 * included; that is read as it stands, so such a card needs a new approval: stricter, never looser.
 * -Infinity when there is neither (never reopened), so every review counts.
 * A card of a project kept in the repo (`card.approvals` is an object) is read with fileTime: a time in the file that is later than now
 * (+ 5 minutes) is no exit at all, so a pushed date far ahead cannot lock the card.
 */
export function leftDoneAt(card, finished) {
  let at = -Infinity;
  const range = Array.isArray(finished) ? finished : typeof finished === 'string' ? [finished] : null;
  if (!card || !range || !range.length) return at;
  const repo = isObject(card.approvals);
  const time = (v) => (repo ? fileTime(v) : typeof v === 'string' ? Date.parse(v) : NaN);
  const stored = time(card.leftDoneAt);
  if (Number.isFinite(stored)) at = stored;
  // a card of a project kept in the repo also has this machine's own record (`localLeftDoneAt`, in the overlay): a pushed file that drops
  // `leftDoneAt` and the moves from its history cannot make an old approval count again
  const local = typeof card.localLeftDoneAt === 'string' ? Date.parse(card.localLeftDoneAt) : NaN;
  if (Number.isFinite(local) && local > at) at = local;
  if (!Array.isArray(card.history)) return at;
  for (const h of card.history) {
    if (!isObject(h) || h.type !== 'moved' || !range.includes(h.from) || range.includes(h.to)) continue;
    const t = time(h.at);
    if (Number.isFinite(t) && t > at) at = t;
  }
  return at;
}

/**
 * True while this machine has seen a repo card in the finished stages (`localDoneAt`) and has not seen it leave them since
 * (`localLeftDoneAt`, which a write sets when it notices an exit). A card that is unfinished while this is true was reopened by a pull
 * whose file may have dropped every trace of it.
 */
export function doneSpellOpen(card) {
  const done = typeof card.localDoneAt === 'string' ? Date.parse(card.localDoneAt) : NaN;
  const left = typeof card.localLeftDoneAt === 'string' ? Date.parse(card.localLeftDoneAt) : NaN;
  return Number.isFinite(done) && !(Number.isFinite(left) && done <= left);
}

/**
 * This machine's own watch on a repo card's finished stages, run inside a write (`at` is the time of the write, an ISO string): the
 * card in a finished stage starts a spell (`localDoneAt`); the card out of them while a spell is open has left them unseen (a pull
 * reopened it), so the exit is pinned at `at` (`localLeftDoneAt`) and the approvals given before are over. True when it pinned an exit.
 * Does nothing to a card that is not a repo task or idea (no `approvals` object).
 */
export function watchFinished(card, cfg, at) {
  if (!card || card.kind === 'thread' || card.kind === 'milestone' || !isObject(card.approvals)) return false;
  const finished = finishedStageIds(cfg);
  if (!finished.length) return false;
  const stages = Array.isArray(cfg.taskStages) ? cfg.taskStages : [];
  const status = stages.some((s) => s && s.id === card.status) ? card.status : cfg.taskRoles.start;
  const now = Date.parse(at);
  const open = doneSpellOpen(card);
  if (finished.includes(status)) {
    if (!open) {
      const left = typeof card.localLeftDoneAt === 'string' ? Date.parse(card.localLeftDoneAt) : NaN;
      card.localDoneAt = new Date(Number.isFinite(left) && left >= now ? left + 1 : now).toISOString();
    }
    return false;
  }
  if (!open) return false;
  card.localLeftDoneAt = new Date(Math.max(now, Date.parse(card.localDoneAt))).toISOString();
  for (const k of Object.keys(card.approvals)) delete card.approvals[k];
  return true;
}

/**
 * The watch (watchFinished) and then this machine's own pin of the card's latest exit from the finished stages (`localLeftDoneAt`), run inside
 * a write at `at` (an ISO string), for a card of a project kept in the repo: the exit as the card now shows it, with a time that the file has
 * up to 5 minutes ahead of this clock (fileTime) pinned as `at` (this machine's clock says when it saw the exit). A file that is replaced
 * later cannot drop the exit then. Does nothing to a card that is not a repo task or idea.
 */
export function pinLeftDone(card, cfg, at) {
  if (!card || card.kind === 'thread' || card.kind === 'milestone' || !isObject(card.approvals)) return;
  watchFinished(card, cfg, at);
  const exit = Math.min(leftDoneAt(card, finishedStageIds(cfg)), Date.parse(at));
  if (!Number.isFinite(exit)) return;
  if (typeof card.localLeftDoneAt !== 'string' || Date.parse(card.localLeftDoneAt) < exit) card.localLeftDoneAt = new Date(exit).toISOString();
}

/** True when the card has acceptance criteria. */
export const hasCriteria = (card) => !!card && Array.isArray(card.criteria) && card.criteria.length > 0;

/**
 * True when the criteria of a card of a project kept in the repo are fewer than this machine's own record of them (`localCriteria`, in the
 * overlay: how many there were the last time the owner's board had them): a pushed file dropped or cut them. The gate still counts the
 * card as having criteria until the owner changes them on this board, which updates the record.
 */
export const criteriaCut = (card) => !!card && isObject(card.approvals) && isObject(card.localCriteria) && card.localCriteria.n > (hasCriteria(card) ? card.criteria.length : 0);

/** True when the card is held to the done gate: it has acceptance criteria, or this machine's record says it had more (criteriaCut). */
export const gatedByCriteria = (card) => hasCriteria(card) || criteriaCut(card);

/**
 * The milestones a milestone depends on by hand (`dependsOn`) that still exist, in the order stored: a milestone that was removed since, or an id
 * that is not a milestone, or the milestone itself, is left out. `cards` are the project's cards. `aliases` (old id -> id now, state.aliases of a
 * project kept in the repo) also reads an id the one-time copy changed: an older plugin version does the copy without knowing this field, so its
 * card files still hold the old ids; the next write of the links stores the new ones.
 */
export function liveDependsOn(card, cards, aliases) {
  if (!card || card.kind !== 'milestone' || !Array.isArray(card.dependsOn)) return [];
  const isMs = (id) => cards.some((c) => c && c.id === id && c.kind === 'milestone');
  const out = [];
  for (const raw of card.dependsOn) {
    if (typeof raw !== 'string') continue;
    const id = !isMs(raw) && aliases && aliases.has(raw) ? aliases.get(raw) : raw;
    if (id === card.id || out.includes(id) || !isMs(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * The lines the cards make between milestones: [{ from, to, links: [{ card, by }] }], `from` the milestone that waits (a card in it is blocked
 * by a card in `to`). Ideas and milestones do not count, a link inside one milestone is none, and a stored blocker that is a milestone reads as
 * that milestone. The same rule as the Milestones map's (milestoneDeps in the board page).
 */
export function milestoneCardLinks(cards) {
  const ms = new Set(cards.filter((c) => c && c.kind === 'milestone').map((c) => c.id));
  const home = new Map([...ms].map((id) => [id, id]));
  const counted = (c) => c && c.kind !== 'milestone' && c.kind !== 'idea' && ms.has(c.parent);
  for (const c of cards) if (counted(c)) home.set(c.id, c.parent);
  const edges = new Map();
  for (const c of cards) {
    if (!counted(c) || !Array.isArray(c.blockedBy)) continue;
    for (const b of new Set(c.blockedBy.filter((x) => typeof x === 'string'))) {
      const to = home.get(b);
      if (!to || to === c.parent) continue;
      const k = `${c.parent}>${to}`;
      if (!edges.has(k)) edges.set(k, { from: c.parent, to, links: [] });
      edges.get(k).links.push({ card: c.id, by: b });
    }
  }
  return [...edges.values()];
}

/**
 * The names of a milestone's lines that still have a line: { <id of the milestone it depends on>: "text" }. A name is kept while a hand link
 * (`dependsOn`) or a card link runs between the two. `aliases` (state.aliases) reads an id the one-time copy changed, as liveDependsOn does.
 */
export function liveLinkNames(card, cards, aliases) {
  if (!card || card.kind !== 'milestone' || !isObject(card.linkNames)) return {};
  const isMs = (id) => cards.some((c) => c && c.id === id && c.kind === 'milestone');
  const hand = new Set(liveDependsOn(card, cards, aliases));
  const fromCards = new Set(milestoneCardLinks(cards).filter((e) => e.from === card.id).map((e) => e.to));
  const out = {};
  for (const [raw, text] of Object.entries(card.linkNames)) {
    const id = !isMs(raw) && aliases && aliases.has(raw) ? aliases.get(raw) : raw;
    // a name from a file is read as one line of plain text: control characters and line breaks become spaces
    const clean = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!clean || id === card.id || id in out || !isMs(id) || !(hand.has(id) || fromCards.has(id))) continue;
    out[id] = Array.from(clean).slice(0, MAX_LINK_NAME).join('');
  }
  return out;
}

/** The ids of the cards a card is blocked by that still exist, finished or not. `cards` are the project's cards. */
export function liveBlockers(card, cards) {
  if (!card || !Array.isArray(card.blockedBy)) return [];
  return card.blockedBy.filter((id) => typeof id === 'string' && cards.some((c) => c && c.id === id));
}

// ---------------------------------------------------------------- history

// What happened to a card: created, moved, edited, by the user or by Claude. Newest last, at most MAX_HISTORY entries.
// An older plugin version ignores the field and keeps it. `worker` says who did the work behind the entry; it is left out when not given.
export const MAX_HISTORY = 50;
export function addHistory(card, by, entry, at, worker) {
  if (!Array.isArray(card.history)) card.history = [];
  card.history.push({ at, by: by === 'user' ? 'user' : 'claude', ...entry, ...(worker ? { worker } : {}) });
  if (card.history.length > MAX_HISTORY) card.history.splice(0, card.history.length - MAX_HISTORY);
}
