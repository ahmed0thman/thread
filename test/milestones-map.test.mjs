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
  + '({ milestonesByNumber, milestoneDeps, milestoneMap, msUpstream, msMapPick, msShort, msLabel, msName, msPlace, msGrid, msSnap, msMovePlan })',
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
    isRemote: () => false, setTimeout: () => 0, clearTimeout: () => {},
    remote: false,
    requests: [],
    api: async (method, path, body) => { env.requests.push([method, path, body]); return env.reply ? env.reply(method, path, body) : {}; },
    pp: (key, rest) => '/api/p/' + key + '/' + rest,
    applyCard: (card) => { const i = env.current.cards.findIndex((c) => c.id === card.id); if (i >= 0) env.current.cards[i] = card; },
    pollSeq: 0, appliedSeq: 0, lastRaw: '',
    apply: (data) => { env.current = data; },
  };
  env.isRemote = () => env.remote;
  const hub = {};
  env.window = {
    addEventListener: (type, fn) => { (hub[type] = hub[type] || []).push(fn); },
    removeEventListener: (type, fn) => { hub[type] = (hub[type] || []).filter((f) => f !== fn); },
    fire: (type, ev = {}) => { const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev }; (hub[type] || []).slice().forEach((f) => f(e)); return e; },
    listening: (type) => (hub[type] || []).length,
  };
  doc.documentElement = new FakeEl(doc, 'html');
  const start = html.indexOf('  function milestonesPaneKey');
  const end = html.indexOf('  // ---------- projects home');
  assert.ok(start > 0 && end > start);
  const src = `${block('card link')}\n${block('working now')}\n${block('milestones and stages')}\n${block('milestone view model')}\n${html.slice(start, end)}\n({ renderMilestones, milestonesPaneKey })`;
  const ctx = vm.createContext(env);
  const page = vm.runInContext(src, ctx);
  ctx.renderPane = () => { pane.replaceChildren(); page.renderMilestones(); };
  ctx.paneSig = '';
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

// ---------------------------------------------------------------- links drawn by hand, and the owner's layout

const withHand = (m, dependsOn) => ({ ...m, dependsOn });

test('a link drawn by hand is an edge like a card link: it makes the map a dependency map, sets Now and After, and joins the route', () => {
  const cards = [withHand(ms('b', 'M2: Checkout'), ['a']), ms('a', 'M1: Payments'), card('a1', { parent: 'a' }), card('b1', { parent: 'b' })];
  const list = cards.filter((c) => c.kind === 'milestone');
  assert.deepEqual(plain(lib.milestoneDeps(list, cards)), [], 'the card links alone make nothing');
  const map = lib.milestoneMap(list, cards, CONFIG);
  const n = byId(map);
  assert.equal(map.mode, 'deps', 'a hand link is a dependency: no longer just the number order');
  assert.deepEqual(plain(map.edges), [{ from: 'b', to: 'a', links: [], hand: true, cycle: false }]);
  assert.deepEqual([n.a.layer, n.b.layer], [0, 1]);
  assert.deepEqual([n.b.deps, n.a.neededBy, n.b.byHand, n.a.byHand], [['a'], ['b'], ['a'], []]);
  assert.deepEqual([n.a.now, n.b.now, n.b.waitingOn], [true, false, ['a']], 'M2 waits for M1: M1 is Now');
  assert.deepEqual(plain(lib.msUpstream(map, 'b')), ['a'], 'To reach it follows the hand link');
  // done milestone: M2 is ready
  const done = lib.milestoneMap(list, [...cards.filter((c) => c.id !== 'a1'), card('a1', { parent: 'a', status: 'done' })], CONFIG);
  assert.equal(byId(done).b.now, true);
});

test('a hand link beside a card link between the same two milestones is one edge that says both; one in the other direction is a cycle', () => {
  const cards = [
    withHand(ms('b', 'M2'), ['a']), ms('a', 'M1'), withHand(ms('c', 'M3'), ['b']),
    card('a1', { parent: 'a' }), card('b1', { parent: 'b', blockedBy: ['a1'] }), card('b2', { parent: 'b', blockedBy: ['a1'] }), card('c1', { parent: 'c', blockedBy: ['a1'] }),
  ];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CONFIG);
  assert.deepEqual(plain(map.edges).map((e) => [e.from, e.to, e.links.length, !!e.hand]), [['b', 'a', 2, true], ['c', 'a', 1, false], ['c', 'b', 0, true]]);
  assert.equal(map.edges.length, 3, 'one edge for the pair, not two');
  // the other way round: M1 depends on M2 by hand, M2 on M1 by cards
  const loop = [withHand(ms('a', 'M1'), ['b']), ms('b', 'M2'), card('a1', { parent: 'a' }), card('b1', { parent: 'b', blockedBy: ['a1'] })];
  const lm = lib.milestoneMap(loop.filter((c) => c.kind === 'milestone'), loop, CONFIG);
  assert.deepEqual(plain(lm.edges).map((e) => [e.from + '>' + e.to, !!e.hand, e.cycle]), [['a>b', true, true], ['b>a', false, true]], 'a loop is shown, not refused');
});

