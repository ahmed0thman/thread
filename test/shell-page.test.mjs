// The board page's shell: the addresses (the projects home, a project's views, a card's page), the default view of each mode, the tile
// of a project on the projects home and the top bar. The page's own code runs in a vm with stand-ins for the rest of the page.
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

const routes = vm.runInNewContext(`${block('routes')}\n({ parseRoute, hashFor, defaultView, viewsOf, resolveView, VIEWS, VIEW_LABEL })`, {});
const route = (hash) => plain(routes.parseRoute(hash));

// ---------------------------------------------------------------- the addresses

test('#/ and an empty address are the projects home', () => {
  const home = { home: true, key: '', view: '', card: '' };
  assert.deepEqual(route('#/'), home);
  assert.deepEqual(route('#'), home);
  assert.deepEqual(route(''), home);
  assert.deepEqual(route(undefined), home);
});

test('#/<key> is the default view of that project, and #/<key>/<view> names a view', () => {
  assert.deepEqual(route('#/abc123'), { home: false, key: 'abc123', view: '', card: '' });
  assert.deepEqual(route('#/abc123/'), { home: false, key: 'abc123', view: '', card: '' });
  for (const v of ['summary', 'board', 'list', 'milestones', 'waiting']) {
    assert.deepEqual(route(`#/abc123/${v}`), { home: false, key: 'abc123', view: v, card: '' }, v);
  }
  assert.deepEqual(plain(routes.VIEWS), ['summary', 'board', 'list', 'milestones', 'waiting']);
});

test('#/<key>/<card> is the card page, and a card id is never taken for a view', () => {
  for (const id of ['c1', 'c42', 'c1000', 'new']) {
    assert.deepEqual(route(`#/abc123/${id}`), { home: false, key: 'abc123', view: '', card: id }, id);
    assert.ok(!routes.VIEWS.includes(id), `${id} is not a view name`);
  }
  // anything else after the project is a card to look for, as before: the page then says it is not found
  assert.deepEqual(route('#/abc123/c9x'), { home: false, key: 'abc123', view: '', card: 'c9x' });
  // a view name is matched whole
  assert.deepEqual(route('#/abc123/boards'), { home: false, key: 'abc123', view: '', card: 'boards' });
  assert.deepEqual(route('#/abc123/Board'), { home: false, key: 'abc123', view: '', card: 'Board' });
});

test('the old #<card> form has no project and still opens the card', () => {
  assert.deepEqual(route('#c3'), { home: false, key: '', view: '', card: 'c3' });
  assert.deepEqual(route('#new'), { home: false, key: '', view: '', card: 'new' });
});

test('the address is decoded, and one that cannot be decoded is used as it is', () => {
  assert.deepEqual(route('#/a%20b/c1'), { home: false, key: 'a b', view: '', card: 'c1' });
  assert.deepEqual(route('#/a%E0%A4%A/c1'), { home: false, key: 'a%E0%A4%A', view: '', card: 'c1' });
  assert.equal(routes.hashFor('abc', ''), '#/abc');
  assert.equal(routes.hashFor('abc', 'list'), '#/abc/list');
  assert.equal(routes.hashFor('a b', 'c1'), '#/a%20b/c1');
  // what the page builds, it can read back
  for (const [k, t] of [['k', ''], ['k', 'board'], ['k', 'c7'], ['k', 'new']]) {
    const r = route(routes.hashFor(k, t));
    assert.equal(r.key, k);
    assert.equal(r.view || r.card, t);
  }
});

test('the link /thread:board prints, #/<key>, opens that project', () => {
  assert.deepEqual(route('#/0123456789ab'), { home: false, key: '0123456789ab', view: '', card: '' });
});

// ---------------------------------------------------------------- the views of a mode

