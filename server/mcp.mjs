// Hand-written MCP server over stdio (newline-delimited JSON-RPC 2.0).
// stdout carries JSON-RPC only; every log line goes to stderr.
import * as core from './core.mjs';

const SERVER_INFO = { name: 'thread', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

function log(...a) {
  try { process.stderr.write('[thread/mcp] ' + a.map((x) => (x instanceof Error ? x.stack || x.message : String(x))).join(' ') + '\n'); } catch { /* ignore */ }
}

process.on('uncaughtException', (e) => log('uncaughtException:', e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e));

// ---------- output ----------

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    log('write failed:', e);
  }
}
process.stdout.on('error', (e) => { log('stdout error:', e); shutdown(); });

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// ---------- tool definitions ----------

const STATUSES = Array.isArray(core.STATUSES) ? core.STATUSES : ['idea', 'new', 'in_progress', 'review', 'blocked', 'done'];

const ID_PROP = { type: 'string', description: 'Card id, for example "c4".' };

const TOOLS = [
  {
    name: 'thread_start',
    description:
      'Start a side thread: a full copy of this conversation, with the same tools, that works on a task in the background while you carry on. ' +
      'It runs detached and never writes into this session. Its results come back only through thread_report, so do not wait for it; ' +
      'call thread_report later when the user asks or when the result is needed. ' +
      'Pass the session id from the "[thread plugin]" SessionStart note as session_id. ' +
      'The default mode is "read" (the thread may read, search and analyse but not edit files). ' +
      'Use mode "write" only when the user asks for the thread to change files.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the thread card on the board.' },
        task: { type: 'string', description: 'What the thread should do. Be specific; the thread has this conversation as context but starts with only this instruction.' },
        session_id: { type: 'string', description: 'This session\'s id (a UUID), taken from the "[thread plugin]" note added at session start. Falls back to the CLAUDE_CODE_SESSION_ID environment variable if omitted.' },
        mode: { type: 'string', enum: ['read', 'write'], description: '"read" (default) forbids file edits. "write" lets the thread edit files; use it only when the user asks for that.' },
      },
      required: ['title', 'task'],
    },
  },
  {
    name: 'thread_continue',
    description: 'Send a follow-up message to a finished (idle or failed-after-first-turn) thread so it runs another turn in the background. Fails if the thread is still running, has ended, or has not completed a first turn. Fetch the result with thread_report.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP, message: { type: 'string', description: 'The follow-up instruction for the thread.' } },
      required: ['id', 'message'],
    },
  },
  {
    name: 'thread_status',
    description: 'Show the state of threads: id, title, run state (running, idle, failed, ended), mode, number of turns, and whether the result has been reported. Omit id to list all threads.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Card id of one thread. Omit to list every thread.' } },
      required: [],
    },
  },
  {
    name: 'thread_report',
    description: 'Fetch the hand-back digest (Happened, Decided, Changed, Open) from a thread\'s newest successful turn. If a turn is still running, the previous digest is returned with a note. Marks the result as reported.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP },
      required: ['id'],
    },
  },
  {
    name: 'thread_end',
    description: 'End a thread. If it is running its process is stopped. The card moves to done and the thread cannot be continued.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP },
      required: ['id'],
    },
  },
  {
    name: 'board_add',
    description: 'Add a card (task or idea) to the project board that the user sees on a local web page.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Card title.' },
        note: { type: 'string', description: 'Optional longer note.' },
        status: { type: 'string', enum: STATUSES, description: 'Column. Defaults to "new".' },
        kind: { type: 'string', enum: ['task', 'idea'], description: 'Defaults to "task".' },
      },
      required: ['title'],
    },
  },
  {
    name: 'board_update',
    description: 'Change a board card\'s title, note or status. Thread cards follow their thread and should not be moved by hand.',
    inputSchema: {
      type: 'object',
      properties: {
        id: ID_PROP,
        title: { type: 'string', description: 'New title.' },
        note: { type: 'string', description: 'New note (replaces the old one).' },
        status: { type: 'string', enum: STATUSES, description: 'New column.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'board_remove',
    description: 'Delete a board card. A thread that is still running cannot be removed; end it first.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP },
      required: ['id'],
    },
  },
  {
    name: 'board_list',
    description: 'List every board card grouped by status. Cards the user added or edited since the last listing are flagged "(new from user)". Listing marks them as seen.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'board_open',
    description: 'Return the URL of the local board web page for this project.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------- argument helpers ----------

class ToolError extends Error {}

function reqStr(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`argument "${key}" is required and must be a non-empty string`);
  return v;
}

function optStr(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`argument "${key}" must be a string`);
  return v;
}

function optEnum(args, key, allowed) {
  const v = optStr(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v)) throw new ToolError(`argument "${key}" must be one of: ${allowed.join(', ')}`);
  return v;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const oneLine = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function threadLine(c) {
  const t = c.thread || {};
  return `${c.id} "${oneLine(c.title, 80)}" — ${t.runState || '?'}, mode ${t.mode || '?'}, ${(t.turns || []).length} turn(s), reported: ${t.reported ? 'yes' : 'no'}`;
}

// ---------- board server ----------

let board = null; // { server, port, url } | null
let boardPromise = Promise.resolve(null);

function startBoard(projectDir) {
  if (process.env.THREAD_NO_HTTP === '1') return;
  boardPromise = import('./http.mjs')
    .then((m) => m.startBoardServer(projectDir))
    .then((b) => { board = b; log('board at', b.url); return b; })
    .catch((e) => { log('board server failed to start:', e); return null; });
}

// ---------- tool handlers ----------

const HANDLERS = {
  async thread_start(args) {
    const sessionId = optStr(args, 'session_id') || process.env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) throw new ToolError('no session id: pass session_id (see the "[thread plugin]" note at session start)');
    const mode = optEnum(args, 'mode', ['read', 'write']) || 'read';
    const card = await core.startThread(core.projectDir(), {
      title: reqStr(args, 'title'),
      task: reqStr(args, 'task'),
      sessionId,
      mode,
    });
    return `Thread ${card.id} "${oneLine(card.title, 80)}" started in the background (mode ${mode}). Results come back only through thread_report; call it with id ${card.id} when the user asks or the result is needed.`;
  },

  async thread_continue(args) {
    const card = await core.continueThread(core.projectDir(), reqStr(args, 'id'), reqStr(args, 'message'));
    return `Thread ${card.id} "${oneLine(card.title, 80)}" is running another turn. Use thread_report to fetch the result.`;
  },

  async thread_status(args) {
    const id = optStr(args, 'id');
    const state = await core.reconcile(core.projectDir());
    const threads = (state.cards || []).filter((c) => c.kind === 'thread');
    if (id) {
      const c = threads.find((x) => x.id === id);
      if (!c) throw new ToolError(`thread ${id} not found`);
      const t = c.thread;
      const last = (t.turns || [])[(t.turns || []).length - 1];
      let out = threadLine(c);
      if (t.runState === 'failed' && last && last.error) out += `\nLast error: ${oneLine(last.error, 300)}`;
      return out;
    }
    if (!threads.length) return 'No threads.';
    return threads.map((c) => {
      const turns = c.thread.turns || [];
      const last = turns[turns.length - 1];
      const failed = c.thread.runState === 'failed' && last && last.error;
      return failed ? `${threadLine(c)} — error: ${oneLine(last.error, 200)}` : threadLine(c);
    }).join('\n');
  },

  async thread_report(args) {
    const id = reqStr(args, 'id');
    const pd = core.projectDir();
    await core.reconcile(pd);
    const { card, text } = await core.reportThread(pd, id);
    return `Thread ${card.id} "${oneLine(card.title, 80)}" (${card.thread.runState}):\n\n${text}`;
  },

  async thread_end(args) {
    const card = await core.endThread(core.projectDir(), reqStr(args, 'id'));
    const note = card.thread.lastResult == null
      ? 'It produced no result.'
      : card.thread.reported ? 'Its last result was reported.' : 'Its last result was never reported; thread_report still works on an ended thread.';
    return `Thread ${card.id} "${oneLine(card.title, 80)}" ended. ${note}`;
  },

  async board_add(args) {
    const card = await core.addCard(core.projectDir(), clean({
      title: reqStr(args, 'title'),
      note: optStr(args, 'note'),
      status: optEnum(args, 'status', STATUSES),
      kind: optEnum(args, 'kind', ['task', 'idea']),
      source: 'claude',
    }));
    return `Added ${card.id} [${card.kind}] "${oneLine(card.title, 80)}" in ${card.status}.`;
  },

  async board_update(args) {
    const card = await core.updateCard(core.projectDir(), reqStr(args, 'id'), clean({
      title: optStr(args, 'title'),
      note: optStr(args, 'note'),
      status: optEnum(args, 'status', STATUSES),
    }), { source: 'claude' });
    return `Updated ${card.id} "${oneLine(card.title, 80)}" (${card.status}).`;
  },

  async board_remove(args) {
    const id = reqStr(args, 'id');
    await core.removeCard(core.projectDir(), id);
    return `Removed ${id}.`;
  },

  async board_list() {
    const pd = core.projectDir();
    await core.reconcile(pd);
    const unseen = new Set(((await core.markSeen(pd)) || []).map((c) => c.id));
    const cards = core.readState(pd).cards || [];
    if (!cards.length) return 'The board is empty.';
    const lines = [];
    const known = new Set(STATUSES);
    const groups = [...STATUSES, ...[...new Set(cards.map((c) => c.status))].filter((s) => !known.has(s))];
    for (const s of groups) {
      const inCol = cards.filter((c) => c.status === s);
      if (!inCol.length) continue;
      lines.push(`${s} (${inCol.length})`);
      for (const c of inCol) {
        const kind = c.kind === 'thread' ? `thread:${c.thread?.runState ?? '?'}` : c.kind;
        const flag = unseen.has(c.id) ? ' (new from user)' : '';
        const note = c.note ? ` — ${oneLine(c.note, 200)}` : '';
        lines.push(`- ${c.id} [${kind}] ${oneLine(c.title, 120)}${flag}${note}`);
      }
    }
    if (unseen.size) lines.push('', `${unseen.size} card(s) new from the user.`);
    return lines.join('\n');
  },

  async board_open() {
    if (process.env.THREAD_NO_HTTP === '1') return 'The board server is disabled (THREAD_NO_HTTP=1).';
    await boardPromise;
    if (!board) return 'The board is unavailable: the HTTP server failed to start (see the plugin log on stderr).';
    return `Board: ${board.url}`;
  },
};