test('a hand link to itself, to an id that is no milestone in the list, or one that is not an id is ignored', () => {
  const cards = [withHand(ms('a', 'M1'), ['a', 'zzz', 5, null, 'b', 'b']), ms('b', 'M2'), card('t', { title: 'task' })];
  const map = lib.milestoneMap(cards.filter((c) => c.kind === 'milestone'), cards, CONFIG);
  assert.deepEqual(plain(map.edges).map((e) => [e.from, e.to]), [['a', 'b']]);
  assert.equal(lib.milestoneMap([withHand(ms('a', 'M1'), ['a', 'gone'])], [], CONFIG).mode, 'order');
});

test('the cell of a milestone is its saved one, else the map\'s own; unknown ids, bad cells and taken cells are ignored', () => {
  const cards = [ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'), card('a1', { parent: 'a' }), card('b1', { parent: 'b', blockedBy: ['a1'] })];
  const list = cards.filter((c) => c.kind === 'milestone');
  const map = lib.milestoneMap(list, cards, CONFIG);   // M1 -> M2 in layers 0 and 1, M3 loose
  const cells = (layout) => Object.fromEntries([...lib.msPlace(map, layout).cells].map(([id, c]) => [id, [c.col, c.row, c.saved]]));
  assert.deepEqual(cells({}), { a: [0, 0, false], b: [1, 0, false], c: [0, 1, false] }, 'automatic: layers, rows, the loose one in the row after');
  assert.deepEqual(cells(null), cells({}));
  assert.equal(lib.msPlace(map, {}).R0, 1);
  assert.deepEqual(cells({ b: { col: 4, row: 2 } }), { a: [0, 0, false], b: [4, 2, true], c: [0, 1, false] });
  assert.deepEqual(cells({ gone: { col: 4, row: 2 }, b: { col: 4, row: 2 } }), { a: [0, 0, false], b: [4, 2, true], c: [0, 1, false] }, 'an id that is gone is ignored');
  for (const bad of [{ col: -1, row: 0 }, { col: 1.5, row: 0 }, { col: '1', row: 0 }, { col: 1 }, { col: 80, row: 0 }, 'x', null, [1, 2]]) {
    assert.deepEqual(cells({ b: bad }), cells({}), JSON.stringify(bad));
  }
  // two saved in one cell: the first in number order keeps it, the other is placed by the map
  assert.deepEqual(cells({ a: { col: 3, row: 3 }, b: { col: 3, row: 3 } }), { a: [3, 3, true], b: [1, 0, false], c: [0, 1, false] });
  // an automatic milestone whose cell a saved one took moves down to a free cell
  assert.deepEqual(cells({ c: { col: 1, row: 0 } }), { a: [0, 0, false], b: [1, 1, false], c: [1, 0, true] });
  assert.deepEqual(cells({ c: { col: 0, row: 0 }, b: { col: 0, row: 1 } }), { a: [0, 2, false], b: [0, 1, true], c: [0, 0, true] });
  // no card links at all: the number order on one row
  const flat = lib.milestoneMap([ms('a', 'M1'), ms('b', 'M2')], [], CONFIG);
  assert.deepEqual([...lib.msPlace(flat, {}).cells].map(([id, c]) => [id, c.col, c.row]), [['a', 0, 0], ['b', 1, 0]]);
});

test('a drop snaps to the nearest cell by its middle, and a cell that is taken is swapped', () => {
  const grid = lib.msGrid(1, false);
  const mid = (c, r) => [16 + c * 204 + 70, grid.rowTop(r) + 74];
  assert.deepEqual(plain(lib.msSnap(grid, ...mid(0, 0))), { col: 0, row: 0 });
  assert.deepEqual(plain(lib.msSnap(grid, ...mid(3, 2))), { col: 3, row: 2 });
  assert.deepEqual(plain(lib.msSnap(grid, mid(3, 2)[0] + 90, mid(3, 2)[1] - 80)), { col: 3, row: 2 }, 'anywhere in the cell');
  assert.deepEqual(plain(lib.msSnap(grid, -500, -500)), { col: 0, row: 0 });
  assert.deepEqual(plain(lib.msSnap(grid, 1e6, 1e6)), { col: 79, row: 79 });
  const gap = lib.msGrid(1, true);
  assert.equal(gap.rowTop(0), 40);
  assert.equal(gap.rowTop(1), 40 + 180 + 30, 'the row of the milestones nothing links has a label above it');
  assert.equal(gap.rowTop(2), 40 + 360 + 30);
  assert.deepEqual(plain(lib.msSnap(gap, 16 + 70, gap.rowTop(1) + 74)), { col: 0, row: 1 });
  const cells = new Map([['a', { col: 0, row: 0 }], ['b', { col: 1, row: 0 }], ['c', { col: 2, row: 1 }]]);
  assert.deepEqual(plain(lib.msMovePlan(cells, 'a', 5, 4)), { a: { col: 5, row: 4 } });
  assert.deepEqual(plain(lib.msMovePlan(cells, 'a', 1, 0)), { a: { col: 1, row: 0 }, b: { col: 0, row: 0 } }, 'a swap');
  assert.deepEqual(plain(lib.msMovePlan(cells, 'a', 0, 0)), {}, 'dropped where it is');
  assert.deepEqual(plain(lib.msMovePlan(cells, 'a', 80, 0)), {});
  assert.deepEqual(plain(lib.msMovePlan(cells, 'nobody', 3, 3)), {});
});

// ---- the page
// SHOP(): M1 (column 1, row 1) <- M2 <- M3 by cards; M0 nothing links, so the map puts it in the row after, under its label.

const click = (el) => el.fire('click', { button: 0 });
const nodeBtn = (t, id) => t.pane.querySelectorAll('button.ms-node').find((b) => b.dataset.id === id);
const wrapOf = (t, id) => t.pane.querySelectorAll('li.ms-node-wrap').find((li) => li.dataset.node === id);
const at = (li) => [parseFloat(li.style.left), parseFloat(li.style.top)];
const flush = () => new Promise((r) => setImmediate(r));
const reqs = (t) => plain(t.env.requests);
const WITH_LABEL = lib.msGrid(1, true);     // the rows of SHOP while M0 is where the map puts it
const spot = (c, r, g = WITH_LABEL) => [16 + c * 204, g.rowTop(r)];

test('a hand link is dotted and says "hand", one with card links says "1 + hand", and the key and the details say it too', () => {
  const cards = SHOP();
  cards.find((c) => c.id === 'm3').dependsOn = ['m0', 'm1'];       // M3 on M0 by hand only, on M1 by hand and by a card (l1 -> p1)
  cards.find((c) => c.id === 'm2').dependsOn = ['m0'];
  const t = mapPage(cards);
  t.page.renderMilestones();
  const groups = t.pane.querySelectorAll('g.ms-edge');
  const text = (g) => g.querySelector('text.ms-count-text').textContent;
  const hand = groups.filter((g) => g.className.includes('ms-edge-hand'));
  const both = groups.filter((g) => g.className.includes('ms-edge-both'));
  assert.deepEqual(hand.map(text), ['hand', 'hand']);
  assert.deepEqual(both.map(text), ['1 + hand']);
  assert.match(t.pane.querySelector('.ms-legend').textContent, /dotted, "hand": a link you drew; "\+ hand" after a number: you drew it too/);
  assert.match(t.pane.querySelector('.ms-glance').textContent, /5 dependencies from 3 card links and 3 links drawn by hand/);
  // the details of M2 (the pick, where the project is): its link to M0 by hand, with Remove
  const det = t.pane.querySelector('div.ms-detail');
  assert.match(det.textContent, /Depends onM0 · drawn by hand/);
  assert.match(det.textContent, /M1 · 1 link · done/);
  const rm = det.querySelectorAll('button.ms-rel-rm');
  assert.equal(rm.length, 1, 'only the link drawn by hand can be removed here');
  assert.equal(rm[0].getAttribute('aria-label'), 'Remove the link you drew: M2 depends on M0');
  assert.match(nodeBtn(t, 'm2').getAttribute('aria-label'), /depends on M0, M1/);
});

test('Remove on a link drawn by hand asks the server, and says it in the live line; a link from cards has no Remove and says where it comes from', async () => {
  const cards = SHOP();
  cards.find((c) => c.id === 'm2').dependsOn = ['m0'];
  const t = mapPage(cards);
  t.env.reply = () => ({ ...cards.find((c) => c.id === 'm2'), dependsOn: undefined });
  t.page.renderMilestones();
  t.pane.querySelector('button.ms-rel-rm').fire('click');
  await flush();
  assert.deepEqual(reqs(t), [['POST', '/api/p/k1/milestones/m2/depends-on', { remove: 'm0' }]]);
  assert.match(t.pane.querySelector('.ms-note').textContent, /^M2 no longer depends on M0 by a link you drew\.$/);
  // a line from cards: click it, and the details say where it comes from
  t.env.renderPane();
  const edge = t.pane.querySelectorAll('g.ms-edge').find((g) => g.querySelector('text.ms-count-text').textContent === '1');
  edge.fire('click');
  const det = t.pane.querySelector('div.ms-detail').textContent;
  assert.match(det, /Selected lineM\d depends on M\d\. It comes from cards [a-z0-9]+ → [a-z0-9]+\. Edit those cards to change it\./);
  assert.equal(t.pane.querySelectorAll('div.ms-detail button.ms-rel-rm').length, 0);
  assert.match(t.page.milestonesPaneKey(), /"[a-z0-9]+>[a-z0-9]+"/, 'the picked line is part of what is drawn');
});

test('Add dependency offers the other milestones that are not linked by hand yet, and Add asks the server for that link, the arrow pointing at the picked one', async () => {
  const cards = SHOP();
  cards.find((c) => c.id === 'm2').dependsOn = ['m0'];
  const t = mapPage(cards);
  t.env.reply = () => ({ ...cards.find((c) => c.id === 'm2'), dependsOn: ['m0', 'm3'] });
  t.page.renderMilestones();
  const sel = t.pane.querySelector('select.ms-add-sel');
  assert.deepEqual(sel.querySelectorAll('option').map((o) => [o.value, o.textContent]), [['', 'Choose a milestone'], ['m1', 'M1: Payments'], ['m3', 'M3: Launch']], 'not itself, not M0 (already linked)');
  const add = t.pane.querySelectorAll('div.ms-add button').find((b) => b.textContent === 'Add');
  assert.equal(add.disabled, true);
  sel.value = 'm3';
  sel.fire('change');
  assert.equal(add.disabled, false);
  assert.match(t.pane.querySelector('.ms-edit-hint').textContent, /^M2 will depend on the milestone you pick: the arrow points at M2\. It holds up no card\.$/);
  add.fire('click');
  await flush();
  assert.deepEqual(reqs(t), [['POST', '/api/p/k1/milestones/m2/depends-on', { add: 'm3' }]]);
  assert.match(t.pane.querySelector('.ms-note').textContent, /^M2 now depends on M3: the arrow points at M2\. It holds up no card\.$/);
  // a refusal is said, in the same line, and is an error
  t.env.reply = () => { throw new Error('depends_on: that would make a loop of milestone links: x'); };
  t.env.renderPane();
  const sel2 = t.pane.querySelector('select.ms-add-sel');
  sel2.value = 'm1';
  sel2.fire('change');
  t.pane.querySelectorAll('div.ms-add button').find((b) => b.textContent === 'Add').fire('click');
  await flush();
  const note = t.pane.querySelector('.ms-note');
  assert.match(note.textContent, /^No link was made: that would make a loop of milestone links: x$/);
  assert.match(note.className, /is-bad/);
  assert.equal(note.getAttribute('aria-live'), 'polite');
});

test('a saved position puts a milestone in its cell, the map grows to hold it, and the milestones nothing links keep their label only while the map places them', () => {
  const cards = [ms('a', 'M1'), ms('b', 'M2'), ms('c', 'M3'), card('a1', { parent: 'a' }), card('b1', { parent: 'b', blockedBy: ['a1'] })];
  const t = mapPage(cards);
  t.page.renderMilestones();
  assert.deepEqual([at(wrapOf(t, 'a')), at(wrapOf(t, 'b')), at(wrapOf(t, 'c'))], [[16, 40], [220, 40], [16, 250]], 'automatic: M3, which nothing links, is below, past the label');
  assert.equal(t.pane.querySelectorAll('.ms-lane-label').length, 1);
  assert.equal(t.pane.querySelector('.ms-reset'), null, 'nothing saved: no Reset layout');
  t.env.current.milestoneLayout = { c: { col: 3, row: 1 }, a: { col: 0, row: 0 }, gone: { col: 9, row: 9 } };
  t.env.renderPane();
  assert.deepEqual([at(wrapOf(t, 'a')), at(wrapOf(t, 'b')), at(wrapOf(t, 'c'))], [[16, 40], [220, 40], [16 + 3 * 204, 220]], 'a, c saved; b where the map puts it');
  assert.equal(t.pane.querySelectorAll('.ms-lane-label').length, 0, 'M3 was moved by hand: the label has nothing to say');
  const canvas = t.pane.querySelector('.ms-map');
  assert.equal(parseFloat(canvas.style.width), 16 * 2 + 3 * 204 + 140, 'wide enough for column 4');
  assert.equal(parseFloat(canvas.style.height), 220 + 148 + 16);
  assert.equal(t.pane.querySelector('.ms-reset button').textContent, 'Reset layout');
  assert.match(t.page.milestonesPaneKey(), /,\[\[\["a",0,0\],\["c",3,1\]\],null,"",false\]\]$/, 'the key follows the layout, ids that are gone left out');
});

