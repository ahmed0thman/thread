// The board page's "Waiting for you": the red pill and its filter, the tag on a card, the section on a card's page, the gear
// entry and the keys. board.html's own code runs in a vm against a small fake DOM and a scripted server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_DIR, FakeEl } from './helpers.mjs';

const html = fs.readFileSync(path.join(SERVER_DIR, 'board.html'), 'utf8');
const block = (name, end) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${end || name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from board.html`);
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
  const state = { current: { cards: [] }, chat: false, ro: false, selKey: 'k1', projects: [], rendered: 0, errors: [], posts: [], copies: [], applied: [], answers: [], busy: {} };
  const mk = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const env = {
    document: doc,
    get current() { return state.current; },
    get selKey() { return state.selKey; },
    get projects() { return state.projects; },
    READONLY_WHY: 'read-only',
    isChat: () => state.chat,
    isRO: () => state.ro,
    h(tag, cls, text) { const e = mk(tag, cls); if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = mk('span', 'shape ' + cls); s.setAttribute('aria-hidden', 'true'); return s; },
    sessionLabel: (id) => `session ${String(id).slice(0, 8)}`,
    sessionInfo: (id) => (state.sessions && state.sessions[id]) || null,
    timeEl: (iso) => { const t = mk('time'); t.textContent = `at ${iso}`; return t; },
    copyBtn: (text, what, labelText) => { const b = mk('button', 'btn small'); b.textContent = labelText || 'Copy'; b.setAttribute('aria-label', labelText || 'Copy ' + what); b.copies = text; b.addEventListener('click', () => state.copies.push(text)); return b; },
    actionBtn: (text, cls, key, onClick) => {
      const b = mk('button', 'btn ' + cls); b.textContent = text; b.dataset.busykey = key;
      b.addEventListener('click', () => { if (b.dataset.off !== '1') onClick(); });
      return b;
    },
    setOff: (b, off) => { b.dataset.off = off ? '1' : '0'; b.disabled = off; },
    runAction: async (key, fn) => { if (state.busy[key]) return undefined; state.busy[key] = true; try { return await fn(); } finally { delete state.busy[key]; } },
    syncBusy() {},
    clearError() {}, showError: (m) => { state.errors.push(m); },
    pp: (key, rest) => `/api/p/${key}/${rest}`,
    api: async (method, p, body) => { state.posts.push([method, p, body]); const a = state.answers.shift(); if (a instanceof Error) throw a; return a; },
    applyCard: (c, key) => { state.applied.push([c, key]); },
    wrote() {}, poll: async () => {},
    renderBoard: () => { state.rendered++; },
    elWaiting: mk('button'), elWaitN: mk('span'), elWaitLegend: mk('span'),
  };
  env.elWaiting.hidden = true;
  env.elWaiting.setAttribute('aria-pressed', 'false');
  Object.assign(env, over.env || {});
  const src = `${block('milestones and stages', 'milestones and stages')}\n${block('waiting for you', 'waiting for you')}
({ waitsOf, openWaitsOf, matches, cardActionsOf: null, waitingCount, tabWaiting, waitingOn, setWaitingOn, toggleWaiting, updateWaitingPill, waitTag, waitSummary, waitSummaryText, cardWaits,
   waitKindMark, waitReady, waitBody, waitAnswerText, waitLine, waitRow, attachWaits, sendWait, waitDrafts, WAIT_ORDER, WAIT_SPEC })`;
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
  assert.match(html, /waiting: waitingOn\(\) && !isChat\(\)/, 'a chat-only board ignores it');
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
  assert.match(html, /const wt = waitTag\(waits, milestone \? 'milestone' : 'card'\);\n\s+if \(wt\) foot\.appendChild\(wt\);/);
  assert.match(html, /waiting for you on its cards' : ' waiting for you'\)/, 'the card\'s accessible name says it');
});

test('the tab of a project shows a red count beside the running dot, the selected one from the page\'s own state', () => {
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

function tabsPage() {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createDocumentFragment: () => new FakeEl(doc, 'frag') };
  doc.body = new FakeEl(doc, 'body');
  const tabs = new FakeEl(doc, 'div'), wrap = new FakeEl(doc, 'nav');
  tabs.scrollLeft = 0; tabs.clientWidth = 1000;
  doc.body.append(wrap, tabs);
  const env = {
    document: doc, elTabs: tabs, elTabsWrap: wrap, selKey: 'k1', projects: [], current: null,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; return s; },
    parentName: () => '', tabWaiting: (p) => p.waiting || 0,
  };
  const page = vm.runInNewContext(`${block('project tabs', 'project tabs')}\n({ tabSig, renderTabs })`, vm.createContext(env));
  return { page, env, tabs };
}

test('a tab shows the number of items waiting, hides it at 0, and the tab bar is drawn again when it changes', () => {
  const { page, env, tabs } = tabsPage();
  env.projects = [{ key: 'k1', name: 'shop', projectDir: '/x/shop', exists: true, cards: 4, running: 1, waiting: 3 }, { key: 'k2', name: 'blog', projectDir: '/x/blog', exists: true, cards: 2, running: 0, waiting: 0 }];
  const sig0 = page.tabSig();
  page.renderTabs(false);
  const [shop, blog] = tabs.children[0].children;
  const badge = shop.querySelector('.wait-badge');
  assert.equal(badge.textContent, '3');
  assert.equal(badge.getAttribute('aria-hidden'), 'true');
  assert.match(shop.textContent, /, 3 waiting for you/, 'a screen reader hears it');
  assert.equal(shop.querySelector('.s-pulse') !== null, true, 'the running dot is still there');
  assert.equal(blog.querySelector('.wait-badge'), null);
  env.projects[1].waiting = 1;
  assert.notEqual(page.tabSig(), sig0, 'a change of the count redraws the tabs');
  assert.match(blog.textContent, /^blog/);
});

// ----- the section on a card's page

function openSection(over = {}) {
  const t = waitsPage(over);
  const ctl = t.page.attachWaits({});
  t.doc.body.append(ctl.host);
  const show = (card) => { t.state.current = { cards: [card] }; ctl.update(card); };
  return { ...t, ctl, show };
}
const CARD = (waits, extra = {}) => task('c1', { waits, ...extra });
const row = (t, id) => t.ctl.host.querySelector(`li[data-wid="${id}"]`);
const sendBtn = (li) => li.querySelectorAll('button').find((b) => b.textContent === 'Send');
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

test('a question has a text box for the answer and Send waits until it holds something', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  const ta = li.querySelector('textarea');
  assert.equal(ta.getAttribute('aria-label'), 'Your answer to c1.w1');
  assert.equal(inputs(li, 'text').length, 0, 'the answer is the text: no separate comment box');
  const send = sendBtn(li);
  assert.equal(send.disabled, true);
  type(ta, '   ');
  assert.equal(send.disabled, true);
  type(ta, ' 5 ');
  assert.equal(send.disabled, false);
  t.state.answers = [{ ...CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: '5' }, answeredVia: 'board' })]) }];
  send.click();
  await tick();
  assert.deepEqual(plain(t.state.posts), [['POST', '/api/p/k1/cards/c1/waits/c1.w1', { text: '5' }]]);
  assert.equal(t.state.applied[0][1], 'k1');
  assert.equal(t.page.waitDrafts['k1/c1.w1'], undefined, 'the draft is gone once sent');
});

test('a choice shows radio buttons for one pick and checkboxes for several, and Send needs a valid pick', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'choice'), wait('c1.w2', 'choice', { multi: true })]));
  const one = row(t, 'c1.w1'), many = row(t, 'c1.w2');
  assert.deepEqual(options(one).map((i) => i.type), ['radio', 'radio', 'radio']);
  assert.deepEqual(options(many).map((i) => i.type), ['checkbox', 'checkbox', 'checkbox']);
  assert.equal(one.querySelector('legend').textContent, 'Pick one');
  assert.equal(many.querySelector('legend').textContent, 'Pick any that apply');
  assert.deepEqual(options(one).map((i) => i.value), ['a', 'b', 'c']);
  assert.equal(new Set(options(one).map((i) => i.name)).size, 1, 'one group');
  assert.equal(sendBtn(one).disabled, true);
  assert.equal(sendBtn(many).disabled, true);
  const o = options(one);
  pick(o[1]);
  assert.equal(sendBtn(one).disabled, false);
  pick(o[2]);   // a radio button fires change only for the one picked; the earlier one is just unchecked by the browser
  assert.equal(sendBtn(one).disabled, false, 'picking another replaces the pick');
  assert.deepEqual(plain(t.page.waitDrafts['k1/c1.w1'].choices), ['c']);
  pick(o[1]);
  const m = options(many);
  pick(m[2]); pick(m[0]);
  assert.equal(sendBtn(many).disabled, false);
  pick(m[0], false); pick(m[2], false);
  assert.equal(sendBtn(many).disabled, true, 'unticking all leaves nothing to send');
  pick(m[1]); pick(m[2]);
  type(inputs(many, 'text')[0], ' fine ');
  t.state.answers = [CARD([wait('c1.w1', 'choice', { state: 'answered', answer: { choices: ['b'] } }), wait('c1.w2', 'choice', { multi: true })])];
  sendBtn(one).click();
  await tick();
  t.state.answers = [CARD([wait('c1.w2', 'choice', { multi: true, state: 'answered', answer: { choices: ['b', 'c'] } })])];
  sendBtn(many).click();
  await tick();
  assert.deepEqual(plain(t.state.posts.map((p) => p[2])), [{ choices: ['b'] }, { choices: ['b', 'c'], comment: 'fine' }]);
});

test('a single choice needs exactly one option and a multiple choice at least one', () => {
  const { page } = waitsPage();
  const d = (choices) => ({ text: '', choices, done: false, verdict: '', comment: '' });
  assert.deepEqual([[], ['a'], ['a', 'b']].map((c) => page.waitReady(wait('x', 'choice'), d(c))), [false, true, false]);
  assert.deepEqual([[], ['a'], ['a', 'b']].map((c) => page.waitReady(wait('x', 'choice', { multi: true }), d(c))), [false, true, true]);
});

test('a to-do is ticked as done and a review is approved or sent back, each with an optional comment', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'todo'), wait('c1.w2', 'review')]));
  const todo = row(t, 'c1.w1'), review = row(t, 'c1.w2');
  const box = inputs(todo, 'checkbox')[0];
  assert.match(todo.textContent, /Done: I did this/);
  assert.equal(sendBtn(todo).disabled, true);
  pick(box);
  assert.equal(sendBtn(todo).disabled, false);
  pick(box, false);
  assert.equal(sendBtn(todo).disabled, true);
  pick(box);
  assert.equal(inputs(todo, 'text')[0].getAttribute('aria-label'), 'Comment on c1.w1 (optional)');
  const radios = inputs(review, 'radio');
  assert.deepEqual(radios.map((r) => r.value), ['approve', 'changes']);
  assert.deepEqual(review.querySelectorAll('label').map((l) => l.textContent), ['Approve', 'Request changes']);
  assert.equal(sendBtn(review).disabled, true);
  pick(radios[1]);
  assert.equal(sendBtn(review).disabled, false);
  type(inputs(review, 'text')[0], 'rename the helper');
  t.state.answers = [CARD([wait('c1.w1', 'todo', { state: 'answered' })]), CARD([wait('c1.w2', 'review', { state: 'answered' })])];
  sendBtn(todo).click();
  await tick();
  sendBtn(review).click();
  await tick();
  assert.deepEqual(plain(t.state.posts.map((p) => p[2])), [{ done: true }, { verdict: 'changes', comment: 'rename the helper' }]);
});

test('Ctrl or Cmd + Enter sends, a plain Enter does not, and the card form\'s own shortcut is not triggered', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const li = row(t, 'c1.w1');
  const ta = li.querySelector('textarea');
  t.state.answers = [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } })])];
  const key = (extra) => { const stops = []; const e = ta.fire('keydown', { key: 'Enter', stopPropagation() { stops.push(1); }, ...extra }); li.fire('keydown', { key: 'Enter', target: ta, stopPropagation() { stops.push(1); }, ...extra }); return { e, stops }; };
  type(ta, '');
  key({ ctrlKey: true });
  await tick();
  assert.equal(t.state.posts.length, 0, 'an empty answer is not sent');
  type(ta, 'x');
  const plainKey = key({});
  await tick();
  assert.equal(t.state.posts.length, 0, 'a plain Enter is a new line');
  assert.equal(plainKey.stops.length, 0);
  const ctrl = key({ metaKey: true });
  await tick();
  assert.equal(t.state.posts.length, 1);
  assert.equal(ctrl.stops.length > 0, true, 'the event stops here, so the form around it does not save');
  const composing = key({ ctrlKey: true, isComposing: true });
  await tick();
  assert.equal(t.state.posts.length, 1, 'text being composed is left alone');
  assert.ok(composing);
});

test('a failed send keeps what was typed and shows the server\'s message', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question')]));
  const ta = row(t, 'c1.w1').querySelector('textarea');
  type(ta, 'my long answer');
  t.state.answers = [new Error('c1.w1 is answered, not open')];
  sendBtn(row(t, 'c1.w1')).click();
  await tick();
  assert.deepEqual(t.state.errors, ['c1.w1 is answered, not open']);
  assert.equal(t.page.waitDrafts['k1/c1.w1'].text, 'my long answer');
  assert.equal(t.state.applied.length, 0);
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
  assert.equal(sendBtn(row(t, 'c1.w1')).disabled, false, 'and Send follows the draft');
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
  t.ctl.host.querySelectorAll('button').filter((b) => b.textContent === 'Send').forEach((b) => { assert.equal(b.disabled, true); assert.equal(b.title, 'read-only'); });
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

test('after Send, focus goes to the next open item, or to the folded line of the item just answered', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  const ta = row(t, 'c1.w1').querySelector('textarea');
  type(ta, 'x');
  ta.focus();
  // the server's answer closes c1.w1; the page applies it (as applyCard does) and the section is drawn again
  t.env.applyCard = (c) => { t.show(c); t.doc.activeElement = null; };
  t.state.answers = [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } }), wait('c1.w2', 'todo')])];
  sendBtn(row(t, 'c1.w1')).click();
  await tick();
  assert.equal(t.doc.activeElement.dataset.fid, 'w-done-c1.w2', 'the next open item\'s control');
  // the last open item: its own folded line
  const box = inputs(row(t, 'c1.w2'), 'checkbox')[0];
  pick(box);
  t.state.answers = [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } }), wait('c1.w2', 'todo', { state: 'answered', answer: { done: true } })])];
  sendBtn(row(t, 'c1.w2')).click();
  await tick();
  assert.equal(t.doc.activeElement.dataset.fid, 'w-copy-c1.w2', 'the Copy id button on the folded line');
  assert.equal(row(t, 'c1.w2').className, 'wait-line');
});

test('focus is left alone when the user moved on while the answer was being sent, and after a failed send', async () => {
  const t = openSection();
  t.show(CARD([wait('c1.w1', 'question'), wait('c1.w2', 'todo')]));
  const ta = row(t, 'c1.w1').querySelector('textarea');
  type(ta, 'x');
  const elsewhere = new FakeEl(t.doc, 'input');
  t.doc.body.append(elsewhere);
  t.env.applyCard = (c) => { t.show(c); };
  t.state.answers = [CARD([wait('c1.w1', 'question', { state: 'answered', answer: { text: 'x' } }), wait('c1.w2', 'todo')])];
  elsewhere.focus();
  sendBtn(row(t, 'c1.w1')).click();
  await tick();
  assert.equal(t.doc.activeElement, elsewhere);
  type(inputs(row(t, 'c1.w2'), 'text')[0], 'c');
  pick(inputs(row(t, 'c1.w2'), 'checkbox')[0]);
  const before = row(t, 'c1.w2').querySelector('input');
  before.focus();
  t.state.answers = [new Error('nope')];
  sendBtn(row(t, 'c1.w2')).click();
  await tick();
  assert.equal(t.doc.activeElement, before, 'a failed send moves nothing');
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
