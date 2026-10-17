// thread plugin: the note a new thread gets when the project has a Graphify code map (graphify-out/GRAPH_REPORT.md) and the `codeMap`
// setting is on. Only looks for files that already exist; nothing here builds, reads or sends the map.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

const NOTE = 'This project has a Graphify code map in graphify-out/ (start with graphify-out/GRAPH_REPORT.md; the /graphify skill queries it if installed). Use it to find which files matter before opening many files. It is an index, not the source of truth: read the actual code before deciding or changing anything, and if the map and the code disagree, the code wins. A missing result in the map is not proof something does not exist; confirm with a text search.';
const STALE = 'The map was built before the latest commit and may be out of date.';

function git(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return ''; }
}

// The map's report as a regular file inside `dir` (no symlink for the report or its folder), or null.
function reportIn(dir) {
  try {
    const folder = lstatSync(join(dir, 'graphify-out'));
    if (!folder.isDirectory()) return null;
    const report = lstatSync(join(dir, 'graphify-out', 'GRAPH_REPORT.md'));
    return report.isFile() ? report : null;
  } catch { return null; }
}

// The note for a thread running in `projectDir`: looked for there first, then at the git root. '' when there is no map.
export function codeMapNote(projectDir) {
  if (typeof projectDir !== 'string' || !projectDir) return '';
  let root = projectDir;
  let report = reportIn(root);
  if (!report) {
    const top = git(projectDir, ['rev-parse', '--show-toplevel']);
    if (!top || top === projectDir) return '';
    root = top;
    report = reportIn(root);
    if (!report) return '';
  }
  const commit = Number(git(root, ['log', '-1', '--format=%ct']));
  const stale = Number.isFinite(commit) && commit > 0 && report.mtimeMs < commit * 1000;
  return stale ? `${NOTE} ${STALE}` : NOTE;
}
