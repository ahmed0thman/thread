// The update notices: the version record and the note SessionStart adds once per update, the board's /api/update, the opt-in check
// (setting updateCheck, one GET to GitHub at most once a day) and the setting itself. Nothing here touches the network: the check is
// pointed at a server of this test on port 0 (THREAD_UPDATE_URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { McpClient, setupThreadEnv, runNode, cleanAmbientEnv, waitFor, HOOK_PATH, PARENT_SESSION, ROOT } from './helpers.mjs';
import * as core from '../server/core.mjs';
import * as update from '../server/update.mjs';
import { startBoardServer } from '../server/http.mjs';

cleanAmbientEnv();

const seenFile = (e) => path.join(e.dataDir, 'seen-version.json');
const checkFile = (e) => path.join(e.dataDir, 'update-check.json');
const readSeenFile = (e) => JSON.parse(fs.readFileSync(seenFile(e), 'utf8'));
const writeSeen = (e, o) => fs.writeFileSync(seenFile(e), JSON.stringify(o));

/** A stand-in for GitHub's releases/latest on port 0. `answer(req)` gives { status, body }; every request is kept in `hits`. */
async function fakeGitHub(t, answer) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, headers: req.headers });
    const { status = 200, body = '' } = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  return { hits, url: `http://127.0.0.1:${server.address().port}/latest` };
}

// ---------------------------------------------------------------- versions and the record

test('versions compare as numbers: 0.9.0 < 0.10.0 < 0.24.0, and something that is not x.y.z is never older', () => {
  assert.equal(update.olderVersion('0.9.0', '0.10.0'), true);
  assert.equal(update.olderVersion('0.10.0', '0.24.0'), true);
  assert.equal(update.olderVersion('0.24.0', '0.10.0'), false);
  assert.equal(update.olderVersion('0.24.0', '0.24.0'), false);
  assert.equal(update.olderVersion('1.0.0', '0.99.99'), false);
  assert.equal(update.olderVersion('unknown', '0.24.0'), false);
  assert.equal(update.olderVersion('0.24.0', undefined), false);
  assert.equal(update.cleanVersion('0.24.0'), '0.24.0');
  assert.equal(update.cleanVersion('v0.24.0'), null);
});

test('a first install records its version and announces nothing', (t) => {
  const e = setupThreadEnv(t);
  assert.deepEqual(update.announce('0.24.0'), { updated: false, updatedFrom: null, out: null });
  assert.deepEqual(readSeenFile(e), { version: '0.24.0', previous: null, latestAnnounced: null });
  assert.deepEqual(update.announce('0.24.0'), { updated: false, updatedFrom: null, out: null });
});

test('an update is announced once, and the record never goes down', (t) => {
  const e = setupThreadEnv(t);
  writeSeen(e, { version: '0.23.0' });
  assert.deepEqual(update.announce('0.24.0'), { updated: true, updatedFrom: '0.23.0', out: null });
  assert.deepEqual(readSeenFile(e), { version: '0.24.0', previous: '0.23.0', latestAnnounced: null });
  assert.deepEqual(update.announce('0.24.0'), { updated: false, updatedFrom: null, out: null }, 'only the first session after an update says it');
  // an older version running again (another window) is neither announced nor recorded
  assert.deepEqual(update.announce('0.23.0'), { updated: false, updatedFrom: null, out: null });
  assert.equal(readSeenFile(e).version, '0.24.0');
  assert.equal(readSeenFile(e).previous, '0.23.0');
  // 0.9.0 -> 0.10.0 is an update (not a string comparison)
  writeSeen(e, { version: '0.9.0' });
  assert.equal(update.announce('0.10.0').updatedFrom, '0.9.0');
});