test('Reset layout asks first; Reset deletes the layout and the map goes back to its own, Keep it does nothing; the controls are only on the computer itself', async () => {
  const cards = SHOP();
  const t = mapPage(cards);
  t.env.current.milestoneLayout = { m0: { col: 2, row: 2 } };
  t.page.renderMilestones();
  const reset = () => t.pane.querySelector('.ms-reset');
  assert.deepEqual(reset().querySelectorAll('button').map((b) => b.textContent), ['Reset layout']);
  reset().querySelector('button').fire('click');
  assert.deepEqual(reqs(t), [], 'a question first');
  assert.deepEqual(reset().querySelectorAll('button').map((b) => b.textContent), ['Reset', 'Keep it']);
  assert.match(reset().textContent, /Forget your layout\?/);
  reset().querySelectorAll('button')[1].fire('click');
  assert.deepEqual(reset().querySelectorAll('button').map((b) => b.textContent), ['Reset layout'], 'Keep it: back to the button');
  assert.deepEqual(reqs(t), []);
  reset().querySelector('button').fire('click');
  t.env.reply = () => ({ layout: {} });
  reset().querySelectorAll('button')[0].fire('click');
  await flush();
  assert.deepEqual(reqs(t), [['DELETE', '/api/p/k1/milestone-layout', null]], 'one call');
  assert.match(t.pane.querySelector('.ms-note').textContent, /The layout is reset: the map places the milestones again\./);
  assert.deepEqual(t.env.current.milestoneLayout, {});
  // through the tunnel there is nothing to reset, and nothing to change
  const r = mapPage(cards);
  r.env.remote = true;
  r.env.current.milestoneLayout = { m0: { col: 2, row: 2 } };
  r.page.renderMilestones();
  assert.equal(r.pane.querySelector('.ms-reset'), null);
  assert.equal(r.pane.querySelectorAll('.ms-handle').length, 0);
  assert.equal(r.pane.querySelector('.ms-edit'), null);
  assert.equal(r.pane.querySelector('.ms-hint'), null);
  assert.equal(r.pane.querySelectorAll('button.ms-rel-rm').length, 0);
  assert.deepEqual(at(wrapOf(r, 'm0')), [16 + 2 * 204, 40 + 2 * 180], 'but it still shows the saved layout');
  nodeBtn(r, 'm1').fire('keydown', { key: 'm' });
  assert.equal(r.pane.querySelector('.ms-snap'), null, 'no move mode');
  nodeBtn(r, 'm1').fire('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(r.env.window.listening('pointermove'), 0, 'and no drag');
});

test('M starts a move: the arrow keys move a cell outline, Enter drops (a taken cell swaps) and saves, Escape cancels, and the focus stays on the milestone', async () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const key = (id, k) => nodeBtn(t, id).fire('keydown', { key: k });
  nodeBtn(t, 'm2').focus();
  assert.equal(key('m2', 'm').defaultPrevented, true);
  assert.equal(t.doc.activeElement, nodeBtn(t, 'm2'));
  const snap = () => t.pane.querySelector('.ms-snap');
  assert.deepEqual([parseFloat(snap().style.left), parseFloat(snap().style.top)], [220, 40], 'at its own cell (M2 is in the second layer)');
  assert.match(t.pane.querySelector('.ms-note').textContent, /Moving M2 from column 2, row 1\. The arrow keys move it, Enter drops it, Escape cancels\./);
  assert.match(nodeBtn(t, 'm2').getAttribute('aria-label'), /moving: column 2, row 1$/);
  key('m2', 'ArrowDown'); key('m2', 'ArrowDown'); key('m2', 'ArrowLeft');
  assert.match(t.pane.querySelector('.ms-note').textContent, /^column 1, row 3$/);
  assert.equal(t.doc.activeElement, nodeBtn(t, 'm2'), 'the arrow keys do not pick another milestone');
  // onto a milestone: it says they swap
  key('m2', 'ArrowUp'); key('m2', 'ArrowUp');
  assert.match(t.pane.querySelector('.ms-note').textContent, /^column 1, row 1: taken by M1, dropping swaps them$/);
  // Escape: nothing saved
  key('m2', 'Escape');
  assert.equal(snap(), null);
  assert.match(t.pane.querySelector('.ms-note').textContent, /Move cancelled\./);
  assert.deepEqual(reqs(t), []);
  // again, drop on a free cell
  key('m2', 'M');
  key('m2', 'ArrowRight'); key('m2', 'ArrowDown');
  t.env.reply = () => ({ layout: { m2: { col: 2, row: 1 } } });
  key('m2', 'Enter');
  assert.equal(snap(), null);
  assert.deepEqual(at(wrapOf(t, 'm2')), spot(2, 1), 'at once, before the server has answered');
  await flush();
  assert.deepEqual(reqs(t), [['PUT', '/api/p/k1/milestone-layout', { set: { m2: { col: 2, row: 1 } } }]]);
  assert.match(t.pane.querySelector('.ms-note').textContent, /^Moved M2 to column 3, row 2\.$/);
  assert.deepEqual(plain(t.env.current.milestoneLayout), { m2: { col: 2, row: 1 } }, 'the page holds the server\'s layout');
  assert.equal(t.doc.activeElement, nodeBtn(t, 'm2'));
  // onto a taken cell: both are saved
  t.env.requests.length = 0;
  key('m2', 'm');
  key('m2', 'ArrowLeft'); key('m2', 'ArrowLeft'); key('m2', 'ArrowUp');
  t.env.reply = () => ({ layout: { m2: { col: 0, row: 0 }, m1: { col: 2, row: 1 } } });
  key('m2', 'Enter');
  await flush();
  const sent = reqs(t)[0][2].set;
  assert.deepEqual(sent, { m2: { col: 0, row: 0 }, m1: { col: 2, row: 1 } }, 'the milestone that stood there takes its place');
  assert.match(t.pane.querySelector('.ms-note').textContent, /^Moved M2 to column 1, row 1; M1 took its place\.$/);
  assert.deepEqual([at(wrapOf(t, 'm2')), at(wrapOf(t, 'm1'))], [spot(0, 0), spot(2, 1)]);
});

