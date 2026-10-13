// Board settings: chat-only or task mode, the stages and which stage the plugin itself uses.
// Two optional files with the same shape, <data dir>/config.json and <project data>/config.json.
// Imports only state.mjs.
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, projectPaths } from './state.mjs';

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

export function configPaths(projectDirArg) {
  return { global: join(dataDir(), 'config.json'), project: join(projectPaths(projectDirArg).dir, 'config.json') };
}

const logged = new Set();
function logOnce(path, message) {
  const key = `${path} ${message}`;
  if (logged.has(key)) return;
  logged.add(key);
  try { process.stderr.write(`[thread/config] ignoring ${path}: ${message}\n`); } catch { /* ignore */ }
}

// { exists, config, invalid } for one file. An unreadable or invalid file has config null and says why.
function readFile(path) {
  if (!existsSync(path)) return { exists: false, config: null, invalid: null };
  try {
    return { exists: true, config: validateConfig(JSON.parse(readFileSync(path, 'utf8'))), invalid: null };
  } catch (e) {
    logOnce(path, e.message);
    return { exists: true, config: null, invalid: String(e.message).split('\n')[0] };
  }
}

// The effective config of a project: defaults, then the global file, then the project file.
// stages and roles come together from the same file; mode is chosen on its own.
export function readConfig(projectDirArg) {
  const paths = configPaths(projectDirArg);
  const files = { global: readFile(paths.global), project: readFile(paths.project) };
  const layers = ['project', 'global'].filter((s) => files[s].config);
  const pick = (has) => layers.find((s) => has(files[s].config)) || 'default';
  const modeFrom = pick((c) => c.mode !== undefined);
  const stagesFrom = pick((c) => c.stages !== undefined);
  const stagesFile = stagesFrom === 'default' ? {} : files[stagesFrom].config;
  const stages = stagesFile.stages || DEFAULT_STAGES;
  return {
    mode: modeFrom === 'default' ? 'tasks' : files[modeFrom].config.mode,
    stages: stages.map((s) => ({ ...s })),
    roles: fillRoles(stagesFile.roles, stages, stages.map((s) => s.id).join() === DEFAULT_STAGES.map((s) => s.id).join()),
    source: { mode: modeFrom, stages: stagesFrom },
    exists: { global: files.global.exists, project: files.project.exists },
    invalid: { global: files.global.invalid, project: files.project.invalid },
    configured: files.global.exists || files.project.exists,
    paths,
  };
}

async function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// Merge `patch` into the scope's file. A field given as null is removed from it. Roles belong
// to the stages they were chosen for, so changing stages without giving roles drops the old ones.
export async function saveConfig(projectDirArg, scope, patch) {
  if (!CONFIG_SCOPES.includes(scope)) throw new Error(`scope must be one of: ${CONFIG_SCOPES.join(', ')}`);
  if (!isObject(patch)) throw new Error('config changes must be an object');
  const path = configPaths(projectDirArg)[scope];
  const file = readFile(path);
  // Saving would silently replace what the user wrote there.
  if (file.invalid) throw new Error(`the ${scope} config file is not valid (${file.invalid}); correct it by hand or reset it first`);
  const current = file.config || {};
  const merged = { ...current };
  for (const key of ['mode', 'stages', 'roles']) {
    if (patch[key] === null) delete merged[key];
    else if (patch[key] !== undefined) merged[key] = patch[key];
  }
  if (patch.stages !== undefined && patch.roles === undefined) delete merged.roles;
  else if (patch.stages === undefined && isObject(patch.roles) && current.roles) merged.roles = { ...current.roles, ...patch.roles };
  const valid = validateConfig(merged);
  await mkdir(join(path, '..'), { recursive: true });
  await writeAtomic(path, JSON.stringify(valid, null, 2) + '\n');
  return readConfig(projectDirArg);
}

// Delete the scope's file.
export async function resetConfig(projectDirArg, scope) {
  if (!CONFIG_SCOPES.includes(scope)) throw new Error(`scope must be one of: ${CONFIG_SCOPES.join(', ')}`);
  await rm(configPaths(projectDirArg)[scope], { force: true });
  return readConfig(projectDirArg);
}