test('a task project starts at its Summary and has five views; a chat-only project has the board only', () => {
  assert.equal(routes.defaultView(false), 'summary');
  assert.equal(routes.defaultView(true), 'board');
  assert.deepEqual(plain(routes.viewsOf(false)), ['summary', 'board', 'list', 'milestones', 'waiting']);
  assert.deepEqual(plain(routes.viewsOf(true)), ['board']);
  assert.deepEqual(plain(routes.VIEW_LABEL), { summary: 'Summary', board: 'Board', list: 'List', milestones: 'Milestones', waiting: 'Waiting' });
});

test('resolveView: the named view, the default one, the view under a card page, and chat-only sending everything to the board', () => {
  const r = (hash, chat, shown = '') => plain(routes.resolveView(routes.parseRoute(hash), chat, shown));
  assert.deepEqual(r('#/k', false), { view: 'summary', fix: false });
  assert.deepEqual(r('#/k', true), { view: 'board', fix: false });
  assert.deepEqual(r('#/k/list', false), { view: 'list', fix: false });
  assert.deepEqual(r('#/k/waiting', false), { view: 'waiting', fix: false });
  // a card page opens over the view that is showing, or over the default one when nothing is
  assert.deepEqual(r('#/k/c3', false, 'list'), { view: 'list', fix: false });
  assert.deepEqual(r('#/k/c3', false, ''), { view: 'summary', fix: false });
  assert.deepEqual(r('#/k/c3', true, 'summary'), { view: 'board', fix: false });
  // chat-only: the other views are sent to the board, and the address is rewritten
  for (const v of ['summary', 'list', 'milestones', 'waiting']) assert.deepEqual(r(`#/k/${v}`, true), { view: 'board', fix: true }, v);
  assert.deepEqual(r('#/k/board', true), { view: 'board', fix: false });
});

// ---------------------------------------------------------------- syncFromHash

function syncPage(over = {}) {
  const state = {
    hash: '', projects: [{ key: 'k1' }, { key: 'k2' }, { key: 'kc' }], homeKey: 'k1', selKey: '', current: null, viewSel: '', panel: null, halted: false,
    chat: { kc: true }, ro: false, calls: [], replaced: [], pushed: [],
    ...over,
  };
  const env = {
    location: { get hash() { return state.hash; }, pathname: '/', search: '' },
    history: { replaceState: (a, b, url) => { state.replaced.push(url); state.hash = url.slice(url.indexOf('#')); }, pushState: (a, b, url) => { state.pushed.push(url); } },
    get halted() { return state.halted; }, get projects() { return state.projects; }, get homeKey() { return state.homeKey; },
    get selKey() { return state.selKey; }, get current() { return state.current; }, get viewSel() { return state.viewSel; }, get panel() { return state.panel; },
    projectByKey: (k) => state.projects.find((p) => p.key === k) || null,
    isRO: () => state.ro, isChat: () => !!state.chat[state.selKey],
    enterHome: () => { state.calls.push('home'); state.selKey = ''; state.current = null; state.viewSel = ''; },
    selectProject: (k) => { state.calls.push('select:' + k); state.selKey = k; state.current = null; state.viewSel = ''; },
    showView: (v) => { state.calls.push('view:' + v); state.viewSel = v; },
    removePanel: (swapping) => { state.calls.push('remove:' + swapping); state.panel = null; },
    buildPanel: (t) => { state.calls.push('build:' + t); state.panel = { target: t }; },
    updatePanel: () => state.calls.push('update'),
  };
  const sync = vm.runInNewContext(`${block('routes')}\n${block('address sync')}\nsyncFromHash`, vm.createContext(env));
  const go = (hash) => { state.hash = hash; state.calls.length = 0; sync(); return state.calls.slice(); };
  const load = () => { state.current = { cards: [] }; };   // the project's board arrived
  return { state, go, load, sync };
}

test('#/ opens the projects home, whatever was selected', () => {
  const p = syncPage({ selKey: 'k2', current: { cards: [] }, viewSel: 'board' });
  assert.deepEqual(p.go('#/'), ['home']);
  assert.deepEqual(p.go(''), ['home']);
});

