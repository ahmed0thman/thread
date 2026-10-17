// The card fields on the board page: the form model (what changed, how labels, blockers and criteria are read), the card face model and
// its marks, the controls on the card page, and the history rows for workers. The page's own code runs in a vm with a fake DOM.
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

test('the card page disables both start buttons for saved criteria or blockers and shows the reason beside them', () => {
  const start = html.indexOf('    function syncStart()');
  const end = html.indexOf('    // known sessions', start);
  assert.ok(start > 0 && end > start);
  const src = `${block('gear menu actions')}\n${html.slice(start, end)}\nsyncStart`;
  for (const kind of ['task', 'idea']) {
    let saved = { id: 'c1', kind };
    const startBtn = {}, goBtn = {}, whyEl = {}, startWhyEl = {};
    const sync = vm.runInNewContext(src, {
      create: false, P: { target: 'c1', isDirty: () => false }, card: { id: 'c1', kind },
      findCard: () => saved, workerStartBlocked: () => '', isRO: () => false,
      startBtn, goBtn, whyEl, startWhyEl, setOff: (b, off) => { b.disabled = off; },
    });
    for (const fields of [{ criteria: ['Tests pass'] }, { blockedBy: ['c9'] }, { criteria: ['Tests pass'], blockedBy: ['c9'] }]) {
      saved = { id: 'c1', kind, ...fields };
      sync();
      assert.equal(startBtn.disabled, true);
      assert.equal(goBtn.disabled, true);
      assert.equal(startWhyEl.hidden, false);
      assert.equal(startWhyEl.textContent, 'A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first.');
      assert.equal(whyEl.textContent, startWhyEl.textContent);
      assert.equal(startBtn.title, startWhyEl.textContent);
    }
    for (const fields of [{}, { criteria: [], blockedBy: [] }]) {
      saved = { id: 'c1', kind, ...fields };
      sync();
      assert.equal(startBtn.disabled, false);
      assert.equal(goBtn.disabled, false);
      assert.equal(startWhyEl.hidden, true);
      assert.equal(startWhyEl.textContent, '');
      assert.equal(whyEl.textContent, '');
    }
  }
  assert.match(html, /startWhyEl\.setAttribute\('role', 'status'\)/);
  assert.match(html, /foot\.append\(startBtn, startWhyEl\)/, 'the reason is beside the card-page button');
});

const model = vm.runInNewContext(`${block('card fields')}\n({ FIELD_KEYS, fieldValues, parseLabels, parseBlockers, parseCriteria, fieldsPatch, fieldKeys, workerTitle, faceModel, fieldFacts, criteriaText, typeChoice, typePatch })`, {});

const NEW = { kind: 'task', id: 'c1', title: 'T', status: 'new' };
const STAGES = { c2: 'In progress', c3: 'New', c4: 'Done' };
const ctxOf = (cards) => ({ cards, finished: (c) => c.status === 'done', label: (s) => ({ in_progress: 'In progress', new: 'New', done: 'Done' })[s] || s });
const cardsOf = (...pairs) => pairs.map(([id, status, kind = 'task']) => ({ id, status, kind, title: id }));

// ---------------------------------------------------------------- the form model

test('a card from an older version has none of the fields, which is the same as the defaults', () => {
  assert.deepEqual(plain(model.fieldValues(NEW)), { type: 'task', priority: 'normal', labels: [], blockedBy: [], criteria: [] });
  assert.deepEqual(plain(model.fieldValues(null)), { type: 'task', priority: 'normal', labels: [], blockedBy: [], criteria: [] });
  // nothing in the data can break it
  assert.deepEqual(plain(model.fieldValues({ type: 'epic', priority: 7, labels: 'ui', blockedBy: [3, null, 'c2'], criteria: [{}, 'ok', ''] })), { type: 'task', priority: 'normal', labels: [], blockedBy: ['c2'], criteria: ['ok'] });
  assert.deepEqual(plain(model.fieldValues({ type: 'bug', priority: 'high', labels: ['a'], blockedBy: ['c2'], criteria: ['x'] })), { type: 'bug', priority: 'high', labels: ['a'], blockedBy: ['c2'], criteria: ['x'] });
  assert.deepEqual(plain(model.faceModel(NEW, ctxOf([NEW]))), { bug: false, priority: '', labels: [], more: 0, blocked: [], blockedTitle: '', criteria: 0, notVerified: false, aria: [] });
  assert.deepEqual(plain(model.fieldFacts(NEW)), []);
});

