// The board page's Worker picker ("Choose a worker"), run for real in a vm against a small fake DOM: the workers block from
// model.js supplies the rows and the search, the worker-picker.js piece supplies the dialog code.
// Not driven here (a fake DOM cannot carry them): the Tab ring (the page looks its stops up through getClientRects and compound
// selectors the fake element cannot match), scrolling the list after a moving selection, and CSS or whatever a screen reader
// does with the aria wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { FakeEl, SERVER_DIR } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = (name) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
const picker = fs.readFileSync(path.join(SERVER_DIR, 'board', 'js', 'worker-picker.js'), 'utf8');

const AGENTS = { agents: [
  { name: 'worker', model: 'claude-sonnet-5-5', effort: 'high', description: 'Bulk implementation work.', scope: 'project' },
  { name: 'critic', model: null, effort: null, description: '', scope: 'user' },
] };
const LANES = { available: true, projectTrusted: false, lanes: [
  { name: 'code-codex', implementer: 'codex', model: 'gpt-fake', variant: null, readOnly: false, source: 'global', approved: true },
  { name: 'review-ro', implementer: 'claude', model: null, variant: 'max', readOnly: true, source: 'project', approved: false },
] };

function pickerPage() {
  const doc = { activeElement: null, listeners: {}, createElement: (tag) => new FakeEl(doc, tag), addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); }, removeEventListener(type, fn) { if (doc.listeners[type]) doc.listeners[type] = doc.listeners[type].filter((f) => f !== fn); } };
  doc.body = new FakeEl(doc, 'body');
  const env = {
    document: doc, elOverlay: { inert: false },
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; s.setAttribute('aria-hidden', 'true'); return s; },
    plainBtn(text, cls, onClick) { const b = env.h('button', cls, text); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; },
  };
  const src = [`let lanes = ${JSON.stringify(LANES)}, agents = ${JSON.stringify(AGENTS)};`, block('tokens and agents'), block('workers'), picker, '({ openWorkerPicker, closeWorkerPicker, get modal() { return workerModal; } })'].join('\n');
  const page = vm.runInNewContext(src, vm.createContext(env));
  return { page, env, doc };
}

// Opens one picker over a fresh opener button and returns the picked keys, the opener, the scrim and the dialog box.
function open(t, { value = '', marks, chosen } = {}) {
  const picked = [];
  const opener = t.doc.createElement('button');
  t.doc.body.appendChild(opener);
  t.page.openWorkerPicker({ value, opener, marks: () => (marks || {}), onPick: (key) => picked.push(key), ...(chosen !== undefined ? { chosen } : {}) });
  const scrim = t.doc.body.children.filter((c) => c.className === 'wp-scrim')[0];
  assert.ok(scrim, 'the picker opened');
  return { picked, opener, scrim, box: scrim.querySelector('.wp') };
}

const rows = (box) => box.querySelectorAll('.wp-row');
const byKey = (box, key) => rows(box).find((r) => r.dataset.key === key);
const tabs = (box) => box.querySelectorAll('.wp-tab');
const tab = (box, id) => tabs(box).find((b) => b.id === 'wp-tab-' + id);
const countOf = (b) => b.children[1].textContent;
const counts = (box) => tabs(box).map(countOf);
const searchIn = (box) => box.querySelector('.wp-search');
const listKeys = (box) => box.querySelector('.wp-list').querySelectorAll('.wp-row').map((r) => r.dataset.key);
const type = (box, q) => { const s = searchIn(box); s.value = q; s.fire('input'); };
const badges = (row) => row.querySelectorAll('.wp-badge').map((b) => b.textContent);

test('the picker is a modal dialog: role, aria-modal, the title it points at, the regions in it and one tab per kind', () => {
  const t = pickerPage();
  const { box } = open(t, {});
  assert.equal(box.getAttribute('role'), 'dialog');
  assert.equal(box.getAttribute('aria-modal'), 'true');
  assert.equal(box.getAttribute('aria-labelledby'), 'wp-title');
  assert.equal(box.querySelector('.wp-title').textContent, 'Choose a worker');
  assert.equal(box.querySelector('.wp-title').id, 'wp-title');
  const s = searchIn(box);
  assert.equal(s.type, 'search');
  assert.equal(s.getAttribute('aria-label'), 'Search workers by name, provider or model');
  assert.equal(box.querySelector('.wp-pinned').getAttribute('role'), 'listbox');
  assert.equal(box.querySelector('.wp-tabs').getAttribute('role'), 'tablist');
  const list = box.querySelector('.wp-list');
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(list.getAttribute('aria-labelledby'), 'wp-tab-agents');
  const [agents, project, global] = tabs(box);
  assert.equal(agents.getAttribute('aria-controls'), 'wp-list', 'the list each tab controls');
  assert.equal(list.id, 'wp-list');
  assert.equal(agents.children[0].textContent, 'Sub-agents');
  assert.equal(agents.children[1].className, 'wp-count');
  assert.deepEqual(counts(box), ['2', '1', '1']);
  assert.equal(agents.getAttribute('aria-selected'), 'true', 'the first tab with rows is the current tab');
  assert.equal(project.getAttribute('aria-selected'), 'false');
  assert.equal(agents.tabIndex === 0 && tabs(box).every((b) => b === agents ? b.tabIndex === 0 : b.tabIndex === -1), true, 'the current tab is the only one that is a tab stop');
  assert.equal(t.env.elOverlay.inert, true, 'the card page behind it is made inert');
});