test('#/<key> selects the project, then shows its default view once the board has loaded', () => {
  const p = syncPage();
  assert.deepEqual(p.go('#/k2'), ['select:k2'], 'the board is still loading');
  p.load();
  assert.deepEqual(p.go('#/k2'), ['view:summary']);
});

test('a chat-only project opens at its board and sends the other views there', () => {
  const p = syncPage();
  p.go('#/kc'); p.load();
  assert.deepEqual(p.go('#/kc'), ['view:board']);
  p.state.viewSel = '';
  assert.deepEqual(p.go('#/kc/list'), ['view:board']);
  assert.equal(p.state.replaced.at(-1), '/#/kc/board', 'the address is rewritten');
  assert.deepEqual(p.go('#/kc/waiting'), ['view:board']);
  assert.equal(p.state.replaced.at(-1), '/#/kc/board');
});

test('each view of a task project is opened by its address', () => {
  const p = syncPage();
  p.go('#/k1'); p.load();
  for (const v of ['summary', 'board', 'list', 'milestones', 'waiting']) assert.deepEqual(p.go(`#/k1/${v}`), [`view:${v}`], v);
});

test('a card page opens over the view that is showing and builds the card', () => {
  const p = syncPage();
  p.go('#/k1'); p.load();
  p.go('#/k1/list');
  assert.deepEqual(p.go('#/k1/c5'), ['view:list', 'build:c5']);
  assert.equal(p.state.viewSel, 'list');
  // closing it: the address goes back to the view
  assert.deepEqual(p.go('#/k1/list'), ['view:list', 'remove:false']);
});

test('a card address loaded directly opens over the default view', () => {
  const p = syncPage();
  p.go('#/k2/c5');
  p.load();
  assert.deepEqual(p.go('#/k2/c5'), ['view:summary', 'build:c5']);
});

test('the old #<card> form opens the card in the selected project, or in the home project at first', () => {
  const p = syncPage();
  assert.deepEqual(p.go('#c3'), ['select:k1']);
  assert.equal(p.state.replaced.at(-1), '/#/k1/c3', 'the address gets its project');
  p.load();
  assert.deepEqual(p.go('#c3'), ['view:summary', 'build:c3']);
  const q = syncPage({ selKey: 'k2', current: { cards: [] }, viewSel: 'board' });
  assert.deepEqual(q.go('#c3'), ['view:board', 'build:c3']);
  assert.equal(q.state.replaced.at(-1), '/#/k2/c3');
});

test('an unknown project falls back to the home project, as before', () => {
  const p = syncPage();
  assert.deepEqual(p.go('#/nope/list'), ['select:k1']);
  assert.equal(p.state.replaced.at(-1), '/#/k1/list');
});

test('a new card is refused on a chat-only or read-only project and the address goes back to the view, which is shown', () => {
  const p = syncPage();
  p.go('#/kc'); p.load(); p.go('#/kc');
  assert.deepEqual(p.go('#/kc/new'), ['view:board']);
  assert.equal(p.state.replaced.at(-1), '/#/kc/board');
  const q = syncPage({ ro: true });
  q.go('#/k1'); q.load(); q.go('#/k1/list');
  assert.deepEqual(q.go('#/k1/new'), ['view:list']);
  assert.equal(q.state.replaced.at(-1), '/#/k1/list');
});

test('/new as the first address of a chat-only or read-only project lands on a shown view, not a blank page', () => {
  // viewSel is still '' (nothing has been shown yet): the address goes to the default view and that view is shown
  const p = syncPage();
  p.go('#/kc/new');
  p.load();
  assert.equal(p.state.viewSel, '');
  assert.deepEqual(p.go('#/kc/new'), ['view:board']);
  assert.equal(p.state.replaced.at(-1), '/#/kc/board', 'not "#/kc", which would leave the page blank');
  assert.equal(p.state.viewSel, 'board', 'showView ran after the redirect');
  const q = syncPage({ ro: true });
  q.go('#/k1/new');
  q.load();
  assert.deepEqual(q.go('#/k1/new'), ['view:summary']);
  assert.equal(q.state.replaced.at(-1), '/#/k1/summary');
  assert.equal(q.state.viewSel, 'summary');
  // the address the redirect wrote is then read as the view it names
  assert.deepEqual(q.go(q.state.hash), ['view:summary']);
});