test('labels are read as lower case words separated by commas, each once, in the order typed', () => {
  assert.deepEqual(plain(model.parseLabels('API, ui ,, api,\nBackend')), ['api', 'ui', 'backend']);
  assert.deepEqual(plain(model.parseLabels('')), []);
  assert.deepEqual(plain(model.parseLabels(' , ,')), []);
  assert.deepEqual(plain(model.parseLabels(undefined)), []);
  assert.deepEqual(plain(model.parseLabels('two words, x')), ['two words', 'x'], 'a space inside a label stays');
  // the length and the number are the server\'s to judge: they are not cut here
  assert.equal(model.parseLabels('x'.repeat(30))[0].length, 30);
});

test('blockers are read as card ids separated by commas or spaces, each once', () => {
  assert.deepEqual(plain(model.parseBlockers('c4, C7 c4,,c9')), ['c4', 'c7', 'c9']);
  assert.deepEqual(plain(model.parseBlockers('  ')), []);
  assert.deepEqual(plain(model.parseBlockers('nonsense')), ['nonsense'], 'a wrong id is the server\'s to refuse');
});

test('criteria are the lines of the editor without the empty ones', () => {
  assert.deepEqual(plain(model.parseCriteria(['  it works ', '', '   ', 'tests pass'])), ['it works', 'tests pass']);
  assert.deepEqual(plain(model.parseCriteria([])), []);
  assert.deepEqual(plain(model.parseCriteria(undefined)), []);
});

test('the patch holds only the fields that changed, and a field back at its default is sent as the default', () => {
  const base = model.fieldValues({ type: 'bug', priority: 'high', labels: ['ui'], blockedBy: ['c2'], criteria: ['a', 'b'] });
  const same = () => plain(base);
  assert.deepEqual(plain(model.fieldsPatch(base, same())), {});
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), priority: 'low' })), { priority: 'low' });
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), type: 'task' })), { type: 'task' });
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), labels: ['ui', 'api'] })), { labels: ['ui', 'api'] });
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), labels: [], criteria: ['a'] })), { labels: [], criteria: ['a'] });
  // a different order is a change; the same lines are not
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), criteria: ['b', 'a'] })), { criteria: ['b', 'a'] });
  assert.deepEqual(plain(model.fieldsPatch(model.fieldValues(NEW), { type: 'bug', priority: 'normal', labels: [], blockedBy: [], criteria: [] })), { type: 'bug' });
  // only the keys the form offers are compared
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), priority: 'low', criteria: [] }, ['type', 'priority', 'labels'])), { priority: 'low' });
  assert.deepEqual(plain(model.fieldsPatch(base, { ...same(), priority: 'low' }, [])), {});
});

test('a milestone is offered no field, a thread and a new card three, a task or idea all five', () => {
  assert.deepEqual(plain(model.fieldKeys('milestone', false)), []);
  assert.deepEqual(plain(model.fieldKeys('milestone', true)), []);
  assert.deepEqual(plain(model.fieldKeys('thread', false)), ['type', 'priority', 'labels']);
  assert.deepEqual(plain(model.fieldKeys('task', true)), ['type', 'priority', 'labels']);
  assert.deepEqual(plain(model.fieldKeys('idea', true)), ['type', 'priority', 'labels']);
  assert.deepEqual(plain(model.fieldKeys('task', false)), ['type', 'priority', 'labels', 'blockedBy', 'criteria']);
  assert.deepEqual(plain(model.fieldKeys('idea', false)), plain(model.FIELD_KEYS));
});

