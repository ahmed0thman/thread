import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, writeStateFile, emptyState, threadCard, ROOT } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();
delete process.env.THREAD_DEPTH;
delete process.env.CLAUDE_CODE_SESSION_ID;

const STATUSES = ['idea', 'new', 'in_progress', 'review', 'blocked', 'done'];
const JSON_HDR = { 'content-type': 'application/json' };

async function boot(t, extra) {
  const e = setupThreadEnv(t, extra);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  assert.ok(b.port > 0);
  assert.match(b.url, /^http:\/\/(127\.0\.0\.1|localhost):\d+/);
  return { ...e, ...b, base: `http://127.0.0.1:${b.port}` };
}

/** Raw HTTP so we control the path and Host header exactly. */
function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('GET /api/state returns projectDir, statuses and cards', async (t) => {
  const b = await boot(t);
  await core.addCard(b.projectDir, { title: 'Seed' });
  const res = await fetch(b.base + '/api/state');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const s = await res.json();
  assert.deepEqual(s.statuses, STATUSES);
  assert.equal(s.projectDir, b.projectDir);
  assert.equal(s.cards.length, 1);
  assert.equal(s.cards[0].title, 'Seed');
});

test('GET / returns the board html', { skip: fs.existsSync(path.join(ROOT, 'server', 'board.html')) ? false : 'server/board.html does not exist yet' }, async (t) => {
  const b = await boot(t);
  const res = await fetch(b.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const html = await res.text();
  assert.match(html, /<html|<!doctype html/i);
});

test('POST creates a user card, PATCH moves it, DELETE removes it', async (t) => {
  const b = await boot(t);
  const post = await fetch(b.base + '/api/cards', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ title: 'From web', note: 'hi' }) });
  assert.equal(post.status, 201);
  const card = await post.json();
  assert.equal(card.id, 'c1');
  assert.equal(card.source, 'user');
  assert.equal(card.seenByClaude, false);
  assert.equal(card.status, 'new');
  assert.equal(card.note, 'hi');

  const patch = await fetch(b.base + '/api/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ status: 'review' }) });
  assert.equal(patch.status, 200);
  const moved = await patch.json();
  assert.equal(moved.status, 'review');
  assert.equal(core.readState(b.projectDir).cards[0].status, 'review');

  const del = await fetch(b.base + '/api/cards/c1', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal(core.readState(b.projectDir).cards.length, 0);
});

