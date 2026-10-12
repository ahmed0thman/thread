#!/usr/bin/env node
// Fake `claude` CLI for tests. Behaviour is selected by FAKE_CLAUDE_MODE.
import { appendFileSync } from 'node:fs';

// `node --test` (no args) globs every .mjs under test/ and would run this file as a test with
// no stdin to read. The real thread runner always passes arguments (-p ...), so bail out when none.
if (process.argv.length <= 2) process.exit(0);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ argv: process.argv.slice(2), prompt, cwd: process.cwd(), depth: process.env.THREAD_DEPTH, threadProjectDir: process.env.THREAD_PROJECT_DIR, claudeProjectDir: process.env.CLAUDE_PROJECT_DIR }) + '\n',
  );
}
// Test-only extra: lets the harness kill leftover children. Not part of the behaviour contract.
if (process.env.FAKE_CLAUDE_PIDFILE) {
  appendFileSync(process.env.FAKE_CLAUDE_PIDFILE, process.pid + '\n');
}

const SESSION = '11111111-2222-4333-8444-555555555555';
const OK = '{"type":"result","subtype":"success","is_error":false,"result":"done\\n## Happened\\nx\\n## Decided\\ny\\n## Changed\\nz\\n## Open\\nnone","session_id":"' + SESSION + '"}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const line = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const assistant = (content, parent = null) => line({ type: 'assistant', message: { content }, parent_tool_use_id: parent });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, extra = {}) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, parent_tool_use_id: null });

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
switch (mode) {
  case 'fail':
    process.stderr.write('boom');
    process.exit(3);
    break;
  case 'garbage':
    process.stdout.write('not json\n');
    process.exit(0);
    break;
  case 'error':
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'something went wrong', session_id: SESSION }) + '\n');
    process.exit(0);
    break;
  case 'hang':
    await sleep(60000);
    process.exit(0);
    break;
  case 'stream':
    line({ type: 'system', subtype: 'init', session_id: SESSION });
    assistant([{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Looking at the file.' }, toolUse('toolu_1', 'Read', { file_path: '/p/src/a.js', path: '/ignored', command: 'ignored' })]);
    toolResult('toolu_1', [{ type: 'text', text: 'line one\n   line two' }]);
    assistant([toolUse('toolu_2', 'Grep', { pattern: 'foo' })], 'toolu_0');
    line('this line is not json {{{');
    line(OK);
    process.exit(0);
    break;
  case 'stream-no-newline':
    process.stdout.write(OK);
    process.exit(0);
    break;
  case 'stream-fail':
    assistant([toolUse('toolu_1', 'Read', { file_path: '/p/a' })]);
    process.stderr.write('boom');
    process.exit(3);
    break;
  case 'stream-edge':
    assistant([{ type: 'text', text: 'word '.repeat(1000) }]);
    assistant([toolUse('toolu_1', 'Mystery', { foo: 'bar', n: 1 }), toolUse('toolu_2', 'Bash', { command: 'echo '.repeat(100), query: 'ignored' }), toolUse('toolu_3', 'Mystery', undefined)]);
    toolResult('toolu_2', 'y '.repeat(400), { is_error: true });
    line(OK);
    process.exit(0);
    break;
  case 'stream-many':
    for (let i = 0; i < 1100; i++) assistant([toolUse(`toolu_${i}`, 'Read', { file_path: `/p/${i}` })]);
    line(OK);
    await new Promise((r) => process.stdout.write('', r)); // more than a pipe holds: let it drain before exiting
    process.exit(0);
    break;
  case 'slow':
    await sleep(Number(process.env.FAKE_CLAUDE_DELAY_MS || 500));
    process.stdout.write(OK + '\n');
    process.exit(0);
    break;
  default:
    process.stdout.write(OK + '\n');
    process.exit(0);
}
