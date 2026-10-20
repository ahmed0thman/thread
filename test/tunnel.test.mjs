// The Cloudflare tunnel (/thread:board --tunnel): the manager, the remote listener and its allowlist, the limits, the control route a
// guest session uses, and the tool. cloudflared is test/fixtures/fake-cloudflared.mjs; nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import {
  PARENT_SESSION, setupThreadEnv, cleanAmbientEnv, McpClient, freePort, waitFor, sleep, isAlive, writeStateFile, emptyState, threadCard, TEST_DIR, FAKE_DELEGATE,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { addWait } from '../server/waits.mjs';
import { startBoardServer, boardToken, tunnelRequest, pingBoard, closeBoardServer } from '../server/http.mjs';
import { findCloudflared, installHelp, parseTunnelHost, redact, reapStaleTunnel, TunnelError } from '../server/tunnel.mjs';

cleanAmbientEnv();
delete process.env.THREAD_BOARD_PORT;

const FAKE = path.join(TEST_DIR, 'fixtures', 'fake-cloudflared.mjs');
const JSON_HDR = { 'content-type': 'application/json' };
const HOST = 'quiet-fake-tunnel-test.trycloudflare.com';

/** Raw HTTP, so the Host header and the path are exactly what a test says. */
function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The board on port 0 with a token, the fake cloudflared, and everything stopped after the test. */
async function boot(t, { tunnel = {}, mode, host } = {}) {
  const e = setupThreadEnv(t);
  const cfLog = path.join(e.base, 'cloudflared.log');
  e.setEnv('THREAD_CLOUDFLARED_BIN', FAKE);
  e.setEnv('FAKE_CLOUDFLARED_LOG', cfLog);
  e.setEnv('FAKE_CLOUDFLARED_MODE', mode);
  e.setEnv('FAKE_CLOUDFLARED_HOST', host);
  const token = boardToken();
  const b = await startBoardServer(e.projectDir, { port: 0, token, tunnel });
  const spawned = () => {
    try { return fs.readFileSync(cfLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  t.after(async () => {
    await b.tunnel.stop();
    for (const c of spawned()) try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
    closeBoardServer(b.server);
  });
  const key = core.projectKey(e.projectDir);
  return { ...e, ...b, token, key, spawned, base: `http://127.0.0.1:${b.port}` };
}

/** Starts the tunnel and returns what a client needs: the fake's listener port, the host, the tunnel token and the origin. */
async function open(b) {
  const view = await b.tunnel.start();
  const last = b.spawned().at(-1);
  const remotePort = Number(/:(\d+)$/.exec(last.argv[3])[1]);
  const origin = `https://${view.host}`;
  const get = (p, over = {}) => raw(remotePort, { path: p, headers: { host: view.host, 'x-thread-token': view.token, ...over } });
  const write = (method, p, body, over = {}) => raw(remotePort, {
    method, path: p, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: view.host, 'x-thread-token': view.token, origin, ...(body === undefined ? {} : JSON_HDR), ...over },
  });
  return { view, remotePort, origin, get, write, child: last };
}

// ---------------------------------------------------------------- pure pieces

test('the address is read from cloudflared output; api.trycloudflare.com and other URLs are not it', () => {
  assert.equal(parseTunnelHost('INF |  https://Quiet-Words-Here.trycloudflare.com  |'), 'quiet-words-here.trycloudflare.com');
  assert.equal(parseTunnelHost('Post "https://api.trycloudflare.com/tunnel": dial tcp'), null);
  assert.equal(parseTunnelHost('see https://developers.cloudflare.com/cloudflare-one/'), null);
  assert.equal(parseTunnelHost('https://evil.com/https://a-b.trycloudflare.com.evil.com'), null);
  assert.equal(parseTunnelHost(''), null);
});

test('long token-like strings are redacted from diagnostics', () => {
  assert.equal(redact(`token ${'a'.repeat(64)} and ${'AbC_-'.repeat(8)} end`), 'token [redacted] and [redacted] end');
  assert.equal(redact('short words stay'), 'short words stay');
});

test('the missing-binary message names the install for each system and does not promise apt', () => {
  assert.match(installHelp('darwin'), /brew install cloudflared/);
  assert.match(installHelp('win32'), /winget install --id Cloudflare\.cloudflared/);
  const linux = installHelp('linux');
  assert.match(linux, /package repository/);
  assert.match(linux, /https:\/\/developers\.cloudflare\.com\/tunnel\/downloads\//);
  assert.doesNotMatch(linux, /apt install cloudflared/);
  for (const p of ['darwin', 'win32', 'linux']) {
    assert.match(installHelp(p), /Then run \/thread:board --tunnel again\./);
    assert.match(installHelp(p), /no Cloudflare account/);
  }
});

test('cloudflared is found by THREAD_CLOUDFLARED_BIN alone, then on PATH; nothing is downloaded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-cf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(findCloudflared({ THREAD_CLOUDFLARED_BIN: FAKE }), FAKE);
  assert.equal(findCloudflared({ THREAD_CLOUDFLARED_BIN: path.join(dir, 'nope'), PATH: path.dirname(FAKE) }), null, 'the test variable decides alone');
  const bin = path.join(dir, 'cloudflared');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findCloudflared({ PATH: dir }, 'linux'), bin);
  fs.chmodSync(bin, 0o644);
  if (process.platform !== 'win32') assert.notEqual(findCloudflared({ PATH: dir }, 'linux'), bin, 'a file that cannot run is not it');
});

// ---------------------------------------------------------------- the manager

test('start, status and stop; a repeated start returns the same link and does not extend it', async (t) => {
  let clock = 1_000_000;
  const b = await boot(t, { tunnel: { now: () => clock } });
  assert.deepEqual(b.tunnel.status(), { active: false });
  const a = await open(b);
  assert.equal(a.view.reused, false);
  assert.equal(a.view.host, HOST);
  assert.equal(a.view.url, `https://${HOST}/`);
  assert.match(a.view.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.view.token, b.token);
  assert.equal(a.view.expiresAt, 1_000_000 + 12 * 3600 * 1000);
  assert.deepEqual(b.spawned()[0].argv.slice(0, 3), ['tunnel', '--no-autoupdate', '--url']);
  assert.notEqual(a.remotePort, b.port, 'the tunnel points at its own listener, not the board port');
  assert.match(b.spawned()[0].argv[3], /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(isAlive(a.child.pid), true);
  const pidFile = path.join(b.dataDir, 'tunnel.pid');
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(rec.cloudflared, a.child.pid, 'the record names cloudflared, its watchdog and its owner');
  assert.notEqual(rec.pid, a.child.pid);
  assert.equal(isAlive(rec.pid), true);
  assert.equal(rec.owner, process.pid);
  if (process.platform !== 'win32') assert.equal(fs.statSync(pidFile).mode & 0o777, 0o600);

  clock += 3600 * 1000;
  const again = await b.tunnel.start();
  assert.equal(again.reused, true);
  assert.equal(again.token, a.view.token);
  assert.equal(again.expiresAt, a.view.expiresAt, 'asking again does not extend it');
  assert.equal(b.spawned().length, 1, 'no second cloudflared');
  assert.deepEqual(b.tunnel.status(), again);

  assert.equal(await b.tunnel.stop(), true);
  assert.equal(await b.tunnel.stop(), false);
  assert.deepEqual(b.tunnel.status(), { active: false });
  await waitFor(() => !isAlive(a.child.pid));
  await waitFor(() => !isAlive(rec.pid));
  assert.equal(fs.existsSync(pidFile), false);
  await assert.rejects(() => raw(a.remotePort, { path: '/' }), 'the remote listener is closed');
  // after a stop the old token is dead: a new tunnel gets a new one
  const next = await b.tunnel.start();
  assert.notEqual(next.token, a.view.token);
});

test('two starts at once share one cloudflared', async (t) => {
  const b = await boot(t);
  const [x, y] = await Promise.all([b.tunnel.start(), b.tunnel.start()]);
  assert.equal(x.token, y.token);
  assert.equal(b.spawned().length, 1);
});

test('without cloudflared the start says how to install it, and starts nothing', async (t) => {
  const b = await boot(t);
  process.env.THREAD_CLOUDFLARED_BIN = path.join(b.base, 'no-such-cloudflared');
  await assert.rejects(() => b.tunnel.start(), (e) => e instanceof TunnelError && e.code === 'missing' && /Then run \/thread:board --tunnel again\./.test(e.message) && e.message.includes(installHelp()));
  assert.deepEqual(b.tunnel.status(), { active: false });
  // and through the control route
  const r = await tunnelRequest(b.url, 'start');
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'missing');
  assert.match(r.body.error, /not installed/);
});

test('a start that gets no address times out with a clear message and cleans up', async (t) => {
  const b = await boot(t, { mode: 'silent', tunnel: { startTimeoutMs: 300 } });
  await assert.rejects(() => b.tunnel.start(), (e) => e.code === 'timeout' && /did not give a tunnel address within/.test(e.message) && /7844/.test(e.message));
  assert.deepEqual(b.tunnel.status(), { active: false });
  await waitFor(() => !isAlive(b.spawned()[0].pid));
  assert.equal(fs.existsSync(path.join(b.dataDir, 'tunnel.pid')), false);
});

test('a cloudflared that stops at once is reported with its last output', async (t) => {
  const b = await boot(t, { mode: 'exit' });
  await assert.rejects(() => b.tunnel.start(), (e) => e.code === 'failed' && /stopped before the tunnel was ready/.test(e.message) && /no such host/.test(e.message));
});

test('a tunnel that never says it is connected still opens after the settle time', async (t) => {
  const b = await boot(t, { mode: 'noconn', tunnel: { settleMs: 100 } });
  const v = await b.tunnel.start();
  assert.equal(v.host, HOST);
});

test('the tunnel ends when its cloudflared dies', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  process.kill(a.child.pid, 'SIGKILL');
  await waitFor(() => b.tunnel.status().active === false);
  await assert.rejects(() => raw(a.remotePort, { path: '/' }));
});

