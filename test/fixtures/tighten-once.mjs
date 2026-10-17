// Runs one tightenDataDir() pass in its own process, the way an MCP server start does. The test sets
// THREAD_DATA_DIR to a temp folder and names it in argv[2]. node --test also runs every .mjs here, so
// with no argument it must exit 0 at once and touch no data directory at all.
import process from 'node:process';
import * as state from '../../server/state.mjs';

if (process.argv[2] && process.env.THREAD_DATA_DIR) state.tightenDataDir();
