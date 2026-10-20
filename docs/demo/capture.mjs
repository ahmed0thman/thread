// Makes docs/demo.png (four panels) and docs/demo.gif (about 20 seconds) of the board's questions-and-review loop.
//
//   node docs/demo/capture.mjs
//
// Needs Node 22+ (the built-in WebSocket client), Google Chrome (macOS path below, or set CHROME_BIN) and ffmpeg (FFMPEG_BIN,
// default /opt/homebrew/bin/ffmpeg). It is not part of `node --test`.
//
// One scripted run: it writes invented data (a fictional shop, "acme-shop") into its own THREAD_DATA_DIR, starts the real board
// server on port 0, drives the real page in headless Chrome over the DevTools protocol (real mouse events, no mock-ups) and takes
// the frames. The scratch folder is DEMO_DIR (kept) or a fresh folder under the system temp folder (removed at the end); everything it
// starts (the server, Chrome) is stopped at the end, also on an error. Writes:
//   docs/demo.png  the four panels, each with a numbered caption strip (composed by Chrome from a small HTML page)
//   docs/demo.gif  the same run as a sequence (960 px wide, or 800 when 960 does not fit under 2 MB)
//
// Harness-only touches to the page (the demo, never the board's source): the header path, which the page shows as the real folder,
// is rewritten in the DOM to ~/code/acme-shop, a small round cursor is drawn so the clicks can be seen, and a caption pill names the step in the GIF frames.
// Claude's side of the loop (the questions it asks, and the move to Done after the approval) is done through the plugin's own
// functions (server/core.mjs), the ones the MCP tools call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_PNG = path.join(ROOT, 'docs', 'demo.png');
const OUT_GIF = path.join(ROOT, 'docs', 'demo.gif');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
// the scratch folder: DEMO_DIR (kept after the run, emptied first), else a fresh folder under the system temp folder (removed at the end)
const OWN_SCRATCH = !process.env.DEMO_DIR;
const SCRATCH = process.env.DEMO_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'thread-demo-'));
const W = 1280, H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the scratch world (set before the plugin code is loaded)

if (!OWN_SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
const DATA = path.join(SCRATCH, 'data');
const PROJECT = path.join(SCRATCH, 'home', 'code', 'acme-shop');
const FRAMES = path.join(SCRATCH, 'frames');
const SHOTS = path.join(SCRATCH, 'shots');
const PROFILE = path.join(SCRATCH, 'chrome-profile');
for (const d of [DATA, PROJECT, FRAMES, SHOTS, PROFILE]) fs.mkdirSync(d, { recursive: true });
for (const k of ['THREAD_DEPTH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'THREAD_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
process.env.THREAD_DATA_DIR = DATA;
process.env.THREAD_CLAUDE_PROJECTS_DIR = path.join(SCRATCH, 'claude-projects');
process.env.THREAD_CLAUDE_BIN = path.join(ROOT, 'test', 'fake-claude.mjs');   // never the real CLI
process.env.THREAD_NO_HTTP = '1';

const core = await import(pathToFileURL(path.join(ROOT, 'server', 'core.mjs')).href);
const { startBoardServer, closeBoardServer } = await import(pathToFileURL(path.join(ROOT, 'server', 'http.mjs')).href);

const SESSION = '5c1d9e0a-3b7f-4a62-9d18-2e4f6a8b0c13';   // invented
const TOKEN = crypto.randomBytes(16).toString('hex');
const AGENT_ID = 'a3f9c2d71e4b8056';

async function seed() {
  await core.touchSession(PROJECT, SESSION, { sessionTitle: 'Shop checkout' });
  const coupon = await core.addCard(PROJECT, {
    title: 'Fix cart total with stacked coupons', status: 'in_progress', type: 'bug', priority: 'high', labels: ['checkout', 'promo'],
    note: 'Stacked coupons give a total that is a cent or two too low.',
    criteria: ['A 10% coupon and a 5 EUR coupon together give the right total', 'Totals are rounded once, at the end', 'Tests cover three or more stacked coupons'],
    worker: 'agent:worker',
  });
  const exp = await core.addCard(PROJECT, {
    title: 'Order export: date format', status: 'in_progress', type: 'task', priority: 'normal', labels: ['export'],
    note: 'The CSV export of orders needs one date format in every column.', worker: 'main',
  });
  // a sub-agent run on the coupon card, as the SubagentStart and SubagentStop hooks record it
  const at = (min) => new Date(Date.now() - min * 60000).toISOString();
  await core.updateState(PROJECT, (state) => {
    const c = core.cardById(state.cards, coupon.id);
    c.runs = [{
      n: 1, agentId: AGENT_ID, agentType: 'worker', mode: 'foreground', description: `[${coupon.id}] fix the stacked coupon total`, state: 'done', sessionId: SESSION,
      startedAt: at(34), finishedAt: at(21), ok: true, steps: 9, usage: { input: 18200, cacheRead: 61400, cacheWrite: 7300, output: 3900 }, transcript: null,
      prompt: 'Fix the cart total when two coupons are stacked. Apply the percent coupon first, round once at the end, and add tests for three stacked coupons. Do not touch the checkout UI.',
      result: 'Fixed in place in src/cart/total.ts: the percent coupon is applied first and the total is rounded once. Added tests for one, two and three stacked coupons. All 48 tests pass.',
    }];
  });
  return { coupon: coupon.id, exp: exp.id };
}

// ---------------------------------------------------------------- Chrome over the DevTools protocol

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); const w = d.id && this.waiting.get(d.id); if (w) { this.waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); } }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.waiting.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; }
  async until(expr, what, ms = 8000) { const end = Date.now() + ms; for (;;) { if (await this.eval(expr)) return; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(60); } }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); }
  mouse(type, x, y, extra = {}) { return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }); }
}

