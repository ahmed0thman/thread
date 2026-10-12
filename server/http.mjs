// Board HTTP server: loopback only, no dependencies.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as core from './core.mjs';

const MAX_BODY = 64 * 1024;
const MAX_PORT_TRIES = 20;
const BOARD_FILE = new URL('./board.html', import.meta.url);

function log(...a) {
  try { process.stderr.write('[thread/http] ' + a.join(' ') + '\n'); } catch { /* ignore */ }
}

function defaultPort(projectDir) {
  const h = createHash('sha1').update(String(projectDir)).digest('hex');
  return 47800 + (parseInt(h.slice(0, 4), 16) % 100);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  try {
    const { hostname } = new URL('http://' + hostHeader);
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume();
      reject(new HttpError(413, 'request body too large (limit 64 KB)'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request body too large (limit 64 KB)'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try {
        const v = JSON.parse(text);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) {
          reject(new HttpError(400, 'body must be a JSON object'));
        } else resolve(v);
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(new HttpError(400, 'request error: ' + e.message)); } });
  });
}

function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string') throw new HttpError(400, `${k} must be a string`);
    out[k] = body[k];
  }
  return out;
}

function makeHandler(projectDir) {
  return async function handle(req, res) {
    if (!hostAllowed(req.headers.host)) {
      send(res, 403, { error: 'forbidden host' });
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, { error: 'bad url' }); return; }
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/') {
      try {
        const html = await readFile(BOARD_FILE);
        send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      } catch (e) {
        if (e && e.code === 'ENOENT') send(res, 503, 'board.html is not available yet');
        else { log('board.html read failed:', e && e.message); send(res, 503, 'board.html could not be read'); }
      }
      return;
    }

    if (method === 'GET' && path === '/api/state') {
      const state = await core.reconcile(projectDir);
      send(res, 200, { projectDir, statuses: core.STATUSES, cards: state.cards.map(withViews) });
      return;
    }

    if (method === 'POST' && path === '/api/cards') {
      requireJson(req);
      const body = await readJsonBody(req);
      const args = pick(body, ['title', 'note', 'status', 'kind']);
      const card = await core.addCard(projectDir, { ...args, source: 'user' });
      send(res, 201, card);
      return;
    }

    const m = /^\/api\/cards\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req);
      const args = pick(body, ['title', 'note', 'status']);
      if (args.status !== undefined) {
        const existing = core.readState(projectDir).cards.find((c) => c.id === m[1]);
        if (existing && existing.kind === 'thread' && existing.status !== args.status) {
          throw new HttpError(400, 'thread status follows the thread');
        }
      }
      const card = await core.updateCard(projectDir, m[1], args, { source: 'user' });
      send(res, 200, card);
      return;
    }
    if (m && method === 'DELETE') {
      req.resume();
      await core.removeCard(projectDir, m[1]);
      send(res, 200, { ok: true });
      return;
    }

    const tm = /^\/api\/threads\/([A-Za-z0-9_-]{1,64})\/(messages|end)$/.exec(path);
    if (tm && method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req);
      const card = tm[2] === 'messages'
        ? await core.continueThread(projectDir, tm[1], body && body.message)
        : await core.endThread(projectDir, tm[1]);
      send(res, 200, withViews(card));
      return;
    }

    req.resume();
    send(res, 404, { error: 'not found' });
  };
}

// Attach the parsed hand-back (free text, digest sections, step map) to each
// turn for the board page. Computed per response; never stored.
function withViews(card) {
  if (!card || card.kind !== 'thread' || !card.thread) return card;
  const turns = (card.thread.turns || []).map((t) => (
    typeof t.result === 'string' ? { ...t, view: core.parseHandback(t.result) } : t
  ));
  return { ...card, thread: { ...card.thread, turns } };
}

function requireJson(req) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    req.resume();
    throw new HttpError(415, 'Content-Type must be application/json');
  }
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onListening); reject(e); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startBoardServer(projectDir, { port } = {}) {
  const handle = makeHandler(projectDir);
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else if (e && e.message) send(res, 400, { error: String(e.message).split('\n')[0] });
      else send(res, 500, { error: 'internal error' });
    });
  });
  server.on('clientError', (err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* ignore */ }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  const base = port === undefined || port === null ? defaultPort(projectDir) : port;
  const tries = base === 0 ? 1 : MAX_PORT_TRIES;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await listenOnce(server, base === 0 ? 0 : base + i);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!e || e.code !== 'EADDRINUSE') break;
    }
  }
  if (lastErr) {
    try { server.close(); } catch { /* ignore */ }
    throw lastErr;
  }
  server.on('error', (e) => log('server error:', e && e.message));
  const actual = server.address().port;
  return { server, port: actual, url: `http://127.0.0.1:${actual}/` };
}
