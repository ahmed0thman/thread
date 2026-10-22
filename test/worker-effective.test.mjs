// The Worker field of a card page shows who works on the card (effectiveWorker in model.js): what runs on it now, else the saved worker, else
// the last worker Claude used, else Claude (default); the badges of the picker; what the start step preselects. The page's own code runs in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = (name) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
const fn = (re) => { const m = re.exec(html); assert.ok(m, `${re} is missing from the board page`); return m[0]; };
const plain = (x) => JSON.parse(JSON.stringify(x));

const NOW = Date.parse('2026-10-14T03:30:00.000Z');
const AGENTS = { agents: [
  { name: 'deep-analyst', description: 'Digs.', model: 'claude-opus-5-5', effort: 'high', scope: 'project' },
  { name: 'worker', description: 'Routine.', model: null, effort: null, scope: 'user' },
] };
const LANES = { available: true, projectTrusted: true, lanes: [
  { name: 'code-codex', implementer: 'codex', model: 'gpt-fake', effort: 'high', variant: null, readOnly: false, source: 'global', approved: true },
  { name: 'review-ro', implementer: 'claude', model: null, effort: 'xhigh', variant: null, readOnly: true, source: 'project', approved: false },
] };

function load(lanes = LANES, agents = AGENTS) {
  const doc = { createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const env = {
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
  };
  const src = [fn(/  function fmtMs\(ms\) \{[\s\S]*?\n  \}\n/), block('tokens and agents'), block('delegation lanes'), block('workers'), block('working now'), block('effective worker'), fn(/  function workerFieldContent\(eff\) \{[\s\S]*?\n  \}\n/)].join('\n');
  return vm.runInNewContext(`let lanes = ${JSON.stringify(lanes)}, agents = ${JSON.stringify(agents)};\n${src}\n({ lastWorkerOf, workerRunnable, effectiveWorker, workerMarks, workerFieldContent, workerOf, setAgents(v) { agents = v; } })`, vm.createContext(env));
}

const run = (over = {}) => ({ n: 1, agentId: 'a1', agentType: 'deep-analyst', state: 'running', startedAt: '2026-10-14T03:26:00.000Z', ...over });
const task = (over = {}) => ({ id: 'c7', kind: 'task', title: 'T', status: 'in_progress', createdAt: '2026-10-14T01:00:00.000Z', ...over });
const hist = (worker, at, by = 'claude') => ({ at, by, type: 'edited', worker });
const eff = (page, card) => plain(page.effectiveWorker(card, NOW));
const startKeyOf = (page, card) => page.effectiveWorker(card, NOW).startKey;

test('something running on the card wins: its agent type and "working now", then the saved worker and what Start uses in the caption and the tooltip', () => {
  const page = load();
  const e = eff(page, task({ runs: [run()] }));
  assert.equal(e.state, 'now');
  assert.equal(e.text, 'deep-analyst · working now');
  assert.equal(e.caption, 'Start as thread uses: agent: deep-analyst', 'nothing saved: the step preselects the one that works, as the last one used');
  assert.deepEqual(e.running, ['agent:deep-analyst']);
  assert.equal(e.title, 'Working now\ndeep-analyst: running for 4m 00s\nSaved worker: none (Claude (default))\nStart as thread uses: agent: deep-analyst');
  const gp = eff(page, task({ runs: [run({ agentType: 'general-purpose' })] }));
  assert.deepEqual([gp.text, gp.caption], ['general-purpose · working now', 'Start as thread uses: Claude (default)'], 'a built-in agent cannot run a thread');
  const lane = eff(page, task({ lane: 'code-codex', runs: [run()] }));
  assert.equal(lane.text, 'deep-analyst · working now', 'a saved lane does not hide who works now');
  assert.equal(lane.caption, 'Start as thread uses: code-codex · codex · gpt-fake · high');
  assert.match(lane.title, /Saved worker: code-codex · codex · gpt-fake · high/);
  const many = eff(page, task({ runs: [run(), run({ n: 2, agentType: 'worker' }), run({ n: 3, agentType: 'worker' })] }));
  assert.equal(many.text, '3 agents working');
  assert.deepEqual(many.running, ['agent:deep-analyst', 'agent:worker']);
  assert.match(many.title, /deep-analyst: running for 4m 00s\nworker: running/);
});

test('the saved sub-agent that is also the one running needs no caption', () => {
  const page = load();
  assert.equal(eff(page, task({ agent: 'deep-analyst', runs: [run()] })).caption, '');
  assert.equal(eff(page, task({ agent: 'worker', runs: [run()] })).caption, 'Start as thread uses: agent: worker');
  assert.equal(eff(page, task({ agent: 'deep-analyst', runs: [run(), run({ n: 2, agentType: 'worker' })] })).caption, 'Start as thread uses: agent: deep-analyst', 'two kinds working: the saved one is not all of them');
});

test('a run of a thread that does the card\'s work is the lane\'s: it is working now as that lane, and the last one used when it is over', () => {
  const page = load();
  const linked = (over = {}) => ({ n: 1, thread: 'c9', turn: 1, lane: 'code-codex', agentType: 'code-codex', state: 'running', startedAt: '2026-10-14T03:26:00.000Z', ...over });
  const now = eff(page, task({ runs: [linked()] }));
  assert.deepEqual([now.state, now.text], ['now', 'code-codex · working now']);
  assert.deepEqual(now.running, ['lane:code-codex'], 'the picker badge goes to the lane, not to an agent of that name');
  assert.deepEqual(plain(page.workerMarks(task({ runs: [linked()] }))), { 'lane:code-codex': 'now' });
  assert.equal(eff(page, task({ lane: 'code-codex', runs: [linked()] })).caption, '', 'the saved lane is the one working: nothing to add');
  const over = task({ runs: [linked({ state: 'done' })] });
  assert.equal(page.lastWorkerOf(over).key, 'lane:code-codex');
  assert.equal(eff(page, over).text, 'code-codex · last used');
  assert.equal(startKeyOf(page, over), 'lane:code-codex');
  // newer than an older sub-agent run, older than a newer one
  assert.equal(page.lastWorkerOf(task({ runs: [run({ state: 'done' }), linked({ n: 2, state: 'done', startedAt: '2026-10-14T03:27:00.000Z' })] })).key, 'lane:code-codex');
  assert.equal(page.lastWorkerOf(task({ runs: [linked({ state: 'done' }), run({ n: 2, state: 'done', startedAt: '2026-10-14T03:28:00.000Z' })] })).key, 'agent:deep-analyst');
  // a thread that is no lane's is nobody to show, as in the history
  assert.equal(page.lastWorkerOf(task({ runs: [linked({ lane: undefined, agentType: 'thread', state: 'done' })] })), null);
  // a thread that runs as an agent (no lane) is that agent's, as workedBy counts it
  const asAgent = linked({ lane: undefined, agentType: 'worker', state: 'done' });
  assert.equal(page.lastWorkerOf(task({ runs: [asAgent] })).key, 'agent:worker');
  assert.deepEqual(plain(page.workerMarks(task({ runs: [{ ...asAgent, state: 'running' }] }))), { 'agent:worker': 'now' });
});

test('a quiet run is muted, not "working now"; a live run beside it wins', () => {
  const page = load();
  const q = eff(page, task({ runs: [run({ quiet: true })] }));
  assert.equal(q.state, 'quiet');
  assert.equal(q.text, 'deep-analyst · quiet');
  assert.deepEqual(q.running, [], 'no badge for a run that may have stopped');
  assert.equal(eff(page, task({ runs: [run({ quiet: true }), run({ n: 2, agentType: 'worker', quiet: true })] })).text, '2 agents quiet');
  const mixed = eff(page, task({ runs: [run({ quiet: true }), run({ n: 2, agentType: 'worker' })] }));
  assert.deepEqual([mixed.state, mixed.text], ['now', 'worker · working now']);
});

test('with nothing running the saved worker shows as it does today, and a card with none and no history says Claude (default)', () => {
  const page = load();
  const s = eff(page, task({ agent: 'worker', runs: [run({ state: 'done' })] }));
  assert.deepEqual([s.state, s.text, s.caption, s.title], ['saved', 'agent: worker', '', '']);
  assert.equal(eff(page, task({ lane: 'code-codex' })).text, 'code-codex · codex · gpt-fake · high');
  const d = eff(page, task());
  assert.deepEqual([d.state, d.text, d.caption, d.startKey], ['default', 'Claude (default)', '', '']);
  assert.equal(eff(page, task({ runs: [], history: [hist('main', '2026-10-14T02:00:00.000Z'), hist('thread:c9', '2026-10-14T02:10:00.000Z')] })).state, 'default', '"main" and a thread are nobody to show');
});

test('the last worker used: the newest of the runs and the worked-by records of the history, by time', () => {
  const page = load();
  const fin = (over) => run({ state: 'done', finishedAt: '2026-10-14T03:00:00.000Z', ...over });
  const one = eff(page, task({ runs: [fin()] }));
  assert.equal(one.state, 'last');
  assert.equal(one.text, 'deep-analyst · last used');
  assert.equal(one.caption, 'Start as thread uses: agent: deep-analyst');
  assert.equal(one.title, 'Last used on this card: deep-analyst (sub-agent, 4m 00s ago)\nSaved worker: none (Claude (default))\nStart as thread uses: agent: deep-analyst');
  // a record newer than the run
  const newer = task({ runs: [fin({ startedAt: '2026-10-14T02:00:00.000Z' })], history: [hist('lane:code-codex', '2026-10-14T03:00:00.000Z')] });
  assert.equal(eff(page, newer).text, 'code-codex · last used');
  assert.match(eff(page, newer).title, /^Last used on this card: code-codex \(lane, 30m 00s ago\)/);
  // a run newer than the record, whatever the order of the lists
  const older = task({ runs: [fin({ agentType: 'worker', startedAt: '2026-10-14T03:10:00.000Z' })], history: [hist('agent:deep-analyst', '2026-10-14T03:00:00.000Z'), hist('main', '2026-10-14T03:20:00.000Z')] });
  assert.equal(eff(page, older).text, 'worker · last used', '"main" after it changes nothing');
  assert.equal(page.lastWorkerOf(task({ runs: [fin({ agentType: 'a-very-long-agent-type-name-cut-with-…' })] })).key, 'agent:a-very-long-agent-type-name-cut-with-', 'a type cut with … loses the dots');
  assert.equal(page.lastWorkerOf(task({ runs: [{ agentType: '' }, null, 'x'], history: [null, { worker: 5 }, { worker: 'agent:' }, { worker: 'thread:c2' }] })), null, 'junk and the empty name are ignored');
  assert.equal(page.lastWorkerOf(null), null);
  assert.equal(JSON.stringify(plain(page.lastWorkerOf(task({ history: [hist('agent:x', 'not a date')] })))), JSON.stringify({ key: 'agent:x', at: null }), 'an entry without a usable time still counts when it is the only one');
});

test('the start step preselects the saved worker, else the last one used when a thread can run as it, else Claude (default)', () => {
  const page = load();
  const done = (agentType) => run({ agentType, state: 'done' });
  assert.equal(startKeyOf(page, task({ runs: [done('deep-analyst')] })), 'agent:deep-analyst', 'a listed sub-agent');
  assert.equal(startKeyOf(page, task({ history: [hist('lane:code-codex', '2026-10-14T03:00:00.000Z')] })), 'lane:code-codex', 'a listed, approved lane');
  assert.equal(startKeyOf(page, task({ agent: 'worker', runs: [done('deep-analyst')] })), 'agent:worker', 'the saved worker first');
  assert.equal(startKeyOf(page, task({ runs: [done('general-purpose')] })), '', 'a built-in agent is not a file in /agents: Claude (default)');
  assert.equal(startKeyOf(page, task({ runs: [done('Explore')] })), '');
  assert.equal(startKeyOf(page, task({ history: [hist('lane:review-ro', '2026-10-14T03:00:00.000Z')] })), '', 'a lane that is not approved cannot be picked');
  assert.equal(startKeyOf(page, task({ history: [hist('lane:gone', '2026-10-14T03:00:00.000Z')] })), '', 'a lane that is not listed');
  const gp = eff(page, task({ runs: [done('general-purpose')] }));
  assert.deepEqual([gp.text, gp.caption], ['general-purpose · last used', 'Start as thread uses: Claude (default)'], 'it is shown as last used, and the caption says what Start does instead');
  page.setAgents(null);
  assert.equal(startKeyOf(page, task({ runs: [done('deep-analyst')] })), '', 'before the lists have loaded nothing is known to be valid');
});

test('the picker marks the workers working now and the last one used, once each', () => {
  const page = load();
  assert.deepEqual(plain(page.workerMarks(task({ runs: [run(), run({ n: 2, agentType: 'worker', state: 'done', startedAt: '2026-10-14T03:27:00.000Z' })] }))), { 'agent:deep-analyst': 'now', 'agent:worker': 'last' });
  assert.deepEqual(plain(page.workerMarks(task({ runs: [run()] }))), { 'agent:deep-analyst': 'now' }, 'the running one is also the last: one badge');
  assert.deepEqual(plain(page.workerMarks(task({ runs: [run({ state: 'done' })] }))), { 'agent:deep-analyst': 'last' });
  assert.deepEqual(plain(page.workerMarks(task({ runs: [run({ quiet: true })] }))), { 'agent:deep-analyst': 'last' }, 'a quiet run is not working now');
  assert.deepEqual(plain(page.workerMarks(task())), {});
});

test('the button content: the live dot for work now, the ring for a quiet run, muted text for the last one used, set as text', () => {
  const page = load();
  const content = (c) => page.workerFieldContent(page.effectiveWorker(c, NOW));
  const [main, caret] = content(task({ runs: [run()] }));
  assert.equal(main.className, 'wk-main');
  assert.deepEqual(main.children.map((c) => c.className), ['work-compact wk-dot work-live', 'wk-text']);
  assert.equal(main.children[0].children[0].className, 'shape s-pulse');
  assert.equal(main.textContent, 'deep-analyst · working now');
  assert.equal(caret.className, 'wk-caret');
  assert.equal(content(task({ runs: [run({ quiet: true })] }))[0].children[0].children[0].className, 'shape s-dring');
  const last = content(task({ runs: [run({ state: 'done' })] }))[0];
  assert.deepEqual(last.children.map((c) => c.className), ['wk-text wk-muted']);
  assert.deepEqual(content(task({ agent: 'worker' }))[0].children.map((c) => c.className), ['wk-text'], 'the saved worker as before');
  const evil = content(task({ runs: [run({ agentType: '<img src=x onerror=1>', state: 'done' })] }))[0];
  assert.equal(evil.children[0].children.length, 0);
  assert.equal(evil.textContent, '<img src=x onerror=1> · last used');
});

test('the page uses it: the card form shows the effective worker and the caption, the picker gets the badges, the start step preselects and sends what it showed', () => {
  assert.match(html, /const eff = effectiveWorker\(workerCard, Date\.now\(\)\);\n\s+fWorker\.replaceChildren\(\.\.\.workerFieldContent\(eff\)\);/);
  assert.match(html, /if \(WE\.dirty\(\)\) \{\n\s+fWorker\.replaceChildren\(\.\.\.workerButtonContent\(WE\.value\)\);/, 'a worker picked and not saved shows as picked');
  assert.match(html, /marks: \(\) => workerMarks\(workerCard\)/);
  assert.match(html, /const preset = effectiveWorker\(cardNow, NaN\)\.startKey;/);
  assert.match(html, /picked: P\.startWorker !== undefined \? P\.startWorker : preset !== shown \? preset : undefined/, 'a preselected last-used worker is saved like a pick, with expectLane and expectAgent for it');
  assert.match(html, /badge\('Working now'/);
  assert.match(html, /badge\('Last used'/);
  assert.doesNotMatch(html, /innerHTML/);
});
