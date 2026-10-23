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
  const src = `${block('card fields')}\n${block('card field marks')}\n({ faceModel, bugMark, priorityMark, faceLabels, faceTags, workerChips, hasFull, fullTag })`;
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

test('the Full access tag shows on a task or idea the user allowed it on and on a thread that runs with it, never on a milestone or a plain card', () => {
  const { page } = marksPage();
  assert.equal(page.fullTag(NEW), null);
  assert.equal(page.hasFull(null), false);
  assert.equal(page.fullTag({ ...NEW, allowFull: false }), null);
  assert.equal(page.fullTag({ ...NEW, allowFull: 'yes' }), null, 'only true counts');
  assert.equal(page.fullTag({ ...NEW, kind: 'milestone', allowFull: true }), null, 'a milestone does no work');
  assert.equal(page.fullTag({ ...NEW, kind: 'thread', thread: { mode: 'write' } }), null);
  const on = page.fullTag({ ...NEW, allowFull: true });
  assert.equal(on.textContent, 'Full access');
  assert.ok(on.className.includes('attn') && on.className.includes('full-tag'));
  assert.ok(on.querySelector('.shape.s-diamond'));
  assert.match(on.title, /You allowed full access on this card/);
  const run = page.fullTag({ ...NEW, kind: 'thread', thread: { mode: 'full' } });
  assert.equal(run.textContent, 'Full access');
  assert.match(run.title, /^This thread runs with full access: no sandbox, no permission checks\.$/);
  assert.equal(page.hasFull({ ...NEW, kind: 'thread', allowFull: true, thread: { mode: 'read' } }), false, 'a thread shows the tag only when it runs with full access, whatever its switch says');
  assert.equal(page.hasFull({ ...NEW, kind: 'thread', allowFull: true, thread: { mode: 'full' } }), true);
  assert.equal(page.fullTag({ ...NEW, allowFull: true, fullStale: true }), null, 'a card whose text changed since needs to be allowed again: no tag');
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

test('the history timeline: marker kinds, a move into a finished stage, groups by day and the cut at eight', () => {
  const { historyEvents, historyTimeline, dayLabel, HIST_SHOWN } = vm.runInNewContext(`${block('sub-agent runs')}; ({ historyEvents, historyTimeline, dayLabel, HIST_SHOWN })`);
  assert.equal(HIST_SHOWN, 8);
  const labelOf = (id) => ({ new: 'New', work: 'Working', done: 'Done', released: 'Released' })[id] || id;
  const finished = (id) => id === 'done' || id === 'released';
  const at = (day, hour) => new Date(2026, 9, day, hour, 0, 0).toISOString();
  const card = { source: 'user', createdAt: at(10, 9), history: [
    { at: at(10, 9), by: 'user', type: 'created', to: 'new' },
    { at: at(11, 9), by: 'claude', type: 'moved', from: 'new', to: 'work', worker: 'agent:worker' },
    { at: at(11, 10), by: 'claude', type: 'waiting', wait: 'c1.w1', kind: 'review' },
    { at: at(12, 9), by: 'claude', type: 'moved', from: 'work', to: 'done' },
    { at: at(12, 10), by: 'user', type: 'moved', from: 'done', to: 'released' },
    { at: at(12, 11), by: 'claude', type: 'from-a-later-version' },
  ] };
  const ev = plain(historyEvents(card, labelOf, finished));
  assert.deepEqual(ev.map((e) => e.kind), ['moved', 'done', 'asked', 'moved', 'created']);   // Done to Released is no "done"; the unknown type is skipped
  assert.deepEqual([ev[1].from, ev[1].to, ev[4].to, ev[2].wk], ['Working', 'Done', 'New', 'review']);
  assert.equal(ev[3].worker, 'agent:worker');
  assert.equal(ev[3].text, 'Claude (agent:worker) moved it from New to Working');
  // without a finished() every move is a plain move; a card from before the history has its creation as the one event
  assert.deepEqual(plain(historyEvents(card, labelOf)).map((e) => e.kind), ['moved', 'moved', 'asked', 'moved', 'created']);
  assert.deepEqual(plain(historyEvents({ source: 'claude', createdAt: 'T0' }, labelOf)).map((e) => [e.kind, e.who]), [['created', 'Claude']]);
  // full access: said in words, and an older entry shape still reads as an edit
  const fullHist = plain(historyEvents({ source: 'user', createdAt: 'T0', history: [
    { at: 'T1', by: 'user', type: 'edited', fields: ['full access'], allowed: true },
    { at: 'T2', by: 'user', type: 'edited', fields: ['full access'], allowed: false },
    { at: 'T3', by: 'user', type: 'edited', fields: ['full access'] },
  ] }, labelOf));
  assert.deepEqual(fullHist.map((e) => e.text), ['You edited the full access', 'You took full access away', 'You allowed full access', 'You created it']);

  // days: Today, Yesterday, then a date; a history on one day has one group with no label
  const now = new Date(2026, 9, 13, 15, 0, 0).getTime();
  assert.equal(dayLabel(at(13, 1), now), 'Today');
  assert.equal(dayLabel(at(12, 23), now), 'Yesterday');
  assert.equal(dayLabel(at(10, 9), now), new Date(2026, 9, 10).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  assert.equal(dayLabel('not a time', now), '');
  const t = plain(historyTimeline(ev, false, now));
  assert.deepEqual(t.groups.map((g) => [g.label, g.events.length]), [['Yesterday', 2], [dayLabel(at(11, 9), now), 2], [dayLabel(at(10, 9), now), 1]]);
  assert.deepEqual([t.total, t.hidden], [5, 0]);
  const same = plain(historyTimeline(ev.slice(0, 2).map((e, i) => ({ ...e, at: at(12, 9 + i) })), false, now));
  assert.deepEqual(same.groups.map((g) => [g.label, g.events.length]), [['', 2]]);

  // more than eight events: the newest eight until all are asked for; the groups follow what is shown
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'edited', who: 'You', worker: '', what: 'edited the note', text: '', at: at(1 + Math.floor(i / 3), 12 - i) })).reverse();
  const cut = plain(historyTimeline(many, false, now));
  assert.deepEqual([cut.total, cut.hidden, cut.groups.reduce((n, g) => n + g.events.length, 0)], [12, 4, 8]);
  assert.equal(cut.groups.length > 1, true);
  const all = plain(historyTimeline(many, true, now));
  assert.deepEqual([all.total, all.hidden, all.groups.reduce((n, g) => n + g.events.length, 0)], [12, 0, 12]);
  assert.deepEqual(plain(historyTimeline(many.slice(0, 8), false, now)).hidden, 0);
});

