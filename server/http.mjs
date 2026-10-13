// Board HTTP server: loopback only, no dependencies.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as core from './core.mjs';

const MAX_BODY = 64 * 1024;
const MAX_PORT_TRIES = 20;
const BOARD_FILE = new URL('./board.html', import.meta.url);
const DEFAULT_PORT = 47800;
const TOKEN_RE = /^[0-9a-f]{32,64}$/;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function log(...a) {
  try { process.stderr.write('[thread/http] ' + a.join(' ') + '\n'); } catch { /* ignore */ }
}

function basePort() {
  const n = Number(process.env.THREAD_BOARD_PORT);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

function dataKey() {
  return createHash('sha1').update(resolve(core.dataDir())).digest('hex').slice(0, 12);
}

function tokenOk(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A browser page may only write from this server's own origin.
function originAllowed(origin, port) {
  try {
    const u = new URL(origin);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === port;
  } catch {
    return false;
  }
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

const THREAD_ROUTES = new Set(['POST messages', 'POST end', 'POST report-request', 'DELETE report-request', 'GET activity']);

// One route table for every project. `sub` is the path below the project
// ("/state", "/cards", "/cards/c1", "/threads/c1/messages"); `query` is the URL's search params.
async function handleProject(req, res, projectDir, sub, query) {
  const method = req.method;
  const isState = method === 'GET' && sub === '/state';
  const isAgents = method === 'GET' && sub === '/agents';
  const isCardCreate = method === 'POST' && sub === '/cards';
  const cm = /^\/cards\/([A-Za-z0-9_-]{1,64})$/.exec(sub);
  const sm = /^\/cards\/([A-Za-z0-9_-]{1,64})\/start$/.exec(sub);
  const tm = /^\/threads\/([A-Za-z0-9_-]{1,64})\/(messages|end|activity|report-request)$/.exec(sub);
  const threadRoute = tm ? `${method} ${tm[2]}` : '';
  const isActivity = threadRoute === 'GET activity';
  const known = isState || isAgents || isCardCreate || (cm && (method === 'PATCH' || method === 'DELETE')) || (sm && method === 'POST') || THREAD_ROUTES.has(threadRoute);
  if (!known) {
    req.resume();
    send(res, 404, { error: 'not found' });
    return;
  }

  const viewOf = (card) => withViews(card, core.readConfig(projectDir), core.readState(projectDir).cards);
  const present = core.dirExists(projectDir);
  if (!isState && !isAgents && !isActivity && !present) {
    req.resume();
    send(res, 409, { error: `project folder not found: ${projectDir}` });
    return;
  }

  if (isState) {
    // A project whose folder is gone is read-only: no reconcile, no write.
    const state = present ? await core.reconcile(projectDir) : core.readState(projectDir);
    const cfg = core.readConfig(projectDir);
    send(res, 200, {
      projectDir,
      exists: present,
      config: { mode: cfg.mode, stages: cfg.stages, roles: cfg.roles },
      cards: state.cards.map((c) => withViews(c, cfg, state.cards)),
      sessions: sessionsView(state),
    });
    return;
  }

  if (isAgents) {
    send(res, 200, { agents: core.listAgents(projectDir) });
    return;
  }

  if (isCardCreate) {
    requireJson(req);
    const body = await readJsonBody(req);
    const args = pick(body, ['title', 'note', 'status', 'kind', 'parent']);
    const card = await core.addCard(projectDir, { ...args, source: 'user' });
    send(res, 201, viewOf(card));
    return;
  }

  if (cm && method === 'PATCH') {
    requireJson(req);
    const body = await readJsonBody(req);
    const args = pick(body, ['title', 'note', 'status']);
    if (body.parent === null) args.parent = null; // null takes the card out of its milestone, like ''
    else Object.assign(args, pick(body, ['parent']));
    const card = await core.updateCard(projectDir, cm[1], args, { source: 'user' });
    send(res, 200, viewOf(card));
    return;
  }
  if (cm && method === 'DELETE') {
    req.resume();
    await core.removeCard(projectDir, cm[1]);
    send(res, 200, { ok: true });
    return;
  }

  if (isActivity) {
    const card = core.readState(projectDir).cards.find((c) => c.id === tm[1]);
    if (!core.isThread(card)) throw new HttpError(404, `thread not found: ${tm[1]}`);
    const turn = Number(query.get('turn'));
    if (!Number.isInteger(turn) || turn < 1 || turn > card.thread.turns.length) throw new HttpError(404, `thread ${tm[1]} has no turn ${query.get('turn')}`);
    const running = card.thread.runState === 'running' && turn === card.thread.turns.length;
    send(res, 200, { turn, running, events: core.readActivity(projectDir, card.id, turn) });
    return;
  }

  if (threadRoute === 'DELETE report-request') {
    req.resume();
    send(res, 200, viewOf(await core.cancelReportRequest(projectDir, tm[1])));
    return;
  }

  requireJson(req);
  const body = await readJsonBody(req);
  let card;
  if (sm) {
    const { sessionId, mode, context, agent } = pick(body, ['sessionId', 'mode', 'context', 'agent']);
    card = await core.startThreadFromCard(projectDir, sm[1], { sessionId, mode, context, agent, extraDirs: body.extraDirs });
  } else if (tm[2] === 'messages') {
    card = await core.continueThread(projectDir, tm[1], body.message);
  } else if (tm[2] === 'end') {
    card = (await core.endThread(projectDir, tm[1])).card;
  } else {
    card = await core.requestReport(projectDir, tm[1]);
  }
  send(res, 200, viewOf(card));
}

function projectsView(homeDir) {
  const list = core.listProjects();
  const homeKey = core.projectKey(homeDir);
  if (!list.some((p) => p.key === homeKey)) {
    const parts = String(homeDir).split(/[\\/]+/).filter(Boolean);
    list.unshift({
      key: homeKey,
      projectDir: homeDir,
      name: parts.length ? parts[parts.length - 1] : String(homeDir),
      exists: core.dirExists(homeDir),
      cards: 0,
      threads: 0,
      running: 0,
      lastActivity: new Date().toISOString(),
    });
  }
  return { home: homeKey, projects: list };
}

function makeHandler(homeDir, token, stop) {
  const requireToken = typeof token === 'string' && token.length > 0;
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
        log('board.html read failed:', e && e.message);
        send(res, 503, 'board.html could not be read');
      }
      return;
    }

    if (method === 'GET' && path === '/api/ping') {
      send(res, 200, { app: 'thread-board', version: core.VERSION, dataKey: dataKey() });
      return;
    }

    if (path.startsWith('/api/')) {
      if (WRITE_METHODS.has(method) && typeof req.headers.origin === 'string' && !originAllowed(req.headers.origin, req.socket.localPort)) {
        req.resume();
        send(res, 403, { error: 'forbidden origin' });
        return;
      }
      if (requireToken && !tokenOk(req.headers['x-thread-token'], token)) {
        req.resume();
        send(res, 401, { error: 'missing or wrong board token' });
        return;
      }
    }

    // Stops only this web server; the process that owns it keeps running.
    if (method === 'POST' && path === '/api/shutdown') {
      req.resume();
      res.on('finish', stop);
      send(res, 200, { ok: true }, { Connection: 'close' });
      return;
    }

    if (method === 'GET' && path === '/api/projects') {
      send(res, 200, projectsView(homeDir));
      return;
    }

    const homeKey = core.projectKey(homeDir);
    const pm = /^\/api\/p\/([^/]*)(\/.*)?$/.exec(path);
    if (pm) {
      const key = pm[1];
      const sub = pm[2] || '';
      if (!core.KEY_RE.test(key)) {
        req.resume();
        send(res, 404, { error: 'unknown project' });
        return;
      }
      if (sub === '' && method === 'DELETE') {
        req.resume();
        await core.forgetProject(key);
        send(res, 200, { ok: true });
        return;
      }
      const dir = key === homeKey ? homeDir : core.projectDirForKey(key);
      if (!dir) {
        req.resume();
        send(res, 404, { error: 'unknown project' });
        return;
      }
      await handleProject(req, res, dir, sub, url.searchParams);
      return;
    }

    if (path === '/api/state' || path === '/api/agents' || path === '/api/cards' || path.startsWith('/api/cards/') || path.startsWith('/api/threads/')) {
      await handleProject(req, res, homeDir, path.slice('/api'.length), url.searchParams);
      return;
    }

    req.resume();
    send(res, 404, { error: 'not found' });
  };
}

