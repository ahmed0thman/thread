// The board page's "Waiting for you": the red pill and its filter, the tag on a card, the section on a card's page, the gear
// entry and the keys. the board page's own code runs in a vm against a small fake DOM and a scripted server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';
import { MAX_BATCH } from '../server/waits.mjs';

const html = await assembleBoardPage();
const block = (name, end) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${end || name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
const plain = (x) => JSON.parse(JSON.stringify(x));

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const task = (id, extra = {}) => ({ id, kind: 'task', title: `Task ${id}`, note: '', status: 'new', ...extra });
const wait = (id, kind, extra = {}) => ({ id, kind, text: `Text of ${id}`, askedBy: SESSION, askedAt: '2026-10-14T03:00:00.000Z', state: 'open', ...(kind === 'choice' ? { choices: ['a', 'b', 'c'], multi: false } : {}), ...extra });

// ---------------------------------------------------------------- the page code on a fake DOM

function waitsPage(over = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const state = { current: { cards: [] }, chat: false, ro: false, selKey: 'k1', projects: [], rendered: 0, view: 'board', goViews: [], errors: [], posts: [], copies: [], applied: [], answers: [], busy: {}, halted: false, home: false, panel: null, listeners: {}, storage: (over.storage || { data: {}, broken: false }) };
  const mk = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const env = {
    document: doc,
    window: { addEventListener: (type, fn) => { (state.listeners[type] = state.listeners[type] || []).push(fn); } },
    get current() { return state.current; },
    get selKey() { return state.selKey; },
    get projects() { return state.projects; },
    get viewSel() { return state.view; },
    get halted() { return state.halted; },
    get showingHome() { return state.home; },
    get panel() { return state.panel; },
    localStorage: {
      getItem: (k) => { if (state.storage.broken) throw new Error('blocked'); return k in state.storage.data ? state.storage.data[k] : null; },
      setItem: (k, v) => { if (state.storage.broken) throw new Error('blocked'); state.storage.data[k] = String(v); },
      removeItem: (k) => { if (state.storage.broken) throw new Error('blocked'); delete state.storage.data[k]; },
    },
    goView: (v) => { state.goViews.push(v); },
    READONLY_WHY: 'read-only',
    isChat: () => state.chat,
    isRO: () => state.ro,
    h(tag, cls, text) { const e = mk(tag, cls); if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = mk('span', 'shape ' + cls); s.setAttribute('aria-hidden', 'true'); return s; },
    plainMd: (s) => s,
    renderMarkdown: (t) => { const e = mk('div', 'md'); e.textContent = t; return e; },
    clampable: (content, cls) => { const e = mk('div', 'clamp' + (cls ? ' ' + cls : '')); e.appendChild(content); return e; },
    sessionLabel: (id) => `session ${String(id).slice(0, 8)}`,
    sessionInfo: (id) => (state.sessions && state.sessions[id]) || null,
    timeEl: (iso) => { const t = mk('time'); t.textContent = `at ${iso}`; return t; },
    copyBtn: (text, what, labelText) => { const b = mk('button', 'btn small'); b.textContent = labelText || 'Copy'; b.setAttribute('aria-label', labelText || 'Copy ' + what); b.copies = text; b.addEventListener('click', () => state.copies.push(text)); return b; },
    actionBtn: (text, cls, key, onClick) => {
      const b = mk('button', 'btn ' + cls); b.textContent = text; b.dataset.busykey = key;
      b.addEventListener('click', () => { if (b.dataset.off !== '1') onClick(); });
      return b;
    },
    plainBtn: (text, cls, onClick) => { const b = mk('button', 'btn' + (cls ? ' ' + cls : '')); b.textContent = text; if (onClick) b.addEventListener('click', onClick); return b; },
    setOff: (b, off) => { b.dataset.off = off ? '1' : '0'; b.disabled = off; },
    runAction: async (key, fn) => { if (state.busy[key]) return undefined; state.busy[key] = true; try { return await fn(); } finally { delete state.busy[key]; } },
    syncBusy() {},
    clearError() {}, showError: (m) => { state.errors.push(m); },
    pp: (key, rest) => `/api/p/${key}/${rest}`,
    api: async (method, p, body) => { state.posts.push([method, p, body]); const a = state.answers.shift(); if (a instanceof Error) throw a; return a; },
    applyCards: (list, key) => { list.forEach((c) => state.applied.push([c, key])); },
    wrote() {}, poll: async () => {},
    renderBoard: () => { state.rendered++; },
    elWaiting: mk('button'), elWaitN: mk('span'), elWaitLegend: mk('span'),
    elSendBar: mk('div'), elSendText: mk('span'), elSendBtn: mk('button'), elNewBtn: mk('button'),
  };
  env.elSendBar.hidden = true;
  env.elSendBar.append(env.elSendText, env.elSendBtn);
  env.elWaiting.hidden = true;
  env.elWaiting.setAttribute('aria-pressed', 'false');
  Object.assign(env, over.env || {});
  const src = `${block('milestones and stages', 'milestones and stages')}\n${block('waiting for you', 'waiting for you')}
({ waitsOf, openWaitsOf, matches, cardActionsOf: null, waitingCount, tabWaiting, waitingOn, setWaitingOn, toggleWaiting, updateWaitingPill, waitTag, waitSummary, waitSummaryText, cardWaits,
   waitKindMark, waitReady, waitBody, waitAnswerText, waitLine, waitRow, attachWaits, sendDrafts, updateSendBar, readyDrafts, loadDrafts, saveDrafts, pruneDrafts, draftEmpty, waitDrafts, WAIT_ORDER, WAIT_SPEC })`;
  const page = vm.runInNewContext(src, vm.createContext(env));
  const setCards = (cards) => { state.current = { cards }; };
  return { page, env, state, doc, setCards };
}
const tick = () => new Promise((r) => setImmediate(r));
const texts = (el) => el.querySelectorAll('li').map((l) => l.textContent);

// ----- the pill, the filter and the legend

test('the pill is hidden with nothing waiting, shows the count of open items and is labelled for a screen reader', () => {
  const { page, env, setCards } = waitsPage();
  setCards([task('c1'), task('c2', { waits: [wait('c2.w1', 'question')] })]);
  page.updateWaitingPill();
  assert.equal(env.elWaiting.hidden, false);
  assert.equal(env.elWaitN.textContent, '1');
  assert.equal(env.elWaiting.getAttribute('aria-label'), 'Waiting for you, 1 item');
  setCards([task('c1', { waits: [wait('c1.w1', 'question'), wait('c1.w2', 'todo'), wait('c1.w3', 'review', { state: 'answered' }), wait('c1.w4', 'todo', { state: 'withdrawn' })] }), task('c2', { waits: [wait('c2.w1', 'choice')] })]);
  page.updateWaitingPill();
  assert.equal(env.elWaitN.textContent, '3', 'answered and withdrawn items do not count');
  assert.equal(env.elWaiting.getAttribute('aria-label'), 'Waiting for you, 3 items');
  setCards([task('c1', { waits: [wait('c1.w1', 'question', { state: 'answered' })] })]);
  page.updateWaitingPill();
  assert.equal(env.elWaiting.hidden, true, 'hidden at 0');
});

test('a milestone is not counted, and a chat-only project counts nothing and shows no pill', () => {
  const { page, env, state, setCards } = waitsPage();
  setCards([{ ...task('c1'), kind: 'milestone', waits: [wait('c1.w1', 'todo')] }, task('c2', { waits: [wait('c2.w1', 'todo')] })]);
  assert.equal(page.waitingCount(), 1, 'a milestone holds no items of its own');
  state.chat = true;
  assert.equal(page.waitingCount(), 0);
  page.updateWaitingPill();
  assert.equal(env.elWaiting.hidden, true);
  assert.equal(env.elWaitLegend.hidden, true);
  assert.deepEqual(plain(page.cardWaits(state.current.cards[1])), [], 'and no card carries a tag');
});

test('the pill toggles the filter, which is remembered as a pressed state, and the board is drawn again', () => {
  const { page, env, state, setCards } = waitsPage();
  setCards([task('c1', { waits: [wait('c1.w1', 'question')] })]);
  page.updateWaitingPill();
  assert.equal(page.waitingOn(), false);
  page.toggleWaiting();
  assert.equal(page.waitingOn(), true);
  assert.equal(env.elWaiting.getAttribute('aria-pressed'), 'true');
  assert.equal(state.rendered, 1);
  assert.match(env.elWaiting.title, /Show every card again/);
  page.toggleWaiting();
  assert.equal(page.waitingOn(), false);
  assert.equal(state.rendered, 2);
  assert.match(env.elWaiting.title, /Show only the cards with items waiting for you/);
});

test('the key is the filter on the board; on the Waiting view it goes back to the board, and on any other view it goes to Waiting', () => {
  const { page, env, state, setCards } = waitsPage();
  setCards([task('c1', { waits: [wait('c1.w1', 'question')] })]);
  state.view = 'summary';
  page.toggleWaiting();
  state.view = 'waiting';
  page.toggleWaiting();
  assert.deepEqual(state.goViews, ['waiting', 'board']);
  assert.equal(page.waitingOn(), false, 'the pill state is left alone');
  assert.equal(state.rendered, 0);
  page.updateWaitingPill();
  assert.equal(env.elWaiting.hidden, true, 'the Waiting view is the filter, so the pill is not shown');
  assert.equal(env.elWaitLegend.hidden, false, 'the legend still says what the icons are');
  state.view = 'board';
  page.updateWaitingPill();
  assert.equal(env.elWaiting.hidden, false);
  assert.equal(env.elWaitLegend.hidden, true);
});

test('with nothing waiting the key and the pill do nothing, and a filter that is on is taken off', () => {
  const { page, state, setCards } = waitsPage();
  setCards([task('c1')]);
  page.toggleWaiting();
  assert.equal(page.waitingOn(), false);
  assert.equal(state.rendered, 0);
  setCards([task('c1', { waits: [wait('c1.w1', 'todo')] })]);
  page.updateWaitingPill();
  page.setWaitingOn(true);
  setCards([task('c1', { waits: [wait('c1.w1', 'todo', { state: 'answered' })] })]);
  page.updateWaitingPill();
  assert.equal(page.waitingOn(), false, 'the last item was answered: the filter goes with it');
});

test('the legend shows the four kinds, each with its own icon and colour, only while the filter is on', () => {
  const { page, env, setCards } = waitsPage();
  setCards([task('c1', { waits: [wait('c1.w1', 'todo')] })]);
  page.updateWaitingPill();
  assert.equal(env.elWaitLegend.hidden, true, 'off while the filter is off');
  page.setWaitingOn(true);
  assert.equal(env.elWaitLegend.hidden, false);
  const marks = env.elWaitLegend.children;
  assert.deepEqual(marks.map((m) => m.dataset.wk), ['question', 'choice', 'review', 'todo']);
  assert.deepEqual(marks.map((m) => m.textContent), ['Question', 'Choice', 'Review', 'To do']);
  const shapes = marks.map((m) => m.children[0].className);
  assert.equal(new Set(shapes).size, 4, 'four different shapes');
  shapes.forEach((s) => assert.match(s, /^shape s-w[qcrt]$/));
  marks.forEach((m) => assert.ok(m.title.length > 10, 'each says what it is in its title'));
  // the page defines a colour per kind, in both themes, and a shape for each
  for (const k of ['question', 'choice', 'review', 'todo']) assert.match(html, new RegExp(`\\[data-wk="${k}"\\] \\{ --k: var\\(--w[qcrt]\\); --kbg: var\\(--w[qcrt]-bg\\); \\}`));
  assert.equal((html.match(/--wq: #/g) || []).length, 2, 'light and dark');
  page.updateWaitingPill();
  assert.equal(env.elWaitLegend.children.length, 4, 'built once');
  page.setWaitingOn(false);
  assert.equal(env.elWaitLegend.hidden, true);
});

test('the waiting filter joins search, threads only, session and milestone with AND', () => {
  const { page } = waitsPage();
  const t = (id, title, parent, w) => task(id, { title, parent, waits: w ? [wait(id + '.w1', 'question')] : [] });
  const thread = { id: 'c9', kind: 'thread', title: 'Thread', note: '', thread: { parentSessionId: SESSION }, waits: [wait('c9.w1', 'todo')] };
  const base = { q: '', threadsOnly: false, session: '', milestone: '', waiting: true };
  const m = (c, f) => page.matches(c, { ...base, ...f });
  assert.equal(m(t('c1', 'Alpha', '', true), {}), true);
  assert.equal(m(t('c2', 'Beta', '', false), {}), false, 'no open item, no match');
  assert.equal(m(t('c2', 'Beta', '', false), { waiting: false }), true);
  assert.equal(m(t('c1', 'Alpha', '', true), { q: 'alpha' }), true);
  assert.equal(m(t('c1', 'Alpha', '', true), { q: 'beta' }), false, 'and the search');
  assert.equal(m(t('c1', 'Alpha', 'c7', true), { milestone: 'c7' }), true);
  assert.equal(m(t('c1', 'Alpha', 'c8', true), { milestone: 'c7' }), false, 'and the milestone');
  assert.equal(m(t('c1', 'Alpha', '', true), { threadsOnly: true }), false, 'and threads only');
  assert.equal(m(thread, { threadsOnly: true }), true);
  assert.equal(m(thread, { session: SESSION }), true);
  assert.equal(m(thread, { session: 'someone-else' }), false, 'and the session');
  assert.equal(m({ ...t('c1', 'Alpha', '', true), waits: [wait('c1.w1', 'question', { state: 'answered' })] }, {}), false, 'an answered item is not waiting');
});

test('the filter state is kept per project with the others, and the board is drawn again when it changes', () => {
  assert.match(html, /filterMemo\[selKey\] = \{[^}]*waiting: waitingOn\(\) \}/);
  assert.match(html, /elWaiting\.setAttribute\('aria-pressed', m\.waiting \? 'true' : 'false'\)/);
  assert.match(html, /waiting: \(waitingOn\(\) \|\| viewSel === 'waiting'\) && !isChat\(\)/, 'a chat-only board ignores it; the Waiting view is the filter always on');
  assert.match(html, /f\.milestone \+ '\|' \+ f\.waiting/, 'part of the key that decides a redraw');
  assert.match(html, /setWaitingOn\(false\);\n\s+renderBoard\(true\);/, 'Clear filters takes it off too');
});

// ----- the tag on a card

test('a card\'s tag has one small icon per kind, the most urgent first, and a count', () => {
  const { page } = waitsPage();
  const items = [wait('c1.w1', 'todo'), wait('c1.w2', 'question'), wait('c1.w3', 'review'), wait('c1.w4', 'question')];
  const tag = page.waitTag(items, 'card');
  assert.match(tag.className, /^tag wait-tag$/);
  assert.equal(tag.children[1].textContent, '4 waiting');
  const icons = tag.children[0].children;
  assert.deepEqual(icons.map((i) => i.dataset.wk), ['question', 'review', 'todo']);
  assert.deepEqual(icons.map((i) => i.className), ['shape s-wq', 'shape s-wr', 'shape s-wt']);
  assert.equal(tag.title, '2 questions, 1 review, 1 to-do waiting for you');
  assert.equal(page.waitTag([wait('c1.w1', 'choice')], 'card').title, '1 choice waiting for you');
  assert.equal(page.waitTag([], 'card'), null);
});

test('a milestone shows the total of its cards\' open items, as a count to look at', () => {
  const { page, state, setCards } = waitsPage();
  const ms = { ...task('c1'), kind: 'milestone' };
  setCards([ms, task('c2', { parent: 'c1', waits: [wait('c2.w1', 'question'), wait('c2.w2', 'todo', { state: 'answered' })] }), task('c3', { parent: 'c1', waits: [wait('c3.w1', 'review')] }), task('c4', { waits: [wait('c4.w1', 'todo')] })]);
  const items = page.cardWaits(ms);
  assert.deepEqual(plain(items).map((w) => w.id), ['c2.w1', 'c3.w1'], 'only its own cards, only open ones');
  const tag = page.waitTag(items, 'milestone');
  assert.equal(tag.children[1].textContent, '2 waiting');
  assert.equal(tag.title, '1 question, 1 review on this milestone’s cards');
  assert.equal(tag.listeners.click, undefined, 'a count to look at: it does nothing when clicked');
  assert.deepEqual(plain(page.cardWaits(state.current.cards[3])).map((w) => w.id), ['c4.w1']);
});

test('a card with no open item has no tag, and the tag is wired into the card and its label', () => {
  const { page, setCards } = waitsPage();
  setCards([task('c1', { waits: [wait('c1.w1', 'question', { state: 'answered' })] })]);
  assert.deepEqual(plain(page.cardWaits({ ...task('c1'), waits: undefined })), []);
  assert.match(html, /const wt = waitTag\(waits, 'card'\);\n\s+if \(wt\) foot\.appendChild\(wt\);/);
  assert.match(html, /waits\.length \+ ' waiting for you'/, 'the card\'s accessible name says it');
  // a milestone is not on the board; the Milestones view shows the tag with its cards' items
  assert.match(html, /const wt = waitTag\(milestoneWaits\(current\.cards, m\.id\), 'milestone'\);\n\s+if \(wt\) li\.appendChild\(wt\);/);
});

test('the waiting count of a project: the selected one from the page\'s own state, the others from the project list', () => {
  const { page, state, setCards } = waitsPage();
  state.projects = [{ key: 'k1', waiting: 9 }, { key: 'k2', waiting: 2 }];
  state.current = null;
  assert.equal(page.tabWaiting({ key: 'k2', waiting: 2 }), 2);
  assert.equal(page.tabWaiting({ key: 'k1', waiting: 9 }), 9, 'no state loaded yet: the project list');
  setCards([task('c1', { waits: [wait('c1.w1', 'todo')] })]);
  assert.equal(page.tabWaiting({ key: 'k1', waiting: 9 }), 1, 'the newer count from the loaded state');
  state.chat = true;
  assert.equal(page.tabWaiting({ key: 'k1', waiting: 9 }), 0);
});

function switcherPage() {
  const env = { selKey: 'k1', projects: [], current: null, parentName: (dir) => dir.split('/').slice(-2)[0], tabWaiting: (p) => p.waiting || 0, fillSelect() {}, elProjSelect: {}, projectByKey: () => null };
  const page = vm.runInNewContext(`${block('project switcher', 'project switcher')}\n({ switchOptions })`, vm.createContext(env));
  return { page, env };
}

test('the project switcher names the parent folder of two projects with one name, a missing folder and the items waiting', () => {
  const { page, env } = switcherPage();
  env.projects = [
    { key: 'k1', name: 'shop', projectDir: '/x/a/shop', exists: true, waiting: 3 },
    { key: 'k2', name: 'shop', projectDir: '/x/b/shop', exists: true, waiting: 0 },
    { key: 'k3', name: 'blog', projectDir: '/x/blog', exists: false, waiting: 1 },
  ];
  assert.deepEqual(plain(page.switchOptions()), [
    ['k1', 'shop (a) · 3 waiting'],
    ['k2', 'shop (b)'],
    ['k3', 'blog (folder missing) · 1 waiting'],
  ]);
  env.projects = [];
  assert.deepEqual(plain(page.switchOptions()), []);
});

// ----- the section on a card's page

function openSection(over = {}) {
  const t = waitsPage(over);
  const P = {};
  const ctl = t.page.attachWaits(P);
  t.doc.body.append(ctl.host);
  const show = (card) => { t.state.current = { cards: [card] }; ctl.update(card); };
  return { ...t, ctl, show, P };
}
const CARD = (waits, extra = {}) => task('c1', { waits, ...extra });
const row = (t, id) => t.ctl.host.querySelector(`li[data-wid="${id}"]`);
const sendBtn = (t) => t.env.elSendBtn;   // the bar's: an item has none
const draftOf = (li) => li.querySelector('.wait-draft');
const stored = (t) => JSON.parse(t.state.storage.data['thread-board-drafts:k1'] || 'null');
const type = (el, value) => { el.value = value; el.fire('input'); };
const pick = (el, checked = true) => { el.checked = checked; el.fire('change'); };
// the page sets type and name as properties; a real DOM reflects them as attributes, the fake does not
const inputs = (el, type) => el.querySelectorAll('input').filter((i) => i.type === type);
const options = (li) => li.querySelectorAll('input').filter((i) => i.name);

test('the section is hidden for a card with no items, and at the top shows one row per open item', () => {
  const t = openSection();
  t.show(CARD([]));
  assert.equal(t.ctl.host.hidden, true);
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  assert.equal(t.ctl.host.hidden, false);
  assert.equal(t.ctl.host.getAttribute('aria-label'), 'Waiting for you');
  assert.equal(t.ctl.host.querySelector('h3').textContent, 'Waiting for you2');
  assert.deepEqual(t.ctl.host.querySelectorAll('li[data-wid]').map((l) => l.dataset.wid), ['c1.w1', 'c1.w2']);
  const li = row(t, 'c1.w1');
  assert.equal(li.dataset.wk, 'question');
  assert.equal(li.querySelector('.pill').textContent, 'Question');
  assert.equal(li.querySelector('.pill').dataset.wk, 'question');
  assert.equal(li.querySelector('.pill .shape').className, 'shape s-wq');
  assert.equal(li.querySelector('.idchip').textContent, 'c1.w1');
  assert.equal(li.querySelector('.wait-text').textContent, 'Text of c1.w1');
  assert.match(li.querySelector('.wait-meta').textContent, /^asked by session aaaaaaaa · at 2026-10-14T03:00:00.000Z$/);
});

test('text from Claude is set as text, never as markup', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question', { text: '<img src=x onerror=alert(1)> **bold**' }), wait('c1.w2', 'choice', { choices: ['<b>x</b>', 'y'] })]));
  assert.equal(row(t, 'c1.w1').querySelector('.wait-text').textContent, '<img src=x onerror=alert(1)> **bold**');
  assert.equal(options(row(t, 'c1.w2'))[0].value, '<b>x</b>');
  assert.equal(t.ctl.host.querySelectorAll('img').length, 0);
  assert.equal(t.ctl.host.querySelectorAll('b').length, 0);
  assert.doesNotMatch(html.slice(html.indexOf('// ---- waiting for you'), html.indexOf('// ---- end waiting for you')), /innerHTML|insertAdjacentHTML/);
});

test('a question has a text box for the answer; typing makes a draft that is not sent, and the bar sends it', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  const ta = li.querySelector('textarea');
  assert.equal(ta.getAttribute('aria-label'), 'Your answer to c1.w1');
  assert.equal(inputs(li, 'text').length, 0, 'the answer is the text: no separate comment box');
  assert.equal(li.querySelectorAll('button').find((b) => b.textContent === 'Send'), undefined, 'the item has no Send button of its own');
  assert.equal(draftOf(li).hidden, true);
  assert.equal(t.env.elSendBar.hidden, true);
  type(ta, '   ');
  assert.equal(draftOf(li).hidden, true, 'blanks are no draft');
  assert.equal(t.env.elSendBar.hidden, true);
  type(ta, ' 5 ');
  assert.equal(draftOf(li).hidden, false);
  assert.equal(draftOf(li).querySelector('span').textContent, 'Draft, not sent');
  assert.equal(li.dataset.draft, '1');
  assert.equal(t.env.elSendBar.hidden, false);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
  assert.match(t.env.elSendText.textContent, /^1 answer is drafted and not sent yet\. Claude gets them together when you send\.$/);
  assert.equal(t.state.posts.length, 0, 'nothing was sent');
  assert.deepEqual(plain(stored(t)), { 'c1.w1': { text: ' 5 ', choices: [], done: false, verdict: '', comment: '' } }, 'and it is kept in the browser');
  t.state.answers = [{ applied: ['c1.w1'], skipped: [], cards: [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: '5' }, answeredVia: 'board' })])] }];
  sendBtn(t).click();
  await tick();
  assert.deepEqual(plain(t.state.posts), [['POST', '/api/p/k1/waits/answer-batch', { items: [{ id: 'c1.w1', text: '5' }] }]]);
  assert.equal(t.state.applied[0][1], 'k1');
  assert.equal(t.page.waitDrafts['k1/c1.w1'], undefined, 'the draft is gone once sent');
  assert.equal(stored(t), null, 'and so is the stored one');
  assert.equal(t.env.elSendBar.hidden, true, 'and the bar with the last draft');
});

