// The board page's Summary view: the numbers it works out from the cards the page already has, and the page code that draws them.
// The page's own code runs in a vm. Dates are local (a week runs Monday 00:00 to Monday 00:00 in the machine's time zone), so every
// time here is built with the local Date constructor and the tests give the same answers in any zone.
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
const plain = (x) => JSON.parse(JSON.stringify(x));

const S = vm.runInNewContext(
  `${block('tokens and agents')}\n${block('milestones and stages')}\n${block('summary')}\n({ summaryModel, weekEdges, weekOf, completedAt, stageTimes, median, chartScale, spanText, derivedWorker })`,
  {},
);

const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const iso = (date) => date.toISOString();
const NOW = local(2026, 10, 14, 12).getTime();           // a Wednesday; its week started on Monday 12 October
const HOUR = 3600000, DAY = 24 * HOUR;
const ago = (ms) => iso(new Date(NOW - ms));

const DEFAULT = {
  stages: ['idea', 'new', 'in_progress', 'review', 'blocked', 'done'].map((id) => ({ id, label: id })),
  roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' },
};
const CUSTOM = {
  stages: [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'qa', label: 'QA' }, { id: 'shipped', label: 'Shipped' }],
  roles: { start: 'todo', working: 'doing', review: 'qa', blocked: 'todo', done: 'shipped' },
};
let n = 0;
const card = (over = {}) => ({ id: 'c' + (++n), kind: 'task', title: 't', status: 'new', createdAt: ago(30 * DAY), updatedAt: ago(30 * DAY), ...over });
const model = (cards, config = DEFAULT, now = NOW) => plain(S.summaryModel(cards, config, now));

// ---------------------------------------------------------------- the tiles

test('the tiles count open, working, lately done, open bugs and waiting by the project\'s own stages', () => {
  const wait = (id, state = 'open') => ({ id, kind: 'question', text: 'q', state, askedAt: ago(DAY) });
  const cards = [
    card({ status: 'todo' }),
    card({ status: 'doing', type: 'bug', waits: [wait('x.w1'), wait('x.w2', 'answered')] }),
    card({ status: 'doing' }),
    card({ status: 'qa', type: 'bug' }),
    card({ status: 'shipped', type: 'bug', updatedAt: ago(2 * DAY) }),     // a done bug is not an open bug
    card({ status: 'shipped', updatedAt: ago(7 * DAY + HOUR) }),            // done, but not lately
    card({ status: 'shipped', updatedAt: ago(7 * DAY) }),                   // exactly 7 days ago still counts
    { id: 'c90', kind: 'milestone', title: 'M', status: 'todo', createdAt: ago(DAY), updatedAt: ago(DAY), waits: [wait('c90.w1')] },
    card({ kind: 'idea', status: 'todo', waits: [wait('y.w1')] }),
  ];
  const t = model(cards, CUSTOM).tiles;
  assert.deepEqual(t, { open: 5, working: 2, workingLabel: 'Doing', doneRecent: 2, bugs: 2, waiting: 2 });
  assert.equal(model(cards, CUSTOM).cards, 8, 'cards are the ones that are not milestones');
});

test('the default stages work the same way, and a project with no working stage still has a label', () => {
  const cards = [card({ status: 'in_progress' }), card({ status: 'done', updatedAt: ago(HOUR) }), card({ status: 'idea' })];
  assert.deepEqual(model(cards).tiles, { open: 2, working: 1, workingLabel: 'in_progress', doneRecent: 1, bugs: 0, waiting: 0 });
  const odd = { stages: DEFAULT.stages, roles: { ...DEFAULT.roles, working: 'gone' } };
  assert.equal(model(cards, odd).tiles.workingLabel, 'In progress');
});

// ---------------------------------------------------------------- weeks

test('the weeks are eight Mondays at 00:00 local, the current week last, and the last edge is the next Monday', () => {
  const edges = plain(S.weekEdges(NOW, 8));
  assert.equal(edges.length, 9);
  edges.forEach((e) => { const d = new Date(e); assert.deepEqual([d.getDay(), d.getHours(), d.getMinutes()], [1, 0, 0]); });
  assert.equal(edges[7], local(2026, 10, 12).getTime());
  assert.equal(edges[8], local(2026, 10, 19).getTime());
  assert.equal(edges[0], local(2026, 8, 24).getTime());
});

test('a Sunday belongs to the week that started the Monday before, and Monday at 00:00 starts a new one', () => {
  const sunday = local(2026, 10, 18, 23, 59).getTime();
  assert.equal(S.weekEdges(sunday, 8)[7], local(2026, 10, 12).getTime());
  const monday = local(2026, 10, 19).getTime();
  assert.equal(S.weekEdges(monday, 8)[7], monday);
  assert.equal(S.weekEdges(local(2026, 10, 19, 0, 0, 0, 1).getTime(), 8)[7], monday);
});

