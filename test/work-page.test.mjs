// "Working now" on the board page: the model that says whether anything runs on a card (a sub-agent run, a thread turn, a lane thread,
// a run that has gone quiet), the element it draws, and where the page uses it. The page's own code runs in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { FakeEl } from './helpers.mjs';
import { RUN_QUIET_MS } from '../server/runs.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = (name) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
const fmtMsSrc = /  function fmtMs\(ms\) \{[\s\S]*?\n  \}\n/.exec(html);
assert.ok(fmtMsSrc, 'fmtMs is missing from the board page');
const model = vm.runInNewContext(`${fmtMsSrc[0]}\n${block('working now')}\n({ workState, workTitle })`, {});   // the block also holds workEl, which is only defined here, not called
const plain = (x) => JSON.parse(JSON.stringify(x));

const NOW = Date.parse('2026-10-14T03:30:00.000Z');
const run = (over = {}) => ({ n: 1, agentId: 'a1', agentType: 'worker', state: 'running', startedAt: '2026-10-14T03:26:00.000Z', ...over });
const task = (runs, over = {}) => ({ id: 'c7', kind: 'task', title: 'T', status: 'in_progress', runs, ...over });
const thread = (runState, over = {}) => ({ id: 'c9', kind: 'thread', title: 'Th', status: 'in_progress', thread: { runState, turns: [{ startedAt: '2026-10-14T03:20:00.000Z' }], ...over } });

test('nothing running on a card gives no state: no runs, only finished or stopped ones, an idle thread, junk', () => {
  for (const c of [task(undefined), task([]), task([run({ state: 'done' }), run({ state: 'stopped' })]), thread('idle'), thread('failed'), thread('ended'), { id: 'c1', kind: 'milestone' }, null, undefined, 7, task([null, 'x', 4])]) {
    assert.equal(model.workState(c), null, JSON.stringify(c));
  }
});

test('one running sub-agent run names its agent type; several say how many', () => {
  const one = plain(model.workState(task([run(), run({ n: 2, state: 'done' })])));
  assert.equal(one.live, true);
  assert.equal(one.quiet, false);
  assert.equal(one.count, 1);
  assert.equal(one.text, 'worker working');
  assert.equal(one.aria, 'working now: worker');
  const three = plain(model.workState(task([run(), run({ n: 2, agentType: 'analyst' }), run({ n: 3, agentType: 'analyst' })])));
  assert.equal(three.text, '3 agents working');
  assert.equal(three.count, 3);
  assert.equal(three.aria, 'working now: 3 agents (worker, analyst)');
  assert.equal(plain(model.workState(task([run({ agentType: '' })]))).text, 'agent working', 'a run without a type');
});

test('a run the server marks quiet is muted, not live; one live run among quiet ones keeps the card live and counts only the live ones', () => {
  const quiet = plain(model.workState(task([run({ quiet: true })])));
  assert.equal(quiet.live, false);
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.text, 'worker quiet');
  assert.doesNotMatch(quiet.aria, /working now/);
  assert.match(quiet.aria, /quiet, may have stopped/);
  assert.equal(plain(model.workState(task([run({ quiet: true }), run({ n: 2, quiet: true })]))).text, '2 agents quiet');
  const mixed = plain(model.workState(task([run({ quiet: true }), run({ n: 2, agentType: 'analyst' })])));
  assert.equal(mixed.live, true);
  assert.equal(mixed.text, 'analyst working');
  assert.equal(mixed.runs.length, 2, 'the tooltip still lists the quiet one');
});