test('a choice shows radio buttons for one pick and checkboxes for several, and only a valid pick is a draft', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'choice'), wait('c1.w2', 'choice', { multi: true })]));
  const one = row(t, 'c1.w1'), many = row(t, 'c1.w2');
  assert.deepEqual(options(one).map((i) => i.type), ['radio', 'radio', 'radio']);
  assert.deepEqual(options(many).map((i) => i.type), ['checkbox', 'checkbox', 'checkbox']);
  assert.equal(one.querySelector('legend').textContent, 'Pick one');
  assert.equal(many.querySelector('legend').textContent, 'Pick any that apply');
  assert.deepEqual(options(one).map((i) => i.value), ['a', 'b', 'c']);
  assert.equal(new Set(options(one).map((i) => i.name)).size, 1, 'one group');
  assert.equal(t.env.elSendBar.hidden, true);
  const o = options(one);
  pick(o[1]);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
  pick(o[2]);   // a radio button fires change only for the one picked; the earlier one is just unchecked by the browser
  assert.equal(sendBtn(t).textContent, 'Send 1 answer', 'picking another replaces the pick');
  assert.deepEqual(plain(t.page.waitDrafts['k1/c1.w1'].choices), ['c']);
  pick(o[1]);
  const m = options(many);
  pick(m[2]); pick(m[0]);
  assert.equal(sendBtn(t).textContent, 'Send 2 answers');
  pick(m[0], false); pick(m[2], false);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer', 'unticking all leaves no draft');
  assert.equal(draftOf(many).hidden, true);
  pick(m[1]); pick(m[2]);
  type(inputs(many, 'text')[0], ' fine ');
  t.state.answers = [{ applied: ['c1.w1', 'c1.w2'], skipped: [], cards: [CARD([wait('c1.w1', 'choice', { state: 'answered', answer: { choices: ['b'] } }), wait('c1.w2', 'choice', { multi: true, state: 'answered', answer: { choices: ['b', 'c'] } })])] }];
  sendBtn(t).click();
  await tick();
  assert.deepEqual(plain(t.state.posts), [['POST', '/api/p/k1/waits/answer-batch', { items: [{ id: 'c1.w1', choices: ['b'] }, { id: 'c1.w2', choices: ['b', 'c'], comment: 'fine' }] }]], 'one request for both');
});

