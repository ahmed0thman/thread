// Board HTTP server: loopback only, no dependencies.
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as core from './core.mjs';
import { listLanesWithRelay } from './lanes.mjs';
import { assembleBoardPage } from './page.mjs';
import { markRunStopped, readRunText, runActivity } from './runs.mjs';
import { TunnelError, createTunnelManager, reapStaleTunnel } from './tunnel.mjs';

export { TunnelError };

const MAX_BODY = 64 * 1024;
const MAX_PORT_TRIES = 20;
const DEFAULT_PORT = 47800;
const TOKEN_RE = /^[0-9a-f]{32,64}$/;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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
    'Referrer-Policy': 'no-referrer',
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

// The drafted answers sent together: the most the batch may hold, each as long as an answer and a comment may be. A character takes up to
// 6 bytes in JSON text (4 in UTF-8; a control character is escaped to 6), plus room for the ids and keys. No other route is given this much.
const MAX_BATCH_BODY = core.MAX_BATCH * (core.MAX_ANSWER + core.MAX_COMMENT) * 6 + 64 * 1024;

function readJsonBody(req, limit = MAX_BODY) {
  const sayLimit = limit >= 1024 * 1024 ? `${(limit / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(limit / 1024)} KB`;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, `request body too large (limit ${sayLimit})`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body too large (limit ${sayLimit})`));
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

// The project-management fields of a card (see fields.mjs): a string, or a list; null or an empty value removes one.
// Their values are checked by the core, which names what is wrong.
function cardFields(body) {
  const out = {};
  for (const k of core.FIELD_NAMES) {
    const v = body[k];
    if (v === undefined) continue;
    const list = k === 'labels' || k === 'blockedBy' || k === 'criteria';
    if (v !== null && (list ? !Array.isArray(v) && typeof v !== 'string' : typeof v !== 'string')) throw new HttpError(400, `${k} must be ${list ? 'a list' : 'a string'}`);
    out[k] = v;
  }
  return out;
}

const PATCH_KEYS = ['title', 'note', 'status', 'kind', 'parent', ...core.FIELD_NAMES];
// What the page's "New" panel sends (issue.js): the same as a patch.
const CREATE_KEYS = PATCH_KEYS;

// A key the card calls do not take is a mistake worth telling the sender about (a lane, blocked_by).
function checkKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new HttpError(400, k === 'blocked_by' ? 'unknown key blocked_by: the key is blockedBy' : `unknown key ${k.slice(0, 40)}; a card takes: ${allowed.join(', ')}`);
  }
}

const THREAD_ROUTES = new Set(['POST messages', 'POST end', 'POST report-request', 'DELETE report-request', 'GET activity']);

// One route table for every project. `sub` is the path below the project
// ("/state", "/cards", "/cards/c1", "/threads/c1/messages"); `query` is the URL's search params.
async function handleProject(req, res, projectDir, sub, query) {
  const method = req.method;
  const isState = method === 'GET' && sub === '/state';
  const isAgents = method === 'GET' && sub === '/agents';
  const isLanes = method === 'GET' && sub === '/lanes';
  const isCardCreate = method === 'POST' && sub === '/cards';
  const cm = /^\/cards\/([A-Za-z0-9_-]{1,64})$/.exec(sub);
  const sm = /^\/cards\/([A-Za-z0-9_-]{1,64})\/start$/.exec(sub);
  const tm = /^\/threads\/([A-Za-z0-9_-]{1,64})\/(messages|end|activity|report-request)$/.exec(sub);
  const threadRoute = tm ? `${method} ${tm[2]}` : '';
  const isActivity = threadRoute === 'GET activity';
  const rm = method === 'GET' ? /^\/cards\/([A-Za-z0-9_-]{1,64})\/runs\/([0-9]{1,6})\/(activity|prompt|report)$/.exec(sub) : null;
  const stopm = method === 'POST' ? /^\/cards\/([A-Za-z0-9_-]{1,64})\/runs\/([0-9]{1,6})\/stop$/.exec(sub) : null;
  const waitm = method === 'POST' ? /^\/cards\/([A-Za-z0-9_-]{1,64})\/waits\/([A-Za-z0-9_.-]{1,80})$/.exec(sub) : null;
  const notifym = method === 'POST' ? /^\/cards\/([A-Za-z0-9_-]{1,64})\/notify$/.exec(sub) : null;
  const isBatch = method === 'POST' && sub === '/waits/answer-batch';
  const known = isState || isAgents || isLanes || isCardCreate || !!rm || !!stopm || !!waitm || !!notifym || isBatch || (cm && (method === 'PATCH' || method === 'DELETE')) || (sm && method === 'POST') || THREAD_ROUTES.has(threadRoute);
  if (!known) {
    req.resume();
    send(res, 404, { error: 'not found' });
    return;
  }

  const viewOf = (card) => withViews(card, core.readConfig(projectDir), core.readState(projectDir).cards);
  const present = core.dirExists(projectDir);
  if (!isState && !isAgents && !isLanes && !isActivity && !rm && !present) {
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

  if (isLanes) {
    send(res, 200, await listLanesWithRelay(projectDir));
    return;
  }

  if (isCardCreate) {
    requireJson(req);
    const body = await readJsonBody(req);
    checkKeys(body, CREATE_KEYS);
    const args = pick(body, ['title', 'note', 'status', 'kind', 'parent']);
    Object.assign(args, cardFields(body));
    let card;
    try {
      card = await core.addCard(projectDir, { ...args, source: 'user' });
    } catch (e) {
      if (e && e.constructor === Error) e.message = e.message.replace(/\bblocked_by\b/g, 'blockedBy');
      throw e;
    }
    send(res, 201, viewOf(card));
    return;
  }

  if (cm && method === 'PATCH') {
    requireJson(req);
    const body = await readJsonBody(req);
    checkKeys(body, PATCH_KEYS);
    const args = pick(body, ['title', 'note', 'status', 'kind']);
    if (body.parent === null) args.parent = null; // null takes the card out of its milestone, like ''
    else Object.assign(args, pick(body, ['parent']));
    Object.assign(args, cardFields(body));
    let card;
    try {
      card = await core.updateCard(projectDir, cm[1], args, { source: 'user' });
    } catch (e) {
      // the core names the field as the MCP tool does (blocked_by); this API calls it blockedBy
      if (e && e.constructor === Error) e.message = e.message.replace(/\bblocked_by\b/g, 'blockedBy');
      throw e;
    }
    send(res, 200, viewOf(card));
    return;
  }
  if (cm && method === 'DELETE') {
    req.resume();
    await core.removeCard(projectDir, cm[1], { source: 'user' });
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

  if (rm) {
    // The page names a card and a run, never a path: the only file read is the transcript recorded on the run.
    const card = core.readState(projectDir).cards.find((c) => c.id === rm[1]);
    const n = Number(rm[2]);
    const run = card && Array.isArray(card.runs) ? card.runs.find((r) => r && r.n === n) : null;
    if (!run) throw new HttpError(404, `card ${rm[1]} has no run ${rm[2]}`);
    if (rm[3] !== 'activity') {
      send(res, 200, readRunText(projectDir, card.id, run, rm[3]));
      return;
    }
    const offset = Number(query.get('offset'));
    send(res, 200, runActivity(projectDir, card.id, run, Number.isInteger(offset) && offset > 0 ? offset : 0));
    return;
  }

  if (stopm) {
    // "Mark as stopped": writes only that run's own state fields
    requireJson(req);
    await readJsonBody(req);
    const card = core.readState(projectDir).cards.find((c) => c.id === stopm[1]);
    const n = Number(stopm[2]);
    if (!card || !Array.isArray(card.runs) || !card.runs.some((r) => r && r.n === n)) throw new HttpError(404, `card ${stopm[1]} has no run ${stopm[2]}`);
    await markRunStopped(projectDir, card.id, n);
    send(res, 200, viewOf(core.readState(projectDir).cards.find((c) => c.id === card.id)));
    return;
  }

  if (waitm) {
    // The user's answer to an item Claude is waiting on. Only the answer fields of an open item are written (see waits.mjs).
    requireJson(req);
    const body = await readJsonBody(req);
    const { card } = await core.answerWait(projectDir, waitm[1], waitm[2], body);
    send(res, 200, viewOf(card));
    return;
  }

  if (notifym) {
    // "Notify Claude": stores the request on a card that is new from the user (see notify.mjs); the hook or the waiter tells the session.
    requireJson(req);
    const body = await readJsonBody(req);
    const { session } = pick(body, ['session']);
    send(res, 200, viewOf(await core.requestNotify(projectDir, notifym[1], session)));
    return;
  }

  if (isBatch) {
    // All the answers the user has drafted, in one write (see answerWaits in waits.mjs).
    requireJson(req);
    const body = await readJsonBody(req, MAX_BATCH_BODY);
    const { applied, skipped, cards } = await core.answerWaits(projectDir, body.items);
    send(res, 200, { applied, skipped, cards: cards.map(viewOf) });
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
      open: 0,
      done: 0,
      waiting: 0,
      lastActivity: new Date().toISOString(),
    });
  }
  return { home: homeKey, projects: list };
}

// ---------------------------------------------------------------- the remote policy (the tunnel's listener)

// Everything the board's page and a person at the keyboard can do, minus what could start or steer a Claude process or lose data.
// The routes are the part of the path below /api/p/<key> (or below /api for the old routes without a project). Anything not listed
// is refused: a new route is closed to the tunnel until it is added here.
const RID = '[A-Za-z0-9_-]{1,64}';
const REMOTE_ROUTES = [
  ['GET', /^\/(state|agents|lanes)$/],
  ['GET', new RegExp(`^/threads/${RID}/activity$`)],
  ['GET', new RegExp(`^/cards/${RID}/runs/[0-9]{1,6}/(activity|prompt|report)$`)],
  ['POST', /^\/cards$/],                                                  // a new card
  ['PATCH', new RegExp(`^/cards/${RID}$`)],                                // an edit
  ['POST', new RegExp(`^/cards/${RID}/waits/[A-Za-z0-9_.-]{1,80}$`)],      // answer or close a waiting item
  ['POST', /^\/waits\/answer-batch$/],                                      // the drafted answers, sent together
  ['POST', new RegExp(`^/cards/${RID}/notify$`)],                          // "Notify Claude" about a card it has not seen
  ['POST', new RegExp(`^/threads/${RID}/report-request$`)],                // ask for a report to the main session
  ['DELETE', new RegExp(`^/threads/${RID}/report-request$`)],              // take it back
];

function remoteRouteAllowed(method, path) {
  if (method === 'GET' && (path === '/api/projects' || path === '/api/caps')) return true;
  const pm = /^\/api\/p\/([0-9a-f]{12})(\/.*)?$/.exec(path);
  let sub;
  if (pm) sub = pm[2] || '';
  else if (/^\/api\/(state|agents|cards|threads|waits)(\/|$)/.test(path)) sub = path.slice('/api'.length);
  else return false;
  return REMOTE_ROUTES.some(([m, re]) => m === method && re.test(sub));
}

// Runs first on the remote listener. Returns true when it has answered. The checks: the tunnel's own host (nothing sent by a proxy
// is believed, X-Forwarded-* included), the lifetime, the number of requests in flight, the tunnel token, the allowlist, and for a
// write the exact origin and a rate limit. Nothing here looks at the peer address: every request comes from the tunnel on loopback.
function remoteGate(req, res, remote, method, path) {
  const host = remote.host;
  if (!host || typeof req.headers.host !== 'string' || req.headers.host.toLowerCase() !== host) {
    req.resume();
    send(res, 403, { error: 'forbidden host' });
    return true;
  }
  if (remote.expired()) {
    req.resume();
    res.once('finish', () => remote.expire());   // ending the tunnel closes this connection, so only after the answer is out
    send(res, 401, { error: 'the tunnel has expired' });
    return true;
  }
  if (remote.inFlight >= remote.limits.concurrent) {
    req.resume();
    send(res, 503, { error: 'too many requests at once' }, { 'Retry-After': '2' });
    return true;
  }
  remote.inFlight++;
  res.once('close', () => { remote.inFlight--; });
  if (method === 'GET' && (path === '/' || path === '/api/ping')) return false;
  const deny = (status, error, headers) => { req.resume(); send(res, status, { error }, headers); return true; };
  if (!path.startsWith('/api/')) return deny(403, 'not allowed through the tunnel');
  if (!remote.tokenOk(req.headers['x-thread-token'])) return deny(401, 'missing or wrong board token');
  if (!remoteRouteAllowed(method, path)) return deny(403, 'not allowed through the tunnel');
  if (WRITE_METHODS.has(method)) {
    if (req.headers.origin !== 'https://' + host) return deny(403, 'forbidden origin');
    const t = remote.now();
    while (remote.writes.length && t - remote.writes[0] >= 60000) remote.writes.shift();
    if (remote.writes.length >= remote.limits.writesPerMinute) return deny(429, 'too many changes in a minute; wait a little', { 'Retry-After': '10' });
    remote.writes.push(t);
  }
  return false;
}

async function handleTunnelControl(req, res, tunnel) {
  requireJson(req);
  const body = await readJsonBody(req);
  const action = body.action;
  if (action !== 'start' && action !== 'status' && action !== 'stop') throw new HttpError(400, 'action must be start, status or stop');
  if (action === 'status') { send(res, 200, tunnel.status()); return; }
  if (action === 'stop') { const was = await tunnel.stop(); send(res, 200, { active: false, stopped: was }); return; }
  try {
    send(res, 200, await tunnel.start());
  } catch (e) {
    if (!(e instanceof TunnelError)) throw e;
    send(res, 502, { error: e.message, code: e.code });
  }
}

// `remote` is the policy of the tunnel's listener (null on the normal one); `tunnel` is the manager the normal listener controls.
function makeHandler(homeDir, token, stop, { remote = null, tunnel = null } = {}) {
  const requireToken = typeof token === 'string' && token.length > 0;
  return async function handle(req, res) {
    if (remote) {
      let early;
      try { early = remoteGate(req, res, remote, req.method, new URL(req.url, 'http://127.0.0.1').pathname); } catch { send(res, 400, { error: 'bad url' }); return; }
      if (early) return;
    } else if (!hostAllowed(req.headers.host)) {
      send(res, 403, { error: 'forbidden host' });
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, { error: 'bad url' }); return; }
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/') {
      try {
        const page = await assembleBoardPage();
        const html = page.replace('__THREAD_VERSION__', () => escapeAttribute(core.VERSION));
        send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
      } catch (e) {
        log('board page read failed:', e && e.message);
        send(res, 503, 'the board page could not be read');
      }
      return;
    }

    if (method === 'GET' && path === '/api/ping') {
      // the tunnel's listener says no more than the version: the data key names this machine's data folder
      send(res, 200, remote ? { app: 'thread-board', version: core.VERSION, remote: true } : { app: 'thread-board', version: core.VERSION, dataKey: dataKey() });
      return;
    }

    if (path.startsWith('/api/') && !remote) {
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

    // What this page may do: everything on the normal listener, the allowlist on the tunnel's.
    if (method === 'GET' && path === '/api/caps') {
      send(res, 200, remote ? { remote: true, expiresAt: remote.expiresAt } : { remote: false });
      return;
    }

    // Starts, shows or stops the tunnel: only on the normal listener (a guest session's board_open comes here, with the board token).
    if (method === 'POST' && path === '/api/tunnel' && !remote) {
      if (!tunnel) { req.resume(); send(res, 404, { error: 'not found' }); return; }
      await handleTunnelControl(req, res, tunnel);
      return;
    }

    // Stops only this web server; the process that owns it keeps running.
    if (method === 'POST' && path === '/api/shutdown' && !remote) {
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
      if (sub === '' && method === 'DELETE' && !remote) {
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

    if (path === '/api/state' || path === '/api/agents' || path === '/api/cards' || path.startsWith('/api/cards/') || path.startsWith('/api/threads/') || path.startsWith('/api/waits/')) {
      await handleProject(req, res, homeDir, path.slice('/api'.length), url.searchParams);
      return;
    }

    req.resume();
    send(res, 404, { error: 'not found' });
  };
}

// What the board page gets for a card. The status is the stage it is shown in (see
// core.effectiveStatus), a milestone carries its progress and state (msState), and a thread gets the parsed
// hand-back (free text, digest sections, step map) on each turn. It also carries workedBy, and verified: false for a
// card with acceptance criteria that sits in a finished stage (the done stage or a later one) without an approving review. Computed per response; never stored.
// `cards` are the project's stored cards, for the progress of a milestone.
function withViews(card, cfg, cards) {
  if (!card) return card;
  const view = { ...card, status: core.effectiveStatus(card, cfg) };
  // where the transcript of a sub-agent run lies stays on the server
  if (Array.isArray(view.runs)) view.runs = view.runs.filter((r) => r && typeof r === 'object').map(({ transcript, ...run }) => run);
  // an older plugin version can remove a milestone without clearing its cards
  if (view.parent && !cards.some((c) => c.id === view.parent && c.kind === 'milestone')) delete view.parent;
  if (card.kind === 'milestone') {
    view.progress = core.milestoneProgress(cards, card.id, cfg);
    view.msState = core.milestoneState(cards, card.id, cfg);
    return threadView(view);
  }
  // a card removed since it was named as a blocker is not shown
  if (view.blockedBy !== undefined) {
    const live = core.liveBlockers(card, cards);
    if (live.length) view.blockedBy = live; else delete view.blockedBy;
  }
  view.workedBy = core.workedBy(card);
  // an open "Notify Claude" request (notify.mjs): the card is unchanged since the click and the session picked has not listed the board; computed, never stored
  if (core.notifyActive(card)) view.notified = true;
  // criteria in a finished stage without an approving review: the board can move a card there, and so could an older plugin version
  // (and 0.11.0 turned cards into threads without checking for criteria, so a thread can carry them too)
  if (core.hasCriteria(card) && core.isFinished(card, cfg) && !core.reviewApproved(card, core.finishedStageIds(cfg))) view.verified = false;
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

function buildServer(handle) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError || e instanceof core.ChatOnlyError || e instanceof core.WaitError) send(res, e.status, { error: e.message });
      else if (e && e.message) send(res, 400, { error: String(e.message).split('\n')[0] });
      else send(res, 500, { error: 'internal error' });
    });
  });
  server.on('clientError', (err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch { /* ignore */ }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

// The tunnel's listener: the same handler under the remote policy, on a free port of its own. Not the board's port.
async function startRemoteListener(projectDir, policy) {
  const server = buildServer(makeHandler(projectDir, '', null, { remote: policy }));
  try {
    await listenOnce(server, 0);
  } catch (e) {
    try { server.close(); } catch { /* ignore */ }
    throw e;
  }
  server.on('error', (e) => log('remote listener error:', e && e.message));
  return { server, port: server.address().port };
}

/**
 * Starts the board's web server. `tunnel` holds test options for the tunnel manager (clock, lifetime, limits, timeouts).
 * Resolves { server, port, url, tunnel }: `tunnel` starts, shows and stops the Cloudflare tunnel for this board, and ends with it.
 */
export async function startBoardServer(projectDir, { port = 0, token, tunnel: tunnelOptions } = {}) {
  const tunnel = createTunnelManager({ serve: (policy) => startRemoteListener(projectDir, policy), ...tunnelOptions });
  const server = buildServer(makeHandler(projectDir, token, () => closeBoardServer(server), { tunnel }));

  try {
    await listenOnce(server, port);
  } catch (e) {
    try { server.close(); } catch { /* ignore */ }
    throw e;
  }
  server.on('error', (e) => log('server error:', e && e.message));
  // however the board ends (stopped, replaced by a newer version, its process exiting), its tunnel ends with it
  server.on('close', () => { tunnel.close().catch(() => {}); });
  core.sweepOrphanLogs(projectDir).catch(() => {});   // logs an older version left behind
  reapStaleTunnel().catch(() => {});                  // a cloudflared an owner that crashed left behind
  const actual = server.address().port;
  return { server, port: actual, url: `http://127.0.0.1:${actual}/`, tunnel };
}

