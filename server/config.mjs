// Board settings: chat-only or task mode, the stages and which stage the plugin itself uses, and whether the board may wake the session.
// Two optional files with the same shape, <data dir>/config.json and <project data>/config.json. A repo-backed project (see repo.mjs) keeps
// its mode, stages and roles in `.claude/thread/config.json` instead, and only the `wake` setting in its local file: whether the board may
// wake a session is the machine's own choice, so a committed file can never turn it on. `codeMap` (a note in a new thread's prompt) is shared like the mode.
// Imports only state.mjs and repo.mjs.
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRIVATE_FILE, dataDir, mkdirPrivate, projectKey, projectPaths, repoConfigPath, repoRootOf } from './state.mjs';
import { MAX_CONFIG_FILE, hasConflictMarkers, readPlainFile } from './repo.mjs';

export const DEFAULT_STAGES = [
  { id: 'idea', label: 'Idea' },
  { id: 'new', label: 'New' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
];
export const CONFIG_MODES = ['tasks', 'chat'];
export const CONFIG_SCOPES = ['global', 'project'];
export const ROLE_NAMES = ['start', 'working', 'review', 'blocked', 'done'];
export const STAGE_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MIN_STAGES = 2;
const MAX_STAGES = 10;
const MAX_LABEL = 30;
const DEFAULT_ROLES = { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' };

// Chat-only mode has its own three columns, whatever stages the task board has. A thread runs in New, a thread whose turn
// finished or failed waits in Review, an ended one is Done. The stored stage settings are not touched, so the task board gets its own back.
export const CHAT_STAGES = [{ id: 'new', label: 'New' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Done' }];
const CHAT_ROLES = { start: 'new', working: 'new', review: 'review', blocked: 'review', done: 'done' };

export const CHAT_ONLY_MESSAGE = 'The task board is off for this project (chat-only). Run /thread:setup to turn it on.';

// Refused because the project is chat-only. The board maps it to HTTP 409.
export class ChatOnlyError extends Error {
  constructor() { super(CHAT_ONLY_MESSAGE); this.status = 409; }
}

// ---------------------------------------------------------------- validation

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanStages(stages) {
  if (!Array.isArray(stages) || stages.length < MIN_STAGES || stages.length > MAX_STAGES) {
    throw new Error(`stages must be a list of ${MIN_STAGES} to ${MAX_STAGES} entries`);
  }
  const out = [];
  for (const s of stages) {
    const id = isObject(s) && typeof s.id === 'string' ? s.id : '';
    if (!STAGE_ID_RE.test(id)) {
      throw new Error(`stage id "${String(isObject(s) ? s.id : s).slice(0, 40)}" is not valid (lowercase letters, digits and underscores, starting with a letter, at most 24 characters)`);
    }
    if (out.some((x) => x.id === id)) throw new Error(`stage id "${id}" is used twice`);
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    if (!label || label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) throw new Error(`stage "${id}" needs a label of 1 to ${MAX_LABEL} characters on one line`);
    out.push({ id, label });
  }
  return out;
}

function cleanRoles(roles, stages) {
  if (!isObject(roles)) throw new Error('roles must be an object');
  const ids = stages.map((s) => s.id);
  const out = {};
  for (const [role, id] of Object.entries(roles)) {
    if (!ROLE_NAMES.includes(role)) throw new Error(`unknown role "${role.slice(0, 40)}" (use ${ROLE_NAMES.join(', ')})`);
    if (typeof id !== 'string' || !ids.includes(id)) {
      throw new Error(`role "${role}" points to "${String(id).slice(0, 40)}", which is not one of the stages (${ids.join(', ')})`);
    }
    out[role] = id;
  }
  return out;
}

// What a config file may hold. Unknown top-level fields are dropped. Roles belong to the
// stages of the same file, so a file with roles must list its stages.
export function validateConfig(obj) {
  if (!isObject(obj)) throw new Error('config must be a JSON object');
  const out = {};
  if (obj.mode !== undefined) {
    if (!CONFIG_MODES.includes(obj.mode)) throw new Error(`mode must be one of: ${CONFIG_MODES.join(', ')}`);
    out.mode = obj.mode;
  }
  if (obj.wake !== undefined) {
    if (typeof obj.wake !== 'boolean') throw new Error('wake must be true or false');
    out.wake = obj.wake;
  }
  if (obj.codeMap !== undefined) {
    if (typeof obj.codeMap !== 'boolean') throw new Error('codeMap must be true or false');
    out.codeMap = obj.codeMap;
  }
  if (obj.stages !== undefined) out.stages = cleanStages(obj.stages);
  if (obj.roles !== undefined) {
    if (!out.stages) throw new Error('roles belong to the stages of the same config file: give stages as well');
    out.roles = cleanRoles(obj.roles, out.stages);
  }
  return out;
}

// Roles a config gives when it names none: the table above for the default stages, else by position.
function fillRoles(roles, stages, isDefault) {
  const n = stages.length;
  const id = (i) => stages[i].id;
  let base;
  if (isDefault) base = DEFAULT_ROLES;
  else {
    const working = n === 2 ? id(0) : id(1);
    base = { start: id(0), working, review: n > 2 ? id(n - 2) : id(n - 1), blocked: working, done: id(n - 1) };
  }
  return { ...base, ...(roles || {}) };
}

// ---------------------------------------------------------------- files

// global: the config for every project. project: the file that holds the project's mode, stages and roles (the repo's for a repo-backed
// project). local: the project's file in the data directory (its `wake`, and for an older project the rest too).
export function configPaths(projectDirArg) {
  const local = join(projectPaths(projectDirArg).dir, 'config.json');
  const root = repoRootOf(projectDirArg);
  // `spelled`: the file the project had before it was repo-backed, when its folder was given another way then (a symlink): a repo-backed
  // project is keyed by the real path of its main checkout
  const spelled = join(dataDir(), 'projects', projectKey(resolve(String(projectDirArg))), 'config.json');
  return { global: join(dataDir(), 'config.json'), project: root ? repoConfigPath(root) : local, local, spelled };
}

const logged = new Set();
function logOnce(path, message) {
  const key = `${path} ${message}`;
  if (logged.has(key)) return;
  logged.add(key);
  try { process.stderr.write(`[thread/config] ignoring ${path}: ${message}\n`); } catch { /* ignore */ }
}

// { exists, config, invalid } for one file. An unreadable or invalid file has config null and says why.
const lstatExists = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// `plain`: the file comes from a repo, so it is read only when it is a plain file of an ordinary size (not a link, a device, a pipe or a huge file).
function readFile(path, { plain = false } = {}) {
  if (!existsSync(path) && !(plain && lstatExists(path))) return { exists: false, config: null, invalid: null };
  try {
    let text;
    if (plain) {
      const r = readPlainFile(path, MAX_CONFIG_FILE);
      if (r.problem) throw new Error(`the file ${r.problem}`);
      text = r.text;
    } else text = readFileSync(path, 'utf8');
    if (hasConflictMarkers(text)) throw new Error('the file has git merge conflict markers: resolve the conflict and commit it');
    return { exists: true, config: validateConfig(JSON.parse(text)), invalid: null };
  } catch (e) {
    logOnce(path, e.message);
    return { exists: true, config: null, invalid: String(e.message).split('\n')[0] };
  }
}

// The project layer. For a repo-backed project: mode, stages and roles from the repo's file, else from the local one (a project that was
// set up before it moved into the repo keeps working); wake from the local file only.
function projectFile(paths, backed) {
  let local = readFile(paths.local);
  if (!backed) return local;
  if (!local.exists && paths.spelled !== paths.local) local = readFile(paths.spelled);
  const repo = readFile(paths.project, { plain: true });
  const rc = repo.config || {};
  const lc = local.config || {};
  const config = {};
  const mode = rc.mode !== undefined ? rc.mode : lc.mode;
  if (mode !== undefined) config.mode = mode;
  const codeMap = rc.codeMap !== undefined ? rc.codeMap : lc.codeMap;
  if (codeMap !== undefined) config.codeMap = codeMap;
  const from = rc.stages !== undefined ? rc : lc;
  if (from.stages !== undefined) config.stages = from.stages;
  if (from.stages !== undefined && from.roles !== undefined) config.roles = from.roles;
  if (lc.wake !== undefined) config.wake = lc.wake;
  return { exists: repo.exists || local.exists, config: repo.config || local.config ? config : null, invalid: repo.invalid || local.invalid };
}

// The effective config of a project: defaults, then the global file, then the project file.
// stages and roles come together from the same file; mode and wake are each chosen on their own. In chat-only mode `stages` and `roles`
// are the fixed chat-only ones; the task board's own stay in `taskStages` and `taskRoles`.
export function readConfig(projectDirArg) {
  const paths = configPaths(projectDirArg);
  const files = { global: readFile(paths.global), project: projectFile(paths, repoRootOf(projectDirArg) !== null) };
  const layers = ['project', 'global'].filter((s) => files[s].config);
  const pick = (has) => layers.find((s) => has(files[s].config)) || 'default';
  const modeFrom = pick((c) => c.mode !== undefined);
  const stagesFrom = pick((c) => c.stages !== undefined);
  const wakeFrom = pick((c) => c.wake !== undefined);
  const codeMapFrom = pick((c) => c.codeMap !== undefined);
  const stagesFile = stagesFrom === 'default' ? {} : files[stagesFrom].config;
  const stages = stagesFile.stages || DEFAULT_STAGES;
  const wake = wakeFrom === 'default' ? false : files[wakeFrom].config.wake;
  const codeMap = codeMapFrom === 'default' ? false : files[codeMapFrom].config.codeMap;
  const mode = modeFrom === 'default' ? 'tasks' : files[modeFrom].config.mode;
  const taskStages = stages.map((s) => ({ ...s }));
  const taskRoles = fillRoles(stagesFile.roles, stages, stages.map((s) => s.id).join() === DEFAULT_STAGES.map((s) => s.id).join());
  const chat = mode === 'chat';
  return {
    mode,
    wake,
    codeMap,
    stages: chat ? CHAT_STAGES.map((s) => ({ ...s })) : taskStages,
    roles: chat ? { ...CHAT_ROLES } : taskRoles,
    taskStages,
    taskRoles,
    source: { mode: modeFrom, stages: stagesFrom, wake: wakeFrom, codeMap: codeMapFrom },
    exists: { global: files.global.exists, project: files.project.exists },
    invalid: { global: files.global.invalid, project: files.project.invalid },
    configured: files.global.exists || files.project.exists,
    paths,
  };
}

async function writeAtomic(path, text, mode = PRIVATE_FILE) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', ...(mode === undefined ? {} : { mode }) });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Merge `patch` into one config file. A field given as null is removed from it. Roles belong
// to the stages they were chosen for, so changing stages without giving roles drops the old ones.
// A repo file is written with the normal file modes (it is committed), the others owner-only.
async function mergeIntoFile(path, label, patch, keys, { repo = false } = {}) {
  const file = readFile(path, { plain: repo });
  // Saving would silently replace what the user wrote there.
  if (file.invalid) throw new Error(`the ${label} config file is not valid (${file.invalid}); correct it by hand or reset it first`);
  const current = file.config || {};
  const merged = { ...current };
  for (const key of keys) {
    if (patch[key] === null) delete merged[key];
    else if (patch[key] !== undefined) merged[key] = patch[key];
  }
  if (patch.stages !== undefined && patch.roles === undefined) delete merged.roles;
  else if (patch.stages === undefined && isObject(patch.roles) && current.roles) merged.roles = { ...current.roles, ...patch.roles };
  const valid = validateConfig(merged);
  if (repo) await mkdir(join(path, '..'), { recursive: true });
  else await mkdirPrivate(join(path, '..'));
  await writeAtomic(path, JSON.stringify(valid, null, 2) + '\n', repo ? undefined : PRIVATE_FILE);
}

export async function saveConfig(projectDirArg, scope, patch) {
  if (!CONFIG_SCOPES.includes(scope)) throw new Error(`scope must be one of: ${CONFIG_SCOPES.join(', ')}`);
  if (!isObject(patch)) throw new Error('config changes must be an object');
  const paths = configPaths(projectDirArg);
  if (scope === 'project' && repoRootOf(projectDirArg)) {
    // mode, codeMap, stages and roles are the project's and go in the repo; wake is this machine's. A removal is made in both files, so the older
    // local value does not show through again.
    const shared = ['mode', 'codeMap', 'stages', 'roles'];
    if (shared.some((k) => patch[k] !== undefined)) await mergeIntoFile(paths.project, 'project', patch, shared, { repo: true });
    const removing = shared.some((k) => patch[k] === null) && existsSync(paths.local);
    if (patch.wake !== undefined || removing) {
      const localPatch = { wake: patch.wake, ...Object.fromEntries(shared.filter((k) => patch[k] === null).map((k) => [k, null])) };
      await mergeIntoFile(paths.local, 'project', localPatch, ['wake', ...shared]);
    }
  } else {
    await mergeIntoFile(paths[scope], scope, patch, ['mode', 'wake', 'codeMap', 'stages', 'roles']);
  }
  return readConfig(projectDirArg);
}

// Delete the scope's file.
export async function resetConfig(projectDirArg, scope) {
  if (!CONFIG_SCOPES.includes(scope)) throw new Error(`scope must be one of: ${CONFIG_SCOPES.join(', ')}`);
  const paths = configPaths(projectDirArg);
  await rm(paths[scope], { force: true });
  if (scope === 'project') await rm(paths.local, { force: true });   // a repo-backed project has the repo's file and its local one
  return readConfig(projectDirArg);
}
