// The board page's "Notify Claude": the gear menu entry, the step on a card's page with the session picker, and the "Claude notified" marker.
// The page's own code runs in a vm; the pieces that sit inside a card page are checked in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const block = (name, end) => {
  const m = new RegExp(`// ---- ${name}[^\\n]*\\n([\\s\\S]*?)// ---- end ${end || name} ----`).exec(html);
  assert.ok(m, `the "${name}" block is missing from the board page`);
  return m[1];
};
// the menu ids the tunnel's page hides (remote.js)
const deniedIds = () => {
  const m = /const REMOTE_DENIED = \[([^\]]*)\]/.exec(html);
  assert.ok(m, 'REMOTE_DENIED is missing from the board page');
  return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
};
const plain = (x) => JSON.parse(JSON.stringify(x));
const run = (code) => vm.runInNewContext(`${block('gear menu actions', 'gear menu actions')}; ${code}`);

const task = (id, extra = {}) => ({ id, kind: 'task', title: `Task ${id}`, note: '', status: 'new', seenByClaude: false, ...extra });
const ctx = (o = {}) => ({ ro: false, stages: [{ id: 'new', label: 'New' }, { id: 'done', label: 'Done' }], choices: [], reportState: () => '', waits: () => 0, ...o });

test('a card can be notified only while it is a task or an idea that is new from the user; a request that is open is "sent"', () => {
  const notifyState = run('notifyState');
  assert.equal(notifyState(task('c1')), 'ready');
  assert.equal(notifyState(task('c1', { kind: 'idea' })), 'ready');
  assert.equal(notifyState(task('c1', { notified: true })), 'sent');
  assert.equal(notifyState(task('c1', { seenByClaude: true })), '', 'Claude has listed it');
  assert.equal(notifyState(task('c1', { seenByClaude: true, notified: true })), 'sent', 'another session listed the card, but the request stays open until the session picked does');
  assert.equal(notifyState(task('c1', { seenByClaude: undefined, notified: true })), 'sent');
  assert.equal(notifyState(task('c1', { seenByClaude: undefined })), '', 'a card an older version wrote has no flag: nothing to point out');
  assert.equal(notifyState(task('c1', { seenByClaude: undefined, newInRepo: true })), 'ready', 'a card that came with a pull (a repo-backed project) can be pointed out too');
  assert.equal(notifyState(task('c1', { newInRepo: true, kind: 'milestone' })), '');
  assert.equal(notifyState(task('c1', { kind: 'thread' })), '');
  assert.equal(notifyState(task('c1', { kind: 'milestone' })), '');
});

test('the gear menu offers "Notify Claude…" under "Answer waiting items", on a task or idea that is new from the user', () => {
  const cardActions = run('cardActions');
  const notify = (c) => (c.notified ? 'sent' : c.seenByClaude === false ? 'ready' : '');
  const a = plain(cardActions(task('c1'), ctx({ notify })));
  assert.deepEqual(a[0], { id: 'notify', label: 'Notify Claude…' });
  assert.deepEqual(a[1], { sep: true });
  assert.equal(a[2].group, 'Move to');
  const both = plain(cardActions(task('c1'), ctx({ notify, waits: () => 2 })));
  assert.deepEqual(both.slice(0, 3), [{ id: 'waits', label: 'Answer waiting items (2)' }, { id: 'notify', label: 'Notify Claude…' }, { sep: true }]);
  assert.equal(plain(cardActions(task('c1', { notified: true }), ctx({ notify })))[0].label, 'Notify Claude again…');
  assert.equal(plain(cardActions(task('c1', { seenByClaude: true }), ctx({ notify }))).some((x) => x.id === 'notify'), false, 'a card Claude has seen');
  assert.equal(plain(cardActions(task('c1', { seenByClaude: true, notified: true }), ctx({ notify })))[0].label, 'Notify Claude again…', 'one that is seen by another session but still has its request');
  assert.equal(plain(cardActions(task('c1'), ctx())).some((x) => x.id === 'notify'), false, 'a context that does not ask adds nothing');
  assert.deepEqual(plain(cardActions(task('c1'), ctx({ notify, ro: true }))), [], 'a read-only board offers nothing that writes');
  const thread = { id: 'c7', kind: 'thread', title: 'T', note: '', status: 'x', seenByClaude: false, thread: { runState: 'idle', lastResult: null } };
  assert.equal(plain(cardActions(thread, ctx({ notify: () => '' }))).some((x) => x.id === 'notify'), false);
  const ms = { id: 'c3', kind: 'milestone', title: 'M', seenByClaude: false };
  assert.deepEqual(plain(cardActions(ms, ctx({ notify }))), [], 'a milestone has its own page actions');
});

test('choosing the entry closes the menu and opens the card page at the step; a chat-only board offers none; the tunnel does not hide it', () => {
  const src = block('gear menu \\(page\\.test', 'gear menu');
  const m = /if \(a\.id === 'notify'\) \{\n([\s\S]*?)\n    \}/.exec(src);
  assert.ok(m, 'menuDo handles it');
  assert.match(m[1], /closeMenu\(false\);\n\s+notifyFor = id;/);
  assert.match(m[1], /setTimeout\(\(\) => \{ if \(notifyFor === id\) notifyFor = ''; \}, 1500\);/, 'the request does not outlive the page opening');
  assert.match(m[1], /openCard\(id, true\);/);
  assert.match(src, /notify: \(c\) => \(isChat\(\) \? '' : notifyState\(c\)\)/);
  assert.match(html, /const notifyNow = notifyFor === target;\n\s+notifyFor = '';/);
  assert.match(html, /else buildTaskPanel\(card, startNow, notifyNow\);/);
  assert.deepEqual(deniedIds(), ['start', 'end', 'delete'], 'the server allows it through the tunnel on purpose, so the page does not hide it');
});