test('a refused save puts the old layout back and says why; the move buttons of the details do what the keys do', async () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const details = () => t.pane.querySelector('div.ms-detail');
  const btn = (text) => details().querySelectorAll('button').find((b) => b.textContent === text || b.getAttribute('aria-label') === text);
  btn('Move').fire('click');
  assert.ok(t.pane.querySelector('.ms-snap'), 'a move started from the details');
  btn('Move right').fire('click');
  btn('Move down').fire('click');
  assert.match(details().textContent, /Moving to column 3, row 2/);
  assert.equal(details().querySelector('.ms-pad').getAttribute('role'), 'group');
  btn('Cancel').fire('click');
  assert.equal(t.pane.querySelector('.ms-snap'), null);
  btn('Move').fire('click');
  btn('Move left').fire('click');   // column 1, row 1: where M1 is
  t.env.reply = () => { throw new Error('the cell column 2, row 1 is taken by c9; m2 cannot share it'); };
  btn('Drop here').fire('click');
  assert.deepEqual(at(wrapOf(t, 'm2')), [16, 40], 'moved at once');
  await flush();
  assert.deepEqual(at(wrapOf(t, 'm2')), [220, 40], 'the old place is back');
  const note = t.pane.querySelector('.ms-note');
  assert.match(note.textContent, /^The move was not saved: the cell column 2, row 1 is taken by c9; m2 cannot share it$/);
  assert.match(note.className, /is-bad/);
  assert.equal(t.env.current.milestoneLayout, undefined);
});

