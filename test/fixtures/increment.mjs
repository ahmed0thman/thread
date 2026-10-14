// Increments a counter in a project's state ten times, through updateState.
// usage: node increment.mjs <core.mjs path> <project dir>
import { pathToFileURL } from 'node:url';

const [corePath, projectDir] = process.argv.slice(2);
if (!corePath || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(corePath).href);
for (let i = 0; i < 10; i++) {
  await core.updateState(projectDir, (s) => { s.counter = (s.counter || 0) + 1; });
}
