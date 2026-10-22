// Runs an older plugin version's board-token reader against the data directory in THREAD_DATA_DIR.
// usage: node old-board-token.mjs <older server folder>   exits 0 when that version's boardToken() returns what board.token holds now
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const [serverDir] = process.argv.slice(2);
if (!serverDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const http = await import(pathToFileURL(join(serverDir, 'http.mjs')).href);
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);
const got = http.boardToken();
const held = readFileSync(join(core.dataDir(), 'board.token'), 'utf8').trim();
process.exit(got === held ? 0 : 1);