test('a single choice needs exactly one option and a multiple choice at least one', () => {
  const { page } = waitsPage();
  const d = (choices) => ({ text: '', choices, done: false, verdict: '', comment: '' });
  assert.deepEqual([[], ['a'], ['a', 'b']].map((c) => page.waitReady(wait('x', 'choice'), d(c))), [false, true, false]);
  assert.deepEqual([[], ['a'], ['a', 'b']].map((c) => page.waitReady(wait('x', 'choice', { multi: true }), d(c))), [false, true, true]);
});

test('a to-do is ticked as done and a review is approved or sent back, each with an optional comment, and both go in one send', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'todo'), wait('c1.w2', 'review')]));
  const todo = row(t, 'c1.w1'), review = row(t, 'c1.w2');
  const box = inputs(todo, 'checkbox')[0];
  assert.match(todo.textContent, /Done: I did this/);
  assert.equal(t.env.elSendBar.hidden, true);
  pick(box);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
  pick(box, false);
  assert.equal(t.env.elSendBar.hidden, true);
  pick(box);
  assert.equal(inputs(todo, 'text')[0].getAttribute('aria-label'), 'Comment on c1.w1 (optional)');
  const radios = inputs(review, 'radio');
  assert.deepEqual(radios.map((r) => r.value), ['approve', 'changes']);
  assert.deepEqual(review.querySelectorAll('label').map((l) => l.textContent), ['Approve', 'Request changes']);
  type(inputs(review, 'text')[0], 'rename the helper');
  assert.equal(draftOf(review).hidden, false, 'a comment alone is something to keep or discard');
  assert.equal(draftOf(review).querySelector('span').textContent, 'Draft, not complete');
  assert.equal(sendBtn(t).textContent, 'Send 1 answer', 'but it is not sent without a verdict');
  pick(radios[1]);
  assert.equal(draftOf(review).querySelector('span').textContent, 'Draft, not sent');
  assert.equal(sendBtn(t).textContent, 'Send 2 answers');
  t.state.answers = [{ applied: ['c1.w1', 'c1.w2'], skipped: [], cards: [CARD([wait('c1.w1', 'todo', { state: 'answered' }), wait('c1.w2', 'review', { state: 'answered' })])] }];
  sendBtn(t).click();
  await tick();
  assert.deepEqual(plain(t.state.posts), [['POST', '/api/p/k1/waits/answer-batch', { items: [{ id: 'c1.w1', done: true }, { id: 'c1.w2', verdict: 'changes', comment: 'rename the helper' }] }]]);
});

