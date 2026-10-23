import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, waitFor, cleanAmbientEnv, freePort, McpClient, PARENT_SESSION, RECORD_OPENER, FAIL_OPENER } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();

const EXPECTED_TOOLS = [
  'thread_start', 'thread_continue', 'thread_status', 'thread_report', 'thread_end',
  'board_add', 'board_update', 'board_remove', 'board_list', 'board_import', 'board_open', 'board_stop',
  'wait_add', 'wait_list', 'wait_close', 'lane_list', 'config_get', 'config_set',
];

function start(t, e, extraEnv) {
  const c = new McpClient(e, extraEnv);
  t.after(() => c.kill());
  return c;
}
const text = (result) => {
  assert.ok(Array.isArray(result.content) && result.content.length === 1, 'one content block');
  assert.equal(result.content[0].type, 'text');
  return result.content[0].text;
};

test('initialize echoes protocolVersion and names the server thread', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  const r = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'thread');
  assert.ok(r.result.capabilities && 'tools' in r.result.capabilities);
});

test('initialize carries the usage guide: the full one for a board project, the thread part for a chat-only one', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  const r = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const ins = r.result.instructions;
  assert.equal(typeof ins, 'string');
  for (const word of ['board_add', 'wait_add', 'Waiting on you: c37.w2', 'answered_in_chat', '[c12]', 'worker', 'board_list', 'thread_report', 'never mark', 'did not verify', 'thread_start (lane, card)', 'delegate relay']) {
    assert.ok(ins.toLowerCase().includes(word.toLowerCase()), `instructions say ${word}`);
  }
  assert.ok(ins.length < 1800, `short: ${ins.length}`);

  await core.saveConfig(e.projectDir, 'project', { mode: 'chat' });
  const chat = start(t, e);
  const cr = await chat.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  const cins = cr.result.instructions;
  assert.match(cins, /thread_report/);
  assert.doesNotMatch(cins, /board_add|wait_add|board_update/);
  assert.ok(cins.length < ins.length);

  const side = start(t, e, { THREAD_DEPTH: '1' });
  const sr = await side.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal('instructions' in sr.result, false);
});

test('tools/list returns exactly the 18 tools, each with an object inputSchema', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const r = await c.request('tools/list', {});
  const tools = r.result.tools;
  assert.equal(tools.length, 18);
  assert.deepEqual(tools.map((x) => x.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} inputSchema`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} description`);
  }
});

test('board_add then board_list round-trips the title and id', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const added = await c.call('board_add', { title: 'Write the migration notes' });
  assert.notEqual(added.isError, true);
  const addedText = text(added);
  const id = addedText.match(/\bc\d+\b/)?.[0];
  assert.ok(id, `card id in "${addedText}"`);
  const list = await c.call('board_list');
  assert.notEqual(list.isError, true);
  const listText = text(list);
  assert.ok(listText.includes('Write the migration notes'));
  assert.ok(listText.includes(id));
  assert.equal(core.readState(e.projectDir).cards[0].title, 'Write the migration notes');
});

test('board_list flags cards added by the user once, then marks them seen', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  await core.addCard(e.projectDir, { title: 'Web card', source: 'user' });
  const first = text(await c.call('board_list'));
  assert.ok(first.includes('Web card'));
  assert.ok(first.includes('(new from user)'));
  const second = text(await c.call('board_list'));
  assert.ok(second.includes('Web card'));
  assert.ok(!second.includes('(new from user)'));
});

test('board_update and board_remove work through the tools', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  await c.call('board_add', { title: 'Item' });
  const upd = await c.call('board_update', { id: 'c1', status: 'review', title: 'Item renamed' });
  assert.notEqual(upd.isError, true);
  assert.equal(core.readState(e.projectDir).cards[0].status, 'review');
  assert.equal(core.readState(e.projectDir).cards[0].title, 'Item renamed');
  const rm = await c.call('board_remove', { id: 'c1' });
  assert.notEqual(rm.isError, true);
  assert.equal(core.readState(e.projectDir).cards.length, 0);
});

