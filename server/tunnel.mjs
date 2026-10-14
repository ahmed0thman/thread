// Remote access to the board through a Cloudflare quick tunnel. Off unless the owner asks for it (/thread:board --tunnel).
//
// What it is: a second HTTP listener on 127.0.0.1 (a free port, made by http.mjs and handed in as `serve`) that applies the
// remote policy, and a `cloudflared tunnel --url` child process that points at it. The tunnel never points at the normal board
// port. The remote listener accepts only the fresh token made here, never board.token, and only the routes http.mjs allows.
//
// This file has no import from http.mjs: the manager gets what it needs through `serve`, so the two do not import each other.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_FILE, dataDir, mkdirPrivateSync } from './state.mjs';

export const TUNNEL_LIFETIME_MS = 12 * 60 * 60 * 1000;
const START_TIMEOUT_MS = 30000;
const SETTLE_MS = 8000;          // after the address is printed, how long to wait for the tunnel to say it is connected
const STOP_WAIT_MS = 3000;
const OUT_TAIL = 8;
const DEFAULT_LIMITS = { concurrent: 32, writesPerMinute: 60 };
// What a cloudflared child started by this plugin looks like in a process list: used to tell a stale one from a stranger's process.
const WATCHDOG = fileURLToPath(new URL('../scripts/tunnel-watchdog.mjs', import.meta.url));
const EXPIRY_CHECK_MS = 60000;   // setTimeout does not count the time a sleeping computer spends asleep, so the expiry is also read off the clock
const OUR_COMMAND = /cloudflared\S*["']?\s+tunnel\s+--no-autoupdate\s+--url\s+http:\/\/127\.0\.0\.1:\d+/;

export class TunnelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Anything that looks like a token or an id (32 or more token characters) is hidden before text reaches a message or a log. */
export function redact(text) {
  return String(text).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

// ---------------------------------------------------------------- finding cloudflared

function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * The cloudflared binary, or null. THREAD_CLOUDFLARED_BIN (for tests) decides alone when it is set. Otherwise PATH, then the usual
 * install places (a GUI-started Claude Code may have a short PATH). Nothing is ever downloaded.
 */
export function findCloudflared(env = process.env, platform = process.platform) {
  const forced = typeof env.THREAD_CLOUDFLARED_BIN === 'string' ? env.THREAD_CLOUDFLARED_BIN.trim() : '';
  if (forced) return isExecutable(forced) ? forced : null;
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dirs = String(env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const common = platform === 'win32'
    ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((d) => join(d, 'cloudflared'))
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of [...dirs, ...common]) {
    const file = join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

/** What to tell a user who has no cloudflared: the one-time install for their system, then to run the command again. */
export function installHelp(platform = process.platform) {
  const how = platform === 'darwin' ? 'Install it once with: brew install cloudflared'
    : platform === 'win32' ? 'Install it once with: winget install --id Cloudflare.cloudflared'
      : 'Install it once from Cloudflare\'s package repository or as a direct download: https://developers.cloudflare.com/tunnel/downloads/';
  return `cloudflared is not installed. The tunnel needs it, and it needs no Cloudflare account. ${how}\nThen run /thread:board --tunnel again.`;
}

// ---------------------------------------------------------------- the child process

// The tunnel's address is the one trycloudflare.com name made of several words. api.trycloudflare.com, which cloudflared also prints, has none.
const URL_RE = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com)(?![A-Za-z0-9-]|\.[A-Za-z0-9])/i;

/** Pure: the host in one line of cloudflared output, or null. */
export function parseTunnelHost(line) {
  const m = URL_RE.exec(String(line));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Start `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` under scripts/tunnel-watchdog.mjs, and resolve
 * { child, host } once it has printed its address and says the tunnel is connected (or `settleMs` after the address). `child` is the
 * watchdog: it ends cloudflared when this process ends (even killed), when `expiresAt` has passed, or when it is stopped. Rejects with
 * a TunnelError after `timeoutMs`, or when the child ends first; the child is killed then. `onSpawn(child)` runs as soon as the
 * child exists, `onPid(pid)` when the watchdog says which pid cloudflared has.
 */
export function startCloudflared(bin, port, { timeoutMs = START_TIMEOUT_MS, settleMs = SETTLE_MS, expiresAt = Date.now() + TUNNEL_LIFETIME_MS, onSpawn, onPid } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [WATCHDOG, String(expiresAt), bin, 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new TunnelError('failed', `cloudflared could not be started: ${redact(e && e.message)}`));
      return;
    }
    child.stdin.on('error', () => { /* the watchdog is gone; the exit handler reports it */ });
    if (onSpawn) onSpawn(child);
    let host = null;
    let done = false;
    let settle = null;
    const tail = [];
    const timer = setTimeout(() => finish(new TunnelError('timeout', `cloudflared did not give a tunnel address within ${Math.round(timeoutMs / 1000)} s. The machine may be offline, or a firewall may block outbound traffic to Cloudflare on port 7844 (QUIC over UDP, or HTTP/2 over TCP).${tailText()}`)), timeoutMs);
    const tailText = () => (tail.length ? `\nLast output of cloudflared:\n${tail.join('\n')}` : '');
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settle);
      if (err) {
        endChild(child);   // a SIGKILL would leave cloudflared without its watchdog
        reject(err);
      } else resolve({ child, host });
    }
    const pump = (stream) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 16384) buf = buf.slice(-16384);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          const pm = /^cloudflared-pid (\d+)$/.exec(line);
          if (pm) { if (onPid) onPid(Number(pm[1])); continue; }
          if (done) continue;   // after the start, the output is only drained
          if (line.trim()) { tail.push(redact(line.trim()).slice(0, 300)); if (tail.length > OUT_TAIL) tail.shift(); }
          if (!host) {
            host = parseTunnelHost(line);
            if (host) settle = setTimeout(() => finish(null), settleMs);
          } else if (/registered tunnel connection/i.test(line)) finish(null);
        }
      });
      stream.on('error', () => { /* the exit handler reports it */ });
    };
    pump(child.stdout);
    pump(child.stderr);
    child.on('error', (e) => finish(new TunnelError('failed', `cloudflared could not be started: ${redact(e && e.message)}`)));
    child.on('exit', (code, sig) => finish(new TunnelError('failed', `cloudflared stopped before the tunnel was ready (${sig ? 'signal ' + sig : 'exit code ' + code}).${tailText()}`)));
  });
}

