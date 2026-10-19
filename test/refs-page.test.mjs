// Card and waiting item references in the board page's Markdown, and the preview popover, run in a vm against a small fake DOM.
// Not driven here: hover timing, focus, scrolling and the popover's position (they need a real browser; see the browser check in CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { FakeEl, SERVER_DIR } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const m = /\/\/ ---- markdown subset[^\n]*\n([\s\S]*?)\/\/ ---- end markdown subset ----/.exec(html);
assert.ok(m, 'the markdown block is missing from the board page');
const refsSrc = fs.readFileSync(path.join(SERVER_DIR, 'board', 'js', 'refs.js'), 'utf8');

const CARDS = [
  { id: 'c86', kind: 'task', title: 'Checkout **flow**', status: 'review', waits: [] },
  { id: 'c8k2x1', kind: 'idea', title: 'Gift cards', status: 'backlog', type: 'bug', waits: [
    { id: 'c8k2x1.w1', kind: 'question', state: 'open', text: 'Should gift cards **expire**? ' + 'x'.repeat(300) },
    { id: 'c8k2x1.w2', kind: 'review', state: 'answered', text: 'Check the receipt' },
  ] },
  { id: 'c9', kind: 'milestone', title: 'Launch', waits: [] },
  { id: 'c10', kind: 'task', title: 'Child', parent: 'c9', status: 'backlog', waits: [] },
];

function load(chat = false) {
  const doc = {
    activeElement: null, listeners: {},
    createElement: (tag) => new FakeEl(doc, tag),
    createTextNode: (t) => { const e = new FakeEl(doc, '#text'); e.textContent = t; return e; },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
  };
  doc.body = new FakeEl(doc, 'body');
  const calls = [];
  const env = {
    document: doc,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    current: { cards: CARDS },
    isChat: () => chat,
    shownCard: (id) => CARDS.find((c) => c.id === id && c.kind === 'thread') || null,
    selKey: '/tmp/acme-shop',
    hashFor: (key, target) => '#/' + encodeURIComponent(key) + (target ? '/' + encodeURIComponent(target) : ''),
    findCard: (id) => CARDS.find((c) => c.id === id) || null,
    waitsOf: (c) => (c && c.waits) || [],
    openWaitsOf: (c) => ((c && c.waits) || []).filter((w) => w.state === 'open'),
    childrenOf: (cards, id) => cards.filter((c) => c.parent === id),
    clip: (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; },
    cfg: () => ({ stages: [{ id: 'backlog', label: 'Backlog' }, { id: 'review', label: 'In review' }] }),
    panel: null, hashPushed: false, location: { hash: '' },
    calls, clearTimeout, setTimeout, clearInterval, setInterval,
    openCard: (id, from) => calls.push(['open', id, from]),
    kindMark: (kind) => { const e = doc.createElement('span'); e.className = 'kindmark'; e.textContent = kind; return e; },
    waitKindMark: (kind) => { const e = doc.createElement('span'); e.className = 'pill'; e.textContent = kind; return e; },
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
  };
  const ctx = vm.createContext(env);
  const api = vm.runInContext(`${m[1]}\n${refsSrc}\n({ renderMarkdown, plainMd, inline, refSig, buildRefPop, visitRef })`, ctx);
  return { api, doc, env, calls };
}
const all = (el, pred, out = []) => { el.children.forEach((c) => { if (pred(c)) out.push(c); all(c, pred, out); }); return out; };
const crefs = (el) => all(el, (c) => c.className === 'cref');
const KEY = encodeURIComponent('/tmp/acme-shop');

test('references: a card id that exists becomes a link to its page; a waiting item id links to its card and names the item', () => {
  const { api } = load();
  const root = api.renderMarkdown('Look at c86 and c8k2x1.w1, then (c8k2x1).');
  const links = crefs(root);
  assert.deepEqual(links.map((a) => a.textContent), ['c86', 'c8k2x1.w1', 'c8k2x1']);
  assert.deepEqual(links.map((a) => a.tagName), ['A', 'A', 'A']);
  assert.equal(links[0].getAttribute('href'), `#/${KEY}/c86`);
  assert.equal(links[0].dataset.card, 'c86');
  assert.equal(links[0].dataset.wait, undefined);
  assert.equal(links[1].getAttribute('href'), `#/${KEY}/c8k2x1`);
  assert.equal(links[1].dataset.card, 'c8k2x1');
  assert.equal(links[1].dataset.wait, 'c8k2x1.w1');
  assert.equal(root.textContent, 'Look at c86 and c8k2x1.w1, then (c8k2x1).', 'the text is unchanged');
});

