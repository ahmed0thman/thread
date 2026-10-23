// A board kept in the repo: the folder `.claude/thread/` at the root of the main checkout. A project is "repo-backed" when that folder
// exists. Its cards (tasks, ideas, milestones) are one file each in `cards/<id>.json`, its mode, stages and roles are `config.json`;
// everything that belongs to a machine or a session (threads, sub-agent runs, "seen" and notify marks, who asked a waiting item and whether
// it was delivered, the wake setting, logs, locks) stays in the plugin's data directory, in the project's local store. Reading joins the two;
// writing splits them again. What a repo file says about those local things is never believed: it is stripped on read, and the local
// part is restored from this machine's overlay only. The record of the one-time copy and the overlay of local fields on the repo's cards
// are the local store's repo.json, a file of its own, so state.json stays what an older plugin version wrote. Nothing here takes a lock or
// writes the local store: state.mjs does, and passes the local state in (`local.repo` is that record). Imports only fields.mjs.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { CARD_ID_SRC, answerHash, askFingerprint, criteriaCut, criteriaHash, hasCriteria } from './fields.mjs';

export const REPO_KINDS = ['task', 'idea', 'milestone'];

// The card fields that never come from a repo file and never go into one: they belong to this machine or to a session. `thread` is a local
// card altogether; `fromRepo` marks a thread that was a repo card (see mergeState).
// `approvals`: the approvals given on this machine's board; `localAnswers`: the answers given here (item id → { answeredAt, hash }, and
// `review: true` for a review item, see waits.mjs); `localLeftDoneAt`: when this machine last saw the card leave the finished stages, `localDoneAt` when it last saw it in them
// (see fields.watchFinished); `localCriteria`: how many acceptance criteria the owner's board last had on the card, and their hash;
// `allowFull`: the owner's permission, on this machine's board, for a worker of this card to run with no sandbox and no permission checks
// (like an approval it is never believed from a file: a pull must not be able to hand out full access); `allowFullHash`: a fingerprint of the card's
// title and note when it was allowed, so that a card whose text changed since (a push, Claude) needs the owner's yes again (fields.fullAllowed).
// A milestone's `dependsOn` (the links drawn by hand on the Milestones map) and `linkNames` (the names of its lines) are not here: they are shared
// fields, in the card file like `parent`. The
// owner's positions on that map are not a card field at all (see layout.mjs: this machine's data directory).
export const LOCAL_KEYS = ['seenByClaude', 'notifyId', 'notifyForRev', 'notifySession', 'notifyRequestedAt', 'notifySeenFor', 'notifyPushedFor', 'runs', 'thread', 'fromRepo', 'approvals', 'localAnswers', 'localLeftDoneAt', 'localDoneAt', 'localCriteria', 'allowFull', 'allowFullHash'];
// The local fields of a waiting item: `askedBy` (the session that asked it) and `deliveredAt`, kept per item id in the overlay (`askers`, `delivered`),
// and `fromFile`, which only the join sets (an answer that only the repo file has).
const MAX_GONE_REVIEWS = 20;
const WAIT_LOCAL_KEYS = ['askedBy', 'deliveredAt', 'fromFile'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const stamp = () => new Date().toISOString();
const isInside = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Test hooks: `afterCopyWrite(n)` runs after the n-th card file of a copy is written (a test throws there to stop the copy half way); `afterFirstLook()` runs in commitState between the first look at the disk and the writes (a test changes a file there). */
export const testHooks = { afterCopyWrite: null, afterFirstLook: null, gitRetryMs: null };

export class RepoConflictError extends Error {
  constructor(ids, why) {
    super(`${ids.length === 1 ? `card ${ids[0]}` : `cards ${ids.join(', ')}`} changed on disk while this was being saved (a git pull, or another device), ${why}; nothing was written and the file on disk was kept. Look at the card again and repeat the change.`);
    this.name = 'RepoConflictError';
    this.ids = ids;
  }
}

// ---------------------------------------------------------------- where the repo folder is

const GIT_RETRY_MS = 5000;     // a git that failed (missing, slow, locked) is asked again after this long
const rootCache = new Map();   // dir -> { root, until }  (until: ms, Infinity when the answer is certain)
const treeCache = new Map();   // root -> { list, until }
/** Forgets the git answers. A test that makes a folder a repo afterwards calls this. */
export function resetRepoCache() { rootCache.clear(); treeCache.clear(); }

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Looks for the repo `dir` is in without running git: climbs to the first `.git`. A folder is the main checkout when its `.git` is a folder; a linked
// worktree has a `.git` file that names its git dir, whose `commondir` file leads to the main one. { found: false } when there is no git above,
// { root } when the answer is certain, { found: true } when git itself has to be asked (a submodule, a separate git dir, an odd layout).
function fastRoot(dir) {
  for (let d = dir; ;) {
    const g = join(d, '.git');
    let st = null;
    try { st = lstatSync(g); } catch { /* none here */ }
    if (st) {
      if (st.isDirectory()) return { found: true, root: d };
      if (st.isFile() && st.size < 4096) {
        try {
          const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(g, 'utf8'));
          if (m) {
            const gitdir = resolve(d, m[1].trim());
            let commondir = null;
            try { commondir = readFileSync(join(gitdir, 'commondir'), 'utf8').trim(); } catch { /* none */ }
            // no commondir: this git dir belongs to this working tree alone (a submodule, a repo made with --separate-git-dir), which is then a main one
            if (commondir === null && statSync(gitdir).isDirectory()) return { found: true, root: d };
            if (commondir !== null) {
              const common = resolve(gitdir, commondir);
              if (basename(common) === '.git') return { found: true, root: dirname(common) };
            }
          }
        } catch { /* a layout git has to explain */ }
      }
      return { found: true };
    }
    const up = dirname(d);
    if (up === d) return { found: false };
    d = up;
  }
}

function git(dir, args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[k];
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
}

function gitCommonDir(dir) {
  let out;
  try { out = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']); } catch {
    out = git(dir, ['rev-parse', '--git-common-dir']);   // a git older than --path-format
  }
  return out ? resolve(dir, out) : null;
}

// The worktrees of the repo `dir` is in, main one first, from `git worktree list --porcelain`: [{ path, bare }].
function parseWorktrees(text) {
  const out = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const first = lines.find((l) => l.startsWith('worktree '));
    if (first) out.push({ path: first.slice('worktree '.length), bare: lines.some((l) => l === 'bare') });
  }
  return out;
}

/**
 * The root of the main checkout of the repo `dir` is in, as a real path (symbolic links resolved), so that a symlinked checkout, a worktree
 * and a sub-folder all find the same one. The parent of the common git dir; for a common dir that is not called .git (a submodule, a repo
 * made with --separate-git-dir) the first entry of `git worktree list`. `dir` itself (resolved) when it is not in a git repo, when git is
 * missing or fails, or when the repo is bare. A failure of git is remembered for a few seconds only, not for the whole process.
 */