// A pointer, as the page sees it: events on the window while one runs.
const down = (el, x, y, extra = {}) => el.fire('pointerdown', { button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, ...extra });
const mid = (c, r, grid = WITH_LABEL) => [16 + c * 204 + 70, grid.rowTop(r) + 74];

test('a press that moves a few pixels drags: the milestone follows the pointer, a cell outline shows where it lands, a swap is marked, and the drop saves; a press that does not move picks', async () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const w = t.env.window;
  // a click: no drag, no request, the click picks
  const [x0, y0] = mid(1, 0);
  down(nodeBtn(t, 'm2'), x0, y0);
  assert.ok(w.listening('pointermove') >= 1);
  w.fire('pointermove', { pointerId: 1, clientX: x0 + 2, clientY: y0 + 1 });
  w.fire('pointerup', { pointerId: 1, clientX: x0 + 2, clientY: y0 + 1 });
  assert.equal(w.listening('pointermove'), 0, 'the listeners are gone');
  assert.deepEqual(reqs(t), []);
  assert.equal(t.pane.querySelector('.ms-snap'), null);
  click(nodeBtn(t, 'm3'));
  assert.equal(nodeBtn(t, 'm3').getAttribute('aria-pressed'), 'true');
  // a drag: M3 (column 3) onto the cell of M1 (column 1): they swap
  const [sx, sy] = mid(2, 0);
  down(nodeBtn(t, 'm3'), sx, sy);
  const [tx, ty] = mid(0, 0);
  w.fire('pointermove', { pointerId: 1, clientX: sx - 100, clientY: sy });
  assert.match(wrapOf(t, 'm3').className, /is-dragging/);
  assert.equal(wrapOf(t, 'm3').style.transform, 'translate(-100px, 0px)');
  w.fire('pointermove', { pointerId: 1, clientX: tx, clientY: ty });
  assert.deepEqual([parseFloat(t.pane.querySelector('.ms-snap').style.left), parseFloat(t.pane.querySelector('.ms-snap').style.top)], [16, 40]);
  assert.match(wrapOf(t, 'm1').className, /is-swap/, 'the milestone that is there is marked');
  assert.match(t.pane.querySelector('.ms-snap').className, /is-swap/);
  assert.match(t.doc.documentElement.className, /ms-dragging/);
  // while it runs, the pane is not drawn again, whatever changes
  t.env.paneSig = 'x';
  assert.equal(t.page.milestonesPaneKey(), 'x');
  t.env.reply = () => ({ layout: { m3: { col: 0, row: 0 }, m1: { col: 2, row: 0 } } });
  w.fire('pointerup', { pointerId: 1, clientX: tx, clientY: ty });
  assert.equal(w.listening('pointerup'), 0);
  assert.doesNotMatch(t.doc.documentElement.className, /ms-dragging/);
  await flush();
  assert.deepEqual(reqs(t), [['PUT', '/api/p/k1/milestone-layout', { set: { m3: { col: 0, row: 0 }, m1: { col: 2, row: 0 } } }]]);
  assert.deepEqual(at(wrapOf(t, 'm3')), [16, 40]);
  assert.deepEqual(at(wrapOf(t, 'm1')), [16 + 2 * 204, 40]);
  assert.equal(nodeBtn(t, 'm3').getAttribute('aria-pressed'), 'true', 'the dropped milestone is picked');
  // the click that ends a drag does not pick again
  t.env.paneSig = '';
  click(nodeBtn(t, 'm1'));
  assert.equal(nodeBtn(t, 'm3').getAttribute('aria-pressed'), 'true');
});

