import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LANE_EVENTS, MAX_LANE_LINE, laneReader, laneTranslator } from '../server/laneevents.mjs';
import { MAX_TEXT } from '../server/runs.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/lane-events/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const item = (type, value) => ({ type, item: value });

test('codex pairs starts and results, including completion-only tools and real MCP payloads', () => {
  const translate = laneTranslator('codex');
  const events = fixture('codex').flatMap(translate);
  assert.deepEqual(events, [
    { kind: 'tool', id: 'cmd1', name: 'shell', summary: 'cat src/a.js' },
    { kind: 'tool_result', id: 'cmd1', ok: true, preview: 'const café = 1;' },
    { kind: 'tool', id: 'edit1', name: 'edit', summary: 'update src/a.js, add b.js' },
    { kind: 'tool_result', id: 'edit1', ok: true, preview: '' },
    { kind: 'tool', id: 'mcp1', name: 'docs.find', summary: 'invoice' },
    { kind: 'tool_result', id: 'mcp1', ok: true, preview: 'Found docs' },
    { kind: 'tool', id: 'web1', name: 'web_search', summary: 'invoice rounding' },
    { kind: 'tool_result', id: 'web1', ok: true, preview: '' },
    { kind: 'text', text: 'Checked the invoice.' },
  ]);
});

test('codex failed commands, command arrays, failed MCP calls and clipping', () => {
  const translate = laneTranslator('codex');
  const events = translate(item('item.completed', { id: 'x', type: 'command_execution', command: ['sh', '-c', 'false'], exit_code: 1, status: 'completed', aggregated_output: 'x'.repeat(500) }));
  assert.equal(events[0].summary, 'sh -c false');
  assert.equal(events[1].ok, false);
  assert.equal(events[1].preview.length, 300);
  assert.equal(translate(item('item.completed', { id: 'y', type: 'command_execution', exit_code: 0, status: 'failed' }))[1].ok, false);
  assert.deepEqual(translate(item('item.completed', { id: 'm', type: 'mcp_tool_call', server: 'docs', tool: 'find', arguments: {}, status: 'failed', error: { message: 'no docs' } }))[1], { kind: 'tool_result', id: 'm', ok: false, preview: 'no docs' });
  assert.equal(translate(item('item.completed', { type: 'agent_message', text: 'x'.repeat(5000) }))[0].text.length, MAX_TEXT);
});

test('opencode finished tools, errors, filePath input and text part deduplication', () => {
  const translate = laneTranslator('opencode');
  assert.deepEqual(fixture('opencode').flatMap(translate), [
    { kind: 'tool', id: 'read1', name: 'read', summary: 'src/a.js' },
    { kind: 'tool_result', id: 'read1', ok: true, preview: 'const café = 1;' },
    { kind: 'tool', id: 'cmd2', name: 'bash', summary: 'false' },
    { kind: 'tool_result', id: 'cmd2', ok: false, preview: 'Command failed' },
    { kind: 'text', text: 'Checked the invoice.' },
  ]);
  const p = { type: 'text', part: { id: 'later', type: 'text', text: 'waiting', time: { start: 1 } } };
  assert.deepEqual(translate(p), []);
  p.part.time.end = 2;
  assert.deepEqual(translate(p), [{ kind: 'text', text: 'waiting' }]);
  assert.deepEqual(translate(p), []);
  assert.deepEqual(translate({ type: 'text', part: { id: 'no-time', type: 'text', text: 'done' } }), [{ kind: 'text', text: 'done' }]);
  const fallback = translate({ type: 'tool_use', part: { type: 'tool', tool: 'read', callID: 'title', state: { status: 'error', title: 'Read a file', error: 'no file' } } });
  assert.equal(fallback[0].summary, 'Read a file');
});

test('unknown events, incomplete events, and non-objects are ignored', () => {
  for (const provider of ['codex', 'opencode']) {
    const translate = laneTranslator(provider);
    for (const v of [null, undefined, true, 42, 'text', [], {}, { type: 'unknown' }, { type: 'error', message: 'ignored' }, { type: 'item.updated', item: { type: 'command_execution', id: 'x' } }, { type: 'item.completed', item: { type: 'reasoning', text: 'private' } }]) assert.deepEqual(translate(v), []);
  }
  assert.equal(laneTranslator('agy'), null);
  assert.equal(laneTranslator('claude'), null);
});

