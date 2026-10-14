// "Waiting for you": things Claude needs from the user, kept as items in `card.waits`. Claude adds them with the
// wait_add tool, the user answers them on the board, and the answer reaches the session that asked with that
// session's next message (the UserPromptSubmit hook). An item is never deleted, only closed. An older plugin
// version ignores the field and keeps it. Imports only state.mjs, sessions.mjs, config.mjs and fields.mjs.
import { now, readState, updateState } from './state.mjs';
import { collapse, sameSession } from './sessions.mjs';
import { ChatOnlyError, readConfig } from './config.mjs';
import { addHistory, cleanWorker, leftDoneAt } from './fields.mjs';

export const WAIT_KINDS = ['question', 'choice', 'todo', 'review'];
export const WAIT_STATES = ['open', 'answered', 'withdrawn'];
export const VERDICTS = ['approve', 'changes'];
export const WAIT_ID_RE = /^(c[0-9]+)\.w([0-9]+)$/;
export const MAX_WAIT_TEXT = 2000;
export const MAX_CHOICE_TEXT = 120;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 8;
export const MAX_ANSWER = 4000;
export const MAX_COMMENT = 2000;
export const MAX_OPEN_WAITS = 20;             // open items on one card
export const MAX_DELIVERED_AT_ONCE = 5;       // answers one prompt carries; the rest follow with the next

