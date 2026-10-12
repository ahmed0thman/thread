import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupThreadEnv, waitFor, cleanAmbientEnv, freePort, McpClient, PARENT_SESSION } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();

const EXPECTED_TOOLS = [
  'thread_start', 'thread_continue', 'thread_status', 'thread_report', 'thread_end',
  'board_add', 'board_update', 'board_remove', 'board_list', 'board_open',
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

test('tools/list returns exactly the 10 tools, each with an object inputSchema', async (t) => {
  const e = setupThreadEnv(t);
  const c = start(t, e);
  await c.init();
  const r = await c.request('tools/list', {});
  const tools = r.result.tools;
  assert.equal(tools.length, 10);
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

test('board_open returns a tokened localhost URL with this project\'s tab when the board server is enabled', async (t) => {
  const e = setupThreadEnv(t);
  const port = await freePort();
  const c = start(t, e, { THREAD_NO_HTTP: '', THREAD_BOARD_PORT: String(port) });
  await c.init();
  const r = await c.call('board_open');
  const m = text(r).match(/(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/)\?t=([0-9a-f]{32,64})#\/([0-9a-f]{12})\b/);
  assert.ok(m, text(r));
  assert.equal(m[3], core.projectKey(e.projectDir));
  assert.equal(m[1], `http://127.0.0.1:${port}/`);
  const denied = await fetch(m[1] + 'api/state');
  assert.equal(denied.status, 401);
  const res = await fetch(m[1] + 'api/state', { headers: { 'X-Thread-Token': m[2] } });
  assert.equal(res.status, 200);
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