test('a card is counted in the week its time falls in, at the edges too', () => {
  const edges = S.weekEdges(NOW, 8);
  const w = (d) => S.weekOf(d.getTime(), edges);
  assert.equal(w(local(2026, 10, 12)), 7, 'Monday 00:00 starts the current week');
  assert.equal(w(local(2026, 10, 11, 23, 59, 59, 999)), 6, 'the last millisecond of the week before');
  assert.equal(w(local(2026, 10, 18, 23, 59, 59, 999)), 7, 'the last millisecond of this week');
  assert.equal(w(local(2026, 10, 19)), -1, 'next week is not shown');
  assert.equal(w(local(2026, 8, 24)), 0, 'the first week starts at its Monday');
  assert.equal(w(local(2026, 8, 23, 23, 59, 59, 999)), -1, 'older than the first week');
  assert.equal(S.weekOf(null, edges), -1);
});

test('created and done are counted per week, milestones are not counted, and the chart scale fits the largest bar', () => {
  const cards = [
    card({ createdAt: iso(local(2026, 10, 12)), status: 'new' }),
    card({ createdAt: iso(local(2026, 10, 11, 23, 59)), status: 'new' }),
    card({ createdAt: iso(local(2026, 10, 13)), status: 'done', updatedAt: iso(local(2026, 10, 14)) }),
    card({ createdAt: iso(local(2026, 8, 25)), status: 'done', updatedAt: iso(local(2026, 8, 30)) }),
    card({ createdAt: iso(local(2026, 1, 1)), status: 'new' }),                              // older than eight weeks
    { id: 'c80', kind: 'milestone', title: 'M', status: 'new', createdAt: iso(local(2026, 10, 13)), updatedAt: iso(local(2026, 10, 13)) },
  ];
  const m = model(cards);
  assert.equal(m.weeks.length, 8);
  assert.deepEqual(m.weeks.map((x) => [x.created, x.done]), [[1, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [2, 1]]);
  assert.equal(m.weeks[7].start, local(2026, 10, 12).getTime());
  assert.deepEqual(m.scale, { top: 4, ticks: [0, 1, 2, 3, 4] });
});

test('a card in a stage after the done stage is finished: Open leaves it out, and the date it counts for is when it was completed, not when it moved on', () => {
  const RELEASED = { stages: [...DEFAULT.stages, { id: 'released', label: 'Released' }], roles: DEFAULT.roles };
  const mv = (at, from, to) => ({ at: ago(at), by: 'claude', type: 'moved', from, to });
  const completedLately = card({ status: 'released', updatedAt: ago(HOUR), history: [{ at: ago(30 * DAY), type: 'created', to: 'new' }, mv(2 * DAY, 'new', 'done'), mv(HOUR, 'done', 'released')] });
  const completedLongAgo = card({ status: 'released', updatedAt: ago(DAY), history: [{ at: ago(40 * DAY), type: 'created', to: 'new' }, mv(20 * DAY, 'new', 'done'), mv(DAY, 'done', 'released')] });
  const cards = [
    completedLately, completedLongAgo,
    card({ status: 'done', updatedAt: ago(9 * DAY), history: [{ at: ago(30 * DAY), type: 'created', to: 'new' }, mv(9 * DAY, 'review', 'done')] }),
    card({ status: 'review' }),
    card({ kind: 'idea', type: 'bug', status: 'idea' }),                 // an unfinished bug idea is an open bug
    card({ kind: 'idea', type: 'bug', status: 'released', updatedAt: ago(DAY) }),   // a finished one is not
  ];
  const m = model(cards, RELEASED);
  assert.equal(m.tiles.open, 2, 'the review card and the idea');
  assert.equal(m.tiles.doneRecent, 2, 'the card completed two days ago, and the bug idea released yesterday (no history: last updated)');
  assert.equal(m.tiles.bugs, 1);
  const inWeek = (ms) => m.weeks.findIndex((w) => ms >= w.start && ms < w.start + 7 * DAY);
  assert.equal(m.weeks.reduce((n, w) => n + w.done, 0), 4, 'four finished cards, each in one week');
  // the week of completion, not the week it was released
  const twenty = inWeek(NOW - 20 * DAY);
  assert.ok(twenty >= 0 && m.weeks[twenty].done >= 1, 'the card completed 20 days ago is in that week');
});

test('the time in stages leaves out every finished stage', () => {
  const RELEASED = { stages: [...DEFAULT.stages, { id: 'released', label: 'Released' }], roles: DEFAULT.roles };
  const mv = (at, from, to) => ({ at: ago(at), by: 'claude', type: 'moved', from, to });
  const c = card({ status: 'released', history: [{ at: ago(10 * DAY), type: 'created', to: 'new' }, mv(8 * DAY, 'new', 'done'), mv(4 * DAY, 'done', 'released')] });
  assert.deepEqual(model([c], RELEASED).stages.map((x) => x.id), ['new'], 'Done and Released are where a card ends up');
});

test('chartScale: whole-number gridlines, four steps, at least four', () => {
  assert.deepEqual(plain(S.chartScale(0)), { top: 4, ticks: [0, 1, 2, 3, 4] });
  assert.deepEqual(plain(S.chartScale(4)), { top: 4, ticks: [0, 1, 2, 3, 4] });
  assert.deepEqual(plain(S.chartScale(5)), { top: 8, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(plain(S.chartScale(13)), { top: 16, ticks: [0, 4, 8, 12, 16] });
});

// ---------------------------------------------------------------- when a card was completed

test('a card was completed at its last move into the finished stages from an unfinished one, not at an earlier one or one into another stage', () => {
  const mv = (at, from, to) => ({ at: iso(at), by: 'claude', type: 'moved', from, to });
  const c = card({ status: 'done', updatedAt: iso(local(2026, 10, 14)), history: [
    { at: iso(local(2026, 9, 1)), by: 'user', type: 'created', to: 'new' },
    mv(local(2026, 9, 2), 'new', 'done'),
    mv(local(2026, 9, 3), 'done', 'in_progress'),
    mv(local(2026, 9, 5), 'in_progress', 'done'),
    mv(local(2026, 9, 9), 'done', 'review'),
    mv(local(2026, 9, 7), 'new', 'blocked'),
  ] });
  assert.equal(S.completedAt(c, DEFAULT), local(2026, 9, 5).getTime());
  // with the blocked stage as the done role, blocked and done are both finished: the later move in is the 7th
  const shifted = { ...DEFAULT, roles: { ...DEFAULT.roles, done: 'blocked' } };
  assert.equal(S.completedAt(c, shifted), local(2026, 9, 7).getTime());
});

test('a move from Done to Released is no completion, and finishing again after a reopening gives a new date', () => {
  const RELEASED = { stages: [...DEFAULT.stages, { id: 'released', label: 'Released' }], roles: DEFAULT.roles };
  const mv = (at, from, to) => ({ at: iso(at), by: 'claude', type: 'moved', from, to });
  const c = card({ status: 'released', updatedAt: iso(local(2026, 10, 14)), history: [
    { at: iso(local(2026, 9, 1)), by: 'user', type: 'created', to: 'new' },
    mv(local(2026, 9, 2), 'new', 'done'),
    mv(local(2026, 9, 12), 'done', 'released'),
  ] });
  assert.equal(S.completedAt(c, RELEASED), local(2026, 9, 2).getTime(), 'released later, completed when it was done');
  c.history.push(mv(local(2026, 9, 20), 'released', 'review'), mv(local(2026, 9, 25), 'review', 'released'));
  assert.equal(S.completedAt(c, RELEASED), local(2026, 9, 25).getTime(), 'reopened and finished again: a new date');
  // a card created straight in a finished stage was completed then
  assert.equal(S.completedAt(card({ status: 'released', updatedAt: iso(local(2026, 10, 14)), history: [{ at: iso(local(2026, 9, 1)), type: 'created', to: 'released' }] }), RELEASED), local(2026, 9, 1).getTime());
});

test('with no move into the finished stages a card was completed when it was last updated; a thread, when its last turn ended', () => {
  const updated = local(2026, 10, 3, 9).getTime();
  assert.equal(S.completedAt(card({ updatedAt: iso(new Date(updated)) }), DEFAULT), updated);
  assert.equal(S.completedAt(card({ updatedAt: iso(new Date(updated)), history: [{ at: iso(local(2026, 9, 1)), type: 'created', to: 'new' }] }), DEFAULT), updated);
  const thread = card({ kind: 'thread', updatedAt: iso(new Date(updated)), thread: { runState: 'ended', turns: [
    { startedAt: 'a', finishedAt: iso(local(2026, 10, 1)) }, { startedAt: 'b', finishedAt: iso(local(2026, 10, 2)) },
  ] } });
  assert.equal(S.completedAt(thread, DEFAULT), local(2026, 10, 2).getTime());
  thread.thread.turns[1].finishedAt = null;
  assert.equal(S.completedAt(thread, DEFAULT), local(2026, 10, 1).getTime(), 'a turn still open is passed over');
  assert.equal(S.completedAt(card({ updatedAt: 'not a date' }), DEFAULT), null);
  assert.equal(S.completedAt(card({ updatedAt: undefined }), DEFAULT), null);
});

test('a done card with no usable time is counted nowhere in the weeks and not among the lately done', () => {
  const m = model([card({ status: 'done', updatedAt: 'nonsense' })]);
  assert.equal(m.tiles.doneRecent, 0);
  assert.equal(m.weeks.reduce((s, w) => s + w.done, 0), 0);
});

// ---------------------------------------------------------------- work by worker

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test('work by worker: done cards from workedBy, tokens from sub-agent runs and thread turns', () => {
  const cards = [
    card({ status: 'done', workedBy: ['main', 'agent:worker'], runs: [{ agentType: 'worker', usage: usage(1000, 500) }, { agentType: 'worker', usage: usage(200, 100, 3000, 100) }, { agentType: 'critic' }] }),
    card({ status: 'done', workedBy: ['agent:worker'] }),
    card({ status: 'new', workedBy: ['main'], runs: [{ agentType: 'analyst', usage: usage(10, 5) }] }),               // not done: tokens only
    card({ kind: 'thread', status: 'done', workedBy: ['agent:reviewer'], thread: { agent: 'reviewer', runState: 'ended', turns: [{ usage: usage(100, 50) }, { usage: usage(100, 50) }, {}] } }),
    card({ kind: 'thread', status: 'review', thread: { agent: null, lane: { name: 'code-codex' }, runState: 'idle', turns: [{ usage: usage(7, 3) }] } }),
    card({ kind: 'thread', status: 'review', thread: { agent: null, lane: null, runState: 'idle', turns: [{ usage: usage(1, 1) }] } }),
  ];
  const m = model(cards);
  assert.deepEqual(m.workers, [
    { name: 'agent:worker', done: 2, tokens: 1500 + 3400 },
    { name: 'agent:reviewer', done: 1, tokens: 300 },
    { name: 'main', done: 1, tokens: 0 },
    { name: 'agent:analyst', done: 0, tokens: 15 },
    { name: 'lane:code-codex', done: 0, tokens: 10 },
    { name: 'thread', done: 0, tokens: 2 },
  ]);
  assert.equal(m.workersMaxDone, 2);
  assert.equal(m.workersMaxTokens, 4900);
  assert.equal(m.workersMore, 0);
});

test('worker names from runs and threads follow workedBy: a cut name loses its dots and is cut to 64 characters', () => {
  assert.equal(S.derivedWorker('agent:', 'code-reviewer…'), 'agent:code-reviewer');
  assert.equal(S.derivedWorker('agent:', 'x'.repeat(100)), 'agent:' + 'x'.repeat(58));
  assert.equal(S.derivedWorker('lane:', 'y'.repeat(100)).length, 64);
});

test('work by worker shows the busiest eight and says how many more there are', () => {
  const cards = Array.from({ length: 11 }, (_, i) => card({ status: 'done', workedBy: ['agent:a' + String(i).padStart(2, '0')], runs: [{ agentType: 'a' + String(i).padStart(2, '0'), usage: usage(i, 0) }] }));
  const m = model(cards);
  assert.equal(m.workers.length, 8);
  assert.equal(m.workersMore, 3);
  assert.deepEqual(m.workers.map((w) => w.name).slice(0, 3), ['agent:a10', 'agent:a09', 'agent:a08'], 'equal done cards: more tokens first');
});

// ---------------------------------------------------------------- waiting for you

test('the open waiting items are listed oldest first, the ones with no time last, and only those that are open and not on a milestone', () => {
  const w = (id, kind, askedAt, state = 'open') => ({ id, kind, text: id + ' ' + 'long '.repeat(80), state, askedAt });
  const cards = [
    card({ id: 'c1', waits: [w('c1.w1', 'todo', ago(DAY)), w('c1.w2', 'question', ago(5 * DAY)), w('c1.w3', 'choice', ago(9 * DAY), 'answered')] }),
    card({ id: 'c2', waits: [w('c2.w1', 'review', ago(3 * DAY)), w('c2.w2', 'question', undefined), { id: 'c2.w3', kind: 'newer-kind', text: 'x', state: 'open' }] }),
    { id: 'c3', kind: 'milestone', title: 'M', status: 'new', waits: [w('c3.w1', 'question', ago(10 * DAY))] },
  ];
  const m = model(cards);
  assert.deepEqual(m.waits.map((x) => x.id), ['c1.w2', 'c2.w1', 'c1.w1', 'c2.w2']);
  assert.deepEqual(m.waits.map((x) => x.card), ['c1', 'c2', 'c1', 'c2']);
  assert.equal(m.waits[0].kind, 'question');
  assert.ok(m.waits[0].text.length <= 160 && m.waits[0].text.endsWith('…'));
  assert.equal(m.waits[3].askedAt, '');
  assert.equal(m.tiles.waiting, 4);
});

test('only the oldest eight items are listed, and the rest are counted', () => {
  const waits = Array.from({ length: 11 }, (_, i) => ({ id: 'c1.w' + (i + 1), kind: 'todo', text: 't', state: 'open', askedAt: ago((20 - i) * HOUR) }));
  const m = model([card({ id: 'c1', waits })]);
  assert.equal(m.waits.length, 8);
  assert.equal(m.waitsMore, 3);
  assert.equal(m.waits[0].id, 'c1.w1');
  assert.equal(m.tiles.waiting, 11);
});

// ---------------------------------------------------------------- time in a stage

test('the median time in a stage comes from the created entry and the moves after it, for stages the card left', () => {
  const h = (type, at, from, to) => ({ at: iso(at), by: 'claude', type, from, to });
  const cardWith = (stays) => {
    // stays: [[stage, hours], ...] starting at `new`; the last stage is where the card is now
    const history = [{ at: iso(local(2026, 9, 1)), by: 'user', type: 'created', to: stays[0][0] }];
    let t = local(2026, 9, 1).getTime();
    stays.slice(1).forEach(([stage], i) => { t += stays[i][1] * HOUR; history.push(h('moved', new Date(t), stays[i][0], stage)); });
    return card({ status: stays[stays.length - 1][0], history });
  };
  const cards = [
    cardWith([['new', 2], ['in_progress', 5], ['review', 1], ['done', 0]]),
    cardWith([['new', 4], ['in_progress', 11], ['done', 0]]),
    cardWith([['new', 6], ['in_progress', 1], ['done', 0]]),       // still in progress counted as left; done is not shown
    cardWith([['new', 100], ['in_progress', 1]]),                   // the stage it is in now has no end yet
  ];
  const m = model(cards);
  assert.deepEqual(m.stages.map((s) => [s.id, s.n, s.median / HOUR]), [['new', 4, 5], ['in_progress', 3, 5], ['review', 1, 1]]);
  assert.ok(!m.stages.some((s) => s.id === 'done'), 'the done stage has no time');
});

test('the median of an even count is the middle pair\'s mean, and an interval with no known start is left out', () => {
  assert.equal(S.median([5, 1, 3]), 3);
  assert.equal(S.median([4, 1, 2, 9]), 3);
  assert.equal(S.median([7]), 7);
  assert.equal(S.median([]), null);
  // the history was cut: the first entry is a move out of `in_progress`, so how long it stayed is unknown
  const times = S.stageTimes({ history: [
    { at: iso(local(2026, 9, 2)), type: 'moved', from: 'in_progress', to: 'review' },
    { at: iso(local(2026, 9, 2, 5)), type: 'moved', from: 'review', to: 'done' },
  ] });
  assert.deepEqual(plain(times), [['review', 5 * HOUR]]);
  // a move that goes back in time or has no time is not a duration
  assert.deepEqual(plain(S.stageTimes({ history: [
    { at: iso(local(2026, 9, 5)), type: 'created', to: 'new' },
    { at: iso(local(2026, 9, 4)), type: 'moved', from: 'new', to: 'review' },
    { at: 'x', type: 'moved', from: 'review', to: 'done' },
  ] })), []);
});

test('stages come in the project\'s order and with its labels', () => {
  const base = local(2026, 9, 1).getTime();
  const t = (days, from, to) => ({ at: iso(new Date(base + days * DAY)), type: 'moved', from, to });
  const c = card({ status: 'qa', history: [{ at: iso(new Date(base)), type: 'created', to: 'todo' }, t(1, 'todo', 'doing'), t(3, 'doing', 'qa')] });
  const m = model([c], CUSTOM);
  assert.deepEqual(m.stages.map((s) => [s.id, s.label, s.median]), [['todo', 'To do', DAY], ['doing', 'Doing', 2 * DAY]]);
});

test('spanText: one unit, minutes up to an hour, hours up to two days, then days', () => {
  assert.equal(S.spanText(20000), 'under 1 min');
  assert.equal(S.spanText(12 * 60000), '12 min');
  assert.equal(S.spanText(90 * 60000), '1.5 h');
  assert.equal(S.spanText(5 * HOUR), '5 h');
  assert.equal(S.spanText(30 * HOUR), '30 h');
  assert.equal(S.spanText(3 * DAY), '3 d');
  assert.equal(S.spanText(36 * DAY), '36 d');
});

// ---------------------------------------------------------------- milestones, old cards, empty

test('each milestone has its own state and progress, counted by the done stage and later ones without ideas, and only six are listed', () => {
  const ms = Array.from({ length: 8 }, (_, i) => ({ id: 'c' + (100 + i), kind: 'milestone', title: 'Milestone ' + i, status: 'new' }));
  const cards = [...ms, card({ parent: 'c100', status: 'shipped' }), card({ parent: 'c100', status: 'doing' }), card({ parent: 'c101', status: 'todo' }),
    card({ parent: 'c102', kind: 'idea', status: 'todo' }), card({ parent: 'c103', status: 'shipped' })];
  const m = model(cards, CUSTOM);
  assert.equal(m.milestones.length, 6);
  assert.equal(m.milestonesMore, 2);
  // in the Milestones view's order (open, empty, done), cut after six: the done one is the first to go
  assert.deepEqual(m.milestones.map((x) => x.id), ['c100', 'c101', 'c102', 'c104', 'c105', 'c106']);
  assert.deepEqual(m.milestones[0], { id: 'c100', title: 'Milestone 0', state: 'open', done: 1, total: 2 });
  assert.deepEqual(m.milestones[2], { id: 'c102', title: 'Milestone 2', state: 'empty', done: 0, total: 0 }, 'an idea does not count');
  const done = model([ms[3], card({ parent: 'c103', status: 'shipped' })], CUSTOM).milestones[0];
  assert.deepEqual(done, { id: 'c103', title: 'Milestone 3', state: 'done', done: 1, total: 1 });
  // a stage after the done stage counts as done
  const later = { ...CUSTOM, stages: [...CUSTOM.stages, { id: 'live', label: 'Live' }] };
  assert.equal(model([ms[0], card({ parent: 'c100', status: 'live' })], later).milestones[0].state, 'done');
});

test('the milestones panel lists open milestones first, then empty ones, then done ones, before it keeps six', () => {
  const ms = Array.from({ length: 8 }, (_, i) => ({ id: 'c' + (200 + i), kind: 'milestone', title: 'M' + i, status: 'new' }));
  const kid = (i, status) => card({ parent: 'c' + (200 + i), status });
  // c200, c203 and c206 are done, c204 and c207 open, the rest empty
  const cards = [...ms, kid(0, 'shipped'), kid(3, 'shipped'), kid(4, 'doing'), kid(6, 'shipped'), kid(7, 'todo')];
  const m = model(cards, CUSTOM);
  assert.deepEqual(m.milestones.map((x) => [x.id, x.state]), [['c204', 'open'], ['c207', 'open'], ['c201', 'empty'], ['c202', 'empty'], ['c205', 'empty'], ['c200', 'done']]);
  assert.equal(m.milestonesMore, 2, 'the two done ones that did not fit');
});

test('old cards with no history, no workedBy, no runs, no waits and no times do not break the numbers', () => {
  const old = [
    { id: 'c1', kind: 'task', title: 'old', status: 'new' },
    { id: 'c2', kind: 'task', title: 'old', status: 'done' },
    { id: 'c3', kind: 'idea', title: 'old', status: 'idea', history: 'x', runs: 'y', waits: null, workedBy: 'z' },
    { id: 'c4', kind: 'thread', title: 'old', status: 'in_progress', thread: {} },
    { id: 'c5', kind: 'thread', title: 'old', status: 'done', thread: { turns: [null, { usage: 'many' }] } },
    null,
  ];
  const m = model(old);
  assert.equal(m.empty, false);
  assert.equal(m.cards, 5);
  assert.deepEqual(m.tiles, { open: 3, working: 1, workingLabel: 'in_progress', doneRecent: 0, bugs: 0, waiting: 0 });
  assert.deepEqual([m.workers, m.waits, m.stages, m.milestones], [[], [], [], []]);
  assert.equal(m.weeks.length, 8);
});

test('a project with no cards is empty, and so is one whose cards are not an array', () => {
  const m = model([]);
  assert.equal(m.empty, true);
  assert.equal(m.cards, 0);
  assert.deepEqual(m.tiles, { open: 0, working: 0, workingLabel: 'in_progress', doneRecent: 0, bugs: 0, waiting: 0 });
  assert.equal(model(undefined).empty, true);
  assert.equal(model([{ id: 'c1', kind: 'milestone', title: 'M', status: 'new' }]).empty, false, 'a milestone is something to show');
});

// ---------------------------------------------------------------- the page code that draws them

function summaryPage(cards, config = DEFAULT, over = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.createElementNS = (ns, tag) => {
    const e = new FakeEl(doc, tag);
    e.ns = ns;
    const set = e.setAttribute.bind(e);
    e.setAttribute = (k, v) => { set(k, v); if (k === 'class') e.className = String(v); };
    return e;
  };
  doc.body = new FakeEl(doc, 'body');
  const pane = new FakeEl(doc, 'main');
  doc.body.append(pane);
  const env = {
    document: doc, elPane: pane, selKey: 'k1', current: { cards }, setTimeout: () => 0, waitsFor: '', opened: [],
    openCard: (id, el) => env.opened.push([id, el]),
    cfg: () => config,
    plainMd: (s) => s,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    hashFor: (k, t) => '#/' + k + (t ? '/' + t : ''),
    timeEl: (at) => { const t = doc.createElement('time'); t.textContent = 'rel ' + at; return t; },
    waitKindMark: (kind) => { const m = doc.createElement('span'); m.className = 'pill'; m.dataset.wk = kind; m.textContent = kind; return m; },
    progressEl: (p) => { const e = doc.createElement('div'); e.className = 'ms-prog'; e.textContent = p.done + '/' + p.total; return e; },
    msStateTag: (state) => { const e = doc.createElement('span'); e.className = 'tag ms-st'; e.textContent = state; return e; },
    ...over,
  };
  const src = `${block('card link')}\n${block('tokens and agents')}\n${block('milestones and stages')}\n${block('summary')}\n${block('summary page')}\nDate.now = () => ${NOW};\n({ renderSummary })`;
  const ctx = vm.createContext(env);
  const page = vm.runInContext(src, ctx);
  return { page, pane, env, ctx, doc };
}

const demoCards = () => [
  card({ id: 'c1', title: '<img src=x onerror=alert(1)>', status: 'doing', type: 'bug', createdAt: ago(2 * DAY), workedBy: ['agent:worker'], runs: [{ agentType: 'worker', usage: usage(4000, 1000) }],
    waits: [{ id: 'c1.w1', kind: 'review', text: '<b>Please</b> check the bug fix', state: 'open', askedAt: ago(3 * HOUR) }] }),
  card({ id: 'c2', status: 'shipped', createdAt: ago(10 * DAY), updatedAt: ago(DAY), workedBy: ['agent:worker', 'main'] }),
  { id: 'c3', kind: 'milestone', title: 'Launch <script>', status: 'todo', createdAt: ago(20 * DAY), updatedAt: ago(DAY) },
  card({ id: 'c4', status: 'todo', parent: 'c3', createdAt: ago(DAY) }),
];

test('the Summary draws the tiles, with a link only on the waiting one, and the panels', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const tiles = t.pane.querySelectorAll('.sum-tile');
  assert.deepEqual(tiles.map((x) => x.querySelector('.sum-tile-label').textContent), ['Open', 'Doing', 'Done, last 7 days', 'Open bugs', 'Waiting for you']);
  assert.deepEqual(tiles.map((x) => x.querySelector('.sum-tile-n').textContent), ['2', '1', '1', '1', '1']);
  assert.deepEqual(tiles.map((x) => x.tagName), ['DIV', 'DIV', 'DIV', 'DIV', 'A']);
  assert.equal(tiles[4].href, '#/k1/waiting');
  for (const cls of ['sum-flow', 'sum-who', 'sum-wait', 'sum-ms', 'sum-stage', 'sum-about']) assert.equal(t.pane.querySelectorAll('.' + cls).length, 1, cls);
  assert.match(t.pane.textContent, /About these numbers/);
  assert.match(t.pane.textContent, /last 50 entries/);
});

test('a waiting tile with nothing waiting is not a link, and a bug tile is marked only while a bug is open', () => {
  const t = summaryPage([card({ status: 'shipped', type: 'bug', updatedAt: ago(DAY) })], CUSTOM);
  t.page.renderSummary();
  const tiles = t.pane.querySelectorAll('.sum-tile');
  assert.equal(tiles[4].tagName, 'DIV');
  assert.doesNotMatch(tiles[3].className, /hot/);
  assert.doesNotMatch(tiles[4].className, /hot/);
  assert.match(t.pane.textContent, /Nothing is waiting for you\./);
});

test('the chart is an SVG with a bar for each non-zero count, numbers on them, axis labels as text and a legend', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const svg = t.pane.querySelector('svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 400 210');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label'), /3 created, 1 done/);
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.querySelectorAll('rect.bar-created').length, 2, 'two weeks have created cards');
  assert.equal(svg.querySelectorAll('rect.bar-done').length, 1);
  assert.equal(svg.querySelectorAll('text.tick').length, 5 + 8, 'five values on the side, a date under each week');
  assert.equal(svg.querySelectorAll('text.val').length, 3);
  assert.equal(svg.querySelectorAll('title').length, 8, 'each week names its numbers');
  assert.match(t.pane.querySelector('.sum-flow').textContent, /Created.*Done/);
  assert.equal(t.pane.querySelectorAll('.swatch').length, 2);
});

