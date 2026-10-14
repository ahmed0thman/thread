// The optional project-management fields of a task or idea card (type, priority, labels, blockedBy, criteria), who did
// the work on a card (the `worker` of a history entry), and whether a card's acceptance criteria have been approved.
// Pure checks (and the history writer): nothing here reads or writes the state file. A field is stored only when it differs
// from its default, and an older plugin version ignores all of them and keeps them. Imports nothing.

export const TYPES = ['task', 'bug'];
export const PRIORITIES = ['high', 'normal', 'low'];
export const MAX_LABELS = 8;
export const MAX_LABEL = 24;
export const MAX_BLOCKERS = 10;
export const MAX_CRITERIA = 10;
export const MAX_CRITERION = 200;
export const MAX_WORKER = 64;
export const FIELD_NAMES = ['type', 'priority', 'labels', 'blockedBy', 'criteria'];

const CARD_ID_RE = /^c[0-9]+$/;
const WORKER_RE = /^(?:main|agent:[A-Za-z0-9][A-Za-z0-9:_.-]*|thread:c[0-9]+|lane:[A-Za-z0-9][A-Za-z0-9._-]*)$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
    if (!CARD_ID_RE.test(t)) throw new Error(`blocked_by takes card ids like "c4", not "${String(x).slice(0, 40)}"`);
    if (out.includes(t)) throw new Error(`${t} is given twice in blocked_by`);
    out.push(t);
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
  if (Array.isArray(card.runs)) for (const r of card.runs) if (isObject(r) && typeof r.agentType === 'string' && r.agentType) add(derived('agent:', r.agentType), r.startedAt);
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
 * When the card last left the done stage, in ms: the later of the card's own `leftDoneAt` (written whenever a card moves out of
 * the done stage, so the capped history cannot lose it) and the latest `moved` entry of its history that came from `doneStage`
 * (a move an older plugin version made leaves no field). -Infinity when there is neither (never reopened), so every review counts.
 */
export function leftDoneAt(card, doneStage) {
  let at = -Infinity;
  if (!card || typeof doneStage !== 'string') return at;
  const stored = typeof card.leftDoneAt === 'string' ? Date.parse(card.leftDoneAt) : NaN;
  if (Number.isFinite(stored)) at = stored;
  if (!Array.isArray(card.history)) return at;
  for (const h of card.history) {
    if (!isObject(h) || h.type !== 'moved' || h.from !== doneStage) continue;
    const t = Date.parse(h.at);
    if (Number.isFinite(t) && t > at) at = t;
  }
  return at;
}

/** True when the card has acceptance criteria. */
export const hasCriteria = (card) => !!card && Array.isArray(card.criteria) && card.criteria.length > 0;

/** The ids of the cards a card is blocked by that still exist. `cards` are the project's cards. */
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
