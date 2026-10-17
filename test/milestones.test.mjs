// Config (global and project files), custom stages and roles, milestones, chat-only mode,
// the setup hint, and what the MCP server, the board API and the hook do with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupThreadEnv, waitFor, cleanAmbientEnv, writeStateFile, emptyState, threadCard, runNode, McpClient,
  HOOK_PATH, PARENT_SESSION,
} from './helpers.mjs';
import * as core from '../server/core.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const JSON_HDR = { 'content-type': 'application/json' };
const STAGES = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'check', label: 'Check' },
  { id: 'done', label: 'Finished' },
];

const writeGlobal = (e, cfg) => fs.writeFileSync(path.join(e.dataDir, 'config.json'), typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
function writeProject(e, cfg) {
  const file = core.configPaths(e.projectDir).project;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
}
const cards = (e) => core.readState(e.projectDir).cards;
const card = (e, id) => cards(e).find((c) => c.id === id);
const mcp = (t, e, extraEnv) => {
  const c = new McpClient(e, extraEnv);
  t.after(() => c.kill());
  return c;
};

// ------------------------------------------------------------ config

test('with no config file the effective config is the defaults', (t) => {
  const e = setupThreadEnv(t);
  const cfg = core.readConfig(e.projectDir);
  assert.equal(cfg.mode, 'tasks');
  assert.deepEqual(cfg.stages.map((s) => s.id), core.STATUSES);
  assert.deepEqual(cfg.roles, { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' });
  assert.deepEqual(cfg.source, { mode: 'default', stages: 'default', wake: 'default', codeMap: 'default' });
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.exists, { global: false, project: false });
});

test('config precedence: default, then the global file, then the project file; stages and roles stay together', (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { mode: 'chat', stages: STAGES, roles: { start: 'todo', done: 'done' } });
  let cfg = core.readConfig(e.projectDir);
  assert.equal(cfg.mode, 'chat');
  assert.deepEqual(cfg.taskStages, STAGES, 'the task board\'s stages are kept while chat-only shows its own');
  assert.deepEqual(cfg.source, { mode: 'global', stages: 'global', wake: 'default', codeMap: 'default' });
  assert.equal(cfg.configured, true);

  // The project file sets only the mode: mode comes from it, stages and roles still from the global file.
  writeProject(e, { mode: 'tasks' });
  cfg = core.readConfig(e.projectDir);
  assert.equal(cfg.mode, 'tasks');
  assert.deepEqual(cfg.stages, STAGES);
  assert.deepEqual(cfg.source, { mode: 'project', stages: 'global', wake: 'default', codeMap: 'default' });

  // The project file sets its own stages: the global roles are not mixed in.
  const own = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
  writeProject(e, { stages: own });
  cfg = core.readConfig(e.projectDir);
  assert.deepEqual(cfg.taskStages, own);
  assert.equal(cfg.mode, 'chat');
  assert.deepEqual(cfg.taskRoles, { start: 'a', working: 'b', review: 'b', blocked: 'b', done: 'c' });
  assert.deepEqual(cfg.source, { mode: 'global', stages: 'project', wake: 'default', codeMap: 'default' });
});

test('an unreadable or invalid config file is ignored, not fatal', (t) => {
  const e = setupThreadEnv(t);
  for (const bad of ['{not json', '[]', JSON.stringify({ mode: 'bogus' }), JSON.stringify({ stages: [{ id: 'x', label: 'X' }] })]) {
    writeGlobal(e, bad);
    const cfg = core.readConfig(e.projectDir);
    assert.equal(cfg.mode, 'tasks', bad);
    assert.deepEqual(cfg.source, { mode: 'default', stages: 'default', wake: 'default', codeMap: 'default' });
    assert.equal(cfg.exists.global, true, 'a file is there, so the plugin counts as set up');
  }
});

test('validateConfig rejects bad modes, stage counts, ids, labels, duplicates and roles', () => {
  const stage = (id, label = id) => ({ id, label });
  const many = (n) => Array.from({ length: n }, (_, i) => stage(`s${i}`));
  assert.throws(() => core.validateConfig({ mode: 'x' }), /mode/);
  assert.throws(() => core.validateConfig({ stages: [stage('a')] }), /2 to 10/);
  assert.throws(() => core.validateConfig({ stages: many(11) }), /2 to 10/);
  assert.doesNotThrow(() => core.validateConfig({ stages: many(10) }));
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('Bad')] }), /not valid/);
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('1b')] }), /not valid/);
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('b'.repeat(25))] }), /not valid/);
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('a')] }), /twice/);
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('b', '   ')] }), /label/);
  assert.throws(() => core.validateConfig({ stages: [stage('a'), stage('b', 'x'.repeat(31))] }), /label/);
  assert.deepEqual(core.validateConfig({ stages: [stage('a', '  A  '), stage('b')] }).stages[0], { id: 'a', label: 'A' });
  assert.throws(() => core.validateConfig({ stages: STAGES, roles: { start: 'nope' } }), /not one of the stages/);
  assert.throws(() => core.validateConfig({ stages: STAGES, roles: { first: 'todo' } }), /unknown role/);
  assert.throws(() => core.validateConfig({ roles: { start: 'idea' } }), /give stages as well/, 'roles need the stages of the same file');
  assert.throws(() => core.validateConfig({ stages: [stage('a', 'one\ntwo'), stage('b')] }), /on one line/);
});