test('a newer release is announced once per version and never a lower one', (t) => {
  const e = setupThreadEnv(t);
  writeSeen(e, { version: '0.24.0', previous: null });
  assert.deepEqual(update.announce('0.24.0', '0.25.0'), { updated: false, updatedFrom: null, out: '0.25.0' });
  assert.deepEqual(update.announce('0.24.0', '0.25.0'), { updated: false, updatedFrom: null, out: null });
  assert.deepEqual(update.announce('0.24.0', '0.24.5'), { updated: false, updatedFrom: null, out: null }, 'lower than one already announced');
  assert.deepEqual(update.announce('0.24.0', '0.26.0'), { updated: false, updatedFrom: null, out: '0.26.0' });
  assert.deepEqual(update.announce('0.26.0', '0.26.0'), { updated: true, updatedFrom: '0.24.0', out: null }, 'not out any more: it is the running version');
  assert.equal(update.announce('0.24.0', '0.24.0').out, null, 'the same version is not newer');
  assert.equal(update.announce('0.24.0', 'garbage').out, null);
  assert.equal(readSeenFile(e).latestAnnounced, '0.26.0');
});

test('nothing is announced that cannot be recorded; the files are owner-only', (t) => {
  const e = setupThreadEnv(t);
  writeSeen(e, { version: '0.23.0' });
  fs.rmSync(seenFile(e));
  fs.mkdirSync(seenFile(e));   // a folder where the file belongs: it cannot be written
  assert.deepEqual(update.announce('0.24.0', '0.25.0'), { updated: false, updatedFrom: null, out: null });
  fs.rmdirSync(seenFile(e));
  assert.equal(update.announce('0.24.0').updatedFrom, null, 'first install again: silent');
  if (process.platform !== 'win32') assert.equal(fs.statSync(seenFile(e)).mode & 0o077, 0);
});

// No released version wrote seen-version.json, so a machine upgrading to 0.24 has no record but has the data of its earlier runs.
test('a machine with no record but the data of an earlier run was updated from a version it cannot name', (t) => {
  const e = setupThreadEnv(t);
  fs.mkdirSync(path.join(e.dataDir, 'projects', 'k1'), { recursive: true });
  fs.writeFileSync(path.join(e.dataDir, 'projects', 'k1', 'state.json'), '{}');
  assert.deepEqual(update.announce('0.24.0'), { updated: true, updatedFrom: null, out: null });
  assert.deepEqual(readSeenFile(e), { version: '0.24.0', previous: null, latestAnnounced: null, fromUnknown: true });
  assert.deepEqual(update.announce('0.24.0'), { updated: false, updatedFrom: null, out: null }, 'once');
  // the next update names its source again, and the unknown source is forgotten
  assert.deepEqual(update.announce('0.25.0'), { updated: true, updatedFrom: '0.24.0', out: null });
  assert.equal('fromUnknown' in readSeenFile(e), false);
});

test('each sign of an earlier run counts: a config file, the setup hint marker, a project\'s repo record', (t) => {
  const signs = [
    (d) => fs.writeFileSync(path.join(d, 'config.json'), '{}'),
    (d) => fs.writeFileSync(path.join(d, 'setup-hint'), ''),
    (d) => { fs.mkdirSync(path.join(d, 'projects', 'k2'), { recursive: true }); fs.writeFileSync(path.join(d, 'projects', 'k2', 'repo.json'), '{}'); },
  ];
  for (const sign of signs) {
    const e = setupThreadEnv(t);
    sign(e.dataDir);
    assert.equal(update.announce('0.24.0').updated, true);
  }
});

test('a data directory with only the token or an empty projects folder is a first install: silent', (t) => {
  const e = setupThreadEnv(t);
  fs.writeFileSync(path.join(e.dataDir, 'board.token'), 'x');
  fs.mkdirSync(path.join(e.dataDir, 'projects', 'k3'), { recursive: true });
  assert.deepEqual(update.announce('0.24.0'), { updated: false, updatedFrom: null, out: null });
  assert.equal(readSeenFile(e).version, '0.24.0');
  assert.equal('fromUnknown' in readSeenFile(e), false);
});

// Sessions that start together: the record is read, compared and written under a lock.
const ONCE = path.join(ROOT, 'test', 'fixtures', 'announce-once.mjs');
async function together(e, versions, { latest } = {}) {
  const gate = String(Date.now() + 700);
  const runs = await Promise.all(versions.map((v) => runNode([ONCE, v, ...(latest ? [latest] : [])], { env: { ...process.env, THREAD_DATA_DIR: e.dataDir, THREAD_GATE_AT: gate } })));
  return runs.map((r) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); });
}