test('the timeline markup is a real list with decorative markers, a time element, and a Show all button', () => {
  assert.match(html, /h\('ol', 'hist-list'\)/);
  assert.match(html, /mark\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(html, /more\.setAttribute\('aria-expanded'/);
  assert.match(html, /'Show all ' \+ t\.total \+ ' events'/);
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

test('the history timeline draws the runs on the card, in time order with the history, with the worker each was of', () => {
  const { historyEvents } = vm.runInNewContext(`${block('sub-agent runs')}; ({ historyEvents })`);
  const labelOf = (id) => ({ work: 'In progress' })[id] || id;
  // the shape of a real card: created by Claude, then two lane runs of threads doing its work, and no other history (2026-10-23)
  const card = { source: 'claude', createdAt: '2026-10-23T11:59:17.527Z', history: [{ at: '2026-10-23T11:59:17.527Z', by: 'claude', type: 'created', to: 'work' }], runs: [
    { n: 1, thread: 'c1', turn: 1, lane: 'think', agentType: 'think', state: 'done', ok: true, startedAt: '2026-10-23T11:59:44.475Z', finishedAt: '2026-10-23T12:04:04.848Z' },
    { n: 2, thread: 'c2', turn: 1, lane: 'debate', agentType: 'debate', state: 'stopped', ok: false, startedAt: '2026-10-23T12:05:13.680Z', finishedAt: '2026-10-23T12:10:01.357Z' },
    { n: 3, agentType: 'worker', state: 'running', startedAt: '2026-10-23T12:11:00.000Z', finishedAt: null },
    { n: 4, thread: 'c5', turn: 1, agentType: 'thread', state: 'done', ok: true, startedAt: '2026-10-23T12:12:00.000Z', finishedAt: '2026-10-23T12:13:00.000Z' },
    { n: 5, state: 'done' },
  ] };
  const ev = plain(historyEvents(card, labelOf));
  assert.deepEqual(ev.map((e) => e.text), [
    'Claude (thread:c5) finished run 4',
    'Claude (thread:c5) started run 4',
    'Claude (agent:worker) started run 3',
    'Claude (lane:debate) run 2 stopped',
    'Claude (lane:debate) started run 2',
    'Claude (lane:think) finished run 1',
    'Claude (lane:think) started run 1',
    'Claude created it in In progress',
  ]);
  assert.deepEqual(ev.slice(0, 4).map((e) => e.kind), ['run-done', 'run', 'run', 'run-stopped']);
  assert.equal(ev[5].worker, 'lane:think');
  assert.deepEqual(plain(historyEvents({ source: 'user', createdAt: 'T0', runs: 'not a list' }, labelOf)).map((e) => e.kind), ['created']);
});

test('the history draws a linked run as its thread or lane, an empty agent type as sub-agent, an open linked run as ended, and only the newest ten runs', () => {
  const { historyEvents } = vm.runInNewContext(`${block('sub-agent runs')}; ({ historyEvents })`);
  const labelOf = (id) => id;
  const at = (m) => new Date(Date.UTC(2026, 9, 23, 0, m)).toISOString();
  const card = { source: 'claude', createdAt: at(0), history: [], runs: [
    { n: 1, thread: 'c7', agentType: 'worker', state: 'done', ok: true, startedAt: at(1), finishedAt: at(2) },
    { n: 2, thread: 'c7', agentType: 'worker', state: 'done', ok: null, startedAt: at(3), finishedAt: at(4) },
    { n: 3, thread: 'c8', lane: 'code-codex', agentType: 'code-codex', state: 'done', ok: true, startedAt: at(5), finishedAt: at(6) },
    { n: 4, agentType: '', state: 'done', startedAt: at(7), finishedAt: at(8) },
    { n: 5, agentType: 'worker', state: 'done', ok: null, startedAt: at(9), finishedAt: at(10) },
  ] };
  assert.deepEqual(plain(historyEvents(card, labelOf)).map((e) => e.text).filter((x) => /finished|ended|stopped/.test(x)), [
    'Claude (agent:worker) finished run 5',
    'Claude (agent:sub-agent) finished run 4',
    'Claude (lane:code-codex) finished run 3',
    'Claude (thread:c7) run 2 ended',
    'Claude (thread:c7) finished run 1',
  ]);
  assert.equal(plain(historyEvents(card, labelOf)).some((e) => /agent:worker\) started run [12]\b/.test(e.text)), false, 'a linked run is never a sub-agent');
  // twelve runs: the newest ten only, with their ends, and the card's own entries all there
  const many = { source: 'claude', createdAt: at(0), history: [{ at: at(0), by: 'claude', type: 'created', to: 'new' }, { at: at(1), by: 'user', type: 'moved', from: 'new', to: 'work' }], runs: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, agentType: 'worker', state: 'done', ok: true, startedAt: at(10 + 2 * i), finishedAt: at(11 + 2 * i) })) };
  const ev = plain(historyEvents(many, labelOf));
  assert.equal(ev.length, 2 + 20);
  assert.equal(ev.filter((e) => e.kind === 'run').length, 10);
  assert.equal(ev.some((e) => /run [12]$|run [12] /.test(e.text) && /run/.test(e.kind)), false, 'runs 1 and 2 are cut');
  assert.equal(ev.at(-1).text, 'Claude created it in new');
  assert.equal(ev.some((e) => e.kind === 'moved'), true);
});