test('default roles for custom stages follow the stages\' order', (t) => {
  const e = setupThreadEnv(t);
  const stages = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `S${i}` }));
  const roles = (n, own) => {
    writeGlobal(e, { stages: stages(n), ...(own ? { roles: own } : {}) });
    return core.readConfig(e.projectDir).roles;
  };
  assert.deepEqual(roles(2), { start: 's0', working: 's0', review: 's1', blocked: 's0', done: 's1' });
  assert.deepEqual(roles(3), { start: 's0', working: 's1', review: 's1', blocked: 's1', done: 's2' });
  assert.deepEqual(roles(6), { start: 's0', working: 's1', review: 's4', blocked: 's1', done: 's5' });
  // A partly given roles object is filled with the defaults.
  assert.deepEqual(roles(6, { review: 's2' }), { start: 's0', working: 's1', review: 's2', blocked: 's1', done: 's5' });
});

test('saveConfig merges into the file, removes a field given as null, validates, and resetConfig deletes the file', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'global', { mode: 'chat' });
  await core.saveConfig(e.projectDir, 'global', { stages: STAGES, roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' } });
  const file = core.configPaths(e.projectDir).global;
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mode, 'chat', 'the earlier field is kept');
  let cfg = core.readConfig(e.projectDir);
  assert.deepEqual(cfg.taskStages, STAGES);

  await assert.rejects(() => core.saveConfig(e.projectDir, 'global', { roles: { start: 'nowhere' } }), /not one of the stages/);
  assert.deepEqual(core.readConfig(e.projectDir).taskRoles.start, 'todo', 'a refused change writes nothing');
  // Dropping the stages drops the roles chosen for them.
  cfg = await core.saveConfig(e.projectDir, 'global', { stages: null, mode: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  assert.equal(cfg.mode, 'tasks');
  assert.deepEqual(cfg.stages.map((s) => s.id), core.STATUSES);

  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  assert.equal(core.readConfig(e.projectDir).mode, 'chat');
  assert.equal(path.dirname(core.configPaths(e.projectDir).project), core.projectPaths(e.projectDir).dir);
  cfg = await core.resetConfig(e.projectDir, 'project');
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).project), false);
  assert.equal(cfg.mode, 'tasks');
  await assert.rejects(() => core.saveConfig(e.projectDir, 'nowhere', {}), /scope/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp file is left behind');
});

// ------------------------------------------------------------ stages and run states

test('addCard and updateCard check the status against the project\'s stages; a new card lands in the start stage', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: STAGES });
  const a = await core.addCard(e.projectDir, { title: 'A' });
  assert.equal(a.status, 'todo');
  await assert.rejects(() => core.addCard(e.projectDir, { title: 'B', status: 'new' }), /invalid status "new" \(use one of: todo, doing, check, done\)/);
  await core.addCard(e.projectDir, { title: 'B', status: 'check' });
  await core.updateCard(e.projectDir, 'c1', { status: 'doing' });
  assert.equal(card(e, 'c1').status, 'doing');
  await assert.rejects(() => core.updateCard(e.projectDir, 'c1', { status: 'in_progress' }), /invalid status/);
});

test('a thread card follows its run state through the project\'s roles', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: STAGES, roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'todo', done: 'done' } });
  const started = await core.startThread(e.projectDir, { title: 'T', task: 'do it', sessionId: PARENT_SESSION });
  assert.equal(started.status, 'doing');
  await waitFor(() => card(e, 'c1').thread.runState === 'idle', { timeout: 10000 });
  assert.equal(card(e, 'c1').status, 'check');
  await core.endThread(e.projectDir, 'c1');
  assert.equal(card(e, 'c1').status, 'done');
  const failing = await core.startThread(e.projectDir, { title: 'F', task: 'x', sessionId: PARENT_SESSION });
  assert.equal(failing.status, 'doing');
  await core.updateState(e.projectDir, (s) => {
    const c = s.cards.find((x) => x.id === failing.id);
    c.thread.pid = null;
    core.setRunState(e.projectDir, c, 'failed');
  });
  assert.equal(card(e, failing.id).status, 'todo', 'blocked role');
});

test('a card whose stored status is not a stage is shown in the start stage, a thread in the stage for its run state, and the file is not rewritten', async (t) => {
  const e = setupThreadEnv(t);
  const task = { id: 'c1', kind: 'task', title: 'Old task', note: '', status: 'in_progress', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x' };
  const th = threadCard({ id: 'c2', status: 'review' });
  const file = writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task, th]));
  writeGlobal(e, { stages: STAGES, roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'todo', done: 'done' } });
  const before = fs.readFileSync(file, 'utf8');
  const cfg = core.readConfig(e.projectDir);
  assert.equal(core.effectiveStatus(task, cfg), 'todo');
  assert.equal(core.effectiveStatus(th, cfg), 'check', 'idle thread: the review role');
  assert.equal(core.effectiveStatus({ ...task, status: 'doing' }, cfg), 'doing');
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const c = mcp(t, e);
  await c.init();
  const list = (await c.call('board_list')).text;
  assert.match(list, /To do \(1\)\n- c1 \[task\] Old task/);
  assert.match(list, /Check \(1\)\n- c2 \[thread:idle\]/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  // The board sending a thread's shown status back is not a status change.
  await core.updateCard(e.projectDir, 'c2', { status: 'check', title: 'Renamed' });
  assert.equal(card(e, 'c2').title, 'Renamed');
  await assert.rejects(() => core.updateCard(e.projectDir, 'c2', { status: 'done' }), /follows the thread/);
});