test('six sessions starting at once announce an update exactly once', async (t) => {
  for (const [label, seed] of [['unknown source', (e) => fs.writeFileSync(path.join(e.dataDir, 'config.json'), '{}')], ['known source', (e) => writeSeen(e, { version: '0.23.0' })]]) {
    const e = setupThreadEnv(t);
    seed(e);
    const out = await together(e, Array(6).fill('0.24.0'));
    assert.equal(out.filter((o) => o.updated).length, 1, label);
    assert.equal(readSeenFile(e).version, '0.24.0', label);
    assert.equal(fs.existsSync(seenFile(e) + '.lock'), false, 'the lock is released');
  }
  const first = setupThreadEnv(t);
  assert.equal((await together(first, Array(6).fill('0.24.0'))).filter((o) => o.updated).length, 0, 'a first install stays silent');
  const out = setupThreadEnv(t);
  writeSeen(out, { version: '0.24.0' });
  assert.equal((await together(out, Array(6).fill('0.24.0'), { latest: '0.25.0' })).filter((o) => o.out).length, 1, 'a newer release too');
});

test('sessions of different versions starting at once end at the highest, and a lower one never overwrites', async (t) => {
  for (let i = 0; i < 3; i++) {
    const e = setupThreadEnv(t);
    writeSeen(e, { version: '0.22.0' });
    const out = await together(e, ['0.23.0', '0.24.0', '0.23.0', '0.24.0', '0.25.0', '0.23.0']);
    assert.equal(readSeenFile(e).version, '0.25.0');
    assert.ok(out.every((o) => o.updated === false || o.updatedFrom), 'every announcement names where it came from');
  }
});

test('a lock left by a dead process is cleared', (t) => {
  const e = setupThreadEnv(t);
  writeSeen(e, { version: '0.23.0' });
  const lock = seenFile(e) + '.lock';
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(update.announce('0.24.0').updated, true, 'a stale lock is removed');
  assert.equal(fs.existsSync(lock), false);
});

// ---------------------------------------------------------------- the session note

function sessionStart(e, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, ...extraEnv };
  return runNode([HOOK_PATH, 'SessionStart'], { env, input: JSON.stringify({ cwd: e.projectDir, hook_event_name: 'SessionStart', session_id: PARENT_SESSION }), cwd: e.projectDir })
    .then((r) => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; });
}

test('SessionStart says once that the plugin was updated, and says nothing on a first install', async (t) => {
  const e = setupThreadEnv(t);
  const first = await sessionStart(e);
  assert.doesNotMatch(first, /was updated|is out/);
  assert.equal(readSeenFile(e).version, core.VERSION);
  writeSeen(e, { version: '0.1.0', previous: null });
  const note = await sessionStart(e);
  assert.ok(note.includes(`thread was updated to ${core.VERSION}. Tell the user once, in one line, and point them to the board's What's new.`), note);
  assert.deepEqual(readSeenFile(e), { version: core.VERSION, previous: '0.1.0', latestAnnounced: null });
  assert.doesNotMatch(await sessionStart(e), /was updated/, 'the second session says nothing');
  writeSeen(e, { version: '99.0.0', previous: null });
  assert.doesNotMatch(await sessionStart(e), /was updated/, 'a newer record is never announced over');
  assert.equal(readSeenFile(e).version, '99.0.0');
});

test('SessionStart says an update happened, without a version, on a machine with an earlier run and no record', async (t) => {
  const e = setupThreadEnv(t);
  fs.mkdirSync(path.join(e.dataDir, 'projects', 'k1'), { recursive: true });
  fs.writeFileSync(path.join(e.dataDir, 'projects', 'k1', 'state.json'), '{}');
  const note = await sessionStart(e);
  assert.ok(note.includes(`thread was updated to ${core.VERSION}. Tell the user once`), note);
  assert.doesNotMatch(note, /from \d/);
  assert.doesNotMatch(await sessionStart(e), /was updated/, 'once');
  // a fresh data directory: the session registers itself in the same hook, and the note still says nothing
  const f = setupThreadEnv(t);
  assert.doesNotMatch(await sessionStart(f), /was updated/);
});