test('hostile values never throw, and only strings are used', () => {
  const bad = { toString: 1 };
  const codex = laneTranslator('codex');
  const opencode = laneTranslator('opencode');
  const values = [bad, [bad], [[bad]], 1, true, null, { valueOf: 1 }, 'x'.repeat(100000)];
  for (const v of values) {
    for (const ev of [
      item('item.started', { type: 'command_execution', id: 'a', command: v }),
      item('item.completed', { type: 'command_execution', id: 'b', command: v, exit_code: v, aggregated_output: v }),
      item('item.completed', { type: 'file_change', id: 'c', status: v, changes: [{ kind: v, path: v }, v, null] }),
      item('item.completed', { type: 'file_change', id: 'd', changes: v }),
      item('item.started', { type: 'mcp_tool_call', id: 'e', server: v, tool: v, arguments: v }),
      item('item.completed', { type: 'mcp_tool_call', id: 'f', server: 's', tool: 't', error: v, result: v }),
      item('item.completed', { type: 'mcp_tool_call', id: 'g', server: 's', tool: 't', error: { message: v }, result: { content: v } }),
      item('item.started', { type: 'web_search', id: 'h', query: v }),
      item('item.completed', { type: 'agent_message', text: v }),
      item('item.completed', v),
      { type: 'item.completed', item: { type: 'command_execution', id: v, command: 'ls' } },
    ]) {
      assert.doesNotThrow(() => codex(ev), JSON.stringify(ev).slice(0, 80));
    }
    for (const part of [
      { type: 'tool', callID: 'x', tool: 'read', state: { status: 'completed', input: v, output: v, title: v } },
      { type: 'tool', callID: 'y', tool: v, state: { status: 'error', input: { filePath: v, file_path: v }, error: v } },
      { type: 'tool', callID: v, tool: 'read', state: v },
      { type: 'text', id: 'z', text: v, time: v },
    ]) {
      assert.doesNotThrow(() => opencode({ type: part.type === 'text' ? 'text' : 'tool_use', part }));
    }
  }
  // the pieces of a hostile event that are strings are still used; the rest are left out
  assert.deepEqual(codex(item('item.started', { type: 'command_execution', id: 'k', command: ['sh', bad, '-c', 'ls'] })), [{ kind: 'tool', id: 'k', name: 'shell', summary: 'sh -c ls' }]);
  assert.deepEqual(codex(item('item.started', { type: 'mcp_tool_call', id: 'm', server: bad, tool: 'find' }))[0].name, 'find');
  assert.deepEqual(codex(item('item.started', { type: 'mcp_tool_call', id: 'n', server: bad, tool: bad }))[0].name, 'mcp');
  assert.equal(codex(item('item.completed', { type: 'file_change', id: 'o', status: 'completed', changes: [{ kind: 'add', path: bad }, { kind: 'update', path: 'a.js' }] }))[0].summary, 'add, update a.js');
});

test('tool ids and names are clipped, and a clipped id still pairs its start with its result', () => {
  const translate = laneTranslator('codex');
  const id = 'i'.repeat(5000);
  const started = translate(item('item.started', { type: 'mcp_tool_call', id, server: 'n'.repeat(5000), tool: 't' }));
  assert.ok(started[0].id.length <= 200 && started[0].name.length <= 100);
  const done = translate(item('item.completed', { type: 'mcp_tool_call', id, server: 'n'.repeat(5000), tool: 't', status: 'completed' }));
  assert.deepEqual(done.map((v) => v.kind), ['tool_result'], 'the start was not repeated');
  assert.equal(done[0].id, started[0].id);
});

// ---------------------------------------------------------------- laneReader (the runner's drain)

function reader(t, onLine, options) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-lane-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'events.jsonl');
  return { file, r: laneReader(file, onLine, options) };
}

test('laneReader waits for a missing file, keeps a partial line and a split UTF-8 character until the next drain', (t) => {
  const lines = [];
  const { file, r } = reader(t, (l) => lines.push(l));
  r.drain();
  assert.deepEqual(lines, []);
  const bytes = Buffer.from('{"a":"café"}\n{"b":"ü€😀"}\n{"c":1}');
  const cafe = bytes.indexOf(Buffer.from('é'));
  writeFileSync(file, bytes.subarray(0, cafe + 1));   // one byte of the two-byte character
  r.drain();
  assert.deepEqual(lines, []);
  const euro = bytes.indexOf(Buffer.from('€'));
  appendFileSync(file, bytes.subarray(cafe + 1, euro + 2));   // the character completes; the euro sign and the line do not
  r.drain();
  assert.deepEqual(lines, ['{"a":"café"}']);
  appendFileSync(file, bytes.subarray(euro + 2));
  r.drain();
  assert.deepEqual(lines, ['{"a":"café"}', '{"b":"ü€😀"}']);
  r.end();
  assert.deepEqual(lines, ['{"a":"café"}', '{"b":"ü€😀"}', '{"c":1}'], 'end() hands over the last line that has no newline');
  r.end();
  r.drain();
  assert.equal(lines.length, 3, 'nothing is read twice');
});

test('laneReader reads a file bigger than its chunk and skips only the line that is over the cap', (t) => {
  const lines = [];
  const { file, r } = reader(t, (l) => lines.push(l), { maxLine: 100, chunk: 16 });
  const big = 'x'.repeat(5000);
  writeFileSync(file, `{"n":1}\n${big}\n{"n":2}\n${big}`);
  r.drain();
  assert.deepEqual(lines, ['{"n":1}', '{"n":2}']);
  appendFileSync(file, 'tail-of-a-skipped-line\n{"n":3}');
  r.drain();
  assert.deepEqual(lines, ['{"n":1}', '{"n":2}'], 'the rest of a skipped line is skipped too');
  r.end();
  assert.deepEqual(lines, ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test('laneReader skips a line over MAX_LANE_LINE and reads on', (t) => {
  assert.equal(MAX_LANE_LINE, 8 * 1024 * 1024);
  const lines = [];
  const { file, r } = reader(t, (l) => lines.push(l.length));
  writeFileSync(file, `ok\n${'y'.repeat(MAX_LANE_LINE + 10)}\nafter\n`);
  r.drain();
  assert.deepEqual(lines, [2, 5]);
  assert.equal(MAX_LANE_EVENTS, 50 * 1024 * 1024);
});

test('laneReader reads no more than maxBytes, and a line that throws loses only that line', (t) => {
  const lines = [];
  const { file, r } = reader(t, (l) => { if (l === 'boom') throw new Error('x'); lines.push(l); }, { maxBytes: 20, chunk: 7 });
  writeFileSync(file, 'one\nboom\ntwo\nthree\nfour\nfive\nsix\n');
  r.drain();
  r.drain();
  assert.deepEqual(lines, ['one', 'two', 'three'], 'the throwing line is lost alone; the 20 bytes end inside "four"');
  r.end();
  assert.deepEqual(lines, ['one', 'two', 'three', 'f'], 'only the byte that was read is left over');
});
