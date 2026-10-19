// The Milestones view's map: the number order, the dependencies the cards make between milestones, the layers, and the page it draws.
// The page's own code runs in a vm; the pure blocks alone, the drawing against a small fake DOM.
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

const CONFIG = {
  mode: 'tasks',
  stages: [{ id: 'idea', label: 'Idea' }, { id: 'new', label: 'New' }, { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' }],
  roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' },
};
// stages of a project's own: nothing in the map may assume the default ids
const CUSTOM = {
  mode: 'tasks',
  stages: [{ id: 'backlog', label: 'Backlog' }, { id: 'doing', label: 'Doing' }, { id: 'shipped', label: 'Shipped' }],
  roles: { start: 'backlog', working: 'doing', review: 'doing', blocked: 'backlog', done: 'shipped' },
};

const lib = vm.runInNewContext(
  `${block('working now')}\n${block('milestones and stages')}\n${block('milestone map model')}\n`
  + '({ milestonesByNumber, milestoneDeps, milestoneMap, msUpstream, msMapPick, msShort, msLabel, msName })',
  {},
);

const card = (id, extra = {}) => ({ id, kind: 'task', title: `Card ${id}`, note: '', status: 'new', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', ...extra });
const ms = (id, title) => card(id, { kind: 'milestone', title });
const byId = (map) => Object.fromEntries(plain(map.nodes).map((n) => [n.id, n]));

test('milestones go by their number, M0 to M10, whatever their state', () => {
  const cards = [
    ms('cb', 'M2: Catalog'), card('k1', { parent: 'cb' }),
    ms('ca', 'M0: Setup'), card('k2', { parent: 'ca', status: 'done' }),
    ms('cc', 'M10: Launch'),
    ms('cd', 'M1: Payments'), card('k3', { parent: 'cd', status: 'done' }),
    ms('ce', 'm3: Search'), card('k4', { parent: 'ce', status: 'in_progress' }),
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  assert.deepEqual(lib.milestonesByNumber(list).map((m) => m.title), ['M0: Setup', 'M1: Payments', 'M2: Catalog', 'm3: Search', 'M10: Launch']);
  const map = lib.milestoneMap(list, cards, CONFIG);
  assert.deepEqual(plain(map.nodes).map((n) => [n.short, n.state]), [['M0', 'done'], ['M1', 'done'], ['M2', 'open'], ['m3', 'open'], ['M10', 'empty']]);
  assert.equal(map.mode, 'order', 'no card links: the line is the number order');
  assert.deepEqual(plain(map.nodes).map((n) => n.layer), [0, 1, 2, 3, 4]);
});

test('a milestone with no number in its title comes after the numbered ones and has no place number', () => {
  const list = [ms('x', 'Holiday sale'), ms('b', 'M2: Catalog'), ms('a', 'M10: Launch'), ms('c', 'M1: Setup')];
  assert.deepEqual(lib.milestonesByNumber(list).map((m) => m.id), ['c', 'b', 'a', 'x']);
  const n = lib.milestoneMap(list, list, CONFIG).nodes;
  assert.deepEqual(plain(n).map((x) => [x.short, x.label]), [['M1', 'M1'], ['M2', 'M2'], ['M10', 'M10'], ['', 'Holiday sale']]);
});

test('a title is numbered by what it starts with: M7, 10, 1., v2.1, but not M1.2.3 or M3x', () => {
  const short = (title) => lib.msShort({ title });
  assert.deepEqual(['M7 Checkout', '10 Launch', '1. Setup', 'M1. Setup', 'v2.1: Beta', '2.5 Cut', '3.'].map(short), ['M7', '10', '1', 'M1', 'v2.1', '2.5', '3']);
  assert.deepEqual(['M1.2.3', 'M3x', 'Holiday', 'Sprint 4', '1000 days'].map(short), ['', '', '', '', '']);
  assert.equal(lib.msLabel({ id: 'c1', title: 'A very long title for a winter sale that goes on' }), 'A very long title for a…');
  assert.equal(lib.msLabel({ id: 'c1', title: '' }), 'c1');
});

test('two milestones with the same name are told apart by their card id, and only then', () => {
  const list = [ms('c4', 'M1: Setup'), ms('c9', 'M1: Setup again'), ms('c2', 'Winter sale'), ms('c3', 'Winter sale'), ms('c5', 'M2: Other')];
  const names = plain(lib.milestoneMap(list, list, CONFIG).nodes).map((n) => lib.msName(n));
  assert.deepEqual(names, ['M1 (c4)', 'M1 (c9)', 'M2', 'Winter sale (c2)', 'Winter sale (c3)']);
  const one = plain(lib.milestoneMap([ms('c1', '5 Launch'), ms('c2', 'Winter sale')], [], CONFIG).nodes).map((n) => lib.msName(n));
  assert.deepEqual(one, ['5', 'Winter sale'], 'a number is not a place: "5 Launch" and a milestone that is fifth in line are different names');
});

test('a card blocked by a card of another milestone makes a dependency; links inside one milestone, ideas and unknown ids do not', () => {
  const cards = [
    ms('m1', 'M1: Payments'), ms('m2', 'M2: Checkout'), ms('m3', 'M3: Launch'),
    card('p1', { parent: 'm1' }), card('p2', { parent: 'm1' }),
    card('c1', { parent: 'm2', blockedBy: ['p1', 'p2', 'p1', 'c2', 'nope', 7] }),   // two links to M1 (p1 once), c2 is in its own milestone
    card('c2', { parent: 'm2' }),
    card('l1', { parent: 'm3', blockedBy: ['m2'] }),                              // blocked by the milestone itself
    card('i1', { parent: 'm3', kind: 'idea', blockedBy: ['p1'] }),               // an idea does not count
    card('l2', { parent: 'm3', blockedBy: ['i9'] }), card('i9', { parent: 'm1', kind: 'idea' }),
    card('free', { blockedBy: ['p1'] }),                                          // a card in no milestone
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const deps = plain(lib.milestoneDeps(list, cards));
  assert.deepEqual(deps, [
    { from: 'm2', to: 'm1', links: [{ card: 'c1', by: 'p1' }, { card: 'c1', by: 'p2' }] },
    { from: 'm3', to: 'm2', links: [{ card: 'l1', by: 'm2' }] },
  ]);
  const map = lib.milestoneMap(list, cards, CONFIG);
  const n = byId(map);
  assert.equal(map.mode, 'deps');
  assert.deepEqual([n.m1.layer, n.m2.layer, n.m3.layer], [0, 1, 2]);
  assert.deepEqual([n.m2.deps, n.m1.neededBy, n.m3.waitingOn], [['m1'], ['m2'], ['m2']]);
  assert.deepEqual(plain(lib.msUpstream(map, 'm3')), ['m1', 'm2']);
});

test('a card blocked by a card of its own milestone is ignored, and so is a milestone that is all self links', () => {
  const cards = [ms('m1', 'M1'), card('a', { parent: 'm1', blockedBy: ['b', 'm1'] }), card('b', { parent: 'm1' }), ms('m2', 'M2')];
  const list = cards.filter((c) => c.kind === 'milestone');
  assert.deepEqual(plain(lib.milestoneDeps(list, cards)), []);
  assert.equal(lib.milestoneMap(list, cards, CONFIG).mode, 'order');
});

test('a cycle neither hangs nor throws: every milestone is placed, in number order, and the edges between its members are marked', () => {
  const cards = [
    ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'), ms('d', 'M4'),
    card('a1', { parent: 'a', blockedBy: ['c1'] }), card('b1', { parent: 'b', blockedBy: ['a1'] }), card('c1', { parent: 'c', blockedBy: ['b1'] }),   // M1 → M3 → M2 → M1
    card('d1', { parent: 'd', blockedBy: ['d1'] }),   // a card blocked by itself
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CONFIG);
  const n = byId(map);
  assert.deepEqual(plain(map.edges).filter((e) => e.cycle).map((e) => e.from + '>' + e.to), ['a>c', 'b>a', 'c>b']);
  assert.deepEqual([n.a.layer, n.b.layer, n.c.layer], [0, 1, 2]);
  assert.deepEqual([n.a.cycle, n.d.cycle], [true, false]);
  assert.equal(n.d.loose, true, 'a self link is no link');
  assert.deepEqual(plain(lib.msUpstream(map, 'a')), ['b', 'c'], 'the walk up stops where it started');
  assert.equal(lib.msMapPick(map, ''), 'd', 'the only open milestone with nothing to wait on');
});

test('only the edges between milestones that wait on each other are a cycle: M1 -> M2 -> M3 <-> M4 has two, not three', () => {
  const cards = [
    ms('c1', 'M1'), ms('c2', 'M2'), ms('c3', 'M3'), ms('c4', 'M4'),
    card('k1', { parent: 'c1', blockedBy: ['k2'] }), card('k2', { parent: 'c2', blockedBy: ['k3'] }),
    card('k3', { parent: 'c3', blockedBy: ['k4'] }), card('k4', { parent: 'c4', blockedBy: ['k3'] }),
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CONFIG);
  const n = byId(map);
  assert.deepEqual(plain(map.edges).map((e) => e.from + '>' + e.to + (e.cycle ? ' cycle' : '')), ['c1>c2', 'c2>c3', 'c3>c4 cycle', 'c4>c3 cycle']);
  assert.deepEqual([n.c1.cycle, n.c2.cycle, n.c3.cycle, n.c4.cycle], [false, false, true, true]);
  assert.deepEqual([n.c3.layer, n.c4.layer, n.c2.layer, n.c1.layer], [0, 1, 1, 2], 'the cycle first, in number order, then what waits on it');
  assert.deepEqual(plain(lib.msUpstream(map, 'c1')), ['c2', 'c3', 'c4']);
});

test('where the project is: the first open milestone with every dependency done; a gone pick falls back to it', () => {
  const cards = [
    ms('m0', 'M0'), card('x0', { parent: 'm0', status: 'shipped' }),
    ms('m1', 'M1'), card('x1', { parent: 'm1', status: 'doing', blockedBy: ['x0'] }),
    ms('m2', 'M2'), card('x2', { parent: 'm2', blockedBy: ['x1'] }),
    ms('m3', 'M3'),
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CUSTOM);
  const n = byId(map);
  assert.deepEqual([n.m0.state, n.m1.state, n.m2.state, n.m3.state], ['done', 'open', 'open', 'empty']);
  assert.deepEqual([n.m1.now, n.m2.now, n.m2.waitingOn], [true, false, ['m1']]);
  assert.equal(n.m3.loose, true);
  assert.equal(lib.msMapPick(map, 'm2'), 'm2');
  assert.equal(lib.msMapPick(map, 'gone'), 'm1');
  assert.equal(lib.msMapPick({ nodes: [] }, ''), '');
});

test('a milestone that depends on two in one layer goes in the next layer, with rows by what it depends on', () => {
  const cards = [ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'), card('a1', { parent: 'a' }), card('b1', { parent: 'b' }), card('c1', { parent: 'c', blockedBy: ['a1', 'b1'] })];
  const map = lib.milestoneMap(cards.filter((c) => c.kind === 'milestone'), cards, CONFIG);
  const n = byId(map);
  assert.deepEqual([n.a.layer, n.a.row, n.b.layer, n.b.row, n.c.layer], [0, 0, 0, 1, 1]);
});

// ---------------------------------------------------------------- the page

// an SVG element: the real DOM's setAttribute('class', ...) is the class, the fake keeps it in className
function svgEl(doc, tag) {
  const e = new FakeEl(doc, tag);
  const set = e.setAttribute;
  e.setAttribute = (k, v) => { if (k === 'class') e.className = String(v); else set.call(e, k, v); };
  return e;
}

function mapPage(cards) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createElementNS: (ns, tag) => svgEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const pane = new FakeEl(doc, 'main');
  doc.body.append(pane);
  const env = {
    document: doc, elPane: pane, selKey: 'k1', current: { cards }, opened: [],
    openCard: (id) => env.opened.push(id),
    cfg: () => CONFIG, milestoneCards: () => cards.filter((c) => c.kind === 'milestone'), label: (s) => s,
    hashFor: (k, t) => '#/' + k + (t ? '/' + t : ''),
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    plainBtn: (text, cls, fn) => { const b = doc.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = text; b.addEventListener('click', fn); return b; },
    progressEl: (p) => { const e = doc.createElement('div'); e.textContent = p.done + '/' + p.total; return e; },
    msStateTag: (state) => { const e = doc.createElement('span'); e.className = 'tag ms-st'; e.textContent = state; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
    fmtMs: (x) => Math.round(x / 1000) + 's',
    waitTag: () => null, goView: () => {}, milestoneSel: '',
    MS_STATE_SHAPE: { empty: 's-dring', open: 's-ring', done: 's-circle' },
    WAIT_SPEC: { question: { shape: 's-wq' }, choice: { shape: 's-wc' }, review: { shape: 's-wr' }, todo: { shape: 's-wt' } },
    waitSummary: (items) => ({ n: items.length, kinds: [...new Set(items.map((w) => w.kind))] }),
  };
  const start = html.indexOf('  function milestonesPaneKey');
  const end = html.indexOf('  // ---------- projects home');
  assert.ok(start > 0 && end > start);
  const src = `${block('card link')}\n${block('working now')}\n${block('milestones and stages')}\n${block('milestone view model')}\n${html.slice(start, end)}\n({ renderMilestones, milestonesPaneKey })`;
  const ctx = vm.createContext(env);
  const page = vm.runInContext(src, ctx);
  ctx.renderPane = () => { pane.replaceChildren(); page.renderMilestones(); };
  return { page, pane, doc, env };
}

const SHOP = () => [
  ms('m3', 'M3: Launch'), card('l1', { parent: 'm3', title: 'Go live', blockedBy: ['c1', 'p1'] }),
  ms('m1', 'M1: Payments'), card('p1', { parent: 'm1', status: 'done' }),
  ms('m2', 'M2: Checkout'), card('c1', { parent: 'm2', title: 'Cart page', blockedBy: ['p1'], waits: [{ id: 'c1.w1', kind: 'question', text: '?', state: 'open' }] }),
  ms('m0', 'M0: Setup'), card('s1', { parent: 'm0', status: 'done' }),
];

test('the map draws one focusable node per milestone in number order, named in words, with the edges hidden from screen readers', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const nodes = t.pane.querySelectorAll('button.ms-node');
  assert.deepEqual(nodes.map((b) => b.dataset.id), ['m0', 'm1', 'm2', 'm3']);
  assert.deepEqual(nodes.map((b) => b.tabIndex), [-1, -1, 0, -1], 'one tab stop: the picked milestone, where the project is');
  assert.equal(nodes[2].getAttribute('aria-pressed'), 'true');
  assert.equal(nodes[2].getAttribute('aria-label'), 'M2: Checkout; Open; 0 of 1 done; 1 waiting; depends on M1; needed by M3; ready: nothing left to wait on');
  assert.match(nodes[3].getAttribute('aria-label'), /depends on M1, M2/);
  assert.equal(t.pane.querySelector('svg.ms-edges').getAttribute('aria-hidden'), 'true');
  assert.equal(t.pane.querySelectorAll('g.ms-edge').length, 3);
  // the picked milestone's details: its own block, with the dependencies as text and the card links that make them
  const det = t.pane.querySelector('div.ms-detail');
  assert.ok(det && det.querySelector('a.ms-item-head'));
  assert.match(det.textContent, /Depends onM1 · 1 link · done/);
  assert.match(det.textContent, /Which cards link it \(2\)/);
  assert.deepEqual(det.querySelectorAll('a.ms-why-card').map((a) => a.href), ['#/k1/c1', '#/k1/p1', '#/k1/l1', '#/k1/c1']);
  assert.match(t.page.milestonesPaneKey(), /^\["milestones","k1","map","m2",/);
});

test('the arrow keys move through the milestones in number order, and the focus goes with the pick', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const node = (id) => t.pane.querySelectorAll('button.ms-node').find((b) => b.dataset.id === id);
  const e = node('m2').fire('keydown', { key: 'ArrowRight' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(node('m3').getAttribute('aria-pressed'), 'true');
  assert.equal(t.doc.activeElement, node('m3'));
  node('m3').fire('keydown', { key: 'Home' });
  assert.equal(t.doc.activeElement, node('m0'));
  assert.equal(node('m0').fire('keydown', { key: 'ArrowLeft' }).defaultPrevented, true, 'at the first one it stays');
  assert.equal(node('m0').fire('keydown', { key: 'a' }).defaultPrevented, false);
  node('m1').fire('click');
  assert.match(t.page.milestonesPaneKey(), /"map","m1",/);
});

test('the Cards view lists every milestone as a block in number order, with what it depends on as text', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  t.pane.querySelectorAll('.ms-modes button').find((b) => b.textContent === 'Cards').fire('click');
  const items = t.pane.querySelectorAll('li.ms-item');
  assert.deepEqual(items.map((li) => li.dataset.id), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(items[3].querySelector('p.ms-rel-row').textContent, 'Depends on: M1, M2');
  assert.match(t.page.milestonesPaneKey(), /^\["milestones","k1","cards","",/);
});

test('with no card links the map is the number order, said as an order and not as a dependency', () => {
  const cards = [ms('b', 'M2'), card('b1', { parent: 'b' }), ms('a', 'M1'), card('a1', { parent: 'a', status: 'done' })];
  const t = mapPage(cards);
  t.page.renderMilestones();
  assert.equal(t.pane.querySelectorAll('line.ms-edge-order').length, 1);
  assert.equal(t.pane.querySelectorAll('g.ms-edge').length, 0);
  assert.match(t.pane.querySelector('.ms-legend').textContent, /number order only/);
  assert.match(t.pane.querySelector('div.ms-detail').textContent, /Comes after M1 in number order/);
  assert.doesNotMatch(t.pane.querySelector('button.ms-node').getAttribute('aria-label'), /depends on/);
});

test('a milestone on a cycle says so in words, not only by a dashed line', () => {
  const cards = [ms('a', 'M1'), ms('b', 'M2'), card('a1', { parent: 'a', blockedBy: ['b1'] }), card('b1', { parent: 'b', blockedBy: ['a1'] })];
  const t = mapPage(cards);
  t.page.renderMilestones();
  const det = t.pane.querySelector('div.ms-detail').textContent;
  assert.match(det, /Cycle: M1 and M2 depend on each other\./);
  assert.equal(det.match(/Cycle:/g).length, 1, 'said once, not once per line');
  assert.equal(t.pane.querySelectorAll('g.ms-edge-cycle').length, 2);
  assert.match(t.pane.querySelector('button.ms-node').getAttribute('aria-label'), /in a cycle/);
  assert.match(t.pane.querySelector('.ms-glance').textContent, /2 open, none ready \(a cycle: M1, M2\)/);
  // a longer loop: through other milestones
  const three = [ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'), card('a1', { parent: 'a', blockedBy: ['c1'] }), card('b1', { parent: 'b', blockedBy: ['a1'] }), card('c1', { parent: 'c', blockedBy: ['b1'] })];
  const t3 = mapPage(three);
  t3.page.renderMilestones();
  assert.match(t3.pane.querySelector('div.ms-detail').textContent, /Cycle: M1 depends on M3, and M3 depends, through other milestones, on M1\./);
});

test('the glance says how many are open when none is ready, and does not call that nothing', () => {
  const t = mapPage([ms('a', 'M1'), ms('b', 'M2'), card('a1', { parent: 'a', blockedBy: ['b1'] }), card('b1', { parent: 'b' }), card('b2', { parent: 'b', status: 'done' })]);
  t.page.renderMilestones();
  assert.match(t.pane.querySelector('.ms-glance').textContent, /Now: M2/);
  const e = mapPage([ms('a', 'M1')]);
  e.page.renderMilestones();
  assert.match(e.pane.querySelector('.ms-glance').textContent, /Nothing is open/);
});

test('the walk to a milestone stops at a done one, so the route and "To reach it" agree with "Now"', () => {
  const cards = [
    ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'),
    card('a1', { parent: 'a' }), card('b1', { parent: 'b', status: 'done', blockedBy: ['a1'] }), card('c1', { parent: 'c', blockedBy: ['b1'] }),
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CONFIG);
  const n = byId(map);
  assert.equal(n.c.now, true, 'its one dependency is done');
  assert.deepEqual(plain(lib.msUpstream(map, 'c')), ['b'], 'the done one is on the route, what it waited on is not');
  const t = mapPage(cards);
  t.page.renderMilestones();
  assert.match(t.pane.querySelector('div.ms-detail').textContent, /Nothing before it is left/);
});

test('the pick, the mode and the fold are kept per project, and the fold stays open over a redraw', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const node = (id) => t.pane.querySelectorAll('button.ms-node').find((b) => b.dataset.id === id);
  node('m3').fire('click');
  t.pane.querySelector('details.ms-why').open = true;
  t.pane.querySelector('details.ms-why').fire('toggle');
  t.env.renderPane();
  assert.equal(t.pane.querySelector('details.ms-why').open, true, 'a redraw does not close it');
  node('m1').fire('click');
  assert.equal(t.pane.querySelector('details.ms-why').open, false, 'it is open for M3 only');
  t.env.selKey = 'k2';
  t.env.renderPane();
  assert.match(t.page.milestonesPaneKey(), /"k2","map","m2"/, 'another project starts where its own project is');
  t.pane.querySelectorAll('.ms-modes button').find((b) => b.textContent === 'Cards').fire('click');
  assert.match(t.page.milestonesPaneKey(), /"k2","cards"/);
  t.env.selKey = 'k1';
  assert.match(t.page.milestonesPaneKey(), /"k1","map","m1"/, 'the first project kept its own');
});

test('the picked milestone sits in one polite live region that is the same element from drawing to drawing', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const live = t.pane.querySelector('.ms-live');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.ok(live.querySelector('div.ms-detail'));
  t.pane.querySelectorAll('button.ms-node').find((b) => b.dataset.id === 'm3').fire('click');
  assert.equal(t.pane.querySelector('.ms-live'), live);
  assert.match(live.querySelector('div.ms-detail').textContent, /M3: Launch/);
});

test('a milestone with no number has a neutral ring and is named by its title, never by a place number', () => {
  const cards = [ms('a', 'M1: Setup'), ms('b', 'Winter sale'), card('a1', { parent: 'a' }), card('b1', { parent: 'b', blockedBy: ['a1'] })];
  const t = mapPage(cards);
  t.page.renderMilestones();
  assert.deepEqual(t.pane.querySelectorAll('text.ms-ring-text').map((x) => x.textContent), ['M1', '•']);
  const lab = t.pane.querySelectorAll('button.ms-node')[1].getAttribute('aria-label');
  assert.match(lab, /^Winter sale; Open; 0 of 1 done; depends on M1/);
  assert.equal(t.pane.querySelectorAll('button.ms-node')[0].getAttribute('aria-label').startsWith('M1: Setup;'), true);
  assert.match(t.pane.querySelector('.ms-glance').textContent, /Now: M1/);
});

test('the counts on the lines never sit on a milestone or on each other, even on a fan-out that skips columns', () => {
  const cards = [];
  for (let i = 0; i <= 12; i++) cards.push(ms('m' + i, 'M' + i));
  cards.push(card('r', { parent: 'm0', status: 'done' }));
  for (let i = 1; i <= 6; i++) cards.push(card('l' + i, { parent: 'm' + i, blockedBy: ['r'] }));
  for (let i = 7; i <= 12; i++) cards.push(card('x' + i, { parent: 'm' + i, blockedBy: ['r', 'l' + (i - 6), 'l' + ((i % 6) + 1)] }));
  const t = mapPage(cards);
  t.page.renderMilestones();
  const num = (v) => parseFloat(v);
  const nodes = t.pane.querySelectorAll('li.ms-node-wrap').map((li) => ({ x: num(li.style.left), y: num(li.style.top) }));
  const pills = t.pane.querySelectorAll('rect.ms-count').map((r) => ({ x: num(r.getAttribute('x')), y: num(r.getAttribute('y')), w: num(r.getAttribute('width')), h: num(r.getAttribute('height')) }));
  assert.equal(pills.length, t.pane.querySelectorAll('g.ms-edge').length);
  assert.ok(pills.length > 18);
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const onNode = pills.filter((p) => nodes.some((n) => hit(p, { x: n.x, y: n.y, w: 140, h: 148 })));
  assert.equal(onNode.length, 0, 'a count over a milestone ' + JSON.stringify([onNode, nodes]));
  let over = 0;
  for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) if (hit(pills[i], pills[j])) over++;
  assert.equal(over, 0, 'two counts over each other');
});

test('the map piece sets no HTML and hard-codes no stage id', () => {
  const src = block('milestone map model') + block('milestone map page');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.doesNotMatch(src, /\.status\s*[!=]==\s*'|'in_progress'|roles\.\w+\s*[!=]==\s*'/);
});
