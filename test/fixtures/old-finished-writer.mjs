// Runs one path of an older plugin version (0.12.1) against the data directory in THREAD_DATA_DIR.
// usage: node old-finished-writer.mjs <older server folder> <project dir> <milestone|read|release>
//   milestone: c1 (a milestone) gets the status "done" by hand, as Claude; that version let a milestone have a stage
//   read:      prints what the older version reads: each card's kind and shown stage, and the progress of c1
//   release:   c1 moves from the done stage to "released", as Claude; that version marks it as having left the done stage
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [serverDir, projectDir, mode] = process.argv.slice(2);
if (!serverDir || !projectDir || !mode) process.exit(0);   // `node --test` also runs every file in this folder, with no arguments
const core = await import(pathToFileURL(join(serverDir, 'core.mjs')).href);

if (mode === 'milestone') {
  await core.updateCard(projectDir, 'c1', { status: 'done' }, { source: 'claude' });
} else if (mode === 'read') {
  const cfg = core.readConfig(projectDir);
  const cards = core.readState(projectDir).cards;
  console.log(JSON.stringify({
    cards: cards.map((c) => [c.id, c.kind, core.effectiveStatus(c, cfg)]),
    progress: core.milestoneProgress(cards, 'c1', cfg),
  }));
  await core.updateCard(projectDir, 'c2', { title: 'Renamed by the older version' }, { source: 'claude' });   // and writes it
} else if (mode === 'release') {
  await core.updateCard(projectDir, 'c1', { status: 'released' }, { source: 'claude' });
} else {
  process.exit(2);
}