test('the worker rows have a bar for done cards and one for tokens, each with its number', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const rows = t.pane.querySelectorAll('li.sum-row');
  assert.deepEqual(rows.map((r) => r.querySelector('.sum-name').textContent), ['agent:worker', 'main']);
  const vals = rows[0].querySelectorAll('.sum-val').map((v) => v.textContent);
  assert.deepEqual(vals, ['1', '5k']);
  assert.equal(rows[0].querySelector('.fill-done').style.width, '100%');
  assert.equal(rows[1].querySelectorAll('.sum-val')[1].textContent, '–');
  assert.equal(rows[1].querySelector('.fill-tokens'), null, 'a zero is an empty track, not a sliver');
});

test('a waiting row links to its card, opens the card at its waiting section, and shows the kind, the id and the age', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const a = t.pane.querySelector('a.sum-wait-item');
  assert.equal(a.href, '#/k1/c1');
  assert.equal(a.querySelector('.pill').dataset.wk, 'review');
  assert.equal(a.querySelector('.idchip').textContent, 'c1');
  assert.match(a.querySelector('time').textContent, /^rel /);
  const e = a.fire('click');
  assert.equal(vm.runInContext('waitsFor', t.ctx), 'c1');
  // the card opens through the page's own route (one history entry, Back closes it), not through the browser's link
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(t.env.opened, [['c1', a]]);
});