// A refused wait call. status is the HTTP status the board answers with.
export class WaitError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shorten = (s, n) => { const t = collapse(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** The items of a card that are well-formed records; anything else an older or broken writer left is skipped. */
export function waitsOf(card) {
  return card && Array.isArray(card.waits) ? card.waits.filter((w) => isObject(w) && typeof w.id === 'string' && WAIT_KINDS.includes(w.kind)) : [];
}
export const openWaits = (card) => waitsOf(card).filter((w) => w.state === 'open');

const approves = (w) => w.state === 'answered' && isObject(w.answer) && w.answer.verdict === 'approve';

/**
 * True when the card's criteria were approved: no review item is open, and the latest closed one (answered or withdrawn,
 * by the time it was closed; a tie goes to the one that is no approval) is answered with the verdict "approve". A withdrawn
 * one is no approval, and an item answered in the chat holds no verdict. Only items closed after the card last left `doneStage` count (see leftDoneAt), so a card
 * that was reopened needs a new approval; without a stage, or when it never left it, all of them count.
 */
export function reviewApproved(card, doneStage) {
  const reviews = waitsOf(card).filter((w) => w.kind === 'review');
  if (reviews.some((w) => w.state === 'open')) return false;
  const since = leftDoneAt(card, doneStage);
  let latest = null, latestAt = 0;
  for (const w of reviews) {
    if (w.state !== 'answered' && w.state !== 'withdrawn') continue;
    const at = Date.parse(w.state === 'answered' ? w.answeredAt : w.withdrawnAt) || 0;
    if (at <= since) continue;
    // a tie goes to the non-approval, so a withdrawal closed in the same millisecond as an approval is never read as one
    if (!latest || at > latestAt || (at === latestAt && !approves(w))) { latest = w; latestAt = at; }
  }
  return !!latest && approves(latest);
}

function findWait(state, id) {
  const m = typeof id === 'string' ? WAIT_ID_RE.exec(id.trim()) : null;
  if (!m) throw new WaitError(`not a waiting item id: ${String(id).slice(0, 40)} (they look like c37.w2)`, 404);
  const card = state.cards.find((c) => c.id === m[1]);
  const item = card ? waitsOf(card).find((w) => w.id === id.trim()) : null;
  if (!item) throw new WaitError(`waiting item not found: ${id.trim()}`, 404);
  return { card, item };
}

function cleanText(text, what, max) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new WaitError(`${what} must not be empty`);
  if (t.length > max) throw new WaitError(`${what} is too long (${t.length} characters, the limit is ${max})`);
  return t;
}

function cleanChoices(choices) {
  if (!Array.isArray(choices) || choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
    throw new WaitError(`a choice needs ${MIN_CHOICES} to ${MAX_CHOICES} options in choices`);
  }
  const out = [];
  for (const c of choices) {
    const t = typeof c === 'string' ? c.trim() : '';
    if (!t || t.length > MAX_CHOICE_TEXT) throw new WaitError(`each option must be 1 to ${MAX_CHOICE_TEXT} characters`);
    if (out.includes(t)) throw new WaitError(`the option "${shorten(t, 40)}" is given twice`);
    out.push(t);
  }
  return out;
}

/** Add an item to a card, for the session `sessionId`. Returns { card, item }. */
export async function addWait(projectDirArg, { card: cardId, kind, text, choices, multi, sessionId, worker } = {}) {
  // A side thread answers to the main session, which is the one that talks to the user.
  if (process.env.THREAD_DEPTH) throw new WaitError('a side thread cannot ask the user for something; tell the main session in your report');
  if (readConfig(projectDirArg).mode === 'chat') throw new ChatOnlyError();
  if (!WAIT_KINDS.includes(kind)) throw new WaitError(`invalid kind "${String(kind).slice(0, 40)}" (use ${WAIT_KINDS.join(', ')})`);
  const body = cleanText(text, 'text', MAX_WAIT_TEXT);
  if (kind !== 'choice' && (choices !== undefined || multi === true)) throw new WaitError('choices and multi belong to the kind "choice" only');
  if (multi !== undefined && typeof multi !== 'boolean') throw new WaitError('multi must be true or false');
  const options = kind === 'choice' ? cleanChoices(choices) : null;
  if (typeof cardId !== 'string' || !cardId.trim()) throw new WaitError('card must be a card id');
  if (typeof sessionId !== 'string' || !sessionId) throw new WaitError('no session id');
  let by;
  try { by = cleanWorker(worker); } catch (e) { throw new WaitError(e.message); }
  return updateState(projectDirArg, (state) => {
    const card = state.cards.find((c) => c.id === cardId.trim());
    if (!card) throw new WaitError(`card not found: ${cardId.trim()}`, 404);
    if (card.kind === 'milestone') throw new WaitError(`${card.id} is a milestone: put the item on one of its cards`);
    if (openWaits(card).length >= MAX_OPEN_WAITS) throw new WaitError(`${card.id} already has ${MAX_OPEN_WAITS} open items; close some first`);
    // The number is never reused: not after a writer pruned old items, and not for an item of a kind this version does not know.
    const raw = Array.isArray(card.waits) ? card.waits : [];
    const used = raw.reduce((m, w) => Math.max(m, Number(WAIT_ID_RE.exec(isObject(w) && typeof w.id === 'string' ? w.id : '')?.[2]) || 0), 0);
    const n = Math.max(Number.isInteger(card.waitSeq) ? card.waitSeq : 0, used) + 1;
    const item = { id: `${card.id}.w${n}`, kind, text: body };
    if (options) { item.choices = options; item.multi = multi === true; }
    Object.assign(item, { askedBy: sessionId.toLowerCase(), askedAt: now(), state: 'open' });
    if (!Array.isArray(card.waits)) card.waits = [];
    card.waits.push(item);
    card.waitSeq = n;
    // card.updatedAt and seenByClaude stay as they are: this is not an edit of the card. The history notes it only to say who did the work.
    if (by) addHistory(card, 'claude', { type: 'waiting', wait: item.id, kind }, item.askedAt, by);
    return { card, item };
  });
}

/** Items as { card, item }, read-only. id: one item. card: one card's items. state: one state; without it, the open ones and the answered ones not yet delivered. */
export function listWaits(projectDirArg, { id, card: cardId, state: want } = {}) {
  if (want !== undefined && !WAIT_STATES.includes(want)) throw new WaitError(`state must be one of: ${WAIT_STATES.join(', ')}`);
  const s = readState(projectDirArg);
  if (id) return [findWait(s, id)];
  if (cardId && !s.cards.some((c) => c.id === cardId)) throw new WaitError(`card not found: ${cardId}`, 404);
  const out = [];
  for (const card of s.cards) {
    if (cardId && card.id !== cardId) continue;
    for (const item of waitsOf(card)) {
      const wanted = want ? item.state === want : item.state === 'open' || (item.state === 'answered' && !item.deliveredAt);
      if (wanted) out.push({ card, item });
    }
  }
  return out;
}

/** Close an open item from the chat: withdraw it, or record that the user answered in the chat (note). Returns { card, item }. */
export async function closeWait(projectDirArg, id, { withdraw, answeredInChat } = {}) {
  if (process.env.THREAD_DEPTH) throw new WaitError('a side thread cannot close waiting items');
  const chat = typeof answeredInChat === 'string' ? answeredInChat.trim() : '';
  if ((withdraw === true) === !!chat) throw new WaitError('give either withdraw: true or answered_in_chat with a note of the answer');
  if (chat.length > MAX_ANSWER) throw new WaitError(`the note is too long (${chat.length} characters, the limit is ${MAX_ANSWER})`);
  return updateState(projectDirArg, (state) => {
    const { card, item } = findWait(state, id);
    if (item.state !== 'open') throw new WaitError(`${item.id} is ${item.state}, not open`, 409);
    const ts = now();
    if (withdraw === true) {
      item.state = 'withdrawn';
      item.withdrawnAt = ts;
    } else {
      // The session closing it is the one that has the answer, so there is nothing to deliver.
      item.state = 'answered';
      item.answer = { text: chat };
      item.answeredAt = ts;
      item.answeredVia = 'chat';
      item.deliveredAt = ts;
    }
    return { card, item };
  });
}

// What the user sent for an item of this kind, checked. { answer, comment }.
function checkAnswer(item, body) {
  const b = isObject(body) ? body : {};
  let comment;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string') throw new WaitError('comment must be text');
    const c = b.comment.trim();
    if (c.length > MAX_COMMENT) throw new WaitError(`the comment is too long (${c.length} characters, the limit is ${MAX_COMMENT})`);
    if (c) comment = c;
  }
  let answer;
  if (item.kind === 'question') {
    answer = { text: cleanText(b.text, 'the answer', MAX_ANSWER) };
  } else if (item.kind === 'choice') {
    const options = Array.isArray(item.choices) ? item.choices : [];
    if (!Array.isArray(b.choices) || b.choices.some((c) => typeof c !== 'string' || !options.includes(c))) throw new WaitError('choices must be options of this item');
    if (new Set(b.choices).size !== b.choices.length) throw new WaitError('an option is chosen twice');
    if (item.multi === true ? b.choices.length < 1 : b.choices.length !== 1) throw new WaitError(item.multi === true ? 'choose at least one option' : 'choose exactly one option');
    answer = { choices: b.choices.slice() };
  } else if (item.kind === 'todo') {
    if (b.done !== true) throw new WaitError('done must be true');
    answer = { done: true };
  } else {
    if (!VERDICTS.includes(b.verdict)) throw new WaitError(`verdict must be one of: ${VERDICTS.join(', ')}`);
    answer = { verdict: b.verdict };
  }
  return { answer, comment };
}

