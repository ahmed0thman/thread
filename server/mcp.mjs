// Hand-written MCP server over stdio (newline-delimited JSON-RPC 2.0).
// stdout carries JSON-RPC only; every log line goes to stderr.
import * as core from './core.mjs';

const SERVER_INFO = { name: 'thread', version: core.VERSION };
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

const { STATUSES, MODES, KINDS, CONTEXTS } = core;

const ID_PROP = { type: 'string', description: 'Card id, for example "c4".' };
const SESSION_PROP = { type: 'string', description: 'This session\'s id (a UUID), taken from the "[thread plugin]" note added at session start. Falls back to the CLAUDE_CODE_SESSION_ID environment variable if omitted.' };
const CONFIRM_PROP = { type: 'string', description: 'The confirm code from a "CONFIRMATION REQUIRED" answer. Pass it only after the user agreed to continue.' };

const TOOLS = [
  {
    name: 'thread_start',
    description:
      'Start a side thread: a separate Claude session that works on a task in the background while you carry on. ' +
      'By default it is a fresh session that knows only the brief and the task you write (plus the project\'s CLAUDE.md, which it loads itself), so it costs little. ' +
      'With context "full" it is instead a copy of this whole conversation, which re-sends everything said so far on every turn and costs far more. ' +
      'It runs detached and never writes into this session. Its results come back only through thread_report, so do not wait for it; ' +
      'call thread_report later when the user asks or when the result is needed. ' +
      'Pass the session id from the "[thread plugin]" SessionStart note as session_id. ' +
      'The default mode is "read" (the thread may read, search and analyse but not edit files). ' +
      'Use mode "write" only when the user asks for the thread to change files. ' +
      'The thread runs headless and cannot answer permission prompts: it can read inside the project and use web search and fetch, ' +
      'but any other folder it must read has to be listed in extra_dirs.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the thread card on the board.' },
        task: { type: 'string', description: 'What the thread should do, written so that it stands alone. Be specific.' },
        context: { type: 'string', enum: CONTEXTS, description: '"brief" (default): a fresh session that knows only brief and task. "full": a copy of this whole conversation; use it only when the task depends on much of what was said, because it costs far more tokens.' },
        brief: { type: 'string', description: 'What the thread needs to know from this conversation; it has not seen it. A good brief gives the goal, the decisions and constraints that apply, exact file paths, what was already tried or ruled out, and the meaning of any project term the task uses. Leave out anything the task does not need and anything in CLAUDE.md. As long as the task needs and no longer. Ignored with context "full".' },
        agent: { type: 'string', description: 'Optional name of a sub-agent from .claude/agents (project or user) to run the thread as; it brings its own model, effort and instructions. Without it the thread uses the same model and effort as this session.' },
        session_id: SESSION_PROP,
        mode: { type: 'string', enum: MODES, description: '"read" (default) forbids file edits. "write" lets the thread edit files; use it only when the user asks for that.' },
        extra_dirs: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Absolute paths of folders outside the project that the task needs to read, for example another repository the user named. Only list folders the task actually requires.' },
      },
      required: ['title', 'task'],
    },
  },
  {
    name: 'thread_continue',
    description: 'Send a follow-up message to a finished (idle or failed-after-first-turn) thread so it runs another turn in the background. Fails if the thread is still running, has ended, or has not completed a first turn. Fetch the result with thread_report. The thread\'s "finished" notice goes to the session that started it.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP, message: { type: 'string', description: 'The follow-up instruction for the thread.' }, session_id: SESSION_PROP },
      required: ['id', 'message'],
    },
  },
  {
    name: 'thread_status',
    description: 'Show the state of threads: id, title, run state (running, idle, failed, ended), mode, context (brief or full), agent or model, number of turns, tokens used, whether the result has been reported, and which session started each. Omit id to list all threads.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Card id of one thread. Omit to list every thread.' }, session_id: SESSION_PROP },
      required: [],
    },
  },
  {
    name: 'thread_report',
    description: 'Fetch the hand-back digest (Happened, Decided, Changed, Open) from a thread\'s newest successful turn. If a turn is still running, the previous digest is returned with a note. Marks the result as reported. ' +
      'Always pass session_id. Omit id to pick this session\'s only finished, unreported thread; threads of other sessions are never picked. ' +
      'A thread started by a different session is not reported until the user confirms: the tool then answers "CONFIRMATION REQUIRED" with a confirm_code.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Card id, for example "c4". Optional: omit to let the tool pick this session\'s thread.' }, session_id: SESSION_PROP, confirm_code: CONFIRM_PROP },
      required: [],
    },
  },
  {
    name: 'thread_end',
    description: 'End a thread. If it is running its process is stopped. The card moves to done and the thread cannot be continued. ' +
      'Always pass session_id. A thread started by a different session is not ended until the user confirms: the tool then answers "CONFIRMATION REQUIRED" with a confirm_code.',
    inputSchema: {
      type: 'object',
      properties: { id: ID_PROP, session_id: SESSION_PROP, confirm_code: CONFIRM_PROP },
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
        kind: { type: 'string', enum: KINDS, description: 'Defaults to "task".' },
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

// The calling session: the session_id argument, else the environment, else unknown.
function callerId(args) {
  const arg = optStr(args, 'session_id');
  if (arg && core.UUID_RE.test(arg.trim())) return arg.trim().toLowerCase();
  const env = process.env.CLAUDE_CODE_SESSION_ID;
  if (typeof env === 'string' && core.UUID_RE.test(env.trim())) return env.trim().toLowerCase();
  return undefined;
}

function needCaller(args) {
  const id = callerId(args);
  if (!id) throw new ToolError('no session id: pass session_id from the "[thread plugin]" note at session start');
  return id;
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function startedBy(state, c, caller) {
  const parent = c.thread.parentSessionId;
  if (caller && core.sameSession(caller, parent)) return 'this session';
  return core.sessionLabel(state, parent);
}

// Who a thread runs as: its agent, else the model and effort it was given, else the CLI default.
function runsAs(t) {
  if (t.agent) return `agent ${t.agent}`;
  return [t.model && `model ${t.model}`, t.effort && `effort ${t.effort}`].filter(Boolean).join(', ') || 'default model';
}

const tokens = (n) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);

// Tokens over all turns that recorded usage, input side (fresh, cache read, cache write) and output; '' when none did.
function usageText(t) {
  const used = t.turns.map((x) => x.usage).filter(Boolean);
  if (!used.length) return '';
  const sum = (f) => used.reduce((a, u) => a + f(u), 0);
  return `, tokens ${tokens(sum((u) => u.input + u.cacheRead + u.cacheWrite))} in / ${tokens(sum((u) => u.output))} out`;
}

function threadLine(c, state, caller) {
  const t = c.thread;
  return `${c.id} "${core.clip(c.title, 80)}" — ${t.runState}, mode ${t.mode}, ${core.threadContext(t)} context, ${runsAs(t)}, ${t.turns.length} turn(s)${usageText(t)}, reported: ${t.reported ? 'yes' : 'no'}, started by: ${startedBy(state, c, caller)}, session ${t.sessionId || 'not known yet'}${t.reportRequestedAt ? ', report requested' : ''}`;
}

// The answer to a report or end that came from a session other than the one
// that started the thread. It carries no digest text.
function confirmText(r, state, caller) {
  const { card, code } = r;
  const verb = r.action === 'end' ? 'ended' : 'reported';
  const cmd = r.action === 'end' ? 'end' : 'report';
  const id = card.id;
  const title = core.clip(card.title, 80);
  const parent = card.thread.parentSessionId;
  const parentLabel = core.sessionLabel(state, parent);
  const seen = core.sessionsOf(state)[String(parent).toLowerCase()]?.lastSeenAt;
  const when = seen && ago(seen) ? `, last active ${ago(seen)}` : '';
  const callerLabel = core.sessionLabel(state, caller);
  const isEnd = r.action === 'end';
  const here = isEnd ? 'End it here' : 'Report here';
  const effect = isEnd
    ? 'End the thread now. The session that started it will find it ended.'
    : 'Put this thread\'s digest into this session\'s context. The session that started it will not receive it.';
  const alertLine = isEnd
    ? 'Ending it here stops the thread for the session that started it.'
    : 'Reporting here puts this thread\'s digest into **this** session\'s context. The session that started it will not receive it.';
  return [
    `CONFIRMATION REQUIRED. Nothing was ${verb}.`,
    '',
    `Thread ${id} "${title}" was started by a different session.`,
    `Started by: ${parentLabel}${when}`,
    `You are in: ${callerLabel}`,
    '',
    'Ask the user with the AskUserQuestion tool. Do not answer for them, do not skip the question, and do not show or summarise any part of the thread\'s digest before they answer.',
    `  question: "Thread ${id} was started by another session (${parentLabel}). ${isEnd ? 'End it from this session' : 'Report its digest into this session'} anyway?"`,
    '  header: "Wrong session"',
    '  options, in this order:',
    `    1. label "Cancel (Recommended)" - description "Leave this session unchanged. Run /thread:${cmd} ${id} in the session that started it."`,
    `    2. label "${here}" - description "${effect}"`,
    '',
    'If the AskUserQuestion tool is not available, show the user the alert below exactly as written and stop until they reply.',
    '',
    '## Not the session that started this thread',
    '',
    `> **Thread ${id}** "${title}"`,
    `> **Started by:** ${parentLabel}`,
    `> **You are in:** ${callerLabel}`,
    '>',
    `> ${alertLine}`,
    '',
    `**${isEnd ? 'End it here anyway?' : 'Report here anyway?'}** Reply "yes" to continue, or "no" to cancel.`,
    '',
    `Only if the user chooses to continue, call thread_${cmd} again with id "${id}", the same session_id, and confirm_code "${code}".`,
  ].join('\n');
}

// ---------- board server ----------

let board = null; // { url, owned, server } | null
let boardPromise = Promise.resolve(null);
let boardMod = null; // ./http.mjs, loaded lazily so a failure there cannot stop the MCP server
let boardWatch = null;
const BOARD_WATCH_MS = 5000;

function startBoard(projectDir) {
  if (process.env.THREAD_NO_HTTP === '1') return;
  boardPromise = import('./http.mjs')
    .then((m) => { boardMod = m; return m.ensureBoard(projectDir); })
    .then((b) => { board = b; log('board at', b.url, b.owned ? '(owned)' : '(shared)'); watchBoard(projectDir); return b; })
    .catch((e) => { log('board server failed to start:', e); return null; });
}

// While another session owns the port, take it over once that server stops answering.
function watchBoard(projectDir) {
  if (boardWatch || !board || board.owned || closing) return;
  let busy = false;
  boardWatch = setInterval(async () => {
    if (busy || closing) return;
    busy = true;
    try {
      if (await boardMod.pingBoard(board.url)) return;
      const b = await boardMod.ensureBoard(projectDir);
      if (closing) { if (b.server) b.server.close(); return; }
      board = b;
      log('board at', b.url, b.owned ? '(owned)' : '(shared)');
      if (b.owned) { clearInterval(boardWatch); boardWatch = null; }
    } catch (e) {
      log('board re-check failed:', e);
    } finally {
      busy = false;
    }
  }, BOARD_WATCH_MS);
  if (typeof boardWatch.unref === 'function') boardWatch.unref();
}

// ---------- tool handlers ----------

const HANDLERS = {
  async thread_start(args) {
    const sessionId = needCaller(args);
    const mode = optEnum(args, 'mode', MODES) || 'read';
    const card = await core.startThread(core.projectDir(), {
      title: reqStr(args, 'title'),
      task: reqStr(args, 'task'),
      sessionId,
      mode,
      extraDirs: args.extra_dirs,
      context: optEnum(args, 'context', CONTEXTS),
      brief: optStr(args, 'brief'),
      agent: optStr(args, 'agent'),
    });
    const t = card.thread;
    const extra = t.dirs.length ? `, extra folders: ${t.dirs.join(', ')}` : '';
    return `Thread ${card.id} "${core.clip(card.title, 80)}" started in the background (mode ${mode}, ${t.context} context, ${runsAs(t)}${extra}). Results come back only through thread_report; call it with id ${card.id} when the user asks or the result is needed.`;
  },

  async thread_continue(args) {
    const pd = core.projectDir();
    const caller = callerId(args);
    const card = await core.continueThread(pd, reqStr(args, 'id'), reqStr(args, 'message'), { sessionId: caller });
    let out = `Thread ${card.id} "${core.clip(card.title, 80)}" is running another turn. Use thread_report to fetch the result.`;
    if (caller && !core.sameSession(caller, card.thread.parentSessionId)) {
      const label = core.sessionLabel(core.readState(pd), card.thread.parentSessionId);
      out += ` This thread belongs to ${label}; its "finished" notice will go to that session.`;
    }
    return out;
  },

  async thread_status(args) {
    const id = optStr(args, 'id');
    const caller = callerId(args);
    const pd = core.projectDir();
    const state = await core.reconcile(pd);
    if (id) {
      const c = core.findThread(state, id);
      const t = c.thread;
      const last = t.turns[t.turns.length - 1];
      let out = threadLine(c, state, caller);
      if (t.runState === 'failed' && last && last.error) out += `\nLast error: ${core.clip(last.error, 300)}`;
      return out;
    }
    const threads = state.cards.filter((c) => c.kind === 'thread');
    if (!threads.length) return 'No threads.';
    return threads.map((c) => {
      const last = c.thread.turns[c.thread.turns.length - 1];
      const failed = c.thread.runState === 'failed' && last && last.error;
      return failed ? `${threadLine(c, state, caller)} — error: ${core.clip(last.error, 200)}` : threadLine(c, state, caller);
    }).join('\n');
  },

  async thread_report(args) {
    const caller = needCaller(args);
    const pd = core.projectDir();
    let id = optStr(args, 'id');
    if (id !== undefined && !id.trim()) id = undefined;
    await core.reconcile(pd);
    if (id === undefined) {
      const { mine, others } = await core.pickReportable(pd, caller);
      if (mine.length !== 1) {
        const state = core.readState(pd);
        const lines = [mine.length
          ? 'Nothing was reported. More than one finished thread from this session is waiting; ask the user which one:'
          : 'Nothing was reported. No finished, unreported thread from this session.'];
        for (const c of mine) lines.push(`- ${c.id} "${core.clip(c.title, 80)}"`);
        if (others.length) {
          lines.push('', 'Finished threads from other sessions (a thread from another session must be requested by id, and the user is asked to confirm):');
          for (const c of others) lines.push(`- ${c.id} "${core.clip(c.title, 80)}" (started by ${core.sessionLabel(state, c.thread.parentSessionId)})`);
        }
        return lines.join('\n');
      }
      id = mine[0].id;
    }
    const r = await core.reportThread(pd, id, { sessionId: caller, confirmCode: optStr(args, 'confirm_code') });
    if (r.needsConfirm) return confirmText(r, core.readState(pd), caller);
    const body = `Thread ${r.card.id} "${core.clip(r.card.title, 80)}" (${r.card.thread.runState}):\n\n${r.text}`;
    if (r.otherSession) {
      const label = core.sessionLabel(core.readState(pd), r.card.thread.parentSessionId);
      return `Reported into a different session than the one that started this thread (${label}).\n${body}`;
    }
    return body;
  },

  async thread_end(args) {
    const caller = needCaller(args);
    const pd = core.projectDir();
    const r = await core.endThread(pd, reqStr(args, 'id'), { sessionId: caller, confirmCode: optStr(args, 'confirm_code') });
    if (r.needsConfirm) return confirmText(r, core.readState(pd), caller);
    const { card } = r;
    const note = card.thread.lastResult == null
      ? 'It produced no result.'
      : card.thread.reported ? 'Its last result was reported.' : 'Its last result was never reported; thread_report still works on an ended thread.';
    return `Thread ${card.id} "${core.clip(card.title, 80)}" ended. ${note}`;
  },

  async board_add(args) {
    const card = await core.addCard(core.projectDir(), clean({
      title: reqStr(args, 'title'),
      note: optStr(args, 'note'),
      status: optEnum(args, 'status', STATUSES),
      kind: optEnum(args, 'kind', KINDS),
      source: 'claude',
    }));
    return `Added ${card.id} [${card.kind}] "${core.clip(card.title, 80)}" in ${card.status}.`;
  },

  async board_update(args) {
    const card = await core.updateCard(core.projectDir(), reqStr(args, 'id'), clean({
      title: optStr(args, 'title'),
      note: optStr(args, 'note'),
      status: optEnum(args, 'status', STATUSES),
    }), { source: 'claude' });
    return `Updated ${card.id} "${core.clip(card.title, 80)}" (${card.status}).`;
  },

  async board_remove(args) {
    const id = reqStr(args, 'id');
    await core.removeCard(core.projectDir(), id);
    return `Removed ${id}.`;
  },

  async board_list() {
    const pd = core.projectDir();
    await core.reconcile(pd);
    const unseen = new Set((await core.markSeen(pd)).map((c) => c.id));
    const cards = core.readState(pd).cards;
    if (!cards.length) return 'The board is empty.';
    const lines = [];
    const known = new Set(STATUSES);
    const groups = [...STATUSES, ...[...new Set(cards.map((c) => c.status))].filter((s) => !known.has(s))];
    for (const s of groups) {
      const inCol = cards.filter((c) => c.status === s);
      if (!inCol.length) continue;
      lines.push(`${s} (${inCol.length})`);
      for (const c of inCol) {
        const kind = c.kind === 'thread' ? `thread:${c.thread.runState}` : c.kind;
        const flag = unseen.has(c.id) ? ' (new from user)' : '';
        const note = c.note ? ` — ${core.clip(c.note, 200)}` : '';
        lines.push(`- ${c.id} [${kind}] ${core.clip(c.title, 120)}${flag}${note}`);
      }
    }
    if (unseen.size) lines.push('', `${unseen.size} card(s) new from the user.`);
    return lines.join('\n');
  },

  async board_open() {
    if (process.env.THREAD_NO_HTTP === '1') return 'The board server is disabled (THREAD_NO_HTTP=1).';
    await boardPromise;
    if (!board) return 'The board is unavailable: the HTTP server failed to start (see the plugin log on stderr).';
    let link;
    try {
      link = `${board.url}?t=${boardMod.boardToken()}#/${core.projectKey(core.projectDir())}`;
    } catch (e) {
      log('board token failed:', e);
      return 'The board is unavailable: its access token could not be read (see the plugin log on stderr).';
    }
    return `Board: ${link}\nThis link opens this project's tab; the same board shows every project.`;
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
    log('malformed input line ignored:', core.clip(text, 80));
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
  if (boardWatch) { clearInterval(boardWatch); boardWatch = null; }
  try { await queue; } catch { /* ignore */ }
  try {
    if (board && board.owned && board.server) {
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