test('a worker is described in words', () => {
  assert.equal(model.workerTitle('main'), 'The main session');
  assert.equal(model.workerTitle('agent:worker'), 'Sub-agent worker');
  assert.equal(model.workerTitle('thread:c4'), 'Side thread c4');
  assert.equal(model.workerTitle('lane:code-codex'), 'Delegation lane code-codex');
  assert.equal(model.workerTitle('something'), 'something');
  assert.equal(model.workerTitle('x:y'), 'x:y');
});

// ---------------------------------------------------------------- the face of a card

test('a face shows a bug, a priority other than normal, three labels and "+N", the open blockers, the criteria and not verified', () => {
  const others = cardsOf(['c2', 'in_progress'], ['c3', 'new'], ['c4', 'done']);
  const card = { ...NEW, type: 'bug', priority: 'high', labels: ['ui', 'api', 'db', 'docs', 'ops'], blockedBy: ['c2', 'c4', 'c3'], criteria: ['a', 'b', 'c'], verified: false, status: 'done' };
  const m = plain(model.faceModel(card, ctxOf([card, ...others])));
  assert.equal(m.bug, true);
  assert.equal(m.priority, 'high');
  assert.deepEqual(m.labels, ['ui', 'api', 'db']);
  assert.equal(m.more, 2);
  assert.deepEqual(m.blocked, ['c2', 'c3'], 'c4 is done, so it holds nothing up');
  assert.equal(m.blockedTitle, 'Blocked by c2 (In progress), c3 (New)');
  assert.equal(m.criteria, 3);
  assert.equal(m.notVerified, true);
  assert.deepEqual(m.aria, ['bug', 'high priority', 'labels ui, api, db, docs, ops', 'blocked by c2, c3', '3 criteria', 'done, not verified']);
  // three labels or fewer have no "+N"
  assert.equal(plain(model.faceModel({ ...NEW, labels: ['a', 'b', 'c'] }, ctxOf([]))).more, 0);
  assert.equal(plain(model.faceModel({ ...NEW, labels: ['a', 'b', 'c', 'd'] }, ctxOf([]))).more, 1);
  // one criterion is singular; low priority is kept, normal is not
  assert.equal(plain(model.faceModel({ ...NEW, criteria: ['x'], priority: 'low' }, ctxOf([]))).aria.join('|'), 'low priority|1 criterion');
  assert.equal(plain(model.faceModel({ ...NEW, priority: 'normal' }, ctxOf([]))).priority, '');
});

test('a card is not blocked once every blocker is done, and a blocker that is gone is not listed', () => {
  const others = cardsOf(['c2', 'done'], ['c3', 'done']);
  assert.deepEqual(plain(model.faceModel({ ...NEW, blockedBy: ['c2', 'c3'] }, ctxOf(others))).blocked, []);
  assert.equal(model.faceModel({ ...NEW, blockedBy: ['c2', 'c3'] }, ctxOf(others)).blockedTitle, '');
  assert.deepEqual(plain(model.faceModel({ ...NEW, blockedBy: ['c9'] }, ctxOf(others))).blocked, []);
});

test('a blocker in any finished stage (the done stage or a later one) holds nothing up; the face asks the page which stages are finished', () => {
  const others = cardsOf(['c2', 'released'], ['c3', 'new']);
  const ctx = { ...ctxOf(others), finished: (c) => c.status === 'done' || c.status === 'released' };
  assert.deepEqual(plain(model.faceModel({ ...NEW, blockedBy: ['c2', 'c3'] }, ctx)).blocked, ['c3']);
  assert.deepEqual(plain(model.faceModel({ ...NEW, blockedBy: ['c2'] }, ctx)).blocked, []);
  assert.match(html, /finished: \(b\) => finishedIn\(b, cfg\(\)\)/, 'the board and the card page give the real rule');
});