// What the board page gets for a card. The status is the stage it is shown in (see
// core.effectiveStatus), a milestone carries its progress, and a thread gets the parsed
// hand-back (free text, digest sections, step map) on each turn. Computed per response; never stored.
// `cards` are the project's stored cards, for the progress of a milestone.
function withViews(card, cfg, cards) {
  if (!card) return card;
  const view = { ...card, status: core.effectiveStatus(card, cfg) };
  // an older plugin version can remove a milestone without clearing its cards
  if (view.parent && !cards.some((c) => c.id === view.parent && c.kind === 'milestone')) delete view.parent;
  if (card.kind === 'milestone') {
    view.progress = core.milestoneProgress(cards, card.id, cfg);
  }
  return threadView(view);
}

function threadView(card) {
  if (card.kind !== 'thread' || !card.thread) return card;
  const turns = (card.thread.turns || []).map((t) => (
    typeof t.result === 'string' ? { ...t, view: core.parseHandback(t.result) } : t
  ));
  // The confirm code must reach the user only through the tool that issued it.
  const { pendingConfirm, ...thread } = card.thread;
  return { ...card, thread: { ...thread, turns } };
}

// Every known session plus every parent session named on a thread card.
function sessionsView(state) {
  const out = {};
  for (const [id, rec] of Object.entries(core.sessionsOf(state))) {
    out[id] = { name: (rec && rec.name) || '', label: core.sessionLabel(state, id), lastSeenAt: (rec && rec.lastSeenAt) || null };
  }
  for (const c of state.cards) {
    const p = c && c.kind === 'thread' && c.thread && c.thread.parentSessionId;
    if (typeof p === 'string' && p && !out[p]) out[p] = { name: '', label: core.sessionLabel(state, p), lastSeenAt: null };
  }
  return out;
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

export async function startBoardServer(projectDir, { port = 0, token } = {}) {
  const handle = makeHandler(projectDir, token, () => closeBoardServer(server));
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError || e instanceof core.ChatOnlyError) send(res, e.status, { error: e.message });
      else if (e && e.message) send(res, 400, { error: String(e.message).split('\n')[0] });
      else send(res, 500, { error: 'internal error' });
    });
  });
  server.on('clientError', (err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* ignore */ }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  try {
    await listenOnce(server, port);
  } catch (e) {
    try { server.close(); } catch { /* ignore */ }
    throw e;
  }
  server.on('error', (e) => log('server error:', e && e.message));
  const actual = server.address().port;
  return { server, port: actual, url: `http://127.0.0.1:${actual}/` };
}