// ------------------------------------------------------------ milestones

test('milestone rules: the parent must be a milestone, one level, set and clear, thread cards allowed', async (t) => {
  const e = setupThreadEnv(t);
  const m = await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  assert.equal(m.kind, 'milestone');
  assert.equal(m.parent, undefined);
  const task = await core.addCard(e.projectDir, { title: 'T', parent: m.id });
  assert.equal(task.parent, 'c1');
  const idea = await core.addCard(e.projectDir, { title: 'I', kind: 'idea', parent: 'c1' });
  assert.equal(idea.parent, 'c1');

  await assert.rejects(() => core.addCard(e.projectDir, { title: 'X', parent: 'c9' }), /^Error: milestone not found: c9$/);
  await assert.rejects(() => core.addCard(e.projectDir, { title: 'X', parent: 'c2' }), /^Error: c2 is not a milestone$/);
  await assert.rejects(() => core.addCard(e.projectDir, { title: 'X', kind: 'milestone', parent: 'c1' }), /^Error: a milestone cannot have a parent$/);
  assert.equal(cards(e).length, 3, 'a refused add creates nothing');

  const other = await core.addCard(e.projectDir, { title: 'Other', kind: 'milestone' });
  await assert.rejects(() => core.updateCard(e.projectDir, other.id, { parent: 'c1' }), /a milestone cannot have a parent/);
  await assert.rejects(() => core.updateCard(e.projectDir, 'c2', { parent: 'c3' }), /c3 is not a milestone/);
  await assert.rejects(() => core.updateCard(e.projectDir, 'c2', { parent: 'c9' }), /milestone not found: c9/);
  assert.equal((await core.updateCard(e.projectDir, 'c2', { parent: other.id })).parent, other.id);
  assert.equal('parent' in (await core.updateCard(e.projectDir, 'c2', { parent: '' })), false);
  await core.updateCard(e.projectDir, 'c3', { parent: 'c4' });
  assert.equal('parent' in (await core.updateCard(e.projectDir, 'c3', { parent: null })), false);
  assert.equal((await core.updateCard(e.projectDir, other.id, { parent: '' })).kind, 'milestone', 'clearing a milestone\'s parent is a no-op');

  // A thread card may have a parent, set at start or later; the status is untouched.
  const th = await core.startThread(e.projectDir, { title: 'Th', task: 'x', sessionId: PARENT_SESSION, parent: 'c1' });
  assert.equal(th.parent, 'c1');
  await assert.rejects(() => core.startThread(e.projectDir, { title: 'Th2', task: 'x', sessionId: PARENT_SESSION, parent: 'c2' }), /c2 is not a milestone/);
  assert.equal(cards(e).filter((c) => c.kind === 'thread').length, 1);
  await waitFor(() => card(e, th.id).thread.runState === 'idle', { timeout: 10000 });
  const moved = await core.updateCard(e.projectDir, th.id, { parent: other.id });
  assert.equal(moved.parent, other.id);
  assert.equal(moved.status, 'review');
});

test('startThreadFromCard keeps the card\'s parent, and a milestone cannot become a thread', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Launch', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'Look into it', parent: 'c1' });
  const started = await core.startThreadFromCard(e.projectDir, 'c2', { sessionId: PARENT_SESSION });
  assert.equal(started.kind, 'thread');
  assert.equal(started.parent, 'c1');
  await assert.rejects(() => core.startThreadFromCard(e.projectDir, 'c1', { sessionId: PARENT_SESSION }), /milestone/);
});

test('removing a milestone clears parent on its cards and keeps them; removing a child leaves the milestone', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  await core.addCard(e.projectDir, { title: 'A', parent: 'c1' });
  await core.addCard(e.projectDir, { title: 'B', parent: 'c1' });
  await core.addCard(e.projectDir, { title: 'Free' });
  await core.removeCard(e.projectDir, 'c2');
  assert.deepEqual(cards(e).map((c) => c.id), ['c1', 'c3', 'c4']);
  await core.removeCard(e.projectDir, 'c1');
  assert.deepEqual(cards(e).map((c) => [c.id, c.parent]), [['c3', undefined], ['c4', undefined]]);
});

test('milestone progress counts the cards in the done role', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: STAGES });
  await core.addCard(e.projectDir, { title: 'M', kind: 'milestone' });
  for (const [title, status] of [['A', 'done'], ['B', 'doing'], ['C', 'done'], ['D', 'new_gone']]) {
    await core.addCard(e.projectDir, { title, parent: 'c1', status: status === 'new_gone' ? 'todo' : status });
  }
  await core.addCard(e.projectDir, { title: 'Elsewhere', status: 'done' });
  const cfg = core.readConfig(e.projectDir);
  assert.deepEqual(core.milestoneProgress(cards(e), 'c1', cfg), { done: 2, total: 4 });
  assert.deepEqual(core.milestoneProgress(cards(e), 'c9', cfg), { done: 0, total: 0 });
});