test('an open page with unsaved edits holds back a move to another view, the home or another project', () => {
  const p = syncPage();
  p.go('#/k1'); p.load(); p.go('#/k1/list'); p.go('#/k1/c5');
  let asked = 0;
  p.state.panel = { target: 'c5', isDirty: () => true, showDiscard: () => { asked++; } };
  assert.deepEqual(p.go('#/k1/summary'), []);
  assert.deepEqual(p.go('#/'), []);
  assert.deepEqual(p.go('#/k2'), []);
  assert.equal(asked, 3);
  assert.deepEqual(p.state.pushed, ['#/k1/c5', '#/k1/c5', '#/k1/c5']);
});

test('nothing happens while the access page shows or before the project list has arrived', () => {
  const p = syncPage({ halted: true });
  assert.deepEqual(p.go('#/k1'), []);
  const q = syncPage({ projects: null });
  assert.deepEqual(q.go('#/k1'), []);
});

// ---------------------------------------------------------------- the tile of a project

const tile = vm.runInNewContext(`${block('projects home')}\n({ tileModel, dirParts })`, {});

test('a tile has the counts the server sent, running threads, the last activity and the path split for cutting', () => {
  const m = plain(tile.tileModel({ key: 'k1', name: 'shop', projectDir: '/home/me/code/shop', exists: true, cards: 9, running: 2, open: 5, done: 4, waiting: 3, lastActivity: '2026-10-14T05:00:00.000Z' }));
  assert.deepEqual(m, {
    key: 'k1', name: 'shop', dir: '/home/me/code/shop', dirHead: '/home/me/code', dirTail: '/shop', missing: false,
    open: 5, done: 4, waiting: 3, running: 2, last: '2026-10-14T05:00:00.000Z', chat: false,
  });
});

test('a server that sends no open, done or waiting gives null counts, shown as a dash', () => {
  const m = plain(tile.tileModel({ key: 'k1', name: 'shop', projectDir: '/x/shop', exists: true, cards: 3, running: 0, lastActivity: '2026-10-14T05:00:00.000Z' }));
  assert.equal(m.open, null);
  assert.equal(m.done, null);
  assert.equal(m.waiting, null);
  assert.equal(m.running, 0);
  // a zero is a count; a missing, negative or text value is not
  const z = plain(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n', open: 0, done: '4', waiting: -1 }));
  assert.deepEqual([z.open, z.done, z.waiting], [0, null, null]);
  assert.equal(z.last, '');
});

test('a tile shows a project whose folder is gone, and chat-only when the server says so or the page has seen it', () => {
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n', exists: false }).missing, true);
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n' }).missing, false);
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n' }).chat, false);
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n', mode: 'chat' }).chat, true);
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n' }, true).chat, true);
  assert.equal(tile.tileModel({ key: 'k', name: 'n', projectDir: '/x/n', mode: 'tasks' }, false).chat, false);
});

test('the path is cut at the last separator, with / or \\ and for a bare name', () => {
  assert.deepEqual(plain(tile.dirParts('/a/b/c')), { head: '/a/b', tail: '/c' });
  assert.deepEqual(plain(tile.dirParts('C:\\a\\b')), { head: 'C:\\a', tail: '\\b' });
  assert.deepEqual(plain(tile.dirParts('shop')), { head: '', tail: 'shop' });
  assert.deepEqual(plain(tile.dirParts('')), { head: '', tail: '' });
  assert.deepEqual(plain(tile.dirParts(undefined)), { head: '', tail: '' });
});

// ---------------------------------------------------------------- the page code that draws them

function homePage(over = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createDocumentFragment: () => new FakeEl(doc, 'frag') };
  doc.body = new FakeEl(doc, 'body');
  const pane = new FakeEl(doc, 'main');
  doc.body.append(pane);
  const state = { projects: [], modeSeen: {}, viewSel: 'summary', selKey: 'k1', current: { cards: [] } };
  const env = {
    document: doc, elPane: pane, get projects() { return state.projects; }, modeSeen: state.modeSeen, get viewSel() { return state.viewSel; }, get selKey() { return state.selKey; },
    get current() { return state.current; },
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
    timeEl: (iso) => { const t = doc.createElement('time'); t.textContent = 'rel ' + iso; return t; },
    hashFor: routes.hashFor, VIEW_LABEL: routes.VIEW_LABEL,
    milestoneCards: () => (state.current.cards || []).filter((c) => c.kind === 'milestone'),
    progressFor: (m) => ({ done: 1, total: 2, id: m.id }),
    progressEl: (p) => { const e = doc.createElement('div'); e.className = 'ms-prog'; e.textContent = `${p.done}/${p.total} done`; return e; },
    ...over,
  };
  const src = `${block('projects home')}\n${html.slice(html.indexOf('  function buildTile(m) {'), html.indexOf('  // ---- what is showing'))}\n({ buildTile, renderHome })`;
  const page = vm.runInNewContext(src, vm.createContext(env));
  return { page, pane, state, env, doc };
}

