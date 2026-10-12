// Session names: touchSession, sessionLabel, the hook that registers sessions and GET /api/state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, runNode, sleep, cleanAmbientEnv, writeStateFile, emptyState, threadCard, statePathFor,
  HOOK_PATH, PARENT_SESSION,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const OTHER = '99999999-9999-4999-8999-999999999999';

const aiTitle = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: PARENT_SESSION });
const userLine = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
const writeLines = (file, lines) => { fs.writeFileSync(file, lines.join('\n') + '\n'); return file; };
const rec = (projectDir, id = PARENT_SESSION) => core.readState(projectDir).sessions?.[id];

/** Make the stored record look old enough to pass the 60 s throttle. */
function backdate(e, id = PARENT_SESSION, ms = 120000) {
  const p = statePathFor(e.dataDir, e.projectDir);
  const st = JSON.parse(fs.readFileSync(p, 'utf8'));
  st.sessions[id].lastSeenAt = new Date(Date.now() - ms).toISOString();
  fs.writeFileSync(p, JSON.stringify(st));
}

test('touchSession prefers sessionTitle over the transcript', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [aiTitle('From transcript'), userLine('hello there')]);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp, sessionTitle: '  My   named session ' });
  assert.equal(r.name, 'My named session');
  assert.equal(r.nameSource, 'title');
  assert.equal(r.transcriptPath, tp);
  assert.ok(r.firstSeenAt && r.lastSeenAt);
  assert.deepEqual(rec(e.projectDir), r);
});

test('touchSession uses the last of several ai-title lines', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [userLine('first'), aiTitle('Old title'), userLine('more'), aiTitle('Newest title'), JSON.stringify({ type: 'assistant' })]);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(r.name, 'Newest title');
  assert.equal(r.nameSource, 'ai-title');
});

test('touchSession falls back to the first real user text and skips text starting with "<"', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [
    'not json at all',
    userLine('<system-reminder>ignore me</system-reminder>'),
    userLine([{ type: 'tool_result', content: 'x' }]),
    userLine([{ type: 'text', text: '<command-name>/x</command-name>' }, { type: 'text', text: 'Fix   the\n login bug' }]),
    userLine('a later message'),
  ]);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(r.nameSource, 'first-message');
  assert.equal(r.name, 'Fix the login bug');
});

test('a long first message is cut to 60 characters with an ellipsis', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [userLine('word '.repeat(40))]);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(r.name.length, 60);
  assert.ok(r.name.endsWith('…'));
});

test('touchSession gives none for a missing file, an empty file, garbage lines and a bad path', async (t) => {
  const e = setupThreadEnv(t);
  const empty = path.join(e.base, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const garbage = writeLines(path.join(e.base, 'garbage.jsonl'), ['{{{', '[1,2', 'null', '"x"', '{"type":"user"}', '{"type":"ai-title","aiTitle":""}']);
  const goodButWrongExt = writeLines(path.join(e.base, 'good.txt'), [aiTitle('Hidden')]);
  const cases = [
    path.join(e.base, 'missing.jsonl'), empty, garbage, 'relative/t.jsonl', goodButWrongExt, undefined, 42,
  ];
  let n = 0;
  for (const transcriptPath of cases) {
    const id = `0000000${n++}-0000-4000-8000-000000000000`;
    const r = await core.touchSession(e.projectDir, id, { transcriptPath });
    assert.equal(r.nameSource, 'none', String(transcriptPath));
    assert.equal(r.name, '');
  }
  assert.equal(await core.touchSession(e.projectDir, 'x'), null, 'bad session id is ignored');
});

test('touchSession reads a 2 MB transcript whose title is in the last lines', async (t) => {
  const e = setupThreadEnv(t);
  const filler = userLine('x'.repeat(900));
  const lines = [];
  for (let i = 0; i < 2300; i++) lines.push(filler);
  lines.push(aiTitle('Title at the end'), JSON.stringify({ type: 'assistant', text: 'tail' }));
  const tp = writeLines(path.join(e.base, 'big.jsonl'), lines);
  assert.ok(fs.statSync(tp).size > 2 * 1024 * 1024);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(r.name, 'Title at the end');
  assert.equal(r.nameSource, 'ai-title');
});

test('in a big transcript with no title the first message comes from the head', async (t) => {
  const e = setupThreadEnv(t);
  const lines = [userLine('Head message here')];
  for (let i = 0; i < 2300; i++) lines.push(JSON.stringify({ type: 'assistant', text: 'y'.repeat(900) }));
  const tp = writeLines(path.join(e.base, 'big2.jsonl'), lines);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(r.name, 'Head message here');
  assert.equal(r.nameSource, 'first-message');
});

test('touchSession skips the transcript and the write within 60 s once a title is known, and picks up a change after that', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [aiTitle('Title A')]);
  const first = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(first.name, 'Title A');
  const statePath = statePathFor(e.dataDir, e.projectDir);
  const mtime = fs.statSync(statePath).mtimeMs;

  writeLines(tp, [aiTitle('Title B')]);
  await sleep(30);
  const again = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(again.name, 'Title A', 'throttled');
  assert.equal(fs.statSync(statePath).mtimeMs, mtime, 'state file was not written');

  backdate(e);
  const later = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: tp });
  assert.equal(later.name, 'Title B');
  assert.ok(Date.parse(later.lastSeenAt) > Date.now() - 5000);
  assert.equal(later.firstSeenAt, first.firstSeenAt);
});

