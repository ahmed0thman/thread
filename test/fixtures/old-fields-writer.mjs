// Runs one write path of an older plugin version against the data directory in THREAD_DATA_DIR.
// usage: node old-fields-writer.mjs <older server folder> <project dir> <create|move|edit>
//   create: two cards, as the older version makes them; the second one is moved to done
//   move:   c1 to the stage "done", as Claude
//   edit:   c1 renamed, and its note changed, as Claude
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode] = process.argv.slice(2);
if (!serverDir || !projectDir || !mode) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (mode === 'create') {
  await core.addCard(projectDir, { title: 'Made by the older version', source: 'claude' });
  const two = await core.addCard(projectDir, { title: 'Also made by it', source: 'user' });
  await core.updateCard(projectDir, two.id, { status: 'done' }, { source: 'claude' });
} else if (mode === 'move') {
  await core.updateCard(projectDir, 'c1', { status: 'done' }, { source: 'claude' });
} else if (mode === 'edit') {
  await core.updateCard(projectDir, 'c1', { title: 'Renamed by the older version' }, { source: 'claude' });
  await core.updateCard(projectDir, 'c1', { note: 'a note', status: 'review' }, { source: 'user' });
} else {
  process.exit(2);
}
