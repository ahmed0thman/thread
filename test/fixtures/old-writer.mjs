// Runs the write paths of an older plugin version against the data directory in THREAD_DATA_DIR.
// usage: node old-writer.mjs <older server folder> <project dir>
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

await core.updateCard(projectDir, 'c1', { title: 'Renamed by the older version', status: 'review' }, { source: 'user' });
await core.updateCard(projectDir, 'c1', { note: 'a note' }, { source: 'claude' });
await core.addCard(projectDir, { title: 'Added by the older version', source: 'user' });
await core.markSeen(projectDir);
await core.reconcile(projectDir);
await core.pendingAnnouncements(projectDir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
await core.removeCard(projectDir, 'c2');
