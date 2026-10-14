import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { SERVER_DIR, FakeEl } from './helpers.mjs';
import { assembleBoardPage, CSS_PIECES, JS_PIECES } from '../server/page.mjs';

const html = await assembleBoardPage();

const BOARD_DIR = path.join(SERVER_DIR, 'board');
const PIECES = ['page.html', ...CSS_PIECES, ...JS_PIECES];
const PIECE_LIMIT = 204800;   // 200 KB, under the plugin directory's 256 KiB file limit with room to grow

test('the board page pieces each stay under 200 KB', () => {
  for (const name of PIECES) {
    const size = fs.statSync(path.join(BOARD_DIR, name)).size;
    assert.ok(size < PIECE_LIMIT, `${name} is ${size} bytes, the limit is ${PIECE_LIMIT}`);
  }
});

test('the style and script pieces cannot end their own tag', () => {
  const read = (name) => fs.readFileSync(path.join(BOARD_DIR, name), 'utf8');
  for (const name of JS_PIECES) assert.doesNotMatch(read(name), /<\/script/i, name);
  for (const name of CSS_PIECES) assert.doesNotMatch(read(name), /<\/style/i, name);
});

test('every file in the style and script folders is listed in page.mjs, and every listed file exists', () => {
  for (const [dir, listed] of [['css', CSS_PIECES], ['js', JS_PIECES]]) {
    const onDisk = fs.readdirSync(path.join(BOARD_DIR, dir)).map((f) => `${dir}/${f}`).sort();
    assert.deepEqual(onDisk, [...listed].sort(), `${dir}: the files in the folder and the list in page.mjs differ`);
    assert.equal(new Set(listed).size, listed.length, `${dir}: a piece is listed twice`);
  }
});

test('the assembled page has no placeholder left and keeps the version marker', () => {
  assert.doesNotMatch(html, /__BOARD_(CSS|JS)__/);
  assert.ok(html.includes('__THREAD_VERSION__'), 'the server fills the version in');
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.equal((html.match(/<script>/g) || []).length, 2);
});

test('a lost placeholder or a missing piece fails the assembly instead of serving a page without style or script', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-pieces-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of PIECES) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.copyFileSync(path.join(BOARD_DIR, name), path.join(dir, name));
  }
  const url = pathToFileURL(dir + path.sep);
  assert.equal(await assembleBoardPage(url), html);
  const page = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
  fs.writeFileSync(path.join(dir, 'page.html'), page.replace('/*__BOARD_JS__*/', ''));
  await assert.rejects(assembleBoardPage(url), /__BOARD_JS__/);
  fs.writeFileSync(path.join(dir, 'page.html'), page);
  for (const name of [CSS_PIECES[0], CSS_PIECES.at(-1), JS_PIECES[0], JS_PIECES.at(-1)]) {
    const file = path.join(dir, name);
    const text = fs.readFileSync(file);
    fs.rmSync(file);
    await assert.rejects(assembleBoardPage(url), /ENOENT/, name);
    fs.writeFileSync(file, text);
  }
  assert.equal(await assembleBoardPage(url), html);
});

test('every inline script in the board page compiles', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'no inline script found');
  blocks.forEach((code, i) => {
    try {
      new vm.Script(code);
    } catch (e) {
      assert.fail(`inline script block ${i} does not compile: ${e.message}`);
    }
  });
});

test('the board page builds the page without innerHTML-style sinks and loads nothing from the network', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!html.includes(sink), `the board page uses ${sink}`);
  }
  // the SVG namespace names the kind of element createElementNS makes; it is never fetched
  assert.doesNotMatch(html.replaceAll('http://www.w3.org/2000/svg', ''), /https?:\/\//);
});

function versionPage() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) {
      const n = { hidden: true, writes: 0, _text: '', addEventListener(type, fn) { this[type] = fn; } };
      Object.defineProperty(n, 'textContent', { get() { return this._text; }, set(v) { this._text = v; this.writes++; } });
      nodes.set(id, n);
    }
    return nodes.get(id);
  };
  let response = { version: '0.9.0' }, failure = false, ok = true, reloads = 0;
  const requests = [];
  const block = /\/\/ ---------- plugin version ----------\n([\s\S]*?)\/\/ ---------- access token ----------/.exec(html);
  assert.ok(block);
  const fns = vm.runInNewContext(block[1] + '; ({ refreshVersion, showVersionNote })', {
    $, document: { querySelector: () => ({ content: '0.9.0' }) },
    location: { reload() { reloads++; } }, parseJson: JSON.parse,
    request: async (...args) => {
      requests.push(args);
      if (failure) throw new Error('offline');
      return { res: { ok }, text: JSON.stringify(response) };
    },
  });
  return { $, refresh: fns.refreshVersion, show: fns.showVersionNote, requests, reloads: () => reloads, respond(data, status = true) { response = data; ok = status; }, fail() { failure = true; } };
}

const NEWER = (v) => `This page is from version 0.9.0, but the board is now served by version ${v}. Reload the page.`;
const OLDER = (v) => `This page is from version 0.9.0, but the board is now served by an older session on version ${v}. Run /thread:board in an updated session, then reload this page.`;

test('the page keeps its served version, compares versions as numbers and reloads only for a newer server', async () => {
  const p = versionPage();
  assert.equal(p.$('plugin-version').textContent, 'v0.9.0');
  await p.refresh();
  assert.equal(p.$('version-note').hidden, true);
  // 0.10.0 is newer than 0.9.0 (a string comparison would say older); a version that is not x.y.z but differs counts as newer
  for (const [version, text, reload] of [['0.10.0', NEWER('0.10.0'), true], ['0.9.1', NEWER('0.9.1'), true], ['0.8.0', OLDER('0.8.0'), false], ['0.8.9', OLDER('0.8.9'), false], ['<b>9.9.9</b>', NEWER('<b>9.9.9</b>'), true]]) {
    p.respond({ version });
    await p.refresh();
    assert.equal(p.$('version-note').hidden, false, version);
    assert.equal(p.$('version-text').textContent, text, version);
    assert.equal(p.$('version-reload').hidden, !reload, `${version}: the Reload button is for a newer server only`);
    assert.equal(p.$('plugin-version').textContent, 'v0.9.0');
  }
  p.respond({ version: '0.9.0' });
  await p.refresh();
  assert.equal(p.$('version-note').hidden, true);
  assert.equal(p.$('version-text').textContent, '');
  p.respond({ version: '0.10.0' });
  await p.refresh();
  p.$('version-reload').click();
  assert.equal(p.reloads(), 1);
  assert.deepEqual(p.requests[0], ['GET', '/api/ping', null, 5000]);
  assert.match(html, /id="plugin-version" title="thread plugin version"/);
  assert.match(html, /id="version-note" role="status" hidden/);
  assert.match(html, /id="old-note" role="status" hidden/);
});

test('the version note gives way to the older-session note, and its text is written only when it changes', async () => {
  const p = versionPage();
  p.respond({ version: '0.10.0' });
  await p.refresh();
  assert.equal(p.$('version-note').hidden, false);
  const writes = p.$('version-text').writes;
  for (let i = 0; i < 3; i++) await p.refresh();
  assert.equal(p.$('version-text').writes, writes, 'a poll that finds the same version leaves the status text alone');
  p.$('old-note').hidden = false;                // the older-session note is showing
  p.show();
  assert.equal(p.$('version-note').hidden, true, 'two contradicting notes are never shown together');
  await p.refresh();
  assert.equal(p.$('version-note').hidden, true);
  p.$('old-note').hidden = true;
  p.show();
  assert.equal(p.$('version-note').hidden, false);
  assert.equal(p.$('version-text').textContent, NEWER('0.10.0'));
  assert.match(html, /elOldNote\.hidden = !\(current && !current\.config\);\n\s+showVersionNote\(\);/, 'the toolbar update re-decides which note shows');
});

test('missing versions and failed version requests hide the mismatch note', async () => {
  const p = versionPage();
  for (const response of [{}, null, { version: '' }, { version: 123 }]) {
    p.respond({ version: '0.10.0' });
    await p.refresh();
    p.respond(response);
    await p.refresh();
    assert.equal(p.$('version-note').hidden, true);
  }
  p.respond({ version: '0.10.0' }, false);
  await p.refresh();
  assert.equal(p.$('version-note').hidden, true);
  p.respond({ version: '0.10.0' });
  await p.refresh();
  p.fail();
  await p.refresh();
  assert.equal(p.$('version-note').hidden, true);
  assert.equal(p.$('version-text').textContent, '');
});

test('the poll loop asks for the server version every few seconds and stops once the access page shows', async () => {
  const m = /\/\/ ---- tick[^\n]*\n([\s\S]*?)\/\/ ---- end tick ----/.exec(html);
  assert.ok(m, 'the tick block is missing from the board page');
  const run = async (state) => {
    const calls = [];
    const g = { halted: false, projects: [], projectsAt: Date.now(), versionAt: 0, lanesAt: 0, selKey: 'k', PROJECTS_MS: 5000, POLL_MS: 2000, loopTimer: 1, ...state };
    const ctx = vm.createContext({
      ...g,
      poll: async () => { calls.push('poll'); if (g.haltAfterPoll) ctx.halted = true; },
      refreshProjects: async () => { calls.push('projects'); },
      refreshVersion: async () => { calls.push('version'); },
      refreshLanes: () => { calls.push('lanes'); return new Promise(() => {}); },   // never settles: the loop must not wait for it
      setTimeout: () => { calls.push('timer'); return 7; },
    });
    vm.runInContext(m[1].replace(/^\s*async function tick/m, 'globalThis.tick = async function tick'), ctx);
    await ctx.tick();
    return calls;
  };
  assert.deepEqual(await run({}), ['poll', 'version', 'lanes', 'timer']);
  assert.deepEqual(await run({ versionAt: Date.now(), lanesAt: Date.now() }), ['poll', 'timer'], 'asked at most every PROJECTS_MS');
  assert.deepEqual(await run({ lanesAt: Date.now() }), ['poll', 'version', 'timer'], 'the lanes have a clock of their own');
  assert.deepEqual(await run({ haltAfterPoll: true }), ['poll'], 'no more requests after the access page shows');
});

// The pure token and agent helpers sit between two marker comments so they can be run without a DOM.
function pageHelpers() {
  const m = /\/\/ ---- tokens and agents[^\n]*\n([\s\S]*?)\/\/ ---- end tokens and agents ----/.exec(html);
  assert.ok(m, 'the helper block is missing from the board page');
  return vm.runInNewContext(`${m[1]}; ({ fmtTokens, turnTokens, threadTokens, tokensText, totalText, agentLabel, modelText, isBrief })`);
}

test('fmtTokens keeps three significant digits', () => {
  const { fmtTokens } = pageHelpers();
  const cases = [[0, '0'], [945, '945'], [999, '999'], [1000, '1k'], [1234, '1.23k'], [48200, '48.2k'], [99950, '100k'], [120400, '120k'], [999499, '999k'], [999500, '1M'], [1350000, '1.35M'], [12500000, '12.5M'], [250000000, '250M']];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, String(n));
  assert.equal(fmtTokens(undefined), '0');
  assert.equal(fmtTokens(NaN), '0');
});

