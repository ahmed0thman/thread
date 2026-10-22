// Stands in for the four delegate relays (<provider>-delegate/scripts/relay.mjs). It writes result.json with the keys the real
// relay of that provider writes for that status (checked against real runs and the relays' source): no more, so that a reader of
// the result cannot lean on a key a real one lacks. It never starts a real provider CLI, and never writes an agy.log.
// FAKE_RELAY_LOG: a file that gets one JSON line per run: { implementer, argv, brief, depth, threadEnv, cwd, pid }.
// FAKE_RELAY_MODE: ok (default), failed (codex, opencode and agy: stderrTail and no error; claude: stderrTail and error),
// timeout (stderrTail and error), unavailable (<provider>_unavailable, exit 127, a message on stderr, nothing else),
// exit2 (usage error: no result.json), noresume (no resume id), slow (waits FAKE_RELAY_DELAY_MS, 60 s when unset; on SIGTERM writes
// an aborted result and exits 143), garbage (result.json is not JSON), emptyreport (completed, finalMessage "").
// failedevents: failed with no error and an empty stderrTail; the reason is only in events.jsonl, as a real codex run with a bad model
// writes it (opencode: an error event; claude: a result event with is_error).
// live: streams fixture events every FAKE_RELAY_STEP_MS (default 50); opencode writes split UTF-8 chunks.
// FAKE_RELAY_EVENTS_FILE: with failedevents, a file to use as events.jsonl instead; in live mode (codex, opencode), a file whose lines are streamed instead of the fixture.
// FAKE_RELAY_STDERR_TAIL: the failed run's stderrTail lines, separated by "|" (default "boom").
// FAKE_RELAY_TOUCHED: touchedFiles as git porcelain lines separated by "|" (default none); FAKE_RELAY_VIOLATION: true or null,
// readOnlyViolation of a read-only agy or claude run (default false).
// FAKE_RELAY_EVENTS=1: a claude run also writes events.jsonl (tool steps and a result event with usage) and result.json usage;
// FAKE_RELAY_EVENTS=usage: only the usage in result.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESUME = { codex: ['--session', 'threadId'], agy: ['--conversation', 'conversationId'], opencode: ['--session', 'sessionId'], claude: ['--session', 'sessionId'] };

