// Runs the write path an older plugin version has for a report click, and reads a config that holds the `wake` setting.
// usage: node old-wake-writer.mjs <older server folder> <project dir>   prints the mode that version reads
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir] = process.argv.slice(2);
if (!serverDir || !projectDir) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

await core.requestReport(projectDir, 'c1');
process.stdout.write(`${core.readConfig(projectDir).mode}\n`);
