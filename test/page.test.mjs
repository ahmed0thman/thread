import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_DIR } from './helpers.mjs';

const html = fs.readFileSync(path.join(SERVER_DIR, 'board.html'), 'utf8');

test('every inline script in board.html compiles', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'no inline script found');
  blocks.forEach((code, i) => {
    try {
      new vm.Script(code);
    } catch (e) {
      assert.fail(`inline script block ${i} does not compile: ${e.message}`);
    }
  });
});

test('board.html builds the page without innerHTML-style sinks and loads nothing from the network', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!html.includes(sink), `board.html uses ${sink}`);
  }
  assert.doesNotMatch(html, /https?:\/\//);
});

// The pure token and agent helpers sit between two marker comments so they can be run without a DOM.
function pageHelpers() {
  const m = /\/\/ ---- tokens and agents[^\n]*\n([\s\S]*?)\/\/ ---- end tokens and agents ----/.exec(html);
  assert.ok(m, 'the helper block is missing from board.html');
  return vm.runInNewContext(`${m[1]}; ({ fmtTokens, turnTokens, threadTokens, tokensText, totalText, agentLabel, modelText, isBrief })`);
}

test('fmtTokens keeps three significant digits', () => {
  const { fmtTokens } = pageHelpers();
  const cases = [[0, '0'], [945, '945'], [999, '999'], [1000, '1k'], [1234, '1.23k'], [48200, '48.2k'], [99950, '100k'], [120400, '120k'], [999499, '999k'], [999500, '1M'], [1350000, '1.35M'], [12500000, '12.5M'], [250000000, '250M']];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, String(n));
  assert.equal(fmtTokens(undefined), '0');
  assert.equal(fmtTokens(NaN), '0');
});

// objects built inside the vm have another Object prototype
const plain = (x) => JSON.parse(JSON.stringify(x));

test('thread tokens count input, cache reads and cache writes as "in" and add up over the turns that have usage', () => {
  const { turnTokens, threadTokens, tokensText, totalText } = pageHelpers();
  const a = { usage: { input: 100, cacheRead: 40000, cacheWrite: 7000, output: 1100 } };
  const b = { usage: { input: 5, cacheRead: 900, cacheWrite: 0, output: 400 } };
  assert.deepEqual(plain(turnTokens(a)), { in: 47100, out: 1100 });
  assert.equal(turnTokens({}), null);
  assert.equal(turnTokens({ usage: 'x' }), null);
  assert.equal(threadTokens([{}, {}]), null);
  assert.equal(threadTokens([]), null);
  const sum = threadTokens([a, {}, b]);
  assert.deepEqual(plain(sum), { in: 48005, out: 1500 });
  assert.equal(tokensText(sum), '48k in · 1.5k out');
  assert.equal(totalText(turnTokens(a)), '48.2k tokens');
  assert.deepEqual(plain(turnTokens({ usage: { output: 7 } })), { in: 0, out: 7 }, 'missing fields count as zero');
});

test('agent and model labels leave out what is missing and name xhigh "extra-high"', () => {
  const { agentLabel, modelText, isBrief } = pageHelpers();
  assert.equal(agentLabel({ name: 'worker', model: 'claude-sonnet-5-5', effort: 'xhigh' }), 'worker · claude-sonnet-5-5 · extra-high');
  assert.equal(agentLabel({ name: 'critic', model: null, effort: 'high' }), 'critic · high');
  assert.equal(agentLabel({ name: 'plain', model: null, effort: null }), 'plain');
  assert.equal(modelText({ model: 'claude-opus-5-5', effort: 'max' }), 'claude-opus-5-5 · max');
  assert.equal(modelText({ model: null, effort: 'low' }), 'low');
  assert.equal(modelText({ model: null, effort: null }), '');
  assert.equal(modelText({}), '');
  assert.equal(isBrief({ context: 'brief' }), true);
  assert.equal(isBrief({ context: 'full' }), false);
  assert.equal(isBrief({}), false, 'a thread without the field is an old, full one');
});

test('the start step sends context and agent, and asks for the agent list when it opens', () => {
  assert.match(html, /\{ sessionId, mode, context, agent: agent \|\| undefined \}/);
  assert.match(html, /pp\(pk, 'agents'\)/);
  assert.match(html, /'Same as session'/);
  assert.match(html, /Copies the whole session; uses far more tokens\./);
  assert.match(html, /Gets only this card’s title and note\./);
});

// The pure milestone and stage helpers sit between two marker comments too.
function milestoneHelpers() {
  const m = /\/\/ ---- milestones and stages[^\n]*\n([\s\S]*?)\/\/ ---- end milestones and stages ----/.exec(html);
  assert.ok(m, 'the milestone helper block is missing from board.html');
  return vm.runInNewContext(`${m[1]}; ({ NO_MS, isThread, clip, chatStages, matches, childrenOf, progressOf, groupByStage, milestoneReport })`);
}

const STAGES4 = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'check', label: 'Checking' }, { id: 'done', label: 'Done' }];
const card = (id, kind, title, status, extra = {}) => ({ id, kind, title, note: '', status, ...extra });

