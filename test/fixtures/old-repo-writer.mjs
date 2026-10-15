// Runs the write paths of an older plugin version against the data directory in THREAD_DATA_DIR, on a project whose newer sessions keep the
// board in the repo: the older version knows only the local store.
// usage: node old-repo-writer.mjs <older server folder> <project dir> add|edit|list
//   add: adds a card as the user would on the board and prints its id; edit: renames card c1 (and says so on stdout); list: prints the card ids
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (mode === 'add') console.log((await core.addCard(projectDir, { title: 'Added by the older version', source: 'user' })).id);
else if (mode === 'edit') console.log((await core.updateCard(projectDir, 'c1', { title: 'Renamed by the older version' }, { source: 'user' })).id);
else console.log(core.readState(projectDir).cards.map((c) => c.id).join(','));