test('Escape during a drag puts everything back and saves nothing; a drop on the same cell saves nothing; another pointer and a right button are ignored', async () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const w = t.env.window;
  const [sx, sy] = mid(0, 0);
  down(nodeBtn(t, 'm1'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 300, clientY: sy + 200 });
  w.fire('pointermove', { pointerId: 2, clientX: sx - 300, clientY: sy });
  assert.ok(t.pane.querySelector('.ms-snap'));
  assert.match(wrapOf(t, 'm1').className, /is-dragging/);
  const grown = parseFloat(t.pane.querySelector('.ms-map').style.height);
  assert.ok(grown > 40 + 180 + 148, 'the box grew to hold the cell it is over');
  const e = w.fire('keydown', { key: 'Escape' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.pane.querySelector('.ms-snap'), null);
  assert.doesNotMatch(wrapOf(t, 'm1').className, /is-dragging/);
  assert.equal(wrapOf(t, 'm1').style.transform, '');
  assert.match(t.pane.querySelector('.ms-note').textContent, /Cancelled: nothing was changed\./);
  assert.ok(parseFloat(t.pane.querySelector('.ms-map').style.height) < grown, 'and back to its size');
  assert.deepEqual(reqs(t), []);
  // back on its own cell
  down(nodeBtn(t, 'm1'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 30, clientY: sy + 30 });
  w.fire('pointermove', { pointerId: 1, clientX: sx, clientY: sy });
  w.fire('pointerup', { pointerId: 1, clientX: sx, clientY: sy });
  await flush();
  assert.deepEqual(reqs(t), []);
  assert.match(t.pane.querySelector('.ms-note').textContent, /M1 stays in column 1, row 1\./);
  // a right button does not start one
  down(nodeBtn(t, 'm1'), sx, sy, { button: 2 });
  assert.equal(w.listening('pointermove'), 0);
});