test('references: unknown ids, and ids of cards that exist but are not references, stay text', () => {
  const { api } = load();
  for (const text of ['c87 is not a card', 'c8k2x1.w9 has no such item', 'c86.w1 is not an item', 'cabc', 'c9.w1', 'v0.18.0 and 1.5',
    // the id of a card that exists, in places that are not a reference to it
    'src/c86.js and ./c86 and #c86', 'abc86 c86x c86-based c86.js c86.5', 'https://example.com/c86', 'https://x.com/?card=c86', 'https://x.com/a?x=1&c=c86',
    'bob@c86', 'C:\\c86\\x', 'x=c86', '~c86', 'thread:c86', 'C86']) {
    assert.equal(crefs(api.renderMarkdown(text)).length, 0, text);
  }
  assert.equal(crefs(api.renderMarkdown('see https://example.com/c86 but c86 and c10')).length, 2, 'a web address next to real references');
});

test('references: in a chat-only project only a thread card is a link, and no item is', () => {
  const { api } = load(true);
  assert.equal(crefs(api.renderMarkdown('c86 and c8k2x1 and c8k2x1.w1')).length, 0);
});

test('references: a bold lead is marked, a mid-sentence bold is not', () => {
  const { api } = load();
  const strongs = (src) => all(api.renderMarkdown(src), (c) => c.tagName === 'STRONG');
  assert.equal(strongs('**On return:** do it')[0].className, 'lead');
  assert.equal(strongs('**Decided:** do it')[0].className, 'tone-decided');
  assert.equal(strongs('Do **this** now')[0].className, '');
});

test('references: a link at the end of a sentence, in bold, in a list item and in a heading', () => {
  const { api } = load();
  assert.equal(crefs(api.renderMarkdown('Done in c86.')).length, 1);
  assert.equal(crefs(api.renderMarkdown('Done in **c86** and c10')).length, 2);
  assert.equal(crefs(api.renderMarkdown('- one c86\n- two c8k2x1.w2')).length, 2);
  assert.equal(crefs(api.renderMarkdown('### c86 first')).length, 1);
});

test('references: not inside code spans, code blocks or link text, and not in plain mode', () => {
  const { api, doc } = load();
  assert.equal(crefs(api.renderMarkdown('Run `c86` now')).length, 0);
  assert.equal(crefs(api.renderMarkdown('```\nc86\n```')).length, 0);
  assert.equal(crefs(api.renderMarkdown('See [c86](https://example.com/x) here')).length, 0, 'inside the text of a link');
  assert.equal(crefs(api.renderMarkdown('See [the card c86](docs/c86.md) here')).length, 0);
  const plain = doc.createElement('span');
  api.inline(plain, 'c86 and **c8k2x1.w1**', 'plain');
  assert.equal(crefs(plain).length, 0);
  assert.equal(plain.textContent, 'c86 and c8k2x1.w1');
});

test('references: plainMd is untouched and refSig lists what is a link now', () => {
  const { api } = load();
  assert.equal(api.plainMd('## Look at **c86** and `c8k2x1.w1`'), 'Look at c86 and c8k2x1.w1');
  assert.equal(api.refSig('c86, c87, c8k2x1.w2, c8k2x1.w5'), 'c86 c8k2x1.w2');
  assert.equal(api.refSig('nothing'), '');
});

test('popover: an open waiting item shows its state, its text cut short as plain text, its card and a Visit button', () => {
  const { api, calls } = load();
  const pop = api.buildRefPop(CARDS[1], CARDS[1].waits[0]);
  assert.equal(pop.id, 'cref-pop');
  const text = pop.textContent;
  assert.match(text, /c8k2x1\.w1/);
  assert.match(text, /Open/);
  assert.match(text, /Should gift cards expire\?/, 'Markdown marks are gone');
  assert.ok(!text.includes('**'));
  const body = all(pop, (c) => c.className === 'cp-text')[0].textContent;
  assert.ok(body.length <= 160, 'cut to 160');
  assert.match(text, /On c8k2x1: Gift cards/);
  const btn = pop.querySelector('button');
  assert.equal(btn.textContent, 'Visit');
  assert.equal(btn.getAttribute('aria-label'), 'Visit c8k2x1.w1');
  btn.click();
  assert.deepEqual(calls.at(-1), ['open', 'c8k2x1', true]);
});

test('popover: a closed item says so; a card shows its kind, title, stage and waiting count; a milestone its cards', () => {
  const { api } = load();
  assert.match(api.buildRefPop(CARDS[1], CARDS[1].waits[1]).textContent, /Answered[\s\S]*has been answered/);
  const card = api.buildRefPop(CARDS[1], null).textContent;
  assert.match(card, /idea/);
  assert.match(card, /Bug/);
  assert.match(card, /Gift cards/);
  assert.match(card, /Backlog · 1 waiting for you/);
  assert.match(api.buildRefPop(CARDS[0], null).textContent, /Checkout flow/);
  assert.match(api.buildRefPop(CARDS[0], null).textContent, /In review · nothing waiting/);
  assert.match(api.buildRefPop(CARDS[2], null).textContent, /Launch[\s\S]*1 card · nothing waiting/);
});
