import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { CORE_PATH, setupThreadEnv, cleanAmbientEnv, statePathFor, REPLY_WITH_MAP } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();

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

function plantStaleLock(lock, { nonEmpty = false } = {}) {
  fs.mkdirSync(lock, { recursive: true });
  if (nonEmpty) fs.writeFileSync(path.join(lock, 'owner-dead'), '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
}

function runAddCard(projectDir) {
  return new Promise((resolve, reject) => {
    const code = `import(${JSON.stringify(CORE_PATH)}).then((m) => m.addCard(${JSON.stringify(projectDir)}, { title: 'x' })).then((c) => console.log(c.id)).catch((e) => { console.error(e.message); process.exit(1); });`;
    const p = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${c}`))));
  });
}

test('a stale lock that still holds an owner file does not block updateState', async (t) => {
  const e = setupThreadEnv(t);
  const { lock } = core.projectPaths(e.projectDir);
  plantStaleLock(lock, { nonEmpty: true });
  const t0 = Date.now();
  const card = await core.addCard(e.projectDir, { title: 'after stale lock' });
  assert.equal(card.id, 'c1');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(lock), false, 'lock is released');
});

test('a fresh lock held by someone else makes updateState fail at the deadline instead of spinning', async (t) => {
  const e = setupThreadEnv(t, { THREAD_LOCK_WAIT_MS: '300' });
  const { lock } = core.projectPaths(e.projectDir);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner-other'), '');
  const t0 = Date.now();
  await assert.rejects(core.addCard(e.projectDir, { title: 'x' }), /could not acquire state lock/);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(fs.existsSync(path.join(lock, 'owner-other')), true, 'the other holder keeps its lock');
});

test('many processes racing to steal a stale lock never lose a card or reuse an id', async (t) => {
  const e = setupThreadEnv(t);
  const { lock } = core.projectPaths(e.projectDir);
  let expected = 0;
  for (let trial = 0; trial < 8; trial++) {
    plantStaleLock(lock, { nonEmpty: trial % 2 === 0 });
    const ids = await Promise.all(Array.from({ length: 12 }, () => runAddCard(e.projectDir)));
    expected += 12;
    assert.equal(new Set(ids).size, 12, `trial ${trial}: duplicate ids ${ids.join(',')}`);
    assert.equal(core.readState(e.projectDir).cards.length, expected, `trial ${trial}: a card was lost`);
  }
});

test('parseHandback splits body, the four sections and the step map', () => {
  const v = core.parseHandback(REPLY_WITH_MAP);
  assert.equal(v.body, 'Intro line.');
  assert.equal(v.sections.happened, '- read the plan');
  assert.equal(v.sections.decided, '- use Postgres');
  assert.equal(v.sections.changed, 'Nothing.');
  assert.equal(v.sections.open, '- one question');
  assert.deepEqual(v.map, [
    { kind: 'did', text: 'read the plan', ref: 'PLAN.md:12' },
    { kind: 'did', text: 'kind falls back' },
    { kind: 'decided', text: 'use Postgres' },
  ]);
});

test('parseHandback tolerates free text, a broken map block and non-strings', () => {
  assert.deepEqual(core.parseHandback('just text').map, []);
  assert.equal(core.parseHandback('just text').body, 'just text');
  const broken = core.parseHandback('a\n## Open\n- x\n```thread-map\nnot json\n```');
  assert.deepEqual(broken.map, []);
  assert.equal(broken.sections.open, '- x');
  assert.equal(core.parseHandback(undefined).body, '');
});

test('the prompt asks for the step map on first and follow-up turns', () => {
  const card = { id: 'c1', title: 't', thread: { sessionId: null, mode: 'read', turns: [{ prompt: 'do it' }] } };
  assert.match(core.buildPrompt(card), /thread-map/);
  card.thread.sessionId = '11111111-2222-4333-8444-555555555555';
  assert.match(core.buildPrompt(card), /thread-map/);
});