let chrome = null, server = null;
async function stopAll() {
  if (chrome) { const c = chrome; chrome = null; c.kill('SIGTERM'); await Promise.race([new Promise((r) => c.once('exit', r)), sleep(3000)]); try { c.kill('SIGKILL'); } catch { /* gone */ } }
  if (server) { const s = server; server = null; closeBoardServer(s.server); }
  if (OWN_SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
}
process.on('SIGINT', () => { stopAll().finally(() => process.exit(130)); });

async function launchChrome() {
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  assert.ok(port > 0, 'Chrome did not report a DevTools port');
  let target;
  for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch { await sleep(100); } }
  assert.ok(target, 'no Chrome page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket failed')); });
  const page = new Page(ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  return page;
}

// ---------------------------------------------------------------- the driving helpers

const q = (s) => JSON.stringify(s);
const CURSOR = `(() => { let c = document.getElementById('demo-cursor'); if (!c) { c = document.createElement('div'); c.id = 'demo-cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;margin:-12px 0 0 -12px;border-radius:50%;background:rgba(176,69,31,.12);border:2.5px solid #b0451f;z-index:99999;pointer-events:none;display:none';
  document.body.appendChild(c); } return c; })()`;
let cursor = { x: 640, y: 400 };
async function drawCursor(page, x, y, press = false) {
  cursor = { x, y };
  await page.eval(`(() => { const c = ${CURSOR}; c.style.display = 'block'; c.style.left = '${x}px'; c.style.top = '${y}px'; c.style.transform = '${press ? 'scale(.7)' : 'scale(1)'}'; })()`);
}
const hideCursor = (page) => page.eval(`(() => { const c = document.getElementById('demo-cursor'); if (c) c.style.display = 'none'; })()`);
// the page shows the real folder; the demo shows a neutral one. The caption is the step's name, drawn in the header's empty space (GIF only).
async function dress(page, caption) {
  await page.eval(`(() => {
    const h = document.getElementById('dir-head'), t = document.getElementById('dir-tail'), d = document.getElementById('dir');
    if (h) h.textContent = '~/code'; if (t) t.textContent = '/acme-shop'; if (d) d.title = '~/code/acme-shop';
    let c = document.getElementById('demo-caption');
    if (!c) { c = document.createElement('div'); c.id = 'demo-caption';
      c.style.cssText = 'position:fixed;top:14px;left:640px;z-index:99998;pointer-events:none;font:600 14px/1 -apple-system,system-ui,sans-serif;color:#fff;background:#2b2a27;padding:9px 14px 9px 9px;border-radius:999px;display:none;align-items:center;gap:9px;white-space:nowrap';
      document.body.appendChild(c); }
    const cap = ${q(caption || null)};
    if (cap) { c.replaceChildren(); const n = document.createElement('span'); n.textContent = cap[0];
      n.style.cssText = 'background:#b0451f;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:13px';
      c.append(n, cap[1]); c.style.display = 'flex'; } else c.style.display = 'none';
  })()`);
}
const frames = [];   // { file, dur } in seconds
let nFrame = 0;
let caption = null;
async function frame(page, dur) {
  await dress(page, caption);
  const file = path.join(FRAMES, `f${String(++nFrame).padStart(3, '0')}.png`);
  await page.shot(file);
  frames.push({ file, dur });
}
// a shot for the four-panel image: no caption pill, no cursor unless `keepCursor`
async function panelShot(page, name, keepCursor) {
  if (!keepCursor) await hideCursor(page);
  await dress(page, null);
  const file = path.join(SHOTS, name);
  await page.shot(file);
  return file;
}
async function centerOf(page, sel, text, corner) {
  const r = await page.eval(`(() => { const all = [...document.querySelectorAll(${q(sel)})]; const el = ${text ? `all.find((e) => e.textContent.trim().startsWith(${q(text)}))` : 'all[0]'};
    if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return ${corner ? '{ x: b.right - 12, y: b.bottom - 6 }' : '{ x: b.left + b.width / 2, y: b.top + b.height / 2 }'}; })()`);
  assert.ok(r, 'element not found: ' + sel + (text ? ' ' + text : ''));
  return r;
}
// Move the cursor to the point in three steps (frames of the movement are kept when `trail`), moving the real mouse too.
async function glideTo(page, to, trail) {
  const from = cursor;
  for (let i = 1; i <= 3; i++) {
    const x = from.x + (to.x - from.x) * (i / 3), y = from.y + (to.y - from.y) * (i / 3);
    await drawCursor(page, x, y);
    await page.mouse('mouseMoved', x, y, { button: 'none', clickCount: 0 });
    if (trail && i < 3) await frame(page, 0.12);
  }
}
async function press(page, to) {
  await drawCursor(page, to.x, to.y, true);
  await page.mouse('mousePressed', to.x, to.y);
  await page.mouse('mouseReleased', to.x, to.y);
}
// Glide to an element and click it with real mouse events; `hold` stops at the hover (nothing pressed).
async function click(page, sel, { text, afterDur = 0.35, hold = false, corner = false } = {}) {
  const to = await centerOf(page, sel, text, corner);   // `corner`: the button's lower right, so the cursor does not cover its label
  await glideTo(page, to, true);
  if (hold) return to;
  await press(page, to);
  await sleep(250);
  if (afterDur) await frame(page, afterDur);
  await drawCursor(page, to.x, to.y, false);
  return to;
}

