// "Notify Claude": the user asks a session to look at a card it has not listed yet. The board stores the request on the card
// (`notifyId`, `notifyForRev`, `notifySession`, plus `notifyRequestedAt` for the order); the hook tells the session with its next
// prompt, or the waiter (wake.mjs) wakes it. A request is open while the card has not been edited since the click (the card's
// revision, `notifyRev`, is still `notifyForRev`) and the session that was picked has not listed the board (board_list sets `notifySeenFor`).
// An older plugin version ignores all of these fields and keeps them; a card it wrote has none, and has no open request.
// Imports only state.mjs, sessions.mjs, config.mjs and fields.mjs.
import { createHash, randomBytes } from 'node:crypto';
import { now, readState, updateState } from './state.mjs';
import { SESSION_ID_RE, collapse, sameSession, sessionsOf } from './sessions.mjs';
import { cardById } from './fields.mjs';
import { ChatOnlyError, readConfig } from './config.mjs';

export const MAX_NOTIFY_NOTE = 500;
export const MAX_NOTIFIED_AT_ONCE = 3;   // requests one prompt carries; the others are named, and follow with the next message

const isThreadOrMilestone = (c) => c.kind === 'thread' || c.kind === 'milestone';
const text = (v) => typeof v === 'string' && v.length > 0;

// What the owner reads of a card and the notify line quotes (title, kind, stage, note), and the fields the owner sets on the board: an edit of
// any of them ends a request on a card kept in the repo. Waiting items, history, workers and the like are not here: Claude's wait_add from
// another session, the owner answering an item, and a worker note are not an edit of the card.
const NOTIFY_FIELDS = ['title', 'note', 'kind', 'status', 'type', 'priority', 'labels', 'blockedBy', 'criteria', 'parent', 'lane'];

/**
 * The revision of a card that a notify click is made on. A card kept on this machine: its `updatedAt`. A card of a project kept in the repo
 * (`card.approvals` is an object): `updatedAt` and a fingerprint of the fields above, because the file's `updatedAt` is whatever the file
 * says, and a pull can change the note and keep it. A request stored with an older form of revision never matches: it is stale.
 */
export function notifyRev(card) {
  const at = card.updatedAt ?? '';
  if (card.approvals === null || typeof card.approvals !== 'object' || Array.isArray(card.approvals)) return at;
  const read = NOTIFY_FIELDS.map((k) => card[k] ?? null);
  return `${at}#${createHash('sha1').update(JSON.stringify(read)).digest('hex').slice(0, 16)}`;
}

/**
 * True while a notify request is open on the card: it has a request id and a session, the card has not been changed since the click
 * (its revision is the one the click was made on, so any later edit ends the request, whatever the clock does), and the session that
 * was picked has not listed the board since. Other sessions listing the board end nothing. Read-side only: nothing is cleaned up.
 */
export function notifyActive(card) {
  if (!card || isThreadOrMilestone(card)) return false;
  if (!text(card.notifyId) || !text(card.notifySession) || typeof card.notifyForRev !== 'string') return false;
  if (card.notifySeenFor === card.notifyId) return false;
  return notifyRev(card) === card.notifyForRev;
}

/** True when the request on the card was already carried to its session (by the prompt hook, or by a wake). */
export const notifyPushed = (card) => text(card.notifyId) && card.notifyPushedFor === card.notifyId;

/**
 * The open requests for `sessionId`, as cards. The ones not carried yet come first, so a request cut off by the limit of one prompt is
 * the first the next one carries; each group oldest first. Read-only; none in a chat-only project.
 */
export function pendingNotifies(projectDirArg, sessionId) {
  if (readConfig(projectDirArg).mode === 'chat') return [];
  const rank = (c) => (notifyPushed(c) ? 1 : 0);
  return readState(projectDirArg).cards
    .filter((c) => notifyActive(c) && sameSession(c.notifySession, sessionId))
    .sort((a, b) => rank(a) - rank(b) || String(a.notifyRequestedAt).localeCompare(String(b.notifyRequestedAt)));
}

/** True for a session the board knows: one that has run a prompt hook here, or one that started a thread. */
function knownSession(state, sessionId) {
  if (Object.keys(sessionsOf(state)).includes(sessionId.toLowerCase())) return true;
  return state.cards.some((c) => c.kind === 'thread' && c.thread && sameSession(c.thread.parentSessionId, sessionId));
}

/**
 * The board's "Notify Claude": ask `sessionId` to look at card `id`. Writes only the notify fields: a new request id, the card's revision
 * as it is now, the session and the time. A card Claude has listed is refused, except one that has an open request (to notify again).
 * Returns the card.
 */
export async function requestNotify(projectDirArg, id, sessionId) {
  if (readConfig(projectDirArg).mode === 'chat') throw new ChatOnlyError();
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error('session must be the id of a Claude session in this project');
  return updateState(projectDirArg, (state) => {
    const card = cardById(state.cards, id);
    if (!card) throw new Error(`card not found: ${String(id).slice(0, 40)}`);
    if (isThreadOrMilestone(card)) throw new Error(`${card.id} is a ${card.kind}: only a task or an idea can be notified`);
    // new from you (edited on this board) or new in the repo (it came with a pull): the click is made on this machine's board, so it is the owner's
    if (card.seenByClaude !== false && card.newInRepo !== true && !notifyActive(card)) throw new Error(`${card.id} is not new from you: Claude has already listed it`);
    if (!knownSession(state, sessionId)) throw new Error('that session is not known in this project');
    card.notifyId = randomBytes(8).toString('hex');
    card.notifyForRev = notifyRev(card);
    card.notifySession = sessionId.toLowerCase();
    card.notifyRequestedAt = now();
    return card;
  });
}

/**
 * The prompt hook carried these requests ({ id, notifyId } each): remember it, so a later turn end does not wake the session for them
 * again. Under the state lock; a request that was replaced meanwhile (another click) keeps its own push state.
 */
export async function markNotifyCarried(projectDirArg, carried) {
  if (!carried.length) return;
  await updateState(projectDirArg, (state) => {
    for (const { id, notifyId } of carried) {
      const card = cardById(state.cards, id);
      if (card && card.notifyId === notifyId) card.notifyPushedFor = notifyId;
    }
  });
}

/** The line the hook adds when requests are left over: they come with the next message. */
export function notifyMoreLine(cards) {
  const shown = cards.slice(0, 20).map((c) => c.id);
  const ids = shown.join(', ') + (cards.length > shown.length ? ` and ${cards.length - shown.length} more` : '');
  return `The user also asked you to look at ${cards.length === 1 ? 'card' : 'cards'} ${ids}; ${cards.length === 1 ? 'it comes' : 'they come'} with the next message.`;
}

/** The line the hook adds for an open request. The card's own words go in quotes as JSON strings, so they stay data and cannot close the line. */
export function notifyLine(card, stageLabel, sessionId) {
  const note = collapse(card.note);
  const cut = note.length > MAX_NOTIFY_NOTE ? note.slice(0, MAX_NOTIFY_NOTE - 1) + '…' : note;
  const title = collapse(card.title);
  const shortTitle = title.length > 80 ? title.slice(0, 79) + '…' : title;
  const where = `${card.kind}, ${stageLabel}`;
  return `The user asks you to look at card ${card.id} ${JSON.stringify(shortTitle)} (${where})${cut ? `: ${JSON.stringify(cut)}` : ''}. Treat it as if they had typed it; board_list${sessionId ? ` with session_id "${sessionId}"` : ''} marks it as seen.`;
}
