// The Graphify code map note in a new thread's prompt, and the `codeMap` setting that turns it on (off by default). Only files that
// already exist are looked at; the claude CLI and the lane relays are fakes. Git is the real one, run in temporary repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupThreadEnv, cleanAmbientEnv, waitFor, McpClient, PARENT_SESSION, FAKE_DELEGATE } from './helpers.mjs';
import * as core from '../server/core.mjs';
import { codeMapNote } from '../server/codemap.mjs';
import { clearLanesCache } from '../server/lanes.mjs';

cleanAmbientEnv();

const MARK = 'Graphify code map';
const STALE = 'built before the latest commit';
const TASK = 'find-the-zebra-crossing-bug';
const untilIdle = (e, id = 'c1') => waitFor(() => core.readState(e.projectDir).cards.find((c) => c.id === id)?.thread?.runState === 'idle', { timeout: 8000 });
const turnOn = (e, scope = 'project') => core.saveConfig(e.projectDir, scope, { codeMap: true });

function map(dir, mtime) {
  fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  const f = path.join(dir, 'graphify-out', 'GRAPH_REPORT.md');
  fs.writeFileSync(f, '# Graph report\n');
  if (mtime) fs.utimesSync(f, mtime, mtime);
  return f;
}
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
function git(dir, ...args) {
  return execFileSync('git', [...GIT, ...args], { cwd: dir, stdio: 'ignore' });
}
function commit(dir, when) {
  fs.writeFileSync(path.join(dir, 'a.txt'), String(Math.random()));
  git(dir, 'add', 'a.txt');
  execFileSync('git', [...GIT, 'commit', '-q', '-m', 'x'], { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
}
const mkCard = (sessionId) => ({ id: 'c1', title: 't', thread: { parentSessionId: PARENT_SESSION, sessionId, mode: 'read', turns: [{ prompt: 'do it' }], brief: 'b' } });

// ---------------------------------------------------------------- the note

test('no graphify-out: the note is empty', (t) => {
  const e = setupThreadEnv(t);
  assert.equal(codeMapNote(e.projectDir), '');
});

test('a map older than the last commit adds the stale sentence; a newer one does not', (t) => {
  const e = setupThreadEnv(t);
  git(e.projectDir, 'init', '-q');
  commit(e.projectDir, '2030-01-01T00:00:00Z');
  const f = map(e.projectDir, new Date('2029-01-01T00:00:00Z'));
  assert.ok(codeMapNote(e.projectDir).includes(STALE));
  const fresh = new Date('2031-01-01T00:00:00Z');
  fs.utimesSync(f, fresh, fresh);
  const note = codeMapNote(e.projectDir);
  assert.ok(note.includes(MARK) && !note.includes(STALE));
});

test('a sub-folder of a git repo uses the map at the git root', (t) => {
  const e = setupThreadEnv(t);
  git(e.projectDir, 'init', '-q');
  commit(e.projectDir, '2030-01-01T00:00:00Z');
  map(e.projectDir, new Date('2029-01-01T00:00:00Z'));
  const sub = path.join(e.projectDir, 'packages', 'app');
  fs.mkdirSync(sub, { recursive: true });
  const note = codeMapNote(sub);
  assert.ok(note.includes(MARK) && note.includes(STALE));
});

test('a symlinked GRAPH_REPORT.md or graphify-out folder is not used', (t) => {
  const e = setupThreadEnv(t);
  const outside = path.join(e.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'GRAPH_REPORT.md'), 'x');
  fs.mkdirSync(path.join(e.projectDir, 'graphify-out'));
  fs.symlinkSync(path.join(outside, 'GRAPH_REPORT.md'), path.join(e.projectDir, 'graphify-out', 'GRAPH_REPORT.md'));
  assert.equal(codeMapNote(e.projectDir), '');
  fs.rmSync(path.join(e.projectDir, 'graphify-out'), { recursive: true });
  fs.symlinkSync(outside, path.join(e.projectDir, 'graphify-out'));
  assert.equal(codeMapNote(e.projectDir), '');
});

test('a directory named GRAPH_REPORT.md is not used', (t) => {
  const e = setupThreadEnv(t);
  fs.mkdirSync(path.join(e.projectDir, 'graphify-out', 'GRAPH_REPORT.md'), { recursive: true });
  assert.equal(codeMapNote(e.projectDir), '');
});

// ---------------------------------------------------------------- the prompt and the setting

test('setting off (the default) with a map present: the first prompt is byte-identical to one built without a project folder', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  const plain = core.buildPrompt(mkCard(null));
  assert.equal(core.buildPrompt(mkCard(null), e.projectDir), plain);
  await core.saveConfig(e.projectDir, 'project', { codeMap: false });
  assert.equal(core.buildPrompt(mkCard(null), e.projectDir), plain);
  assert.ok(!plain.includes(MARK));
});

test('setting on and a map present: the note is in a first prompt only, before the digest instruction', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  await turnOn(e);
  const first = core.buildPrompt(mkCard(null), e.projectDir);
  assert.ok(first.includes(MARK) && first.includes('the code wins'));
  assert.ok(first.indexOf(MARK) < first.indexOf('End your reply with a hand-back digest'));
  assert.ok(!first.includes(STALE), 'a map written now is not stale (not a git repo: no check)');
  assert.ok(!core.buildPrompt(mkCard('s1'), e.projectDir).includes(MARK));
});

test('setting on but no map: the prompt is unchanged', async (t) => {
  const e = setupThreadEnv(t);
  await turnOn(e);
  assert.equal(core.buildPrompt(mkCard(null), e.projectDir), core.buildPrompt(mkCard(null)));
});

