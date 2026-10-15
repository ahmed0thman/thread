// Runs the single-answer path of an older plugin version on items that a newer one answered in a batch.
// usage: node old-answer-writer.mjs <older server folder> <project dir> <card id> <item id>   prints "answered" or "no waiting items"
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, cardId, itemId] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (typeof core.answerWait !== 'function') {
  process.stdout.write('no waiting items\n');   // a version from before waiting items
} else {
  await core.answerWait(projectDir, cardId, itemId, { done: true });
  process.stdout.write('answered\n');
}
await core.updateCard(projectDir, cardId, { title: 'Renamed by the older version' }, { source: 'user' });