test('closing the board ends the tunnel: token revoked, listener closed, cloudflared killed', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  assert.equal((await a.get('/api/state')).status, 200);
  closeBoardServer(b.server);
  await waitFor(() => !isAlive(a.child.pid));
  await waitFor(() => b.tunnel.status().active === false);
  await assert.rejects(() => raw(a.remotePort, { path: '/' }));
  assert.equal(fs.existsSync(path.join(b.dataDir, 'tunnel.pid')), false);
});

test('the lifetime ends the tunnel by itself', async (t) => {
  const b = await boot(t, { tunnel: { lifetimeMs: 400 } });
  const a = await open(b);
  await waitFor(() => b.tunnel.status().active === false, { timeout: 4000 });
  await waitFor(() => !isAlive(a.child.pid));
});

test('a board that has closed starts no tunnel', async (t) => {
  const b = await boot(t);
  if (b.server.listening) {
    const closed = new Promise((r) => b.server.once('close', r));
    closeBoardServer(b.server);
    await closed;
  }
  await assert.rejects(() => b.tunnel.start(), (e) => e instanceof TunnelError && /board has stopped/.test(e.message));
  assert.equal(b.spawned().length, 0);
  assert.equal(b.tunnel.status().active, false);
});

test('the expiry is also read off the clock, for a computer that slept', async (t) => {
  let clock = Date.now();
  const b = await boot(t, { tunnel: { now: () => clock, lifetimeMs: 60 * 60 * 1000, expiryCheckMs: 100 } });
  const a = await open(b);
  await sleep(300);
  assert.equal(b.tunnel.status().active, true);
  clock += 61 * 60 * 1000;   // the timer did not run while the lid was shut
  await waitFor(() => b.tunnel.status().active === false, { timeout: 4000 });
  await waitFor(() => !isAlive(a.child.pid));
});

test('a cloudflared left by a crashed owner is killed at the next start, but a stranger\'s process is not', async (t) => {
  const e = setupThreadEnv(t);
  const stale = spawn(process.execPath, [FAKE, 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:9'], { stdio: 'ignore' });
  const stranger = spawn(process.execPath, [FAKE, 'tunnel', '--url', 'http://127.0.0.1:9'], { stdio: 'ignore' });   // cloudflared, but not with our arguments
  t.after(() => { stale.kill('SIGKILL'); stranger.kill('SIGKILL'); });
  await waitFor(() => stale.pid && stranger.pid);
  const file = path.join(e.dataDir, 'tunnel.pid');
  fs.writeFileSync(file, JSON.stringify({ pid: stranger.pid }));
  assert.equal(await reapStaleTunnel(), false);
  assert.equal(isAlive(stranger.pid), true, 'a process that is not our cloudflared is left alone');
  assert.equal(fs.existsSync(file), false, 'the record is dropped either way');
  fs.writeFileSync(file, JSON.stringify({ pid: stale.pid }));   // a record from a version before owners were recorded
  assert.equal(await reapStaleTunnel(), true);
  await waitFor(() => !isAlive(stale.pid));
  fs.writeFileSync(file, 'not json');
  assert.equal(await reapStaleTunnel(), false);
});

// ---------------------------------------------------------------- the remote listener

test('the remote listener takes the tunnel token only; the board token and a missing token are refused', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  assert.equal((await a.get('/api/state')).status, 200);
  const persistent = await a.get('/api/state', { 'x-thread-token': b.token });
  assert.equal(persistent.status, 401);
  assert.equal(persistent.json.error, 'missing or wrong board token');
  assert.equal((await a.get('/api/state', { 'x-thread-token': '' })).status, 401);
  assert.equal((await a.get('/api/state', { 'x-thread-token': a.view.token.slice(0, -1) + (a.view.token.endsWith('0') ? '1' : '0') })).status, 401);
  assert.equal((await a.get('/api/projects', { 'x-thread-token': b.token })).status, 401);
  // the board token does not open the write routes either
  assert.equal((await a.write('POST', `/api/p/${b.key}/cards`, { title: 'x' }, { 'x-thread-token': b.token })).status, 401);
  assert.equal(core.readState(b.projectDir).cards.length, 0);
});

test('the normal listener refuses the tunnel token', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const r = await raw(b.port, { path: '/api/state', headers: { host: `127.0.0.1:${b.port}`, 'x-thread-token': a.view.token } });
  assert.equal(r.status, 401);
  assert.equal((await raw(b.port, { path: '/api/state', headers: { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token } })).status, 200);
});

