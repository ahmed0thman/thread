// Shared multi-project board: project listing, scoped routes, token, origin, port sharing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { setupThreadEnv, cleanAmbientEnv, writeStateFile, emptyState, threadCard, runNode, waitFor, statePathFor, ROOT } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer, boardToken, ensureBoard } from '../server/http.mjs';

cleanAmbientEnv();
delete process.env.THREAD_DEPTH;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.THREAD_BOARD_PORT;

const JSON_HDR = { 'content-type': 'application/json' };
const keyOf = (dir) => crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function closeServer(server) {
  return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
}

/** A second project with its own folder, seeded with the given cards. */
function otherProject(e, name, cards = [], { create = true } = {}) {
  const dir = path.join(e.tmp || e.base, name);
  if (create) fs.mkdirSync(dir);
  writeStateFile(e.dataDir, dir, emptyState(dir, cards));
  return { dir, key: keyOf(dir) };
}

function card(over = {}) {
  return { id: 'c1', kind: 'task', title: 'T', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over };
}

async function boot(t, opts = {}) {
  const e = setupThreadEnv(t, opts.env);
  const b = await startBoardServer(e.projectDir, { port: 0, token: opts.token });
  t.after(() => closeServer(b.server));
  return { ...e, ...b, tmp: e.base, base: `http://127.0.0.1:${b.port}`, homeKey: keyOf(e.projectDir) };
}

