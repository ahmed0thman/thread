// Test helper for test/wake.test.mjs. `waiter-parent.mjs hold` stays alive until killed (a stand-in for Claude Code).
// `waiter-parent.mjs spawn <waiter.mjs>` starts the waiter as its child, passes its own stdin on, and prints the child's pid.
// With no arguments it exits 0, because node --test runs every .mjs in this folder.
import { spawn } from 'node:child_process';

const [mode, script] = process.argv.slice(2);
if (mode === 'hold') {
  setInterval(() => {}, 1000);
} else if (mode === 'spawn' && script) {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
  process.stdin.pipe(child.stdin);
  process.stdout.write(`${child.pid}\n`);
  setInterval(() => {}, 1000);
}