test('thread_start returns a card id; thread_status later shows idle; thread_report returns the digest', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const started = await c.call('thread_start', { title: 'Research', task: 'look into things', session_id: PARENT_SESSION });
  assert.notEqual(started.isError, true, started.content?.[0]?.text);
  const id = text(started).match(/\bc\d+\b/)?.[0];
  assert.ok(id, 'card id in start result');

  await waitFor(async () => /idle/.test(text(await c.call('thread_status', { id }))), { timeout: 10000, interval: 100 });
  const status = text(await c.call('thread_status', { id }));
  assert.ok(status.includes(id));
  assert.ok(status.includes('Research'));

  const all = text(await c.call('thread_status', {}));
  assert.ok(all.includes(id));

  const rep = await c.call('thread_report', { id, session_id: PARENT_SESSION });
  assert.notEqual(rep.isError, true);
  assert.ok(text(rep).includes('## Happened'));
  assert.equal(core.readState(e.projectDir).cards[0].thread.reported, true);
});

test('thread_start falls back to CLAUDE_CODE_SESSION_ID when session_id is omitted', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e, { CLAUDE_CODE_SESSION_ID: PARENT_SESSION });
  await c.init();
  const started = await c.call('thread_start', { title: 'Env session', task: 'do it' });
  assert.notEqual(started.isError, true, started.content?.[0]?.text);
  assert.equal(core.readState(e.projectDir).cards[0].thread.parentSessionId, PARENT_SESSION);
});

test('thread_continue and thread_end work through the tools', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  await c.call('thread_start', { title: 'T', task: 'first', session_id: PARENT_SESSION });
  await waitFor(() => core.readState(e.projectDir).cards[0].thread.runState === 'idle', { timeout: 10000 });
  const cont = await c.call('thread_continue', { id: 'c1', message: 'and more' });
  assert.notEqual(cont.isError, true, cont.content?.[0]?.text);
  await waitFor(() => { const th = core.readState(e.projectDir).cards[0].thread; return th.runState === 'idle' && th.turns.length === 2; }, { timeout: 10000 });
  const end = await c.call('thread_end', { id: 'c1', session_id: PARENT_SESSION });
  assert.notEqual(end.isError, true);
  assert.equal(core.readState(e.projectDir).cards[0].thread.runState, 'ended');
});

test('board_open returns text when the HTTP server is disabled', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const r = await c.call('board_open');
  assert.equal(r.content[0].type, 'text');
  assert.ok(r.content[0].text.length > 0);
  assert.match(r.content[0].text, /disabled|unavailable/i);
  assert.doesNotMatch(r.content[0].text, /\?t=/);
});

test('board_open opens the browser with a one-time code, never the token; the code trades for the token once; the tokened link stays in an owner-only file', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const log = path.join(e.base, 'opened.txt');
  const c = start(t, e, { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port), THREAD_NO_OPEN: '', THREAD_OPENER: RECORD_OPENER, THREAD_OPENER_LOG: log });
  await c.init();
  const r = await c.call('board_open');
  const key = core.projectKey(e.projectDir);
  const file = path.join(e.dataDir, 'board-link.txt');
  assert.match(text(r), new RegExp(`^Opened the board in your browser: http://127\\.0\\.0\\.1:${port}/#/${key}\\n`));
  assert.ok(text(r).includes(file), 'the answer names the file with the link, on success too');
  assert.doesNotMatch(text(r), /\?[tc]=|[0-9a-f]{32}/, 'no token and no code in the answer');
  assert.match(text(r), /works in a browser that has opened the board before; \/thread:board opens it again\./);
  const opened = await waitFor(() => { try { return fs.readFileSync(log, 'utf8').trim(); } catch { return ''; } });
  const m = opened.match(/^(http:\/\/127\.0\.0\.1:\d+\/)\?c=([0-9a-f]{32})#\/([0-9a-f]{12})$/);
  assert.ok(m, `the opener got a link with a code: ${opened.replace(/[0-9a-f]{32}/g, '<hex>')}`);
  assert.equal(m[1], `http://127.0.0.1:${port}/`);
  assert.equal(m[3], key);
  const linked = fs.readFileSync(file, 'utf8').trim();
  const t2 = linked.match(/^(http:\/\/127\.0\.0\.1:\d+\/)\?t=([0-9a-f]{32,64})#\/([0-9a-f]{12})$/);
  assert.ok(t2, 'the file holds the tokened link, for opening by hand');
  assert.equal(opened.includes(t2[2]), false, 'the opener\'s argument never holds the token');
  assert.equal((await fetch(m[1] + 'api/state')).status, 401);
  assert.equal((await fetch(m[1] + 'api/state', { headers: { 'X-Thread-Token': t2[2] } })).status, 200);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'the file is owner-only');
  assert.doesNotMatch(text(r), new RegExp(t2[2]), 'the answer never holds the token');

  // the page's trade: once, from the board's own origin
  const post = (code, origin = `http://127.0.0.1:${port}`) => fetch(m[1] + 'api/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ code }) });
  const got = await post(m[2]);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).token, t2[2]);
  assert.equal((await post(m[2])).status, 401, 'a used code is dead');
  // and a second call to the tool makes a new code
  await c.call('board_open');
  const second = await waitFor(() => { const l = fs.readFileSync(log, 'utf8').trim().split('\n'); return l.length > 1 ? l[1] : ''; });
  assert.notEqual(second.match(/\?c=([0-9a-f]{32})/)[1], m[2]);
});

