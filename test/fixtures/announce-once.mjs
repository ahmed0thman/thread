#!/usr/bin/env node
// Runs one announce() of server/update.mjs as the given plugin version and prints its answer as one JSON line (a test starts several at
// once). THREAD_GATE_AT (ms since 1970) holds every process back until the same moment. With no argument (node --test runs every .mjs
// here) it does nothing.
import { announce } from '../../server/update.mjs';

const [version, latest] = process.argv.slice(2);
if (version) {
  const gate = Number(process.env.THREAD_GATE_AT);
  if (Number.isFinite(gate)) while (Date.now() < gate) { /* wait for the others */ }
  process.stdout.write(JSON.stringify(announce(version, latest || null)) + '\n');
}