test('a name already known is kept when a later look finds nothing', async (t) => {
  const e = setupThreadEnv(t);
  await core.touchSession(e.projectDir, PARENT_SESSION, { sessionTitle: 'Keep me' });
  backdate(e);
  const r = await core.touchSession(e.projectDir, PARENT_SESSION, { transcriptPath: path.join(e.base, 'gone.jsonl') });
  assert.equal(r.name, 'Keep me');
  assert.equal(r.nameSource, 'title');
});

test('sessionLabel shows name and short id, or only the short id', () => {
  const state = { sessions: { [PARENT_SESSION]: { name: 'Plan the thing', nameSource: 'title' }, [OTHER]: { name: '', nameSource: 'none' } } };
  assert.equal(core.sessionLabel(state, PARENT_SESSION), 'Plan the thing · aaaaaaaa');
  assert.equal(core.sessionLabel(state, OTHER), 'session 99999999');
  assert.equal(core.sessionLabel(state, '12345678-0000-4000-8000-000000000000'), 'session 12345678');
  assert.equal(core.sessionLabel({}, PARENT_SESSION), 'session aaaaaaaa');
});

// ---------------------------------------------------------------- hook

function hook(e, event, input, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, ...extraEnv };
  return runNode([HOOK_PATH, event], { env, input: JSON.stringify({ cwd: e.projectDir, hook_event_name: event, ...input }), cwd: e.projectDir });
}

test('SessionStart and UserPromptSubmit register the session with the name from its transcript', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [aiTitle('Hooked title')]);
  const start = await hook(e, 'SessionStart', { session_id: PARENT_SESSION, transcript_path: tp });
  assert.equal(start.code, 0);
  assert.ok(JSON.parse(start.stdout.trim()).hookSpecificOutput.additionalContext.includes(PARENT_SESSION));
  assert.equal(rec(e.projectDir).name, 'Hooked title');
  assert.equal(rec(e.projectDir).nameSource, 'ai-title');

  const second = '22222222-3333-4444-8555-666666666666';
  const tp2 = writeLines(path.join(e.base, 't2.jsonl'), [userLine('Look at the cache')]);
  const prompt = await hook(e, 'UserPromptSubmit', { session_id: second, transcript_path: tp2, prompt: 'hi' });
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout.trim(), '');
  assert.equal(rec(e.projectDir, second).name, 'Look at the cache');
});

test('the hook uses session_title when Claude Code provides one', async (t) => {
  const e = setupThreadEnv(t);
  await hook(e, 'SessionStart', { session_id: PARENT_SESSION, session_title: 'Named by user' });
  assert.equal(rec(e.projectDir).name, 'Named by user');
  assert.equal(rec(e.projectDir).nameSource, 'title');
});

test('with THREAD_DEPTH set the hook registers nothing', async (t) => {
  const e = setupThreadEnv(t);
  const tp = writeLines(path.join(e.base, 't.jsonl'), [aiTitle('Side thread')]);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const r = await hook(e, event, { session_id: PARENT_SESSION, transcript_path: tp }, { THREAD_DEPTH: '1' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
  }
  assert.equal(fs.existsSync(statePathFor(e.dataDir, e.projectDir)), false);
});

test('a broken transcript still gets the SessionStart note', async (t) => {
  const e = setupThreadEnv(t);
  const bad = writeLines(path.join(e.base, 'bad.jsonl'), ['{{{ nope', '\u0000\u0001']);
  for (const transcript_path of [bad, path.join(e.base, 'missing.jsonl'), 'relative.jsonl', 12]) {
    const r = await hook(e, 'SessionStart', { session_id: PARENT_SESSION, transcript_path });
    assert.equal(r.code, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.ok(JSON.parse(lines[0]).hookSpecificOutput.additionalContext.includes(PARENT_SESSION));
  }
  assert.equal(rec(e.projectDir).nameSource, 'none');
});

test('SessionStart still prints its note when the state file is corrupt', async (t) => {
  const e = setupThreadEnv(t);
  const p = statePathFor(e.dataDir, e.projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json');
  const r = await hook(e, 'SessionStart', { session_id: PARENT_SESSION });
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext.includes(PARENT_SESSION));
});

// ---------------------------------------------------------------- GET /api/state

test('GET /api/state returns session labels, including a parent id with no record', async (t) => {
  const e = setupThreadEnv(t);
  const state = emptyState(e.projectDir, [
    threadCard({ id: 'c1' }),
    threadCard({ id: 'c2' }, { parentSessionId: OTHER }),
  ]);
  state.sessions = { [PARENT_SESSION]: { name: 'Plan the thing', nameSource: 'title', transcriptPath: '', firstSeenAt: 'a', lastSeenAt: '2026-10-12T10:00:00.000Z' } };
  writeStateFile(e.dataDir, e.projectDir, state);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const s = await (await fetch(`http://127.0.0.1:${b.port}/api/state`)).json();
  assert.deepEqual(s.sessions[PARENT_SESSION], { name: 'Plan the thing', label: 'Plan the thing · aaaaaaaa', lastSeenAt: '2026-10-12T10:00:00.000Z' });
  assert.deepEqual(s.sessions[OTHER], { name: '', label: 'session 99999999', lastSeenAt: null });
  assert.equal(s.cards.length, 2);
});

test('GET /api/state returns an empty sessions object when there are none', async (t) => {
  const e = setupThreadEnv(t);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const s = await (await fetch(`http://127.0.0.1:${b.port}/api/state`)).json();
  assert.deepEqual(s.sessions, {});
});