export function mainCheckout(dirArg) {
  const dir = resolve(String(dirArg));
  const cached = rootCache.get(dir);
  if (cached !== undefined && cached.until > Date.now()) return cached.root;
  let root = real(dir);
  let until = Date.now() + 30000;
  try {
    const fast = fastRoot(dir);
    if (fast.root) {
      root = real(fast.root);
      until = Infinity;
    } else if (fast.found) {
      try {
        const common = gitCommonDir(dir);
        if (common && basename(common) === '.git') root = real(dirname(common));
        else if (common) root = real(mainOfOddRepo(dir, common));
        until = Infinity;
      } catch { until = Date.now() + (testHooks.gitRetryMs ?? GIT_RETRY_MS); }
    }
  } catch { /* the project folder itself */ }
  rootCache.set(dir, { root, until });
  return root;
}

// The main worktree of a repo whose common git dir is not called .git and that fastRoot could not place (a linked worktree of a repo made with
// --separate-git-dir, say): the `core.worktree` its config names, else the first entry of `git worktree list` when that is a working tree,
// else the working tree `dir` is in. The last is the known limit: git does not record where such a repo's main working tree is, so a linked
// worktree of it is a checkout of its own.
function mainOfOddRepo(dir, common) {
  try {
    const wt = git(dir, ['--git-dir', common, 'config', '--get', 'core.worktree']);
    if (wt) return resolve(common, wt);
  } catch { /* no such setting */ }
  try {
    const main = parseWorktrees(git(dir, ['worktree', 'list', '--porcelain']))[0];
    if (main && !main.bare && resolve(main.path) !== common) return main.path;
  } catch { /* fall through */ }
  return git(dir, ['rev-parse', '--show-toplevel']);
}

/** The real paths of the worktrees of the repo whose main checkout is `root` (the main one included); [] when git cannot say. */
export function worktreesOf(root) {
  const cached = treeCache.get(root);
  if (cached && cached.until > Date.now()) return cached.list;
  let list = [];
  let until = Date.now() + (testHooks.gitRetryMs ?? GIT_RETRY_MS);
  try {
    // a main checkout with a `.git` folder keeps one folder per linked worktree, each with a file that names the worktree's own .git file
    if (lstatSync(join(root, '.git')).isDirectory()) {
      list = [root];
      const wt = join(root, '.git', 'worktrees');
      for (const n of existsSync(wt) ? readdirSync(wt) : []) {
        try { list.push(real(dirname(readFileSync(join(wt, n, 'gitdir'), 'utf8').trim()))); } catch { /* a pruned one */ }
      }
    } else {
      list = parseWorktrees(git(root, ['worktree', 'list', '--porcelain'])).filter((w) => !w.bare).map((w) => real(w.path));
    }
    until = Date.now() + 30000;
  } catch { /* none known */ }
  treeCache.set(root, { list, until });
  return list;
}

export const repoFolder = (root) => join(root, '.claude', 'thread');
export const cardsFolder = (root) => join(repoFolder(root), 'cards');
export const repoConfigPath = (root) => join(repoFolder(root), 'config.json');

const isHome = (root) => { try { return root === real(homedir()); } catch { return false; } };

/**
 * Why the repo folder of `root` cannot be used, or null when it can or is not there: `.claude/thread` or `cards` that is a link (a cloned
 * repo can hold one) or leads outside the main checkout would make the plugin read and write elsewhere.
 */
export function folderProblem(root) {
  let st;
  try { st = lstatSync(repoFolder(root)); } catch { return null; }
  if (st.isSymbolicLink()) return '.claude/thread is a symbolic link';
  if (!st.isDirectory()) return '.claude/thread is not a folder';
  if (!isInside(real(repoFolder(root)), root)) return '.claude/thread leads outside the repository';
  try {
    const c = lstatSync(cardsFolder(root));
    if (c.isSymbolicLink()) return '.claude/thread/cards is a symbolic link';
    if (!c.isDirectory()) return '.claude/thread/cards is not a folder';
  } catch { /* no cards folder yet */ }
  return null;
}

/** The main checkout's root when the project is repo-backed (that root has a usable `.claude/thread/`), else null. */
export function repoRootOf(dirArg) {
  const root = mainCheckout(dirArg);
  if (isHome(root) || !isDir(repoFolder(root)) || folderProblem(root)) return null;
  return root;
}

/** Why a `.claude/thread/` folder that exists is not used (a link, outside the repository, or the home folder), or null. */
export function repoRefusal(dirArg) {
  const root = mainCheckout(dirArg);
  try { lstatSync(repoFolder(root)); } catch { return null; }
  if (isHome(root)) return 'the main checkout is your home folder (a dotfiles repository?), which every project would share';
  return folderProblem(root);
}

/** Where the project's local store is keyed from: the main checkout's root for a repo-backed project, else the project folder itself. */
export const storeRoot = (dirArg) => repoRootOf(dirArg) ?? resolve(String(dirArg));

/** Turns it on: makes the folder (with a .gitkeep, so an empty board still commits, and a .gitignore for temp files). Returns the main checkout's root. */
export function enableRepo(dirArg) {
  const root = mainCheckout(dirArg);
  if (isHome(root)) throw new Error(`the main checkout of this project is your home folder (${root}), probably a dotfiles repository: a board kept in ${repoFolder(root)} would be shared by every project under it. Turn the repo board on in a project that has a repository of its own.`);
  const problem = folderProblem(root);
  if (problem) throw new Error(`${problem}, so the board is not kept there. Remove it and turn the repo board on again.`);
  mkdirSync(cardsFolder(root), { recursive: true });
  createIfAbsent(join(cardsFolder(root), '.gitkeep'), '');
  ensureGitignore(root);
  return root;
}