// ------------------------------------------------------------ MCP

test('tools take any stage id of the project; the schema no longer fixes the status values', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: STAGES });
  const c = mcp(t, e);
  await c.init();
  const tools = (await c.request('tools/list', {})).result.tools;
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  for (const name of ['board_add', 'board_update']) {
    assert.equal(byName[name].inputSchema.properties.status.enum, undefined, name);
    assert.match(byName[name].inputSchema.properties.status.description, /board_list shows them/);
  }
  assert.ok(byName.board_add.inputSchema.properties.kind.enum.includes('milestone'));
  for (const name of ['board_add', 'board_update', 'board_list', 'thread_start']) assert.equal(byName[name].inputSchema.properties.parent.type, 'string', name);
  assert.match(byName.thread_continue.description, /Since your last turn:/);
  assert.deepEqual(byName.config_set.inputSchema.required, ['scope']);

  const ok = await c.call('board_add', { title: 'Plan', status: 'check' });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /in check\./);
  const bad = await c.call('board_add', { title: 'Plan', status: 'new' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid status "new" \(use one of: todo, doing, check, done\)/);
  assert.equal((await c.call('board_add', { title: 'Default' })).text.includes('in todo.'), true);
});

test('board_list groups by stage label, tags cards with their milestone, shows progress, and reports one milestone', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  await c.call('board_add', { title: 'Ship the new onboarding flow for everyone this quarter', kind: 'milestone', note: 'The big one' });
  await c.call('board_add', { title: 'Write copy', parent: 'c1', status: 'done' });
  await c.call('board_add', { title: 'Build screens', parent: 'c1', status: 'in_progress' });
  await c.call('board_add', { title: 'Unrelated' });
  const m2 = await c.call('board_add', { title: 'Other milestone', kind: 'milestone' });
  assert.match(m2.text, /^Added c5 \[milestone\]/);
  await c.call('board_add', { title: 'Elsewhere', parent: 'c5' });

  const list = (await c.call('board_list')).text;
  const tag = '[Ship the new onboarding flow …]';
  assert.match(list, /^New \(2\)$/m, 'the milestones are not in the stage groups');
  assert.match(list, /^In progress \(1\)$/m);
  assert.match(list, /^Done \(1\)$/m);
  assert.ok(list.includes(`- c3 [task] Build screens ${tag}`), list);
  assert.ok(list.includes(`- c2 [task] Write copy ${tag}`), list);
  assert.ok(list.includes('- c1 [milestone:open] Ship the new onboarding flow for everyone this quarter (1/2 done) — The big one'), list);
  assert.ok(list.includes('- c5 [milestone:open] Other milestone (0/1 done)'), list);
  assert.match(list, /^Milestones \(2\)$/m, 'milestones have their own section');
  assert.match(list, /^- c4 \[task\] Unrelated$/m);
  assert.match(list, /\nStages, as id: label \[what the plugin uses it for\]:\n- idea: Idea\n- new: New \[start\]\n- in_progress: In progress \[working\]\n- review: Review \[review\]\n- blocked: Blocked \[blocked\]\n- done: Done \[done\]$/);

  const report = (await c.call('board_list', { parent: 'c1' })).text;
  const lines = report.split('\n');
  assert.equal(lines[0], 'Milestone c1 "Ship the new onboarding flow for everyone this quarter": open, 1 of 2 done.');
  assert.ok(report.includes('- c2 [task] Write copy') && report.includes('- c3 [task] Build screens'));
  assert.ok(!report.includes('Unrelated') && !report.includes('Elsewhere') && !report.includes('Other milestone'));
  assert.ok(report.includes('(1/2 done)'));

  const notMilestone = await c.call('board_list', { parent: 'c2' });
  assert.equal(notMilestone.isError, true);
  assert.equal(notMilestone.text, 'c2 is not a milestone');
  assert.equal((await c.call('board_list', { parent: 'c99' })).text, 'milestone not found: c99');
});

test('board_update sets and clears a milestone; thread_status shows the milestone tag', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  await c.call('board_add', { title: 'Launch', kind: 'milestone' });
  await c.call('board_add', { title: 'Task' });
  const set = await c.call('board_update', { id: 'c2', parent: 'c1' });
  assert.match(set.text, /milestone c1/);
  assert.equal(card(e, 'c2').parent, 'c1');
  const clear = await c.call('board_update', { id: 'c2', parent: '' });
  assert.equal(clear.isError, false, clear.text);
  assert.equal(card(e, 'c2').parent, undefined);
  assert.equal((await c.call('board_update', { id: 'c2', parent: 'c2' })).text, 'c2 is not a milestone');

  const started = await c.call('thread_start', { title: 'Research', task: 'look', session_id: PARENT_SESSION, parent: 'c1' });
  assert.equal(started.isError, false, started.text);
  assert.equal(card(e, 'c3').parent, 'c1');
  assert.match((await c.call('thread_status', { id: 'c3' })).text, /^c3 "Research" \[Launch\] — /);
  assert.match((await c.call('thread_status', {})).text, /^c3 "Research" \[Launch\] — /);
  assert.equal((await c.call('thread_start', { title: 'X', task: 'y', session_id: PARENT_SESSION, parent: 'c2' })).text, 'c2 is not a milestone');
});