test('the board takes its columns from the config, not from a fixed list of six', () => {
  assert.doesNotMatch(html, /STATUSES/);
  assert.doesNotMatch(html, /repeat\(6,/);
  assert.match(html, /repeat\(var\(--cols, 6\),/g);
  assert.match(html, /setProperty\('--cols', String\(stages\.length\)\)/);
  assert.match(html, /current\.config/);
});

test('chat-only shows the columns of the thread roles, in stage order', () => {
  const { chatStages } = milestoneHelpers();
  const ids = (x) => plain(x).map((s) => s.id);
  const roles = { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' };
  assert.deepEqual(ids(chatStages({ stages: STAGES4, roles })), ['doing', 'check', 'done']);
  const six = [{ id: 'idea', label: 'Idea' }, { id: 'new', label: 'New' }, { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' }];
  assert.deepEqual(ids(chatStages({ stages: six, roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' } })), ['in_progress', 'review', 'blocked', 'done']);
});

test('the milestone filter shows the milestone and its cards, or the cards of no milestone, and joins the other filters', () => {
  const { matches, NO_MS } = milestoneHelpers();
  const m = card('c1', 'milestone', 'Launch', 'doing');
  const inside = card('c2', 'task', 'Fix links', 'todo', { parent: 'c1' });
  const outside = card('c3', 'task', 'Proofread', 'todo');
  const other = card('c4', 'task', 'Else', 'todo', { parent: 'c9' });
  const thr = card('c5', 'thread', 'Look into it', 'doing', { parent: 'c1', thread: { parentSessionId: 's1' } });
  const f = (o) => ({ q: '', threadsOnly: false, session: '', milestone: '', ...o });
  assert.deepEqual([m, inside, outside, other, thr].filter((c) => matches(c, f({ milestone: 'c1' }))).map((c) => c.id), ['c1', 'c2', 'c5']);
  assert.deepEqual([m, inside, outside, other, thr].filter((c) => matches(c, f({ milestone: NO_MS }))).map((c) => c.id), ['c3'], 'a milestone is not "no milestone"');
  assert.equal([m, inside, outside, other, thr].filter((c) => matches(c, f({}))).length, 5);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', threadsOnly: true }))).map((c) => c.id), ['c5']);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', q: 'links' }))).map((c) => c.id), ['c2']);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', session: 's1' }))).map((c) => c.id), ['c5']);
});

test('milestone progress counts the cards in the done stage; the report groups them by stage', () => {
  const { progressOf, groupByStage, milestoneReport, clip } = milestoneHelpers();
  const m = card('c1', 'milestone', 'Docs v2', 'doing');
  const cards = [
    m,
    card('c2', 'task', 'Fix links', 'todo', { parent: 'c1' }),
    card('c3', 'task', 'Search box', 'doing', { parent: 'c1' }),
    card('c4', 'thread', 'Look into the build', 'check', { parent: 'c1', thread: { runState: 'idle' } }),
    card('c5', 'task', 'Changelog', 'done', { parent: 'c1' }),
    card('c6', 'idea', 'Not in it', 'done'),
  ];
  assert.deepEqual(plain(progressOf(cards, 'c1', 'done')), { done: 1, total: 4 });
  assert.deepEqual(plain(progressOf(cards, 'c6', 'done')), { done: 0, total: 0 });
  assert.deepEqual(groupByStage(cards.filter((c) => c.parent === 'c1'), STAGES4).map((g) => [g.stage.id, g.cards.length]), [['todo', 1], ['doing', 1], ['check', 1], ['done', 1]]);
  assert.equal(milestoneReport(m, cards, STAGES4, 'done'), [
    'Milestone c1 "Docs v2": 1 of 4 done.',
    'To do (1)', '- c2 [task] Fix links',
    'Doing (1)', '- c3 [task] Search box',
    'Checking (1)', '- c4 [thread:idle] Look into the build',
    'Done (1)', '- c5 [task] Changelog',
  ].join('\n'));
  assert.equal(milestoneReport(card('c9', 'milestone', 'Empty', 'todo'), [], STAGES4, 'done'), 'Milestone c9 "Empty": 0 of 0 done.\nNo cards in this milestone yet.');
  assert.equal(clip('  a   long\ntitle ', 100), 'a long title');
  assert.equal(clip('x'.repeat(40), 30), 'x'.repeat(29) + '…');
});

test('a milestone page links to its cards, copies a report and offers no thread start', () => {
  assert.match(html, /Cards in this milestone/);
  assert.match(html, /'Copy report'/);
  assert.match(html, /\['task', 'idea', 'milestone'\]/);
  assert.match(html, /a\[href\]/, 'the focus trap reaches the card links');
  assert.match(html, /if \(!isMs\) \{[^}]*Start as thread/s);
});

test('the new-card form and thread pages send parent, and a cleared one is sent as an empty string', () => {
  assert.match(html, /bodyObj\.parent = fMs\.value/);
  assert.match(html, /patch\.parent = fMs\.value/);
  assert.match(html, /\{ parent: sel\.value \}/);
});