test('Ctrl or Cmd + Enter sends the drafts like the bar does, a plain Enter does not, and the card form\'s own shortcut is not triggered', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  const ta = li.querySelector('textarea');
  t.state.answers = [{ applied: ['c1.w1'], skipped: [], cards: [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } })])] }];
  const key = (extra) => { const stops = []; const e = ta.fire('keydown', { key: 'Enter', stopPropagation() { stops.push(1); }, ...extra }); li.fire('keydown', { key: 'Enter', target: ta, stopPropagation() { stops.push(1); }, ...extra }); return { e, stops }; };
  type(ta, '');
  key({ ctrlKey: true });
  await tick();
  assert.equal(t.state.posts.length, 0, 'no draft, nothing to send');
  type(ta, 'x');
  const plainKey = key({});
  await tick();
  assert.equal(t.state.posts.length, 0, 'a plain Enter is a new line');
  assert.equal(plainKey.stops.length, 0);
  const ctrl = key({ metaKey: true });
  await tick();
  assert.equal(t.state.posts.length, 1);
  assert.equal(ctrl.stops.length > 0, true, 'the event stops here, so the form around it does not save');
  assert.deepEqual(plain(t.state.posts[0][2]), { items: [{ id: 'c1.w1', text: 'x' }] });
  type(ta, 'again');
  const composing = key({ ctrlKey: true, isComposing: true });
  await tick();
  assert.equal(t.state.posts.length, 1, 'text being composed is left alone');
  assert.ok(composing);
});

test('a failed send keeps every draft, here and in the browser, and shows the server\'s message', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'my long answer');
  pick(inputs(row(t, 'c1.w2'), 'checkbox')[0]);
  t.state.answers = [new Error('nothing was sent: c1.w1: the answer is too long')];
  sendBtn(t).click();
  await tick();
  assert.deepEqual(t.state.errors, ['nothing was sent: c1.w1: the answer is too long']);
  assert.equal(t.page.waitDrafts['k1/c1.w1'].text, 'my long answer');
  assert.equal(t.page.waitDrafts['k1/c1.w2'].done, true);
  assert.equal(Object.keys(stored(t)).length, 2);
  assert.equal(t.state.applied.length, 0);
  assert.equal(sendBtn(t).textContent, 'Send 2 answers');
});

test('the page sends in requests of at most MAX_BATCH answers, one after another; a request that fails keeps its drafts and says which it was', async () => {
  assert.match(html, new RegExp(`const WAIT_BATCH_MAX = ${MAX_BATCH};`), 'the page and the server agree on the size');
  const t = openSection();
  const waits = Array.from({ length: 51 }, (_, i) => wait(`c1.w${i + 1}`, 'todo'));
  t.show(CARD(waits));
  waits.forEach((w) => pick(inputs(row(t, w.id), 'checkbox')[0]));
  assert.equal(sendBtn(t).textContent, 'Send 51 answers');
  t.state.answers = [
    { applied: waits.slice(0, 50).map((w) => w.id), skipped: [], cards: [CARD(waits.map((w, i) => (i < 50 ? { ...w, state: 'answered' } : w)))] },
    new Error('nothing was sent: c1.w51: something'),
  ];
  sendBtn(t).click();
  await tick();
  await tick();
  assert.deepEqual(t.state.posts.map((p) => p[2].items.length), [50, 1], 'two requests, the second after the first');
  assert.equal(t.state.posts[1][2].items[0].id, 'c1.w51');
  assert.equal(t.state.errors.length, 1);
  assert.equal(t.state.errors[0], 'Part 2 of 2 was not sent (c1.w51): nothing was sent: c1.w51: something 50 answers were sent before it; the drafts of this part and of the rest are kept.');
  assert.deepEqual(Object.keys(stored(t)), ['c1.w51'], 'the first request\'s drafts are gone, the failed one\'s are kept');
  assert.equal(t.page.waitDrafts['k1/c1.w51'].done, true);
  // exactly 50 is one request
  const u = openSection();
  const fifty = waits.slice(0, 50);
  u.show(CARD(fifty));
  fifty.forEach((w) => pick(inputs(row(u, w.id), 'checkbox')[0]));
  u.state.answers = [{ applied: fifty.map((w) => w.id), skipped: [], cards: [CARD(fifty.map((w) => ({ ...w, state: 'answered' })))] }];
  sendBtn(u).click();
  await tick();
  assert.equal(u.state.posts.length, 1);
  assert.deepEqual(u.state.errors, []);
});

test('a draft typed into while its request is in flight is kept, and the user is told what Claude received', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'question')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'first version');
  type(row(t, 'c1.w2').querySelector('textarea'), 'second');
  let release;
  t.state.answers = [new Promise((resolve) => { release = () => resolve({ applied: ['c1.w1', 'c1.w2'], skipped: [], cards: [] }); })];
  sendBtn(t).click();
  await tick();
  type(row(t, 'c1.w1').querySelector('textarea'), 'first version, then more');   // the request is out
  release();
  await tick();
  assert.deepEqual(plain(t.state.posts[0][2].items), [{ id: 'c1.w1', text: 'first version' }, { id: 'c1.w2', text: 'second' }]);
  assert.equal(t.page.waitDrafts['k1/c1.w1'].text, 'first version, then more', 'the newer text is not thrown away');
  assert.equal(t.page.waitDrafts['k1/c1.w2'], undefined, 'the one that did not change is gone');
  assert.deepEqual(Object.keys(stored(t)), ['c1.w1']);
  assert.deepEqual(t.state.errors, ['c1.w1 was changed while it was being sent; Claude got the version that was sent.']);
  // a draft emptied while in flight is no draft: nothing to keep
  const u = openSection();
  u.show(CARD([wait('c1.w1', 'question')]));
  type(row(u, 'c1.w1').querySelector('textarea'), 'x');
  u.state.answers = [new Promise((resolve) => { release = () => resolve({ applied: ['c1.w1'], skipped: [], cards: [] }); })];
  sendBtn(u).click();
  await tick();
  type(row(u, 'c1.w1').querySelector('textarea'), '');
  release();
  await tick();
  assert.deepEqual(u.state.errors, []);
  assert.equal(stored(u), null);
});

