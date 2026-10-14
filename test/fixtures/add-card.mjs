// Adds one card to a project and prints its id; exits 1 with the message on stderr when that fails.
// usage: node add-card.mjs <core.mjs path> <project dir>
import { pathToFileURL } from 'node:url';

const [corePath, projectDir] = process.argv.slice(2);
if (!corePath || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
try {
  const core = await import(pathToFileURL(corePath).href);
  console.log((await core.addCard(projectDir, { title: 'x' })).id);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
