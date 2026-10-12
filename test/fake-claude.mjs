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
    JSON.stringify({ argv: process.argv.slice(2), prompt, cwd: process.cwd(), depth: process.env.THREAD_DEPTH }) + '\n',
  );
}
// Test-only extra: lets the harness kill leftover children. Not part of the behaviour contract.
if (process.env.FAKE_CLAUDE_PIDFILE) {
  appendFileSync(process.env.FAKE_CLAUDE_PIDFILE, process.pid + '\n');
}

const SESSION = '11111111-2222-4333-8444-555555555555';
const OK = '{"type":"result","subtype":"success","is_error":false,"result":"done\\n## Happened\\nx\\n## Decided\\ny\\n## Changed\\nz\\n## Open\\nnone","session_id":"' + SESSION + '"}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  case 'slow':
    await sleep(Number(process.env.FAKE_CLAUDE_DELAY_MS || 500));
    process.stdout.write(OK + '\n');
    process.exit(0);
    break;
  default:
    process.stdout.write(OK + '\n');
    process.exit(0);
}
