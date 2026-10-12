import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupThreadEnv, runNode, cleanAmbientEnv, writeStateFile, emptyState, threadCard, HOOK_PATH, PARENT_SESSION } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();
delete process.env.THREAD_DEPTH;
delete process.env.CLAUDE_CODE_SESSION_ID;

function hook(e, event, input, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];
  const payload = typeof input === 'string' ? input : JSON.stringify({ cwd: e.projectDir, hook_event_name: event, ...input });
  return runNode([HOOK_PATH, event], { env, input: payload, cwd: e.projectDir });
}

test('SessionStart prints one JSON object whose additionalContext contains the session id', async (t) => {
  const e = setupThreadEnv(t);
  const r = await hook(e, 'SessionStart', { session_id: PARENT_SESSION });
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(PARENT_SESSION));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('thread_start'));
});

test('UserPromptSubmit with nothing pending prints nothing', async (t) => {
  const e = setupThreadEnv(t);
  const r = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'hello' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('UserPromptSubmit after a thread finished for that session names the card id, and prints nothing the second time', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard({ id: 'c1', title: 'Zebra research' })]));
  const first = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'next' });
  assert.equal(first.code, 0);
  const out = JSON.parse(first.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('c1'), ctx);
  assert.ok(ctx.includes('Zebra research'), ctx);
  assert.match(ctx, /thread_report/);
  assert.ok(ctx.length <= 700, `context length ${ctx.length}`);
  assert.equal(core.readState(e.projectDir).cards[0].thread.announced, true);

  const second = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'again' });
  assert.equal(second.code, 0);
  assert.equal(second.stdout.trim(), '');
});

test('UserPromptSubmit stays silent for a different session id and does not consume the announcement', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard()]));
  const other = await hook(e, 'UserPromptSubmit', { session_id: '99999999-9999-4999-8999-999999999999', prompt: 'x' });
  assert.equal(other.code, 0);
  assert.equal(other.stdout.trim(), '');
  assert.equal(core.readState(e.projectDir).cards[0].thread.announced, false);
});

test('UserPromptSubmit announces a failed thread', async (t) => {
  const e = setupThreadEnv(t);
  const failed = threadCard({ status: 'blocked' }, { runState: 'failed', lastResult: null, turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: false, result: null, error: 'boom' }] });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [failed]));
  const r = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'x' });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('c1'));
});

test('UserPromptSubmit mentions unseen user cards and does not mark them seen', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'u1', source: 'user' });
  await core.addCard(e.projectDir, { title: 'u2', source: 'user' });
  await core.addCard(e.projectDir, { title: 'mine' });
  const r = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'x' });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /2 new board cards/);
  assert.match(ctx, /board_list/);
  assert.deepEqual(core.readState(e.projectDir).cards.map((c) => c.seenByClaude), [false, false, true]);
  const again = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'y' });
  assert.match(JSON.parse(again.stdout.trim()).hookSpecificOutput.additionalContext, /2 new board cards/, 'still mentioned until board_list marks them seen');
});

test('UserPromptSubmit reconciles a dead runner before announcing', async (t) => {
  const e = setupThreadEnv(t);
  const c = threadCard({ status: 'in_progress' }, {
    sessionId: null, runState: 'running', pid: 2147483646, lastResult: null,
    turns: [{ prompt: 'p', startedAt: new Date().toISOString(), finishedAt: null, ok: null, result: null, error: null }],
  });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [c]));
  const r = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'x' });
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext.includes('c1'));
  assert.equal(core.readState(e.projectDir).cards[0].thread.runState, 'failed');
});

test('garbage stdin gives no output and exit code 0', async (t) => {
  const e = setupThreadEnv(t);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const r = await hook(e, event, 'this is {{ not json');
    assert.equal(r.code, 0, event);
    assert.equal(r.stdout.trim(), '', event);
  }
  const empty = await hook(e, 'UserPromptSubmit', '');
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout.trim(), '');
});

test('a corrupt state file gives no output and exit code 0', async (t) => {
  const e = setupThreadEnv(t);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const p = core.projectPaths(e.projectDir).state;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'corrupt{');
  const r = await hook(e, 'UserPromptSubmit', { session_id: PARENT_SESSION, prompt: 'x' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('THREAD_DEPTH=1 gives no output and exit code 0', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [threadCard()]));
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const r = await hook(e, event, { session_id: PARENT_SESSION, prompt: 'x' }, { THREAD_DEPTH: '1' });
    assert.equal(r.code, 0, event);
    assert.equal(r.stdout.trim(), '', event);
  }
  assert.equal(core.readState(e.projectDir).cards[0].thread.announced, false);
});