test('only a card that says verified: false is marked, and a milestone or a thread shows what it can have', () => {
  assert.equal(model.faceModel({ ...NEW, criteria: ['a'], status: 'done' }, ctxOf([])).notVerified, false);
  assert.equal(model.faceModel({ ...NEW, criteria: ['a'], verified: true }, ctxOf([])).notVerified, false);
  assert.deepEqual(plain(model.faceModel({ id: 'c5', kind: 'milestone', title: 'M', status: 'new', type: 'bug', labels: ['x'], criteria: ['y'] }, ctxOf([]))).aria, []);
  const th = plain(model.faceModel({ id: 'c6', kind: 'thread', title: 'T', status: 'new', type: 'bug', priority: 'low', labels: ['x'], thread: {} }, ctxOf([])));
  assert.deepEqual([th.bug, th.priority, th.labels, th.criteria], [true, 'low', ['x'], 0]);
});

test('a thread page, which has no card form, shows the fields as read-only rows', () => {
  assert.deepEqual(plain(model.fieldFacts({ ...NEW, type: 'bug', priority: 'low', labels: ['a', 'b'], workedBy: ['agent:worker', 'lane:code-codex'] })), [
    ['Type', 'Bug'], ['Priority', 'Low'], ['Labels', 'a, b'], ['Worked by', 'agent:worker, lane:code-codex'],
  ]);
  assert.deepEqual(plain(model.fieldFacts({ ...NEW, priority: 'high' })), [['Priority', 'High']]);
});

// ---------------------------------------------------------------- the marks on a fake DOM