/** The board's answer to an open item. Writes only state, answer, comment, answeredAt and answeredVia. Returns { card, item }. */
export async function answerWait(projectDirArg, cardId, id, body) {
  if (readConfig(projectDirArg).mode === 'chat') throw new ChatOnlyError();
  return updateState(projectDirArg, (state) => {
    const { card, item } = findWait(state, id);
    if (card.id !== cardId) throw new WaitError(`${item.id} is not on card ${cardId}`, 404);
    if (item.state !== 'open') throw new WaitError(`${item.id} is ${item.state}, not open`, 409);
    const { answer, comment } = checkAnswer(item, body);
    item.state = 'answered';
    item.answer = answer;
    if (comment) item.comment = comment;
    item.answeredAt = now();
    item.answeredVia = 'board';
    // Not seenByClaude: markSeen clears it project-wide, so another session (or an older version) would swallow it.
    return { card, item };
  });
}

/** The answer in words, whole. */
export function answerPhrase(item) {
  const a = isObject(item.answer) ? item.answer : {};
  let out;
  if (item.kind === 'question' || item.answeredVia === 'chat') out = `"${a.text ?? ''}"`;
  else if (item.kind === 'choice') out = `chose ${(Array.isArray(a.choices) ? a.choices : []).map((c) => `"${c}"`).join(', ')}`;
  else if (item.kind === 'todo') out = 'did it';
  else out = a.verdict === 'approve' ? 'approved' : 'asked for changes';
  return item.comment ? `${out}, with the comment "${item.comment}"` : out;
}

/** How many answers given on the board are still undelivered although the session that asked is not `sessionId`. Read only. */
export function countUndeliveredElsewhere(projectDirArg, sessionId) {
  let n = 0;
  for (const card of readState(projectDirArg).cards) {
    for (const item of waitsOf(card)) if (item.state === 'answered' && !item.deliveredAt && !sameSession(item.askedBy, sessionId)) n += 1;
  }
  return n;
}

/**
 * The answers waiting for session `sessionId`: items it asked, answered on the board, not delivered yet. They are marked
 * delivered under the state lock, so two prompts never carry the same answer. At most MAX_DELIVERED_AT_ONCE per call.
 */
export async function deliverWaitAnswers(projectDirArg, sessionId) {
  if (readConfig(projectDirArg).mode === 'chat') return [];
  return updateState(projectDirArg, (state) => {
    const out = [];
    for (const card of state.cards) {
      for (const item of waitsOf(card)) {
        if (out.length >= MAX_DELIVERED_AT_ONCE) return out;
        if (item.state !== 'answered' || item.deliveredAt || !sameSession(item.askedBy, sessionId)) continue;
        item.deliveredAt = now();
        out.push({ card: { id: card.id, title: card.title }, item: JSON.parse(JSON.stringify(item)) });
      }
    }
    return out;
  });
}

/** The line the hook adds for a delivered answer. */
export function deliveryLine(item, answerMax = 300) {
  const phrase = answerPhrase(item);
  const cut = shorten(phrase, answerMax);
  const more = cut.length < collapse(phrase).length ? ` (cut short; wait_list with id ${item.id} shows it whole)` : '';
  return `The user answered ${item.id} on the board ("${shorten(item.text, 60)}"): ${cut}${more}. Continue with it.`;
}