test('a guest session\'s board_open gets its code from the session that serves the board', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const log = path.join(e.base, 'opened.txt');
  const env = { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port), THREAD_NO_OPEN: '', THREAD_OPENER: RECORD_OPENER, THREAD_OPENER_LOG: log };
  const owner = start(t, e, env);
  await owner.init();
  await owner.call('board_open', { open: false });
  const guest = start(t, e, env);
  await guest.init();
  const r = await guest.call('board_open');
  assert.match(text(r), /^Opened the board in your browser:/);
  const opened = await waitFor(() => { try { return fs.readFileSync(log, 'utf8').trim(); } catch { return ''; } });
  const m = opened.match(/\?c=([0-9a-f]{32})#/);
  assert.ok(m, opened.replace(/[0-9a-f]{32}/g, '<hex>'));
  const res = await fetch(`http://127.0.0.1:${port}/api/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ code: m[1] }) });
  assert.equal(res.status, 200, 'the owner knows the code the guest was given');
});

test('board_open with open: false, or THREAD_NO_OPEN=1, opens nothing and still keeps the link file; an opener that fails or cannot start is said', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const log = path.join(e.base, 'opened.txt');
  const env = { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port), THREAD_NO_OPEN: '', THREAD_OPENER: RECORD_OPENER, THREAD_OPENER_LOG: log };
  const c = start(t, e, env);
  await c.init();
  const key = core.projectKey(e.projectDir);
  const r = await c.call('board_open', { open: false });
  assert.match(text(r), new RegExp(`^Board: http://127\\.0\\.0\\.1:${port}/#/${key}\\n`));
  assert.match(text(r), /board-link\.txt/);
  assert.doesNotMatch(text(r), /\?[tc]=|[0-9a-f]{32}/);
  assert.ok(fs.existsSync(path.join(e.dataDir, 'board-link.txt')));
  const never = start(t, e, { ...env, THREAD_NO_OPEN: '1' });
  await never.init();
  assert.doesNotMatch(text(await never.call('board_open')), /Opened the board/);
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(fs.existsSync(log), false, 'nothing was opened');
  const broken = start(t, e, { ...env, THREAD_OPENER: path.join(e.base, 'no-such-opener') });
  await broken.init();
  const bad = text(await broken.call('board_open'));
  assert.match(bad, /^Could not open a browser\./);
  assert.match(bad, /board-link\.txt/);
  assert.doesNotMatch(bad, /\?[tc]=|[0-9a-f]{32}/);
  // an opener that starts and then exits with an error is no success
  const failing = start(t, e, { ...env, THREAD_OPENER: FAIL_OPENER });
  await failing.init();
  const failed = text(await failing.call('board_open'));
  assert.match(failed, /^Could not open a browser\./);
  assert.doesNotMatch(failed, /Opened the board/);
  assert.match(failed, /board-link\.txt/);
});

