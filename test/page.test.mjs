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
