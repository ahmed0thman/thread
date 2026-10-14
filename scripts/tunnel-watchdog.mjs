#!/usr/bin/env node
// Runs cloudflared for the board's tunnel and makes sure it does not outlive its owner. Started by server/tunnel.mjs as
//   node tunnel-watchdog.mjs <expiry, ms since the epoch> <cloudflared> <cloudflared arguments...>
// with a pipe on stdin. It ends cloudflared, and then itself, when that pipe closes (the owner ended, even by SIGKILL), when the
// expiry has passed (checked against the clock, so a sleeping computer does not stretch it), or when it is told to stop (a signal, or
// the owner closing the pipe). cloudflared's stderr is this process's stderr, so the owner reads the tunnel address from it. The
// first line on stdout is `cloudflared-pid <pid>`. This process ends when cloudflared does.
import { spawn } from 'node:child_process';

const [expiry, bin, ...args] = process.argv.slice(2);
const expiresAt = Number(expiry);
// `node --test` runs every .mjs under test/ and a script may be started with no arguments: do nothing then.
if (!bin || !Number.isFinite(expiresAt)) process.exit(2);

const KILL_AFTER_MS = 2000;
const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(1);
  }, KILL_AFTER_MS);
}

child.on('error', (e) => { process.stderr.write(`cloudflared could not be started: ${e && e.message}\n`); process.exit(1); });
child.on('exit', (code, sig) => process.exit(sig ? 1 : (code || 0)));

process.stdin.on('data', () => { /* nothing is expected; reading keeps the pipe watched */ });
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);

setInterval(() => { if (Date.now() >= expiresAt) stop(); }, 1000);

// Last, so that whoever reads this line can already count on the handlers above.
if (child.pid) process.stdout.write(`cloudflared-pid ${child.pid}\n`);
