// Delegation lanes: named settings (which coding CLI, which model, which effort, read-only or not)
// that come from the separate delegate skills. This module only reads them, by running the
// delegate-setup script; it never writes lane config or its approval file, and it never throws.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';

export const PROVIDERS = ['codex', 'agy', 'opencode', 'claude'];
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
const TTL_MS = 30000;
const TIMEOUT_MS = 5000;
const NONE = { available: false, projectTrusted: false, lanes: [] };

// The folder that holds delegate-setup: THREAD_DELEGATE_DIR, else the user's skills folder.
export const skillsDir = () => process.env.THREAD_DELEGATE_DIR || join(homedir(), '.claude', 'skills');

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// The result of `config.mjs load`, cut down to the lanes this plugin can show.
function parseLanes(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch { return NONE; }
  if (!data || typeof data !== 'object' || !data.lanes || typeof data.lanes !== 'object' || Array.isArray(data.lanes)) return NONE;
  const projectTrusted = data.projectTrusted === true;
  const lanes = [];
  for (const [name, l] of Object.entries(data.lanes)) {
    if (!NAME_RE.test(name) || !l || typeof l !== 'object' || !PROVIDERS.includes(l.implementer)) continue;
    const source = l.source === 'project' ? 'project' : 'global';
    // codex has a sandbox dial; a read-only sandbox makes the lane read-only
    const sandbox = l.implementer === 'codex' && SANDBOXES.includes(l.sandbox) ? l.sandbox : null;
    lanes.push({
      name,
      implementer: l.implementer,
      model: text(l.model),
      effort: text(l.effort),
      variant: text(l.variant),
      readOnly: l.readOnly === true || sandbox === 'read-only',
      sandbox,
      source,
      approved: source !== 'project' || projectTrusted,
    });
  }
  return { available: true, projectTrusted, lanes };
}

function load(projectDir, timeoutMs) {
  const script = join(skillsDir(), 'delegate-setup', 'scripts', 'config.mjs');
  return new Promise((resolve) => {
    try {
      execFile(process.execPath, [script, 'load', '--cwd', projectDir], { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true, shell: false }, (err, stdout) => {
        resolve(err ? NONE : parseLanes(String(stdout)));
      });
    } catch { resolve(NONE); }
  });
}

const cache = new Map();   // skills folder + project folder -> { at, result: Promise }
const globalCache = new Map();   // skills folder + filesystem root -> { at, result: Promise of the names of the global lanes }

export function clearLanesCache() { cache.clear(); globalCache.clear(); }

// { available, projectTrusted, lanes } for a project. `available` is false when the delegate
// skills are missing or their script fails, times out or prints something unreadable.
export async function listLanes(projectDir, { timeoutMs = TIMEOUT_MS, ttlMs = TTL_MS } = {}) {
  const key = `${skillsDir()}\0${projectDir}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.result;
  const result = load(projectDir, timeoutMs);
  cache.set(key, { at: Date.now(), result });
  return result;
}

// The lane called `name`, or an Error that says what to do.
export async function requireLane(projectDir, name) {
  const { available, lanes } = await listLanes(projectDir);
  if (!available) throw new Error('lanes need the delegate skills, which were not found; install them or leave lane out');
  const lane = lanes.find((l) => l.name === name);
  if (!lane) throw new Error(`unknown lane "${name}"; ${lanes.length ? `valid lanes: ${lanes.map((l) => l.name).join(', ')}` : 'no lanes are set up (see the delegate-setup skill)'}`);
  if (!lane.approved) throw new Error(`lane "${name}" is not approved; approve this project's lane config with the delegate-setup skill`);
  return lane;
}

// ---------------------------------------------------------------- running a thread on a lane

// How each provider's relay is asked to continue a session, and which key of its result.json holds the id to continue with.
export const RESUME = {
  codex: { flag: '--session', key: 'threadId' },
  agy: { flag: '--conversation', key: 'conversationId' },
  opencode: { flag: '--session', key: 'sessionId' },
  claude: { flag: '--session', key: 'sessionId' },
};
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// The relay script that runs a lane's provider: <skills folder>/<provider>-delegate/scripts/relay.mjs
export const relayPath = (implementer) => join(skillsDir(), `${implementer}-delegate`, 'scripts', 'relay.mjs');