export function closeBoardServer(server) {
  try { server.close(); server.closeAllConnections(); } catch { /* already closed */ }
}

// ---------------------------------------------------------------- shared board

// While this file exists no session starts or takes over the board; opening the board removes it.
const stoppedFile = () => join(core.dataDir(), 'board.stopped');
export function boardStopped() { return existsSync(stoppedFile()); }
export function setBoardStopped(on) {
  if (on) { core.mkdirPrivateSync(core.dataDir()); writeFileSync(stoppedFile(), '', { mode: core.PRIVATE_FILE }); }
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

/**
 * Ask the board at <base> to start, show or stop its tunnel (a guest session's way to the owner). Resolves { status, body }, or null
 * when the board cannot be reached. A board from a version before the tunnel answers 404.
 */
export function tunnelRequest(baseUrl, action) {
  return new Promise((resolveP) => {
    const payload = JSON.stringify({ action });
    let req;
    try {
      req = http.request(new URL('/api/tunnel', baseUrl), {
        method: 'POST',
        agent: false,
        timeout: 60000,   // starting the tunnel can take 30 s
        headers: { 'X-Thread-Token': boardToken(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 16384) res.destroy(); else chunks.push(c); });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          resolveP({ status: res.statusCode, body });
        });
        res.on('error', () => resolveP(null));
      });
    } catch {
      resolveP(null);
      return;
    }
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolveP(null));
    req.end(payload);
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
    core.mkdirPrivateSync(core.dataDir());
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
      return { url: b.url, owned: true, server: b.server, tunnel: b.tunnel };
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
            return { url: b.url, owned: true, server: b.server, tunnel: b.tunnel };
          } catch { await new Promise((r) => setTimeout(r, 50)); }
        }
        if (!(await pingBoard(url))) continue;   // someone else's port now
      }
      return { url, owned: false, server: null };
    }
  }
  throw new Error(`no board port available from ${base}${base ? ` to ${base + tries - 1}` : ''}${lastErr ? ': ' + lastErr.message : ''}`);
}