// ---------------------------------------------------------------- the run

async function run() {
  const ids = await seed();
  const w1 = await core.addWait(PROJECT, { card: ids.coupon, kind: 'review', text: 'Fix in place, tests pass; approve or request changes', sessionId: SESSION, worker: 'agent:worker' });
  const w2 = await core.addWait(PROJECT, { card: ids.exp, kind: 'choice', text: "Which date format: ISO 8601 or the shop's locale?", choices: ['ISO 8601 (2026-10-14)', 'Shop locale (14/10/2026)'], sessionId: SESSION, worker: 'main' });
  // the loop is real: before an approval Claude may not move the card to Done (the tool's own refusal; it is a tool answer, not a screen)
  await assert.rejects(core.updateCard(PROJECT, ids.coupon, { status: 'done' }, { source: 'claude' }), /approv/i, 'Claude must not be able to finish the card before the approval');

  server = await startBoardServer(PROJECT, { port: 0, token: TOKEN });
  const key = core.projectKey(PROJECT);
  const page = await launchChrome();
  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + server.port + '/?t=' + TOKEN + '#/' + key + '/waiting' });
  const cardSel = (id) => `.card[data-id="${id}"]`;
  await page.until(`!!document.querySelector(${q(cardSel(ids.coupon))}) && !!document.querySelector(${q(cardSel(ids.exp))})`, 'the two cards', 10000);
  await page.eval(`(() => { try { localStorage.clear(); } catch (e) {} })()`);
  await sleep(800);
  // headless Chrome has no address bar; check the page itself shows no token either
  const shows = await page.eval(`document.body.innerText.includes(${q(TOKEN)}) || location.href.includes(${q(TOKEN)})`);

  // 1. Claude asks on the board
  caption = ['1', 'Claude asks on the board'];
  await frame(page, 3.0);
  const p1 = await panelShot(page, 'p1.png');

  // 2. answer both on their cards' pages (the choice first, then the review), then one Send for both
  caption = ['2', 'Answer both, press Send once'];
  await click(page, cardSel(ids.exp));
  await page.until(`!!document.querySelector('[data-wid="${w2.item.id}"]')`, 'the export card page');
  await sleep(300);
  await frame(page, 1.1);
  await click(page, `[data-wid="${w2.item.id}"] input[type=radio]`, { afterDur: 0.9 });   // the first option, ISO 8601
  await page.until(`!document.getElementById('send-bar').hidden`, 'the send bar');
  await click(page, 'button', { text: 'Back to', afterDur: 0.2 });
  await page.until(`!!document.querySelector(${q(cardSel(ids.coupon))})`, 'the Waiting view again');
  await click(page, cardSel(ids.coupon));
  await page.until(`!!document.querySelector('[data-wid="${w1.item.id}"]')`, 'the coupon card page');
  await sleep(300);
  await frame(page, 1.0);
  await click(page, `[data-wid="${w1.item.id}"] input[type=radio]`, { afterDur: 0.5 });   // the first one is Approve
  await page.until(`document.getElementById('send-btn').textContent === 'Send 2 answers'`, 'two drafts');
  await sleep(200);
  const to = await click(page, '#send-btn', { hold: true, corner: true });   // hover, not pressed yet
  await sleep(250);
  await frame(page, 2.8);
  const p2 = await panelShot(page, 'p2.png', true);
  await press(page, to);
  await page.until(`document.getElementById('send-bar').hidden && !document.querySelector('[data-wid="${w1.item.id}"].wait-item')`, 'the answers to be sent', 10000);
  await drawCursor(page, to.x, to.y, false);
  // the session's next prompt carries the answers to it (the UserPromptSubmit hook's own function marks them delivered)
  const delivered = await core.deliverWaitAnswers(PROJECT, SESSION);
  assert.equal(delivered.length, 2);
  await page.until(`document.body.innerText.includes('delivered') && !document.body.innerText.includes('not yet delivered')`, 'the delivered mark', 10000);
  await sleep(300);
  await hideCursor(page);

  // 3. the answers are on the card: the review answered "Approved" on the coupon card's page, then its criteria and history
  caption = ['3', 'The answers are on the cards'];
  const cc = core.readState(PROJECT).cards.find((c) => c.id === ids.coupon);
  assert.equal(cc.waits[0].answer.verdict, 'approve');
  await frame(page, 2.8);
  const p3 = await panelShot(page, 'p3.png');
  const scrollTo = (y) => page.eval(`[...document.querySelectorAll('.scroller')].forEach((e) => { e.scrollTop = ${y}; })`);
  await scrollTo(480);
  await sleep(250);
  await frame(page, 1.2);
  await scrollTo(100000);
  await sleep(250);
  await frame(page, 1.2);
  await scrollTo(0);

  // 4. Claude moves the card to Done (what board_update does, source "claude"): the approval is there, so the gate lets it through
  caption = ['4', 'Done only after approval'];
  await core.updateCard(PROJECT, ids.coupon, { status: 'done', worker: 'main' }, { source: 'claude' });
  await click(page, 'button', { text: 'Back to', afterDur: 0.2 });
  await click(page, 'a.vtab[data-view="board"]', { afterDur: 0.2 });
  const inDone = (id) => `(() => { const c = document.querySelector(${q(cardSel(id))}); const col = c && c.closest('.col, section, [data-status]'); return !!col && /^\\s*done/i.test(col.textContent); })()`;
  await page.until(inDone(ids.coupon), 'the coupon card in Done', 10000);
  assert.equal(await page.eval(inDone(ids.exp)), false);
  assert.equal(await page.eval(`document.body.innerText.includes('not verified')`), false, 'the coupon card must show no "not verified" mark');
  await hideCursor(page);
  await sleep(300);
  await frame(page, 3.0);
  const p4 = await panelShot(page, 'p4.png');

  await composePng(page, [p1, p2, p3, p4]);
  return { shows, ids };
}