test('the projects home has one tile per project, a link to #/<key> with the name, the path and the counts', () => {
  const { page, pane, state } = homePage();
  state.projects = [
    { key: 'k1', name: 'shop', projectDir: '/home/me/code/shop', exists: true, running: 2, open: 5, done: 4, waiting: 3, lastActivity: '2026-10-14T05:00:00.000Z' },
    { key: 'k2', name: 'blog', projectDir: '/home/me/code/blog', exists: true, running: 0, lastActivity: '2026-10-13T05:00:00.000Z' },
  ];
  page.renderHome();
  const tiles = pane.querySelectorAll('a.tile');
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].href, '#/k1');
  assert.equal(tiles[0].querySelector('.tile-name').textContent, 'shop');
  assert.equal(tiles[0].querySelector('.dir-head').textContent, '/home/me/code');
  assert.equal(tiles[0].querySelector('.dir-tail').textContent, '/shop');
  const stat = (t, name) => t.querySelectorAll('.stat').find((s) => s.querySelector('dt').textContent === name);
  assert.equal(stat(tiles[0], 'Open').querySelector('dd').textContent, '5');
  assert.equal(stat(tiles[0], 'Done').querySelector('dd').textContent, '4');
  assert.equal(stat(tiles[0], 'Waiting').querySelector('dd').textContent, '3');
  assert.match(stat(tiles[0], 'Waiting').className, /\bhot\b/, 'red above 0');
  assert.match(tiles[0].querySelector('.tile-run').textContent, /2 running/);
  assert.match(tiles[0].textContent, /Active rel 2026-10-14/);
  // an older server: dashes, no red, no running mark
  for (const name of ['Open', 'Done', 'Waiting']) assert.equal(stat(tiles[1], name).querySelector('dd').textContent, '–', name);
  assert.doesNotMatch(stat(tiles[1], 'Waiting').className, /hot/);
  assert.equal(tiles[1].querySelector('.tile-run'), null);
  assert.match(pane.textContent, /2 projects/);
});

