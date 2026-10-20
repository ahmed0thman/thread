// Where the owner dragged the milestones on the Milestones map: a cell of the map's grid (column and row) per milestone, kept per project in
// the plugin's data directory (projects/<key>/milestone-layout.json). It belongs to this machine: it is never written into the repo, into
// state.json or into the browser. A milestone with no entry stays where the map puts it. An older plugin version never reads the file.
// Imports only state.mjs and fields.mjs.
import { readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { PRIVATE_FILE, projectPaths, withLock } from './state.mjs';
import { CARD_ID_RE } from './fields.mjs';

export const MAX_CELL = 79;           // the map has 80 columns and 80 rows at most (MS_MAX_CELL in the board page)
export const MAX_LAYOUT_CHANGES = 20; // positions one call may set (a drop sets one, or two when it swaps)
export const MAX_POSITIONS = 200;      // saved places in all: the reader keeps no more, so the writer refuses to save more

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCell = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_CELL;
const layoutFile = (projectDirArg) => projectPaths(projectDirArg).layout;

/**
 * The positions of a stored value that make sense: { id: { col, row } } with ids of cards and cells inside the grid, at most MAX_POSITIONS, and no
 * two in one cell (the later one is dropped, as the map does: the first keeps the cell). Anything else is dropped.
 */
function tidy(raw) {
  const out = {};
  const used = new Set();
  const src = isObject(raw) && isObject(raw.positions) ? raw.positions : {};
  for (const [id, p] of Object.entries(src)) {
    if (Object.keys(out).length >= MAX_POSITIONS) break;
    if (!CARD_ID_RE.test(id) || !isObject(p) || !isCell(p.col) || !isCell(p.row) || used.has(`${p.col}:${p.row}`)) continue;
    used.add(`${p.col}:${p.row}`);
    out[id] = { col: p.col, row: p.row };
  }
  return out;
}

/**
 * The saved positions of a project, { id: { col, row } }; {} when there are none, or the file cannot be read (a damaged file is no layout).
 * With `live` (the Set of the ids of the project's milestones) only those are returned, and a position saved under an id that the one-time copy into
 * the repo changed (`aliases`: old id -> id now, state.aliases) is read as the milestone's new id.
 */
export function readMilestoneLayout(projectDirArg, live, aliases) {
  let all;
  try { all = tidy(JSON.parse(readFileSync(layoutFile(projectDirArg), 'utf8'))); } catch { return {}; }
  if (!live) return all;
  const out = {};
  const used = new Set();
  const put = (id, p) => { if (!(id in out) && !used.has(`${p.col}:${p.row}`)) { out[id] = p; used.add(`${p.col}:${p.row}`); } };
  for (const [id, p] of Object.entries(all)) if (live.has(id)) put(id, p);
  for (const [id, p] of Object.entries(all)) if (!live.has(id) && aliases && live.has(aliases.get(id))) put(aliases.get(id), p);
  return out;
}

async function writeLayout(file, positions) {
  if (!Object.keys(positions).length) { await unlink(file).catch(() => {}); return; }
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ version: 1, positions }), { encoding: 'utf8', mode: PRIVATE_FILE });
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Saves the cells in `changes` ({ id: { col, row } }) next to the ones already saved, and resolves to the layout now. `live` is the Set of the
 * ids of the project's milestones: a position for any other id is refused, and one saved for a milestone that is gone is dropped here (`aliases` as in readMilestoneLayout: a place saved under an old id is rewritten under the new one). Two
 * milestones cannot be saved in one cell. Under the project's lock, so two drops never lose each other.
 */
export async function setMilestoneLayout(projectDirArg, changes, live, aliases) {
  if (!isObject(changes)) throw new Error('set must be an object of milestone ids and cells');
  const ids = Object.keys(changes);
  if (!ids.length) throw new Error('set holds no milestone');
  if (ids.length > MAX_LAYOUT_CHANGES) throw new Error(`set has too many milestones (${ids.length}, the limit is ${MAX_LAYOUT_CHANGES})`);
  // `live` may be a Map of id -> title: the messages then name a milestone by its title
  const nameOf = (id) => (live instanceof Map && typeof live.get(id) === 'string' ? `"${live.get(id).slice(0, 30)}"` : id);
  for (const id of ids) {
    const p = changes[id];
    if (!CARD_ID_RE.test(id) || !live.has(id)) throw new Error(`milestone not found: ${id.slice(0, 40)}`);
    if (!isObject(p) || !isCell(p.col) || !isCell(p.row)) throw new Error(`the cell of ${nameOf(id)} must be a column and a row, each a whole number from 0 to ${MAX_CELL}`);
  }
  return withLock(projectDirArg, async () => {
    const file = layoutFile(projectDirArg);
    const next = {};
    for (const [id, p] of Object.entries(readMilestoneLayout(projectDirArg, live, aliases))) if (!(id in changes)) next[id] = p;
    for (const id of ids) next[id] = { col: changes[id].col, row: changes[id].row };
    if (Object.keys(next).length > MAX_POSITIONS) throw new Error(`the map keeps at most ${MAX_POSITIONS} saved places; Reset layout, or move fewer milestones`);
    const taken = new Map();
    for (const [id, p] of Object.entries(next)) {
      const k = `${p.col}:${p.row}`;
      if (taken.has(k)) throw new Error(`the cell column ${p.col + 1}, row ${p.row + 1} is taken by ${nameOf(taken.get(k))}; ${nameOf(id)} cannot share it`);
      taken.set(k, id);
    }
    await writeLayout(file, next);
    return next;
  });
}

/** Forgets every saved position of the project: the map goes back to its own layout. */
export async function resetMilestoneLayout(projectDirArg) {
  return withLock(projectDirArg, async () => { await writeLayout(layoutFile(projectDirArg), {}); return {}; });
}