test('a finger drags only after it has rested, and a finger that moves first is a scroll', () => {
  const t = mapPage(SHOP());
  const timers = [];
  t.env.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  t.page.renderMilestones();
  const w = t.env.window;
  const [sx, sy] = mid(0, 0);
  down(nodeBtn(t, 'm1'), sx, sy, { pointerType: 'touch' });
  w.fire('pointermove', { pointerId: 1, clientX: sx + 30, clientY: sy });
  assert.equal(w.listening('pointermove'), 0, 'moved before the hold: it was a scroll');
  assert.equal(wrapOf(t, 'm1').style.transform, undefined);
  down(nodeBtn(t, 'm1'), sx, sy, { pointerType: 'touch' });
  timers.at(-1)();   // the hold
  assert.match(wrapOf(t, 'm1').className, /is-armed/);
  assert.equal(w.listening('touchmove'), 1, 'and the page does not scroll under it');
  w.fire('pointermove', { pointerId: 1, clientX: sx + 30, clientY: sy });
  assert.match(wrapOf(t, 'm1').className, /is-dragging/);
  w.fire('pointercancel', { pointerId: 1 });
  assert.doesNotMatch(wrapOf(t, 'm1').className, /is-dragging|is-armed/);
});

test('dragging the dot of a milestone onto another links them (the one dropped on waits), shows a line while it runs, and refuses itself and a link that is already there', async () => {
  const cards = SHOP();
  cards.find((c) => c.id === 'm2').dependsOn = ['m0'];
  const t = mapPage(cards);
  t.page.renderMilestones();
  const w = t.env.window;
  const dot = (id) => wrapOf(t, id).querySelector('.ms-handle');
  assert.equal(t.pane.querySelectorAll('.ms-handle').length, 4);
  assert.equal(dot('m1').getAttribute('aria-hidden'), 'true');
  // M2 depends on M0 by hand, so M0 is linked: M0 and M1 stand in the first column, M2 and M3 after them, and nothing has a label
  const G = lib.msGrid(1, false);
  const [sx, sy] = [16 + 70 + 24 + 14, G.rowTop(0) + 33];
  const [tx, ty] = mid(2, 0, G);
  down(dot('m0'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 50, clientY: sy });
  const line = t.pane.querySelector('path.ms-link-preview');
  assert.ok(line, 'a line from the dot to the pointer');
  assert.match(line.getAttribute('d'), /^M\S+ \S+ L\S+ \S+$/);
  w.fire('pointermove', { pointerId: 1, clientX: tx, clientY: ty });
  assert.match(wrapOf(t, 'm3').className, /is-target/);
  w.fire('pointermove', { pointerId: 1, clientX: 16 + 70, clientY: G.rowTop(0) + 74 });
  assert.match(wrapOf(t, 'm0').className, /is-refused/, 'itself');
  assert.doesNotMatch(wrapOf(t, 'm3').className, /is-target/);
  w.fire('pointermove', { pointerId: 1, clientX: tx, clientY: ty });
  t.env.reply = () => ({ ...cards.find((c) => c.id === 'm3'), dependsOn: ['m0'] });
  w.fire('pointerup', { pointerId: 1, clientX: tx, clientY: ty });
  assert.equal(t.pane.querySelector('path.ms-link-preview'), null);
  await flush();
  assert.deepEqual(reqs(t), [['POST', '/api/p/k1/milestones/m3/depends-on', { add: 'm0' }]]);
  assert.match(t.pane.querySelector('.ms-note').textContent, /^M3 now depends on M0: the arrow points at M3\. It holds up no card\.$/);
  // onto itself: refused, no request
  t.env.requests.length = 0;
  t.env.renderPane();
  down(dot('m0'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 20, clientY: sy });
  w.fire('pointerup', { pointerId: 1, clientX: 16 + 70, clientY: G.rowTop(0) + 74 });
  assert.match(t.pane.querySelector('.ms-note').textContent, /^A milestone cannot depend on itself\.$/);
  assert.match(wrapOf(t, 'm0').className, /ms-shake/);
  // onto M2, which already depends on M0 by a link you drew
  down(dot('m0'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 20, clientY: sy });
  const [x2, y2] = mid(1, 0, G);
  w.fire('pointerup', { pointerId: 1, clientX: x2, clientY: y2 });
  assert.match(t.pane.querySelector('.ms-note').textContent, /^M2 already depends on M0 by a link you drew\.$/);
  // dropped on empty space: nothing, and the line is gone
  down(dot('m0'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 20, clientY: sy });
  w.fire('pointerup', { pointerId: 1, clientX: 900, clientY: 700 });
  assert.match(t.pane.querySelector('.ms-note').textContent, /No link was made: drop the line on a milestone\./);
  assert.deepEqual(reqs(t), []);
  // Escape ends it too
  down(dot('m0'), sx, sy);
  w.fire('pointermove', { pointerId: 1, clientX: sx + 20, clientY: sy });
  w.fire('keydown', { key: 'Escape' });
  assert.equal(t.pane.querySelector('path.ms-link-preview'), null);
  assert.equal(w.listening('pointerup'), 0);
});

