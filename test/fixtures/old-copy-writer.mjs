// Turns the repo folder on for a project and makes the one-time copy of its cards into the repo, with an older plugin version's code (which knows
// nothing of a milestone's `dependsOn`), against the data directory in THREAD_DATA_DIR.
// usage: node old-copy-writer.mjs <older server folder> <project dir>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

core.enableRepo(projectDir);
await core.addCard(projectDir, { title: 'Added by the older version, which makes the copy', source: 'user' });