function marksPage() {
  const doc = { createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const mk = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const env = {
    document: doc,
    h(tag, cls, text) { const e = mk(tag, cls); if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = mk('span', 'shape ' + cls); s.setAttribute('aria-hidden', 'true'); return s; },
  };
  const src = `${block('card fields')}\n${block('card field marks')}\n({ faceModel, bugMark, priorityMark, faceLabels, faceTags, workerChips })`;
  return { page: vm.runInNewContext(src, vm.createContext(env)), doc };
}

test('the bug mark has an icon and text for a screen reader; the high mark is two arrows up and the low mark two quiet arrows down', () => {
  const { page } = marksPage();
  const m = (extra, cards = []) => page.faceModel({ ...NEW, ...extra }, ctxOf(cards));
  assert.equal(page.bugMark(m({})), null);
  assert.equal(page.priorityMark(m({})), null);
  const bug = page.bugMark(m({ type: 'bug' }));
  assert.ok(bug.querySelector('.shape.s-beetle'));
  assert.equal(bug.querySelector('.sr-only').textContent, 'bug');
  const hi = page.priorityMark(m({ priority: 'high' }));
  assert.equal(hi.className, 'fmark fm-high');
  assert.equal(hi.querySelector('.sr-only').textContent, 'high priority');
  assert.equal(hi.querySelectorAll('.s-up').length, 2, 'two arrows up');
  assert.equal(hi.title, 'High priority');
  const lo = page.priorityMark(m({ priority: 'low' }));
  assert.equal(lo.className, 'fmark fm-low');
  assert.equal(lo.querySelector('.sr-only').textContent, 'low priority');
  assert.equal(lo.querySelectorAll('.s-dn').length, 2, 'two arrows down');
  assert.equal(lo.title, 'Low priority');
});

test('the labels are chips, three at most and "+N" with all of them in its tooltip', () => {
  const { page } = marksPage();
  const row = page.faceLabels({ ...NEW, labels: ['a', 'b', 'c', 'd', 'e'] }, page.faceModel({ ...NEW, labels: ['a', 'b', 'c', 'd', 'e'] }, ctxOf([])));
  assert.deepEqual(row.querySelectorAll('.cardchip').map((x) => x.textContent), ['a', 'b', 'c', '+2']);
  assert.equal(row.querySelector('.more').title, 'a, b, c, d, e');
  assert.equal(page.faceLabels(NEW, page.faceModel(NEW, ctxOf([]))), null);
  const two = page.faceLabels({ ...NEW, labels: ['a', 'b'] }, page.faceModel({ ...NEW, labels: ['a', 'b'] }, ctxOf([])));
  assert.deepEqual(two.querySelectorAll('.cardchip').map((x) => x.textContent), ['a', 'b']);
});

test('the tags are blocked (with the blockers in its tooltip), the criteria count and not verified; a plain card has none', () => {
  const { page } = marksPage();
  assert.equal(page.faceTags(page.faceModel(NEW, ctxOf([]))).length, 0);
  const card = { ...NEW, blockedBy: ['c2'], criteria: ['a', 'b', 'c'], verified: false };
  const tags = page.faceTags(page.faceModel(card, ctxOf(cardsOf(['c2', 'in_progress']))));
  assert.deepEqual(plain(tags.map((t) => t.textContent)), ['blocked', '3 criteria', 'not verified']);
  assert.equal(tags[0].title, 'Blocked by c2 (In progress)');
  assert.ok(tags[0].querySelector('.s-block'));
  assert.ok(tags[2].className.includes('attn'));
  assert.equal(page.faceTags(page.faceModel({ ...NEW, criteria: ['only'] }, ctxOf([])))[0].textContent, '1 criterion');
});

test('workers are chips with their words as a tooltip, and none gives nothing', () => {
  const { page } = marksPage();
  assert.equal(page.workerChips(undefined), null);
  assert.equal(page.workerChips([]), null);
  const row = page.workerChips(['main', 'agent:worker', 'lane:code-codex']);
  assert.deepEqual(row.querySelectorAll('.cardchip').map((x) => x.textContent), ['main', 'agent:worker', 'lane:code-codex']);
  assert.deepEqual(row.querySelectorAll('.cardchip').map((x) => x.title), ['The main session', 'Sub-agent worker', 'Delegation lane code-codex']);
});

// ---------------------------------------------------------------- the controls on the card page

function editorPage(doneStage = 'done') {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const mk = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const cards = [{ id: 'c2', title: 'Pay', status: 'review', kind: 'task' }, { id: 'c3', title: 'Ship', status: 'done', kind: 'task' }];
  const env = {
    document: doc,
    selKey: 'k1',
    h(tag, cls, text) { const e = mk(tag, cls); if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { return mk('span', 'shape ' + cls); },
    fillSelect: (sel, pairs, want) => { sel.options = pairs; sel.value = want; },
    plainBtn(text, cls, onClick) { const b = mk('button', 'btn' + (cls ? ' ' + cls : '')); b.textContent = text; if (onClick) b.addEventListener('click', onClick); return b; },
    cfg: () => ({ roles: { done: doneStage } }),
    label: (s) => ({ review: 'Review', done: 'Done' })[s] || s,
    findCard: (id) => cards.find((c) => c.id === id) || null,
    hashFor: (k, id) => `#/${k}/${id}`,
    cards: [], stagePairs: null,
  };
  const start = html.indexOf('  function field(labelText');
  const mid = html.indexOf('  // The card fields\' controls');
  const end = html.indexOf('  // startNow: open at');
  assert.ok(start > 0 && mid > start && end > mid, 'the field helper and the editor are in issue.js');
  // `field` and the editor, without the stage helpers between them
  const src = `${html.slice(start, html.indexOf('  const stagePairs', start))}\n${html.slice(mid, end)}\n${block('card fields')}\n${block('card field marks')}\n({ fieldsEditor })`;
  const page = vm.runInNewContext(src, vm.createContext(env));
  return { page, doc };
}

test('the editor reads and writes the fields the way the form model does, and offers only the fields it is given', () => {
  const { page } = editorPage();
  let changes = 0;
  const ed = page.fieldsEditor(['type', 'priority', 'labels', 'blockedBy', 'criteria'], () => { changes++; });
  assert.deepEqual(plain(ed.values()), { type: 'task', priority: 'normal', labels: [], blockedBy: [], criteria: [] });
  ed.set({ type: 'bug', priority: 'low', labels: ['ui', 'api'], blockedBy: ['c2', 'c3', 'c9'], criteria: ['one', 'two'] });
  assert.deepEqual(plain(ed.values()), { type: 'bug', priority: 'low', labels: ['ui', 'api'], blockedBy: ['c2', 'c3', 'c9'], criteria: ['one', 'two'] });
  // the labels are chips, the blockers links with their stage, "(done)" for a finished one, and a note for an id that is no card
  assert.deepEqual(ed.root.querySelectorAll('.cardchip').map((x) => x.textContent), ['ui', 'api']);
  const rows = ed.root.querySelectorAll('li').filter((li) => !li.className.includes('crit-row'));
  assert.equal(rows.length, 3);
  const [a, b, c] = rows;
  assert.equal(a.querySelector('a').href, '#/k1/c2');
  assert.equal(a.querySelector('.blk-stage').textContent, 'Review');
  assert.equal(b.querySelector('.blk-stage').textContent, 'Done', 'a stage called Done does not say it twice');
  assert.equal(c.querySelector('a'), null);
  assert.match(c.textContent, /c9.*No card with this id/);
  assert.equal(!!ed.root.hidden, false);
  ed.show(['type', 'priority', 'labels']);
  const fields = ed.root.children;
  assert.deepEqual(plain(fields.map((f) => !!f.hidden)), [false, false, true, true], 'blockers and criteria are hidden');
  ed.show([]);
  assert.equal(ed.root.hidden, true);
  assert.equal(changes, 0, 'setting values is not a change');
});

test('a blocker in a stage that has the done role says so, unless the stage is called Done already', () => {
  const { page } = editorPage('review');
  const ed = page.fieldsEditor(['blockedBy'], () => {});
  ed.setKey('blockedBy', ['c2', 'c3']);
  assert.deepEqual(plain(ed.root.querySelectorAll('.blk-stage').map((x) => x.textContent)), ['Review (done)', 'Done']);
});

test('criteria can be added and removed one line at a time, up to ten, and an empty line is not a criterion', () => {
  const { page } = editorPage();
  let changes = 0;
  const ed = page.fieldsEditor(['criteria'], () => { changes++; });
  const rows = () => ed.root.querySelectorAll('li');
  const add = () => ed.root.querySelectorAll('button').find((b) => b.textContent === 'Add criterion');
  assert.equal(rows().length, 0);
  add().click();
  assert.equal(rows().length, 1);
  assert.deepEqual(plain(ed.values().criteria), [], 'an empty line is no criterion');
  rows()[0].children[0].value = ' first ';
  add().click();
  rows()[1].children[0].value = 'second';
  assert.deepEqual(plain(ed.values().criteria), ['first', 'second']);
  assert.equal(rows()[1].children[0].getAttribute('aria-label'), 'Criterion 2');
  assert.equal(rows()[1].children[1].getAttribute('aria-label'), 'Remove criterion 2');
  // Enter in a line starts the next one
  const enter = rows()[1].children[0].fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(rows().length, 3);
  // Enter in an empty line adds nothing
  rows()[2].children[0].fire('keydown', { key: 'Enter' });
  assert.equal(rows().length, 3);
  rows()[0].children[1].click();
  assert.deepEqual(plain(ed.values().criteria), ['second']);
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].children[0].getAttribute('aria-label'), 'Criterion 1', 'the lines are numbered again');
  assert.equal(changes, 4);
  // the limit of ten
  ed.setKey('criteria', Array.from({ length: 10 }, (_, i) => 'c' + i));
  assert.equal(add().disabled, true);
  assert.match(add().title, /at most 10/);
  rows()[9].children[1].click();
  assert.equal(add().disabled, false);
});