test('config_get shows the defaults with no config; config_set saves, returns the new config and counts orphaned cards', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  const first = (await c.call('config_get')).text;
  assert.match(first, /^Set up: no/);
  assert.match(first, /Mode: tasks .* — from default/);
  assert.match(first, /- in_progress: In progress/);
  assert.match(first, /- start: new \(a new card lands here\)/);
  assert.match(first, /Global config file: .*config\.json \(not created\)/);

  await c.call('board_add', { title: 'Old', status: 'review' });
  const set = await c.call('config_set', { scope: 'project', stages: STAGES, roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' } });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /^Saved to the project config file\./);
  assert.match(set.text, /Set up: yes/);
  assert.match(set.text, /Stages, in order — from project config file:\n- todo: To do\n- doing: Doing\n- check: Check\n- done: Finished/);
  assert.match(set.text, /In this project, 1 card\(s\) have a status that is no longer a stage; they show in the start stage \(todo\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(core.configPaths(e.projectDir).project, 'utf8')).stages, STAGES);
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).global), false);
  assert.equal(card(e, 'c1').status, 'review', 'cards are not changed');
  assert.equal((await c.call('config_get')).text, set.text.split('\n\n').slice(1, -1).join('\n\n'));

  // Global scope, then the project file hides it for stages.
  const g = await c.call('config_set', { scope: 'global', mode: 'chat' });
  assert.match(g.text, /Mode: chat .* — from global config file/);
  assert.match(g.text, /Stages, in order — fixed for chat-only \(what the board shows now\):\n- new: New\n- review: Review\n- done: Done/);
  assert.match(g.text, /The task board's own settings, kept for when it is turned on\. Stages, in order — from project config file:\n- todo: To do\n- doing: Doing\n- check: Check\n- done: Finished\nRoles of the task board[^\n]*\n- start: todo/);
  assert.equal(JSON.parse(fs.readFileSync(core.configPaths(e.projectDir).global, 'utf8')).mode, 'chat');
  assert.match(g.text, /Every card is in a current stage|no longer a stage/);
});

test('config_set refuses bad input and reset takes no other field; reset deletes the file', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  const bad = [
    [{}, /"scope" is required/],
    [{ scope: 'everywhere', mode: 'chat' }, /scope.*one of: global, project/],
    [{ scope: 'project' }, /nothing to change/],
    [{ scope: 'project', mode: 'both' }, /mode.*one of: tasks, chat/],
    [{ scope: 'project', stages: [{ id: 'only', label: 'One' }] }, /2 to 10/],
    [{ scope: 'project', stages: [{ id: 'Bad Id', label: 'x' }, { id: 'ok', label: 'y' }] }, /not valid/],
    [{ scope: 'project', stages: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], roles: { done: 'z' } }, /not one of the stages/],
    [{ scope: 'project', reset: true, mode: 'chat' }, /no other setting/],
  ];
  for (const [args, re] of bad) {
    const r = await c.call('config_set', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).project), false, 'nothing was written');

  await c.call('config_set', { scope: 'project', mode: 'chat' });
  await c.call('config_set', { scope: 'global', mode: 'tasks', stages: STAGES });
  const reset = await c.call('config_set', { scope: 'project', reset: true });
  assert.equal(reset.isError, false, reset.text);
  assert.match(reset.text, /^The project config file was deleted\./);
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).project), false);
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).global), true);
  assert.match(reset.text, /Stages, in order — from global config file/);
  const clearStages = await c.call('config_set', { scope: 'global', stages: null });
  assert.equal(clearStages.isError, false, clearStages.text);
  assert.match(clearStages.text, /Stages, in order — from default/);
});

// ------------------------------------------------------------ chat-only

const CHAT_MSG = 'The task board is off for this project (chat-only). Run /thread:setup to turn it on.';

test('chat-only: board_add and the task cards\' update and remove are refused, thread cards still work, board_list shows threads only', async (t) => {
  const e = setupThreadEnv(t);
  const task = { id: 'c1', kind: 'task', title: 'Old task', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x' };
  const ms = { ...task, id: 'c2', kind: 'milestone', title: 'Old milestone' };
  const th = threadCard({ id: 'c3', title: 'Side research' });
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task, ms, th]));
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const c = mcp(t, e);
  await c.init();

  for (const [name, args] of [
    ['board_add', { title: 'New' }],
    ['board_add', { title: 'New', kind: 'milestone' }],
    ['board_update', { id: 'c1', title: 'x' }],
    ['board_update', { id: 'c2', note: 'x' }],
    ['board_remove', { id: 'c1' }],
    ['board_remove', { id: 'c2' }],
  ]) {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.text, CHAT_MSG, name);
  }
  assert.deepEqual(cards(e).map((x) => x.id), ['c1', 'c2', 'c3'], 'existing cards are kept');

  const upd = await c.call('board_update', { id: 'c3', title: 'Renamed thread' });
  assert.equal(upd.isError, false, upd.text);
  const list = (await c.call('board_list')).text;
  assert.match(list, /^This project is chat-only/m);
  assert.match(list, /Renamed thread/);
  assert.ok(!list.includes('Old task') && !list.includes('Old milestone'));
  const rm = await c.call('board_remove', { id: 'c3' });
  assert.equal(rm.isError, false, rm.text);
  assert.match((await c.call('board_list')).text, /chat-only[\s\S]*No threads\./);
  assert.equal(card(e, 'c1').title, 'Old task');

  await assert.rejects(() => core.startThreadFromCard(e.projectDir, 'c1', { sessionId: PARENT_SESSION }), /chat-only/);
  const s = await c.call('thread_start', { title: 'Still works', task: 'x', session_id: PARENT_SESSION });
  assert.equal(s.isError, false, s.text);
});