test('a waiting count of 0 is not red, a missing folder and chat-only are marked, and the tile text is set as text', () => {
  const { page, pane, state } = homePage();
  state.projects = [
    { key: 'k1', name: '<img src=x onerror=alert(1)>', projectDir: '/x/<b>y</b>', exists: false, open: 1, done: 0, waiting: 0, lastActivity: '2026-10-14T05:00:00.000Z' },
    { key: 'k2', name: 'chat', projectDir: '/x/chat', exists: true, open: 0, done: 0, waiting: 0 },
  ];
  state.modeSeen.k2 = true;
  page.renderHome();
  const [a, b] = pane.querySelectorAll('a.tile');
  assert.match(a.className, /is-missing/);
  assert.match(a.textContent, /folder missing/);
  assert.doesNotMatch(a.querySelectorAll('.stat').find((s) => s.querySelector('dt').textContent === 'Waiting').className, /hot/);
  assert.equal(a.querySelector('.tile-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(a.querySelector('img'), null, 'no markup is made from a name');
  assert.match(b.textContent, /chat-only/);
  assert.doesNotMatch(a.textContent, /chat-only/);
});

// ---------------------------------------------------------------- the markup and its wiring

test('the page has the project switcher, the top bar, the pane and the board, with the board filters in their own group', () => {
  assert.match(html, /<nav class="switcher" id="switcher" aria-label="Project" hidden>\s*<a class="home-link" id="home-link" href="#\/"/);
  assert.match(html, /<select class="input" id="proj-select" aria-label="Switch project">/);
  assert.match(html, /<nav class="views" id="views" aria-label="Project views" hidden><\/nav>/);
  assert.match(html, /<main class="pane" id="pane"/);
  assert.doesNotMatch(html, /ptabs|ptab\b|role="tablist"/, 'the project tab row is gone');
  const bar = html.slice(html.indexOf('<div class="toolbar"'), html.indexOf('<main class="board"'));
  assert.match(bar, /id="search"[\s\S]*<div class="filters" id="filters">[\s\S]*id="threads-only"[\s\S]*id="waiting-btn"[\s\S]*id="filter-note"[\s\S]*<\/div>\s*<button[^>]*id="new-btn"/);
  assert.match(html, /\.filters \{ display: contents; \}/);
});

test('the top bar is made of links to the views, marks the current one and carries the waiting count', () => {
  const src = html.slice(html.indexOf('  function renderViews() {'), html.indexOf('  // ---- the pane:'));
  assert.match(src, /link\.href = hashFor\(selKey, v\);/);
  assert.match(src, /link\.setAttribute\('aria-current', 'page'\)/);
  assert.match(src, /viewsOf\(isChat\(\)\)\.forEach/);
  assert.match(src, /v === 'waiting' && n > 0/);
  assert.match(src, /, ' \+ n \+ \(n === 1 \? ' item' : ' items'\) \+ ' waiting for you'/);
});

test('the board is drawn only while it shows, the Waiting view is the waiting filter, and the search is for the views that use it', () => {
  assert.match(html, /function renderBoard\(force\) \{\n\s+if \(!current \|\| !showsBoard\(\)\) return;/);
  assert.match(html, /const SEARCH_VIEWS = \['board', 'waiting', 'list'\];/);
  assert.match(html, /function showsBoard\(\) \{ return !showingHome && !!selKey && \(viewSel === 'board' \|\| viewSel === 'waiting'\); \}/);
  assert.match(html, /else if \(f\.waiting && !waitingCount\(\)\) what = 'Nothing is waiting for you\.';/);
});

test('leaving for the home forgets the project, and a new card cannot be started without one', () => {
  const src = html.slice(html.indexOf('  function enterHome() {'), html.indexOf('  // ---- the top bar of a project'));
  assert.match(src, /showingHome = true;\n\s+selKey = '';/);
  assert.match(src, /current = null;/);
  assert.match(html, /function openNew\(\) \{ if \(halted \|\| !selKey \|\| isRO\(\) \|\| isChat\(\)\) return;/);
});

test('the back button names the view the card page was opened over', () => {
  assert.match(html, /function backName\(\) \{ return VIEW_LABEL\[viewSel\] \? VIEW_LABEL\[viewSel\]\.toLowerCase\(\) : 'board'; \}/);
  assert.match(html, /h\('span', null, 'Back to ' \+ backName\(\)\)/);
});