test('a read-only board disables every control, with the reason', () => {
  const { page } = editorPage();
  const ed = page.fieldsEditor(['type', 'priority', 'labels', 'blockedBy', 'criteria'], () => {});
  ed.setKey('criteria', ['a']);
  ed.setDisabled(true, 'read-only');
  const all = [...ed.root.querySelectorAll('input'), ...ed.root.querySelectorAll('select'), ...ed.root.querySelectorAll('button')];
  assert.ok(all.length >= 6);
  assert.ok(all.every((c) => c.disabled === true && c.title === 'read-only'));
  ed.setDisabled(false);
  assert.ok(all.every((c) => c.disabled === false && c.title === ''));
});

// ---------------------------------------------------------------- the history

test('the history names the worker of an entry, shows what a worker did and what Claude asked, and still skips a type it does not know', () => {
  const run = block('sub-agent runs');
  const { historyRows } = vm.runInNewContext(`${run}; ({ historyRows })`);
  const labelOf = (id) => ({ new: 'New', review: 'Review' })[id] || id;
  const card = { source: 'claude', createdAt: 'T0', history: [
    { at: 'T1', by: 'claude', type: 'created', to: 'new', worker: 'main' },
    { at: 'T2', by: 'claude', type: 'moved', from: 'new', to: 'review', worker: 'agent:worker' },
    { at: 'T3', by: 'claude', type: 'worked', worker: 'lane:code-codex' },
    { at: 'T4', by: 'claude', type: 'waiting', wait: 'c1.w1', kind: 'review', worker: 'thread:c4' },
    { at: 'T5', by: 'user', type: 'edited', fields: ['type', 'labels'] },
    { at: 'T6', by: 'claude', type: 'waiting', wait: 'c1.w2', kind: 'question' },
    { at: 'T7', by: 'claude', type: 'waiting', wait: 'c1.w3', kind: 'from-a-later-version' },
    { at: 'T8', by: 'claude', type: 'from-a-later-version', worker: 'main' },
    { at: 'T9', by: 'user', type: 'worked', worker: 'main' },
  ] };
  assert.deepEqual(plain(historyRows(card, labelOf)), [
    { text: 'Worked on by You', at: 'T9' },
    { text: 'Claude raised a waiting item', at: 'T7' },
    { text: 'Claude asked you a question', at: 'T6' },
    { text: 'You edited the type, labels', at: 'T5' },
    { text: 'Claude (thread:c4) asked you to review it', at: 'T4' },
    { text: 'Worked on by Claude (lane:code-codex)', at: 'T3' },
    { text: 'Claude (agent:worker) moved it from New to Review', at: 'T2' },
    { text: 'Claude (main) created it in New', at: 'T1' },
  ]);
  // an entry without a worker reads as before
  assert.deepEqual(plain(historyRows({ source: 'user', createdAt: 'T0', history: [{ at: 'T1', by: 'claude', type: 'moved', from: 'new', to: 'review' }] }, labelOf)).map((r) => r.text), ['Claude moved it from New to Review', 'You created it']);
});