function rawReq(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ------------------------------------------------------------ core: listing

test('projectKey equals the project data folder name', (t) => {
  const e = setupThreadEnv(t);
  assert.match(core.projectKey(e.projectDir), /^[0-9a-f]{12}$/);
  assert.equal(path.basename(core.projectPaths(e.projectDir).dir), core.projectKey(e.projectDir));
  assert.equal(core.projectKey(e.projectDir), keyOf(e.projectDir));
});

test('listProjects lists two projects newest first with counts and exists', (t) => {
  const e = setupThreadEnv(t);
  const older = otherProject(e, 'older', [
    card({ id: 'c1', updatedAt: '2026-01-02T00:00:00.000Z' }),
    threadCard({ id: 'c2', updatedAt: '2026-01-03T00:00:00.000Z' }, { runState: 'running', pid: 1 }),
  ]);
  const newer = otherProject(e, 'newer', [card({ updatedAt: '2026-06-01T00:00:00.000Z' })], { create: false });
  const list = core.listProjects();
  assert.deepEqual(list.map((p) => p.key), [newer.key, older.key]);
  const [n, o] = list;
  assert.deepEqual({ ...n }, { key: newer.key, projectDir: newer.dir, name: 'newer', exists: false, cards: 1, threads: 0, running: 0, lastActivity: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual({ ...o }, { key: older.key, projectDir: older.dir, name: 'older', exists: true, cards: 2, threads: 1, running: 1, lastActivity: '2026-01-03T00:00:00.000Z' });
  assert.equal(core.projectDirForKey(older.key), older.dir);
  assert.equal(core.projectDirForKey('0123456789ab'), null);
  assert.equal(core.projectDirForKey('../../etc'), null);
});

test('listProjects falls back to the state file mtime when a project has no cards', (t) => {
  const e = setupThreadEnv(t);
  const p = otherProject(e, 'empty');
  const mtime = fs.statSync(statePathFor(e.dataDir, p.dir)).mtimeMs;
  const [one] = core.listProjects();
  assert.equal(Date.parse(one.lastActivity), Math.floor(mtime) === mtime ? mtime : Date.parse(new Date(mtime).toISOString()));
});

test('listProjects skips a bad folder name, a corrupt state and a state that does not match its folder', (t) => {
  const e = setupThreadEnv(t);
  const good = otherProject(e, 'good', [card()]);
  const root = path.join(e.dataDir, 'projects');
  const goodState = fs.readFileSync(statePathFor(e.dataDir, good.dir), 'utf8');
  fs.mkdirSync(path.join(root, 'not-a-hex-key'), { recursive: true });
  fs.writeFileSync(path.join(root, 'not-a-hex-key', 'state.json'), goodState);
  fs.mkdirSync(path.join(root, 'ABCDEF012345'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ABCDEF012345', 'state.json'), goodState);
  fs.mkdirSync(path.join(root, '0123456789ab'), { recursive: true });
  fs.writeFileSync(path.join(root, '0123456789ab', 'state.json'), '{ not json');
  fs.mkdirSync(path.join(root, 'ba9876543210'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ba9876543210', 'state.json'), goodState); // another project's state
  fs.mkdirSync(path.join(root, 'aaaaaaaaaaaa'), { recursive: true }); // no state file
  assert.deepEqual(core.listProjects().map((p) => p.key), [good.key]);
  assert.equal(core.projectDirForKey('ba9876543210'), null);
});

test('listProjects returns [] for an empty or missing data dir and never throws', (t) => {
  const e = setupThreadEnv(t);
  assert.deepEqual(core.listProjects(), []);
  fs.mkdirSync(path.join(e.dataDir, 'projects'));
  assert.deepEqual(core.listProjects(), []);
  e.setEnv('THREAD_DATA_DIR', path.join(e.base, 'does-not-exist'));
  assert.deepEqual(core.listProjects(), []);
});

// ------------------------------------------------------------ core: forget

test('forgetProject refuses an existing folder, a running thread and an unknown key', async (t) => {
  const e = setupThreadEnv(t);
  const live = otherProject(e, 'live', [card()]);
  await assert.rejects(() => core.forgetProject(live.key), /still exists/);
  assert.ok(fs.existsSync(core.projectPaths(live.dir).dir));

  const busy = otherProject(e, 'busy', [threadCard({}, { runState: 'running', pid: process.pid, turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }] })]);
  fs.rmdirSync(busy.dir);
  await assert.rejects(() => core.forgetProject(busy.key), /still running/);
  assert.ok(fs.existsSync(core.projectPaths(busy.dir).dir));

  await assert.rejects(() => core.forgetProject('0123456789ab'), /unknown project/);
  await assert.rejects(() => core.forgetProject('../..'), /unknown project/);
  await assert.rejects(() => core.forgetProject(undefined), /unknown project/);
});

test('forgetProject removes the data folder of a project whose folder is gone', async (t) => {
  const e = setupThreadEnv(t);
  const gone = otherProject(e, 'gone', [card(), threadCard({ id: 'c2' })]);
  const keep = otherProject(e, 'keep', [card()]);
  fs.rmdirSync(gone.dir);
  fs.mkdirSync(path.join(core.projectPaths(gone.dir).dir, 'logs'));
  await core.forgetProject(gone.key);
  assert.equal(fs.existsSync(core.projectPaths(gone.dir).dir), false);
  assert.deepEqual(core.listProjects().map((p) => p.key), [keep.key]);
  assert.ok(fs.existsSync(core.projectPaths(keep.dir).state));
});

// ------------------------------------------------------------ http: ping, projects

test('GET /api/ping returns the app name, plugin version and data key without a token', async (t) => {
  const b = await boot(t, { token: 'secret-token' });
  const r = await fetch(b.base + '/api/ping');
  assert.equal(r.status, 200);
  const body = await r.json();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  assert.deepEqual(body, { app: 'thread-board', version, dataKey: crypto.createHash('sha1').update(path.resolve(b.dataDir)).digest('hex').slice(0, 12) });
});

test('GET /api/projects includes the home project even without a state file', async (t) => {
  const b = await boot(t);
  const other = otherProject(b, 'other', [card({ updatedAt: '2000-01-01T00:00:00.000Z' })]);
  const body = await (await fetch(b.base + '/api/projects')).json();
  assert.equal(body.home, b.homeKey);
  const home = body.projects.find((p) => p.key === b.homeKey);
  assert.ok(home);
  assert.equal(home.projectDir, b.projectDir);
  assert.equal(home.name, 'project');
  assert.equal(home.exists, true);
  assert.equal(home.cards, 0);
  assert.equal(home.threads, 0);
  assert.equal(home.running, 0);
  assert.ok(body.projects.some((p) => p.key === other.key));
  assert.equal(fs.existsSync(core.projectPaths(b.projectDir).state), false, 'listing must not create the home state file');
});

// ------------------------------------------------------------ http: scoped routes

test('scoped routes create, patch and delete a card in another project and leave home untouched', async (t) => {
  const b = await boot(t);
  await core.addCard(b.projectDir, { title: 'home card' });
  const other = otherProject(b, 'other');
  const p = `${b.base}/api/p/${other.key}`;

  const post = await fetch(p + '/cards', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ title: 'scoped' }) });
  assert.equal(post.status, 201);
  assert.equal((await post.json()).source, 'user');
  assert.equal(core.readState(other.dir).cards.length, 1);

  const patch = await fetch(p + '/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ status: 'review' }) });
  assert.equal(patch.status, 200);
  assert.equal(core.readState(other.dir).cards[0].status, 'review');

  const st = await (await fetch(p + '/state')).json();
  assert.equal(st.projectDir, other.dir);
  assert.equal(st.cards.length, 1);

  const homeState = core.readState(b.projectDir);
  assert.equal(homeState.cards.length, 1);
  assert.equal(homeState.cards[0].title, 'home card');
  assert.equal(homeState.cards[0].status, 'new');

  const del = await fetch(p + '/cards/c1', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(core.readState(other.dir).cards.length, 0);
  assert.equal(core.readState(b.projectDir).cards.length, 1);
});

test('the home key works as a scoped route, and unprefixed routes still act on home', async (t) => {
  const b = await boot(t);
  const r = await fetch(`${b.base}/api/p/${b.homeKey}/cards`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ title: 'via key' }) });
  assert.equal(r.status, 201);
  const s = await (await fetch(b.base + '/api/state')).json();
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0].title, 'via key');
});