test('chat-only over HTTP: creating, editing, deleting and starting a task card get 409; threads and GET state still work', async (t) => {
  const e = setupThreadEnv(t);
  const task = { id: 'c1', kind: 'task', title: 'Old task', note: '', status: 'new', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x' };
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [task, threadCard({ id: 'c2' })]));
  writeGlobal(e, { mode: 'chat' });
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}/api`;
  const send = (method, url, body) => fetch(base + url, { method, headers: JSON_HDR, body: body === undefined ? undefined : JSON.stringify(body) });

  for (const [method, url, body] of [
    ['POST', '/cards', { title: 'New' }],
    ['POST', '/cards', { title: 'New', kind: 'milestone' }],
    ['PATCH', '/cards/c1', { title: 'x' }],
    ['DELETE', '/cards/c1'],
    ['POST', '/cards/c1/start', { sessionId: PARENT_SESSION, mode: 'read' }],
  ]) {
    const r = await send(method, url, body);
    assert.equal(r.status, 409, `${method} ${url}`);
    assert.deepEqual(await r.json(), { error: CHAT_MSG });
  }
  assert.equal(cards(e).length, 2);
  assert.equal((await send('PATCH', '/cards/c2', { title: 'Renamed' })).status, 200);
  const state = await (await send('GET', '/state')).json();
  assert.equal(state.config.mode, 'chat');
  assert.equal(state.cards.length, 2, 'existing cards stay in the state');
});

test('the hook does not mention new board cards from the user in chat-only mode', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'u1', source: 'user' });
  const run = () => runNode([HOOK_PATH, 'UserPromptSubmit'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir },
    input: JSON.stringify({ cwd: e.projectDir, hook_event_name: 'UserPromptSubmit', session_id: PARENT_SESSION, prompt: 'x' }),
    cwd: e.projectDir,
  });
  assert.match((await run()).stdout, /1 new board card/);
  await core.saveConfig(e.projectDir, 'global', { mode: 'chat' });
  const chat = await run();
  assert.equal(chat.code, 0);
  assert.equal(chat.stdout.trim(), '');
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [...cards(e), threadCard({ id: 'c2', title: 'Zebra' })]));
  const notice = JSON.parse((await run()).stdout.trim()).hookSpecificOutput.additionalContext;
  assert.match(notice, /Thread c2 "Zebra" finished/, 'thread notices still come');
  assert.ok(!notice.includes('new board card'));
});

// ------------------------------------------------------------ setup hint

test('SessionStart adds the setup hint once per machine, and not when a config file exists', async (t) => {
  const e = setupThreadEnv(t);
  const start = () => runNode([HOOK_PATH, 'SessionStart'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir },
    input: JSON.stringify({ cwd: e.projectDir, hook_event_name: 'SessionStart', session_id: PARENT_SESSION }),
    cwd: e.projectDir,
  });
  const ctx = async () => {
    const r = await start();
    assert.equal(r.code, 0);
    return JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
  };
  const first = await ctx();
  assert.ok(first.includes(PARENT_SESSION));
  assert.ok(first.includes('The thread plugin has not been set up.'));
  assert.ok(first.includes('/thread:setup'));
  assert.equal(first.split('\n').length, 3, 'the waiting-item sentence and one setup line added to the session note');
  assert.equal(fs.existsSync(path.join(e.dataDir, 'setup-hint')), true);
  const second = await ctx();
  assert.ok(!second.includes('/thread:setup'));
  assert.ok(second.includes(PARENT_SESSION));

  // A set-up plugin never shows it, even with no marker.
  fs.rmSync(path.join(e.dataDir, 'setup-hint'));
  await core.saveConfig(e.projectDir, 'global', { mode: 'tasks' });
  assert.ok(!(await ctx()).includes('/thread:setup'));
  assert.equal(fs.existsSync(path.join(e.dataDir, 'setup-hint')), false, 'no marker is made');
});

test('a marker that cannot be written does not break SessionStart', async (t) => {
  const e = setupThreadEnv(t);
  // The data dir sits below a plain file, so neither it nor the marker can be created.
  fs.writeFileSync(path.join(e.base, 'blocker'), '');
  const r = await runNode([HOOK_PATH, 'SessionStart'], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: path.join(e.base, 'blocker', 'data') },
    input: JSON.stringify({ cwd: e.projectDir, hook_event_name: 'SessionStart', session_id: PARENT_SESSION }),
    cwd: e.projectDir,
  });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout.trim()).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(PARENT_SESSION));
  assert.ok(ctx.includes('/thread:setup'), 'the hint shows again because the marker could not be made');
});

// ------------------------------------------------------------ board API

test('GET state carries config, the effective status of each card and progress on milestones', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: STAGES, roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' } });
  const old = { id: 'c3', kind: 'task', title: 'Old', note: '', status: 'in_progress', source: 'claude', seenByClaude: true, createdAt: 'x', updatedAt: 'x', parent: 'c1' };
  const ms = { ...old, id: 'c1', kind: 'milestone', title: 'M', status: 'doing' };
  delete ms.parent;
  const done = { ...old, id: 'c2', title: 'Done one', status: 'done' };
  const file = writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [ms, done, old, threadCard({ id: 'c4', parent: 'c1' })]));
  const stored = fs.readFileSync(file, 'utf8');
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const s = await (await fetch(`http://127.0.0.1:${b.port}/api/state`)).json();
  assert.deepEqual(s.config, {
    mode: 'tasks',
    stages: STAGES,
    roles: { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' },
  });
  const by = Object.fromEntries(s.cards.map((c) => [c.id, c]));
  assert.deepEqual(by.c1.progress, { done: 1, total: 3 });
  assert.equal(by.c3.status, 'todo', 'unknown stored status shows in the start stage');
  assert.equal(by.c4.status, 'check', 'a thread shows in the stage for its run state');
  assert.equal(by.c2.progress, undefined);
  assert.equal(by.c3.parent, 'c1');
  assert.equal(fs.readFileSync(file, 'utf8'), stored, 'GET does not rewrite the state');
});