test('the pointer pieces add no HTML and no stage id, and keep nothing in the browser', () => {
  const src = html.slice(html.indexOf('// ---------- the Milestones map: arranging, linking'), html.indexOf('// ---------- projects home'));
  assert.ok(src.length > 2000);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /\.status\s*[!=]==\s*'|'in_progress'|roles\.\w+\s*[!=]==\s*'/);
  assert.doesNotMatch(src, /localStorage|sessionStorage/, 'the layout is not kept in the browser');
});

test('a drag cannot stay stuck: a ctrl+click (a right click on a Mac) does not start one, a context menu ends one, a move with no button down ends one, and the next press ends a press that never ended', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  const w = t.env.window;
  const [sx, sy] = mid(0, 0);
  down(nodeBtn(t, 'm1'), sx, sy, { ctrlKey: true });
  assert.equal(w.listening('pointermove'), 0, 'a ctrl+click is no press');
  down(nodeBtn(t, 'm1'), sx, sy);
  w.fire('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: sx + 40, clientY: sy });
  assert.match(wrapOf(t, 'm1').className, /is-dragging/);
  w.fire('contextmenu', {});
  assert.doesNotMatch(wrapOf(t, 'm1').className, /is-dragging/);
  assert.equal(w.listening('pointermove'), 0);
  down(nodeBtn(t, 'm1'), sx, sy);
  w.fire('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: sx + 40, clientY: sy });
  w.fire('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: sx + 60, clientY: sy });
  assert.equal(w.listening('pointermove'), 0, 'the button was let go out of our sight');
  assert.doesNotMatch(wrapOf(t, 'm1').className, /is-dragging/);
  // a press whose end was never seen is ended by the next press, however soon
  down(nodeBtn(t, 'm1'), sx, sy);
  down(nodeBtn(t, 'm2'), sx, sy);
  assert.equal(w.listening('pointerup'), 1, 'one press, not two');
  w.fire('pointerup', { pointerId: 1, clientX: sx, clientY: sy });
  assert.equal(w.listening('pointerup'), 0);
  assert.equal(t.env.requests.length, 0);
});

test('a keyboard move that a click ends says so, the line under the map is cleared for another project, and the row of milestones nothing links is labelled without "by any card"', () => {
  const t = mapPage(SHOP());
  t.page.renderMilestones();
  nodeBtn(t, 'm2').fire('keydown', { key: 'm' });
  assert.ok(t.pane.querySelector('.ms-snap'));
  click(nodeBtn(t, 'm3'));
  assert.equal(t.pane.querySelector('.ms-snap'), null);
  assert.match(t.pane.querySelector('.ms-note').textContent, /^Move cancelled\.$/);
  assert.equal(t.pane.querySelector('.ms-lane-label').textContent, 'Not linked to another milestone');
  t.env.selKey = 'k2';
  t.env.renderPane();
  assert.equal(t.pane.querySelector('.ms-note').textContent, '', 'another project: no news from the first');
  t.env.selKey = 'k1';
  nodeBtn(t, 'm2').fire('keydown', { key: 'm' });
  t.pane.querySelectorAll('.ms-modes button').find((b) => b.textContent === 'Cards').fire('click');
  assert.match(t.page.milestonesPaneKey(), /,null,"",false\]\]$/, 'the Cards view ends a move too (there is no map to say it on)');
});