test('SessionStart says a newer release is out only when the check is on, once per version', async (t) => {
  const e = setupThreadEnv(t);
  writeSeen(e, { version: core.VERSION, previous: null });
  fs.writeFileSync(checkFile(e), JSON.stringify({ at: Date.now(), latest: '99.1.0' }));
  assert.doesNotMatch(await sessionStart(e), /is out/, 'off by default: a cache alone says nothing');
  fs.writeFileSync(path.join(e.dataDir, 'config.json'), JSON.stringify({ updateCheck: true }));
  const note = await sessionStart(e);
  assert.ok(note.includes(`thread 99.1.0 is out (this is ${core.VERSION}): tell the user once and how to update`), note);
  assert.match(note, /claude plugin marketplace update thread-marketplace, then claude plugin update thread@thread-marketplace/);
  assert.doesNotMatch(await sessionStart(e), /is out/);
  fs.writeFileSync(checkFile(e), JSON.stringify({ at: Date.now(), latest: '99.2.0' }));
  assert.match(await sessionStart(e), /thread 99\.2\.0 is out/);
  fs.writeFileSync(checkFile(e), JSON.stringify({ at: Date.now(), latest: '0.0.1' }));
  assert.doesNotMatch(await sessionStart(e), /is out/, 'an older release is not out');
});

test('a side thread gets no update note and records nothing', async (t) => {
  const e = setupThreadEnv(t);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: e.projectDir, THREAD_DATA_DIR: e.dataDir, THREAD_DEPTH: '1' };
  const r = await runNode([HOOK_PATH, 'SessionStart'], { env, input: JSON.stringify({ cwd: e.projectDir, session_id: PARENT_SESSION }), cwd: e.projectDir });
  assert.equal(r.stdout, '');
  assert.equal(fs.existsSync(seenFile(e)), false);
});

// ---------------------------------------------------------------- the changelog and /api/update

