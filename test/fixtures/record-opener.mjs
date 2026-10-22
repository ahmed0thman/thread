#!/usr/bin/env node
// Stands in for the browser opener (THREAD_OPENER) in tests: writes its argument to the file named by THREAD_OPENER_LOG and exits 0.
// With no argument (node --test runs every .mjs here) it does nothing.
import { appendFileSync } from 'node:fs';

const [link] = process.argv.slice(2);
if (link && process.env.THREAD_OPENER_LOG) appendFileSync(process.env.THREAD_OPENER_LOG, link + '\n');