export function closeBoardServer(server) {
  try { server.close(); server.closeAllConnections(); } catch { /* already closed */ }
}

// ---------------------------------------------------------------- shared board

// While this file exists no session starts or takes over the board; opening the board removes it.
const stoppedFile = () => join(core.dataDir(), 'board.stopped');
export function boardStopped() { return existsSync(stoppedFile()); }
export function setBoardStopped(on) {
  if (on) { mkdirSync(core.dataDir(), { recursive: true }); writeFileSync(stoppedFile(), ''); }
  else try { unlinkSync(stoppedFile()); } catch { /* not stopped */ }
}

/** True when plugin version `a` is lower than `b`; false when either is not x.y.z. */
export function olderVersion(a, b) {
  const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v)); return m ? m.slice(1).map(Number) : null; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Ask the board at <base> to stop. Resolves true when it agreed; boards before 0.8.2 cannot. */
export function stopBoard(baseUrl) {
  return new Promise((resolveP) => {
    let req;
    try {
      req = http.request(new URL('/api/shutdown', baseUrl), { method: 'POST', agent: false, timeout: 2000, headers: { 'X-Thread-Token': boardToken(), 'Content-Length': 0 } }, (res) => {
        res.resume();
        res.on('end', () => resolveP(res.statusCode === 200));
        res.on('error', () => resolveP(false));
      });
    } catch {
      resolveP(false);
      return;
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveP(false));
    req.end();
  });
}