test('the remote listener checks the tunnel host exactly and believes no forwarding header', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const as = (host, extra = {}) => a.get('/api/state', { host, ...extra });
  assert.equal((await as(`127.0.0.1:${a.remotePort}`)).status, 403);
  assert.equal((await as('localhost')).status, 403);
  assert.equal((await as('evil.trycloudflare.com')).status, 403);
  assert.equal((await as(`${HOST}.evil.com`)).status, 403);
  assert.equal((await as(`x.${HOST}`)).status, 403);
  assert.equal((await as(`${HOST}:8080`)).status, 403);
  assert.equal((await as(`127.0.0.1:${a.remotePort}`, { 'x-forwarded-host': HOST })).status, 403, 'X-Forwarded-Host grants nothing');
  assert.equal((await as(`127.0.0.1:${a.remotePort}`, { forwarded: `host=${HOST}`, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' })).status, 403);
  assert.equal((await as(HOST.toUpperCase())).status, 200, 'host names are not case sensitive');
  assert.equal((await raw(a.remotePort, { path: '/', headers: { host: 'evil.example' } })).status, 403, 'not even the page');
});

test('the remote listener serves the page without a token, with no-referrer and no-store, and a caps answer that says remote', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const page = await raw(a.remotePort, { path: '/', headers: { host: HOST } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['cache-control'], /no-store/);
  const ping = await raw(a.remotePort, { path: '/api/ping', headers: { host: HOST } });
  assert.deepEqual(Object.keys(ping.json).sort(), ['app', 'remote', 'version'], 'no data key on the tunnel');
  const caps = await a.get('/api/caps');
  assert.deepEqual(caps.json, { remote: true, expiresAt: a.view.expiresAt });
  assert.equal((await raw(a.remotePort, { path: '/api/caps', headers: { host: HOST } })).status, 401);
  const local = await raw(b.port, { path: '/api/caps', headers: { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token } });
  assert.deepEqual(local.json, { remote: false });
  const localPage = await raw(b.port, { path: '/', headers: { host: `127.0.0.1:${b.port}` } });
  assert.equal(localPage.headers['referrer-policy'], 'no-referrer');
  assert.equal((await raw(a.remotePort, { path: '/favicon.ico', headers: { host: HOST } })).status, 403, 'nothing else is served');
});

test('a write over the tunnel needs the exact origin of the tunnel', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const path_ = `/api/p/${b.key}/cards`;
  const noOrigin = await raw(a.remotePort, { method: 'POST', path: path_, body: '{"title":"x"}', headers: { host: HOST, 'x-thread-token': a.view.token, ...JSON_HDR } });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json.error, 'forbidden origin');
  for (const origin of ['http://127.0.0.1:' + a.remotePort, 'http://localhost', `http://${HOST}`, `https://${HOST}:444`, `https://x.${HOST}`, 'https://evil.com', 'null', `https://${HOST}.evil.com`]) {
    assert.equal((await a.write('POST', path_, { title: 'x' }, { origin })).status, 403, origin);
  }
  assert.equal(core.readState(b.projectDir).cards.length, 0);
  const ok = await a.write('POST', path_, { title: 'From the phone' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.source, 'user');
  assert.equal(core.readState(b.projectDir).cards.length, 1);
  // a read needs no origin
  assert.equal((await a.get('/api/state')).status, 200);
});

// ---------------------------------------------------------------- the allowlist

function seedThread(b) {
  const gone = threadCard({ id: 'c2', title: 'A thread', status: 'review' });
  writeStateFile(b.dataDir, b.projectDir, emptyState(b.projectDir, [
    { id: 'c1', kind: 'task', title: 'A task', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x' },
    gone,
  ]));
}

test('over the tunnel a person can read, edit, answer and ask for a report, but never start, steer, end or delete anything', async (t) => {
  const b = await boot(t);
  seedThread(b);
  const w = await addWait(b.projectDir, { card: 'c1', kind: 'question', text: 'Which retry limit?', sessionId: PARENT_SESSION });
  const a = await open(b);
  const P = `/api/p/${b.key}`;
  const ok = async (res, status = 200) => { assert.equal(res.status, status, `${res.status} ${res.text}`); return res; };

  // reads, project-prefixed and old routes
  await ok(await a.get('/api/projects'));
  await ok(await a.get(`${P}/state`));
  await ok(await a.get('/api/state'));
  await ok(await a.get('/api/agents'));
  await ok(await a.get(`${P}/agents`));
  await ok(await a.get(`${P}/lanes`));
  assert.notEqual((await a.get(`${P}/threads/c2/activity?turn=1`)).status, 403);
  assert.notEqual((await a.get(`${P}/cards/c1/runs/1/activity`)).status, 403);

  // writes that are allowed
  const made = await ok(await a.write('POST', `${P}/cards`, { title: 'New from the phone' }), 201);
  await ok(await a.write('POST', '/api/cards', { title: 'Old route' }), 201);
  await ok(await a.write('PATCH', `${P}/cards/${made.json.id}`, { title: 'Edited' }));
  await ok(await a.write('PATCH', `/api/cards/${made.json.id}`, { note: 'Edited on the old route' }));
  const answered = await ok(await a.write('POST', `${P}/cards/c1/waits/${w.item.id}`, { text: 'Three.' }));
  assert.equal(answered.json.waits.find((x) => x.id === w.item.id).state, 'answered');
  // "Notify Claude" on a card that is new from the user, and the drafted answers sent together: both on both route shapes
  await core.touchSession(b.projectDir, PARENT_SESSION);
  const notified = await ok(await a.write('POST', `${P}/cards/${made.json.id}/notify`, { session: PARENT_SESSION }));
  assert.equal(notified.json.notified, true);
  await ok(await a.write('POST', `/api/cards/${made.json.id}/notify`, { session: PARENT_SESSION }));
  assert.equal(core.readState(b.projectDir).cards.find((c) => c.id === made.json.id).notifySession, PARENT_SESSION);
  const w2 = await addWait(b.projectDir, { card: 'c1', kind: 'todo', text: 'Run it', sessionId: PARENT_SESSION });
  const w3 = await addWait(b.projectDir, { card: 'c1', kind: 'question', text: 'Why?', sessionId: PARENT_SESSION });
  const batch = await ok(await a.write('POST', `${P}/waits/answer-batch`, { items: [{ id: w2.item.id, done: true }] }));
  assert.deepEqual(batch.json.applied, [w2.item.id]);
  await ok(await a.write('POST', '/api/waits/answer-batch', { items: [{ id: w3.item.id, text: 'because' }] }));
  assert.equal(core.waitsOf(core.readState(b.projectDir).cards.find((c) => c.id === 'c1')).filter((x) => x.state === 'answered').length, 3);
  await ok(await a.write('POST', `${P}/threads/c2/report-request`, {}));
  assert.ok(core.readState(b.projectDir).cards.find((c) => c.id === 'c2').thread.reportRequestedAt);
  await ok(await a.write('DELETE', `${P}/threads/c2/report-request`));
  await ok(await a.write('POST', '/api/threads/c2/report-request', {}));

  // everything else is refused, whether or not the route exists
  const denied = [
    ['POST', `${P}/cards/c1/start`, { sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
    ['POST', '/api/cards/c1/start', { sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }],
    ['POST', `${P}/threads/c2/messages`, { message: 'do it' }],
    ['POST', '/api/threads/c2/messages', { message: 'do it' }],
    ['POST', `${P}/threads/c2/end`, {}],
    ['POST', '/api/threads/c2/end', {}],
    ['DELETE', `${P}/cards/c1`],
    ['DELETE', '/api/cards/c1'],
    ['DELETE', `${P}/cards/c2`],
    ['POST', '/api/shutdown', {}],
    ['DELETE', `${P}`],
    ['DELETE', `/api/p/${'0'.repeat(12)}`],
    ['POST', `${P}/cards/c1/runs/1/stop`, {}],
    ['POST', '/api/tunnel', { action: 'stop' }],
    ['POST', '/api/tunnel', { action: 'start' }],
    ['PUT', `${P}/cards/c1`, {}],
    ['POST', `${P}/cards/c1`, {}],
    ['GET', '/api/nothing-here'],
    ['GET', `${P}/nothing-here`],
    ['DELETE', '/api/projects'],
    ['POST', '/api/state', {}],
  ];
  for (const [method, p, body] of denied) {
    const r = await a.write(method, p, body);
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status} ${r.text}`);
    assert.equal(r.json.error, 'not allowed through the tunnel', `${method} ${p}`);
  }
  // and nothing happened
  const after = core.readState(b.projectDir);
  assert.ok(after.cards.find((c) => c.id === 'c1'));
  assert.equal(after.cards.find((c) => c.id === 'c2').thread.runState, 'idle');
  assert.equal(after.cards.find((c) => c.id === 'c2').thread.turns.length, 1);
  assert.equal(b.server.listening, true, 'shutdown did not stop the board');
  assert.equal(b.tunnel.status().active, true);
  assert.deepEqual((await pingBoard(b.url)).app, 'thread-board');
  assert.ok(core.listProjects().some((p) => p.key === b.key), 'the project is still listed');
  // a denied route is refused before the body is read, so an oversized body gets the same answer
  assert.equal((await a.write('POST', `${P}/threads/c2/messages`, { message: 'x'.repeat(100000) })).status, 403);
});

test('over the tunnel a lane cannot be set, changed or removed, and a refused save writes nothing; on the normal listener it can', async (t) => {
  const b = await boot(t);
  b.setEnv('THREAD_DELEGATE_DIR', FAKE_DELEGATE);   // the fake delegate skills, never the real ones
  b.setEnv('FAKE_DELEGATE_MODE', 'ok');
  seedThread(b);
  const a = await open(b);
  const P = `/api/p/${b.key}`;
  const stored = () => JSON.stringify(core.readState(b.projectDir).cards.find((c) => c.id === 'c1'));
  const before = stored();
  for (const body of [{ lane: 'code-codex' }, { lane: 'code-codex', title: 'Also renamed' }, { lane: null }, { lane: '' }, { lane: 'no-such-lane' }]) {
    for (const route of [`${P}/cards/c1`, '/api/cards/c1']) {
      const r = await a.write('PATCH', route, body);
      assert.equal(r.status, 403, `${route} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
      assert.match(r.json.error, /^a lane sends the card's work to another coding CLI, so it can only be set, changed or removed on the computer itself, not through the tunnel$/);
    }
  }
  assert.equal(stored(), before, 'nothing was written');
  assert.equal((await a.write('PATCH', `${P}/cards/c1`, { title: 'Renamed from the phone' })).status, 200, 'the rest of a card can still be edited');
  // the same save on the board's own listener
  const H = { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token, ...JSON_HDR };
  const local = await raw(b.port, { method: 'PATCH', path: `${P}/cards/c1`, headers: H, body: JSON.stringify({ lane: 'code-codex' }) });
  assert.equal(local.status, 200, local.text);
  assert.equal(local.json.lane, 'code-codex');
  assert.equal((await a.write('PATCH', `${P}/cards/c1`, { note: 'A note from the phone' })).status, 200, 'a card that has a lane can still be edited remotely');
  assert.equal(core.readState(b.projectDir).cards.find((c) => c.id === 'c1').lane, 'code-codex');
  const lanesRead = await a.get(`${P}/lanes`);
  assert.equal(lanesRead.status, 200, 'the lanes can be read, as before');
});

test('over the tunnel an agent cannot be set, changed or removed, and a refused save writes nothing; on the normal listener it can', async (t) => {
  const b = await boot(t);
  fs.mkdirSync(path.join(b.projectDir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(b.projectDir, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---\nYou review.\n');
  seedThread(b);
  const a = await open(b);
  const P = `/api/p/${b.key}`;
  const stored = () => JSON.stringify(core.readState(b.projectDir).cards.find((c) => c.id === 'c1'));
  const before = stored();
  for (const body of [{ agent: 'reviewer' }, { agent: 'reviewer', title: 'Also renamed' }, { agent: null }, { agent: '' }, { agent: 'no-such-agent' }]) {
    for (const route of [`${P}/cards/c1`, '/api/cards/c1']) {
      const r = await a.write('PATCH', route, body);
      assert.equal(r.status, 403, `${route} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
      assert.match(r.json.error, /^a sub-agent decides who works on the card when it is started as a thread, so it can only be set, changed or removed on the computer itself, not through the tunnel$/);
    }
  }
  assert.equal((await a.write('PATCH', `${P}/cards/c1`, { agent: 'reviewer', lane: null })).status, 403, 'a lane and an agent together');
  assert.equal(stored(), before, 'nothing was written');
  assert.equal((await a.write('PATCH', `${P}/cards/c1`, { title: 'Renamed from the phone' })).status, 200, 'the rest of a card can still be edited');
  const H = { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token, ...JSON_HDR };
  const local = await raw(b.port, { method: 'PATCH', path: `${P}/cards/c1`, headers: H, body: JSON.stringify({ agent: 'reviewer' }) });
  assert.equal(local.status, 200, local.text);
  assert.equal(local.json.agent, 'reviewer');
  assert.equal((await a.write('PATCH', `${P}/cards/c1`, { note: 'A note from the phone' })).status, 200, 'a card that has an agent can still be edited remotely');
  assert.equal(core.readState(b.projectDir).cards.find((c) => c.id === 'c1').agent, 'reviewer');
  assert.equal((await a.get(`${P}/agents`)).status, 200, 'the agents can be read, as before');
});

test('over the tunnel the milestone links and the map layout cannot be changed, a card edit cannot set links, and the layout can be read; the normal listener can', async (t) => {
  const b = await boot(t);
  const m1 = await core.addCard(b.projectDir, { title: 'M1', kind: 'milestone' });
  const m2 = await core.addCard(b.projectDir, { title: 'M2', kind: 'milestone' });
  const a = await open(b);
  const P = `/api/p/${b.key}`;
  const stored = () => JSON.stringify(core.readState(b.projectDir).cards);
  const before = stored();
  const layoutFile = core.projectPaths(b.projectDir).layout;
  for (const [method, route, body] of [
    ['POST', `${P}/milestones/${m2.id}/depends-on`, { add: m1.id }],
    ['POST', `${P}/milestones/${m2.id}/depends-on`, { remove: m1.id }],
    ['POST', `/api/milestones/${m2.id}/depends-on`, { add: m1.id }],
    ['PUT', `${P}/milestone-layout`, { set: { [m1.id]: { col: 1, row: 1 } } }],
    ['DELETE', `${P}/milestone-layout`, undefined],
    ['PUT', '/api/milestone-layout', { set: { [m1.id]: { col: 1, row: 1 } } }],
  ]) {
    const r = await a.write(method, route, body);
    assert.equal(r.status, 403, `${method} ${route} -> ${r.status} ${r.text}`);
    assert.match(r.json.error, /^not allowed through the tunnel$/);
  }
  assert.equal(stored(), before, 'nothing was written');
  assert.equal(fs.existsSync(layoutFile), false, 'no layout was saved');
  // the card route is open to the tunnel but has no key for the links
  const patch = await a.write('PATCH', `${P}/cards/${m2.id}`, { dependsOn: [m1.id] });
  assert.equal(patch.status, 400);
  assert.match(patch.json.error, /unknown key dependsOn/);
  assert.equal(stored(), before);
  // reading is as before, and carries the layout (a place on this computer's map, never a secret)
  const H = { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token, ...JSON_HDR };
  const local = await raw(b.port, { method: 'PUT', path: `${P}/milestone-layout`, headers: H, body: JSON.stringify({ set: { [m1.id]: { col: 1, row: 1 } } }) });
  assert.equal(local.status, 200, local.text);
  const link = await raw(b.port, { method: 'POST', path: `${P}/milestones/${m2.id}/depends-on`, headers: H, body: JSON.stringify({ add: m1.id }) });
  assert.equal(link.status, 200, link.text);
  const state = await a.get(`${P}/state`);
  assert.equal(state.status, 200);
  assert.deepEqual(state.json.milestoneLayout, { [m1.id]: { col: 1, row: 1 } });
  assert.deepEqual(state.json.cards.find((c) => c.id === m2.id).dependsOn, [m1.id]);
  assert.equal((await a.write('DELETE', `${P}/milestone-layout`)).status, 403, 'and it stays closed once a layout exists');
  assert.equal((await raw(b.port, { method: 'DELETE', path: `${P}/milestone-layout`, headers: H })).status, 200);
});

test('on the normal listener the same routes still work as before', async (t) => {
  const b = await boot(t);
  seedThread(b);
  await open(b);
  const H = { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token };
  const del = await raw(b.port, { method: 'DELETE', path: '/api/cards/c1', headers: H });
  assert.equal(del.status, 200);
  const end = await raw(b.port, { method: 'POST', path: '/api/threads/c2/end', headers: { ...H, ...JSON_HDR }, body: '{}' });
  assert.equal(end.status, 200);
});

// ---------------------------------------------------------------- expiry and limits

test('the lifetime is enforced on every request, and the first late request ends the tunnel', async (t) => {
  let clock = 5_000_000;
  const b = await boot(t, { tunnel: { now: () => clock } });
  const a = await open(b);
  clock += 12 * 3600 * 1000 - 1;
  assert.equal((await a.get('/api/state')).status, 200, 'one millisecond before the end');
  clock += 1;
  const late = await a.get('/api/state');
  assert.equal(late.status, 401);
  assert.equal(late.json.error, 'the tunnel has expired');
  await waitFor(() => b.tunnel.status().active === false);
  await waitFor(() => !isAlive(a.child.pid));
  await assert.rejects(() => raw(a.remotePort, { path: '/' }), 'the listener is closed');
});

test('at most the set number of requests are in flight on the tunnel; the rest get 503', async (t) => {
  const b = await boot(t, { tunnel: { limits: { concurrent: 2 } } });
  const a = await open(b);
  const hang = () => new Promise((resolve) => {
    const s = net.connect(a.remotePort, '127.0.0.1', () => {
      s.write(`POST /api/p/${b.key}/cards HTTP/1.1\r\nHost: ${HOST}\r\nx-thread-token: ${a.view.token}\r\nOrigin: ${a.origin}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"title":`);
      resolve(s);
    });
    s.on('error', () => {});
  });
  const held = [await hang(), await hang()];
  t.after(() => held.forEach((s) => s.destroy()));
  await sleep(100);
  const busy = await a.get('/api/state');
  assert.equal(busy.status, 503);
  assert.equal(busy.json.error, 'too many requests at once');
  assert.equal((await raw(b.port, { path: '/api/state', headers: { host: `127.0.0.1:${b.port}`, 'x-thread-token': b.token } })).status, 200, 'the board itself is not affected');
  held.forEach((s) => s.destroy());
  await waitFor(async () => (await a.get('/api/state')).status === 200);
});

test('writes over the tunnel are limited per minute; reads and the limit window are separate', async (t) => {
  let clock = 1_000;
  const b = await boot(t, { tunnel: { now: () => clock, limits: { writesPerMinute: 3 } } });
  const a = await open(b);
  const P = `/api/p/${b.key}`;
  for (let i = 0; i < 3; i++) assert.equal((await a.write('POST', `${P}/cards`, { title: 'n' + i })).status, 201);
  const over = await a.write('POST', `${P}/cards`, { title: 'one too many' });
  assert.equal(over.status, 429);
  assert.ok(over.headers['retry-after']);
  assert.equal(core.readState(b.projectDir).cards.length, 3);
  for (let i = 0; i < 5; i++) assert.equal((await a.get('/api/state')).status, 200, 'reads are not limited');
  assert.equal((await a.write('POST', `${P}/threads/c9/messages`, { message: 'x' })).status, 403, 'a denied write is not counted');
  clock += 60_000;
  assert.equal((await a.write('POST', `${P}/cards`, { title: 'later' })).status, 201, 'a minute later it works again');
});

// ---------------------------------------------------------------- the control route

test('a guest session starts, shows and stops the tunnel through the owner\'s control route', async (t) => {
  const b = await boot(t);
  const status0 = await tunnelRequest(b.url, 'status');
  assert.equal(status0.status, 200);
  assert.deepEqual(status0.body, { active: false });
  const started = await tunnelRequest(b.url, 'start');
  assert.equal(started.status, 200);
  assert.equal(started.body.host, HOST);
  assert.equal(started.body.reused, false);
  assert.match(started.body.token, /^[0-9a-f]{64}$/);
  const again = await tunnelRequest(b.url, 'start');
  assert.equal(again.body.reused, true);
  assert.equal(again.body.expiresAt, started.body.expiresAt);
  assert.equal((await tunnelRequest(b.url, 'status')).body.token, started.body.token);
  assert.equal(b.spawned().length, 1);
  const stopped = await tunnelRequest(b.url, 'stop');
  assert.deepEqual(stopped.body, { active: false, stopped: true });
  assert.deepEqual((await tunnelRequest(b.url, 'stop')).body, { active: false, stopped: false });
  assert.equal(b.tunnel.status().active, false);
});

test('the control route needs the board token, a local origin and a known action, and does not exist on the tunnel', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const H = { host: `127.0.0.1:${b.port}`, ...JSON_HDR };
  const call = (headers, body = '{"action":"status"}') => raw(b.port, { method: 'POST', path: '/api/tunnel', headers: { ...H, ...headers }, body });
  assert.equal((await call({})).status, 401, 'no token');
  assert.equal((await call({ 'x-thread-token': a.view.token })).status, 401, 'the tunnel token is no key to it');
  assert.equal((await call({ 'x-thread-token': b.token, origin: 'https://evil.com' })).status, 403);
  assert.equal((await call({ 'x-thread-token': b.token, origin: a.origin })).status, 403, 'not even the tunnel\'s own origin');
  assert.equal((await call({ 'x-thread-token': b.token, origin: `http://127.0.0.1:${b.port}` })).status, 200);
  assert.equal((await call({ 'x-thread-token': b.token })).status, 200, 'no origin: a process, not a page');
  assert.equal((await call({ 'x-thread-token': b.token }, '{"action":"explode"}')).status, 400);
  assert.equal((await call({ 'x-thread-token': b.token, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call({ host: `evil.example`, 'x-thread-token': b.token })).status, 403, 'the normal listener keeps its own host check');
  // on the tunnel's listener: refused even with the right token and origin
  for (const action of ['status', 'start', 'stop']) {
    const r = await a.write('POST', '/api/tunnel', { action });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'not allowed through the tunnel');
  }
  assert.equal(b.tunnel.status().active, true);
});

test('a board from a version before the tunnel answers the control route with 404', async (t) => {
  const old = http.createServer((req, res) => { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"error":"not found"}'); });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  t.after(() => { old.close(); old.closeAllConnections(); });
  setupThreadEnv(t);
  const r = await tunnelRequest(`http://127.0.0.1:${old.address().port}/`, 'start');
  assert.equal(r.status, 404);
  assert.equal(await tunnelRequest('http://127.0.0.1:1/', 'start'), null, 'a board that cannot be reached');
});

// ---------------------------------------------------------------- the tool

function mcpEnv(port) {
  return { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port), THREAD_CLOUDFLARED_BIN: FAKE, FAKE_CLOUDFLARED_LOG: process.env.FAKE_CLOUDFLARED_LOG, FAKE_CLOUDFLARED_HOST: HOST };
}

/** The two calls opening the tunnel takes: the first answers with a code, the second, with that code, opens it. Returns the second answer. */
async function openLink(c) {
  const first = (await c.call('board_open', { tunnel: 'start' })).text;
  const code = /confirm_code "([0-9a-f]{8})"/.exec(first);
  assert.ok(code, first);
  return (await c.call('board_open', { tunnel: 'start', confirm_code: code[1] })).text;
}

test('board_open with tunnel works from the owner and from a guest, board_stop closes it, and the answer carries the warning', async (t) => {
  const e = setupThreadEnv(t);
  const cfLog = path.join(e.base, 'cf.log');
  e.setEnv('FAKE_CLOUDFLARED_LOG', cfLog);
  const spawned = () => { try { return fs.readFileSync(cfLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  t.after(() => spawned().forEach((c) => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }));
  const port = await freePort();
  const owner = new McpClient(e, mcpEnv(port));
  t.after(() => owner.kill());
  await owner.init();
  assert.match((await owner.call('board_open')).text, /^Board: http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}#\/[0-9a-f]{12}\n/, 'without tunnel the answer is as before');
  const guest = new McpClient(e, mcpEnv(port));
  t.after(() => guest.kill());
  await guest.init();
  assert.match((await guest.call('board_open')).text, /^Board:/);

  // the first call opens nothing: it asks for the user's yes, and says what the link allows
  const ask = (await guest.call('board_open', { tunnel: 'start' })).text;
  assert.match(ask, /^Board:/, 'the local link is still given');
  assert.match(ask, /CONFIRMATION REQUIRED\. No tunnel was opened\./);
  assert.match(ask, /every project on the board with its absolute path \(which contains your username\)/);
  assert.match(ask, /create and edit cards \(which gives Claude new instructions\), answer waiting items \(which can approve a review and wake Claude\)/);
  assert.match(ask, /move a card that has criteria to done, or edit those criteria/);
  assert.doesNotMatch(ask, /Remote link:/);
  assert.equal(spawned().length, 0, 'no code, no tunnel');
  const code = /confirm_code "([0-9a-f]{8})"/.exec(ask)[1];
  assert.match((await guest.call('board_open', { tunnel: 'start', confirm_code: 'deadbeef' })).text, /CONFIRMATION REQUIRED/, 'a wrong code is refused');
  assert.match((await owner.call('board_open', { tunnel: 'start', confirm_code: code })).text, /CONFIRMATION REQUIRED/, 'a code from another session is no key');
  assert.equal(spawned().length, 0);

  const fromGuest = await openLink(guest);
  const linkRe = new RegExp(`Remote link: https://${HOST.replace(/\./g, '\\.')}/#t=([0-9a-f]{64})/${core.projectKey(e.projectDir)}\\n`);
  const m = linkRe.exec(fromGuest);
  assert.ok(m, fromGuest);
  assert.match(fromGuest, /It works until .+ \(in 12 h\)\./);
  assert.match(fromGuest, /Whoever has this link acts as you on this board/);
  assert.match(fromGuest, /It can read: every project on the board with its absolute path \(which contains your username\), thread reports and transcripts, sub-agent run prompts, reports and steps, the session list, the agents list and the lane settings\./);
  assert.match(fromGuest, /It can do: create and edit cards \(which gives Claude new instructions\), answer waiting items \(which can approve a review and wake Claude\), notify Claude about a card \(its title and note reach Claude as if you had typed them, whether or not waking is on; with waking on that also wakes it\), and ask for thread reports\. It acts as you, so it can also move a card that has criteria to done, or edit those criteria/);
  assert.doesNotMatch(fromGuest, /already open/);
  assert.equal(fromGuest.slice(fromGuest.indexOf('Remote link:')).includes(boardToken()), false, 'the board token is not in the remote link');

  const fromOwner = (await owner.call('board_open', { tunnel: 'start' })).text;
  assert.ok(fromOwner.includes(m[0].trim()), 'the same link');
  assert.match(fromOwner, /already open; asking again does not extend it/);
  assert.equal(spawned().length, 1);

  // the link works through the tunnel's listener
  const remotePort = Number(/:(\d+)$/.exec(spawned()[0].argv[3])[1]);
  const via = await raw(remotePort, { path: '/api/state', headers: { host: HOST, 'x-thread-token': m[1] } });
  assert.equal(via.status, 200);

  assert.match((await guest.call('board_open', { tunnel: 'stop' })).text, /The tunnel is stopped\. The remote link no longer works\./);
  await waitFor(() => !isAlive(spawned()[0].pid));
  assert.match((await owner.call('board_open', { tunnel: 'stop' })).text, /No tunnel was open\./);
  assert.equal((await owner.call('board_open', { tunnel: 'bogus' })).isError, true);

  // board_stop closes a tunnel, from a guest and from the owner
  await openLink(guest);
  assert.equal(spawned().length, 2);
  assert.match((await guest.call('board_stop')).text, /^Board stopped\. The remote tunnel link is closed too\./);
  await waitFor(() => !isAlive(spawned()[1].pid));
  await owner.call('board_open');
  await openLink(owner);
  assert.equal(spawned().length, 3);
  assert.match((await owner.call('board_stop')).text, /^Board stopped\. The remote tunnel link is closed too\./);
  await waitFor(() => !isAlive(spawned()[2].pid));
});

test('the cloudflared of a session ends with the session; one left by a killed session is ended by the next owner', async (t) => {
  const e = setupThreadEnv(t);
  const cfLog = path.join(e.base, 'cf.log');
  e.setEnv('FAKE_CLOUDFLARED_LOG', cfLog);
  const spawned = () => { try { return fs.readFileSync(cfLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  t.after(() => spawned().forEach((c) => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }));
  const pidFile = path.join(e.dataDir, 'tunnel.pid');

  // a session that is asked to end (SIGTERM, which Claude Code sends when a window closes) takes its cloudflared with it
  const a = new McpClient(e, mcpEnv(await freePort()));
  t.after(() => a.kill());
  await a.init();
  assert.match(await openLink(a), /Remote link:/);
  assert.equal(isAlive(spawned()[0].pid), true);
  a.child.kill('SIGTERM');
  await a.exited;
  await waitFor(() => !isAlive(spawned()[0].pid));
  assert.equal(fs.existsSync(pidFile), false);

  // a session that is killed outright cannot clean up, but the watchdog sees its pipe close and ends cloudflared
  const b = new McpClient(e, mcpEnv(await freePort()));
  t.after(() => b.kill());
  await b.init();
  assert.match(await openLink(b), /Remote link:/);
  const left = spawned()[1].pid;
  const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(rec.cloudflared, left, 'the record names cloudflared');
  assert.equal(rec.owner, b.child.pid, 'and its owner');
  assert.ok(isAlive(rec.pid) && rec.pid !== left, 'and the watchdog');
  b.kill();
  await b.exited;
  await waitFor(() => !isAlive(left), { timeout: 6000 });
  await waitFor(() => !isAlive(rec.pid), { timeout: 6000 });
});

test('a killed owner\'s cloudflared and watchdog die within seconds, even when the owner is a plain process', async (t) => {
  const e = setupThreadEnv(t);
  const cfLog = path.join(e.base, 'cf.log');
  e.setEnv('FAKE_CLOUDFLARED_LOG', cfLog);
  e.setEnv('THREAD_CLOUDFLARED_BIN', FAKE);
  const spawned = () => { try { return fs.readFileSync(cfLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  t.after(() => spawned().forEach((c) => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }));
  const owner = spawn(process.execPath, [path.join(TEST_DIR, 'fixtures', 'tunnel-owner.mjs')], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, THREAD_PROJECT_DIR: e.projectDir } });
  t.after(() => owner.kill('SIGKILL'));
  let out = '';
  owner.stdout.on('data', (c) => { out += c; });
  await waitFor(() => out.includes('\n'), { timeout: 10000 });
  const rec = JSON.parse(fs.readFileSync(path.join(e.dataDir, 'tunnel.pid'), 'utf8'));
  assert.equal(rec.owner, owner.pid);
  assert.equal(isAlive(rec.cloudflared), true);
  assert.equal(isAlive(rec.pid), true);
  owner.kill('SIGKILL');
  await waitFor(() => !isAlive(rec.cloudflared) && !isAlive(rec.pid), { timeout: 6000 });
});

test('the watchdog ends cloudflared at the expiry, and when it is told to stop', async (t) => {
  const e = setupThreadEnv(t);
  const WATCHDOG = path.join(TEST_DIR, '..', 'scripts', 'tunnel-watchdog.mjs');
  const run = (expiresAt) => {
    const w = spawn(process.execPath, [WATCHDOG, String(expiresAt), FAKE, 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:9'], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => w.kill('SIGKILL'));
    const r = { w, cf: 0, stderr: '', exited: new Promise((res) => w.on('exit', res)) };
    w.stdout.on('data', (c) => { const m = /cloudflared-pid (\d+)/.exec(String(c)); if (m) r.cf = Number(m[1]); });
    w.stderr.on('data', (c) => { r.stderr += c; });
    return r;
  };
  // the expiry has passed: both are gone in about a second, and cloudflared's output was passed through
  const a = run(Date.now() + 1500);
  await waitFor(() => a.cf);
  t.after(() => { try { process.kill(a.cf, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => /trycloudflare\.com/.test(a.stderr));
  assert.equal(isAlive(a.cf), true);
  await waitFor(() => !isAlive(a.cf), { timeout: 6000 });
  await a.exited;
  // a stop signal, and the pipe closing
  for (const how of ['SIGTERM', 'SIGHUP', 'stdin']) {
    const r = run(Date.now() + 3600_000);
    await waitFor(() => r.cf);
    t.after(() => { try { process.kill(r.cf, 'SIGKILL'); } catch { /* gone */ } });
    if (how === 'stdin') r.w.stdin.end(); else r.w.kill(how);
    await waitFor(() => !isAlive(r.cf), { timeout: 6000 });
    await r.exited;
  }
  // cloudflared ending ends the watchdog
  const d = run(Date.now() + 3600_000);
  await waitFor(() => d.cf);
  process.kill(d.cf, 'SIGKILL');
  await d.exited;
});

test('another board starting does not end the tunnel of a live owner; a dead owner\'s is ended', async (t) => {
  const b = await boot(t);
  const a = await open(b);
  const file = path.join(b.dataDir, 'tunnel.pid');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.owner, process.pid);
  assert.equal(await reapStaleTunnel(), false);
  const other = await startBoardServer(b.projectDir, { port: 0, token: b.token });   // a second board in the same data directory
  t.after(() => closeBoardServer(other.server));
  await sleep(300);
  assert.equal(isAlive(a.child.pid), true, 'the tunnel of a live owner is untouched');
  assert.equal(fs.existsSync(file), true, 'and so is its record');
  assert.equal((await a.get('/api/state')).status, 200);
  // the same record, with an owner that no longer runs, is acted on
  const dead = spawn(process.execPath, [path.join(TEST_DIR, 'fixtures', 'exit-now.mjs')], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  fs.writeFileSync(file, JSON.stringify({ ...rec, owner: dead.pid }));
  assert.equal(await reapStaleTunnel(), true);
  await waitFor(() => !isAlive(a.child.pid));
});

test('opening the tunnel needs the code once; a side thread may not open or close it', async (t) => {
  const e = setupThreadEnv(t);
  const cfLog = path.join(e.base, 'cf.log');
  e.setEnv('FAKE_CLOUDFLARED_LOG', cfLog);
  const spawned = () => { try { return fs.readFileSync(cfLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  t.after(() => spawned().forEach((c) => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }));
  const c = new McpClient(e, mcpEnv(await freePort()));
  t.after(() => c.kill());
  await c.init();
  const code = /confirm_code "([0-9a-f]{8})"/.exec((await c.call('board_open', { tunnel: 'start' })).text)[1];
  assert.equal(spawned().length, 0);
  assert.match((await c.call('board_open', { tunnel: 'start', confirm_code: code })).text, /Remote link:/);
  assert.equal(spawned().length, 1);
  assert.match((await c.call('board_open', { tunnel: 'stop' })).text, /The tunnel is stopped/, 'stopping needs no code');
  assert.match((await c.call('board_open', { tunnel: 'start', confirm_code: code })).text, /CONFIRMATION REQUIRED/, 'a code works once');
  assert.equal(spawned().length, 1);

  const th = new McpClient(e, { ...mcpEnv(await freePort()), THREAD_DEPTH: '1' });
  t.after(() => th.kill());
  await th.init();
  for (const tunnel of ['start', 'stop']) {
    const r = await th.call('board_open', { tunnel });
    assert.equal(r.isError, true);
    assert.match(r.text, /a side thread cannot open or close the remote link/);
  }
  assert.equal(spawned().length, 1);
});

test('board_open with tunnel says how to install cloudflared when it is missing, and names an older board', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const c = new McpClient(e, { ...mcpEnv(port), THREAD_CLOUDFLARED_BIN: path.join(e.base, 'nope') });
  t.after(() => c.kill());
  await c.init();
  const r = { isError: false, text: await openLink(c) };
  assert.equal(r.isError, false);
  assert.match(r.text, /cloudflared is not installed/);
  assert.match(r.text, /Then run \/thread:board --tunnel again\./);
  assert.match(r.text, /^Board:/, 'the local link is still given');

  // a board without the control route, served by an "older version" (a plain 404 server) that a guest has adopted
  const dataKey = crypto.createHash('sha1').update(path.resolve(e.dataDir)).digest('hex').slice(0, 12);
  const p2 = await freePort();
  const oldBoard = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ping') { res.end(JSON.stringify({ app: 'thread-board', version: '99.0.0', dataKey })); return; }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  });
  await new Promise((r2) => oldBoard.listen(p2, '127.0.0.1', r2));
  t.after(() => { oldBoard.close(); oldBoard.closeAllConnections(); });
  const g = new McpClient(e, mcpEnv(p2));
  t.after(() => g.kill());
  await g.init();
  const old = await g.call('board_open', { tunnel: 'start' });
  assert.match(old.text, /The board is served by an older plugin version; run \/thread:board in an updated session first \(it takes the board over\), then --tunnel\./);
});

// ---------------------------------------------------------------- the page

function pageSource() {
  return fs.readFileSync(path.join(TEST_DIR, '..', 'server', 'board', 'js', 'base.js'), 'utf8');
}

// Runs the page's token block against a stand-in address bar. `search` and `hash` are what the browser has; the result says what the
// page keeps and what is left in the address bar.
function runTokenBlock({ search = '', hash = '', stored = '' }) {
  const m = /\/\/ ---- token in the address[^\n]*\n([\s\S]*?)\/\/ ---- end token in the address ----/.exec(pageSource());
  assert.ok(m, 'the token block is missing from base.js');
  const store = { 'thread-board-token': stored };
  const loc = { search, hash, pathname: '/' };
  const out = { replaced: [] };
  const ctx = vm.createContext({
    location: loc,
    history: {
      replaceState: (a, b, url) => {
        out.replaced.push(url);
        const [before, ...frag] = url.split('#');
        const [pathname, ...q] = before.split('?');
        Object.assign(loc, { pathname, search: q.length ? '?' + q.join('?') : '', hash: frag.length ? '#' + frag.join('#') : '' });
      },
    },
    sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    URLSearchParams,
    TOKEN_KEY: 'thread-board-token',
  });
  vm.runInContext(`${m[1]}\nthis.result = { token: () => token };`, ctx);
  return { token: ctx.result.token(), stored: store['thread-board-token'], url: loc.pathname + loc.search + loc.hash, replaced: out.replaced };
}

test('the page reads a token from ?t= as before and from #t= for the tunnel, and cleans the address bar of both', () => {
  const local = runTokenBlock({ search: '?t=' + 'a'.repeat(32), hash: '#/0123456789ab' });
  assert.equal(local.token, 'a'.repeat(32));
  assert.equal(local.stored, 'a'.repeat(32));
  assert.equal(local.url, '/#/0123456789ab');
  const withOther = runTokenBlock({ search: '?x=1&t=' + 'b'.repeat(32), hash: '#/0123456789ab/c7' });
  assert.equal(withOther.token, 'b'.repeat(32));
  assert.equal(withOther.url, '/?x=1#/0123456789ab/c7');

  const tok = 'c'.repeat(64);
  const remote = runTokenBlock({ hash: `#t=${tok}/0123456789ab` });
  assert.equal(remote.token, tok);
  assert.equal(remote.stored, tok);
  assert.equal(remote.url, '/#/0123456789ab', 'the route is what is left, as an ordinary route');
  const bare = runTokenBlock({ hash: `#t=${tok}` });
  assert.equal(bare.token, tok);
  assert.equal(bare.url, '/');

  const kept = runTokenBlock({ hash: '#/0123456789ab', stored: 'd'.repeat(32) });
  assert.equal(kept.token, 'd'.repeat(32), 'with no token in the address, the stored one is used');
  assert.deepEqual(kept.replaced, []);
  const junk = runTokenBlock({ hash: '#t=not a token/x' });
  assert.equal(junk.token, '', 'a fragment that is not a token is left alone');
});

test('the board_open tool and the board skill tell Claude to ask the user before it passes the code', () => {
  const tool = fs.readFileSync(path.join(TEST_DIR, '..', 'server', 'mcp.mjs'), 'utf8');
  assert.match(tool, /never done on the first call: the tool answers "CONFIRMATION REQUIRED" with a confirm_code and opens nothing/);
  const skill = fs.readFileSync(path.join(TEST_DIR, '..', 'skills', 'board', 'SKILL.md'), 'utf8');
  assert.match(skill, /never opened on the first call/);
  assert.match(skill, /only after they agree/);
});
