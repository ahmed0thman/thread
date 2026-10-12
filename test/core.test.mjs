import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { CORE_PATH, setupThreadEnv, cleanAmbientEnv, statePathFor } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();
delete process.env.THREAD_DEPTH;
delete process.env.CLAUDE_CODE_SESSION_ID;

test('state file lives at projects/<sha1 first 12>/state.json', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'x' });
  assert.ok(fs.existsSync(statePathFor(e.dataDir, e.projectDir)));
  assert.equal(path.resolve(core.projectPaths(e.projectDir).state), path.resolve(statePathFor(e.dataDir, e.projectDir)));
  assert.equal(core.dataDir(), e.dataDir);
});

test('readState on a missing file returns an empty state with version 1 and no cards', (t) => {
  const e = setupThreadEnv(t);
  const s = core.readState(e.projectDir);
  assert.equal(s.version, 1);
  assert.deepEqual(s.cards, []);
  assert.equal(s.seq, 0);
  assert.equal(s.projectDir, e.projectDir);
  assert.ok(!fs.existsSync(statePathFor(e.dataDir, e.projectDir)), 'readState must not need to create the file');
});

test('addCard assigns ids c1, c2 and defaults status new, kind task, seenByClaude true', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'First' });
  const b = await core.addCard(e.projectDir, { title: 'Second', note: 'n', status: 'idea', kind: 'idea' });
  assert.equal(a.id, 'c1');
  assert.equal(b.id, 'c2');
  assert.equal(a.status, 'new');
  assert.equal(a.kind, 'task');
  assert.equal(a.source, 'claude');
  assert.equal(a.seenByClaude, true);
  assert.equal(a.note, '');
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(a.updatedAt)));
  assert.equal(b.status, 'idea');
  assert.equal(b.kind, 'idea');
  assert.equal(b.note, 'n');
  const s = core.readState(e.projectDir);
  assert.equal(s.seq, 2);
  assert.deepEqual(s.cards.map((c) => c.id), ['c1', 'c2']);
});

test('addCard with source user sets seenByClaude false', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'From web', source: 'user' });
  assert.equal(c.source, 'user');
  assert.equal(c.seenByClaude, false);
});

test('addCard rejects an empty title and an invalid status', async (t) => {
  const e = setupThreadEnv(t);
  await assert.rejects(() => core.addCard(e.projectDir, { title: '' }), /title/i);
  await assert.rejects(() => core.addCard(e.projectDir, { title: 'ok', status: 'bogus' }), /status/i);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
});

test('updateCard changes status, title and note', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'A' });
  const u = await core.updateCard(e.projectDir, c.id, { status: 'review', title: 'B', note: 'nn' });
  assert.equal(u.status, 'review');
  assert.equal(u.title, 'B');
  assert.equal(u.note, 'nn');
  assert.equal(core.readState(e.projectDir).cards[0].status, 'review');
});

test('updateCard throws on an invalid status and on an unknown id', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'A' });
  await assert.rejects(() => core.updateCard(e.projectDir, c.id, { status: 'nope' }), /status/i);
  await assert.rejects(() => core.updateCard(e.projectDir, 'c99', { status: 'done' }), Error);
  assert.equal(core.readState(e.projectDir).cards[0].status, 'new');
});

test('updateCard by the user sets seenByClaude false, by Claude leaves the flag alone', async (t) => {
  const e = setupThreadEnv(t);
  const c = await core.addCard(e.projectDir, { title: 'A' });
  assert.equal(c.seenByClaude, true);
  const byClaude = await core.updateCard(e.projectDir, c.id, { note: 'claude edit' });
  assert.equal(byClaude.seenByClaude, true);
  const byUser = await core.updateCard(e.projectDir, c.id, { status: 'done' }, { source: 'user' });
  assert.equal(byUser.seenByClaude, false);
  const byClaudeAgain = await core.updateCard(e.projectDir, c.id, { note: 'again' });
  assert.equal(byClaudeAgain.seenByClaude, false, 'a Claude edit must not clear the flag');
});

