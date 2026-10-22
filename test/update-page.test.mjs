// The board page's update notes: "Updated to X" with What's new, and "thread X is out" with the two commands, each put away per
// version in this browser. The page's own code runs in a vm with stand-ins for the rest of the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = /\/\/ ---- update notes[^\n]*\n([\s\S]*?)\/\/ ---- end update notes ----/.exec(html);
assert.ok(block, 'the "update notes" block is missing from the board page');

function page({ remote = false, store = {}, storage = true } = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const box = new FakeEl(doc, 'div');
  box.hidden = true;
  doc.body.appendChild(box);
  const h = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };
  const requests = [];
  let answer = { ok: true, body: null }, failure = false;
  const localStorage = storage
    ? { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
    : { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const ctx = {
    $: () => box, h, localStorage, isRemote: () => remote, parseJson: JSON.parse,
    plainBtn: (text, cls, onClick) => { const b = h('button', 'btn' + (cls ? ' ' + cls : ''), text); if (onClick) b.addEventListener('click', onClick); return b; },
    renderMarkdown: (src) => { const d = h('div', 'md'); d.textContent = String(src); d.markdown = true; return d; },
    codeBlock: (text, lang, shell, prompt) => { const d = h('div', 'codeblock'); d.textContent = text; d.shell = shell; return d; },
    request: async (...args) => { requests.push(args); if (failure) throw new Error('offline'); return { res: { ok: answer.ok }, text: JSON.stringify(answer.body) }; },
  };
  const fns = vm.runInNewContext(block[1] + '; ({ refreshUpdate, renderUpdate })', ctx);
  return { box, store, requests, refresh: fns.refreshUpdate, render: fns.renderUpdate, respond(body, ok = true) { answer = { ok, body }; }, fail() { failure = true; } };
}
const text = (el) => el.textContent;
const items = (p) => p.box.children;
const button = (el, label) => el.querySelectorAll('button').find((b) => b.textContent === label);

const UPDATED = { version: '0.24.0', from: '0.23.0', latest: null, notes: 'The **new** things.', releases: 'https://example.invalid/releases' };

test('an update shows "Updated to X" with a What\'s new panel that holds the changelog entry, set as Markdown text', async () => {
  const p = page();
  p.respond(UPDATED);
  await p.refresh();
  assert.deepEqual(p.requests, [['GET', '/api/update', null, 5000]]);
  assert.equal(p.box.hidden, false);
  assert.equal(items(p).length, 1);
  const item = items(p)[0];
  assert.match(text(item), /Updated to 0\.24\.0 \(from 0\.23\.0\)\./);
  const panel = item.querySelector('.update-panel');
  assert.equal(panel.hidden, true, 'closed until asked for');
  const more = button(item, 'What’s new');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  more.click();
  assert.equal(panel.hidden, false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.children[0].markdown, true, 'through the page\'s Markdown renderer');
  assert.equal(panel.children[0].textContent, 'The **new** things.');
  more.click();
  assert.equal(panel.hidden, true);
});

test('an update from a version that cannot be named says "Updated to X" with no "from", and is put away per version', async () => {
  const store = {};
  const p = page({ store });
  p.respond({ ...UPDATED, from: null, updated: true });
  await p.refresh();
  assert.equal(items(p).length, 1);
  assert.equal(text(items(p)[0]).split('\n')[0].startsWith('Updated to 0.24.0.'), true, text(items(p)[0]));
  assert.doesNotMatch(text(items(p)[0]), /from/);
  button(items(p)[0], 'Dismiss').click();
  assert.deepEqual(Object.keys(store), ['thread-board-update:updated:0.24.0']);
  p.render({ ...UPDATED, from: null, updated: true });
  assert.equal(p.box.hidden, true);
  const no = page();
  no.render({ ...UPDATED, from: null, updated: false });
  assert.equal(no.box.hidden, true, 'neither from nor updated: nothing to say');
});

test('with no changelog entry the panel says to see the release notes and names the address as plain text', async () => {
  const p = page();
  p.respond({ ...UPDATED, notes: null });
  await p.refresh();
  const panel = items(p)[0].querySelector('.update-panel');
  assert.equal(panel.children[0].markdown, undefined);
  assert.equal(panel.textContent, 'See the release notes: https://example.invalid/releases');
});

test('Dismiss puts the note away for that version only, in this browser', async () => {
  const store = {};
  const p = page({ store });
  p.respond(UPDATED);
  await p.refresh();
  button(items(p)[0], 'Dismiss').click();
  assert.equal(items(p).length, 0);
  assert.equal(p.box.hidden, true);
  assert.deepEqual(Object.keys(store), ['thread-board-update:updated:0.24.0']);
  // a later load: the same version stays away, the next one shows
  const again = page({ store });
  again.respond(UPDATED);
  await again.refresh();
  assert.equal(again.box.hidden, true);
  again.respond({ ...UPDATED, version: '0.25.0', from: '0.24.0' });
  await again.refresh();
  assert.match(text(items(again)[0]), /Updated to 0\.25\.0/);
});

test('a newer release shows "thread X is out" with the two update commands as code blocks, put away per version', async () => {
  const store = {};
  const p = page({ store });
  p.respond({ version: '0.24.0', from: null, latest: '0.25.0', notes: null, releases: 'x' });
  await p.refresh();
  const item = items(p)[0];
  assert.equal(item.dataset.kind, 'out');
  assert.match(text(item), /^thread 0\.25\.0 is out \(this is 0\.24\.0\)\. To update, run these, then reload the window:/);
  const cmds = item.querySelectorAll('.codeblock');
  assert.deepEqual(cmds.map((c) => c.textContent), ['claude plugin marketplace update thread-marketplace', 'claude plugin update thread@thread-marketplace']);
  assert.ok(cmds.every((c) => c.shell === true));
  assert.equal(button(item, 'What’s new'), undefined);
  button(item, 'Dismiss').click();
  assert.equal(p.box.hidden, true);
  assert.deepEqual(Object.keys(store), ['thread-board-update:out:0.25.0']);
  p.render({ version: '0.24.0', from: null, latest: '0.25.0', notes: null });
  assert.equal(p.box.hidden, true);
  p.render({ version: '0.24.0', from: null, latest: '0.26.0', notes: null });
  assert.equal(p.box.hidden, false);
});

test('both notes can show at once and each is put away on its own', async () => {
  const p = page();
  p.render({ ...UPDATED, latest: '0.25.0' });
  assert.equal(items(p).length, 2);
  button(items(p)[0], 'Dismiss').click();
  assert.equal(items(p).length, 1);
  assert.equal(p.box.hidden, false);
  assert.equal(items(p)[0].dataset.kind, 'out');
});

test('nothing shows without an update, for an answer that is not one, offline, through the tunnel, or when the browser has no storage', async () => {
  const none = page();
  none.respond({ version: '0.24.0', from: null, latest: null, notes: null });
  await none.refresh();
  assert.equal(none.box.hidden, true);
  const bad = page();
  bad.respond({ error: 'x' }, false);
  await bad.refresh();
  assert.equal(bad.box.hidden, true);
  const off = page();
  off.fail();
  await off.refresh();
  assert.equal(off.box.hidden, true);
  const tunnel = page({ remote: true });
  tunnel.respond(UPDATED);
  await tunnel.refresh();
  assert.deepEqual(tunnel.requests, [], 'the tunnel does not serve it, so the page does not ask');
  // storage that throws: the note shows and Dismiss still hides it for this page
  const blocked = page({ storage: false });
  blocked.respond(UPDATED);
  await blocked.refresh();
  assert.equal(items(blocked).length, 1);
  button(items(blocked)[0], 'Dismiss').click();
  assert.equal(blocked.box.hidden, true);
});

test('the update note is in the page, loaded by start, and the page text is never set as HTML', () => {
  assert.match(html, /id="update-note"/);
  assert.match(html, /refreshUpdate\(\);/);
  assert.doesNotMatch(block[1], /innerHTML|insertAdjacentHTML|outerHTML/);
});