// Writes `text` to `path` only when nothing is there, and never through a link: the exclusive flag makes the open fail on any existing
// name, a dangling symbolic link included (a cloned repository can carry one), so it cannot be used to create a file elsewhere.
function createIfAbsent(path, text) {
  try { writeFileSync(path, text, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

// Leftover temp files of an interrupted write must never be committed.
const GITIGNORE = '# temp files of an interrupted write\n*.tmp\n';
export function ensureGitignore(root) {
  try { createIfAbsent(join(repoFolder(root), '.gitignore'), GITIGNORE); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- reading a file safely

export const MAX_CARD_FILE = 1024 * 1024;
export const MAX_CONFIG_FILE = 256 * 1024;

/**
 * Reads a plain file without following a link and without trusting its size: { text } or { problem }. A link, a device, a pipe or a
 * file over `max` bytes is not read (a pipe is never opened, so it cannot block).
 */
export function readPlainFile(path, max, known = null) {
  let st = known;
  if (!st) try { st = lstatSync(path); } catch { return { problem: 'cannot be read' }; }
  if (!st.isFile() || st.size > max) return { problem: 'is not a plain file of an ordinary size' };
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const fs = fstatSync(fd);
    if (!fs.isFile() || fs.size > max || fs.ino !== st.ino || fs.dev !== st.dev) return { problem: 'is not a plain file of an ordinary size' };
    const buf = Buffer.alloc(fs.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { text: buf.subarray(0, off).toString('utf8'), bytes: buf.subarray(0, off), stat: fs };
  } catch { return { problem: 'cannot be read' }; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

// ---------------------------------------------------------------- a card file

const WAIT_ORDER = ['id', 'kind', 'text', 'choices', 'multi', 'askedAt', 'state', 'answer', 'comment', 'answeredAt', 'answeredVia', 'withdrawnAt'];
// Exactly the list older versions have: a key not in it sorts last, alphabetically, the same in every version (a card's file text and its
// hash are the same whichever version writes it). So a field added later, `agent` included, is not added here.
const CARD_ORDER = ['id', 'kind', 'title', 'note', 'status', 'source', 'parent', 'lane', 'type', 'priority', 'labels', 'blockedBy', 'criteria', 'waits', 'waitSeq', 'leftDoneAt', 'createdAt', 'updatedAt', 'history'];

// The keys in the order above, then any others in alphabetical order, so the same card is always the same text.
function ordered(obj, order) {
  const out = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** The text of a card file: stable key order, two spaces, a newline at the end. `shared` is a card without its local fields. */
export function cardText(shared) {
  const card = ordered(shared, CARD_ORDER);
  if (Array.isArray(card.waits)) card.waits = card.waits.map((w) => (isObject(w) ? ordered(w, WAIT_ORDER) : w));
  return JSON.stringify(card, null, 2) + '\n';
}

/**
 * The shared part of a card (what a repo file holds) and the local part: { shared, local, askers, delivered }. Neither is a copy of the
 * other. `askers` is item id → { by: the session, fp: a fingerprint of the question (askFingerprint) }; `delivered` keeps a delivery time
 * only for an item this machine's session asked: for any other the field means nothing here.
 */
export function splitCard(card) {
  const shared = {};
  const local = {};
  for (const [k, v] of Object.entries(card)) {
    if (v === undefined) continue;
    if (k === 'approvals' && isObject(v) && !Object.keys(v).length) continue;   // none: nothing to keep
    if (LOCAL_KEYS.includes(k)) local[k] = clone(v); else shared[k] = clone(v);
  }
  const askers = {};
  const delivered = {};
  if (Array.isArray(shared.waits)) {
    shared.waits = shared.waits.map((w) => {
      if (!isObject(w) || !WAIT_LOCAL_KEYS.some((k) => k in w)) return w;
      const { askedBy, deliveredAt, fromFile, ...rest } = w;
      if (typeof askedBy === 'string' && askedBy && typeof w.id === 'string') {
        askers[w.id] = { by: askedBy, fp: askFingerprint(rest) };
        if (typeof deliveredAt === 'string' && deliveredAt) delivered[w.id] = deliveredAt;
      }
      return rest;
    });
  }
  return { shared, local, askers, delivered };
}

/** What a repo file may say: the card without its local fields (a pushed file is never believed about them). A new object. */
function stripLocal(card) {
  const out = {};
  for (const [k, v] of Object.entries(card)) if (!LOCAL_KEYS.includes(k)) out[k] = v;
  if (Array.isArray(out.waits)) {
    out.waits = out.waits.map((w) => {
      if (!isObject(w)) return w;
      const { askedBy, deliveredAt, fromFile, ...rest } = w;
      return rest;
    });
  }
  return out;
}

// True when the answer in the file is the one given on this machine's board (the overlay's record of it): same time, same answer and comment.
const givenHere = (rec, w) => isObject(rec) && rec.answeredAt === w.answeredAt && rec.hash === answerHash(w);

/**
 * A repo card with this machine's overlay put back. Nothing in the file says whether the user wrote it, so a card this machine has no record
 * of (or whose record says nothing about Claude having seen it) is never "new from the user": it is `newInRepo` (a property that is not
 * listed, so it is never written anywhere), and counts as seen once it is listed. A waiting item that this machine did not ask counts as
 * delivered. An answered item whose answer was not given on this machine's board is `fromFile`, delivered or not: if this machine asked it, the
 * answer is delivered once, as information, and it never wakes a session.
 */
function joinCard(file, ov, share) {
  const card = share ? { ...file } : clone(file);   // shared: the nested parts are the cache's (frozen) and stay shared
  const has = isObject(ov);
  if (has) for (const k of LOCAL_KEYS) if (ov[k] !== undefined) card[k] = clone(ov[k]);
  if (!has || typeof ov.seenByClaude !== 'boolean') hidden(card, { newInRepo: true });
  // the approvals given on this machine's board (see waits.mjs reviewApproved); {} marks a card as one whose approvals are kept here
  if (!isObject(card.approvals)) card.approvals = {};
  if (Array.isArray(card.waits)) {
    const askers = has && isObject(ov.askers) ? ov.askers : {};
    const delivered = has && isObject(ov.delivered) ? ov.delivered : {};
    const given = isObject(card.localAnswers) ? card.localAnswers : {};
    card.waits = card.waits.map((w) => {
      if (!isObject(w) || typeof w.id !== 'string') return w;
      // asked by a session of this machine: the record names it and fingerprints the question, so an item id that another device reused for a
      // different question is not ours (a record without a fingerprint is believed as it is)
      const rec = askers[w.id];
      const by = typeof rec === 'string' ? rec : isObject(rec) && typeof rec.by === 'string' ? rec.by : null;
      const mine = by !== null && (!isObject(rec) || typeof rec.fp !== 'string' || rec.fp === askFingerprint(w));
      // an answer that was not given on this machine's board is the file's, whether or not it was delivered already
      const pushed = w.state === 'answered' && !givenHere(given[w.id], w);
      if (mine) {
        // a delivery time means something for an answered item only: a reopened one (a pull) has none, whatever the record still says
        const out = { ...w, askedBy: by, ...(w.state === 'answered' && typeof delivered[w.id] === 'string' ? { deliveredAt: delivered[w.id] } : {}) };
        if (pushed) out.fromFile = true;
        return out;
      }
      if (w.state === 'answered') return { ...w, deliveredAt: String(w.answeredAt || w.askedAt || file.updatedAt || '1970-01-01T00:00:00.000Z'), ...(pushed ? { fromFile: true } : {}) };
      return w;
    });
  }
  return card;
}

/** A fingerprint of a card's shared fields, for telling whether an older version changed it: its local fields do not count. */
export function sharedHash(card) {
  return createHash('sha1').update(cardText(splitCard(card).shared)).digest('hex').slice(0, 16);
}

const sha = (bytes) => createHash('sha1').update(bytes).digest('hex');
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

// ---------------------------------------------------------------- reading the cards folder

const CARD_FILE_RE = new RegExp(`^(${CARD_ID_SRC})\\.json$`);
const CONFLICT_RE = /^(?:<{7}|={7}|>{7})(?: |$)/m;

/** Text with git conflict markers in it. */
export const hasConflictMarkers = (text) => CONFLICT_RE.test(text);

/** Checks a parsed card against the file it came from: the problem, or null. The file's content is never quoted. */
function cardProblem(card, id) {
  if (!isObject(card)) return 'is not a JSON object';
  if (card.id !== id) return 'holds an id that does not match its file name';
  if (!REPO_KINDS.includes(card.kind)) return 'is not a task, an idea or a milestone';
  if (typeof card.title !== 'string') return 'has no title';
  return null;
}

// Parsed card files, kept for the life of the process: a file is read again only when its name, mtime, size or inode changed.
const fileCache = new Map();   // path -> { sig, entry }

function readEntry(path, id, st) {
  const read = readPlainFile(path, MAX_CARD_FILE, st);
  if (read.problem) return { problem: read.problem };
  if (hasConflictMarkers(read.text)) return { problem: 'has git merge conflict markers: resolve the conflict and commit it' };
  let card;
  try { card = JSON.parse(read.text); } catch { return { problem: 'is not valid JSON' }; }
  const problem = cardProblem(card, id);
  if (problem) return { problem };
  const stripped = deepFreeze(stripLocal(card));
  return { card: stripped, text: cardText(stripped), hash: sha(read.bytes), at: Date.parse(card.createdAt) };
}

/**
 * Reads `cards/`. Returns { cards: [{ id, card, text, hash, sig }], notices: [{ file, reason }], ids }. `ids` holds every id that has a card
 * file, readable or not. `card` is the file without its local fields; it is shared with the cache, so a caller copies it before it changes
 * anything. A file with merge conflict markers, invalid JSON or the wrong shape, a link, or one that is too big is skipped and named in
 * `notices` (by name only, never by what it holds); it is never touched.
 */
export function readRepoCards(root) {
  const dir = cardsFolder(root);
  const out = { cards: [], notices: [], ids: new Set() };
  let names;
  try { names = readdirSync(dir).sort(); } catch { return out; }
  const live = new Set();
  for (const name of names) {
    const m = CARD_FILE_RE.exec(name);
    if (!m) continue;
    const id = m[1];
    out.ids.add(id);
    const path = join(dir, name);
    live.add(path);
    const file = `.claude/thread/cards/${name}`;
    let sig;
    let st;
    try { st = lstatSync(path); sig = `${st.mtimeMs}:${st.size}:${st.ino}:${st.isFile() ? 'f' : 'x'}`; } catch { out.notices.push({ file, reason: 'cannot be read' }); continue; }
    let hit = fileCache.get(path);
    if (!hit || hit.sig !== sig) {
      hit = { sig, entry: readEntry(path, id, st) };
      fileCache.set(path, hit);
    }
    if (hit.entry.problem) out.notices.push({ file, reason: hit.entry.problem });
    else out.cards.push({ id, card: hit.entry.card, text: hit.entry.text, hash: hit.entry.hash, at: hit.entry.at, sig });
  }
  if (fileCache.size > live.size + 64) for (const p of fileCache.keys()) if (!live.has(p) && p.startsWith(dir + sep)) fileCache.delete(p);
  return out;
}

/** A cheap fingerprint of the cards folder and the repo config, for the waiter: it changes when a card file is added, removed or changed. */
export function cardsSignature(root) {
  const parts = [];
  const dir = cardsFolder(root);
  const stat = (p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}:${s.ino}`; } catch { return '-'; } };
  parts.push(stat(dir));
  try {
    for (const n of readdirSync(dir).sort()) if (CARD_FILE_RE.test(n)) parts.push(`${n}=${stat(join(dir, n))}`);
  } catch { /* no folder */ }
  parts.push(stat(repoConfigPath(root)));
  return parts.join('|');
}

// ---------------------------------------------------------------- writing

export const cardFile = (root, id) => join(cardsFolder(root), `${id}.json`);
const tempName = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);

/** Writes `text` to `path` atomically: a temp file in the same folder, then a rename. Normal file modes: repo files are not private. */
export function writeAtomicSync(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempName(path);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
}

/** Creates `path` with `text`, and only when nothing is there: false when a file appeared (it is never overwritten). */
export function createExclusiveSync(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempName(path);
  try {
    writeFileSync(tmp, text);
    try {
      linkSync(tmp, path);   // fails when the name exists, atomically
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      if (existsSync(path)) return false;   // a filesystem without hard links: the check, then the rename
      renameSync(tmp, path);
    }
    return true;
  } finally {
    try { unlinkSync(tmp); } catch { /* already renamed */ }
  }
}

// ---------------------------------------------------------------- ids

/** A new card id for a repo-backed project: `c` and 5 lowercase letters and digits with at least one of each, not in `taken`. */
export function newCardId(taken) {
  for (;;) {
    let s = '';
    for (const b of randomBytes(24)) {
      if (b < 252) s += (b % 36).toString(36);   // 252 = 7 * 36: no bias
      if (s.length === 5) break;
    }
    if (s.length === 5 && /[0-9]/.test(s) && /[a-z]/.test(s) && !taken.has(`c${s}`)) return `c${s}`;
  }
}

// ---------------------------------------------------------------- the joined state

const idOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// By creation time, then by id (shorter first). The times are parsed once, not on each comparison.
const sortCards = (cards) => cards.map((c) => ({ c, t: Date.parse(c.createdAt) })).sort((x, y) => {
  if (x.t !== y.t && Number.isFinite(x.t) && Number.isFinite(y.t)) return x.t - y.t;
  return idOrder(String(x.c.id).length, String(y.c.id).length) || idOrder(String(x.c.id), String(y.c.id));
}).map((x) => x.c);

const hidden = (obj, props) => { for (const [k, v] of Object.entries(props)) Object.defineProperty(obj, k, { value: v, enumerable: false, writable: true, configurable: true }); };

/** The cards of the local state that an older version of the plugin owns: tasks, ideas and milestones (a thread is a local card of its own). */
export function oldCards(local) {
  return (Array.isArray(local.cards) ? local.cards : []).filter((c) => isObject(c) && c.kind !== 'thread' && !c.thread && typeof c.id === 'string' && REPO_KINDS.includes(c.kind));
}

/**
 * The id a card had before the one-time copy gave it a random one → its id now; for the main store's own cards. { map, ambiguous }: an old id
 * that two of the project's own stores both had (the folder spelled two ways) names no card, since it cannot say which: it is left out of
 * `map` and listed in `ambiguous`.
 */
function aliasesOf(mark, mainKey) {
  const map = new Map();
  const ambiguous = new Set();
  const entries = isObject(mark.map) ? mark.map : {};
  const prefix = `${mainKey}:`;
  // the project's own old store, however its folder was spelled then (a symlink): other stores' ids may clash with it, so they are not aliases
  for (const [k, v] of Object.entries(entries)) {
    if (!((k.startsWith(prefix) || (isObject(v) && v.own === true)) && isObject(v) && typeof v.id === 'string')) continue;
    const old = k.slice(k.indexOf(':') + 1);
    if (ambiguous.has(old)) continue;
    if (map.has(old) && map.get(old) !== v.id) { map.delete(old); ambiguous.add(old); } else map.set(old, v.id);
  }
  return { map, ambiguous };
}

/**
 * Joins the repo's cards with the local state. `local` is the local state (a copy this call may change). Returns the state the rest of the
 * plugin works on: the repo cards with their local overlay, then the local thread cards. A thread that was started from a repo card on this
 * machine (`fromRepo` names that card's file) stands for that card and hides it; a thread that merely has the same id as a card does not:
 * both are shown, and the card tools take the card, the thread tools the thread. The cards of the local state that an older version wrote
 * for tasks, ideas and milestones are not part of it. The result also carries, not enumerable: notices (card files that could not be read,
 * and the ids that two cards share), takenIds (every id in use anywhere), repoBacked, aliases (old id → id now), ambiguousAliases (old ids
 * that name no card because two older stores of the project had them) and what commitState needs. A card has the property `newInRepo` (not
 * listed) while this machine has no record that Claude saw it.
 * `forWrite`: it also keeps what commitState compares against; a read does not need it.
 */
export function mergeState(root, local, { forWrite = false, mainKey = '' } = {}) {
  const read = readRepoCards(root);
  const mark = isObject(local.repo) ? local.repo : {};
  const overlay = isObject(mark.overlay) ? mark.overlay : {};
  const localCards = Array.isArray(local.cards) ? local.cards : [];
  const threads = localCards.filter((c) => isObject(c) && c.kind === 'thread');
  const threadById = new Map(threads.map((c) => [c.id, c]));
  const cards = [];
  const base = { shared: new Map(), parsed: new Map(), snap: new Map(), pre: new Map(), shadowed: new Set(), keepFiles: new Set(), clashes: [], repoIds: new Set(read.ids), localCards: forWrite ? clone(localCards) : localCards, root };
  for (const { id, card, text, hash, sig } of read.cards) {
    const t = threadById.get(id);
    base.parsed.set(id, card);
    base.snap.set(id, { sig, hash });
    if (t && t.fromRepo === id) { base.shadowed.add(id); continue; }   // started as a thread on this machine: the thread card stands for it here
    if (t) base.clashes.push(id);
    base.shared.set(id, text);
    const joined = joinCard(card, overlay[id], !forWrite);
    if (forWrite) base.pre.set(id, JSON.stringify(joined));
    cards.push(joined);
  }
  for (const t of threads) cards.push(t);
  const state = { ...local, cards: sortCards(cards) };
  const taken = new Set([...read.ids, ...localCards.filter(isObject).map((c) => c.id)]);
  const notices = read.notices.concat(base.clashes.map((id) => ({
    file: `.claude/thread/cards/${id}.json`, shown: true,
    reason: `has the same id as a thread on this machine; both are shown, and the card tools take the card, the thread tools the thread`,
  })));
  const al = aliasesOf(mark, mainKey);
  hidden(state, { notices, takenIds: taken, repoBacked: true, base, aliases: al.map, ambiguousAliases: [...al.ambiguous].sort() });
  return state;
}

// A three-way merge of one card: `base` is the card as this call read it, `mine` its new version, `theirs` what is on disk now. Fields
// that only one side changed take that side; the history takes both sides' new entries; waiting items merge by id; a field both sides
// changed differently is a conflict (null is returned).
const CONFLICT = Symbol('conflict');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'undefined');
const same = (a, b) => canon(a) === canon(b);
function mergeHistory(base, mine, theirs) {
  const b = Array.isArray(base) ? base : [];
  const m = Array.isArray(mine) ? mine : [];
  const t = Array.isArray(theirs) ? theirs : [];
  const grows = (x) => x.length >= b.length && same(x.slice(0, b.length), b);
  if (!grows(m) || !grows(t)) return CONFLICT;
  const merged = [...b, ...m.slice(b.length), ...t.slice(b.length)];
  merged.sort((x, y) => String(isObject(x) ? x.at : '').localeCompare(String(isObject(y) ? y.at : '')));
  return merged.slice(-50);
}
function mergeWait(bw, mw, tw) {
  if (same(mw, bw)) return tw;
  if (same(tw, bw) || same(mw, tw)) return mw;
  if (!isObject(bw) || !isObject(mw) || !isObject(tw)) return CONFLICT;
  const w = {};
  for (const k of new Set([...Object.keys(bw), ...Object.keys(mw), ...Object.keys(tw)])) {
    const v = same(mw[k], bw[k]) ? tw[k] : same(tw[k], bw[k]) || same(mw[k], tw[k]) ? mw[k] : CONFLICT;
    if (v === CONFLICT) return CONFLICT;
    if (v !== undefined) w[k] = v;
  }
  return w;
}
function mergeWaits(base, mine, theirs) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const idOf = (w) => (isObject(w) && typeof w.id === 'string' ? w.id : null);
  if ([base, mine, theirs].some((x) => arr(x).some((w) => !idOf(w)))) return CONFLICT;
  const byId = (x) => new Map(arr(x).map((w) => [idOf(w), w]));
  const [b, m, t] = [byId(base), byId(mine), byId(theirs)];
  const out = [];
  for (const id of new Set([...t.keys(), ...m.keys()])) {
    const w = mergeWait(b.get(id), m.get(id), t.get(id));
    if (w === CONFLICT) return CONFLICT;
    if (w !== undefined) out.push(w);
  }
  return out;
}
export function mergeCard(base, mine, theirs) {
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    let v;
    if (same(mine[k], base[k])) v = theirs[k];
    else if (same(theirs[k], base[k]) || same(mine[k], theirs[k])) v = mine[k];
    else if (k === 'history') v = mergeHistory(base[k], mine[k], theirs[k]);
    else if (k === 'waits') v = mergeWaits(base[k], mine[k], theirs[k]);
    else if (k === 'updatedAt') v = String(mine[k]) > String(theirs[k]) ? mine[k] : theirs[k];
    else if (k === 'waitSeq') v = Math.max(Number(mine[k]) || 0, Number(theirs[k]) || 0);
    else v = CONFLICT;
    if (v === CONFLICT) return null;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The file on disk for `id` as a write needs to see it: { exists, hash, card } (card: its shared form), or { exists: true, unreadable: true }. */
function diskNow(root, id) {
  const path = cardFile(root, id);
  try { lstatSync(path); } catch { return { exists: false }; }
  const read = readPlainFile(path, MAX_CARD_FILE);
  if (read.problem) return { exists: true, unreadable: true };
  let card;
  try { card = JSON.parse(read.text); } catch { return { exists: true, unreadable: true }; }
  if (hasConflictMarkers(read.text) || cardProblem(card, id)) return { exists: true, unreadable: true };
  return { exists: true, hash: sha(read.bytes), bytes: read.bytes, card: stripLocal(card) };
}

// Puts back what a call that failed half way had done, newest first. A file that is not what the call left (someone changed it since) is left alone.
function undo(done) {
  for (const d of done.reverse()) {
    try {
      if (d.op === 'create') {
        const now = readPlainFile(d.path, MAX_CARD_FILE);
        if (now.text === d.wrote) unlinkSync(d.path);
      } else if (d.op === 'replace') {
        const now = readPlainFile(d.path, MAX_CARD_FILE);
        if (now.text === d.wrote) writeAtomicSync(d.path, d.before.toString('utf8'));
      } else if (!existsSync(d.path)) createExclusiveSync(d.path, d.before.toString('utf8'));
    } catch { /* best effort: the next read shows what is there */ }
  }
}

const GONE_MS = 30 * 24 * 3600 * 1000;
// The overlay keeps a record per card id. One for a card whose file is gone (pulled away, another branch) is kept 30 days, in case the file comes
// back, and then dropped; the approvals in it go at once, since an approval must not outlive the file it was given for. `live` are the ids of
// the cards in the state (a new one has no file yet).
function pruneOverlay(root, overlay, fileIds, live) {
  for (const id of Object.keys(overlay)) {
    const rec = overlay[id];
    if (!isObject(rec)) { delete overlay[id]; continue; }
    // a file that a copy or an import wrote during this call is not in fileIds (read before it)
    if (fileIds.has(id) || live.has(id) || existsSync(cardFile(root, id))) { delete rec.goneAt; continue; }
    delete rec.approvals;
    if (typeof rec.goneAt !== 'string') rec.goneAt = stamp();
    else if (Date.now() - Date.parse(rec.goneAt) > GONE_MS) delete overlay[id];
  }
}

/**
 * What the state looks like in the local store after a call changed the joined `state`, writing the repo's card files on the way: a new
 * card is created (never over a file that appeared), a changed card is written when its shared text changed, a removed card's file is
 * deleted. Before any file is touched the file on disk is compared with what this call read: when it changed meanwhile (a git pull, another
 * device) the change is merged into the new content if it is clean, else the call is refused with a RepoConflictError and nothing is written.
 * A conflicted or unreadable file is never touched. Returns the new local state. The old cards of an older version stay in `cards`.
 */
export function commitState(state) {
  const { base } = state;
  const root = base.root;
  const out = { ...state };
  const mark = isObject(state.repo) ? state.repo : null;
  const overlay = isObject(mark && mark.overlay) ? mark.overlay : {};
  const live = new Set();         // ids of the repo cards in the state
  const threads = [];
  const ops = [];                 // { op: 'create' | 'replace' | 'delete', id, text, snap }
  const conflicts = [];
  for (const card of state.cards) {
    if (!isObject(card) || typeof card.id !== 'string') continue;
    if (card.kind === 'thread') { threads.push(card); continue; }
    const id = card.id;
    live.add(id);
    // the record of how many acceptance criteria the owner's board has on the card (fields.criteriaCut): refreshed while the file has at least
    // as many, kept when a pushed file cut or dropped them; the owner changing them on the board sets or clears it (core.updateCard)
    if (card.kind !== 'milestone' && hasCriteria(card) && !criteriaCut(card)) {
      const rec = card.localCriteria;
      const n = card.criteria.length;
      const hash = criteriaHash(card);
      if (!isObject(rec) || rec.n !== n || rec.hash !== hash) card.localCriteria = { n, hash };
    }
    const was = base.pre.get(id);
    if (was !== undefined && was === JSON.stringify(card)) continue;   // not changed by this call
    const { shared, local, askers, delivered } = splitCard(card);
    if (Object.keys(askers).length) local.askers = askers;
    if (Object.keys(delivered).length) local.delivered = delivered;
    // the record of answers given here is kept for the items that are still there
    if (isObject(local.localAnswers)) {
      const ids = new Set((Array.isArray(shared.waits) ? shared.waits : []).map((w) => (isObject(w) ? w.id : null)));
      // an answer to a review item that is gone from the file is kept (the done gate counts a review answered here and removed as a change,
      // see waits.reviewApproved), the newest MAX_GONE_REVIEWS of them; any other record goes with its item
      const gone = [];
      for (const k of Object.keys(local.localAnswers)) {
        if (ids.has(k)) continue;
        if (local.localAnswers[k] && local.localAnswers[k].review === true) gone.push(k); else delete local.localAnswers[k];
      }
      gone.sort((a, b) => String(local.localAnswers[b].answeredAt).localeCompare(String(local.localAnswers[a].answeredAt)));
      for (const k of gone.slice(MAX_GONE_REVIEWS)) delete local.localAnswers[k];
      if (!Object.keys(local.localAnswers).length) delete local.localAnswers;
    }
    if (Object.keys(local).length) overlay[id] = local; else delete overlay[id];
    const text = cardText(shared);
    if (base.shared.get(id) === text) continue;
    ops.push({ op: base.shared.has(id) ? 'replace' : 'create', id, text, shared });
  }
  // a removed card's file goes, and so does the file a removed thread card was hiding; a file that could not be read is never touched
  const standing = new Set(threads.filter((t) => t.fromRepo === t.id).map((t) => t.id));   // threads that stand for a repo card
  // a thread that stands for a card carries the switch itself (and only it can be taken away): the card's own copy in the record is dropped, so that
  // removing the thread later does not bring the card back with a switch the owner took away from the thread
  for (const id of standing) if (isObject(overlay[id])) { delete overlay[id].allowFull; delete overlay[id].allowFullHash; }
  // the file a thread was started from, as it was then: what decides whether removing the thread may remove the file (core.removeCard)
  for (const t of threads) {
    if (t.fromRepo !== t.id || typeof t.fromRepoHash !== 'string') continue;
    overlay[t.id] = { ...(isObject(overlay[t.id]) ? overlay[t.id] : {}), startedHash: t.fromRepoHash };
    delete t.fromRepoHash;
  }
  for (const id of base.repoIds) {
    if (live.has(id) || standing.has(id)) continue;
    // a file that could not be read now (a merge conflict, bad JSON, a link) is no card that was removed: its local record stays, and is
    // there again when the file is fixed
    if (!base.shared.has(id) && !base.shadowed.has(id)) continue;
    if ((base.shared.has(id) || base.shadowed.has(id)) && !base.keepFiles.has(id)) ops.push({ op: 'delete', id });
    if (base.keepFiles.has(id)) { if (isObject(overlay[id])) delete overlay[id].startedHash; } else delete overlay[id];
  }
  // a delivery mark is for an answered item: one that was reopened (a pull) is open again, and its next answer is a new one
  for (const card of state.cards) {
    const rec = isObject(card) && card.kind !== 'thread' ? overlay[card.id] : null;
    if (!isObject(rec) || !isObject(rec.delivered)) continue;
    const answered = new Set((Array.isArray(card.waits) ? card.waits : []).filter((w) => isObject(w) && w.state === 'answered').map((w) => w.id));
    for (const k of Object.keys(rec.delivered)) if (!answered.has(k)) delete rec.delivered[k];
    if (!Object.keys(rec.delivered).length) delete rec.delivered;
  }
  pruneOverlay(root, overlay, base.repoIds, live);
  // first look: what is on disk against what was read
  const planned = [];
  for (const o of ops) {
    const snap = base.snap.get(o.id);
    if (o.op === 'create') {
      planned.push(o);
      continue;
    }
    const now = diskNow(root, o.id);
    if (!now.exists) {
      if (o.op === 'delete') continue;   // already gone
      conflicts.push({ id: o.id, why: 'because the file was removed' });
      continue;
    }
    if (now.unreadable) { conflicts.push({ id: o.id, why: 'because the file cannot be read now' }); continue; }
    if (!snap || now.hash === snap.hash) { planned.push(o); continue; }
    if (o.op === 'delete') { conflicts.push({ id: o.id, why: 'because it was changed there' }); continue; }
    const merged = mergeCard(base.parsed.get(o.id) || {}, o.shared, now.card);
    if (!merged) { conflicts.push({ id: o.id, why: 'and the two versions change the same field' }); continue; }
    planned.push({ ...o, text: cardText(merged), hash: now.hash });
  }
  if (conflicts.length) {
    const why = conflicts.length === 1 ? conflicts[0].why : 'and they could not be merged';
    throw new RepoConflictError(conflicts.map((c) => c.id), why);
  }
  // then act, checking each file once more right before it is touched. A call that fails half way puts back what it already did, so that
  // "nothing was written" stays true: a file it created is removed, one it replaced or deleted is restored.
  if (testHooks.afterFirstLook) testHooks.afterFirstLook();
  const done = [];   // { op, path, before (the bytes it replaced or deleted), wrote (the text it wrote) }
  try {
    for (const o of planned) {
      const path = cardFile(root, o.id);
      if (o.op === 'create') {
        if (!createExclusiveSync(path, o.text)) throw new RepoConflictError([o.id], 'because a file with that name appeared');
        done.push({ op: 'create', path, wrote: o.text });
        continue;
      }
      const again = diskNow(root, o.id);
      const expect = o.hash ?? (base.snap.get(o.id) || {}).hash;
      if (!again.exists || again.unreadable || again.hash !== expect) {
        if (o.op === 'delete' && !again.exists) continue;
        throw new RepoConflictError([o.id], 'while it was being written');
      }
      if (o.op === 'delete') {
        try { unlinkSync(path); } catch { /* already gone */ }
        done.push({ op: 'delete', path, before: again.bytes });
      } else {
        writeAtomicSync(path, o.text);
        done.push({ op: 'replace', path, before: again.bytes, wrote: o.text });
      }
    }
  } catch (e) {
    undo(done);
    throw e;
  }
  // the local cards: threads (updated, or new), and the old cards of an older version as they were
  const byId = new Map(threads.map((c) => [c.id, c]));
  const used = new Set();
  const cards = [];
  for (const c of base.localCards) {
    if (isObject(c) && c.kind === 'thread') {
      if (byId.has(c.id) && !used.has(c.id)) { cards.push(byId.get(c.id)); used.add(c.id); }
      continue;
    }
    if (isObject(c) && byId.has(c.id)) continue;   // the old copy of a card that is a thread now
    cards.push(c);
  }
  for (const t of threads) if (!used.has(t.id)) cards.push(t);
  out.cards = cards;
  if (mark) out.repo = { ...mark, overlay };
  return out;
}

// ---------------------------------------------------------------- the copy from the local stores, and what an older version wrote since

/**
 * The stores a copy takes cards from: { key, label, cards, logs }, the project's own local store first (`label` is null for it), then the
 * older per-path stores of its worktrees and sub-folders. Only the tasks, ideas and milestones of each are cards for the repo.
 */
const mapKey = (src, id) => `${src}:${id}`;

function rewriteCard(c, src, idOf) {
  const card = clone(c);
  card.id = idOf(src, c.id);
  if (typeof card.parent === 'string') card.parent = idOf(src, card.parent);
  if (Array.isArray(card.blockedBy)) card.blockedBy = card.blockedBy.map((b) => (typeof b === 'string' ? idOf(src, b) : b));
  if (Array.isArray(card.dependsOn)) card.dependsOn = card.dependsOn.map((b) => (typeof b === 'string' ? idOf(src, b) : b));   // a milestone's links drawn by hand
  if (isObject(card.linkNames)) card.linkNames = Object.fromEntries(Object.entries(card.linkNames).map(([k, v]) => [idOf(src, k), v]));   // and the names of its lines
  if (Array.isArray(card.waits)) {
    card.waits = card.waits.map((w) => {
      if (!isObject(w) || typeof w.id !== 'string' || !w.id.startsWith(`${c.id}.`)) return w;
      return { ...w, id: `${card.id}${w.id.slice(c.id.length)}` };
    });
  }
  return card;
}

function overlayOf(card) {
  const { local, askers, delivered } = splitCard(card);
  // an approval the board of this machine's own old store recorded: it came from here, so it is recorded as given here
  const approvals = {};
  for (const w of Array.isArray(card.waits) ? card.waits : []) {
    if (isObject(w) && w.kind === 'review' && w.state === 'answered' && w.answeredVia === 'board' && isObject(w.answer) && w.answer.verdict === 'approve' && typeof w.answeredAt === 'string') approvals[w.id] = { answeredAt: w.answeredAt, criteria: criteriaHash(card) };
  }
  if (Object.keys(approvals).length) local.approvals = approvals;
  // an answer the old board of this machine recorded was given here, too
  const answers = {};
  for (const w of Array.isArray(card.waits) ? card.waits : []) {
    if (isObject(w) && w.state === 'answered' && typeof w.askedBy === 'string' && typeof w.answeredAt === 'string' && (w.answeredVia === 'board' || w.answeredVia === 'chat')) answers[w.id] = { answeredAt: w.answeredAt, hash: answerHash(w), ...(w.kind === 'review' ? { review: true } : {}) };
  }
  if (Object.keys(answers).length) local.localAnswers = answers;
  if (Object.keys(askers).length) local.askers = askers;
  if (Object.keys(delivered).length) local.delivered = delivered;
  // a card of this machine's own old board is known here: Claude had it before it was copied (an unseen one keeps its mark)
  if (typeof local.seenByClaude !== 'boolean') local.seenByClaude = true;
  return local;
}

const itemCard = (sources, it) => {
  const src = sources.find((s) => s.key === it.src);
  return src ? oldCards({ cards: src.cards }).find((c) => c.id === it.old) : undefined;
};

/**
 * Plans a copy of the old cards that have no entry in `repo.map` yet: gives each a new random id and records the plan (the manifest, in
 * `repo.copy`) so that a copy that is interrupted can be finished. Writes no card. `taken` holds the ids in use; returns the manifest's items.
 */
export function planCopy(repo, sources, taken) {
  const map = isObject(repo.map) ? repo.map : (repo.map = {});
  const items = [];
  for (const s of sources) {
    for (const c of oldCards({ cards: s.cards })) {
      if (map[mapKey(s.key, c.id)]) continue;
      const id = newCardId(taken);
      taken.add(id);
      items.push({ src: s.key, old: c.id, id, hash: sharedHash(c), ...(s.label === null ? { own: true } : {}) });
    }
  }
  repo.copy = { startedAt: stamp(), items };
  return items;
}

/**
 * Writes the cards of a planned copy (`repo.copy`): each one that has no file yet is created, never over a file that is there; the overlay
 * and the old-id map are set for all of them, including the ones an earlier, interrupted run wrote. The copy is over when this returns.
 * `copySnapshots(item)` is called for each card, to carry its run snapshots over to the new id.
 */
export function runCopy(root, repo, sources, { dismiss = false, copySnapshots = null } = {}) {
  const overlay = isObject(repo.overlay) ? repo.overlay : (repo.overlay = {});
  const map = isObject(repo.map) ? repo.map : (repo.map = {});
  const items = repo.copy && Array.isArray(repo.copy.items) ? repo.copy.items : [];
  const lookup = new Map(items.map((i) => [mapKey(i.src, i.old), i.id]));
  const idOf = (s, old) => lookup.get(mapKey(s, old)) ?? (isObject(map[mapKey(s, old)]) && typeof map[mapKey(s, old)].id === 'string' ? map[mapKey(s, old)].id : old);
  let written = 0;
  for (const it of items) {
    const old = itemCard(sources, it);
    if (!old) continue;   // the card went from its store meanwhile
    if (dismiss) { map[mapKey(it.src, it.old)] = { id: null, hash: it.hash }; continue; }
    const card = rewriteCard(old, it.src, idOf);
    const { shared } = splitCard(card);
    if (!existsSync(cardFile(root, it.id))) {
      if (!createExclusiveSync(cardFile(root, it.id), cardText(shared))) continue;   // a file appeared under that name: left as it is
      written += 1;
      if (testHooks.afterCopyWrite) testHooks.afterCopyWrite(written);
    }
    overlay[it.id] = overlayOf(card);
    map[mapKey(it.src, it.old)] = { id: it.id, hash: it.hash, ...(it.own ? { own: true } : {}) };
    if (copySnapshots) copySnapshots(it, old);
  }
  delete repo.copy;
  return items.filter((i) => !dismiss && isObject(map[mapKey(i.src, i.old)]) && map[mapKey(i.src, i.old)].id === i.id).length;
}

/**
 * The one-time copy, when a project becomes repo-backed: gives the task, idea and milestone cards of the local stores new random ids and
 * writes them (shared fields only) into `cards/`, unless that folder already has card files (another device's), in which case nothing is
 * copied and the local cards are left for `board_import`. Records it in `local.repo` (when, the state file's mtime and seq, the old-id map with
 * a fingerprint of each copied card, the manifest). The local stores' cards are not touched. Returns the mark, or null when it was done before.
 * This only plans: the caller saves the mark, then calls `runCopy`.
 */
export function importOnce(root, local, stateFile, sources) {
  if (isObject(local.repo) && typeof local.repo.importedAt === 'string') return null;
  let mtime = null;
  try { mtime = statSync(stateFile).mtimeMs; } catch { /* no state file yet */ }
  local.repo = { importedAt: stamp(), stateMtimeMs: mtime, stateSeq: typeof local.seq === 'number' ? local.seq : 0, copied: 0, announced: false, map: {}, overlay: {} };
  const present = readRepoCards(root);
  if (present.ids.size) {
    local.repo.skipped = true;
  } else {
    const taken = new Set([...present.ids, ...oldCards(local).map((c) => c.id), ...(Array.isArray(local.cards) ? local.cards : []).filter(isObject).map((c) => c.id)]);
    local.repo.copied = planCopy(local.repo, sources, taken).length;
  }
  return local.repo;
}

/**
 * What an older plugin version did to the local stores' old cards since the copy: [{ id, why, src, from }], why being "added" (a card that
 * was not copied) or "changed" (its shared fields differ from what was copied). `from` is the folder of an older per-path store, null for
 * the project's own. A card an older version removed is not listed. Empty before the copy was made.
 */
export function driftOf(repo, sources) {
  if (!isObject(repo) || typeof repo.importedAt !== 'string') return [];
  const map = isObject(repo.map) ? repo.map : {};
  const out = [];
  for (const s of sources) {
    for (const c of oldCards({ cards: s.cards })) {
      const e = map[mapKey(s.key, c.id)];
      if (!isObject(e)) out.push({ id: c.id, why: 'added', src: s.key, from: s.label });
      else if (e.hash !== sharedHash(c)) out.push({ id: c.id, why: 'changed', src: s.key, from: s.label });
    }
  }
  return out;
}

/**
 * `board_import`: copies the cards an older version added to the local stores (the "added" ones of driftOf) into `cards/`, with new random
 * ids, and with the same rules as the first copy. A card that was changed there is not copied over its repo version; it is reported, and not
 * mentioned again. `dismiss` copies nothing and only stops the cards from being mentioned. `save` writes the mark (the manifest goes out before
 * any card is written). Returns { copied, changed } (old card ids).
 */
export async function importDrift(root, state, sources, { dismiss = false, save, copySnapshots } = {}) {
  const repo = state.repo;
  if (!isObject(repo) || typeof repo.importedAt !== 'string') throw new Error('this project has no copy mark yet; the board has not been used since it became repo-backed');
  const drift = driftOf(repo, sources);
  const changed = [];
  const map = isObject(repo.map) ? repo.map : (repo.map = {});
  for (const d of drift) {
    if (d.why !== 'changed') continue;
    const c = oldCards({ cards: sources.find((s) => s.key === d.src).cards }).find((x) => x.id === d.id);
    map[mapKey(d.src, d.id)].hash = sharedHash(c);
    changed.push(d.id);
  }
  const added = drift.filter((d) => d.why === 'added');
  let copied = [];
  if (added.length) {
    const keep = sources.map((s) => ({ ...s, cards: oldCards({ cards: s.cards }).filter((c) => added.some((d) => d.src === s.key && d.id === c.id)) }));
    const items = planCopy(repo, keep, state.takenIds);
    if (save) await save();
    runCopy(root, repo, sources, { dismiss, copySnapshots });
    if (!dismiss) copied = items.map((i) => i.old);
    for (const i of items) if (!dismiss) state.takenIds.add(i.id);
  }
  return { copied, changed };
}

/** Finishes a copy that was interrupted: the manifest in `repo.copy` is run again for the cards that have no file yet. True when there was one. */
export function resumeCopy(root, repo, sources, opts) {
  if (!isObject(repo) || !repo.copy || !Array.isArray(repo.copy.items)) return false;
  runCopy(root, repo, sources, opts);
  return true;
}