test('with no config GET state reports the default stages and roles', async (t) => {
  const e = setupThreadEnv(t);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const s = await (await fetch(`http://127.0.0.1:${b.port}/api/state`)).json();
  assert.deepEqual(s.config.stages.map((x) => x.id), core.STATUSES);
  assert.equal(s.config.mode, 'tasks');
  assert.equal(s.config.roles.start, 'new');
});

test('POST cards takes kind milestone and parent; PATCH sets and clears parent; errors are 400', async (t) => {
  const e = setupThreadEnv(t);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const base = `http://127.0.0.1:${b.port}/api`;
  const send = (method, url, body) => fetch(base + url, { method, headers: JSON_HDR, body: JSON.stringify(body) });

  const m = await send('POST', '/cards', { title: 'Launch', kind: 'milestone' });
  assert.equal(m.status, 201);
  const mj = await m.json();
  assert.equal(mj.kind, 'milestone');
  assert.deepEqual(mj.progress, { done: 0, total: 0 });
  const t1 = await send('POST', '/cards', { title: 'Task', parent: 'c1' });
  assert.equal(t1.status, 201);
  assert.equal((await t1.json()).parent, 'c1');
  assert.equal(card(e, 'c2').source, 'user');

  const bad = await send('POST', '/cards', { title: 'X', parent: 'c2' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'c2 is not a milestone' });
  assert.equal((await send('POST', '/cards', { title: 'X', parent: 5 })).status, 400);

  await send('POST', '/cards', { title: 'Second' });
  assert.equal((await (await send('PATCH', '/cards/c3', { parent: 'c1' })).json()).parent, 'c1');
  const cleared = await (await send('PATCH', '/cards/c3', { parent: '' })).json();
  assert.equal(cleared.parent, undefined);
  assert.equal((await (await send('PATCH', '/cards/c2', { parent: null })).json()).parent, undefined);
  assert.equal(card(e, 'c2').parent, undefined);
  assert.equal((await send('PATCH', '/cards/c1', { parent: 'c3' })).status, 400);
  const prog = await (await send('PATCH', '/cards/c1', { title: 'Launch 2' })).json();
  assert.deepEqual(prog.progress, { done: 0, total: 0 });
});

test('the board has no way to write the config', async (t) => {
  const e = setupThreadEnv(t);
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  for (const url of ['/api/config', '/api/p/' + core.projectKey(e.projectDir) + '/config']) {
    const r = await fetch(`http://127.0.0.1:${b.port}${url}`, { method: 'PUT', headers: JSON_HDR, body: JSON.stringify({ mode: 'chat' }) });
    assert.equal(r.status, 404, url);
  }
  assert.equal(fs.existsSync(core.configPaths(e.projectDir).global), false);
});

test('changing stages without roles drops the old roles, and the six default ids keep the default roles', async (t) => {
  const e = setupThreadEnv(t);
  await core.saveConfig(e.projectDir, 'global', {
    stages: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'done', label: 'Done' }],
    roles: { blocked: 'todo' },
  });
  let cfg = await core.saveConfig(e.projectDir, 'global', { stages: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  assert.deepEqual(cfg.roles, { start: 'a', working: 'a', review: 'b', blocked: 'a', done: 'b' });
  // a project that wants the default six while the global file has its own
  cfg = await core.saveConfig(e.projectDir, 'project', { stages: core.STATUSES.map((id) => ({ id, label: id })) });
  assert.equal(cfg.source.stages, 'project');
  assert.deepEqual(cfg.roles, { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' });
});

// ------------------------------------------------------------ found in review

test('a thread card always sits in the stage for its run state, whatever status is stored', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { id: 'c1', kind: 'milestone', title: 'M', note: '', status: 'new', source: 'claude', seenByClaude: true },
    threadCard({ id: 'c2', status: 'done', parent: 'c1' }, { runState: 'ended' }),
    threadCard({ id: 'c3', status: 'review', parent: 'c1' }, { runState: 'idle' }),
  ]));
  // review and done stay stages, but the roles now point at the stages after them
  await core.saveConfig(e.projectDir, 'project', {
    stages: ['new', 'in_progress', 'review', 'qa', 'done', 'shipped'].map((id) => ({ id, label: id })),
    roles: { review: 'qa', done: 'shipped' },
  });
  const cfg = core.readConfig(e.projectDir);
  assert.equal(core.effectiveStatus(card(e, 'c2'), cfg), 'shipped');
  assert.equal(core.effectiveStatus(card(e, 'c3'), cfg), 'qa');
  assert.deepEqual(core.milestoneProgress(cards(e), 'c1', cfg), { done: 1, total: 2 });
  assert.equal(card(e, 'c2').status, 'done', 'the file is not rewritten');
});

