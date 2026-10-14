#!/usr/bin/env node
// Stands in for `cloudflared` in the tunnel tests. Run as `tunnel --no-autoupdate --url http://127.0.0.1:<port>`, it prints a
// trycloudflare-style address on stderr, as the real one does, and stays alive until it is killed. FAKE_CLOUDFLARED_MODE:
//   (unset)  print the address and the "Registered tunnel connection" line
//   silent   print nothing (the start times out)
//   exit     print an error and exit 1
//   noconn   print the address only (the start settles after a short wait)
// FAKE_CLOUDFLARED_HOST sets the host name; FAKE_CLOUDFLARED_LOG, when set, gets a line with the pid and the arguments.
import { appendFileSync } from 'node:fs';

// `node --test` runs every .mjs under test/ with no arguments: do nothing then.
if (process.argv[2] === 'tunnel') {
  const mode = process.env.FAKE_CLOUDFLARED_MODE || '';
  const host = process.env.FAKE_CLOUDFLARED_HOST || 'quiet-fake-tunnel-test.trycloudflare.com';
  if (process.env.FAKE_CLOUDFLARED_LOG) appendFileSync(process.env.FAKE_CLOUDFLARED_LOG, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\n');
  const say = (text) => process.stderr.write(`2025-01-01T00:00:00Z INF ${text}\n`);
  if (mode === 'exit') {
    say('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host');
    process.exit(1);
  }
  if (mode !== 'silent') {
    say('Requesting new quick Tunnel on trycloudflare.com...');
    say('+--------------------------------------------------------------------------------------------+');
    say(`|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |`);
    say(`|  https://${host}                                         |`);
    if (mode !== 'noconn') say('Registered tunnel connection connIndex=0 connection=00000000-0000-0000-0000-000000000000 event=0 ip=198.41.200.1 location=ams01 protocol=quic');
  }
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
}