test('the card page asks which session, preselects the most recently active one, posts to the notify route and shows "Claude notified"', () => {
  const issue = html.slice(html.indexOf('function buildTaskPanel'), html.indexOf('// "Cards in this milestone"'));
  // the same list as Start as thread, most recently active first
  assert.match(issue, /function startSessions\(\) \{[\s\S]*?\.sort\(\(a, b\) => String\(b\[1\]\.lastSeenAt \|\| ''\)\.localeCompare\(String\(a\[1\]\.lastSeenAt \|\| ''\)\)\);/);
  const step = /if \(P\.notifying\) \{([\s\S]*?)\n      \}\n      if \(P\.confirmDelete\)/.exec(issue);
  assert.ok(step, 'a foot step for it');
  assert.match(step[1], /const list = notifySessions\(\);/);
  assert.match(step[1], /field\('Session to notify', sel, 'f-notify-session'\)/);
  assert.match(step[1], /actionBtn\('Notify', 'primary', 'notify:' \+ selKey \+ ':' \+ card\.id, \(\) => doNotify\(sel\.value\)\)/);
  assert.match(step[1], /No recent session in this project\./, 'with no session known there is nothing to pick');
  assert.match(step[1], /setOff\(go, true\);/, 'and the button is there, disabled');
  assert.doesNotMatch(step[1], /innerHTML/);
  assert.match(issue, /api\('POST', pp\(pk, 'cards\/' \+ encodeURIComponent\(card\.id\) \+ '\/notify'\), \{ session \}\)/);
  assert.match(issue, /plainBtn\(nf === 'sent' \? 'Notify again' : 'Notify Claude'/, 'a button in the foot, beside Start as thread');
  assert.match(issue, /if \(c\.notified === true\) seenWrap\.appendChild\(notifiedEl\(/);
  assert.match(issue, /const ns = notifyState\(c\);\n\s+if \(!ns\) P\.notifying = false;\n\s+if \(P\.notifySig !== undefined && P\.notifySig !== ns\) renderFoot\(\);/, 'the button goes with the unseen flag');
  assert.match(issue, /if \(ro\) P\.confirmDelete = P\.starting = P\.notifying = false;/);
  assert.match(issue, /const nf = isChat\(\) \? '' : notifyState\(findCard\(P\.target\) \|\| card\);/, 'not in a chat-only project');
});

test('the card face and the page show "Claude notified" beside "Claude has not seen this yet", as text', () => {
  const face = html.slice(html.indexOf("if (card.seenByClaude === false) foot.appendChild(unseenEl('span'));"), html.indexOf('const rs = thread ?'));
  assert.match(face, /if \(card\.notified === true\) foot\.appendChild\(notifiedEl\('span', card\)\);/);
  assert.match(html, /\(card\.notified === true \? ', Claude notified' : ''\)\);/, 'a screen reader hears it');
  const el = html.slice(html.indexOf('function notifiedEl'), html.indexOf('// The board’s settings'.replace('’', "'")));
  assert.match(el, /u\.appendChild\(h\('span', null, 'Claude notified'\)\)/);
  assert.match(el, /u\.title = 'Asked ' \+ sessionLabel\(card\.notifySession\)/);
  assert.doesNotMatch(el, /innerHTML/);
  assert.match(html, /\.notified \{ display: inline-flex;[^}]*color: var\(--ok\);/);
});

test('the picker offers the sessions active in the last 7 days and the most recent one, whatever its age', () => {
  const issue = html.slice(html.indexOf('function buildTaskPanel'), html.indexOf('// "Cards in this milestone"'));
  const fn = /(const NOTIFY_RECENT_MS[\s\S]*?function notifySessions\(\) \{[\s\S]*?\n    \})/.exec(issue);
  assert.ok(fn, 'notifySessions is on the card page');
  const day = 24 * 3600 * 1000;
  const ago = (d) => new Date(Date.now() - d * day).toISOString();
  const pick = (sessions) => vm.runInNewContext(`${fn[1]}; notifySessions()`, { startSessions: () => Object.keys(sessions).map((id) => [id, sessions[id]]).sort((a, b) => String(b[1].lastSeenAt || '').localeCompare(String(a[1].lastSeenAt || ''))), Date, String });
  const ids = (sessions) => pick(sessions).map(([id]) => id);
  assert.deepEqual(ids({ a: { lastSeenAt: ago(1) }, b: { lastSeenAt: ago(6) }, c: { lastSeenAt: ago(8) }, d: { lastSeenAt: ago(40) }, e: { lastSeenAt: null } }), ['a', 'b'], 'ended sessions stay out');
  assert.deepEqual(ids({ c: { lastSeenAt: ago(8) }, d: { lastSeenAt: ago(40) } }), ['c'], 'the most recent one stays, however old');
  assert.deepEqual(ids({ e: { lastSeenAt: null } }), ['e'], 'a session known only from a thread is still the only choice');
  assert.deepEqual(ids({}), [], 'none: the step says so and the button is disabled');
});