async function callTool(params) {
  const name = params && params.name;
  const handler = typeof name === 'string' && Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) return { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true };
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    return { content: [{ type: 'text', text: 'arguments must be an object' }], isError: true };
  }
  try {
    const text = await handler(rawArgs || {});
    return { content: [{ type: 'text', text: String(text) }] };
  } catch (e) {
    if (!(e instanceof ToolError)) log(`tool ${name} failed:`, e);
    const msg = e && e.message ? String(e.message).split('\n')[0] : 'tool failed';
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

// ---------- dispatch ----------

async function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    log('ignoring non-object message');
    return;
  }
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
  const isRequest = typeof msg.method === 'string';
  if (!isRequest) {
    if (hasId && !('result' in msg) && !('error' in msg)) replyError(msg.id, -32600, 'Invalid Request');
    return; // a response from the client, or junk: nothing to do
  }
  if (!hasId) return; // notification: never reply

  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  try {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        break;
      case 'ping':
        reply(id, {});
        break;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        break;
      case 'tools/call':
        reply(id, await callTool(params));
        break;
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log(`error handling ${method}:`, e);
    replyError(id, -32603, 'Internal error');
  }
}

// ---------- stdin loop ----------

let queue = Promise.resolve();
let buffer = '';
let closing = false;

function processLine(line) {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log('malformed input line ignored:', oneLine(text, 80));
    return;
  }
  const items = Array.isArray(msg) ? msg : [msg];
  for (const item of items) {
    queue = queue.then(() => handleMessage(item)).catch((e) => log('handler crashed:', e));
  }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  try { await queue; } catch { /* ignore */ }
  try {
    if (board && board.server) {
      await Promise.race([
        new Promise((resolve) => {
          board.server.close(() => resolve());
          if (typeof board.server.closeAllConnections === 'function') board.server.closeAllConnections();
        }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  } catch (e) { log('close failed:', e); }
  try {
    await new Promise((resolve) => { try { process.stdout.write('', () => resolve()); } catch { resolve(); } });
  } catch { /* ignore */ }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    processLine(line);
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) { processLine(buffer); buffer = ''; }
  shutdown();
});
process.stdin.on('error', (e) => { log('stdin error:', e); shutdown(); });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

try {
  // Inside a side thread the main session already serves the board.
  if (!process.env.THREAD_DEPTH) startBoard(core.projectDir());
} catch (e) {
  log('startup failed:', e);
}