test('a running run of a thread that does the card\'s work reads like a sub-agent\'s: its lane (the agent type the server gives it) working, a quiet one muted', () => {
  const linked = (over = {}) => run({ n: 2, agentId: undefined, thread: 'c9', turn: 1, lane: 'code-codex', agentType: 'code-codex', ...over });
  const w = plain(model.workState(task([linked()])));
  assert.equal(w.live, true);
  assert.equal(w.text, 'code-codex working');
  assert.equal(w.aria, 'working now: code-codex');
  assert.equal(w.runs[0].key, 'lane:code-codex');
  assert.equal(model.workTitle(model.workState(task([linked()])), NOW), 'Working now\ncode-codex: running for 4m 00s');
  assert.equal(plain(model.workState(task([linked({ quiet: true })]))).text, 'code-codex quiet', 'the server marks a stale one quiet');
  assert.equal(plain(model.workState(task([linked(), run({ n: 3 })]))).text, '2 agents working', 'beside a sub-agent run');
  const noLane = plain(model.workState(task([linked({ lane: undefined, agentType: 'thread' })])));
  assert.equal(noLane.text, 'thread working');
  assert.equal(noLane.runs[0].key, '', 'a thread without a lane is not a worker to pick');
  assert.equal(plain(model.workState(task([run()]))).runs[0].key, 'agent:worker');
});

test('a running thread shows as live; a lane thread names its lane; an idle one shows nothing', () => {
  const plainThread = plain(model.workState(thread('running')));
  assert.equal(plainThread.live, true);
  assert.equal(plainThread.text, 'Running');
  assert.equal(plainThread.aria, 'working now: thread turn running');
  assert.equal(plainThread.since, '2026-10-14T03:20:00.000Z', 'the newest turn');
  const lane = plain(model.workState(thread('running', { lane: { name: 'code-codex', implementer: 'codex' } })));
  assert.equal(lane.text, 'Running on code-codex');
  assert.equal(lane.lane, 'code-codex');
  assert.match(lane.aria, /on lane code-codex/);
  assert.equal(model.workState(thread('running', { turns: undefined })).since, '');
});

test('the tooltip says what runs, for how long, and why a quiet run is not live', () => {
  const live = model.workTitle(model.workState(task([run(), run({ n: 2, agentType: 'analyst', startedAt: '2026-10-14T03:18:30.000Z' })])), NOW);
  assert.equal(live, 'Working now\nworker: running for 4m 00s\nanalyst: running for 11m 30s');
  const quiet = model.workTitle(model.workState(task([run({ quiet: true })])), NOW);
  assert.match(quiet, /^Nothing has happened for a while\nworker: no recent activity, it may have stopped for 4m 00s$/);
  assert.equal(model.workTitle(model.workState(thread('running', { lane: { name: 'code-codex' } })), NOW), 'A turn of this thread is running for 10m 00s on the code-codex lane.');
  assert.equal(model.workTitle(model.workState(thread('running')), NOW), 'A turn of this thread is running for 10m 00s.');
  assert.doesNotMatch(model.workTitle(model.workState(task([run({ startedAt: 'junk' })])), NOW), /for NaN/, 'an unreadable time is left out');
});

test('the signature changes when a run starts, stops, goes quiet or another agent joins, and not otherwise', () => {
  const sig = (c) => (model.workState(c) || {}).sig || '';
  const base = task([run()]);
  assert.notEqual(sig(task([])), sig(base), 'a run starts');
  assert.notEqual(sig(base), sig(task([run({ state: 'done' })])), 'it stops');
  assert.notEqual(sig(base), sig(task([run({ quiet: true })])), 'it goes quiet');
  assert.notEqual(sig(base), sig(task([run(), run({ n: 2 })])), 'a second one joins');
  assert.notEqual(sig(thread('idle')), sig(thread('running')), 'a thread turn starts');
  assert.notEqual(sig(thread('running')), sig(thread('running', { turns: [{ startedAt: '2026-10-14T03:29:00.000Z' }] })), 'a new turn');
  assert.equal(sig(base), sig({ ...base, title: 'Renamed', note: 'x' }), 'a change that is not about work leaves it alone');
  assert.equal(sig(thread('idle')), '');
});

