// Runs an older plugin version against the data directory in THREAD_DATA_DIR, on a card that carries a field of a newer one (the card's agent).
// usage: node old-worker-writer.mjs <older server folder> <project dir> rename <card id>   renames the card as the user would on the board
//        node old-worker-writer.mjs <older server folder> <project dir> lane <card id> <lane>   sets that lane on the card ('' removes it)
//        node old-worker-writer.mjs <older server folder> <project dir> serve               starts the older board on a free port, prints "<port> <token>" and stays up
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode, id, lane] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (mode === 'rename') {
  await new Promise((r) => setTimeout(r, 5));
  await core.updateCard(projectDir, id, { title: 'Renamed by the older version' }, { source: 'user' });
} else if (mode === 'lane') {
  await core.updateCard(projectDir, id, { lane }, { source: 'user' });
} else if (mode === 'serve') {
  const http = await import(pathToFileURL(join(serverDir, 'http.mjs')).href);
  const token = 'ab'.repeat(16);
  const b = await http.startBoardServer(projectDir, { port: 0, token });
  console.log(`${b.port} ${token} ${core.projectKey(projectDir)}`);
  setInterval(() => {}, 1000);
}