test('search narrows every tab to a name, provider or model hit, and each count follows', () => {
  const t = pickerPage();
  const { box } = open(t, {});
  type(box, 'critic');   // a name
  assert.deepEqual(counts(box), ['1', '0', '0']);
  assert.deepEqual(listKeys(box), ['agent:critic']);
  type(box, 'sonnet');   // a model
  assert.deepEqual(counts(box), ['1', '0', '0']);
  assert.deepEqual(listKeys(box), ['agent:worker'], 'only the sub-agent on that model');
  assert.equal(tab(box, 'agents').getAttribute('aria-label'), 'Sub-agents, 1 matching');
  type(box, 'codex');   // a provider
  assert.deepEqual(counts(box), ['0', '0', '1']);
  assert.deepEqual(listKeys(box), [], 'the lane in another tab is not drawn until its tab is chosen');
  tab(box, 'global').click();
  assert.deepEqual(listKeys(box), ['lane:code-codex']);
  type(box, 'zzz');
  assert.deepEqual(counts(box), ['0', '0', '0']);
  assert.match(box.querySelector('.wp-empty').textContent, /zzz/);
});

test('switching tabs keeps the search text and its filtered list', () => {
  const t = pickerPage();
  const { box } = open(t, {});
  type(box, 'review');
  tab(box, 'project').click();
  assert.equal(searchIn(box).value, 'review');
  assert.deepEqual(counts(box), ['0', '1', '0']);
  assert.deepEqual(listKeys(box), ['lane:review-ro']);
  assert.deepEqual(tabs(box).filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.id), ['wp-tab-project']);
  assert.equal(box.querySelector('.wp-list').getAttribute('aria-labelledby'), 'wp-tab-project');
  tab(box, 'agents').click();
  assert.equal(searchIn(box).value, 'review', 'the text survives a trip through the tabs');
  assert.match(box.querySelector('.wp-empty').textContent, /review/, 'and what each tab says about a no-hit search, too');
});

test('a row that cannot be picked shows why and does nothing over a click or Enter; the picker stays open', () => {
  const t = pickerPage();
  const { box, scrim } = open(t, {});
  tab(box, 'project').click();
  const row = byKey(box, 'lane:review-ro');
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.ok(badges(row).includes('Not approved'));
  row.click();
  assert.deepEqual(t.doc.body.children.filter((c) => c === scrim), [scrim], 'the dialog is still up');
  box.fire('keydown', { key: 'Enter', target: row });
  assert.notEqual(t.page.modal, null, 'never picked, never closed');
  box.fire('keydown', { key: ' ', target: row });
  assert.equal(typeof t.page.modal.close, 'function', 'still there after Space, too, and closable');
  assert.deepEqual(t.doc.body.children.filter((c) => c === scrim), [scrim]);
});

test('Enter on a row picks it and closes; a click on a row does the same, and focus returns to the opener', () => {
  const t = pickerPage();
  let o = open(t, { value: 'agent:worker' });
  o.box.fire('keydown', { key: 'Enter', target: byKey(o.box, 'agent:worker') });
  assert.deepEqual(o.picked, ['agent:worker']);
  assert.equal(t.page.modal, null);
  assert.equal(t.doc.body.children.includes(o.scrim), false, 'the scrim is gone');
  assert.equal(t.env.elOverlay.inert, false, 'and the card page wakes up');
  assert.equal(t.doc.activeElement, o.opener, 'focus went back to the button that opened it');
  o = open(t, {});
  byKey(o.box, 'agent:critic').click();
  assert.deepEqual(o.picked, ['agent:critic']);
  assert.equal(t.page.modal, null);
  assert.equal(t.doc.body.children.includes(o.scrim), false);
});

test('Esc closes the dialog without picking, and so do a press on the scrim and a close from elsewhere', () => {
  const t = pickerPage();
  let o = open(t, { value: 'lane:code-codex' });
  o.box.fire('keydown', { key: 'Escape', target: searchIn(o.box) });
  assert.deepEqual(o.picked, []);
  assert.equal(t.page.modal, null);
  assert.equal(t.doc.body.children.includes(o.scrim), false);
  o = open(t, {});
  o.scrim.fire('mousedown');   // target === scrim: not a press inside the box
  assert.deepEqual(o.picked, []);
  assert.equal(t.page.modal, null);
  assert.equal(t.doc.body.children.includes(o.scrim), false);
  o = open(t, {});
  t.page.closeWorkerPicker();
  assert.deepEqual(o.picked, []);
  assert.equal(t.page.modal, null);
});