test('the history order does not depend on an entry whose time does not parse: it takes the time of the one before it', () => {
  const { historyEvents } = vm.runInNewContext(`${block('sub-agent runs')}; ({ historyEvents })`);
  const at = (h) => new Date(Date.UTC(2026, 9, 23, h)).toISOString();
  const card = { source: 'claude', createdAt: at(0), history: [
    { at: at(0), by: 'claude', type: 'created', to: 'new' },
    { at: at(5), by: 'claude', type: 'moved', from: 'new', to: 'work' },
    { at: 'not a time', by: 'user', type: 'edited', fields: ['title'] },
    { at: at(6), by: 'claude', type: 'moved', from: 'work', to: 'review' },
  ], runs: [{ n: 1, agentType: 'worker', state: 'done', ok: true, startedAt: at(1), finishedAt: at(4) }] };
  const texts = plain(historyEvents(card, (x) => x)).map((e) => e.text);
  assert.deepEqual(texts, [
    'Claude moved it from work to review',
    'You edited the title',
    'Claude moved it from new to work',
    'Claude (agent:worker) finished run 1',
    'Claude (agent:worker) started run 1',
    'Claude created it in new',
  ]);
  // a first entry that does not parse sits at the card's creation, before everything after it
  const first = { source: 'claude', createdAt: at(0), history: [{ at: 'later maybe', by: 'user', type: 'created', to: 'new' }, { at: at(2), by: 'claude', type: 'moved', from: 'new', to: 'work' }] };
  assert.deepEqual(plain(historyEvents(first, (x) => x)).map((e) => e.text), ['Claude moved it from new to work', 'You created it in new']);
});
