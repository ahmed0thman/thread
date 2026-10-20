// Shared test helpers. node:* only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TEST_DIR, '..');
export const FAKE_CLAUDE = path.join(TEST_DIR, 'fake-claude.mjs');
export const FAKE_DELEGATE = path.join(TEST_DIR, 'fake-delegate');
export const SERVER_DIR = path.join(ROOT, 'server');
export const CORE_PATH = path.join(SERVER_DIR, 'core.mjs');
export const MCP_PATH = path.join(SERVER_DIR, 'mcp.mjs');
export const HOOK_PATH = path.join(ROOT, 'scripts', 'hook.mjs');

export const PARENT_SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const THREAD_SESSION = '11111111-2222-4333-8444-555555555555';

/** A thread reply with the four headings and a step map that has one unusable and one unknown-kind step. */
export const REPLY_WITH_MAP = [
  'Intro line.',
  '## Happened', '- read the plan', '## Decided', '- use Postgres', '## Changed', 'Nothing.', '## Open', '- one question',
  '```thread-map',
  '[{"kind":"did","text":"read the plan","ref":"PLAN.md:12"},{"kind":"bogus","text":"kind falls back"},{"text":""},{"kind":"decided","text":"use Postgres"}]',
  '```',
].join('\n');

/** Remove environment that would change behaviour when the suite runs inside a Claude session. */
export function cleanAmbientEnv() {
  for (const k of ['THREAD_DEPTH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'THREAD_PROJECT_DIR', 'THREAD_NO_HTTP', 'THREAD_TIMEOUT_MS', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_DELAY_MS', 'THREAD_DELEGATE_DIR', 'FAKE_DELEGATE_MODE', 'FAKE_DELEGATE_LOG', 'FAKE_DELEGATE_SANDBOX', 'FAKE_RELAY_MODE', 'FAKE_RELAY_LOG', 'FAKE_RELAY_VIOLATION', 'FAKE_RELAY_TOUCHED', 'FAKE_RELAY_STDERR_TAIL', 'FAKE_RELAY_EVENTS', 'FAKE_RELAY_EVENTS_FILE']) {
    delete process.env[k];
  }
}

/** Fresh temp data dir and project dir. */
export function tmpEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-test-'));
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(projectDir);
  return { base, dataDir, projectDir, logFile: path.join(base, 'fake.log'), pidFile: path.join(base, 'fake.pids') };
}

export async function waitFor(fn, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms: ${fn.toString().slice(0, 200)}${lastErr ? ' (last error: ' + lastErr.message + ')' : ''}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killQuiet(pid, sig = 'SIGKILL') {
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

/** Kill runner pids recorded in any state file under dataDir and fake CLI pids from the pid file. */
function killLeftovers(env) {
  const projects = path.join(env.dataDir, 'projects');
  try {
    for (const d of fs.readdirSync(projects)) {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(projects, d, 'state.json'), 'utf8'));
        for (const c of st.cards || []) {
          const pid = c.thread && c.thread.pid;
          if (pid && pid !== process.pid) killQuiet(pid);
        }
      } catch { /* unreadable state is fine in cleanup */ }
    }
  } catch { /* no projects dir */ }
  try {
    for (const line of fs.readFileSync(env.pidFile, 'utf8').split('\n')) {
      const pid = parseInt(line, 10);
      if (pid && pid !== process.pid) killQuiet(pid);
    }
  } catch { /* no pid file */ }
}

/**
 * Create temp dirs and set THREAD_DATA_DIR / THREAD_CLAUDE_BIN / FAKE_CLAUDE_LOG (+ pid file) in
 * process.env for the duration of the test `t`. Restores env, kills leftovers and removes the temp dirs afterwards.
 * `extra` is a map of additional env vars (undefined deletes).
 */
export function setupThreadEnv(t, extra = {}) {
  const env = tmpEnv();
  const wanted = {
    THREAD_DATA_DIR: env.dataDir,
    THREAD_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: env.logFile,
    FAKE_CLAUDE_PIDFILE: env.pidFile,
    ...extra,
  };
  const saved = {};
  for (const [k, v] of Object.entries(wanted)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const out = {
    ...env,
    readLog: () => readFakeLog(env.logFile),
    /** Set or delete further env vars, restored at the end of the test. */
    setEnv(k, v) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    },
  };
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    killLeftovers(env);
    await sleep(50);
    fs.rmSync(env.base, { recursive: true, force: true });
  });
  return out;
}