test('the current choice is marked: aria-selected and a Selected badge (the default) on exactly that row, which is the tab stop', () => {
  const t = pickerPage();
  const { box } = open(t, { value: 'agent:worker' });
  const cur = byKey(box, 'agent:worker');
  assert.equal(cur.getAttribute('aria-selected'), 'true');
  assert.ok(badges(cur).includes('Selected'));
  assert.deepEqual(rows(box).filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.dataset.key), ['agent:worker']);
  assert.deepEqual(rows(box).map((r) => r.tabIndex), rows(box).map((r) => (r === cur ? 0 : -1)), 'only the current row is a tab stop');
});

test('what the card says about its workers is shown as badges with their titles, on the right rows', () => {
  const t = pickerPage();
  const { box } = open(t, { marks: { 'agent:worker': 'now', 'lane:code-codex': 'last' } });
  const now = byKey(box, 'agent:worker').querySelectorAll('.wp-badge').find((b) => b.textContent === 'Working now');
  assert.equal(now.title, 'This worker is working on this card right now');
  tab(box, 'global').click();
  const last = byKey(box, 'lane:code-codex').querySelectorAll('.wp-badge').find((b) => b.textContent === 'Last used');
  assert.equal(last.title, 'Claude used this worker last on this card');
  tab(box, 'project').click();
  assert.equal(byKey(box, 'lane:review-ro').querySelectorAll('.wp-badge').find((b) => b.textContent === 'Working now' || b.textContent === 'Last used'), undefined, 'a mark belongs to its row only');
});

test('a current choice the lists no longer know is shown above the default, stays selected and cannot be picked', () => {
  const t = pickerPage();
  const { box, picked } = open(t, { value: 'agent:gone' });
  const lost = byKey(box, 'agent:gone');
  assert.equal(lost.getAttribute('aria-selected'), 'true');
  assert.equal(lost.getAttribute('aria-disabled'), 'true');
  assert.equal(lost.querySelector('.wp-name').textContent, 'agent: gone');
  assert.ok(badges(lost).includes('Not found'), 'it is marked as not found');
  assert.ok(badges(lost).includes('Selected'), 'and still as the current choice');
  assert.match(lost.querySelector('.wp-hint').textContent, /No longer available\. Pick another worker\./);
  assert.ok(lost.tabIndex === 0 && rows(box).filter((r) => r.tabIndex === 0).length === 1, 'it keeps the tab stop; the default row does not');
  type(box, 'gone');   // a search that empties every list still keeps it there, selected
  const again = byKey(box, 'agent:gone');
  assert.equal(again.getAttribute('aria-selected'), 'true');
  assert.ok(again.tabIndex === 0);
  box.fire('keydown', { key: 'Enter', target: again });
  assert.deepEqual(picked, [], 'Enter on it cannot pick a worker that is gone');
  assert.notEqual(t.page.modal, null, 'the dialog is still up');
});

test('the badge on the chosen row is what the caller says: Saved with its title; with nothing saved no row is selected and Claude (default) gets no badge', () => {
  const t = pickerPage();
  let o = open(t, { value: 'agent:worker', chosen: { text: 'Saved', title: 'Saved on this card' } });
  const saved = byKey(o.box, 'agent:worker').querySelectorAll('.wp-badge').find((b) => b.textContent === 'Saved');
  assert.equal(saved.title, 'Saved on this card');
  assert.ok(!rows(o.box).some((r) => badges(r).includes('Selected')), 'the default text is not added beside it');
  t.page.closeWorkerPicker();
  o = open(t, { value: '', chosen: null, marks: { 'lane:code-codex': 'last' } });
  const def = byKey(o.box, '');
  assert.deepEqual(rows(o.box).filter((r) => r.getAttribute('aria-selected') === 'true'), [], 'no row is drawn as the choice');
  assert.deepEqual(badges(def), [], 'and no badge says it was chosen');
  assert.equal(rows(o.box).filter((r) => r.tabIndex === 0).length, 1, 'one row is still the tab stop');
});

test('with nothing chosen it opens on the tab of the worker working now, else of the last one used; a chosen worker wins', () => {
  const t = pickerPage();
  const selectedTab = (box) => tabs(box).find((b) => b.getAttribute('aria-selected') === 'true').id;
  let o = open(t, { value: '', chosen: null, marks: { 'lane:code-codex': 'last' } });
  assert.equal(selectedTab(o.box), 'wp-tab-global');
  assert.ok(badges(byKey(o.box, 'lane:code-codex')).includes('Last used'), 'the Last used badge is in view');
  t.page.closeWorkerPicker();
  o = open(t, { value: '', chosen: null, marks: { 'lane:code-codex': 'last', 'lane:review-ro': 'now' } });
  assert.equal(selectedTab(o.box), 'wp-tab-project', 'working now comes before last used');
  t.page.closeWorkerPicker();
  o = open(t, { value: 'agent:worker', marks: { 'lane:code-codex': 'last' } });
  assert.equal(selectedTab(o.box), 'wp-tab-agents');
  t.page.closeWorkerPicker();
  o = open(t, { value: '', marks: {} });
  assert.equal(selectedTab(o.box), 'wp-tab-agents', 'no marks: the first tab with rows');
});