test('the Summary\'s card links open the card page on a plain click and leave modified clicks to the browser', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const links = [t.pane.querySelector('a.sum-wait-item'), t.pane.querySelector('a.sum-ms-item')];
  assert.deepEqual(links.map((a) => a.href), ['#/k1/c1', '#/k1/c3'], 'the address stays, for a new tab');
  const plain = links[1].fire('click', { button: 0 });
  assert.equal(plain.defaultPrevented, true);
  assert.deepEqual(t.env.opened.map((o) => o[0]), ['c3']);
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const e = links[1].fire('click', mod);
    assert.equal(e.defaultPrevented, false, JSON.stringify(mod));
  }
  assert.equal(t.env.opened.length, 1, 'none of the modified clicks opened the page here');
  // the link to a view is a plain link
  const more = summaryPage(Array.from({ length: 9 }, (_, i) => card({ id: 'c' + (i + 20), status: 'todo', waits: [{ id: `c${i + 20}.w1`, kind: 'question', text: 'q', state: 'open', askedAt: ago(HOUR) }] })), CUSTOM);
  more.page.renderSummary();
  const view = more.pane.querySelector('a.sum-more');
  assert.equal(view.href, '#/k1/waiting');
  assert.equal(view.listeners.click, undefined);
});

test('milestones link to their page with their progress', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  const a = t.pane.querySelector('a.sum-ms-item');
  assert.equal(a.href, '#/k1/c3');
  assert.equal(a.querySelector('.sum-ms-title').textContent, 'Launch <script>');
  assert.equal(a.querySelector('.ms-prog').textContent, '0/1');
  assert.equal(a.querySelector('.ms-st').textContent, 'open', 'the state is beside the title');
});