test('the indicator is a pill with a pulsing dot when live, a muted pill with a dashed ring when quiet, and a dot with a text for screen readers when compact', () => {
  const doc = { createElement: (tag) => new FakeEl(doc, tag) };
  const env = {
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
    Date: { now: () => NOW, parse: Date.parse },
  };
  const src = `${fmtMsSrc[0]}\n${block('working now')}\n({ workState, workEl })`;
  const page = vm.runInNewContext(src, vm.createContext(env));
  const live = page.workEl(page.workState(task([run()])), false);
  assert.equal(live.className, 'pill work work-live');
  assert.equal(live.dataset.run, 'running');
  assert.ok(live.querySelector('.shape.s-pulse'));
  assert.equal(live.textContent, 'worker working');
  assert.match(live.title, /^Working now\nworker: running for 4m 00s$/);
  live.title = '';
  env.Date.now = () => NOW + 60000;
  live.fire('mouseenter');
  assert.match(live.title, /5m 00s/, 'the elapsed time is renewed when the pointer comes');
  const quiet = page.workEl(page.workState(task([run({ quiet: true })])), false);
  assert.equal(quiet.className, 'pill work work-quiet');
  assert.equal(quiet.dataset.run, undefined);
  assert.ok(quiet.querySelector('.shape.s-dring') && !quiet.querySelector('.s-pulse'));
  const dot = page.workEl(page.workState(task([run()])), 'dot');
  assert.match(dot.className, /work-compact work-live work-dot/);
  assert.equal(dot.querySelector('.sr-only').textContent, 'worker working');
  assert.equal(dot.querySelector('.work-text'), null);
});

test('the board uses it: first in a tile\'s foot, in its aria-label, in the list row, the milestones view and the card page header', () => {
  assert.match(html, /const work = workState\(card\);\n\s+if \(work\) foot\.appendChild\(workEl\(work, false\)\);\n\s+if \(thread\) \{\n\s+if \(!work\) foot\.appendChild\(runPill\(t\.runState\)\);/, 'before everything else in the foot; a thread shows it as its Running pill');
  assert.match(html, /\(work \? ', ' \+ work\.aria : ''\)/, 'in the tile\'s aria-label');
  assert.match(html, /work: workState\(c\),/);
  assert.match(html, /r\.unverified, r\.work \? r\.work\.sig : ''\]/, 'a row is drawn again when work starts or stops');
  assert.match(html, /if \(r\.work\) marks\.appendChild\(workEl\(r\.work, true\)\)/);
  assert.match(html, /stageName\[c\.status\] \|\| c\.status, \(workState\(c\) \|\| \{\}\)\.sig \|\| ''\]/, 'the Milestones view too');
  assert.match(html, /link\.appendChild\(workEl\(work, 'dot'\)\)/);
  assert.match(html, /\.\.\.\(work \? \[workEl\(work, false\)\] : \[\]\), h\('span', 'tnum', n \? n \+/, 'the header of a task card page');
  assert.match(html, /meta\.appendChild\(work \? workEl\(work, false\) : runPill\(t\.runState\)\)/, 'the header of a thread page');
  assert.match(html, /\(workState\(c\) \|\| \{\}\)\.sig\]\),\n\s+about:/, 'and its key');
});

test('the style: a quiet look apart from the live one, and no animation when the user asks for less motion', () => {
  assert.match(html, /\.pill\.work-quiet \{[^}]*--k: var\(--muted\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.s-pulse \{ opacity: 1; \}/, 'the dot stays visible without animation');
});

test('the quiet threshold of the board page is the number the server uses', () => {
  const m = /const RUN_QUIET_MS = (\d+) \* 60 \* 1000;/.exec(html);
  assert.ok(m, 'the card page\'s RUN_QUIET_MS');
  assert.equal(Number(m[1]) * 60 * 1000, RUN_QUIET_MS);
  assert.ok(fs.readFileSync(new URL('../server/runs.mjs', import.meta.url), 'utf8').includes('export const RUN_QUIET_MS = 10 * 60 * 1000;'));
});