// ---------------------------------------------------------------- the four-panel image (a small HTML page, rendered by the same Chrome)

const CAPTIONS = ['Claude asks on the board', 'Answer both, press Send once', 'The answers are on the cards', 'Done only after approval'];
// the part of each 1280x800 shot that matters: x, y, width, height
const CROPS = [[0, 0, 1000, 625], [0, 112, 1100, 688], [0, 0, 935, 584], [440, 205, 840, 525]];
async function composePng(page, shots) {
  const CW = 800, CH = 500, GAP = 20, BAR = 46;
  const cell = (file, i) => {
    const [x, y, w, h] = CROPS[i];
    const k = Math.min(CW / w, CH / h);
    return `<figure><figcaption><b>${i + 1}</b><span>${CAPTIONS[i]}</span></figcaption>
      <div class="img"><img src="${pathToFileURL(file).href}" style="width:${W * k}px;left:${-x * k}px;top:${-y * k}px"></div></figure>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { width: ${CW * 2 + GAP * 3}px; padding: ${GAP}px; background: #e9e5dc; display: grid; grid-template-columns: ${CW}px ${CW}px; gap: ${GAP}px; font-family: -apple-system, system-ui, sans-serif; }
    figure { width: ${CW}px; border-radius: 10px; overflow: hidden; background: #faf8f4; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
    figcaption { height: ${BAR}px; background: #2b2a27; color: #fff; display: flex; align-items: center; gap: 12px; padding: 0 16px; font-size: 19px; font-weight: 600; }
    figcaption b { background: #b0451f; border-radius: 50%; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; }
    .img { position: relative; width: ${CW}px; height: ${CH}px; overflow: hidden; background: #faf8f4; }
    img { position: absolute; display: block; }
  </style>${shots.map(cell).join('')}`;
  const file = path.join(SHOTS, 'compose.html');
  fs.writeFileSync(file, html);
  const wide = CW * 2 + GAP * 3, tall = (BAR + CH) * 2 + GAP * 3;
  await page.send('Emulation.setDeviceMetricsOverride', { width: wide, height: tall, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: pathToFileURL(file).href });
  await page.until(`document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`, 'the panels to load');
  await sleep(300);
  await page.shot(OUT_PNG);
}

// ---------------------------------------------------------------- the GIF (ffmpeg, with a palette pass)

function makeGif(width) {
  const FPS = 8;
  const list = frames.map((f) => `file '${f.file}'\nduration ${f.dur}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`;   // a file must follow the last duration for it to count
  const listFile = path.join(SCRATCH, 'frames.txt');
  fs.writeFileSync(listFile, list);
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf',
    `fps=${FPS},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`, '-t', String(frames.reduce((n, f) => n + f.dur, 0)), '-loop', '0', OUT_GIF]);   // -t: the concat demuxer holds the last frame twice as long
  return fs.statSync(OUT_GIF).size;
}

// ---------------------------------------------------------------- go

try {
  const r = await run();
  const seconds = frames.reduce((n, f) => n + f.dur, 0);
  let width = 960, size = makeGif(width);
  if (size > 2 * 1024 * 1024) { width = 800; size = makeGif(width); }
  console.log(`frames: ${frames.length}, about ${seconds.toFixed(1)} s, GIF ${width} px wide ${size} bytes, PNG ${fs.statSync(OUT_PNG).size} bytes, token on the page: ${r.shows}`);
  assert.equal(r.shows, false, 'the token must not be shown on the page');
} finally {
  await stopAll();
}
