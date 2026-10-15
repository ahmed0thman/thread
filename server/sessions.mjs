// Session names: the session record in the state file and how its name is found. Imports only ./state.mjs.
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { now, readLocalState, updateLocalState } from './state.mjs';

export const SESSION_ID_RE = /^[0-9A-Za-z-]{8,64}$/;
const TRANSCRIPT_CHUNK = 256 * 1024;
const SESSION_THROTTLE_MS = 60000;
const NAME_MAX = 120;
const FIRST_MESSAGE_MAX = 60;
const NAME_RANK = { none: 0, 'first-message': 1, 'ai-title': 2, title: 3 };

export const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// A model name or effort level that is safe to pass to the CLI as one argument; otherwise null.
export const cleanModel = (v) => (typeof v === 'string' && MODEL_RE.test(v) ? v : null);
export const cleanEffort = (v) => (EFFORTS.includes(v) ? v : null);

function validTranscriptPath(p) {
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) && p.endsWith('.jsonl');
}

function parseJsonLine(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead).toString('utf8');
}

// The first usable user text in one transcript line, or ''.
function userTextOf(obj) {
  const content = obj && obj.message && obj.message.content;
  const blocks = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
      : [];
  for (const raw of blocks) {
    const t = collapse(raw);
    if (t && !t.startsWith('<')) return t;
  }
  return '';
}

// Reads at most the last 256 KB for an ai-title line and at most the first
// 256 KB for the first user message. Never throws; null when nothing is found.
async function nameFromTranscript(file) {
  if (!validTranscriptPath(file)) return null;
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    if (!size) return null;
    const len = Math.min(size, TRANSCRIPT_CHUNK);
    const tailStart = size - len;
    const tailLines = (await readAt(fh, tailStart, len)).split('\n');
    if (tailStart > 0) tailLines.shift(); // partial first line
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (!tailLines[i].includes('ai-title')) continue;
      const o = parseJsonLine(tailLines[i]);
      if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && collapse(o.aiTitle)) {
        return { name: collapse(o.aiTitle).slice(0, NAME_MAX), source: 'ai-title' };
      }
    }
    const headLines = (tailStart === 0 ? tailLines : (await readAt(fh, 0, len)).split('\n'));
    if (size > len) headLines.pop(); // partial last line
    for (const line of headLines) {
      if (!line.includes('"user"')) continue;
      const o = parseJsonLine(line);
      if (!o || o.type !== 'user') continue;
      const t = userTextOf(o);
      if (t) {
        return { name: t.length > FIRST_MESSAGE_MAX ? t.slice(0, FIRST_MESSAGE_MAX - 1) + '…' : t, source: 'first-message' };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// The model and effort of the newest assistant line in the last 256 KB of a transcript. Never throws.
async function modelFromTranscript(file) {
  const none = { model: null, effort: null };
  if (!validTranscriptPath(file)) return none;
  let fh;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, TRANSCRIPT_CHUNK);
    const lines = (await readAt(fh, size - len, len)).split('\n');
    if (size > len) lines.shift(); // partial first line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      const o = parseJsonLine(lines[i]);
      const model = o && o.type === 'assistant' && !o.isSidechain && o.message && o.message.model;
      if (typeof model !== 'string' || model === '<synthetic>') continue;
      return { model: cleanModel(model), effort: cleanEffort(o.effort) };
    }
    return none;
  } catch {
    return none;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// The model and effort a session is running with, from its recorded transcript; nulls when unknown.
export async function sessionModel(projectDirArg, sessionId) {
  let rec;
  try { rec = sessionsOf(readLocalState(projectDirArg))[String(sessionId).toLowerCase()]; } catch { rec = undefined; }
  return modelFromTranscript(rec && rec.transcriptPath);
}

export function sessionsOf(state) {
  return state && state.sessions && typeof state.sessions === 'object' && !Array.isArray(state.sessions) ? state.sessions : {};
}

function recentlyNamed(rec) {
  if (!rec || (rec.nameSource !== 'title' && rec.nameSource !== 'ai-title') || !rec.name) return false;
  const seen = Date.parse(rec.lastSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < SESSION_THROTTLE_MS;
}

export async function touchSession(projectDirArg, sessionId, { transcriptPath, sessionTitle } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const key = sessionId.toLowerCase();
  const tp = validTranscriptPath(transcriptPath) ? transcriptPath : '';
  let prev;
  try { prev = sessionsOf(readLocalState(projectDirArg))[key]; } catch { prev = undefined; }
  if (recentlyNamed(prev)) return prev;

  let found = null;
  const title = typeof sessionTitle === 'string' ? collapse(sessionTitle) : '';
  if (title) found = { name: title.slice(0, NAME_MAX), source: 'title' };
  else found = await nameFromTranscript(tp || (prev && prev.transcriptPath));

  return updateLocalState(projectDirArg, (state) => {
    state.sessions = sessionsOf(state);
    const ts = now();
    let rec = state.sessions[key];
    if (!rec || typeof rec !== 'object') {
      rec = { name: '', nameSource: 'none', transcriptPath: '', firstSeenAt: ts, lastSeenAt: ts };
      state.sessions[key] = rec;
    }
    // A found name replaces the old one unless it is a weaker source.
    if (found && (NAME_RANK[found.source] ?? 0) >= (NAME_RANK[rec.nameSource] ?? 0)) {
      rec.name = found.name;
      rec.nameSource = found.source;
    }
    if (tp) rec.transcriptPath = tp;
    rec.lastSeenAt = ts;
    return JSON.parse(JSON.stringify(rec));
  });
}

export function sessionLabel(state, sessionId) {
  const id = String(sessionId ?? '');
  const short = id.slice(0, 8);
  const rec = sessionsOf(state)[id.toLowerCase()];
  return rec && typeof rec.name === 'string' && rec.name ? `${rec.name} · ${short}` : `session ${short}`;
}

export function sameSession(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}