test('the later request of a batch is built from the drafts as they are by then', async () => {
  const t = openSection();
  const waits = Array.from({ length: 51 }, (_, i) => wait(`c1.w${i + 1}`, 'question'));
  t.show(CARD(waits));
  waits.forEach((w) => type(row(t, w.id).querySelector('textarea'), 'v1'));
  let release;
  t.state.answers = [new Promise((resolve) => { release = () => resolve({ applied: [], skipped: [], cards: [] }); }), { applied: [], skipped: [], cards: [] }];
  sendBtn(t).click();
  await tick();
  type(row(t, 'c1.w51').querySelector('textarea'), 'v2');   // the first request is in flight
  release();
  await tick();
  await tick();
  assert.deepEqual(plain(t.state.posts[1][2].items), [{ id: 'c1.w51', text: 'v2' }]);
});

test('two tabs share the drafts: a save keeps what the other tab stored, and the storage event brings its changes in', () => {
  const shared = { data: {}, broken: false };
  const a = openSection({ storage: shared });
  const b = openSection({ storage: shared });
  const waits = [wait('c1.w1', 'question'), wait('c1.w2', 'question'), wait('c1.w3', 'todo')];
  a.show(CARD(waits));
  b.show(CARD(waits));
  a.state.panel = a.P;   // the card page that is open in tab A
  const fire = (t) => (t.state.listeners.storage || []).forEach((fn) => fn({ key: 'thread-board-drafts:k1' }));
  type(row(a, 'c1.w1').querySelector('textarea'), 'from tab A');
  type(row(b, 'c1.w2').querySelector('textarea'), 'from tab B');   // B never saw A's draft
  assert.deepEqual(Object.keys(stored(a)).sort(), ['c1.w1', 'c1.w2'], 'B\'s save did not overwrite A\'s draft');
  assert.equal(stored(a)['c1.w1'].text, 'from tab A');
  // A is told, and shows B's draft; its own is untouched
  fire(a);
  assert.equal(a.page.waitDrafts['k1/c1.w2'].text, 'from tab B');
  assert.equal(row(a, 'c1.w2').querySelector('textarea').value, 'from tab B', 'the open section is drawn again with it');
  assert.equal(sendBtn(a).textContent, 'Send 2 answers');
  assert.equal(a.page.waitDrafts['k1/c1.w1'].text, 'from tab A');
  // a draft A is typing into and has not saved... is saved at once, so the other tab's later save cannot take it
  type(row(a, 'c1.w1').querySelector('textarea'), 'from tab A, longer');
  type(row(b, 'c1.w3').querySelectorAll('input')[0], '');
  pick(inputs(row(b, 'c1.w3'), 'checkbox')[0]);
  assert.equal(stored(a)['c1.w1'].text, 'from tab A, longer', 'B saved without losing A\'s newer text');
  assert.equal(stored(a)['c1.w3'].done, true);
  // B discards its own: the storage drops only that one, and A follows
  const discard = row(b, 'c1.w2').querySelectorAll('button').find((x) => x.textContent === 'Discard');
  discard.click();
  assert.deepEqual(Object.keys(stored(a)).sort(), ['c1.w1', 'c1.w3']);
  fire(a);
  assert.ok(a.page.draftEmpty(a.page.waitDrafts['k1/c1.w2']), 'nothing is left of it');
  assert.equal(row(a, 'c1.w2').querySelector('textarea').value, '');
  assert.equal(a.page.waitDrafts['k1/c1.w3'].done, true);
  assert.equal(sendBtn(a).textContent, 'Send 2 answers');
  // an event for another key, or an unreadable storage, changes nothing
  (a.state.listeners.storage || []).forEach((fn) => fn({ key: 'something-else' }));
  shared.broken = true;
  fire(a);
  assert.equal(a.page.waitDrafts['k1/c1.w1'].text, 'from tab A, longer');
});

test('with the bar\'s text hidden on a narrow window, the button says what it sends and its hover text names the cards', () => {
  const t = openSection();
  t.state.current = { cards: [task('c1', { waits: [wait('c1.w1', 'question'), wait('c1.w2', 'todo')] }), task('c4', { waits: [wait('c4.w1', 'todo')] })] };
  t.ctl.update(t.state.current.cards[0]);
  type(row(t, 'c1.w1').querySelector('textarea'), 'x');
  pick(inputs(row(t, 'c1.w2'), 'checkbox')[0]);
  t.page.updateSendBar();
  assert.equal(sendBtn(t).textContent, 'Send 2 answers');
  assert.equal(sendBtn(t).title, 'Send them all to Claude in one go (card c1). Ctrl or Cmd + Enter in an answer does the same.');
  t.page.waitDrafts['k1/c4.w1'] = { text: '', choices: [], done: true, verdict: '', comment: '' };
  t.page.updateSendBar();
  assert.equal(sendBtn(t).textContent, 'Send 3 answers');
  assert.match(sendBtn(t).title, /\(cards c1, c4\)/);
});

test('answers given elsewhere meanwhile are reported by the server: their drafts go, the others are sent, and the page says so', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'mine');
  pick(inputs(row(t, 'c1.w2'), 'checkbox')[0]);
  t.state.answers = [{ applied: ['c1.w2'], skipped: [{ id: 'c1.w1', reason: 'answered' }], cards: [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'theirs' } }), wait('c1.w2', 'todo', { state: 'answered' })])] }];
  sendBtn(t).click();
  await tick();
  assert.equal(t.state.errors.length, 1);
  assert.match(t.state.errors[0], /^c1\.w1 was answered or withdrawn elsewhere already, so its draft was dropped\. The others were sent\.$/);
  assert.deepEqual(Object.keys(t.page.waitDrafts).filter((k) => k.startsWith('k1/')), []);
  assert.equal(stored(t), null);
});

test('the drafts are kept in the browser per project: a reload shows them again, and storage that fails or holds rubbish costs nothing', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'half an answer');
  pick(options(row(t, 'c1.w2'))[2]);
  pick(inputs(row(t, 'c1.w3'), 'radio')[1]);
  type(inputs(row(t, 'c1.w3'), 'text')[0], 'a comment');
  assert.deepEqual(Object.keys(t.state.storage.data), ['thread-board-drafts:k1'], 'one entry per project');
  // a new page (a reload) on the same storage
  const again = openSection({ storage: t.state.storage });
  again.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review')]));
  again.page.updateSendBar();   // the page does it with every state it draws
  assert.equal(row(again, 'c1.w1').querySelector('textarea').value, 'half an answer');
  assert.deepEqual(options(row(again, 'c1.w2')).map((i) => i.checked), [false, false, true]);
  assert.deepEqual(inputs(row(again, 'c1.w3'), 'radio').map((i) => i.checked), [false, true]);
  assert.equal(inputs(row(again, 'c1.w3'), 'text')[0].value, 'a comment');
  assert.equal(sendBtn(again).textContent, 'Send 3 answers');
  // another project's drafts are not this one's
  again.state.storage.data['thread-board-drafts:k2'] = JSON.stringify({ 'c1.w1': { text: 'elsewhere' } });
  assert.equal(again.page.readyDrafts('k1').length, 3);
  // storage that throws: the page still works, from memory
  const broken = openSection({ storage: { data: {}, broken: true } });
  broken.show(CARD([wait('c1.w1', 'question')]));
  type(row(broken, 'c1.w1').querySelector('textarea'), 'typed');
  assert.equal(sendBtn(broken).textContent, 'Send 1 answer');
  // rubbish is ignored, and a draft is cut to what the server accepts
  const junk = openSection({ storage: { data: { 'thread-board-drafts:k1': '{ half' }, broken: false } });
  junk.show(CARD([wait('c1.w1', 'question')]));
  assert.equal(junk.env.elSendBar.hidden, true);
  const odd = openSection({ storage: { data: { 'thread-board-drafts:k1': JSON.stringify({ 'c1.w1': { text: 5, choices: 'x', verdict: 'maybe', done: 'yes', comment: {} }, 'x<img>': { text: 'a' }, 'c1.w2': { text: 'y'.repeat(9000) }, 'c1.w3': null }) }, broken: false } });
  odd.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'question')]));
  assert.equal(odd.page.waitDrafts['k1/c1.w1'].text, '');
  assert.equal(odd.page.waitDrafts['k1/c1.w2'].text.length, 4000);
  assert.equal(odd.page.waitDrafts['k1/x<img>'], undefined);
  const src = html.slice(html.indexOf('// ---- waiting for you'), html.indexOf('// ---- end waiting for you'));
  for (const call of ['localStorage.getItem', 'localStorage.setItem', 'localStorage.removeItem']) {
    const i = src.indexOf(call);
    assert.ok(i > 0, call);
    assert.match(src.slice(Math.max(0, i - 200), i), /try \{/, `${call} is inside a try`);
  }
});

