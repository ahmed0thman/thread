// Runs the write paths of an older plugin version on one milestone card, against the data directory in THREAD_DATA_DIR.
// usage: node old-milestone-writer.mjs <older server folder> <project dir> <milestone id> <another card id>
//   renames the milestone as the owner would on the board, changes its note as Claude, adds a card to it and removes the other card
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, id, other] = process.argv.slice(2);
if (!serverDir || !projectDir || !id) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

await core.updateCard(projectDir, id, { title: 'Renamed by the older version' }, { source: 'user' });
await core.updateCard(projectDir, id, { note: 'a note' }, { source: 'claude' });
await core.addCard(projectDir, { title: 'A card added by the older version', parent: id, source: 'user' });
if (other) await core.removeCard(projectDir, other);