test('an unknown or malformed project key answers 404 unknown project', async (t) => {
  const b = await boot(t);
  for (const key of ['0123456789ab', 'ABCDEF012345', 'short', '0123456789abcd', 'zzzzzzzzzzzz', '0123456789%61b']) {
    const r = await rawReq(b.port, { path: `/api/p/${key}/state` });
    assert.equal(r.status, 404, key);
    assert.deepEqual(JSON.parse(r.text), { error: 'unknown project' }, key);
    const w = await rawReq(b.port, { method: 'POST', path: `/api/p/${key}/cards`, headers: JSON_HDR, body: '{"title":"x"}' });
    assert.equal(w.status, 404, key);
  }
});

test('a thread follow-up through a scoped route runs in that project\'s folder without project env vars', async (t) => {
  const b = await boot(t);
  b.setEnv('THREAD_PROJECT_DIR', b.projectDir);
  b.setEnv('CLAUDE_PROJECT_DIR', b.projectDir);
  const other = otherProject(b, 'other', [threadCard()]);
  const r = await fetch(`${b.base}/api/p/${other.key}/threads/c1/messages`, { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ message: 'keep going' }) });
  assert.equal(r.status, 200, await r.clone().text());
  const log = await waitFor(() => { const l = b.readLog(); return l.length ? l : null; }, { timeout: 10000 });
  assert.equal(fs.realpathSync(log[0].cwd), fs.realpathSync(other.dir));
  assert.equal(log[0].threadProjectDir, undefined);
  assert.equal(log[0].claudeProjectDir, undefined);
  await waitFor(() => core.readState(other.dir).cards[0].thread.runState === 'idle', { timeout: 10000 });
  assert.equal(core.readState(b.projectDir).cards.length, 0);
});

// ------------------------------------------------------------ http: missing folder

test('a project whose folder is gone is read-only until it is forgotten', async (t) => {
  const b = await boot(t);
  const gone = otherProject(b, 'gone', [threadCard({ status: 'in_progress' }, {
    runState: 'running', pid: 2147483646,
    turns: [{ prompt: 'p', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, ok: null, result: null, error: null }],
  })]);
  fs.rmdirSync(gone.dir);
  const stateFile = core.projectPaths(gone.dir).state;
  const before = fs.statSync(stateFile);
  const beforeText = fs.readFileSync(stateFile, 'utf8');
  await new Promise((r) => setTimeout(r, 20));

  const p = `${b.base}/api/p/${gone.key}`;
  const read = await fetch(p + '/state');
  assert.equal(read.status, 200);
  const s = await read.json();
  assert.equal(s.exists, false);
  assert.equal(s.cards[0].thread.runState, 'running', 'must not reconcile');
  assert.equal(fs.statSync(stateFile).mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeText);

  const write = await fetch(p + '/cards', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ title: 'x' }) });
  assert.equal(write.status, 409);
  assert.deepEqual(await write.json(), { error: `project folder not found: ${gone.dir}` });
  const follow = await fetch(p + '/threads/c1/messages', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ message: 'hi' }) });
  assert.equal(follow.status, 409);
  const patch = await fetch(p + '/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ title: 'x' }) });
  assert.equal(patch.status, 409);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeText);
  assert.deepEqual(b.readLog(), []);

  const del = await fetch(p, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(fs.existsSync(core.projectPaths(gone.dir).dir), false);
  assert.equal((await fetch(p + '/state')).status, 404);
});