test('Discard empties the draft of an item: its controls, the stored copy and the bar', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'draft');
  pick(inputs(row(t, 'c1.w2'), 'checkbox')[0]);
  assert.equal(sendBtn(t).textContent, 'Send 2 answers');
  const discard = draftOf(row(t, 'c1.w1')).querySelectorAll('button').find((b) => b.textContent === 'Discard');
  assert.equal(discard.getAttribute('aria-label'), 'Discard the draft answer to c1.w1');
  discard.click();
  assert.equal(row(t, 'c1.w1').querySelector('textarea').value, '');
  assert.equal(draftOf(row(t, 'c1.w1')).hidden, true);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
  assert.deepEqual(Object.keys(stored(t)), ['c1.w2']);
  assert.equal(inputs(row(t, 'c1.w2'), 'checkbox')[0].checked, true, 'the other draft stays');
  draftOf(row(t, 'c1.w2')).querySelectorAll('button')[0].click();
  assert.equal(t.env.elSendBar.hidden, true);
  assert.equal(stored(t), null);
  assert.equal(t.state.posts.length, 0, 'a discard sends nothing');
});

// ----- the bar

test('the bar counts the complete drafts of the whole project, in every view, and is gone for chat-only, read-only, the home and a halted page', () => {
  const t = openSection();
  const cards = [CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]), task('c2', { waits: [wait('c2.w1', 'todo')] }), { ...task('c3'), kind: 'milestone' }];
  t.state.current = { cards };
  t.page.loadDrafts('k1');
  t.page.waitDrafts['k1/c1.w1'] = { text: 'a', choices: [], done: false, verdict: '', comment: '' };
  t.page.waitDrafts['k1/c2.w1'] = { text: '', choices: [], done: true, verdict: '', comment: '' };
  t.page.waitDrafts['k1/c1.w2'] = { text: '', choices: [], done: false, verdict: '', comment: 'only a comment' };
  t.page.saveDrafts('k1', ['c1.w1', 'c1.w2', 'c2.w1']);
  for (const v of ['summary', 'board', 'list', 'milestones', 'waiting']) {
    t.state.view = v;
    t.page.updateSendBar();
    assert.equal(sendBtn(t).textContent, 'Send 2 answers', v);
    assert.equal(t.env.elSendBar.hidden, false, v);
  }
  t.state.chat = true; t.page.updateSendBar(); assert.equal(t.env.elSendBar.hidden, true, 'chat-only');
  t.state.chat = false; t.state.ro = true; t.page.updateSendBar(); assert.equal(t.env.elSendBar.hidden, true, 'read-only');
  t.state.ro = false; t.state.home = true; t.page.updateSendBar(); assert.equal(t.env.elSendBar.hidden, true, 'the projects home');
  t.state.home = false; t.state.halted = true; t.page.updateSendBar(); assert.equal(t.env.elSendBar.hidden, true, 'the access-link page');
  t.state.halted = false; t.page.updateSendBar(); assert.equal(t.env.elSendBar.hidden, false);
  // an item answered elsewhere drops its draft the next time the state arrives
  t.state.current = { cards: [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } }), wait('c1.w2', 'todo')]), cards[1]] };
  t.page.updateSendBar();
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
  assert.equal(t.page.waitDrafts['k1/c1.w1'], undefined);
  assert.deepEqual(Object.keys(stored(t)).sort(), ['c1.w2', 'c2.w1'].sort(), 'and the stored copy follows');
  // a card that is gone takes its drafts with it
  t.state.current = { cards: [cards[1]] };
  t.page.updateSendBar();
  assert.equal(t.page.waitDrafts['k1/c1.w2'], undefined);
  assert.equal(sendBtn(t).textContent, 'Send 1 answer');
});

test('the bar is part of the page: outside the app that a card page makes inert, with its own region label, after the overlay, and kept out of the focus trap\'s way', () => {
  const page = html.slice(html.indexOf('<div class="overlay"'), html.indexOf('<script>\n(function'));
  assert.match(page, /<div class="send-bar" id="send-bar" role="region" aria-label="Answers to send" hidden>\s*<span class="send-text" id="send-text"><\/span>\s*<button type="button" class="btn primary" id="send-btn"><\/button>/);
  assert.ok(html.indexOf('id="send-bar"') > html.indexOf('<div id="app">') && html.indexOf('id="send-bar"') > html.indexOf('</div>\n\n<div class="gate"'), 'a sibling of #app, not inside it');
  assert.match(html, /if \(!elSendBar\.hidden\) list\.push\(elSendBtn\);/, 'a card page traps Tab but the bar stays reachable');
  assert.match(html, /a === elSendBtn;/);
  assert.match(html, /html:has\(\.send-bar:not\(\[hidden\]\)\) #app \{ height: calc\(100vh - var\(--send-h\)\);/, 'the views end above the bar');
  assert.match(html, /html:has\(\.send-bar:not\(\[hidden\]\)\) \.overlay \{ bottom: var\(--send-h\); \}/, 'and so does a card page');
  assert.match(html, /updateWaitingPill\(\);\n\s+updateSendBar\(\);/, 'redrawn with the toolbar, on every state and every project change');
  assert.match(html, /elBanner\.hidden = true;\n\s+elSendBar\.hidden = true;/, 'and gone with the access-link page');
});

test('an answered item collapses to a muted line with a tick, the answer and whether it was delivered', () => {
  const t = openSection();
  const base = { state: 'answered', answeredVia: 'board', answeredAt: '2026-10-14T03:05:00.000Z' };
  t.state.sessions = { [SESSION]: { label: 'Fix tax · aaaaaaaa', lastSeenAt: '2026-10-14T01:00:00.000Z' } };
  t.show(CARD([
    wait('c1.w1', 'question', { ...base, answer: { text: 'Five' } }),
    wait('c1.w2', 'choice', { ...base, answer: { choices: ['a', 'c'] }, comment: 'both', deliveredAt: '2026-10-14T03:06:00.000Z' }),
    wait('c1.w3', 'todo', { ...base, answer: { done: true } }),
    wait('c1.w4', 'review', { ...base, answer: { verdict: 'approve' } }),
    wait('c1.w5', 'review', { state: 'withdrawn' }),
    wait('c1.w6', 'question', { state: 'answered', answeredVia: 'chat', answer: { text: 'said in the chat' }, deliveredAt: 'x' }),
    wait('c1.w7', 'question'),
  ]));
  assert.equal(t.ctl.host.querySelectorAll('li[data-wid]').length, 7);
  assert.equal(row(t, 'c1.w7').className, 'wait-item', 'the open item keeps its controls');
  const line = (id) => row(t, id);
  assert.equal(line('c1.w1').className, 'wait-line');
  assert.equal(line('c1.w1').querySelector('.shape').className, 'shape s-check', 'a tick');
  assert.equal(line('c1.w1').querySelector('textarea'), null, 'no controls left');
  assert.match(line('c1.w1').textContent, /^c1\.w1 Text of c1\.w1Your answer: Five · not yet delivered: it reaches the session that asked with its next message \(last active at 2026-10-14T01:00:00.000Z\)\. If that session was cleared or closed, any session can read it with wait_list \(ask “what did I answer on c1\.w1\?”\)\./);
  assert.match(line('c1.w2').textContent, /Your answer: a, c — both · delivered/);
  assert.doesNotMatch(line('c1.w2').textContent, /not yet/);
  assert.match(line('c1.w3').textContent, /Your answer: Done · not yet delivered/);
  assert.match(line('c1.w4').textContent, /Your answer: Approved ·/);
  assert.match(line('c1.w5').textContent, /Withdrawn: Claude no longer needs it\./);
  assert.equal(line('c1.w5').querySelector('.shape').className, 'shape s-cross');
  assert.match(line('c1.w6').textContent, /Answered in the chat: said in the chat/);
  assert.doesNotMatch(line('c1.w6').textContent, /delivered/, 'an answer given in the chat needs no delivery');
  assert.equal(t.ctl.host.querySelector('h3').textContent, 'Waiting for you1', 'the count is of open ones');
});

test('an answer that only the repo file has is marked as such, as text, delivered or not', () => {
  const t = openSection();
  const base = { state: 'answered', answeredVia: 'board', answeredAt: '2026-10-14T03:05:00.000Z', answer: { text: '<img src=x onerror=alert(1)> drop it' } };
  t.show(CARD([
    wait('c1.w1', 'question', { ...base, fromFile: true, deliveredAt: '2026-10-14T03:06:00.000Z' }),
    wait('c1.w2', 'question', { ...base, fromFile: true }),
    wait('c1.w3', 'question', { ...base, answer: { text: 'given here' } }),
  ]));
  const line = (id) => row(t, id);
  assert.match(line('c1.w1').textContent, /Answered on another device \(from the repo file\): <img src=x onerror=alert\(1\)> drop it · delivered/);
  assert.match(line('c1.w2').textContent, /^c1\.w2 .*Answered on another device \(from the repo file\): .* · not yet delivered/);
  assert.equal(line('c1.w1').querySelector('img'), null, 'the words are text, never markup');
  assert.match(line('c1.w3').textContent, /Your answer: given here/);
  assert.doesNotMatch(line('c1.w3').textContent, /another device/);
});

test('a session that is not known is still named in "not yet delivered"', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'todo', { state: 'answered', answer: { done: true }, askedBy: '' })]));
  assert.match(row(t, 'c1.w1').textContent, /not yet delivered: it reaches the session that asked with its next message\. If that session was cleared or closed, any session can read it with wait_list/);
  assert.doesNotMatch(row(t, 'c1.w1').textContent, /last active/);
});