// The children (watchdogs) this process started, ended when it ends. A SIGKILLed owner cannot do this; the watchdog notices the
// closed pipe and ends cloudflared itself, and the pid file is for what even that missed.
const live = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
function endChild(c) {
  try { c.stdin.end(); } catch { /* closed */ }   // closing the pipe is the portable way to say stop
  try { c.kill('SIGTERM'); } catch { /* already gone */ }
}
function killLive() { for (const c of live) { endChild(c); clearPid(c.pid); } }
function onSignal(sig) {
  killLive();
  // Stand aside: when ours was the only handler, the signal does what it would have done without us.
  process.removeListener(sig, signalHandlers[sig]);
  if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}
const signalHandlers = Object.fromEntries(SIGNALS.map((s) => [s, () => onSignal(s)]));
function track(child) {
  live.add(child);
  if (!process.listeners('exit').includes(killLive)) process.on('exit', killLive);
  for (const s of SIGNALS) if (!process.listeners(s).includes(signalHandlers[s])) process.on(s, signalHandlers[s]);
}
function untrack(child) {
  live.delete(child);
  if (live.size) return;
  process.removeListener('exit', killLive);
  for (const s of SIGNALS) process.removeListener(s, signalHandlers[s]);
}

// ---------------------------------------------------------------- the pid file

// If the owner is killed outright, the watchdog sees its pipe close and ends cloudflared, so the pid file only matters for a watchdog
// that could not (or one an older version started without it). The record holds the watchdog's pid, cloudflared's pid and the owner's.
const pidFile = () => join(dataDir(), 'tunnel.pid');

function writePid(rec) {
  try {
    mkdirPrivateSync(dataDir());
    writeFileSync(pidFile(), JSON.stringify({ ...rec, owner: process.pid, startedAt: new Date().toISOString() }) + '\n', { mode: PRIVATE_FILE });
  } catch { /* the pid file is a safety net only */ }
}
function clearPid(pid) {
  try {
    const rec = JSON.parse(readFileSync(pidFile(), 'utf8'));
    if (rec && rec.pid === pid) unlinkSync(pidFile());
  } catch { /* none, or not ours */ }
}

function commandLineOf(pid) {
  return new Promise((resolve) => {
    const done = (err, out) => resolve(err ? null : String(out).trim());
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { timeout: 5000, windowsHide: true }, done);
    } else {
      execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5000 }, done);
    }
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

/**
 * Ends a tunnel that an earlier owner left behind (its watchdog and its cloudflared), but only when the owner recorded with it is
 * dead, and only a pid that still runs cloudflared with this plugin's arguments. A live owner's tunnel is never touched, and its
 * record is left in place. A record without an owner (an older version) counts as an owner that is gone.
 */
export async function reapStaleTunnel() {
  let rec;
  try { rec = JSON.parse(readFileSync(pidFile(), 'utf8')); } catch { return false; }
  const owner = rec && rec.owner;
  if (Number.isInteger(owner) && owner > 0 && (owner === process.pid || pidAlive(owner))) return false;
  try { unlinkSync(pidFile()); } catch { /* gone */ }
  let reaped = false;
  for (const pid of new Set([rec && rec.pid, rec && rec.cloudflared])) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    const cmd = await commandLineOf(pid);
    if (!cmd || !OUR_COMMAND.test(cmd)) continue;
    try { process.kill(pid, 'SIGTERM'); reaped = true; } catch { /* gone */ }
  }
  return reaped;
}

// ---------------------------------------------------------------- the manager

function sameToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One tunnel at a time. `serve(policy)` starts the remote listener and resolves { server, port }. The policy is what that listener
 * consults on every request: its host, its token, its expiry and its limits. Options are for tests: `now` (a clock), `lifetimeMs`,
 * `limits`, `startTimeoutMs`, `settleMs`, `expiryCheckMs`.
 */
export function createTunnelManager({ serve, lifetimeMs = TUNNEL_LIFETIME_MS, now = Date.now, limits = {}, startTimeoutMs = START_TIMEOUT_MS, settleMs = SETTLE_MS, expiryCheckMs = EXPIRY_CHECK_MS } = {}) {
  let active = null;    // { policy, server, child, timer, clock }
  let closed = false;   // the board this manager belongs to has ended: no tunnel may start
  let starting = null;  // { promise, cancelled, child }

  const view = (a, reused) => ({ active: true, url: `https://${a.policy.host}/`, host: a.policy.host, token: a.policy.token, expiresAt: a.policy.expiresAt, reused });

  async function begin(attempt) {
    const bin = findCloudflared();
    if (!bin) throw new TunnelError('missing', installHelp());
    await reapStaleTunnel();
    const policy = {
      host: null,
      token: randomBytes(32).toString('hex'),
      expiresAt: 0,
      limits: { ...DEFAULT_LIMITS, ...limits },
      inFlight: 0,
      writes: [],
      now,
      tokenOk(given) { return sameToken(given, this.token); },
      // a revoked token counts as expired
      expired() { return !this.token || now() >= this.expiresAt; },
      expire() { stop().catch(() => {}); },
    };
    const { server } = await serve(policy);
    let started;
    try {
      started = await startCloudflared(bin, server.address().port, {
        timeoutMs: startTimeoutMs,
        settleMs,
        // the watchdog gives up on its own a little after the lifetime, if this process is somehow still there but no longer ends it
        expiresAt: Date.now() + lifetimeMs + startTimeoutMs,
        onSpawn: (c) => { attempt.child = c; attempt.pids = { pid: c.pid }; track(c); writePid(attempt.pids); },
        onPid: (cf) => { if (attempt.pids) { attempt.pids.cloudflared = cf; writePid(attempt.pids); } },
      });
      if (attempt.cancelled) throw new TunnelError('failed', 'The tunnel was stopped while it was starting.');
    } catch (e) {
      policy.token = null;
      closeServer(server);
      if (attempt.child) { killChild(attempt.child); untrack(attempt.child); clearPid(attempt.child.pid); }
      throw e;
    }
    policy.host = started.host;
    return { policy, server, child: started.child };
  }

  async function start() {
    if (closed) throw new TunnelError('failed', 'The board has stopped, so the tunnel cannot be started.');
    if (active) return view(active, true);
    if (starting) return starting.promise;
    const attempt = { cancelled: false, child: null, promise: null };
    attempt.promise = (async () => {
      try {
        const made = await begin(attempt);
        made.policy.expiresAt = now() + lifetimeMs;
        made.timer = setTimeout(() => { stop().catch(() => {}); }, Math.min(lifetimeMs, 2 ** 31 - 1));
        if (typeof made.timer.unref === 'function') made.timer.unref();
        // a timer stands still while the computer sleeps, so the clock is read too
        made.clock = setInterval(() => { if (now() >= made.policy.expiresAt) stop().catch(() => {}); }, expiryCheckMs);
        if (typeof made.clock.unref === 'function') made.clock.unref();
        made.child.on('exit', () => { if (active === made) stop().catch(() => {}); });
        active = made;
        return view(made, false);
      } finally {
        starting = null;
      }
    })();
    starting = attempt;
    return attempt.promise;
  }

  function killChild(child) {
    endChild(child);
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, STOP_WAIT_MS);
    if (typeof hard.unref === 'function') hard.unref();
    child.once('exit', () => clearTimeout(hard));
  }

  function closeServer(server) {
    try { server.close(); server.closeAllConnections(); } catch { /* already closed */ }
  }

  /** Revokes the token, closes the remote listener and ends cloudflared. True when a tunnel was running. */
  async function stop() {
    if (starting) {
      starting.cancelled = true;
      if (starting.child) killChild(starting.child);
    }
    const cur = active;
    if (!cur) return false;
    active = null;
    clearTimeout(cur.timer);
    clearInterval(cur.clock);
    cur.policy.token = null;
    closeServer(cur.server);
    const gone = new Promise((resolve) => {
      if (cur.child.exitCode !== null || cur.child.signalCode !== null) resolve();
      else cur.child.once('exit', resolve);
    });
    killChild(cur.child);
    await Promise.race([gone, new Promise((r) => setTimeout(r, STOP_WAIT_MS + 500))]);
    untrack(cur.child);
    clearPid(cur.child.pid);
    return true;
  }

  function status() {
    return active ? view(active, true) : { active: false };
  }

  /** The board has ended: ends the tunnel, and no new one may start. */
  function close() {
    closed = true;
    return stop();
  }

  return { start, stop, status, close };
}