test('markSeen returns the unseen cards and clears the flag', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'by claude' });
  const u1 = await core.addCard(e.projectDir, { title: 'u1', source: 'user' });
  const u2 = await core.addCard(e.projectDir, { title: 'u2', source: 'user' });
  const unseen = await core.markSeen(e.projectDir);
  assert.deepEqual(unseen.map((c) => c.id).sort(), [u1.id, u2.id].sort());
  assert.ok(core.readState(e.projectDir).cards.every((c) => c.seenByClaude === true));
  assert.deepEqual(await core.markSeen(e.projectDir), []);
});

test('removeCard removes the card and unknown id throws', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'A' });
  const b = await core.addCard(e.projectDir, { title: 'B' });
  assert.equal(await core.removeCard(e.projectDir, a.id), true);
  assert.deepEqual(core.readState(e.projectDir).cards.map((c) => c.id), [b.id]);
  await assert.rejects(() => core.removeCard(e.projectDir, 'c42'), Error);
  await assert.rejects(() => core.removeCard(e.projectDir, a.id), Error);
});

test('ids are not reused after a card is removed', async (t) => {
  const e = setupThreadEnv(t);
  const a = await core.addCard(e.projectDir, { title: 'A' });
  await core.removeCard(e.projectDir, a.id);
  const b = await core.addCard(e.projectDir, { title: 'B' });
  assert.equal(b.id, 'c2');
});

test('updateState returns the value returned by fn', async (t) => {
  const e = setupThreadEnv(t);
  const v = await core.updateState(e.projectDir, (s) => { s.marker = 7; return 'ret'; });
  assert.equal(v, 'ret');
  assert.equal(core.readState(e.projectDir).marker, 7);
});

test('concurrency: 20 processes x 10 updateState increments end at 200', { timeout: 50000 }, async (t) => {
  const e = setupThreadEnv(t);
  const code = `
    const core = await import(process.env.CORE_URL);
    for (let i = 0; i < 10; i++) {
      await core.updateState(process.env.PROJ, (s) => { s.counter = (s.counter || 0) + 1; });
    }
  `;
  const children = [];
  t.after(() => children.forEach((c) => c.kill('SIGKILL')));
  const runs = Array.from({ length: 20 }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CORE_URL: pathToFileURL(CORE_PATH).href, PROJ: e.projectDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(c);
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('error', reject);
    c.on('close', (codeNum) => (codeNum === 0 ? resolve() : reject(new Error(`worker exited ${codeNum}: ${err.slice(-500)}`))));
  }));
  await Promise.all(runs);
  assert.equal(core.readState(e.projectDir).counter, 200);
  assert.ok(!fs.existsSync(core.projectPaths(e.projectDir).lock), 'lock must be released');
});

test('a stale lock directory (older than 10 s) does not block updateState', { timeout: 15000 }, async (t) => {
  const e = setupThreadEnv(t);
  const { lock } = core.projectPaths(e.projectDir);
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lock, old, old);
  const started = Date.now();
  await core.updateState(e.projectDir, (s) => { s.touched = true; });
  assert.ok(Date.now() - started < 4000, 'stale lock should be removed promptly, not waited out');
  assert.equal(core.readState(e.projectDir).touched, true);
  assert.ok(!fs.existsSync(lock));
});

test('corrupt state.json makes readState throw rather than reset', (t) => {
  const e = setupThreadEnv(t);
  const file = statePathFor(e.dataDir, e.projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => core.readState(e.projectDir), Error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json', 'file must be left untouched');
});

test('buildPrompt first turn names the card, task, mode sentence and the four headings', async (t) => {
  const e = setupThreadEnv(t, { THREAD_CLAUDE_BIN: '/nonexistent/never-run' });
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const card = await core.startThread(e.projectDir, { title: 'Prompt check', task: 'inspect the widget', sessionId: sid });
  const full = core.readState(e.projectDir).cards.find((c) => c.id === card.id);
  const p = core.buildPrompt(full);
  assert.match(p, new RegExp(`\\[side thread ${card.id}: Prompt check\\]`));
  assert.ok(p.includes('Task: inspect the widget'));
  assert.ok(p.includes('Do not modify any files'));
  for (const h of ['## Happened', '## Decided', '## Changed', '## Open']) assert.ok(p.includes(h), h);
  const args = core.buildClaudeArgs(full);
  assert.ok(Array.isArray(args));
  assert.ok(!args.some((a) => a.includes('inspect the widget')), 'prompt must not be in argv');
});