// ---------------------------------------------------------------- the Type select of a task or idea page: Task, Bug or Idea

test('the Type select is one choice for a task or idea: Idea is the kind, Bug is a task with the type field', () => {
  assert.equal(model.typeChoice({ kind: 'task' }), 'task');
  assert.equal(model.typeChoice({ kind: 'task', type: 'bug' }), 'bug');
  assert.equal(model.typeChoice({ kind: 'idea' }), 'idea');
  assert.equal(model.typeChoice({ kind: 'idea', type: 'bug' }), 'idea', 'a stored bug idea shows as an idea');
  assert.equal(model.typeChoice({ kind: 'task', type: 'nonsense' }), 'task');
});

test('choosing a type sends only what changed, as kind and/or type', () => {
  const patch = (choice, kind, type) => plain(model.typePatch(choice, kind, type));
  assert.deepEqual(patch('task', 'task', 'task'), {}, 'no change');
  assert.deepEqual(patch('task', 'task', undefined), {}, 'no type stored is a task');
  assert.deepEqual(patch('idea', 'task', 'task'), { kind: 'idea' });
  assert.deepEqual(patch('task', 'idea', 'task'), { kind: 'task' });
  assert.deepEqual(patch('bug', 'task', 'task'), { type: 'bug' });
  assert.deepEqual(patch('task', 'task', 'bug'), { type: 'task' });
  assert.deepEqual(patch('bug', 'idea', 'task'), { kind: 'task', type: 'bug' }, 'an idea becomes a bug');
  assert.deepEqual(patch('idea', 'task', 'bug'), { kind: 'idea' }, 'a bug becomes an idea and keeps its type: a bug idea');
  assert.deepEqual(patch('idea', 'idea', 'bug'), {}, 'a bug idea chosen as Idea again is no change');
  assert.deepEqual(patch('task', 'idea', 'bug'), { kind: 'task', type: 'task' }, 'an idea that kept a bug type becomes a plain task');
  assert.deepEqual(patch('bug', 'idea', 'bug'), { kind: 'task' }, 'an idea with the bug type becomes a bug: only the kind changes');
});