test('every item, open or closed, has a button that copies its id with the page\'s own copy helper', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo', { state: 'answered', answer: { done: true } }), wait('c1.w3', 'review', { state: 'withdrawn' })]));
  for (const id of ['c1.w1', 'c1.w2', 'c1.w3']) {
    const b = row(t, id).querySelectorAll('button').find((x) => x.textContent === 'Copy id');
    assert.ok(b, `${id} has a copy button`);
    assert.equal(b.copies, id, 'it copies the id and nothing else');
    assert.equal(b.getAttribute('aria-label'), `Copy id ${id}`);
    b.click();
  }
  assert.deepEqual(t.state.copies, ['c1.w1', 'c1.w2', 'c1.w3']);
  const src = html.slice(html.indexOf('function waitIdButton'), html.indexOf('// A closed item: a muted line'));
  assert.match(src, /copyBtn\(w\.id,/, 'the helper that has the clipboard fallback');
});

test('the newest closed items show as lines, and the older ones sit in a fold', () => {
  const t = openSection();
  const closed = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => wait(`c1.w${n}`, 'todo', { state: 'answered', answer: { done: true } }));
  t.show(CARD(closed));
  const direct = t.ctl.host.children.filter((c) => c.className === 'wait-list').flatMap((u) => u.querySelectorAll('li').map((l) => l.dataset.wid));
  assert.equal(direct.length, 5, 'five are shown as lines');
  const det = t.ctl.host.querySelector('details');
  assert.equal(det.querySelector('summary').textContent, 'Earlier items (3)');
  assert.deepEqual(det.querySelectorAll('li').map((l) => l.dataset.wid), ['c1.w3', 'c1.w2', 'c1.w1']);
  assert.match(t.ctl.host.textContent, /Nothing is waiting for you on this card\./);
});

test('what was typed survives a redraw of the section, and focus returns to the same control', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review')]));
  type(row(t, 'c1.w1').querySelector('textarea'), 'half an ans');
  pick(options(row(t, 'c1.w2'))[2]);
  pick(inputs(row(t, 'c1.w3'), 'radio')[0]);
  type(inputs(row(t, 'c1.w3'), 'text')[0], 'a comment');
  const ta = row(t, 'c1.w1').querySelector('textarea');
  ta.focus();
  // another item arrives: the section is drawn again
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review'), wait('c1.w4', 'todo')]));
  const fresh = row(t, 'c1.w1').querySelector('textarea');
  assert.notEqual(fresh, ta, 'it was drawn again');
  assert.equal(fresh.value, 'half an ans');
  assert.equal(t.doc.activeElement, fresh, 'focus stays');
  assert.deepEqual(options(row(t, 'c1.w2')).map((i) => i.checked), [false, false, true]);
  assert.deepEqual(inputs(row(t, 'c1.w3'), 'radio').map((i) => i.checked), [true, false]);
  assert.equal(inputs(row(t, 'c1.w3'), 'text')[0].value, 'a comment');
  assert.equal(sendBtn(t).textContent, 'Send 3 answers', 'and the bar follows the drafts');
  // nothing changed: nothing is drawn
  t.ctl.update(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review'), wait('c1.w4', 'todo')]));
  assert.equal(row(t, 'c1.w1').querySelector('textarea'), fresh);
  // an item that is no longer open drops its draft
  t.show(CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } })]));
  assert.equal(t.page.waitDrafts['k1/c1.w1'], undefined);
});

test('a drafted choice that is no longer an option is dropped', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'choice')]));
  pick(options(row(t, 'c1.w1'))[0]);
  t.page.waitDrafts['k1/c1.w1'].choices.push('gone');
  t.show(CARD([wait('c1.w1', 'choice', { text: 'edited' })]));
  assert.deepEqual(plain(t.page.waitDrafts['k1/c1.w1'].choices), ['a']);
});

test('a read-only board disables every control and says why; a chat-only one shows nothing', () => {
  const t = openSection();
  t.state.ro = true;
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review')]));
  const controls = t.ctl.host.querySelectorAll('textarea').concat(t.ctl.host.querySelectorAll('input'));
  assert.ok(controls.length >= 6);
  controls.forEach((c) => assert.equal(c.disabled, true));
  assert.equal(t.env.elSendBar.hidden, true);
  assert.match(t.ctl.host.textContent, /read-only/);
  t.state.ro = false;
  t.state.chat = true;
  t.ctl.update(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'choice'), wait('c1.w3', 'review')]));
  assert.equal(t.ctl.host.hidden, true);
  assert.equal(t.ctl.host.children.length, 0);
});

test('an answer is not sent from a read-only board even by the key', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  type(li.querySelector('textarea'), 'x');
  t.state.ro = true;
  li.fire('keydown', { key: 'Enter', ctrlKey: true });
  await tick();
  assert.equal(t.state.posts.length, 0);
  await t.page.sendDrafts();
  assert.equal(t.state.posts.length, 0, 'nor by calling it');
});

test('"Answer waiting items" scrolls the section into view and focuses the first open control', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'todo', { state: 'answered', answer: { done: true } }), wait('c1.w2', 'choice'), wait('c1.w3', 'question')]));
  t.ctl.focus();
  assert.equal(t.ctl.host.scrolledIntoView, 1);
  assert.equal(t.doc.activeElement.type, 'radio', 'the first control of the first open item');
  assert.equal(t.doc.activeElement.dataset.fid, 'w-opt-c1.w2-0');
  assert.equal(t.doc.activeElement.name, 'wait-c1.w2');
  const empty = openSection();
  empty.show(CARD([wait('c1.w1', 'todo', { state: 'answered', answer: { done: true } })]));
  empty.ctl.focus();
  assert.equal(empty.doc.activeElement.textContent, 'Copy id', 'with nothing open it lands on the first button');
});