// objects built inside the vm have another Object prototype
const plain = (x) => JSON.parse(JSON.stringify(x));

test('thread tokens count input, cache reads and cache writes as "in" and add up over the turns that have usage', () => {
  const { turnTokens, threadTokens, tokensText, totalText } = pageHelpers();
  const a = { usage: { input: 100, cacheRead: 40000, cacheWrite: 7000, output: 1100 } };
  const b = { usage: { input: 5, cacheRead: 900, cacheWrite: 0, output: 400 } };
  assert.deepEqual(plain(turnTokens(a)), { in: 47100, out: 1100 });
  assert.equal(turnTokens({}), null);
  assert.equal(turnTokens({ usage: 'x' }), null);
  assert.equal(threadTokens([{}, {}]), null);
  assert.equal(threadTokens([]), null);
  const sum = threadTokens([a, {}, b]);
  assert.deepEqual(plain(sum), { in: 48005, out: 1500 });
  assert.equal(tokensText(sum), '48k in · 1.5k out');
  assert.equal(totalText(turnTokens(a)), '48.2k tokens');
  assert.deepEqual(plain(turnTokens({ usage: { output: 7 } })), { in: 0, out: 7 }, 'missing fields count as zero');
});

test('agent and model labels leave out what is missing and name xhigh "extra-high"', () => {
  const { agentLabel, modelText, isBrief } = pageHelpers();
  assert.equal(agentLabel({ name: 'worker', model: 'claude-sonnet-5-5', effort: 'xhigh' }), 'worker · claude-sonnet-5-5 · extra-high');
  assert.equal(agentLabel({ name: 'critic', model: null, effort: 'high' }), 'critic · high');
  assert.equal(agentLabel({ name: 'plain', model: null, effort: null }), 'plain');
  assert.equal(modelText({ model: 'claude-opus-5-5', effort: 'max' }), 'claude-opus-5-5 · max');
  assert.equal(modelText({ model: null, effort: 'low' }), 'low');
  assert.equal(modelText({ model: null, effort: null }), '');
  assert.equal(modelText({}), '');
  assert.equal(isBrief({ context: 'brief' }), true);
  assert.equal(isBrief({ context: 'full' }), false);
  assert.equal(isBrief({}), false, 'a thread without the field is an old, full one');
});

test('the start step sends context and agent, and asks for the agent list when it opens', () => {
  assert.match(html, /\{ sessionId, mode, context, agent: agent \|\| undefined \}/);
  assert.match(html, /pp\(pk, 'agents'\)/);
  assert.match(html, /'Same as session'/);
  assert.match(html, /Copies the whole session; uses far more tokens\./);
  assert.match(html, /Gets only this card’s title and note\./);
});

// The pure milestone and stage helpers sit between two marker comments too.
function milestoneHelpers() {
  const m = /\/\/ ---- milestones and stages[^\n]*\n([\s\S]*?)\/\/ ---- end milestones and stages ----/.exec(html);
  assert.ok(m, 'the milestone helper block is missing from the board page');
  return vm.runInNewContext(`${m[1]}; ({ NO_MS, isThread, clip, chatStages, matches, childrenOf, progressOf, groupByStage, milestoneReport })`);
}

const STAGES4 = [{ id: 'todo', label: 'To do' }, { id: 'doing', label: 'Doing' }, { id: 'check', label: 'Checking' }, { id: 'done', label: 'Done' }];
const card = (id, kind, title, status, extra = {}) => ({ id, kind, title, note: '', status, ...extra });

