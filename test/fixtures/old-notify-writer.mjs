// Runs the write paths of an older plugin version on a card that carries the notify fields of a newer one.
// usage: node old-notify-writer.mjs <older server folder> <project dir> [seen]
//   without "seen": the older version renames card c1 as the user would on the board
//   with "seen": the older version lists the board (markSeen)
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

await new Promise((r) => setTimeout(r, 5));
if (mode === 'seen') await core.markSeen(projectDir);
else await core.updateCard(projectDir, 'c1', { title: 'Renamed by the older version' }, { source: 'user' });