test('the project setting overrides the global one, both ways, and null removes it', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  const has = () => core.buildPrompt(mkCard(null), e.projectDir).includes(MARK);
  await turnOn(e, 'global');
  assert.equal(has(), true);
  assert.equal(core.readConfig(e.projectDir).source.codeMap, 'global');
  await core.saveConfig(e.projectDir, 'project', { codeMap: false });
  assert.equal(has(), false);
  assert.equal(core.readConfig(e.projectDir).source.codeMap, 'project');
  await core.saveConfig(e.projectDir, 'project', { codeMap: null });
  assert.equal(has(), true);
  await core.saveConfig(e.projectDir, 'global', { codeMap: false });
  await core.saveConfig(e.projectDir, 'project', { codeMap: true });
  assert.equal(has(), true);
});

test('a config file with a codeMap that is not true or false is ignored and named', async (t) => {
  const e = setupThreadEnv(t);
  const file = core.configPaths(e.projectDir).global;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ codeMap: 'yes' }));
  const cfg = core.readConfig(e.projectDir);
  assert.equal(cfg.codeMap, false);
  assert.match(cfg.invalid.global, /codeMap must be true or false/);
});

test('config_get and config_set show and save codeMap; a non-boolean is refused', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  assert.match((await c.call('config_get')).text, /Code map \(Graphify\) note for new threads: off \(default\) — from default/);
  const set = await c.call('config_set', { scope: 'project', codeMap: true });
  assert.match(set.text, /Code map \(Graphify\) note for new threads: on — from project config file/);
  const bad = await c.call('config_set', { scope: 'project', codeMap: 'yes' });
  assert.equal(bad.isError, true);
  assert.match((await c.call('config_set', { scope: 'project', codeMap: null })).text, /off \(default\) — from default/);
});

test('in a repo-backed project the setting is shared like the mode: saved in the repo file, and a removal clears it', async (t) => {
  const e = setupThreadEnv(t);
  e.base = fs.realpathSync(e.base);
  e.projectDir = fs.realpathSync(e.projectDir);
  core.resetRepoCache();
  git(e.base, 'init', '-q', e.projectDir);
  core.enableRepo(e.projectDir);
  const cfg = await core.saveConfig(e.projectDir, 'project', { codeMap: true });
  assert.equal(cfg.codeMap, true);
  const repoFile = core.configPaths(e.projectDir).project;
  assert.equal(JSON.parse(fs.readFileSync(repoFile, 'utf8')).codeMap, true);
  assert.equal((await core.saveConfig(e.projectDir, 'project', { codeMap: null })).codeMap, false);
  assert.equal('codeMap' in JSON.parse(fs.readFileSync(repoFile, 'utf8')), false);
});

// ---------------------------------------------------------------- the three ways a thread starts (setting on)

test('a Claude thread gets the note on its first turn and not on a follow-up (fake claude)', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  await turnOn(e);
  await core.startThread(e.projectDir, { title: 'Side job', task: TASK, sessionId: PARENT_SESSION });
  await untilIdle(e);
  await core.continueThread(e.projectDir, 'c1', 'and again', { sessionId: PARENT_SESSION });
  await waitFor(() => e.readLog().length === 2, { timeout: 8000 });
  const [first, second] = e.readLog();
  assert.ok(first.prompt.includes(MARK));
  assert.ok(!second.prompt.includes(MARK));
});

test('a Claude thread with the setting off gets no note even when a map exists (fake claude)', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  await core.startThread(e.projectDir, { title: 'Side job', task: TASK, sessionId: PARENT_SESSION });
  await untilIdle(e);
  assert.ok(!e.readLog()[0].prompt.includes('graphify'));
});

test('a card started as a thread gets the note (fake claude)', async (t) => {
  const e = setupThreadEnv(t);
  map(e.projectDir);
  await turnOn(e);
  const added = await core.addCard(e.projectDir, { title: 'Fix the parser', note: 'The parser drops commas.' });
  await core.startThreadFromCard(e.projectDir, added.id, { sessionId: PARENT_SESSION });
  await untilIdle(e, added.id);
  const { prompt } = e.readLog()[0];
  assert.ok(prompt.includes('Task: Fix the parser') && prompt.includes(MARK));
});

test('a lane thread gets the note in the brief file it sends to the relay, and none with the setting off (fake relay)', async (t) => {
  cleanAmbientEnv();
  clearLanesCache();
  t.after(clearLanesCache);
  const e = setupThreadEnv(t, { THREAD_DELEGATE_DIR: FAKE_DELEGATE, FAKE_DELEGATE_MODE: 'ok', FAKE_RELAY_MODE: 'ok' });
  const relayLog = path.join(e.base, 'relay.log');
  e.setEnv('FAKE_RELAY_LOG', relayLog);
  map(e.projectDir);
  const runs = () => fs.readFileSync(relayLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  await core.startThread(e.projectDir, { title: 'Off', task: TASK, sessionId: PARENT_SESSION, lane: 'code-codex' });
  await untilIdle(e);
  assert.ok(runs()[0].brief.includes(`Task: ${TASK}`) && !runs()[0].brief.includes(MARK));
  await turnOn(e);
  await core.startThread(e.projectDir, { title: 'On', task: TASK, sessionId: PARENT_SESSION, lane: 'code-codex' });
  await untilIdle(e, 'c2');
  assert.ok(runs()[1].brief.includes(MARK));
});