/** Parse the fake CLI's log: one object per invocation { argv, prompt, cwd, depth }. */
export function readFakeLog(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** State file path derived from the contract formula, independent of core.mjs. */
export function statePathFor(dataDir, projectDir) {
  const h = crypto.createHash('sha1').update(projectDir).digest('hex').slice(0, 12);
  return path.join(dataDir, 'projects', h, 'state.json');
}

export function writeStateFile(dataDir, projectDir, state) {
  const p = statePathFor(dataDir, projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

/** A contract-shaped thread card for hand-written states. */
export function threadCard(over = {}, threadOver = {}) {
  const now = new Date().toISOString();
  return {
    id: 'c1',
    kind: 'thread',
    title: 'Side job',
    note: '',
    status: 'review',
    source: 'claude',
    seenByClaude: true,
    createdAt: now,
    updatedAt: now,
    thread: {
      parentSessionId: PARENT_SESSION,
      sessionId: THREAD_SESSION,
      mode: 'read',
      runState: 'idle',
      pid: null,
      turns: [{ prompt: 'p', startedAt: now, finishedAt: now, ok: true, result: 'done\n## Happened\nx', error: null }],
      lastResult: 'done\n## Happened\nx',
      reported: false,
      announced: false,
      ...threadOver,
    },
    ...over,
  };
}

export function emptyState(projectDir, cards = []) {
  return { version: 1, projectDir, seq: cards.length, cards };
}

/** Run `node args...` and collect output. */
export function runNode(args, { env = process.env, input, cwd, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timed out: node ${args.join(' ')}`));
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** A JSON-RPC client over the stdio of a spawned MCP server. The board page is off unless extraEnv turns it on. */
export class McpClient {
  constructor(e, extraEnv = {}) {
    this.lines = [];
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(process.execPath, [MCP_PATH], {
      env: { ...process.env, THREAD_NO_HTTP: '1', THREAD_PROJECT_DIR: e.projectDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (d) => (this.stderr += d));
    this.exited = new Promise((r) => this.child.on('exit', (code, sig) => r({ code, sig })));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg && msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
  }
  raw(text) { this.child.stdin.write(text + '\n'); }
  send(obj) { this.raw(JSON.stringify(obj)); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no reply to ${method} (id ${id}); stderr: ${this.stderr.slice(-300)}`)); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  /** tools/call. The result keeps its `content` and gains `isError` (a boolean) and `text` (the first content block). */
  async call(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    assert.equal(r.error, undefined, `tools/call ${name} returned a JSON-RPC error: ${JSON.stringify(r.error)}`);
    return { ...r.result, isError: r.result.isError === true, text: r.result.content[0].text };
  }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    this.notify('notifications/initialized');
    return r;
  }
  kill() { this.child.kill('SIGKILL'); }
}

/** A small stand-in for a DOM element, enough to run the board page's own code in a vm. */
export class FakeEl {
  constructor(doc, tag) {
    Object.assign(this, { doc, tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, dataset: {}, style: {}, listeners: {}, className: '', _text: '', scrollTop: 0, clientHeight: 300, offsetTop: 0, offsetHeight: 30, offsetWidth: 210, rect: { left: 0, top: 0, right: 0, bottom: 0 } });
  }
  get childNodes() { return this.children; }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n === this.doc.body; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children.forEach((c) => { c.parent = null; }); this.children = []; }
  prepend(...cs) { const keep = this.children; this.children = []; this.append(...cs, ...keep); }
  scrollIntoView() { this.scrolledIntoView = (this.scrolledIntoView || 0) + 1; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => { if (typeof c === 'string') { const t = new FakeEl(this.doc, 'span'); t.textContent = c; this.appendChild(t); } else this.appendChild(c); }); }
  replaceChildren(...cs) { this.children.forEach((c) => { c.parent = null; }); this.children = []; this.append(...cs); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    (this.listeners[type] || []).forEach((fn) => fn(e));
    return e;
  }
  click() { return this.fire('click'); }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return this.rect; }
  closest(sel) { for (let x = this; x; x = x.parent) if (x.matches && x.matches(sel)) return x; return null; }
  // one compound selector: an optional tag, then .class and [attr], [attr="v"], [attr^="v"] parts
  matches(sel) {
    const tag = /^[a-z][a-z0-9]*/i.exec(sel);
    if (tag && tag[0].toUpperCase() !== this.tagName) return false;
    const parts = sel.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
    return parts.every((p) => {
      if (p[0] === '.') return this.className.split(' ').includes(p.slice(1));
      const [, name, op, val] = /^\[([\w-]+)(\^?=)?"?([^"\]]*)"?\]$/.exec(p);
      const have = name.startsWith('data-') ? this.dataset[name.slice(5)] : this.getAttribute(name);
      if (have === undefined || have === null) return false;
      return !op ? true : op === '=' ? have === val : have.startsWith(val);
    });
  }
  querySelectorAll(sel) {
    const steps = sel.split(/\s+/);
    let found = [this];
    for (const step of steps) {
      const next = [];
      for (const root of found) {
        const walk = (n) => n.children.forEach((c) => { if (c.matches(step)) next.push(c); walk(c); });
        walk(root);
      }
      found = next;
    }
    return found;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// The released versions the cross-version tests run: 0.9.1, 0.10.0 (tag v0.10.0, commit 3b61221), 0.11.0, 0.12.1, 0.13.0, 0.14.0, 0.15.2, 0.16.0, 0.20.0 and 0.21.0.
export const RELEASED_REFS = ['v0.9.1', '3b61221', 'v0.11.0', 'v0.12.1', 'v0.13.0', 'v0.14.0', 'v0.15.2', 'v0.16.0', 'v0.20.0', 'v0.21.0'];

/**
 * The server folder of an older plugin version, taken from a git ref (a tag, or a commit id) into a temp folder that is
 * removed after test `t`. Returns the folder to pass to test/fixtures/old-writer.mjs. A checkout with no git history at all skips the
 * test; any other failure, a missing ref included, throws, so the test fails where it can be seen instead of going quiet.
 */
export function oldServerFrom(t, ref) {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'buffer', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
  try { git('rev-list', '-n', '1', 'HEAD'); } catch {
    t.skip('this checkout has no git history, so there is no older version to run');
    return null;
  }
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-old-'));
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  try { git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`); } catch { throw new Error(`the git ref ${ref} is not in this checkout (a shallow clone, or a clone without tags?)`); }
  fs.mkdirSync(path.join(old, 'server'));
  fs.mkdirSync(path.join(old, '.claude-plugin'));
  const names = git('ls-tree', '--name-only', ref, 'server/').toString('utf8').split('\n').filter((n) => n.endsWith('.mjs'));
  for (const n of names) fs.writeFileSync(path.join(old, n), git('show', `${ref}:${n}`));
  fs.writeFileSync(path.join(old, '.claude-plugin', 'plugin.json'), git('show', `${ref}:.claude-plugin/plugin.json`));
  return path.join(old, 'server');
}