test('board_list gives every stage with its id and roles, also on an empty board', async (t) => {
  const e = setupThreadEnv(t);
  writeGlobal(e, { stages: [{ id: 's1', label: 'واحد' }, { id: 's2', label: 'اثنان' }, { id: 's3', label: 'ثلاثة' }] });
  const c = mcp(t, e);
  await c.init();
  assert.equal((await c.call('board_list')).text, 'The board is empty.\n\nStages, as id: label [what the plugin uses it for]:\n- s1: واحد [start]\n- s2: اثنان [working, review, blocked]\n- s3: ثلاثة [done]');
});

test('an invalid config file is reported by config_get and never overwritten by config_set', async (t) => {
  const e = setupThreadEnv(t);
  const bad = JSON.stringify({ mode: 'chat', stages: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], roles: { done: 'zzz' } });
  writeProject(e, bad);
  const c = mcp(t, e);
  await c.init();
  assert.match((await c.call('config_get')).text, /Project config file: .* \(IGNORED, not valid: role "done" points to "zzz"/);
  const set = await c.call('config_set', { scope: 'project', mode: 'tasks' });
  assert.equal(set.isError, true);
  assert.match(set.text, /project config file is not valid/);
  assert.equal(fs.readFileSync(core.configPaths(e.projectDir).project, 'utf8'), bad);
  assert.equal((await c.call('config_set', { scope: 'project', reset: true })).isError, false);
});

test('config_set merges a partial roles change, removes mode with null, and is refused inside a thread', async (t) => {
  const e = setupThreadEnv(t);
  const c = mcp(t, e);
  await c.init();
  const roles = { start: 'todo', working: 'doing', review: 'check', blocked: 'todo', done: 'done' };
  await c.call('config_set', { scope: 'project', mode: 'chat', stages: STAGES, roles });
  await c.call('config_set', { scope: 'project', roles: { blocked: 'check' } });
  assert.deepEqual(core.readConfig(e.projectDir).taskRoles, { ...roles, blocked: 'check' });
  const cleared = await c.call('config_set', { scope: 'project', mode: null });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(core.readConfig(e.projectDir).mode, 'tasks');
  assert.deepEqual(core.readConfig(e.projectDir).stages, STAGES, 'the stages stay');

  const inThread = mcp(t, e, { THREAD_DEPTH: '1' });
  await inThread.init();
  const r = await inThread.call('config_set', { scope: 'project', mode: 'chat' });
  assert.equal(r.isError, true);
  assert.match(r.text, /side thread cannot change the plugin settings/);
  assert.equal(core.readConfig(e.projectDir).mode, 'tasks');
});

test('in chat-only mode board_list leaves the user\'s hidden cards unseen', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'From the user', source: 'user' });
  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const c = mcp(t, e);
  await c.init();
  const list = (await c.call('board_list')).text;
  assert.doesNotMatch(list, /new from the user/);
  assert.equal(card(e, 'c1').seenByClaude, false);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  assert.match((await c.call('board_list')).text, /c1 \[task\] From the user \(new from user\)/);
});

test('the board hides a parent that is no longer a milestone', async (t) => {
  const e = setupThreadEnv(t);
  writeStateFile(e.dataDir, e.projectDir, emptyState(e.projectDir, [
    { id: 'c2', kind: 'task', title: 'Orphan', note: '', status: 'new', source: 'claude', seenByClaude: true, parent: 'c1' },
  ]));
  const b = await startBoardServer(e.projectDir, { port: 0 });
  t.after(() => new Promise((r) => { b.server.closeAllConnections(); b.server.close(() => r()); }));
  const state = await (await fetch(b.url + 'api/state')).json();
  assert.equal('parent' in state.cards[0], false);
});

test('every skill has front matter a strict YAML parser accepts', () => {
  const dir = new URL('../skills/', import.meta.url);
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(new URL(`${name}/SKILL.md`, dir), 'utf8');
    const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(head, `${name}: no front matter`);
    for (const line of head[1].split('\n')) {
      const m = /^([a-z-]+): (.*)$/.exec(line);
      assert.ok(m, `${name}: ${line}`);
      // an unquoted value must not contain ": " or " #", or start with a character YAML treats specially
      if (!/^".*"$/.test(m[2])) assert.doesNotMatch(m[2], /: | #|^[\[\]{}&*!|>'"%@`]/, `${name}: quote the ${m[1]}`);
    }
  }
});