test('text from cards is set as text: no markup is made from a title, a wait or a milestone', () => {
  const t = summaryPage(demoCards(), CUSTOM);
  t.page.renderSummary();
  assert.equal(t.pane.querySelector('img'), null);
  assert.equal(t.pane.querySelector('b'), null);
  assert.equal(t.pane.querySelector('script'), null);
  assert.match(t.pane.querySelector('.sum-wait-text').textContent, /^<b>Please<\/b> check/);
});

test('a project with no cards shows zero tiles, says so and links to the Board', () => {
  const t = summaryPage([], CUSTOM);
  t.page.renderSummary();
  assert.deepEqual(t.pane.querySelectorAll('.sum-tile-n').map((x) => x.textContent), ['0', '0', '0', '0', '0']);
  assert.match(t.pane.querySelector('.sum-empty').textContent, /No cards in this project yet/);
  assert.equal(t.pane.querySelector('.sum-empty a.btn').href, '#/k1/board');
  assert.equal(t.pane.querySelectorAll('svg').length, 0);
  assert.match(t.pane.textContent, /About these numbers/);
});

test('a project with cards but nothing in a panel says so in that panel', () => {
  const t = summaryPage([card({ status: 'todo', createdAt: ago(300 * DAY) })], CUSTOM);
  t.page.renderSummary();
  const text = (cls) => t.pane.querySelector('.' + cls).textContent;
  assert.match(text('sum-flow'), /Nothing was created or finished in these weeks\./);
  assert.match(text('sum-who'), /No work by a recorded worker yet\./);
  assert.match(text('sum-wait'), /Nothing is waiting for you\./);
  assert.match(text('sum-ms'), /No milestones in this project yet\./);
  assert.match(text('sum-stage'), /Not enough moves between stages yet\./);
});

// ---------------------------------------------------------------- the wiring in the page

test('the Summary view is drawn by the pane, redrawn when its numbers change, and has its own style and script pieces', () => {
  assert.match(html, /else if \(viewSel === 'summary'\) renderSummary\(\);/);
  assert.match(html, /if \(viewSel === 'summary'\) return JSON\.stringify\(\['summary', selKey, summaryModel\(current\.cards, cfg\(\), Date\.now\(\)\)\]\);/);
  assert.match(html, /\.sum-cols \{/);
  assert.doesNotMatch(html, /Summary analytics come in a later update/);
});