test('the task page and the thread page both carry the section, outside the pane that is redrawn', () => {
  assert.match(html, /const W = !create && !isMs \? attachWaits\(P\) : null;\n\s+body\.append\(\.\.\.\(W \? \[W\.host\] : \[\]\), warnSlot, roNote, conflict\);/, 'at the top of a task or idea page');
  assert.match(html, /P\.update = \(c\) => \{\n\s+P\.latestUpdatedAt = c\.updatedAt;\n\s+if \(W\) W\.update\(c\);/);
  assert.match(html, /const W = attachWaits\(P\);[^\n]*\n\s+P\.focusWaits = \(\) => \{ S\.reveal\(\); W\.focus\(\); \};/);
  assert.match(html, /rebuild\('about', \(\) => \{\n\s+const out = \[W\.host\];/, 'first in the thread page\'s left pane, as the same element each time');
  assert.match(html, /\n\s+W\.update\(c\);\n\s+if \(k\.head !== P\.keys\.head\)/);
  assert.match(html, /if \(atWaits && panel\.focusWaits\) panel\.focusWaits\(\);/);
});

// ----- the gear menu entry and the key

function actionsOf() {
  return vm.runInNewContext(`${block('gear menu actions', 'gear menu actions')}; cardActions`);
}
const thr = (extra = {}) => ({ id: 'c7', kind: 'thread', title: 'T', note: '', status: 'x', thread: { runState: 'idle', lastResult: null }, ...extra });
const ctx = (o = {}) => ({ ro: false, stages: [{ id: 'new', label: 'New' }, { id: 'done', label: 'Done' }], choices: [], reportState: () => '', waits: (c) => (c.waits || []).filter((w) => w.state === 'open').length, ...o });

test('the gear menu offers "Answer waiting items (N)" first on a task, idea or thread with open items', () => {
  const cardActions = actionsOf();
  const two = [wait('c1.w1', 'todo'), wait('c1.w2', 'question'), wait('c1.w3', 'todo', { state: 'answered' })];
  const a = plain(cardActions(task('c1', { waits: two }), ctx()));
  assert.deepEqual(a[0], { id: 'waits', label: 'Answer waiting items (2)' });
  assert.deepEqual(a[1], { sep: true });
  assert.equal(a[2].group, 'Move to');
  assert.equal(plain(cardActions(task('c1', { kind: 'idea', waits: two }), ctx()))[0].id, 'waits');
  const t = plain(cardActions(thr({ waits: two }), ctx()));
  assert.equal(t[0].label, 'Answer waiting items (2)');
  assert.equal(t[2].id, 'end');
  assert.equal(plain(cardActions(task('c1', { waits: [wait('c1.w1', 'todo', { state: 'answered' })] }), ctx())).some((x) => x.id === 'waits'), false, 'nothing open: no entry');
  assert.equal(plain(cardActions(task('c1'), ctx())).some((x) => x.id === 'waits'), false);
  assert.deepEqual(plain(cardActions(task('c1', { waits: two }), ctx({ ro: true }))), [], 'a read-only board offers nothing that writes');
  const ms = plain(cardActions({ id: 'c3', kind: 'milestone', title: 'M', waits: two }, ctx()));
  assert.equal(ms.some((x) => x.id === 'waits'), false, 'a milestone has none of its own');
  assert.equal(plain(cardActions(task('c1', { waits: two }), { ...ctx(), waits: undefined })).some((x) => x.id === 'waits'), false, 'a context that does not count adds nothing');
});

test('choosing the entry closes the menu and opens the card page at its section; a chat-only board counts none', () => {
  const src = block('gear menu \\(page\\.test', 'gear menu');
  const m = /if \(a\.id === 'waits'\) \{\n([\s\S]*?)\n    \}/.exec(src);
  assert.ok(m, 'menuDo handles it');
  assert.match(m[1], /closeMenu\(false\);\n\s+waitsFor = id;/);
  assert.match(m[1], /setTimeout\(\(\) => \{ if \(waitsFor === id\) waitsFor = ''; \}, 1500\);/, 'the request does not outlive the page opening');
  assert.match(m[1], /openCard\(id, true\);/);
  assert.match(src, /waits: \(c\) => \(isChat\(\) \? 0 : openWaitsOf\(c\)\.length\)/);
});

function keyPage(over = {}) {
  const calls = [];
  const state = { menu: null, panel: null, halted: false, typing: false };
  const env = {
    get menu() { return state.menu; }, get panel() { return state.panel; }, get halted() { return state.halted; },
    isTyping: () => state.typing, requestClose: () => calls.push('close'), trapList: () => [], elBanner: { hidden: true }, $: () => ({}),
    elSearch: { focus: () => calls.push('search'), select() {} }, openNew: () => calls.push('new'), toggleWaiting: () => calls.push('waiting'),
    document: { activeElement: null, addEventListener() {} },
    ...over,
  };
  const page = vm.runInNewContext(`${block('global keys', 'global keys')}; onGlobalKey`, vm.createContext(env));
  const press = (key, extra = {}) => { const e = { key, target: {}, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...extra }; page(e); return e; };
  return { press, calls, state };
}

test('the w key toggles the filter like n and / do their jobs, and stays out of typing fields, modified keys and open pages', () => {
  const k = keyPage();
  assert.equal(k.press('w').defaultPrevented, true);
  k.press('W');
  assert.deepEqual(k.calls, ['waiting', 'waiting']);
  k.press('n'); k.press('/');
  assert.deepEqual(k.calls.slice(2), ['new', 'search'], 'the other keys still work');
  k.calls.length = 0;
  k.state.typing = true;
  k.press('w');
  assert.deepEqual(k.calls, [], 'typing a w in a field');
  k.state.typing = false;
  k.press('w', { ctrlKey: true }); k.press('w', { metaKey: true }); k.press('w', { altKey: true });
  assert.deepEqual(k.calls, [], 'Ctrl, Cmd and Alt + W belong to the browser');
  k.press('w', { isComposing: true });
  k.press('w', { defaultPrevented: true });
  assert.deepEqual(k.calls, []);
  k.state.panel = { root: {} };
  k.press('w');
  assert.deepEqual(k.calls, [], 'a card page is open');
  k.state.panel = null;
  k.state.menu = { el: { contains: () => true } };
  k.press('w');
  assert.deepEqual(k.calls, [], 'the gear menu is open');
  k.state.menu = null;
  k.state.halted = true;
  k.press('w');
  assert.deepEqual(k.calls, []);
});

test('the pill is in the toolbar next to Threads only, hidden until there is something, and the legend follows it', () => {
  const bar = html.slice(html.indexOf('<div class="toolbar"'), html.indexOf('<main class="board"'));
  assert.match(bar, /id="threads-only"[\s\S]*id="waiting-btn" aria-pressed="false" aria-keyshortcuts="w" hidden>/);
  assert.match(bar, /id="waiting-btn"[\s\S]*Waiting for you[\s\S]*id="waiting-n"/);
  assert.match(bar, /id="waiting-btn"[\s\S]*id="wait-legend" role="group" aria-label="Kinds of items waiting for you" hidden/);
  assert.match(html, /\.wait-pill \{ color: var\(--danger\); background: var\(--danger-bg\)/, 'red, from the existing danger tokens');
  assert.match(html, /elThreadsOnly\.hidden = chat;/);
});

test('after the send the bar is gone, so focus goes to the open card page, or to New card; it is left alone when the user went elsewhere', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const root = new FakeEl(t.doc, 'aside');
  t.doc.body.append(root);
  t.state.panel = { root };
  const reply = () => ({ applied: ['c1.w1'], skipped: [], cards: [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } })])] });
  type(row(t, 'c1.w1').querySelector('textarea'), 'x');
  t.env.elSendBtn.focus();
  t.state.answers = [reply()];
  t.env.elSendBtn.click();
  await tick();
  assert.equal(t.doc.activeElement, root, 'the card page that is open');
  // no card page: the New card button
  const u = openSection();
  u.show(CARD([wait('c1.w1', 'question')]));
  type(row(u, 'c1.w1').querySelector('textarea'), 'x');
  u.env.elSendBtn.focus();
  u.state.answers = [reply()];
  u.env.elSendBtn.click();
  await tick();
  assert.equal(u.doc.activeElement, u.env.elNewBtn);
  // the user moved on while it was sending
  const v = openSection();
  v.show(CARD([wait('c1.w1', 'question')]));
  type(row(v, 'c1.w1').querySelector('textarea'), 'x');
  const elsewhere = new FakeEl(v.doc, 'input');
  v.doc.body.append(elsewhere);
  v.state.answers = [reply()];
  elsewhere.focus();
  v.env.elSendBtn.click();
  await tick();
  assert.equal(v.doc.activeElement, elsewhere);
  // a failed send moves nothing
  const w = openSection();
  w.show(CARD([wait('c1.w1', 'question')]));
  type(row(w, 'c1.w1').querySelector('textarea'), 'x');
  w.env.elSendBtn.focus();
  w.state.answers = [new Error('nope')];
  w.env.elSendBtn.click();
  await tick();
  assert.equal(w.doc.activeElement, w.env.elSendBtn);
});

test('the draft row sits at the foot of each open item, where the Send button used to be', () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  assert.deepEqual(li.children.map((c) => c.className), ['wait-top', 'clamp wait-text', 'input', 'wait-draft']);
});

test('the text of an empty chat-only column follows the role of the stage, not its id', () => {
  const { chatEmptyText } = vm.runInNewContext(`${block('milestones and stages', 'milestones and stages')}; ({ chatEmptyText })`);
  const roles = { start: 'a', working: 'a', review: 'b', blocked: 'b', done: 'c' };
  assert.equal(chatEmptyText({ id: 'a' }, roles), 'No thread is running.');
  assert.equal(chatEmptyText({ id: 'b' }, roles), 'No finished thread to look at.');
  assert.equal(chatEmptyText({ id: 'c' }, roles), 'No ended thread.');
  assert.equal(chatEmptyText({ id: 'new' }, roles), '', 'the id means nothing: a stage with none of these roles has no text of its own');
  const fixed = { start: 'new', working: 'new', review: 'review', blocked: 'review', done: 'done' };
  assert.deepEqual(['new', 'review', 'done'].map((id) => chatEmptyText({ id }, fixed)), ['No thread is running.', 'No finished thread to look at.', 'No ended thread.']);
  assert.doesNotMatch(html, /CHAT_EMPTY\[stage\.id\]/);
  assert.match(html, /chatEmptyText\(stage, cfg\(\)\.roles\) \|\| 'Nothing in '/);
});