// The resume id in a relay's result, or null (agy may give none). It goes into argv later, so only a plain token is taken.
export function resumeIdOf(implementer, result) {
  const spec = RESUME[implementer];
  const v = spec && result && typeof result === 'object' ? result[spec.key] : null;
  return typeof v === 'string' && SESSION_RE.test(v) ? v : null;
}

// What a thread stores of its lane: the lane as it was when the turn began, and the provider's id to continue with.
export function laneSnapshot(lane, session = null) {
  return { name: lane.name, implementer: lane.implementer, model: lane.model, effort: lane.effort, variant: lane.variant, readOnly: lane.readOnly, sandbox: lane.sandbox || null, source: lane.source, session };
}

// The lane called `name`, ready to run a thread in `mode`; otherwise an Error that says what to do.
export async function requireRunnableLane(projectDir, name, mode) {
  const lane = await requireLane(projectDir, name);
  if (!existsSync(relayPath(lane.implementer))) {
    throw new Error(`lane "${name}" runs on ${lane.implementer}, but its relay (the ${lane.implementer}-delegate skill) was not found; install it or choose another lane`);
  }
  if (mode === 'write' && lane.implementer === 'agy') throw new Error(`lane "${name}" runs on agy: agy lanes are read-only in this version`);
  if (mode === 'write' && lane.readOnly) throw new Error(`lane "${name}" is read-only; start the thread with mode "read", or choose a lane that can edit files`);
  return lane;
}

// What a lane lets a write thread do, for people to read: agy is read-only in this version (its headless mode auto-denies edits),
// a codex lane with no sandbox has full access.
export function accessText(lane) {
  if (lane.implementer === 'agy') return 'read-only (agy lanes are read-only in this version)';
  if (lane.readOnly) return 'read-only';
  return lane.sandbox === 'danger-full-access' ? 'full access (no sandbox)' : 'can edit files';
}

// Why a thread's stored lane cannot be run, or '' when it can. A thread whose lane is present but unusable must never run anything.
export function unusableLane(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return 'its lane record is not an object';
  if (typeof l.name !== 'string' || !NAME_RE.test(l.name)) return 'its lane has no valid name';
  if (!PROVIDERS.includes(l.implementer)) return `its lane runs on an unknown provider (${String(l.implementer).slice(0, 40)})`;
  if (l.session != null && (typeof l.session !== 'string' || !SESSION_RE.test(l.session))) return 'its stored session id is not usable';
  return '';
}

// The names of the global lanes, as the delegate script gives them for a folder that is in no repository (the filesystem root): a project's lane
// of the same name replaces the global one whole, so the merged list of a project cannot say which of its lanes do.
async function globalLaneNames(projectDir) {
  const root = parse(resolve(projectDir)).root;
  const key = `${skillsDir()}\0${root}`;
  const hit = globalCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const result = load(root, TIMEOUT_MS).then((r) => new Set(r.lanes.map((l) => l.name)));
  globalCache.set(key, { at: Date.now(), result });
  return result;
}

// The lanes of a project, each with whether its provider's relay is installed (the board decides from it whether a follow-up can run) and,
// for a project lane, whether it replaces a global lane of the same name (`overridesGlobal`).
export async function listLanesWithRelay(projectDir) {
  // both loads at once, so the answer takes as long as the slower one and not both; a global load that fails just leaves `overridesGlobal` out
  const [r, global] = await Promise.all([listLanes(projectDir), globalLaneNames(projectDir).catch(() => new Set())]);
  return { ...r, lanes: r.lanes.map((l) => ({ ...l, relay: existsSync(relayPath(l.implementer)), ...(l.source === 'project' && global.has(l.name) ? { overridesGlobal: true } : {}) })) };
}