test('PATCH by the user marks the card unseen by Claude', async (t) => {
  const b = await boot(t);
  await core.addCard(b.projectDir, { title: 'Claude card' });
  const patch = await fetch(b.base + '/api/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ title: 'Edited on web' }) });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).seenByClaude, false);
});

test('a wrong Host header gets 403', async (t) => {
  const b = await boot(t);
  const bad = await raw(b.port, { path: '/api/state', headers: { Host: 'evil.example.com' } });
  assert.equal(bad.status, 403);
  const bad2 = await raw(b.port, { path: '/api/state', headers: { Host: `evil.example.com:${b.port}` } });
  assert.equal(bad2.status, 403);
  const good = await raw(b.port, { path: '/api/state', headers: { Host: `localhost:${b.port}` } });
  assert.equal(good.status, 200);
  const good2 = await raw(b.port, { path: '/api/state', headers: { Host: `127.0.0.1:${b.port}` } });
  assert.equal(good2.status, 200);
});

test('a write without a JSON content type gets 415', async (t) => {
  const b = await boot(t);
  const r = await fetch(b.base + '/api/cards', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(r.status, 415);
  const r2 = await fetch(b.base + '/api/cards', { method: 'POST', body: JSON.stringify({ title: 'x' }) , headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r2.status, 415);
  assert.equal(core.readState(b.projectDir).cards.length, 0);
});

test('invalid JSON gets 400', async (t) => {
  const b = await boot(t);
  const r = await fetch(b.base + '/api/cards', { method: 'POST', headers: JSON_HDR, body: '{not json' });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

test('a body over 64 KB gets 413', async (t) => {
  const b = await boot(t);
  const body = JSON.stringify({ title: 'big', note: 'x'.repeat(70 * 1024) });
  const r = await raw(b.port, { method: 'POST', path: '/api/cards', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body });
  assert.equal(r.status, 413);
  assert.equal(core.readState(b.projectDir).cards.length, 0);
});

test('an unknown route gets 404 with an error body', async (t) => {
  const b = await boot(t);
  const r = await fetch(b.base + '/api/nothing-here');
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error);
  const r2 = await fetch(b.base + '/api/cards', { method: 'GET' });
  assert.ok([404, 405].includes(r2.status));
});

test('core errors come back as 400 with a message', async (t) => {
  const b = await boot(t);
  const unknown = await fetch(b.base + '/api/cards/c404', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ title: 'x' }) });
  assert.equal(unknown.status, 400);
  assert.ok((await unknown.json()).error);
  const emptyTitle = await fetch(b.base + '/api/cards', { method: 'POST', headers: JSON_HDR, body: JSON.stringify({ title: '' }) });
  assert.equal(emptyTitle.status, 400);
  await core.addCard(b.projectDir, { title: 'x' });
  const badStatus = await fetch(b.base + '/api/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ status: 'bogus' }) });
  assert.equal(badStatus.status, 400);
  const delUnknown = await fetch(b.base + '/api/cards/c404', { method: 'DELETE' });
  assert.equal(delUnknown.status, 400);
});

test('PATCH status on a thread card gets 400, but the card is unchanged', async (t) => {
  const b = await boot(t);
  writeStateFile(b.dataDir, b.projectDir, emptyState(b.projectDir, [threadCard()]));
  const r = await fetch(b.base + '/api/cards/c1', { method: 'PATCH', headers: JSON_HDR, body: JSON.stringify({ status: 'done' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /thread/i);
  const c = core.readState(b.projectDir).cards[0];
  assert.equal(c.status, 'review');
  assert.equal(c.thread.runState, 'idle');
});

test('GET /api/state reconciles a running thread whose runner is dead', async (t) => {
  const b = await boot(t);
  const c = threadCard({ status: 'in_progress' }, {
    sessionId: null, runState: 'running', pid: 2147483646, lastResult: null,
    turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }],
  });
  writeStateFile(b.dataDir, b.projectDir, emptyState(b.projectDir, [c]));
  const s = await (await fetch(b.base + '/api/state')).json();
  assert.equal(s.cards[0].thread.runState, 'failed');
  assert.equal(s.cards[0].status, 'blocked');
});

test('path traversal does not return source code', async (t) => {
  const b = await boot(t);
  for (const p of ['/../core.mjs', '/server/core.mjs', '/%2e%2e/server/core.mjs', '/../server/core.mjs', '/..%2fserver%2fcore.mjs', '/server/../server/core.mjs', '/core.mjs', '/http.mjs', '/../scripts/hook.mjs', '/../test/helpers.mjs']) {
    const r = await raw(b.port, { path: p });
    assert.ok(!/export (async )?(function|const)|import .* from ['"]node:/.test(r.text), `source leaked via ${p}`);
    assert.notEqual(r.status, 200, `${p} returned 200`);
  }
});

test('the server binds to loopback only', async (t) => {
  const b = await boot(t);
  const addr = b.server.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('a second server for the same project moves to a free port instead of failing', async (t) => {
  const b = await boot(t);
  const second = await startBoardServer(b.projectDir);
  const third = await startBoardServer(b.projectDir);
  t.after(() => { for (const x of [second, third]) { x.server.closeAllConnections?.(); x.server.close(); } });
  assert.notEqual(second.port, third.port);
  const res = await fetch(`http://127.0.0.1:${second.port}/api/state`);
  assert.equal(res.status, 200);
});