test('the card page offers Idea only for an existing task or idea, sends kind with type, and a milestone has no Status or kind', () => {
  assert.match(html, /\.concat\(withIdea \? \[\['idea', 'Idea'\]\] : \[\]\)/);
  assert.match(html, /fieldsEditor\(fxKeys\(\), \(\) => onTouched\(\), !create\)/, 'a new card has its own Type select');
  assert.match(html, /const tp = typePatch\(fp\.type, P\.base\.kind, P\.base\.type\); delete fp\.type; Object\.assign\(fp, tp\);/);
  assert.match(html, /const fStatus = isMs \? null : h\('select', 'input'\);/, 'a milestone has no Status select');
  assert.match(html, /if \(fKind\.value !== 'milestone'\) bodyObj\.status = fStatus\.value;/, 'a new milestone sends no status');
  assert.match(html, /if \(fStatus && fStatus\.value !== P\.base\.status\) patch\.status = fStatus\.value;/);
  assert.match(html, /if \(wStatus\) wStatus\.hidden = fKind\.value === 'milestone';/, 'the Status field goes when Type is Milestone');
  assert.match(html, /metaKind\.textContent = c\.kind;/, 'the Kind row follows the card');
  assert.match(html, /msStateTag\(msStateOf\(m, current\.cards, conf\)\), progressEl\(progressFor\(m\)\)/, 'the state is beside the progress');
});

test('the new-card form does not look for a saved card when it syncs the start button (no error on a keystroke)', () => {
  const start = html.indexOf('    function syncStart()');
  const end = html.indexOf('    // known sessions', start);
  const src = `${block('gear menu actions')}\n${html.slice(start, end)}\nsyncStart`;
  const startBtn = {};
  const sync = vm.runInNewContext(src, {
    create: true, P: { target: '', isDirty: () => true }, card: null, findCard: () => null,
    workerStartBlocked: () => { throw new Error('read a saved card'); }, isRO: () => false, startBtn, goBtn: null, whyEl: {}, startWhyEl: {}, setOff: () => {},
  });
  assert.doesNotThrow(() => sync());
  assert.deepEqual(startBtn, {}, 'nothing is touched');
});

test('a Type choice that the card already is, after its kind changed elsewhere, becomes the baseline instead of leaving the form dirty', () => {
  // an untouched field follows the server; a touched one that now equals the server's value is the baseline, else the user's choice stays
  assert.match(html, /if \(sameField\(nv\[k\], cur\[k\]\)\) P\.base\.fields\[k\] = nv\[k\];\s*return;/);
  // a Save whose patch is empty takes the choice as the baseline too, and the start button follows
  assert.match(html, /if \(FX\) P\.base\.fields\.type = FX\.values\(\)\.type;\s*msgEl\.textContent = 'No changes to save\.';\s*syncStart\(\);/);
});