test('the changelog entry is the line of that version, or null', (t) => {
  const e = setupThreadEnv(t);
  const file = path.join(e.base, 'CHANGELOG.md');
  fs.writeFileSync(file, '# Changelog\n\n- **0.24.0** A new thing. [docs](docs/x.md)\n- **0.23.0** Older.\n- **0.2.0** Much older.\n');
  assert.equal(update.changelogEntry('0.24.0', file), 'A new thing. [docs](https://github.com/ahmed0thman/thread/blob/v0.24.0/docs/x.md)'); // a repo path points at the release's tag
  assert.equal(update.changelogEntry('0.2.0', file), 'Much older.');
  assert.equal(update.changelogEntry('0.24', file), null);
  assert.equal(update.changelogEntry('0.25.0', file), null);
  assert.equal(update.changelogEntry('0.24.0', path.join(e.base, 'missing.md')), null);
  const real = update.changelogEntry(core.VERSION);
  assert.ok(real === null || real.length > 0);
  assert.ok(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').includes('- **0.23.0**'), 'the real file is where the server looks');
  assert.ok(update.changelogEntry('0.23.0'), 'the real entry is found');
});

async function getJson(b, p, headers = {}) {
  const res = await fetch(b.url.replace(/\/$/, '') + p, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('GET /api/update answers what the banners need, needs the token and reads only', async (t) => {
  const e = setupThreadEnv(t);
  const b = await startBoardServer(e.projectDir, { port: 0, token: 'ab'.repeat(16) });
  t.after(() => new Promise((r) => { b.server.closeAllConnections?.(); b.server.close(() => r()); }));
  const tok = { 'X-Thread-Token': 'ab'.repeat(16) };
  assert.equal((await getJson(b, '/api/update')).status, 401);
  // no record: nothing to announce
  assert.deepEqual((await getJson(b, '/api/update', tok)).body, { version: core.VERSION, from: null, updated: false, latest: null, notes: null, releases: update.RELEASES_URL });
  // updated: the entry of the running version comes with it
  writeSeen(e, { version: core.VERSION, previous: '0.1.0' });
  let r = (await getJson(b, '/api/update', tok)).body;
  assert.equal(r.from, '0.1.0');
  assert.equal(r.notes, update.changelogEntry(core.VERSION));
  // a record from before the hook ran (older than the running version) counts too; a newer record does not
  writeSeen(e, { version: '0.1.0', previous: null });
  assert.equal((await getJson(b, '/api/update', tok)).body.from, '0.1.0');
  writeSeen(e, { version: '99.0.0', previous: '98.0.0' });
  assert.equal((await getJson(b, '/api/update', tok)).body.from, null);
  // an update from a version that cannot be named: no `from`, but `updated`, with the entry
  writeSeen(e, { version: core.VERSION, previous: null, fromUnknown: true });
  r = (await getJson(b, '/api/update', tok)).body;
  assert.deepEqual([r.from, r.updated, r.notes], [null, true, update.changelogEntry(core.VERSION)]);
  writeSeen(e, { version: '99.0.0', previous: null, fromUnknown: true });
  assert.equal((await getJson(b, '/api/update', tok)).body.updated, false, 'a record newer than this version is not an update');
  // a newer release is shown only while the check is on
  fs.writeFileSync(checkFile(e), JSON.stringify({ at: Date.now(), latest: '99.1.0' }));
  assert.equal((await getJson(b, '/api/update', tok)).body.latest, null);
  fs.writeFileSync(path.join(e.dataDir, 'config.json'), JSON.stringify({ updateCheck: true }));
  assert.equal((await getJson(b, '/api/update', tok)).body.latest, '99.1.0');
  const post = await fetch(b.url.replace(/\/$/, '') + '/api/update', { method: 'POST', headers: { ...tok, 'content-type': 'application/json' }, body: '{}' });
  assert.notEqual(post.status, 200);
});

// ---------------------------------------------------------------- the opt-in check

test('the check asks once, reads the tag only, and does not ask again within 24 hours', async (t) => {
  const e = setupThreadEnv(t);
  const gh = await fakeGitHub(t, () => ({ body: { tag_name: 'v0.30.2', name: 'x', body: 'notes', author: { login: 'someone' } } }));
  e.setEnv('THREAD_UPDATE_URL', gh.url);
  const now = Date.now();
  assert.deepEqual(await update.runUpdateCheck('0.24.0', now), { latest: '0.30.2', asked: true });
  assert.equal(gh.hits.length, 1);
  assert.equal(gh.hits[0].headers['user-agent'], 'thread-plugin/0.24.0');
  assert.deepEqual(Object.keys(gh.hits[0].headers).filter((h) => /auth|cookie|token/i.test(h)), []);
  assert.deepEqual(update.readCheck(), { at: now, latest: '0.30.2' });
  assert.deepEqual(await update.runUpdateCheck('0.24.0', now + 23 * 3600 * 1000), { latest: '0.30.2', asked: false });
  assert.equal(gh.hits.length, 1);
  assert.equal((await update.runUpdateCheck('0.24.0', now + 25 * 3600 * 1000)).asked, true);
  assert.equal(gh.hits.length, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(checkFile(e)).mode & 0o077, 0);
});

test('a failed check is silent, is not retried within the day, and keeps the version found before', async (t) => {
  const e = setupThreadEnv(t);
  let mode = 'ok';
  const gh = await fakeGitHub(t, () => (mode === 'ok' ? { body: { tag_name: '0.30.0' } } : mode === 'status' ? { status: 500, body: 'no' } : mode === 'json' ? { body: 'not json' } : { body: { tag_name: 'latest' } }));
  e.setEnv('THREAD_UPDATE_URL', gh.url);
  const day = 25 * 3600 * 1000;
  let now = Date.now();
  assert.equal((await update.runUpdateCheck('0.24.0', now)).latest, '0.30.0');
  for (const m of ['status', 'json', 'tag']) {
    mode = m;
    now += day;
    const r = await update.runUpdateCheck('0.24.0', now);
    assert.equal(r.latest, null, m);
    assert.ok(r.error, m);
    assert.deepEqual(update.readCheck(), { at: now, latest: '0.30.0' }, `${m}: the attempt is recorded, the earlier answer kept`);
    assert.equal((await update.runUpdateCheck('0.24.0', now + 1000)).asked, false, `${m}: no retry`);
  }
  // a server that is not there at all
  now += day;
  e.setEnv('THREAD_UPDATE_URL', 'http://127.0.0.1:1/latest');
  const down = await update.runUpdateCheck('0.24.0', now);
  assert.ok(down.error);
});

test('the check never runs in a side thread, nor under THREAD_NO_HTTP unless a test gives its own address', (t) => {
  const e = setupThreadEnv(t);
  assert.equal(update.checkAllowed(), true);
  e.setEnv('THREAD_DEPTH', '1');
  assert.equal(update.checkAllowed(), false);
  e.setEnv('THREAD_DEPTH', undefined);
  e.setEnv('THREAD_NO_HTTP', '1');
  assert.equal(update.checkAllowed(), false);
  e.setEnv('THREAD_UPDATE_URL', 'http://127.0.0.1:9/x');
  assert.equal(update.checkAllowed(), true);
});

test('the MCP server runs the check in the background only when updateCheck is on', async (t) => {
  const e = setupThreadEnv(t);
  const gh = await fakeGitHub(t, () => ({ body: { tag_name: 'v99.0.0' } }));
  const env = { THREAD_UPDATE_URL: gh.url, THREAD_DATA_DIR: e.dataDir };
  // off (the default): no request, and the server is up at once
  const off = new McpClient(e, env);
  t.after(() => off.kill());
  await off.init();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gh.hits.length, 0);
  assert.equal(fs.existsSync(checkFile(e)), false);
  off.kill();
  fs.writeFileSync(path.join(e.dataDir, 'config.json'), JSON.stringify({ updateCheck: true }));
  const on = new McpClient(e, env);
  t.after(() => on.kill());
  await on.init();
  await waitFor(() => fs.existsSync(checkFile(e)) && JSON.parse(fs.readFileSync(checkFile(e), 'utf8')).latest === '99.0.0');
  assert.equal(gh.hits.length, 1);
  // a second server within the day does not ask again
  const again = new McpClient(e, env);
  t.after(() => again.kill());
  await again.init();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gh.hits.length, 1);
  // a side thread never asks, even with the setting on
  fs.rmSync(checkFile(e));
  const side = new McpClient(e, { ...env, THREAD_DEPTH: '1' });
  t.after(() => side.kill());
  await side.init();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(gh.hits.length, 1);
});

// ---------------------------------------------------------------- the setting

test('updateCheck is off by default, can be set globally or per project, and is read from this machine only', async (t) => {
  const e = setupThreadEnv(t);
  const cfg = () => core.readConfig(e.projectDir);
  assert.equal(cfg().updateCheck, false);
  assert.equal(cfg().source.updateCheck, 'default');
  await core.saveConfig(e.projectDir, 'global', { updateCheck: true });
  assert.equal(cfg().updateCheck, true);
  assert.equal(cfg().source.updateCheck, 'global');
  await core.saveConfig(e.projectDir, 'project', { updateCheck: false });
  assert.equal(cfg().updateCheck, false);
  assert.equal(cfg().source.updateCheck, 'project');
  await core.saveConfig(e.projectDir, 'project', { updateCheck: null });
  assert.equal(cfg().updateCheck, true);
  assert.throws(() => core.validateConfig({ updateCheck: 'yes' }), /updateCheck must be true or false/);
});

test('in a project kept in the repo, updateCheck stays on this machine and a committed file cannot turn it on', async (t) => {
  const e = setupThreadEnv(t);
  fs.mkdirSync(path.join(e.projectDir, '.git'));
  core.enableRepo(e.projectDir);
  await core.startRepo(e.projectDir);
  const repoCfg = core.configPaths(e.projectDir).project;
  assert.ok(repoCfg.startsWith(fs.realpathSync(e.projectDir)) || repoCfg.includes('.claude'), repoCfg);
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks', updateCheck: true });
  assert.equal(core.readConfig(e.projectDir).updateCheck, true);
  assert.doesNotMatch(fs.readFileSync(repoCfg, 'utf8'), /updateCheck/, 'never written into the repo');
  await core.saveConfig(e.projectDir, 'project', { updateCheck: null });
  assert.equal(core.readConfig(e.projectDir).updateCheck, false);
  fs.writeFileSync(repoCfg, JSON.stringify({ mode: 'tasks', updateCheck: true }));
  assert.equal(core.readConfig(e.projectDir).updateCheck, false, 'a committed file is not believed');
});

test('config_set updateCheck: true needs the user\'s yes, like wake; false and null do not', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  const code = (r) => /confirm_code "([0-9a-f]+)"/.exec(r.text)[1];
  const first = await c.call('config_set', { scope: 'global', updateCheck: true, codeMap: true });
  assert.match(first.text, /^CONFIRMATION REQUIRED\. Nothing was saved\./);
  assert.match(first.text, /api\.github\.com/);
  assert.doesNotMatch(first.text, /Waking lets/);
  assert.equal(core.readConfig(e.projectDir).updateCheck, false);
  assert.equal(core.readConfig(e.projectDir).codeMap, false, 'nothing of the call is saved');
  // a code belongs to one scope and one set of settings
  const wrongScope = await c.call('config_set', { scope: 'project', updateCheck: true, confirm_code: code(first) });
  assert.match(wrongScope.text, /^CONFIRMATION REQUIRED/);
  const both = await c.call('config_set', { scope: 'global', updateCheck: true, wake: true });
  assert.match(both.text, /Waking lets/);
  assert.match(both.text, /api\.github\.com/);
  const wakeOnly = await c.call('config_set', { scope: 'global', updateCheck: true, confirm_code: code(both) });
  assert.match(wakeOnly.text, /^CONFIRMATION REQUIRED/, 'a code for both does not turn on one');
  const ask = await c.call('config_set', { scope: 'global', updateCheck: true });
  const ok = await c.call('config_set', { scope: 'global', updateCheck: true, codeMap: true, confirm_code: code(ask) });
  assert.match(ok.text, /Saved to the global config file/);
  assert.match(ok.text, /Check GitHub once a day for a new thread release: on — from global config file/);
  assert.equal(core.readConfig(e.projectDir).updateCheck, true);
  assert.match((await c.call('config_set', { scope: 'global', updateCheck: true, confirm_code: code(ask) })).text, /^CONFIRMATION REQUIRED/, 'a code works once');
  assert.match((await c.call('config_set', { scope: 'global', updateCheck: false })).text, /Saved to the global config file/);
  assert.match((await c.call('config_set', { scope: 'global', updateCheck: null })).text, /Saved/);
  assert.equal(core.readConfig(e.projectDir).updateCheck, false);
  const bad = await c.call('config_set', { scope: 'global', updateCheck: 'yes' });
  assert.equal(bad.isError, true);
  assert.match((await c.call('config_get')).text, /Check GitHub once a day for a new thread release: off \(default\)/);
});

test('a side thread cannot change updateCheck', async (t) => {
  const e = setupThreadEnv(t);
  const c = new McpClient(e, { THREAD_DEPTH: '1' });
  t.after(() => c.kill());
  await c.init();
  const r = await c.call('config_set', { scope: 'global', updateCheck: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /side thread cannot change the plugin settings/);
});

test('the check address is built from pieces and the plugin has no other address to call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'update.mjs'), 'utf8');
  assert.doesNotMatch(src, /`[^`]*https?:\/\/[^`]*\$\{/, 'no remote address in a template literal');
  assert.match(update.RELEASES_URL, /^https:\/\/github\.com\/ahmed0thman\/thread\/releases$/);
});
