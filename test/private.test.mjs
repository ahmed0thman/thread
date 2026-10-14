// The plugin's data directory is for its owner only: folders 0700, files 0600. Modes are a POSIX idea, so these tests skip on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupThreadEnv, cleanAmbientEnv, waitFor, McpClient, PARENT_SESSION } from './helpers.mjs';
import * as core from '../server/core.mjs';

cleanAmbientEnv();

const POSIX = { skip: process.platform === 'win32' ? 'file modes do not apply on Windows' : false };
const modeOf = (p) => fs.lstatSync(p).mode & 0o777;
const octal = (p) => modeOf(p).toString(8);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  return d.isDirectory() ? [p, ...walk(p)] : d.isSymbolicLink() ? [] : [p];
});

// A data folder that does not exist yet, so the plugin creates it; umask 0 so that only the modes the plugin asks for can narrow a mode.
function freshDataDir(t, e) {
  const old = process.umask(0);
  t.after(() => process.umask(old));
  const dir = path.join(e.base, 'fresh-data');
  e.setEnv('THREAD_DATA_DIR', dir);
  return dir;
}

test('the data folder, a project folder and the state file are created owner-only', POSIX, async (t) => {
  const e = setupThreadEnv(t);
  const data = freshDataDir(t, e);
  await core.addCard(e.projectDir, { title: 'x' });
  const { dir, state } = core.projectPaths(e.projectDir);
  for (const d of [data, path.join(data, 'projects'), dir]) assert.equal(octal(d), '700', d);
  assert.equal(octal(state), '600');
  assert.equal(fs.existsSync(core.projectPaths(e.projectDir).lock), false);
});

test('a config file the plugin saves is owner-only', POSIX, async (t) => {
  const e = setupThreadEnv(t);
  const data = freshDataDir(t, e);
  await core.saveConfig(e.projectDir, 'global', { mode: 'chat' });
  assert.equal(octal(data), '700');
  assert.equal(octal(path.join(data, 'config.json')), '600');
  await core.saveConfig(e.projectDir, 'project', { mode: 'tasks' });
  assert.equal(octal(path.join(core.projectPaths(e.projectDir).dir, 'config.json')), '600');
});

test('a thread turn writes its logs, activity, heartbeat and the run files owner-only', POSIX, async (t) => {
  const e = setupThreadEnv(t);
  const data = freshDataDir(t, e);
  await core.startThread(e.projectDir, { title: 'Side job', task: 'look around', sessionId: PARENT_SESSION });
  await waitFor(() => core.readState(e.projectDir).cards[0]?.thread?.runState === 'idle', { timeout: 8000 });
  const { logs } = core.projectPaths(e.projectDir);
  const files = fs.readdirSync(logs);
  assert.ok(files.some((f) => f.endsWith('.out')) && files.some((f) => f.endsWith('.err')) && files.some((f) => f.endsWith('.activity.jsonl')), files.join());
  for (const p of walk(data)) {
    assert.equal(octal(p), fs.lstatSync(p).isDirectory() ? '700' : '600', p);
  }
});

