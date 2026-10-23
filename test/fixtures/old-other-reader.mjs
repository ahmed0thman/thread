// Runs the answer, phrase and card-write paths of an older plugin version on a choice item that a newer one may have answered "Other".
// usage: node old-other-reader.mjs <older server folder> <project dir> answer <items as JSON>   prints "ok" or "refused: <the message>"
//        node old-other-reader.mjs <older server folder> <project dir> phrase <card id> <item id>   prints { phrase, line, fileLine } as JSON
//        node old-other-reader.mjs <older server folder> <project dir> touch <card id>   renames the card, as the older version's board would
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode, a, b] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (mode === 'answer') {
  try {
    await core.answerWaits(projectDir, JSON.parse(a));
    console.log('ok');
  } catch (e) {
    console.log(`refused: ${e.message}`);
  }
} else if (mode === 'phrase') {
  const card = core.readState(projectDir).cards.find((c) => c.id === a);
  const item = core.waitsOf(card).find((w) => w.id === b);
  console.log(JSON.stringify({ phrase: core.answerPhrase(item), line: core.deliveryLine(item), fileLine: core.deliveryLine({ ...item, fromFile: true }) }));
} else if (mode === 'touch') {
  await core.updateCard(projectDir, a, { title: 'Renamed by the older version' }, { source: 'user' });
  console.log('ok');
}