test('DELETE /api/p/<key> on a project whose folder exists answers 400', async (t) => {
  const b = await boot(t);
  const live = otherProject(b, 'live', [card()]);
  const r = await fetch(`${b.base}/api/p/${live.key}`, { method: 'DELETE' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /still exists/);
  const r2 = await fetch(`${b.base}/api/p/0123456789ab`, { method: 'DELETE' });
  assert.equal(r2.status, 400);
  assert.ok(fs.existsSync(core.projectPaths(live.dir).state));
});

// ------------------------------------------------------------ http: token

test('with a token set, API calls need the X-Thread-Token header; ping and the page do not', async (t) => {
  const b = await boot(t, { token: 'a'.repeat(32) });
  const routes = [
    ['GET', '/api/state'], ['GET', '/api/projects'], ['GET', `/api/p/${b.homeKey}/state`],
    ['POST', '/api/cards'], ['DELETE', '/api/cards/c1'], ['DELETE', `/api/p/${b.homeKey}`],
  ];
  for (const [method, p] of routes) {
    const none = await rawReq(b.port, { method, path: p, headers: JSON_HDR, body: method === 'POST' ? '{"title":"x"}' : undefined });
    assert.equal(none.status, 401, `${method} ${p}`);
    assert.deepEqual(JSON.parse(none.text), { error: 'missing or wrong board token' });
    const wrong = await rawReq(b.port, { method, path: p, headers: { ...JSON_HDR, 'x-thread-token': 'b'.repeat(32) }, body: method === 'POST' ? '{"title":"x"}' : undefined });
    assert.equal(wrong.status, 401, `${method} ${p} wrong`);
    const short = await rawReq(b.port, { method, path: p, headers: { ...JSON_HDR, 'x-thread-token': 'a' }, body: method === 'POST' ? '{"title":"x"}' : undefined });
    assert.equal(short.status, 401, `${method} ${p} short`);
  }
  assert.equal(core.readState(b.projectDir).cards.length, 0);
  const H = { 'X-Thread-Token': 'a'.repeat(32) };
  assert.equal((await fetch(b.base + '/api/state', { headers: H })).status, 200);
  assert.equal((await fetch(b.base + '/api/projects', { headers: H })).status, 200);
  assert.equal((await fetch(b.base + '/api/cards', { method: 'POST', headers: { ...H, ...JSON_HDR }, body: '{"title":"ok"}' })).status, 201);
  assert.equal((await fetch(b.base + '/api/ping')).status, 200);
  const page = await fetch(b.base + '/');
  assert.notEqual(page.status, 401);
});

test('without a token set, nothing is required', async (t) => {
  const b = await boot(t);
  assert.equal((await fetch(b.base + '/api/state')).status, 200);
  assert.equal((await fetch(b.base + '/api/projects')).status, 200);
  const b2 = await startBoardServer(b.projectDir, { port: 0, token: '' });
  t.after(() => closeServer(b2.server));
  assert.equal((await fetch(`http://127.0.0.1:${b2.port}/api/state`)).status, 200);
});

// ------------------------------------------------------------ http: origin

test('a write with a foreign Origin answers 403; own origin and no Origin pass', async (t) => {
  const b = await boot(t);
  const post = (origin) => fetch(b.base + '/api/cards', { method: 'POST', headers: { ...JSON_HDR, ...(origin ? { Origin: origin } : {}) }, body: '{"title":"o"}' });
  assert.equal((await post('http://evil.example')).status, 403);
  assert.equal((await post(`http://evil.example:${b.port}`)).status, 403);
  assert.equal((await post(`http://127.0.0.1:${b.port + 1}`)).status, 403);
  assert.equal((await post('null')).status, 403);
  assert.equal(core.readState(b.projectDir).cards.length, 0);
  assert.equal((await post(`http://127.0.0.1:${b.port}`)).status, 201);
  assert.equal((await post(`http://localhost:${b.port}`)).status, 201);
  assert.equal((await post()).status, 201);
  const del = await fetch(b.base + '/api/cards/c1', { method: 'DELETE', headers: { Origin: 'http://evil.example' } });
  assert.equal(del.status, 403);
  assert.equal(core.readState(b.projectDir).cards.length, 3);
});

// ------------------------------------------------------------ boardToken

test('boardToken creates a 0600 file once and returns the same value later and from another process', async (t) => {
  const e = setupThreadEnv(t);
  const file = path.join(e.dataDir, 'board.token');
  assert.equal(fs.existsSync(file), false);
  const a = boardToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(boardToken(), a);
  const script = `import('${path.join(ROOT, 'server', 'http.mjs')}').then((m) => process.stdout.write(m.boardToken()))`;
  const r = await runNode(['-e', script], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } });
  assert.equal(r.stdout, a);
  assert.deepEqual(fs.readdirSync(e.dataDir).filter((n) => n.includes('.tmp')), []);
});

