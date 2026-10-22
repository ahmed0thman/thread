#!/usr/bin/env node
// Stands in for a browser opener (THREAD_OPENER) that fails: exits 1 when it is given an argument (a link), 0 with none.
// With no argument (node --test runs every .mjs here) it exits 0.
process.exit(process.argv.length > 2 ? 1 : 0);
