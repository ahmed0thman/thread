import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { SERVER_DIR } from './helpers.mjs';

const html = fs.readFileSync(path.join(SERVER_DIR, 'board.html'), 'utf8');

test('every inline script in board.html compiles', () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'no inline script found');
  blocks.forEach((code, i) => {
    try {
      new vm.Script(code);
    } catch (e) {
      assert.fail(`inline script block ${i} does not compile: ${e.message}`);
    }
  });
});

test('board.html builds the page without innerHTML-style sinks and loads nothing from the network', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!html.includes(sink), `board.html uses ${sink}`);
  }
  assert.doesNotMatch(html, /https?:\/\//);
});

// The pure token and agent helpers sit between two marker comments so they can be run without a DOM.
function pageHelpers() {
  const m = /\/\/ ---- tokens and agents[^\n]*\n([\s\S]*?)\/\/ ---- end tokens and agents ----/.exec(html);
  assert.ok(m, 'the helper block is missing from board.html');
  return vm.runInNewContext(`${m[1]}; ({ fmtTokens, turnTokens, threadTokens, tokensText, totalText, agentLabel, modelText, isBrief })`);
}

test('fmtTokens keeps three significant digits', () => {
  const { fmtTokens } = pageHelpers();
  const cases = [[0, '0'], [945, '945'], [999, '999'], [1000, '1k'], [1234, '1.23k'], [48200, '48.2k'], [99950, '100k'], [120400, '120k'], [999499, '999k'], [999500, '1M'], [1350000, '1.35M'], [12500000, '12.5M'], [250000000, '250M']];
  for (const [n, want] of cases) assert.equal(fmtTokens(n), want, String(n));
  assert.equal(fmtTokens(undefined), '0');
  assert.equal(fmtTokens(NaN), '0');
});

// objects built inside the vm have another Object prototype
const plain = (x) => JSON.parse(JSON.stringify(x));

test('thread tokens count input, cache reads and cache writes as "in" and add up over the turns that have usage', () => {
  const { turnTokens, threadTokens, tokensText, totalText } = pageHelpers();
  const a = { usage: { input: 100, cacheRead: 40000, cacheWrite: 7000, output: 1100 } };
  const b = { usage: { input: 5, cacheRead: 900, cacheWrite: 0, output: 400 } };
  assert.deepEqual(plain(turnTokens(a)), { in: 47100, out: 1100 });
  assert.equal(turnTokens({}), null);
  assert.equal(turnTokens({ usage: 'x' }), null);
  assert.equal(threadTokens([{}, {}]), null);
  assert.equal(threadTokens([]), null);
  const sum = threadTokens([a, {}, b]);
  assert.deepEqual(plain(sum), { in: 48005, out: 1500 });
  assert.equal(tokensText(sum), '48k in · 1.5k out');
  assert.equal(totalText(turnTokens(a)), '48.2k tokens');
  assert.deepEqual(plain(turnTokens({ usage: { output: 7 } })), { in: 0, out: 7 }, 'missing fields count as zero');
});

test('agent and model labels leave out what is missing and name xhigh "extra-high"', () => {
  const { agentLabel, modelText, isBrief } = pageHelpers();
  assert.equal(agentLabel({ name: 'worker', model: 'claude-sonnet-5-5', effort: 'xhigh' }), 'worker · claude-sonnet-5-5 · extra-high');
  assert.equal(agentLabel({ name: 'critic', model: null, effort: 'high' }), 'critic · high');
  assert.equal(agentLabel({ name: 'plain', model: null, effort: null }), 'plain');
  assert.equal(modelText({ model: 'claude-opus-5-5', effort: 'max' }), 'claude-opus-5-5 · max');
  assert.equal(modelText({ model: null, effort: 'low' }), 'low');
  assert.equal(modelText({ model: null, effort: null }), '');
  assert.equal(modelText({}), '');
  assert.equal(isBrief({ context: 'brief' }), true);
  assert.equal(isBrief({ context: 'full' }), false);
  assert.equal(isBrief({}), false, 'a thread without the field is an old, full one');
});

test('the start step sends context and agent, and asks for the agent list when it opens', () => {
  assert.match(html, /\{ sessionId, mode, context, agent: agent \|\| undefined \}/);
  assert.match(html, /pp\(pk, 'agents'\)/);
  assert.match(html, /'Same as session'/);
  assert.match(html, /Copies the whole session; uses far more tokens\./);
  assert.match(html, /Gets only this card’s title and note\./);
});