export function run(implementer) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--brief')) process.exit(0);   // `node --test` also loads files under test/: do nothing when nobody asked for a run
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const brief = opt('--brief');
  const outDir = opt('--out-dir');
  const [resumeFlag, idKey] = RESUME[implementer];
  const resumed = opt(resumeFlag);
  const readOnly = argv.includes('--read-only') || opt('--sandbox') === 'read-only';
  const mode = process.env.FAKE_RELAY_MODE || 'ok';
  if (process.env.FAKE_RELAY_LOG) {
    const threadEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(THREAD_|CLAUDE_PROJECT_DIR$)/.test(k) && k !== 'THREAD_DATA_DIR').map(([k, v]) => [k, k === 'THREAD_DEPTH' ? v : '(set)']));
    let text = null;
    try { text = fs.readFileSync(brief, 'utf8'); } catch { /* no brief file */ }
    fs.appendFileSync(process.env.FAKE_RELAY_LOG, JSON.stringify({ implementer, argv, brief: text, depth: process.env.THREAD_DEPTH || null, threadEnv, cwd: process.cwd(), pid: process.pid }) + '\n');
  }
  if (mode === 'exit2') { process.stderr.write('error: lane "x" is not approved: the project config has not been approved\nsecond line\n'); process.exit(2); }

  const id = mode === 'noresume' ? null : resumed || `${implementer}-sess-1`;
  const message = `${implementer} lane reply${resumed ? ` (resumed ${resumed})` : ''}\n## Happened\n- did the work\n## Decided\n- nothing\n## Changed\nNothing.\n## Open\n- none`;
  const startedAt = new Date().toISOString();
  const touched = process.env.FAKE_RELAY_TOUCHED ? process.env.FAKE_RELAY_TOUCHED.split('|') : [];
  const violation = process.env.FAKE_RELAY_VIOLATION === 'true' ? true : process.env.FAKE_RELAY_VIOLATION === 'null' ? null : false;
  const tailLines = (process.env.FAKE_RELAY_STDERR_TAIL || 'boom').split('|');
  const p = (name) => path.join(outDir, name);
  const common = { schema: 'delegate-relay.result.v1', lane: opt('--lane') || null, laneSource: null };

  // Keys of a real result for each provider, as in the runs under relay-proof and the relays' source.
  const bases = {
    codex: () => ({ ...common, workdir: opt('--cd'), sandbox: readOnly ? 'read-only' : (opt('--sandbox') || 'workspace-write'), model: 'gpt-fake', effort: 'high', resumeLast: false, session: resumed || null, cleanEnv: false, ignoreUserConfig: false, keepEnv: [], codexVersion: 'codex-cli 0.160.0', startedAt, finishedAt: new Date().toISOString(), briefPath: brief, eventsPath: p('events.jsonl'), finalPath: p('final.txt'), stderrPath: p('stderr.txt') }),
    agy: () => ({ ...common, tool: 'agy', workdir: opt('--cd'), model: 'gemini-fake', effort: null, project: null, sandbox: false, readOnly, readOnlyViolation: readOnly ? violation : null, dangerouslySkipPermissions: false, resumed: Boolean(resumed), agyVersion: '1.3.4', projectId: 'project-1', startedAt, finishedAt: new Date().toISOString(), briefPath: brief, finalPath: p('final.txt'), logPath: p('agy.log'), stderrPath: p('stderr.txt') }),
    opencode: () => ({ ...common, tool: 'opencode', workdir: opt('--cd'), agent: readOnly ? 'plan' : null, model: 'vendor/model-x', variant: 'max', auto: true, resumed: Boolean(resumed), resumeLast: false, opencodeVersion: '1.18.34', startedAt, finishedAt: new Date().toISOString(), briefPath: brief, eventsPath: p('events.jsonl'), finalPath: p('final.txt') }),
    claude: () => ({ ...common, tool: 'claude', workdir: opt('--cd'), model: 'claude-fake', effort: 'medium', maxTurns: null, maxBudgetUsd: null, timeout: opt('--timeout') || null, readOnly, permissionMode: readOnly ? 'plan' : 'default', toolSurface: [], dangerouslySkipPermissions: false, claudeVersion: '2.1.289 (Claude Code)', resultSubtype: null, numTurns: null, totalCostUsd: null, ...(readOnly ? { readOnlyViolation: violation } : {}), startedAt, finishedAt: new Date().toISOString(), briefPath: brief, eventsPath: p('events.jsonl'), finalPath: p('final.txt'), stderrPath: p('stderr.txt') }),
  };
  // the field that holds the resume id sits after `signal` in a real result
  const write = (status, exitCode, extra = {}, { touchedFiles = touched } = {}) => {
    const result = { ...bases[implementer](), status, exitCode, signal: null, [idKey]: id, ...(implementer === 'opencode' ? { cost: null } : {}), finalMessage: '', touchedFiles, ...extra };
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(p('result.json'), mode === 'garbage' ? 'not json {' : JSON.stringify(result, null, 2));
  };
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };
  const done = () => {
    if (mode === 'failed') {
      write('failed', 1, { stderrTail: tailLines, ...(implementer === 'claude' ? { error: 'claude returned an error result (error_during_execution)' } : {}) });
      process.exit(1);
    }
    if (mode === 'failedevents') {
      const inner = "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.";
      const body = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: inner } });
      const events = {
        codex: [{ type: 'thread.started', thread_id: id }, { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `no-such-model-xyz` not found. Defaulting to fallback metadata.' } }, { type: 'turn.started' }, { type: 'error', message: body }, { type: 'turn.failed', error: { message: body } }],
        opencode: [{ type: 'step_start' }, { type: 'error', timestamp: 1, sessionID: id, error: { name: 'APIError', data: { message: inner } } }],
        claude: [{ type: 'system', subtype: 'init', session_id: id }, { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id, result: inner }],
        agy: [],
      }[implementer];
      fs.mkdirSync(outDir, { recursive: true });
      if (process.env.FAKE_RELAY_EVENTS_FILE) fs.copyFileSync(process.env.FAKE_RELAY_EVENTS_FILE, p('events.jsonl'));   // events of the test's own making
      else if (implementer !== 'agy') fs.writeFileSync(p('events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      write('failed', 1, { stderrTail: [] });
      process.exit(1);
    }
    if (mode === 'timeout') {
      write('timeout', 124, { signal: null, stderrTail: tailLines, error: `${implementer} did not finish within --timeout ${opt('--timeout')}; killed by the relay watchdog` });
      process.exit(124);
    }
    if (mode === 'unavailable') {
      // like the real ones: nothing but the status, and the reason on the relay's stderr
      write(`${implementer}_unavailable`, 127, {}, { touchedFiles: null });
      process.stderr.write(`relay: \`${implementer}\` not found on PATH. Install it and log in.\n`);
      process.exit(127);
    }
    const extra = { finalMessage: mode === 'emptyreport' ? '' : message };
    if (implementer === 'agy' && !extra.finalMessage) extra.stderrTail = [];
    if (implementer === 'claude' && (process.env.FAKE_RELAY_EVENTS || mode === 'live')) {
      extra.usage = usage; extra.numTurns = 2; extra.totalCostUsd = 0.01; extra.resultSubtype = 'success';
    }
    if (implementer === 'claude' && process.env.FAKE_RELAY_EVENTS === '1' && mode !== 'live') {
      const sid = id || 'none';
      const lines = [
        { type: 'system', subtype: 'init', session_id: sid },
        { type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: 'Looking at the file.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.txt' } }] } },
        { type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file text' }] } },
        { type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'x' } }] } },
        { type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'a.txt:1' }] } },
        { type: 'result', subtype: 'success', is_error: false, session_id: sid, result: message, usage, total_cost_usd: 0.01 },
      ];
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(p('events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    }
    write('completed', 0, extra);
    process.stdout.write(`relay: completed (exit 0)  ·  ${implementer}\n`);
    process.exit(0);
  };
  if (mode === 'live') {
    const stepMs = Number(process.env.FAKE_RELAY_STEP_MS) || 50;
    const lines = implementer === 'agy' ? [] : implementer === 'claude' ? [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the file.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.txt' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file text' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'x' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'a.txt:1' }] } },
      { type: 'result', result: message, usage },
    ].map((v) => JSON.stringify(v)) : fs.readFileSync(process.env.FAKE_RELAY_EVENTS_FILE || fileURLToPath(new URL(`../fixtures/lane-events/${implementer}.jsonl`, import.meta.url)), 'utf8').trimEnd().split('\n');
    fs.mkdirSync(outDir, { recursive: true });
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    (async () => {
      for (let i = 0; i < lines.length; i++) {
        await pause(stepMs);
        // Final unterminated line also exercises the runner's finish drain.
        const bytes = Buffer.from(lines[i] + (i < lines.length - 1 ? '\n' : ''));
        if (implementer === 'opencode') {
          const unicode = bytes.indexOf(Buffer.from('é'));
          const split = unicode >= 0 ? unicode + 1 : Math.floor(bytes.length / 2);
          fs.appendFileSync(p('events.jsonl'), bytes.subarray(0, split));
          await pause(stepMs);
          fs.appendFileSync(p('events.jsonl'), bytes.subarray(split));
        } else fs.appendFileSync(p('events.jsonl'), bytes);
      }
      await pause(stepMs);
      done();
    })().catch((e) => { process.stderr.write(String(e)); process.exit(1); });
  } else if (mode === 'slow') {
    process.on('SIGTERM', () => { write('aborted', 143, { signal: 'SIGTERM', stderrTail: [], error: `the relay was killed by SIGTERM; ${implementer} was terminated with it — inspect the working tree before re-dispatching` }); process.exit(143); });
    setTimeout(done, Number(process.env.FAKE_RELAY_DELAY_MS) || 60000);
  } else done();
}