test('board_stop replaces the board token, so a token a browser kept opens nothing; the next board_open makes a fresh one', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const c = start(t, e, { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port), THREAD_NO_OPEN: '1' });
  await c.init();
  await c.call('board_open', { open: false });
  const tokenFile = path.join(e.dataDir, 'board.token');
  const old = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Thread-Token': old } })).status, 200);
  assert.match(text(await c.call('board_stop')), /^Board stopped\./);
  assert.equal(fs.existsSync(tokenFile), false, 'the token is gone');
  assert.equal(JSON.stringify(text(await c.call('board_stop'))).includes(old), false);
  await c.call('board_open', { open: false });
  const fresh = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.notEqual(fresh, old);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Thread-Token': old } })).status, 401, 'the old token opens nothing');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Thread-Token': fresh } })).status, 200);
  assert.ok(fs.readFileSync(path.join(e.dataDir, 'board-link.txt'), 'utf8').includes(fresh), 'the link file holds the new token');
});

test('wait_add hands back the chat pointer as a tokenless link to the card page on the running board, and the plain id when there is no board', async (t) => {
  const e = setupThreadEnv(t);
  await core.addCard(e.projectDir, { title: 'Fix the importer' });
  const port = await freePort();
  const c = start(t, e, { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port) });
  await c.init();
  const sid = '11111111-2222-4333-8444-555555555555';
  const r = await c.call('wait_add', { card: 'c1', kind: 'question', text: 'Which importer?', session_id: sid });
  const key = core.projectKey(e.projectDir);
  assert.ok(text(r).includes(`"Waiting on you: [c1.w1](http://127.0.0.1:${port}/#/${key}/c1)"`), text(r));
  assert.doesNotMatch(text(r), /\?t=|#t=|[0-9a-f]{32}/, 'no token in the answer');

  const off = setupThreadEnv(t);
  await core.addCard(off.projectDir, { title: 'Fix the importer' });
  const c2 = start(t, off);
  await c2.init();
  const r2 = await c2.call('wait_add', { card: 'c1', kind: 'question', text: 'Which importer?', session_id: sid });
  assert.match(text(r2), /"Waiting on you: c1\.w1"/);
});

test('unknown tool and missing required argument return isError true, and the server still answers a ping', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const unknown = await c.request('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.equal(unknown.result?.isError, true, JSON.stringify(unknown));
  assert.equal(unknown.result.content[0].type, 'text');
  const missing = await c.request('tools/call', { name: 'board_add', arguments: {} });
  assert.equal(missing.result?.isError, true, JSON.stringify(missing));
  const missing2 = await c.request('tools/call', { name: 'thread_start', arguments: { title: 'only title' } });
  assert.equal(missing2.result?.isError, true, JSON.stringify(missing2));
  const unknownId = await c.request('tools/call', { name: 'board_remove', arguments: { id: 'c999' } });
  assert.equal(unknownId.result?.isError, true, JSON.stringify(unknownId));
  const ping = await c.request('ping', {});
  assert.deepEqual(ping.result, {});
});

test('a garbage line does not kill the server', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  c.raw('this is not json {{{');
  c.raw('');
  c.raw('[1,2');
  const ping = await c.request('ping', {});
  assert.deepEqual(ping.result, {});
  assert.equal(await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('alive'), 100))]), 'alive');
});

test('an unknown method returns error code -32601', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const r = await c.request('does/not/exist', {});
  assert.equal(r.error?.code, -32601);
  assert.equal(r.result, undefined);
});

test('a notification gets no reply', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const before = c.lines.length;
  c.notify('notifications/initialized');
  c.notify('notifications/cancelled', { requestId: 999 });
  c.notify('some/unknown_notification');
  const ping = await c.request('ping', {});
  assert.deepEqual(ping.result, {});
  assert.equal(c.lines.length - before, 1, `only the ping reply expected, got: ${c.lines.slice(before).join(' | ')}`);
});

test('every stdout line is valid JSON-RPC', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  c.raw('garbage');
  await c.request('tools/list', {});
  await c.request('nope', {});
  await c.call('board_add', { title: 'x' });
  await c.call('board_list');
  await c.request('ping', {});
  assert.ok(c.lines.length >= 5);
  for (const line of c.lines) {
    let msg;
    assert.doesNotThrow(() => { msg = JSON.parse(line); }, `not JSON: ${line}`);
    assert.equal(msg.jsonrpc, '2.0', line);
  }
});