test('processes starting together end up with the same token, and an invalid token file is regenerated', async (t) => {
  const e = setupThreadEnv(t);
  const script = `import('${path.join(ROOT, 'server', 'http.mjs')}').then((m) => process.stdout.write(m.boardToken()))`;
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => runNode(['-e', script], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir } })));
  const tokens = new Set(runs.map((r) => r.stdout));
  assert.equal(tokens.size, 1, [...tokens].join(','));
  assert.match([...tokens][0], /^[0-9a-f]{32}$/);

  fs.writeFileSync(path.join(e.dataDir, 'board.token'), 'short');
  const fresh = boardToken();
  assert.match(fresh, /^[0-9a-f]{32}$/);
  assert.equal(fs.readFileSync(path.join(e.dataDir, 'board.token'), 'utf8').trim(), fresh);
  fs.writeFileSync(path.join(e.dataDir, 'board.token'), 'z'.repeat(40));
  assert.match(boardToken(), /^[0-9a-f]{32}$/);
});

// ------------------------------------------------------------ ensureBoard

test('ensureBoard owns a free port, a second call adopts it, and a later call takes it over', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const first = await ensureBoard(e.projectDir, { port });
  let open = first.server;
  t.after(async () => { if (open) await closeServer(open); });
  assert.equal(first.owned, true);
  assert.equal(first.url, `http://127.0.0.1:${port}/`);

  const second = await ensureBoard(e.projectDir, { port });
  assert.equal(second.owned, false);
  assert.equal(second.server, null);
  assert.equal(second.url, first.url);

  // the shared board answers with the token that boardToken() hands out
  assert.equal((await fetch(first.url + 'api/state')).status, 401);
  assert.equal((await fetch(first.url + 'api/state', { headers: { 'X-Thread-Token': boardToken() } })).status, 200);

  await closeServer(first.server);
  open = null;
  const third = await ensureBoard(e.projectDir, { port });
  open = third.server;
  assert.equal(third.owned, true);
  assert.equal(third.url, first.url);
});

test('ensureBoard moves to the next port when the port is held by something else', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const stranger = http.createServer((req, res) => { res.end('hello'); });
  await new Promise((r) => stranger.listen(port, '127.0.0.1', r));
  t.after(() => closeServer(stranger));
  const b = await ensureBoard(e.projectDir, { port });
  t.after(() => b.server && closeServer(b.server));
  assert.equal(b.owned, true);
  const got = Number(new URL(b.url).port);
  assert.ok(got > port && got < port + 20, `got ${got}`);

  const impostor = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ app: 'something-else' })); });
  const p2 = await freePort();
  await new Promise((r) => impostor.listen(p2, '127.0.0.1', r));
  t.after(() => closeServer(impostor));
  const c = await ensureBoard(e.projectDir, { port: p2 });
  t.after(() => c.server && closeServer(c.server));
  assert.equal(c.owned, true);
  assert.notEqual(new URL(c.url).port, String(p2));
});

test('THREAD_BOARD_PORT sets the base port', async (t) => {
  const port = await freePort();
  const e = setupThreadEnv(t, { THREAD_BOARD_PORT: String(port) });
  const b = await ensureBoard(e.projectDir);
  t.after(() => closeServer(b.server));
  assert.equal(b.url, `http://127.0.0.1:${port}/`);
});

// ------------------------------------------------------------ MCP

test('board_open through the MCP server returns ?t= and #/<key>, and says unavailable with THREAD_NO_HTTP=1', async (t) => {
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const e = setupThreadEnv(t);
  const port = await freePort();
  async function openBoard(extraEnv) {
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp.mjs')], {
      env: { ...process.env, THREAD_PROJECT_DIR: e.projectDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    t.after(() => child.kill('SIGKILL'));
    child.stdin.on('error', () => {});
    const pending = new Map();
    readline.createInterface({ input: child.stdout }).on('line', (l) => { try { const m = JSON.parse(l); pending.get(m.id)?.(m); } catch { /* ignore */ } });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply to ' + method)), 8000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const r = await rpc(2, 'tools/call', { name: 'board_open', arguments: {} });
    child.kill('SIGKILL');
    return r.result.content[0].text;
  }
  const on = await openBoard({ THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port) });
  assert.match(on, new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?t=[0-9a-f]{32}#/${keyOf(e.projectDir)}`));
  const off = await openBoard({ THREAD_NO_HTTP: '1' });
  assert.match(off, /disabled|unavailable/i);
  assert.doesNotMatch(off, /\?t=/);
});