/** The board's access token: 32 random hex characters in <data dir>/board.token (0600). */
export function boardToken() {
  const file = join(core.dataDir(), 'board.token');
  const readGood = () => {
    try {
      const t = readFileSync(file, 'utf8').trim();
      return TOKEN_RE.test(t) ? t : null;
    } catch {
      return null;
    }
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = readGood();
    if (existing) return existing;
    mkdirSync(core.dataDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, randomBytes(16).toString('hex') + '\n', { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
      // link() creates the name only if it is free, so the first of two
      // processes starting together wins and both end up reading its token.
      try {
        linkSync(tmp, file);
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          const winner = readGood();
          if (winner) return winner;
          renameSync(tmp, file); // present but invalid: replace it
        } else {
          renameSync(tmp, file); // no hard links on this filesystem
        }
      }
    } finally {
      try { unlinkSync(tmp); } catch { /* already renamed */ }
    }
    const written = readGood();
    if (written) return written;
  }
  throw new Error(`cannot create the board token file: ${file}`);
}

/** GET <base>/api/ping with a 1 s timeout. Resolves to the parsed body or null. */
export function pingBoard(baseUrl) {
  return new Promise((resolveP) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolveP(v); } };
    let req;
    try {
      req = http.get(new URL('/api/ping', baseUrl), { agent: false, timeout: 1000 }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 4096) { res.destroy(); done(null); } else chunks.push(c); });
        res.on('end', () => {
          try { done(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch { done(null); }
        });
        res.on('error', () => done(null));
      });
    } catch {
      done(null);
      return;
    }
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

/**
 * Own the board port, or adopt a thread board already serving the same data.
 * A board from an older plugin version is asked to stop and replaced, so the
 * page always comes from the newest version that is running.
 * Resolves { url, owned, server }; throws when no port in the range works.
 */
export async function ensureBoard(projectDir, { port } = {}) {
  const base = port === undefined || port === null ? basePort() : port;
  const token = boardToken();
  const tries = base === 0 ? 1 : MAX_PORT_TRIES;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const p = base === 0 ? 0 : base + i;
    if (p > 65535) break;
    try {
      const b = await startBoardServer(projectDir, { port: p, token });
      return { url: b.url, owned: true, server: b.server };
    } catch (e) {
      lastErr = e;
      if (!e || e.code !== 'EADDRINUSE') continue;
    }
    const url = `http://127.0.0.1:${p}/`;
    const info = await pingBoard(url);
    if (info && info.app === 'thread-board' && info.dataKey === dataKey()) {
      if (olderVersion(info.version, core.VERSION) && await stopBoard(url)) {
        for (let n = 0; n < 20; n++) {
          try {
            const b = await startBoardServer(projectDir, { port: p, token });
            return { url: b.url, owned: true, server: b.server };
          } catch { await new Promise((r) => setTimeout(r, 50)); }
        }
        if (!(await pingBoard(url))) continue;   // someone else's port now
      }
      return { url, owned: false, server: null };
    }
  }
  throw new Error(`no board port available from ${base}${base ? ` to ${base + tries - 1}` : ''}${lastErr ? ': ' + lastErr.message : ''}`);
}