test('tightenDataDir narrows the folders and files an older version left open, and touches nothing outside', POSIX, (t) => {
  const e = setupThreadEnv(t);
  const data = path.join(e.base, 'old-data');
  const outside = path.join(e.base, 'outside');
  fs.mkdirSync(path.join(data, 'projects', 'abc123', 'logs'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  fs.writeFileSync(path.join(data, 'projects', 'abc123', 'state.json'), '{}');
  fs.writeFileSync(path.join(data, 'projects', 'abc123', 'logs', 'c1.out'), 'x');
  fs.writeFileSync(path.join(data, 'script.sh'), 'x');
  fs.writeFileSync(path.join(data, 'config.json'), '{}');
  fs.chmodSync(path.join(data, 'config.json'), 0o644);
  fs.writeFileSync(path.join(outside, 'linked.txt'), 'x');
  fs.chmodSync(path.join(outside, 'linked.txt'), 0o644);
  fs.linkSync(path.join(outside, 'linked.txt'), path.join(data, 'projects', 'abc123', 'logs', 'c2.out'));
  fs.symlinkSync(outside, path.join(data, 'link-to-outside'));
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(data, 'link-to-file'));
  for (const p of [data, outside, path.join(data, 'projects'), path.join(data, 'projects', 'abc123'), path.join(data, 'projects', 'abc123', 'logs')]) fs.chmodSync(p, 0o755);
  for (const p of [path.join(data, 'projects', 'abc123', 'state.json'), path.join(data, 'projects', 'abc123', 'logs', 'c1.out'), path.join(outside, 'keep.txt')]) fs.chmodSync(p, 0o644);
  fs.chmodSync(path.join(data, 'script.sh'), 0o755);
  e.setEnv('THREAD_DATA_DIR', data);

  core.tightenDataDir();

  for (const d of [path.join(data, 'projects'), path.join(data, 'projects', 'abc123'), path.join(data, 'projects', 'abc123', 'logs')]) assert.equal(octal(d), '700', d);
  assert.equal(octal(path.join(data, 'projects', 'abc123', 'state.json')), '600');
  assert.equal(octal(path.join(data, 'projects', 'abc123', 'logs', 'c1.out')), '600');
  assert.equal(octal(path.join(data, 'config.json')), '600', 'the plugin\'s own top-level file');
  assert.equal(octal(data), '755', 'a folder named by THREAD_DATA_DIR is not changed itself');
  assert.equal(octal(path.join(data, 'script.sh')), '755', 'a file that is not the plugin\'s is not touched');
  assert.equal(octal(path.join(outside, 'linked.txt')), '644', 'a hard-linked file is not touched');
  assert.equal(octal(outside), '755', 'a folder behind a symlink is not touched');
  assert.equal(octal(path.join(outside, 'keep.txt')), '644', 'a file behind a symlink is not touched');
  assert.ok(fs.lstatSync(path.join(data, 'link-to-outside')).isSymbolicLink());
  // the same user still reads and writes everything
  assert.equal(fs.readFileSync(path.join(data, 'projects', 'abc123', 'state.json'), 'utf8'), '{}');
  fs.appendFileSync(path.join(data, 'projects', 'abc123', 'logs', 'c1.out'), 'y');
});

test('tightenDataDir leaves a data folder that is itself a symlink alone', POSIX, (t) => {
  const e = setupThreadEnv(t);
  const real = path.join(e.base, 'real');
  fs.mkdirSync(path.join(real, 'projects'), { recursive: true });
  fs.chmodSync(real, 0o755);
  fs.chmodSync(path.join(real, 'projects'), 0o755);
  const link = path.join(e.base, 'data-link');
  fs.symlinkSync(real, link);
  e.setEnv('THREAD_DATA_DIR', link);
  core.tightenDataDir();
  assert.equal(octal(real), '755');
  assert.equal(octal(path.join(real, 'projects')), '755');
});

test('tightenDataDir with no data folder yet does nothing and does not throw', POSIX, (t) => {
  const e = setupThreadEnv(t);
  e.setEnv('THREAD_DATA_DIR', path.join(e.base, 'not-there'));
  core.tightenDataDir();
  assert.equal(fs.existsSync(path.join(e.base, 'not-there')), false);
});

test('the MCP server tightens an existing data folder when it starts, and state written by an older version stays readable', POSIX, async (t) => {
  const e = setupThreadEnv(t);
  const { dir, state } = core.projectPaths(e.projectDir);
  await core.addCard(e.projectDir, { title: 'before' });
  for (const p of [e.dataDir, path.join(e.dataDir, 'projects'), dir]) fs.chmodSync(p, 0o755);
  fs.chmodSync(state, 0o644);
  const c = new McpClient(e);
  t.after(() => c.kill());
  await c.init();
  await waitFor(() => modeOf(dir) === 0o700 && modeOf(state) === 0o600, { timeout: 5000 });
  assert.equal(octal(path.join(e.dataDir, 'projects')), '700');
  assert.match((await c.call('board_list')).text, /before/);
});