test('the board takes its columns from the config, not from a fixed list of six', () => {
  assert.doesNotMatch(html, /STATUSES/);
  assert.doesNotMatch(html, /repeat\(6,/);
  assert.match(html, /repeat\(var\(--cols, 6\),/g);
  assert.match(html, /setProperty\('--cols', String\(stages\.length\)\)/);
  assert.match(html, /current\.config/);
});

test('chat-only shows the columns of the thread roles, in stage order', () => {
  const { chatStages } = milestoneHelpers();
  const ids = (x) => plain(x).map((s) => s.id);
  const roles = { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' };
  assert.deepEqual(ids(chatStages({ stages: STAGES4, roles })), ['doing', 'check', 'done']);
  const six = [{ id: 'idea', label: 'Idea' }, { id: 'new', label: 'New' }, { id: 'in_progress', label: 'In progress' }, { id: 'review', label: 'Review' }, { id: 'blocked', label: 'Blocked' }, { id: 'done', label: 'Done' }];
  assert.deepEqual(ids(chatStages({ stages: six, roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' } })), ['in_progress', 'review', 'blocked', 'done']);
});

test('the milestone filter shows the milestone and its cards, or the cards of no milestone, and joins the other filters', () => {
  const { matches, NO_MS } = milestoneHelpers();
  const m = card('c1', 'milestone', 'Launch', 'doing');
  const inside = card('c2', 'task', 'Fix links', 'todo', { parent: 'c1' });
  const outside = card('c3', 'task', 'Proofread', 'todo');
  const other = card('c4', 'task', 'Else', 'todo', { parent: 'c9' });
  const thr = card('c5', 'thread', 'Look into it', 'doing', { parent: 'c1', thread: { parentSessionId: 's1' } });
  const f = (o) => ({ q: '', threadsOnly: false, session: '', milestone: '', ...o });
  assert.deepEqual([m, inside, outside, other, thr].filter((c) => matches(c, f({ milestone: 'c1' }))).map((c) => c.id), ['c1', 'c2', 'c5']);
  assert.deepEqual([m, inside, outside, other, thr].filter((c) => matches(c, f({ milestone: NO_MS }))).map((c) => c.id), ['c3'], 'a milestone is not "no milestone"');
  assert.equal([m, inside, outside, other, thr].filter((c) => matches(c, f({}))).length, 5);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', threadsOnly: true }))).map((c) => c.id), ['c5']);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', q: 'links' }))).map((c) => c.id), ['c2']);
  assert.deepEqual([m, inside, thr].filter((c) => matches(c, f({ milestone: 'c1', session: 's1' }))).map((c) => c.id), ['c5']);
});

test('milestone progress counts the cards in the done stage; the report groups them by stage', () => {
  const { progressOf, groupByStage, milestoneReport, clip } = milestoneHelpers();
  const m = card('c1', 'milestone', 'Docs v2', 'doing');
  const cards = [
    m,
    card('c2', 'task', 'Fix links', 'todo', { parent: 'c1' }),
    card('c3', 'task', 'Search box', 'doing', { parent: 'c1' }),
    card('c4', 'thread', 'Look into the build', 'check', { parent: 'c1', thread: { runState: 'idle' } }),
    card('c5', 'task', 'Changelog', 'done', { parent: 'c1' }),
    card('c6', 'idea', 'Not in it', 'done'),
  ];
  assert.deepEqual(plain(progressOf(cards, 'c1', 'done')), { done: 1, total: 4 });
  assert.deepEqual(plain(progressOf(cards, 'c6', 'done')), { done: 0, total: 0 });
  assert.deepEqual(groupByStage(cards.filter((c) => c.parent === 'c1'), STAGES4).map((g) => [g.stage.id, g.cards.length]), [['todo', 1], ['doing', 1], ['check', 1], ['done', 1]]);
  assert.equal(milestoneReport(m, cards, STAGES4, 'done'), [
    'Milestone c1 "Docs v2": 1 of 4 done.',
    'To do (1)', '- c2 [task] Fix links',
    'Doing (1)', '- c3 [task] Search box',
    'Checking (1)', '- c4 [thread:idle] Look into the build',
    'Done (1)', '- c5 [task] Changelog',
  ].join('\n'));
  assert.equal(milestoneReport(card('c9', 'milestone', 'Empty', 'todo'), [], STAGES4, 'done'), 'Milestone c9 "Empty": 0 of 0 done.\nNo cards in this milestone yet.');
  assert.equal(clip('  a   long\ntitle ', 100), 'a long title');
  assert.equal(clip('x'.repeat(40), 30), 'x'.repeat(29) + '…');
});

test('a milestone page links to its cards, copies a report and offers no thread start', () => {
  assert.match(html, /Cards in this milestone/);
  assert.match(html, /'Copy report'/);
  assert.match(html, /\['task', 'idea', 'milestone'\]/);
  assert.match(html, /a\[href\]/, 'the focus trap reaches the card links');
  assert.match(html, /if \(!isMs\) \{[^}]*Start as thread/s);
});

test('the new-card form and thread pages send parent, and a cleared one is sent as an empty string', () => {
  assert.match(html, /bodyObj\.parent = fMs\.value/);
  assert.match(html, /patch\.parent = fMs\.value/);
  assert.match(html, /\{ parent \}/);
  assert.match(html, /setParent\(card\.id, sel\.value/);
});

// The gear menu's choice of actions sits between two marker comments, so it runs on its own.
function gearActions() {
  const m = /\/\/ ---- gear menu actions[^\n]*\n([\s\S]*?)\/\/ ---- end gear menu actions ----/.exec(html);
  assert.ok(m, 'the gear menu block is missing from the board page');
  return vm.runInNewContext(`${m[1]}; cardActions`);
}
const reportOf = (c) => (!c.thread || c.thread.lastResult == null ? '' : c.thread.reported ? 'yes' : c.thread.reportRequestedAt ? 'queued' : 'not');
const ctx = (o = {}) => ({ ro: false, stages: STAGES4, choices: [], reportState: reportOf, ...o });
const flat = (list) => plain(list).flatMap((a) => (a.items ? a.items : a.sep ? [] : [a]));
const ids = (list) => flat(list).map((a) => a.id);
const thr = (runState, extra = {}) => card('c7', 'thread', 'Look into it', 'doing', { thread: { runState, lastResult: null, ...extra } });

test('gear menu: a thread offers End thread, Report to main session and Delete under the same conditions as its page', () => {
  const cardActions = gearActions();
  assert.deepEqual(ids(cardActions(thr('idle', { lastResult: 'x' }), ctx())), ['end', 'report', 'delete']);
  assert.deepEqual(ids(cardActions(thr('idle'), ctx())), ['end', 'delete'], 'no result yet, nothing to report');
  assert.deepEqual(ids(cardActions(thr('ended', { lastResult: 'x' }), ctx())), ['report', 'delete'], 'an ended thread cannot be ended again');
  assert.deepEqual(ids(cardActions(thr('ended', { lastResult: 'x', reported: true }), ctx())), ['delete'], 'a reported result needs no report');
  const queued = flat(cardActions(thr('idle', { lastResult: 'x', reportRequestedAt: 't' }), ctx())).find((a) => a.id === 'report');
  assert.deepEqual([queued.label, queued.on], ['Cancel queued report', false], 'a queued report offers its cancel');
  const fresh = flat(cardActions(thr('idle', { lastResult: 'x' }), ctx())).find((a) => a.id === 'report');
  assert.deepEqual([fresh.label, fresh.on], ['Report to main session', true]);
  const del = (c) => flat(cardActions(c, ctx())).find((a) => a.id === 'delete');
  assert.equal(del(thr('running')).disabled, true, 'Delete is unavailable while a turn is running');
  assert.match(del(thr('running')).why, /turn is running/);
  assert.equal(!!del(thr('idle')).disabled, false);
});

test('gear menu: a task or idea can move to every other stage, join a milestone, start as a thread and be deleted', () => {
  const cardActions = gearActions();
  const t = card('c2', 'task', 'Fix links', 'doing', { parent: 'c1' });
  const out = plain(cardActions(t, ctx({ choices: [['c1', 'Launch'], ['c9', 'Docs']] })));
  assert.deepEqual(out.map((a) => a.group || (a.sep ? '-' : a.id)), ['Move to', 'Set milestone', '-', 'start', 'delete']);
  const stages = out[0].items;
  assert.deepEqual(stages.map((a) => a.value), ['todo', 'doing', 'check', 'done'], 'the stages come from the config');
  assert.deepEqual(stages.map((a) => [a.checked, a.disabled]), [[false, false], [true, true], [false, false], [false, false]], 'the current stage is marked and disabled');
  const ms = out[1].items;
  assert.deepEqual(ms.map((a) => [a.value, a.label, a.checked]), [['', 'No milestone', false], ['c1', 'Launch', true], ['c9', 'Docs', false]]);
  assert.ok(ms.every((a) => a.radio) && stages.every((a) => a.radio));
  const none = plain(cardActions(card('c3', 'idea', 'Loyalty', 'todo', { parent: 'gone' }), ctx({ choices: [['c1', 'Launch']] })));
  assert.equal(none[1].items.find((a) => a.checked).value, '', 'a missing milestone counts as none');
  assert.deepEqual(plain(cardActions(t, ctx())).map((a) => a.group || (a.sep ? '-' : a.id)), ['Move to', '-', 'start', 'delete'], 'no milestone to pick, no milestone group');
});

test('gear menu: criteria or blockers disable Start as thread with a reason for tasks and ideas', () => {
  const cardActions = gearActions();
  for (const kind of ['task', 'idea']) {
    for (const fields of [{ criteria: ['Tests pass'] }, { blockedBy: ['c9'] }, { criteria: ['Tests pass'], blockedBy: ['c9'] }]) {
      const start = flat(cardActions(card('c2', kind, 'Card', 'todo', fields), ctx())).find((a) => a.id === 'start');
      assert.equal(start.disabled, true);
      assert.equal(start.why, 'A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first.');
    }
    for (const fields of [{}, { criteria: [], blockedBy: [] }]) {
      const start = flat(cardActions(card('c2', kind, 'Card', 'todo', fields), ctx())).find((a) => a.id === 'start');
      assert.equal(start.disabled, false);
      assert.equal(start.why, '');
    }
  }
});

test('gear menu: a milestone offers Copy report and Delete, and a read-only board only what does not write', () => {
  const cardActions = gearActions();
  const m = card('c1', 'milestone', 'Launch', 'doing');
  assert.deepEqual(ids(cardActions(m, ctx())), ['copy', 'delete']);
  assert.deepEqual(ids(cardActions(m, ctx({ ro: true }))), ['copy'], 'copying changes nothing');
  assert.deepEqual(ids(cardActions(card('c2', 'task', 'T', 'todo'), ctx({ ro: true }))), []);
  assert.deepEqual(ids(cardActions(thr('idle', { lastResult: 'x' }), ctx({ ro: true }))), [], 'no gear when nothing applies');
  assert.deepEqual(ids(cardActions(card('c8', 'thread', 'Broken', 'doing'), ctx())), [], 'a thread card without its thread data has nothing to do');
});

test('gear menu: each action calls the code its card page calls', () => {
  // the menu and the pages share these functions
  for (const fn of ['endThread', 'deleteCard', 'requestReport', 'setParent', 'copyOrWarn']) {
    assert.match(html, new RegExp(`async function ${fn}\\(`), `${fn} is one shared function`);
  }
  assert.match(html, /endThread\(id\);/);
  assert.match(html, /deleteCard\(id, \(ok, here\)/);
  assert.match(html, /requestReport\(id, a\.on\)/);
  assert.match(html, /moveCard\(id, a\.value\)/);
  assert.match(html, /setParent\(id, a\.value\)/);
  assert.match(html, /await endThread\(card\.id,/);
  assert.match(html, /await deleteCard\(card\.id,/);
  assert.match(html, /await deleteCard\(id,/);
  assert.match(html, /await requestReport\(card\.id, on,/);
  assert.match(html, /milestoneReport\(card, current\.cards, conf\.stages, conf\.roles\.done\)/);
  // each request is made in one place only
  assert.equal(html.split("'/end'").length, 2);
  assert.equal(html.split("'/report-request'").length, 2);
  assert.equal(html.split("'DELETE', pp(pk, 'cards/'").length, 2);
  // confirm texts are shared too
  assert.equal(html.split('End this thread? It stops taking messages').length, 2);
  assert.equal(html.split('This cannot be undone.').length, 3);
});

test('gear menu: the gear is a labelled menu button, opens a role=menu and never opens the card or starts a drag', () => {
  assert.match(html, /'Actions for ' \+ card\.id/);
  assert.match(html, /setAttribute\('aria-haspopup', 'menu'\)/);
  assert.match(html, /setAttribute\('aria-expanded', menu && menu\.id === card\.id/);
  assert.match(html, /el\.setAttribute\('role', 'menu'\)/);
  assert.match(html, /a\.radio \? 'menuitemradio' : 'menuitem'/);
  assert.match(html, /e\.stopPropagation\(\);\n\s+if \(menu && menu\.id === card\.id\)/, 'a click on the gear does not reach the card');
  assert.match(html, /if \(dragBlocked\(e\)\) return;/, 'a press that began on the gear starts no drag');
  for (const key of ["'ArrowDown'", "'ArrowUp'", "'Home'", "'End'", "'Escape'", "'Tab'"]) assert.ok(html.includes(`e.key === ${key}`), `${key} is handled in the menu`);
  assert.match(html, /document\.addEventListener\('pointerdown'[^]*?closeMenu\(false\)/, 'a click outside closes the menu');
  assert.match(html, /document\.body\.appendChild\(el\)/, 'the menu hangs from the body, so no column clips it');
  assert.match(html, /position: fixed; z-index: 50/);
});

test('the End confirmation names the stage that has the done role, not a fixed one', () => {
  const m = /function endConfirmText\(\) \{[^\n]*\}/.exec(html);
  assert.ok(m, 'endConfirmText is missing');
  const text = (stages, done) => vm.runInNewContext(`${m[0]}; endConfirmText()`, {
    cfg: () => ({ roles: { done } }), label: (id) => (stages.find((s) => s.id === id) || { label: id }).label,
  });
  assert.equal(text(STAGES4, 'done'), 'End this thread? It stops taking messages and the card moves to Done.');
  assert.equal(text([{ id: 'todo', label: 'To do' }, { id: 'shipped', label: 'Shipped' }], 'shipped'), 'End this thread? It stops taking messages and the card moves to Shipped.');
  assert.doesNotMatch(html.replace(m[0], ''), /moves to Done/);
});

test('gear menu: Start as thread opens the card page at the start step', () => {
  assert.match(html, /startFor = id;\n[^]*?openCard\(id, true\)/);
  assert.match(html, /starting: !!startNow && !create && card\.kind !== 'milestone' && !isRO\(\)/);
  assert.match(html, /const startNow = startFor === target;/);
});

test('gear menu: a drawn board keeps an open menu in step with the card, or closes it and returns focus', () => {
  assert.match(html, /\n    syncMenu\(\);\n/);
  assert.match(html, /if \(!gear \|\| !actions\.length\) \{ closeMenu\(true\); return; \}/);
  assert.match(html, /focusGear && t\.querySelector\('\.gear'\)/, 'a focused gear is focused again after the board is drawn');
  assert.match(html, /closeMenu\(false\);\n    const startNow/, 'a card page closes the menu');
});

// ---- the gear menu, run for real against a small fake DOM ----

const ROLES4 = { start: 'todo', working: 'doing', review: 'check', blocked: 'doing', done: 'done' };

// The page's own pieces: the action rules and the menu code, with stand-ins for what lives elsewhere on the page.
function menuPage(over = {}) {
  const actions = /\/\/ ---- gear menu actions[^\n]*\n([\s\S]*?)\/\/ ---- end gear menu actions ----/.exec(html);
  const menuSrc = /\/\/ ---- gear menu \(page\.test[^\n]*\n([\s\S]*?)\/\/ ---- end gear menu ----/.exec(html);
  const milestones = /\/\/ ---- milestones and stages[^\n]*\n([\s\S]*?)\/\/ ---- end milestones and stages ----/.exec(html);
  assert.ok(actions && menuSrc && milestones, 'the gear menu blocks are missing from the board page');
  const doc = { listeners: {}, activeElement: null, documentElement: { clientWidth: 1280 }, addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }, createElement(tag) { return new FakeEl(doc, tag); } };
  doc.body = new FakeEl(doc, 'body');
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args.filter((a) => typeof a !== 'function')]); return Promise.resolve(); };
  const board = new FakeEl(doc, 'main'), newBtn = new FakeEl(doc, 'button');
  doc.body.append(board, newBtn);
  const state = { cards: [], ro: false, chat: false, halted: false, choices: [], stages: STAGES4, windowH: 800 };
  const env = {
    document: doc, window: { get innerHeight() { return state.windowH; }, addEventListener() {} }, elBoard: board, elNewBtn: newBtn,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    cssEscape: (x) => x, findCard: (id) => state.cards.find((c) => c.id === id) || null,
    cfg: () => ({ stages: state.stages, roles: ROLES4 }), isRO: () => state.ro, isChat: () => state.chat, milestoneChoices: () => state.choices,
    reportState: reportOf, milestoneReport: () => 'REPORT', copyOrWarn: async () => true, current: { cards: [] },
    endConfirmText: () => 'END?', deleteConfirmText: (c) => 'DEL ' + c.id,
    endThread: rec('end'), deleteCard: rec('delete'), requestReport: rec('report'), moveCard: rec('move'), setParent: rec('parent'),
    dropCard: rec('drop'), renderBoard: rec('render'), openCard: rec('open'), setTimeout: () => 1, clearTimeout() {},
    get halted() { return state.halted; },
  };
  Object.assign(env, over);
  const script = `let menu = null, gearCtx = null, gearDown = false, startFor = '', waitsFor = '';
${milestones[1]}
${actions[1]}
${menuSrc[1]}
({ gearBtn, openMenu, closeMenu, syncMenu, menuActions, menuKeydown, dragBlocked, placeMenu, get menu() { return menu; }, get startFor() { return startFor; }, get waitsFor() { return waitsFor; } })`;
  const page = vm.runInNewContext(script, vm.createContext(env));
  // a card element on the board, with its gear when it has one
  const put = (card) => {
    state.cards = state.cards.filter((c) => c.id !== card.id).concat(card);
    env.current.cards = state.cards;
    board.children.filter((c) => c.dataset.id === card.id).forEach((c) => c.remove());
    const el = doc.createElement('article');
    el.className = 'card';
    el.dataset.id = card.id;
    const gear = page.gearBtn(card);
    gear.className += ' gear';
    el.appendChild(gear);
    board.appendChild(el);
    return gear;
  };
  const items = () => (page.menu ? page.menu.el.querySelectorAll('[role^="menuitem"]') : []);
  const item = (key) => items().find((i) => i.dataset.key === key);
  const docFire = (type, target) => { const e = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (doc.listeners[type] || []).forEach((fn) => fn(e)); return e; };
  return { page, doc, state, calls, put, items, item, docFire, newBtn, board };
}

test('gear menu (fake DOM): blocked thread starts do nothing and become available when the fields are cleared', () => {
  for (const fields of [{ criteria: ['Tests pass'] }, { blockedBy: ['c9'] }]) {
    const t = menuPage();
    const c = card('c2', 'task', 'Card', 'todo', fields);
    t.put(c).click();
    assert.equal(t.item('start').getAttribute('aria-disabled'), 'true');
    assert.equal(t.item('start').title, 'A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first.');
    t.item('start').click();
    assert.deepEqual(t.calls, []);
    assert.equal(t.page.startFor, '');
    t.put({ ...c, criteria: [], blockedBy: [] });
    t.page.syncMenu();
    assert.equal(t.item('start').getAttribute('aria-disabled'), null);
    t.item('start').click();
    assert.equal(t.page.startFor, 'c2');
    assert.deepEqual(t.calls, [['open', 'c2', true]]);
  }
});

test('gear menu (fake DOM): a press on the gear cancels the next drag once, and a stale press does not', () => {
  const t = menuPage();
  const gear = t.put(thr('idle'));
  const other = new FakeEl(t.doc, 'div');
  gear.fire('pointerdown');
  const first = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(t.page.dragBlocked(first), true, 'a drag from the gear is cancelled');
  assert.equal(first.defaultPrevented, true);
  assert.equal(t.page.dragBlocked({ preventDefault() {} }), false, 'the press is used up by that drag');
  gear.fire('pointerdown');
  t.docFire('contextmenu', gear);                       // a right-click never ends in a pointerup
  assert.equal(t.page.dragBlocked({ preventDefault() {} }), false, 'a context menu clears it');
  gear.fire('pointerdown');
  t.docFire('pointerdown', other);                      // the next press is elsewhere
  assert.equal(t.page.dragBlocked({ preventDefault() {} }), false, 'a press elsewhere clears it');
  gear.fire('pointerdown');
  t.docFire('pointerup', gear);
  assert.equal(t.page.dragBlocked({ preventDefault() {} }), false, 'a pointerup clears it');
});

test('gear menu (fake DOM): End and Delete each ask first, with their own text, and only the yes acts', () => {
  const t = menuPage();
  const gear = t.put(thr('idle', { lastResult: 'x' }));
  gear.click();
  assert.equal(gear.getAttribute('aria-expanded'), 'true');
  assert.equal(t.doc.activeElement, t.items()[0], 'the first item has focus');
  t.item('end').click();
  assert.equal(t.page.menu.el.textContent.includes('END?'), true);
  assert.deepEqual(t.calls, [], 'nothing is sent before the yes');
  assert.deepEqual(t.items().map((i) => i.dataset.key), ['keep', 'go']);
  assert.equal(t.doc.activeElement, t.item('keep'), 'focus starts on the safe choice');
  t.item('go').click();
  assert.deepEqual(t.calls, [['end', 'c7']]);
  assert.equal(t.page.menu, null);
  assert.equal(t.doc.activeElement, gear, 'focus goes back to the gear');
  t.calls.length = 0;
  gear.click();
  t.item('delete').click();
  assert.equal(t.page.menu.el.textContent.includes('DEL c7'), true);
  assert.equal(t.page.menu.el.textContent.includes('END?'), false);
  assert.deepEqual(t.calls, [], 'Delete asks before it deletes');
  t.item('keep').click();
  assert.deepEqual(t.calls, []);
  assert.equal(t.page.menu, null);
  gear.click();
  t.item('delete').click();
  t.item('go').click();
  assert.deepEqual(t.calls, [['delete', 'c7']]);
});

test('gear menu (fake DOM): a disabled item does nothing, an enabled one calls its shared function', () => {
  const t = menuPage();
  const running = t.put(thr('running'));
  running.click();
  assert.equal(t.item('delete').getAttribute('aria-disabled'), 'true');
  t.item('delete').click();
  assert.equal(t.page.menu.confirm, null, 'Delete cannot start while a turn runs');
  assert.deepEqual(t.calls, []);
  t.page.closeMenu(false);
  const task = t.put(card('c3', 'task', 'Fix links', 'doing', { parent: 'c1' }));
  t.state.choices = [['c1', 'Launch'], ['c9', 'Docs']];
  task.click();
  t.item('move:doing').click();
  assert.deepEqual(t.calls, [], 'the current stage cannot be chosen');
  assert.notEqual(t.page.menu, null, 'and the menu stays open');
  t.item('move:check').click();
  assert.deepEqual(t.calls, [['move', 'c3', 'check']]);
  assert.equal(t.page.menu, null);
  task.click();
  t.item('ms:c9').click();
  task.click();
  t.item('ms:').click();
  task.click();
  t.item('start').click();
  assert.deepEqual(t.calls.slice(1), [['parent', 'c3', 'c9'], ['parent', 'c3', ''], ['open', 'c3', true]]);
  assert.equal(t.page.startFor, 'c3', 'the card page is asked to open at the start step');
  const m = t.put(card('c1', 'milestone', 'Launch', 'doing'));
  m.click();
  assert.deepEqual(t.items().map((i) => i.dataset.key), ['copy', 'delete']);
});

test('gear menu (fake DOM): nothing opens on a read-only or halted board, however the gear is reached', () => {
  const t = menuPage();
  const task = t.put(card('c3', 'task', 'Fix links', 'doing'));
  const thread = t.put(thr('idle', { lastResult: 'x' }));
  assert.ok(t.page.menuActions(t.state.cards[0]).length > 0);
  t.state.ro = true;
  assert.equal(t.page.menuActions(t.state.cards[0]).length, 0, 'a task has nothing that does not write');
  assert.equal(t.page.menuActions(t.state.cards[1]).length, 0);
  task.click(); thread.click();
  assert.equal(t.page.menu, null);
  t.state.ro = false;
  t.state.halted = true;
  assert.equal(t.page.menuActions(t.state.cards[0]).length, 0, 'the access page is showing');
  task.click();
  assert.equal(t.page.menu, null);
});

test('gear menu (fake DOM): a step waiting for yes is voided when its action stops applying; a vanished card closes the menu', () => {
  const t = menuPage();
  const gear = t.put(thr('idle'));
  gear.click();
  t.item('end').click();
  assert.equal(t.page.menu.confirm, 'end');
  const ended = t.put(thr('ended', { lastResult: 'x', reported: true }));   // the board was drawn again
  t.page.syncMenu();
  assert.equal(t.page.menu.confirm, null, 'End no longer applies');
  assert.deepEqual(t.items().map((i) => i.dataset.key), ['delete'], 'the list is drawn again');
  assert.equal(ended.getAttribute('aria-expanded'), 'true', 'the new gear is the open one');
  assert.equal(t.doc.activeElement, t.item('delete'), 'focus stays inside the menu');
  t.item('delete').click();
  assert.equal(t.page.menu.confirm, 'delete');
  t.put(thr('running'));
  t.page.syncMenu();
  assert.equal(t.page.menu.confirm, null, 'Delete is not allowed while a turn runs');
  // the card is deleted elsewhere
  t.state.cards = [];
  t.board.children.forEach((c) => c.remove());
  t.page.syncMenu();
  assert.equal(t.page.menu, null);
  assert.equal(t.doc.activeElement, t.newBtn, 'focus is not lost');
});

test('gear menu (fake DOM): keys move through the menu, Escape and Tab close it, and a held key chooses nothing', () => {
  const t = menuPage();
  const gear = t.put(thr('idle', { lastResult: 'x' }));
  const press = (key, extra) => t.page.menu.el.fire('keydown', { key, ...extra });
  const keys = () => t.items().map((i) => i.dataset.key);
  gear.fire('keydown', { key: 'Enter', repeat: true });
  assert.equal(gear.fire('keydown', { key: 'Enter', repeat: true }).defaultPrevented, true, 'a repeated Enter on the gear is ignored');
  assert.equal(gear.fire('keydown', { key: 'Enter', repeat: false }).defaultPrevented, false, 'the first press is not');
  gear.click();
  assert.equal(press('ArrowDown').defaultPrevented, true);
  assert.equal(t.doc.activeElement.dataset.key, keys()[1]);
  press('End'); assert.equal(t.doc.activeElement.dataset.key, keys()[keys().length - 1]);
  press('ArrowDown'); assert.equal(t.doc.activeElement.dataset.key, keys()[0], 'wraps');
  press('ArrowUp'); assert.equal(t.doc.activeElement.dataset.key, keys()[keys().length - 1], 'wraps');
  press('Home'); assert.equal(t.doc.activeElement.dataset.key, keys()[0]);
  assert.equal(press('Enter', { repeat: true }).defaultPrevented, true, 'a held Enter does not press the item');
  assert.equal(press(' ', { repeat: true }).defaultPrevented, true);
  assert.equal(press('Enter').defaultPrevented, false, 'a first Enter is left to the button');
  assert.notEqual(t.page.menu, null);
  assert.equal(press('Escape').defaultPrevented, true);
  assert.equal(t.page.menu, null);
  assert.equal(t.doc.activeElement, gear);
  assert.equal(gear.getAttribute('aria-expanded'), 'false');
  gear.click();
  assert.equal(press('Tab').defaultPrevented, false, 'the Tab itself goes on from the gear');
  assert.equal(t.page.menu, null);
  assert.equal(t.doc.activeElement, gear);
  // an outside press closes it; a second gear takes over
  const other = t.put(card('c3', 'task', 'T', 'doing'));
  gear.click();
  t.docFire('pointerdown', t.newBtn);
  assert.equal(t.page.menu, null);
  gear.click(); other.click();
  assert.equal(gear.getAttribute('aria-expanded'), 'false');
  assert.equal(other.getAttribute('aria-expanded'), 'true');
  assert.equal(t.doc.body.children.filter((c) => c.className === 'menu').length, 1, 'one menu at a time');
});

test('gear menu (fake DOM): the menu stays inside the window and a long menu scrolls to the focused item', () => {
  const t = menuPage();
  t.state.stages = Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, label: 'Stage ' + i }));
  t.state.choices = Array.from({ length: 25 }, (_, i) => ['m' + i, 'Milestone ' + i]);
  const gear = t.put(card('c3', 'task', 'T', 's0'));
  gear.rect = { left: 1000, right: 1030, top: 760, bottom: 786 };
  gear.click();
  const el = t.page.menu.el;
  assert.ok(parseInt(el.style.left, 10) + el.offsetWidth <= 1280 - 8 && parseInt(el.style.left, 10) >= 8, 'inside horizontally');
  assert.ok(parseInt(el.style.top, 10) >= 8 && parseInt(el.style.top, 10) + el.offsetHeight <= 800 - 8, 'inside vertically: flipped above the gear');
  assert.ok(parseInt(el.style.top, 10) < 760, 'it flipped above the gear near the bottom edge');
  // lay the items out one under another, 30px each, in a 300px window
  t.items().forEach((it, i) => { it.offsetTop = i * 30; });
  const last = t.items().length - 1;
  t.page.menu.el.fire('keydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
  assert.equal(t.doc.activeElement, t.items()[last]);
  assert.equal(el.scrollTop, (last + 1) * 30 - 300, 'the last item is brought into view');
  t.page.menu.el.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
  assert.equal(el.scrollTop, 0, 'and the first one back');
  assert.match(html, /item\.focus\(\{ preventScroll: true \}\)/, 'the page itself is never scrolled');
});

// ------------------------------------------------------------ delegation lanes

const LANES = {
  available: true, projectTrusted: false,
  lanes: [
    { name: 'code-codex', implementer: 'codex', model: 'gpt-fake', effort: 'high', variant: null, readOnly: false, source: 'global', approved: true },
    { name: 'ui-open', implementer: 'opencode', model: 'vendor/model-x', effort: null, variant: 'max', readOnly: false, source: 'global', approved: true },
    { name: 'review-ro', implementer: 'claude', model: null, effort: 'xhigh', variant: null, readOnly: true, source: 'project', approved: false },
  ],
};

function lanePage(lanes = null) {
  const m = /\/\/ ---- delegation lanes[^\n]*\n([\s\S]*?)\/\/ ---- end delegation lanes ----/.exec(html);
  const t = /\/\/ ---- tokens and agents[^\n]*\n([\s\S]*?)\/\/ ---- end tokens and agents ----/.exec(html);
  assert.ok(m && t, 'the lanes block is missing from the board page');
  const doc = { createElement: (tag) => new FakeEl(doc, tag) };
  doc.body = new FakeEl(doc, 'body');
  const env = {
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape(cls) { const s = doc.createElement('span'); s.className = 'shape ' + cls; s.setAttribute('aria-hidden', 'true'); return s; },
  };
  const page = vm.runInNewContext(`let lanes = ${JSON.stringify(lanes)};\n${t[1]}\n${m[1]}\n({ laneInfo, laneTag, laneRows, showLaneRows, laneSig, laneFollowUp, laneTraceNote, laneStartPlan, setLanes(v) { lanes = v; } })`, vm.createContext(env));
  return { page, doc };
}
const lcard = (lane, extra = {}) => ({ id: 'c3', kind: 'task', title: 'T', note: '', status: 'todo', lane, ...extra });

test('lane tag: a hexagon icon and "name · provider", with the model and what the lane does in the title', () => {
  const { page } = lanePage(LANES);
  const tag = page.laneTag(lcard('code-codex'));
  assert.match(tag.className, /\btag\b.*\blane-tag\b/);
  assert.equal(tag.className.includes('attn'), false);
  assert.deepEqual(tag.children.map((c) => c.className), ['shape s-hex', 'lane-tag-name', 'lane-tag-state']);
  assert.equal(tag.children[0].getAttribute('aria-hidden'), 'true', 'the icon is decoration');
  assert.equal(tag.textContent, 'code-codex · codex');
  assert.equal(tag.title, 'Delegation lane code-codex: codex · gpt-fake · high. Starting this card as a thread runs it on that lane.');
  assert.match(page.laneTag(lcard('ui-open', { kind: 'idea' })).title, /^Delegation lane ui-open: opencode · vendor\/model-x · max\./, 'a variant stands in for the effort');
  assert.equal(page.laneTag(lcard('ui-open')).textContent, 'ui-open · opencode');
});

test('lane tag: a lane that is not found or not approved says so in words, and a card without a lane has no tag', () => {
  const { page } = lanePage(LANES);
  const missing = page.laneTag(lcard('gone'));
  assert.equal(missing.textContent, 'gone · not found');
  assert.match(missing.className, /\battn\b/);
  assert.match(missing.title, /No lane has this name/);
  const un = page.laneTag(lcard('review-ro'));
  assert.equal(un.textContent, 'review-ro · not approved');
  assert.match(un.className, /\battn\b/);
  assert.match(un.title, /not approved yet\. Approve it with the delegate-setup skill/);
  assert.equal(page.laneTag(lcard(undefined)), null);
  assert.equal(page.laneTag(lcard('')), null);
  assert.equal(page.laneTag(lcard('code-codex', { kind: 'milestone' })), null, 'milestones have no lane');
  assert.equal(page.laneTag(lcard('code-codex', { kind: 'thread' })), null, 'neither do threads (yet)');
});

test('lane tag: until the lanes have loaded the name is shown plain, and without the delegate skills a card\'s lane shows as not found', () => {
  const { page } = lanePage(null);
  const loading = page.laneTag(lcard('code-codex'));
  assert.equal(loading.textContent, 'code-codex');
  assert.equal(loading.className.includes('attn'), false);
  assert.deepEqual(plain(page.laneRows(lcard('code-codex'))), [['Lane', 'code-codex']]);
  page.setLanes({ available: false, projectTrusted: false, lanes: [] });
  const none = page.laneTag(lcard('code-codex'));
  assert.equal(none.textContent, 'code-codex · not found');
  assert.match(none.title, /delegate skills could not be read/);
  assert.equal(page.laneTag(lcard(undefined)), null, 'a card with no lane shows nothing about lanes');
  assert.deepEqual(plain(page.laneRows(lcard(undefined))), []);
});

test('lane rows on a card page: lane, provider, model, effort or variant, access and source', () => {
  const { page } = lanePage(LANES);
  assert.deepEqual(plain(page.laneRows(lcard('code-codex'))), [
    ['Lane', 'code-codex'], ['Provider', 'codex'], ['Model', 'gpt-fake'], ['Effort', 'high'], ['Access', 'Can edit files'], ['Source', 'All projects'],
  ]);
  assert.deepEqual(plain(page.laneRows(lcard('ui-open'))).slice(2, 4), [['Model', 'vendor/model-x'], ['Variant', 'max']], 'Variant takes the place of Effort');
  const ro = plain(page.laneRows(lcard('review-ro')));
  assert.deepEqual(ro, [['Lane', 'review-ro (not approved)'], ['Hint', 'This lane comes from the project’s lane config, which is not approved yet. Approve it with the delegate-setup skill.']]);
  const gone = plain(page.laneRows(lcard('gone')));
  assert.deepEqual(gone.map((r) => r[0]), ['Lane', 'Hint']);
  assert.equal(gone[0][1], 'gone (not found)');
  page.setLanes({ ...LANES, lanes: [{ ...LANES.lanes[2], approved: true }] });
  assert.deepEqual(plain(page.laneRows(lcard('review-ro'))), [
    ['Lane', 'review-ro'], ['Provider', 'claude'], ['Model', 'CLI default'], ['Effort', 'extra-high'], ['Access', 'Read-only'], ['Source', 'This project'],
  ]);
  assert.deepEqual(plain(page.laneRows(lcard(undefined))), [], 'no lane, no rows');
});

test('lane rows are set as text, replace the earlier ones and leave the other rows alone', () => {
  const { page, doc } = lanePage(LANES);
  const dl = doc.createElement('dl');
  const kind = doc.createElement('dd');
  kind.textContent = 'task';
  dl.append(doc.createElement('dt'), kind);
  let nodes = page.showLaneRows(dl, [], lcard('code-codex'));
  assert.equal(nodes.length, 12);
  assert.equal(dl.children.length, 14);
  nodes = page.showLaneRows(dl, nodes, lcard('<b>x</b>'));
  assert.equal(dl.children.length, 2 + 4, 'the old rows went, the new ones came');
  assert.equal(dl.children[2].textContent, 'Lane');
  assert.equal(dl.children[3].textContent, '<b>x</b> (not found)', 'markup in a name stays text');
  assert.equal(dl.children[3].children.length, 0);
  nodes = page.showLaneRows(dl, nodes, lcard(undefined));
  assert.equal(dl.children.length, 2, 'no lane, no rows');
  assert.equal(dl.children[1], kind);
});

test('the lane signature changes when the lanes change what a card shows, and not otherwise', () => {
  const { page } = lanePage(LANES);
  const a = page.laneSig(lcard('review-ro'));
  page.setLanes({ ...LANES, projectTrusted: true, lanes: LANES.lanes.map((l) => ({ ...l, approved: true })) });
  assert.notEqual(page.laneSig(lcard('review-ro')), a, 'approving it changes the card');
  page.setLanes({ ...LANES, lanes: [...LANES.lanes, { ...LANES.lanes[0], name: 'extra' }] });
  const b = page.laneSig(lcard('code-codex'));
  page.setLanes({ ...LANES, lanes: [...LANES.lanes, { ...LANES.lanes[0], name: 'another' }] });
  assert.equal(page.laneSig(lcard('code-codex')), b, 'a lane the card does not use changes nothing');
});

test('the page wires lanes in: read on the slow cycle and when a project shows, drawn in the foot and on the page, never written', () => {
  assert.match(html, /request\('GET', pp\(key, 'lanes'\), null, 9000\)/);
  assert.match(html, /lanes = null; lanesSig = ''; lanesAt = 0;/);
  assert.match(html, /const lt = laneTag\(card\);\n\s+if \(lt\) foot\.appendChild\(lt\);/);
  assert.match(html, /laneNodes = showLaneRows\(metaDl, laneNodes, c\);/);
  assert.match(html, /f\.milestone \+ '\|' \+ f\.waiting \+ '\|' \+ lanesSig/, 'the board is drawn again when the lanes change');
  assert.match(html, /if \(card\.lane \|\| \(card\.thread && card\.thread\.lane\)\) ctx\.push\(laneSig\(card\)\)/, 'so is a card page');
  assert.doesNotMatch(html, /\blane\s*:\s*(fMs|fTitle|fNote|fStatus)|patch\.lane|bodyObj\.lane/, 'no write sends a lane');
});

const SNAP = (over = {}) => ({ name: 'code-codex', implementer: 'codex', model: 'gpt-fake', effort: 'high', variant: null, readOnly: false, source: 'global', session: 'codex-sess-1', ...over });
const lthread = (lane, runState = 'idle', extra = {}) => ({ id: 'c4', kind: 'thread', title: 'Lane thread', note: '', status: 'review', thread: { runState, lane, turns: [], ...extra } });

test('lane thread: the tag and the page rows come from the snapshot taken when it started, whatever the lanes are now', () => {
  const { page } = lanePage(LANES);
  const tag = page.laneTag(lthread(SNAP({ name: 'long-gone', implementer: 'agy', model: 'gemini-fake' })));
  assert.equal(tag.textContent, 'long-gone · agy', 'not "not found": a thread keeps what it ran on');
  assert.equal(tag.className.includes('attn'), false);
  assert.match(tag.title, /^Delegation lane long-gone: agy · gemini-fake · high\. This thread runs on that lane\.$/);
  assert.deepEqual(plain(page.laneRows(lthread(SNAP(), 'idle', { mode: 'read' }))), [
    ['Lane', 'code-codex'], ['Provider', 'codex'], ['Model', 'gpt-fake'], ['Effort', 'high'], ['Access', 'Can edit files'], ['Source', 'All projects'], ['Follow-up', 'Possible'],
  ].map((r) => (r[0] === 'Access' ? ['Access', 'Read-only'] : r)), 'a thread started in read mode is read-only, whatever the lane could do');
  assert.equal(plain(page.laneRows(lthread(SNAP(), 'idle', { mode: 'write' })))[4][1], 'Can edit files');
  const v = plain(page.laneRows(lthread(SNAP({ effort: null, variant: 'max', readOnly: true, source: 'project' }), 'idle', { mode: 'write' })));
  assert.deepEqual(v.slice(3), [['Variant', 'max'], ['Access', 'Read-only'], ['Source', 'This project'], ['Follow-up', 'Possible']]);
  page.setLanes(null);
  assert.equal(page.laneTag(lthread(SNAP())).textContent, 'code-codex · codex', 'also before the lanes have loaded');
  assert.equal(page.laneInfo(lthread(undefined)), null, 'a thread without a lane shows nothing');
});

test('lane thread: a follow-up is possible with the provider\'s session, and the page says why not otherwise', () => {
  const { page } = lanePage(LANES);
  assert.deepEqual(plain(page.laneFollowUp(lthread(SNAP()))), { ok: true, text: 'Possible', why: '' });
  assert.equal(page.laneFollowUp(lthread(SNAP({ session: null }), 'running')).ok, false);
  assert.match(page.laneFollowUp(lthread(SNAP({ session: null }), 'running')).text, /^Not yet:/);
  assert.match(page.laneFollowUp(lthread(SNAP({ session: null, implementer: 'agy' }))).text, /^Not possible: agy gave no session to continue\. Start a new thread instead\.$/);
  assert.equal(page.laneFollowUp(lthread(undefined)).ok, false);
});

test('lane thread: the trace says in one line what the provider shows of a turn', () => {
  const { page } = lanePage(LANES);
  for (const p of ['codex', 'agy', 'opencode']) {
    const line = p + ' gives no live steps in this version. The report appears when the turn ends; any steps shown here come from that report.';
    assert.equal(page.laneTraceNote(lthread(SNAP({ implementer: p }), 'idle')), line);
    assert.equal(page.laneTraceNote(lthread(SNAP({ implementer: p }), 'running')), line);
  }
  assert.equal(page.laneTraceNote(lthread(SNAP({ implementer: 'claude' }), 'running')), 'The steps and token use of this turn appear when it ends.');
  assert.equal(page.laneTraceNote(lthread(SNAP({ implementer: 'claude' }), 'idle')), '', 'a finished claude turn has its trace and tokens');
  assert.equal(page.laneTraceNote(lthread(undefined)), '');
});

test('start step for a card with a lane: the lane line, read-only when the lane is, and the reason when it cannot start', () => {
  const { page } = lanePage(LANES);
  assert.deepEqual(plain(page.laneStartPlan(lcard('code-codex'))), { name: 'code-codex', provider: 'codex', line: 'Runs on lane code-codex · codex', detail: 'gpt-fake · high', readOnly: false, modeNote: '', blocked: '' });
  const ui = page.laneStartPlan(lcard('ui-open', { kind: 'idea' }));
  assert.equal(ui.detail, 'vendor/model-x · max');
  page.setLanes({ ...LANES, lanes: [{ ...LANES.lanes[0], readOnly: true }] });
  assert.equal(page.laneStartPlan(lcard('code-codex')).readOnly, true);
  page.setLanes(LANES);
  const un = page.laneStartPlan(lcard('review-ro'));
  assert.equal(un.blocked, 'Lane “review-ro” is not approved. This lane comes from the project’s lane config, which is not approved yet. Approve it with the delegate-setup skill.');
  assert.match(page.laneStartPlan(lcard('gone')).blocked, /^Lane “gone” was not found\. No lane has this name/);
  page.setLanes({ available: false, projectTrusted: false, lanes: [] });
  assert.match(page.laneStartPlan(lcard('code-codex')).blocked, /delegate skills could not be read/);
  assert.equal(page.laneStartPlan(lcard(undefined)), null, 'no lane: the step is the usual one');
  assert.equal(page.laneStartPlan(lthread(SNAP())), null, 'a thread has no start step');
});

test('the start step hides the agent and Full copy for a lane, never sends a lane, and the composer follows the lane\'s session', () => {
  assert.match(html, /const lp = laneStartPlan\(findCard\(P\.target\) \|\| card\);/);
  assert.match(html, /if \(!lp\) step\.appendChild\(field\('Agent', agentSel, 'f-start-agent'\)\);/);
  assert.match(html, /context: ctx \? ctx\.value\(\) : 'brief', agent: lp \? '' : agentSel\.value/);
  assert.match(html, /lp && lp\.readOnly \? \[\['read', 'Read-only'\]\]/);
  assert.match(html, /lp && lp\.blocked \? lp\.blocked : ''/);
  assert.match(html, /if \(P\.starting\) renderFoot\(\); else syncStart\(\); \}/, 'a lane that loads or changes enables or disables the Start as thread button');
  assert.match(html, /if \(t\.lane\) \{ const f = laneFollowUp\(card\); return f\.ok \? '' : 'This thread cannot take a follow-up\. ' \+ f\.why; \}/);
  assert.match(html, /const laneNote = laneTraceNote\(c\);/);
  assert.doesNotMatch(html, /\{ sessionId, mode, context, agent: [^}]*lane/, 'the start request carries no lane');
});

test('lane tag: the name may be cut short, but the state and the provider are a part of their own that never shrinks', () => {
  const { page } = lanePage(LANES);
  const long = 'a-lane-with-a-very-long-name-that-cannot-fit-in-a-card-foot-at-all';
  for (const [lane, state] of [[long, ' · not found'], ['review-ro', ' · not approved']]) {
    const tag = page.laneTag(lcard(lane));
    assert.deepEqual(tag.children.map((c) => c.className), ['shape s-hex', 'lane-tag-name', 'lane-tag-state']);
    assert.equal(tag.children[1].textContent, lane);
    assert.equal(tag.children[2].textContent, state, 'the words are not in the part that is cut');
  }
  assert.equal(page.laneTag(lcard('code-codex')).children[2].textContent, ' · codex');
  assert.equal(page.laneTag(lcard(long, { kind: 'idea' })).title.includes(long), true, 'the title still has the whole name');
  assert.match(html, /\.lane-tag-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}\n\.lane-tag-state \{ flex: none; \}/);
});

test('lane thread: a follow-up needs the lane to be found, approved, on the same provider and with its relay; otherwise it says why', () => {
  const { page } = lanePage(LANES);
  const th = (o = {}, run = 'idle', extra = {}) => lthread(SNAP(o), run, extra);
  assert.equal(page.laneFollowUp(th()).ok, true);
  const now = (over) => page.setLanes({ ...LANES, lanes: [{ ...LANES.lanes[0], ...over }, ...LANES.lanes.slice(1)] });
  now({ approved: false });
  assert.match(page.laneFollowUp(th()).text, /^Not possible: lane “code-codex” is not approved\. Approve this project’s lane config with the delegate-setup skill\.$/);
  now({ relay: false });
  assert.match(page.laneFollowUp(th()).text, /^Not possible: the codex relay \(the codex-delegate skill\) is not installed\.$/);
  now({ implementer: 'opencode' });
  assert.match(page.laneFollowUp(th()).text, /now runs on opencode, which cannot continue a codex session/);
  now({ readOnly: true });
  assert.equal(page.laneFollowUp(th()).ok, true, 'a read thread does not mind');
  assert.match(page.laneFollowUp(th({}, 'idle', { mode: 'write' })).text, /read-only now/);
  page.setLanes({ ...LANES, lanes: LANES.lanes.slice(1) });
  assert.match(page.laneFollowUp(th()).text, /no longer one of the loaded lanes/);
  page.setLanes({ available: false, projectTrusted: false, lanes: [] });
  assert.match(page.laneFollowUp(th()).text, /delegate skills could not be read/);
  page.setLanes(null);
  assert.equal(page.laneFollowUp(th()).ok, true, 'until the lanes have loaded the session decides');
  page.setLanes(LANES);
  assert.notEqual(page.laneSig(th()), (page.setLanes({ ...LANES, lanes: [{ ...LANES.lanes[0], approved: false }] }), page.laneSig(th())), 'the page is drawn again when that changes');
  assert.match(html, /composer: t\.runState \+ '\|' \+ t\.sessionId \+ '\|' \+ \(t\.lane \? laneSig\(c\) : ''\)/, 'and so is the composer');
});

test('lane access: agy is read-only, a codex lane with no sandbox says so, and a read-mode thread is never shown as able to edit', () => {
  const { page } = lanePage(LANES);
  const access = (card) => plain(page.laneRows(card)).find((r) => r[0] === 'Access')[1];
  assert.equal(access(lthread(SNAP({ sandbox: 'danger-full-access' }), 'idle', { mode: 'write' })), 'Full access (no sandbox)');
  assert.equal(access(lthread(SNAP({ sandbox: 'danger-full-access' }), 'idle', { mode: 'read' })), 'Read-only', 'read mode passes --read-only');
  assert.equal(access(lthread(SNAP({ sandbox: 'workspace-write' }), 'idle', { mode: 'write' })), 'Can edit files');
  assert.equal(access(lthread(SNAP({ implementer: 'agy' }), 'idle', { mode: 'write' })), 'Read-only');
  page.setLanes({ ...LANES, lanes: [{ ...LANES.lanes[0], sandbox: 'danger-full-access' }, { ...LANES.lanes[0], name: 'agy-fast', implementer: 'agy' }] });
  assert.equal(access(lcard('code-codex')), 'Full access (no sandbox)');
  assert.equal(access(lcard('agy-fast')), 'Read-only');
});

test('start step: it says what runs, offers only read access for agy, and warns about full access', () => {
  const { page } = lanePage({ ...LANES, lanes: [LANES.lanes[0], { ...LANES.lanes[0], name: 'agy-fast', implementer: 'agy' }, { ...LANES.lanes[0], name: 'code-full', sandbox: 'danger-full-access' }] });
  const agy = page.laneStartPlan(lcard('agy-fast'));
  assert.equal(agy.readOnly, true);
  assert.equal(agy.modeNote, 'agy lanes are read-only in this version.');
  assert.equal(agy.provider, 'agy');
  assert.equal(page.laneStartPlan(lcard('code-full')).modeNote, 'This lane has no sandbox: in write mode it has full access.');
  assert.equal(page.laneStartPlan(lcard('code-full')).readOnly, false);
  assert.equal(page.laneStartPlan(lcard('gone')).provider, '', 'an unknown lane names no provider');
  assert.match(html, /'This card becomes a thread: a background ' \+ \(lp0\.provider \? lp0\.provider \+ ' session' : 'session'\) \+ ' on lane ' \+ lp0\.name/);
  assert.match(html, /a background Claude session working on this card’s title and note\./, 'the usual step still says Claude');
});

// ---- the card workspace: sub-agent runs ----

function runsBlock() {
  const m = /\/\/ ---- sub-agent runs[^\n]*\n([\s\S]*?)\/\/ ---- end sub-agent runs ----/.exec(html);
  assert.ok(m, 'the sub-agent runs block is missing from the board page');
  return vm.runInNewContext(`${m[1]}; ({ TOOL_VERB, runTitle, runPillState, runSteps, historyRows, quietNote, shownEvents })`);
}

test('a run is titled by its description without the [cN] marker, and shows as Running or Finished', () => {
  const { runTitle, runPillState } = runsBlock();
  assert.equal(runTitle({ description: '[c24] fix the tax rounding', agentType: 'worker' }), 'fix the tax rounding');
  assert.equal(runTitle({ description: '  [c7]fix it' }), 'fix it');
  assert.equal(runTitle({ description: '[c7]', agentType: 'worker' }), 'worker', 'no text after the marker: the agent type');
  assert.equal(runTitle({}), 'Sub-agent');
  assert.equal(runPillState({ state: 'running' }), 'running');
  assert.equal(runPillState({ state: 'done' }), 'idle');
  assert.equal(runPillState({ state: 'stopped' }), 'ended');
});

test('the trace of a run has one step per tool call: read, ran, edited, searched; a failed call is an error step', () => {
  const { runSteps } = runsBlock();
  const events = [
    { kind: 'tool', id: 'a', name: 'Read', summary: '/work/shop/a.txt' }, { kind: 'tool_result', id: 'a', ok: true, preview: 'x' },
    { kind: 'text', text: 'thinking aloud' },
    { kind: 'tool', id: 'b', name: 'Bash', summary: 'npm test' }, { kind: 'tool_result', id: 'b', ok: true, preview: '' },
    { kind: 'tool', id: 'c', name: 'Edit', summary: '/work/shop/cart.js' }, { kind: 'tool_result', id: 'c', ok: true, preview: '' },
    { kind: 'tool', id: 'd', name: 'Grep', summary: 'tax' }, { kind: 'tool_result', id: 'd', ok: false, preview: 'boom' },
    { kind: 'tool', id: 'e', name: 'MadeUpTool', summary: '' },
    { kind: 'truncated' },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(runSteps(events))), [
    { kind: 'found', label: 'Read', text: '/work/shop/a.txt' },
    { kind: 'did', label: 'Ran', text: 'npm test' },
    { kind: 'changed', label: 'Edited', text: '/work/shop/cart.js' },
    { kind: 'error', label: 'Searched failed', text: 'tax' },
    { kind: 'did', label: 'MadeUpTool', text: '' },
  ]);
  assert.deepEqual(runSteps([]), []);
});

test('the history reads newest first, names who did it and the stages by their labels, and keeps the creation of an older card', () => {
  const { historyRows } = runsBlock();
  const labelOf = (id) => ({ new: 'New', review: 'Review' })[id] || id;
  const card = { source: 'user', createdAt: 'T0', history: [
    { at: 'T1', by: 'user', type: 'created', to: 'new' },
    { at: 'T2', by: 'claude', type: 'moved', from: 'new', to: 'review' },
    { at: 'T3', by: 'user', type: 'edited', fields: ['title', 'note'] },
    { at: 'T4', by: 'claude', type: 'from-a-later-version' },
  ] };
  assert.deepEqual(JSON.parse(JSON.stringify(historyRows(card, labelOf))), [
    { text: 'You edited the title, note', at: 'T3' },
    { text: 'Claude moved it from New to Review', at: 'T2' },
    { text: 'You created it in New', at: 'T1' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(historyRows({ source: 'claude', createdAt: 'T0' }, labelOf))), [{ text: 'Claude created it', at: 'T0' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(historyRows({ source: 'user', createdAt: 'T0', history: [{ at: 'T5', by: 'claude', type: 'moved', from: 'new', to: 'gone_stage' }] }, labelOf))).map((r) => r.text), ['Claude moved it from New to gone_stage', 'You created it']);
});

// The run views, run against a fake DOM and a scripted server.
function runViews() {
  const run = /\/\/ ---- run views[^\n]*\n([\s\S]*?)\/\/ ---- end run views ----/.exec(html);
  const helpers = /\/\/ ---- sub-agent runs[^\n]*\n([\s\S]*?)\/\/ ---- end sub-agent runs ----/.exec(html);
  const tokens = /\/\/ ---- tokens and agents[^\n]*\n([\s\S]*?)\/\/ ---- end tokens and agents ----/.exec(html);
  assert.ok(run && helpers && tokens);
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createTextNode: (t) => { const e = new FakeEl(doc, 'span'); e.textContent = t; return e; } };
  doc.body = new FakeEl(doc, 'body');
  const requests = [];
  const world = { answers: [], card: null };
  const env = {
    document: doc, selKey: 'k1', POLL_MS: 5, panel: null,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    shape: () => doc.createElement('span'), chev: () => doc.createElement('span'), timeEl: (t) => { const e = doc.createElement('time'); e.textContent = String(t); return e; },
    elapsedEl: () => doc.createElement('span'), runPill: (st) => { const e = doc.createElement('span'); e.className = 'pill'; e.textContent = st; return e; },
    label: (id) => id, sessionLabel: (id) => `session ${id}`, stepsText: (n) => `${n} steps`, fmtMs: (ms) => `${ms} ms`, cfg: () => ({ stages: [] }),
    pp: (key, rest) => `/api/p/${key}/${rest}`,
    findCard: () => world.card,
    renderMarkdown: (t) => { const e = doc.createElement('div'); e.textContent = t; return e; },
    actList: (events) => { const e = doc.createElement('ul'); e.className = 'act-list'; events.forEach((ev) => { const li = doc.createElement('li'); li.textContent = ev.kind + ':' + (ev.id || ''); e.appendChild(li); }); return e; },
    UNAVAILABLE: 'unavailable', READONLY_WHY: 'read-only', ro: false, isRO: () => env.ro, posts: [],
    actionBtn: (text, cls, key, onClick) => { const b = doc.createElement('button'); b.className = 'btn ' + cls; b.textContent = text; b.dataset.busykey = key; b.addEventListener('click', onClick); return b; },
    setOff: (b, off) => { b.disabled = off; }, runAction: async (key, fn) => fn(), clearError() {}, showError: (m) => { env.errors.push(m); }, errors: [],
    applyCard: (c) => { world.card = c; }, wrote() {}, poll: async () => {},
    stepEl: (kind, text) => { const e = doc.createElement('li'); e.textContent = kind + ' ' + text; e.querySelector = () => ({ append() {} }); return e; },
    api: async (method, path, body) => { requests.push(path); if (method === 'POST') env.posts.push([path, body]); const a = world.answers.shift(); if (a instanceof Error) throw a; return a; },
    setTimeout: (fn) => { env.__cycle = fn; return 1; }, clearTimeout() {},
  };
  const code = `${tokens[1]}\n${helpers[1]}\n${run[1]}\n({ attachRuns, runData })`;
  const page = vm.runInNewContext(code, vm.createContext(env));   // env becomes the page's global scope: env.panel is the page's `panel`
  const P = { target: 'c1', actOpen: {}, flash: null, scrollers: {} };
  env.panel = P;
  const scConvo = new FakeEl(doc, 'div'), scTrace = new FakeEl(doc, 'div');
  P.scrollers = { conversation: scConvo, trace: scTrace };
  const S = { scConvo, scTrace, composer: new FakeEl(doc, 'div'), rebuild: (id, build) => P.scrollers[id].replaceChildren(...[].concat(build())), jumpToTurn() {} };
  return { page, env, P, S, doc, requests, world, scConvo, scTrace };
}
const RUN1 = (over = {}) => ({ n: 1, agentId: 'a1b2c3d4', agentType: 'worker', mode: 'foreground', description: '[c1] go', state: 'running', sessionId: 's', startedAt: 'T0', finishedAt: null, ok: null, prompt: 'do the thing', result: null, ...over });
const tick = () => new Promise((r) => setImmediate(r));

test('run views: a running run is read from the offset the server gave, and a finished answer replaces what was read', async () => {
  const t = runViews();
  const view = t.page.attachRuns(t.P, t.S);
  t.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0', runs: [RUN1()] };
  t.world.answers = [
    { run: 1, running: true, events: [{ kind: 'tool', id: 'x', name: 'Read', summary: 'a' }], next: 100, more: true, prompt: 'do the thing' },
    { run: 1, running: true, events: [{ kind: 'tool_result', id: 'x', ok: true }], next: 180, more: false },
  ];
  view.update(t.world.card);
  // update() scheduled a cycle on a stubbed timer: run it by hand
  await vm_cycle(t);
  assert.deepEqual(t.requests, ['/api/p/k1/cards/c1/runs/1/activity?offset=0', '/api/p/k1/cards/c1/runs/1/activity?offset=100'], 'a chunk that says "more" is followed at once, from where it ended');
  assert.equal(t.scTrace.textContent.includes('found a'), true, 'the step is in the trace');
  const d = Object.values(t.page.runData)[0];
  assert.equal(d.events.length, 2);
  assert.equal(d.offset, 180);
  assert.equal(d.final, false, 'a running run is read again');
  // the run finished: its answer is the whole snapshot, with no offset
  t.world.card = { ...t.world.card, runs: [RUN1({ state: 'done', finishedAt: 'T1', ok: true, result: 'the report', steps: 1 })] };
  t.world.answers = [{ run: 1, running: false, events: [{ kind: 'tool', id: 'x', name: 'Read', summary: 'a' }, { kind: 'tool_result', id: 'x', ok: true }, { kind: 'text', text: 'done' }], next: null, more: false }];
  t.requests.length = 0;
  await vm_cycle(t);
  assert.equal(t.requests.length, 1);
  assert.equal(d.events.length, 3, 'replaced, not added to the two already read');
  assert.equal(d.final, true);
  assert.ok(t.scConvo.textContent.includes('the report'));
  assert.ok(t.scConvo.textContent.includes('do the thing'), 'the prompt is shown');
  // a finished run is not asked for again
  t.requests.length = 0;
  await vm_cycle(t);
  assert.deepEqual(t.requests, []);
});

// One round of the page's own cycle: update() scheduled it on a stubbed timer, so call it through the stub.
async function vm_cycle(t) {
  const fn = t.env.__cycle;
  assert.ok(fn, 'the page scheduled a cycle');
  await fn();
}

test('run views: a card with no run says so, and the page offers no message box for a run', () => {
  const t = runViews();
  const view = t.page.attachRuns(t.P, t.S);
  t.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0' };
  view.update(t.world.card);
  assert.match(t.scConvo.textContent, /No agent has worked on this card/);
  assert.match(t.scConvo.textContent, /\[c1\]/, 'it names the marker for this card');
  assert.match(t.S.composer.textContent, /Only the main session can message these agents/);
  assert.equal(t.S.composer.querySelectorAll('.input').length, 0);
  assert.equal(t.requests.length, 0, 'nothing to ask the server');
});

test('the card workspace: tasks and ideas open it, a milestone keeps its page, a thread keeps its own, and nothing is set as markup', () => {
  assert.match(html, /const ws = page && !isMs;/);
  assert.match(html, /\} else mountDrawer\(P, page\);/);
  assert.match(html, /workspaceShell\(P, \{ lead: h\('span', 'idchip', card\.id\)/, 'the thread workspace uses the same shell');
  assert.match(html, /workspaceShell\(P, \{ lead: h\('span', 'ws-ids'\)/);
  assert.match(html, /'cards\/' \+ encodeURIComponent\(c\.id\) \+ '\/runs\/' \+ run\.n \+ '\/activity\?offset=' \+ d\.offset/, 'the page names a card and a run, never a path');
  assert.doesNotMatch(html, /transcript/i, 'the page knows nothing of transcript paths');
});

test('run views: the step count is the run\'s own, the newest events are kept with a marker, and a reset starts the list over', async () => {
  const t = runViews();
  const view = t.page.attachRuns(t.P, t.S);
  const tool = (i) => ({ kind: 'tool', id: 't' + i, name: 'Read', summary: 'f' + i });
  t.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0', runs: [RUN1()] };
  t.world.answers = [
    { run: 1, running: true, events: Array.from({ length: 1500 }, (_, i) => tool(i)), next: 10, more: true },
    { run: 1, running: true, events: Array.from({ length: 1500 }, (_, i) => tool(1500 + i)), next: 20, more: false },
  ];
  view.update(t.world.card);
  await vm_cycle(t);
  const d = Object.values(t.page.runData)[0];
  assert.equal(d.events.length, 2000, 'the newest 2000 are kept');
  assert.equal(d.dropped, 1000);
  assert.equal(d.events[1999].summary, 'f2999', 'the end of the run is what is shown');
  assert.equal(d.final, false, 'a running run is still followed after the cap');
  assert.match(t.scTrace.textContent, /Earlier steps are not shown\./);
  assert.match(t.scConvo.textContent, /earlier:/, 'the list starts with the marker');
  // later events keep coming in at the end
  t.world.answers = [{ run: 1, running: true, events: [tool(3000)], next: 30, more: false }];
  await vm_cycle(t);
  assert.equal(d.events[d.events.length - 1].summary, 'f3000');
  assert.equal(d.events.length, 2000);
  // the file was replaced by a shorter one: the answer says reset, and the list is rebuilt, not added to
  t.world.answers = [{ run: 1, running: true, events: [tool(1)], next: 5, more: false, reset: true }];
  await vm_cycle(t);
  assert.equal(d.events.length, 1);
  assert.equal(d.dropped, 0);
  assert.equal(d.offset, 5);
  // a finished run with 3000 steps says 3000, not the 1 or 2001 events at hand
  t.world.card = { ...t.world.card, runs: [RUN1({ state: 'done', finishedAt: 'T1', ok: true, result: 'r', steps: 3000 })] };
  t.world.answers = [{ run: 1, running: false, events: [{ kind: 'earlier', dropped: 5 }, ...Array.from({ length: 2000 }, (_, i) => tool(i))], next: null, more: false }];
  view.update(t.world.card);
  await vm_cycle(t);
  assert.match(t.scConvo.textContent, /3000 steps/);
  assert.equal(d.events[0].kind, 'earlier', 'the marker the snapshot carries is kept');
  assert.equal(d.events.length, 2001, 'the marker and the 2000 events the server kept');
});

test('run views: a quiet running run says so, every running run can be marked as stopped, a stopped one says it was', async () => {
  const t = runViews();
  const view = t.page.attachRuns(t.P, t.S);
  t.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0', runs: [RUN1()] };
  t.world.answers = [{ run: 1, running: true, events: [], next: 0, more: false, quietMs: 3 * 60 * 1000 }];
  view.update(t.world.card);
  await vm_cycle(t);
  const stopBtn = () => t.scConvo.querySelectorAll('.run-stop')[0];
  assert.ok(stopBtn(), 'a running run offers Mark as stopped');
  assert.equal(stopBtn().textContent, 'Mark as stopped');
  assert.doesNotMatch(t.scConvo.textContent, /No activity for/);
  t.world.answers = [{ run: 1, running: true, events: [], next: 0, more: false, quietMs: 15 * 60 * 1000 + 5000 }];
  await vm_cycle(t);
  assert.match(t.scConvo.textContent, /No activity for 15 min; it may have stopped\./);
  // the click posts to the run's own route and takes the card the server returns
  const after = { ...t.world.card, runs: [RUN1({ state: 'stopped', ok: false, finishedAt: 'T9', note: 'Marked as stopped on the board: no stop was reported for this run.' })] };
  t.world.answers = [after];
  stopBtn().click();
  await tick(); await tick();
  assert.deepEqual(plain(t.env.posts), [['/api/p/k1/cards/c1/runs/1/stop', {}]]);
  assert.equal(t.world.card, after);
  t.world.answers = [{ run: 1, running: false, events: [], next: null, more: false }];
  view.update(after);
  await vm_cycle(t);
  assert.equal(t.scConvo.querySelectorAll('.run-stop').length, 0, 'a stopped run offers no control');
  assert.match(t.scConvo.textContent, /Marked as stopped on the board/);
  assert.match(t.scTrace.textContent, /Run 1/);
  // a finished run has none either, and on a read-only board the control is off
  const t2 = runViews();
  const v2 = t2.page.attachRuns(t2.P, t2.S);
  t2.env.ro = true;
  t2.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0', runs: [RUN1()] };
  t2.world.answers = [{ run: 1, running: true, events: [], next: 0, more: false }];
  v2.update(t2.world.card);
  await vm_cycle(t2);
  assert.equal(t2.scConvo.querySelectorAll('.run-stop')[0].disabled, true);
});

test('run views: the full prompt and report come from the run\'s route when the state holds only a preview', async () => {
  const t = runViews();
  const view = t.page.attachRuns(t.P, t.S);
  const run = RUN1({ state: 'done', finishedAt: 'T1', ok: true, prompt: 'the pre', promptFile: true, result: 'the rep', reportFile: true, steps: 0 });
  t.world.card = { id: 'c1', kind: 'task', title: 'T', status: 'new', source: 'user', createdAt: 'T0', runs: [run] };
  t.world.answers = [
    { run: 1, running: false, events: [], next: null, more: false },
    { text: 'the pre and the whole prompt', full: true },
    { text: 'the rep and the whole report', full: true },
  ];
  view.update(t.world.card);
  assert.match(t.scConvo.textContent, /the pre/, 'the preview shows at once');
  await vm_cycle(t);
  assert.deepEqual(t.requests, ['/api/p/k1/cards/c1/runs/1/activity?offset=0', '/api/p/k1/cards/c1/runs/1/prompt', '/api/p/k1/cards/c1/runs/1/report']);
  assert.match(t.scConvo.textContent, /the whole prompt/);
  assert.match(t.scConvo.textContent, /the whole report/);
  t.requests.length = 0;
  await vm_cycle(t);
  assert.deepEqual(t.requests, [], 'each is fetched once');
});

// ---- the card pane: the discard prompt and the start step must be where the user can see them ----

function paneMemory() {
  const m = /\/\/ ---- pane memory[^\n]*\n([\s\S]*?)\/\/ ---- end pane memory ----/.exec(html);
  assert.ok(m, 'the pane memory block is missing from the board page');
  return vm.runInNewContext(`${m[1]}; ({ THREAD_PANES_KEY, CARD_PANES_KEY, loadCollapsed, saveCollapsedTo, revealCardPane })`);
}

test('a task page and a thread page remember their folded panes under different keys', () => {
  const { THREAD_PANES_KEY, CARD_PANES_KEY, loadCollapsed, saveCollapsedTo } = paneMemory();
  assert.notEqual(THREAD_PANES_KEY, CARD_PANES_KEY);
  assert.equal(THREAD_PANES_KEY, 'thread-board-panes', 'the thread key is the one earlier versions wrote');
  const data = {};
  const store = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
  saveCollapsedTo(store, THREAD_PANES_KEY, { left: true, right: false });
  assert.deepEqual(plain(loadCollapsed(store, THREAD_PANES_KEY)), { left: true, right: false });
  assert.deepEqual(plain(loadCollapsed(store, CARD_PANES_KEY)), { left: false, right: false }, 'folding a thread\'s pane does not fold a task\'s');
  saveCollapsedTo(store, CARD_PANES_KEY, { left: false, right: true });
  assert.deepEqual(plain(loadCollapsed(store, THREAD_PANES_KEY)), { left: true, right: false });
  assert.deepEqual(plain(loadCollapsed({ getItem() { throw new Error('blocked'); } }, 'k')), { left: false, right: false });
  assert.deepEqual(plain(loadCollapsed(null, 'k')), { left: false, right: false });
  saveCollapsedTo(null, 'k', {});   // no storage: no error
  data[CARD_PANES_KEY] = 'not json';
  assert.deepEqual(plain(loadCollapsed(store, CARD_PANES_KEY)), { left: false, right: false });
});

test('revealing the card pane selects its tab when narrow and unfolds it when wide, and says whether it changed anything', () => {
  const { revealCardPane } = paneMemory();
  const narrow = { narrow: true, view: 'conversation' };
  const mem = { left: true, right: true };
  assert.equal(revealCardPane(narrow, mem), true);
  assert.equal(narrow.view, 'about');
  assert.deepEqual(plain(mem), { left: true, right: true }, 'narrow layout ignores folding');
  assert.equal(revealCardPane(narrow, mem), false, 'already showing');
  const wide = { narrow: false, view: 'conversation' };
  assert.equal(revealCardPane(wide, mem), true);
  assert.equal(mem.left, false);
  assert.equal(mem.right, true, 'the other pane is left as it was');
  assert.equal(wide.view, 'conversation');
  assert.equal(revealCardPane(wide, mem), false);
});

test('the card workspace reveals its form for the discard prompt and for the start step, and the shells keep separate memories', () => {
  assert.match(html, /P\.showDiscard = \(\) => \{\n\s+if \(ws\) S\.reveal\(\);/, 'the discard prompt first brings the form into view');
  assert.match(html, /if \(ws\) \{ if \(P\.starting\) S\.reveal\(\); S\.applyPanes\(\); \}/, 'a page opened at the start step does too');
  assert.match(html, /function reveal\(\) \{ if \(revealCardPane\(P, o\.panes\)\) \{ saveCollapsedTo\(paneStore, o\.key, o\.panes\); applyPanes\(\); \} \}/);
  assert.match(html, /panes: wsCollapsed, key: THREAD_PANES_KEY/);
  assert.match(html, /panes: cardCollapsed, key: CARD_PANES_KEY/);
  assert.doesNotMatch(html, /sessionStorage\.(get|set)Item\(WS_KEY/);
});
