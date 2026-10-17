// The board page's Markdown subset and the clamp for long text, run in a vm against a small fake DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { FakeEl } from './helpers.mjs';
import { assembleBoardPage } from '../server/page.mjs';

const html = await assembleBoardPage();
const m = /\/\/ ---- markdown subset[^\n]*\n([\s\S]*?)\/\/ ---- end markdown subset ----/.exec(html);
assert.ok(m, 'the markdown block is missing from the board page');

function load(extra = {}) {
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createTextNode: (t) => { const e = new FakeEl(doc, '#text'); e.textContent = t; return e; } };
  doc.body = new FakeEl(doc, 'body');
  const env = {
    document: doc,
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    ...extra,
  };
  const api = vm.runInNewContext(`${m[1]}\n({ renderMarkdown, clampable, splitSteps, sectionTone, plainMd, inline })`, vm.createContext(env));
  return { api, doc };
}
// a tree as text: <p>text</p>, <ol><li>a</li></ol>
const dump = (el) => el.tagName === '#TEXT' ? el.textContent : `<${el.tagName.toLowerCase()}>${el._text}${el.children.map(dump).join('')}</${el.tagName.toLowerCase()}>`;
const all = (el, pred, out = []) => { el.children.forEach((c) => { if (pred(c)) out.push(c); all(c, pred, out); }); return out; };
const tagged = (el, tag) => all(el, (c) => c.tagName === tag.toUpperCase());
const md = (src) => dump(load().api.renderMarkdown(src)).replace(/^<div>|<\/div>$/g, '');

test('markdown: numbered steps run together in a paragraph become an ordered list', () => {
  assert.equal(md('1) App settings > Basic: add the domain 2) Facebook Login: set the URI 3) Save'), '<ol><li>App settings > Basic: add the domain</li><li>Facebook Login: set the URI</li><li>Save</li></ol>');
  assert.equal(md('Do this in order: 1. open it 2. edit it 3. save it'), '<p>Do this in order:</p><ol><li>open it</li><li>edit it</li><li>save it</li></ol>');
  assert.equal(md('Done. 1) a 2) b 3) c 4) d'), '<p>Done.</p><ol><li>a</li><li>b</li><li>c</li><li>d</li></ol>');
  assert.equal(md('Run **now**: 1) a 2) b 3) c'), '<p>Run <strong>now</strong>:</p><ol><li>a</li><li>b</li><li>c</li></ol>');
  assert.equal(md('Lead line\nsecond line: 1) a 2) b 3) c'), '<p>Lead line\nsecond line:</p><ol><li>a</li><li>b</li><li>c</li></ol>');
});

test('markdown: things that look like steps but are not stay one paragraph', () => {
  for (const text of [
    'Upgrade to v2.5 and then §7.3, about 1.5 s later 2.5 s',
    'Only one: 1) do it',
    'Two only: 1) a 2) b',
    'It took 1. 5 minutes',
    'Wrong order: 2) a 3) b 4) c',
    'Skipped: 1) a 2) b 4) d',
    'Mixed: 1) a 2. b 3) c',
    'On 12. Oct we met, on 13. Oct again, on 14. Oct once more',
    'Version1) a 2) b 3) c',
    'No punctuation first 1) a 2) b 3) c',
  ]) assert.equal(md(text), `<p>${text}</p>`, text);
  assert.equal(md('1) just one'), '<ol><li>just one</li></ol>', 'a lone numbered line is still a list');
});

test('markdown: line breaks the author wrote are kept, and real lists and code still work', () => {
  assert.equal(md('one\ntwo\n\nthree'), '<p>one\ntwo</p><p>three</p>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. a\n2. b\n3. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>');
  assert.equal(md('```\n1) x 2) y 3) z\n```'), '<pre><code>1) x 2) y 3) z</code></pre>');
});

test('clamp: the toggle shows only when the text overflows, and Show more / Show less work', () => {
  const observers = [];
  const { api, doc } = load({ ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe(el) { this.el = el; } } });
  const mk = (key) => api.clampable(doc.createElement('div'), 'wait-text', key);
  const box = mk('k1');
  const body = box.children[0], btn = box.children[1];
  assert.equal(btn.hidden, true, 'hidden until measured');
  // fits: scrollHeight equals the clamped height
  Object.assign(body, { scrollHeight: 100, clientHeight: 100 });
  observers[0].fn();
  assert.equal(btn.hidden, true);
  assert.equal(box.dataset.over, undefined);
  // overflows
  Object.assign(body, { scrollHeight: 400, clientHeight: 300 });
  observers[0].fn();
  assert.equal(btn.hidden, false);
  assert.equal(box.dataset.over, '1');
  assert.equal(btn.textContent, 'Show more');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.type, 'button');
  btn.click();
  assert.equal(box.dataset.open, '1');
  assert.equal(btn.textContent, 'Show less');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(btn.hidden, false, 'an opened box keeps its toggle');
  // a redraw of the same message comes back open
  const again = mk('k1');
  assert.equal(again.dataset.open, '1');
  assert.equal(again.children[1].hidden, false);
  assert.equal(again.children[1].textContent, 'Show less');
  btn.click();
  assert.equal(box.dataset.open, undefined);
  assert.equal(btn.textContent, 'Show more');
  assert.equal(mk('k1').dataset.open, undefined, 'closed again, so a redraw is closed');
});

const table = (rows) => `<div><table>${rows}</table></div>`;
const tr = (tag, ...cells) => `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;

test('markdown: a table with a delimiter line becomes a table, with or without outer pipes', () => {
  const want = table(`<thead>${tr('th', 'Area', 'Implication')}</thead><tbody>${tr('td', 'Ownership', 'Moves')}${tr('td', 'Docs', 'Update')}</tbody>`);
  assert.equal(md('| Area | Implication |\n|---|---|\n| Ownership | Moves |\n| Docs | Update |'), want);
  assert.equal(md('Area | Implication\n--- | ---\nOwnership | Moves\nDocs | Update'), want);
  assert.equal(md('Intro\n| Area | Implication |\n| :-- | --: |\n| Ownership | Moves |\n\nAfter'), `<p>Intro</p>${table(`<thead>${tr('th', 'Area', 'Implication')}</thead><tbody>${tr('td', 'Ownership', 'Moves')}</tbody>`)}<p>After</p>`);
});

test('markdown: table alignment comes from the delimiter line, and a row of a table ends at the first line without a pipe', () => {
  const root = load().api.renderMarkdown('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |\nplain line');
  assert.deepEqual(tagged(root, 'th').map((x) => x.className), ['al-l', 'al-c', 'al-r', '']);
  assert.deepEqual(tagged(root, 'td').map((x) => x.className), ['al-l', 'al-c', 'al-r', '']);
  assert.equal(root.children.length, 2, 'the table and the paragraph after it');
  assert.equal(root.children[0].className, 'md-table');
});

test('markdown: escaped pipes and pipes in code spans do not split a cell', () => {
  const root = load().api.renderMarkdown('| Expr | Note |\n|---|---|\n| a \\| b | x |\n| `a | b` | y |\n| ``p|q`` | z |');
  const cells = tagged(root, 'td');
  assert.deepEqual(cells.map((x) => x.textContent), ['a | b', 'x', 'a | b', 'y', 'p|q', 'z']);
  assert.equal(tagged(cells[2], 'code').length, 1);
});

test('markdown: table rows are padded or cut to the header, and cells take inline formatting', () => {
  const root = load().api.renderMarkdown('| A | B |\n|---|---|\n| only |\n| 1 | 2 | 3 |\n| **bold** | [x](https://e.com/p) |');
  assert.deepEqual(tagged(root, 'tr').map((r) => r.children.length), [2, 2, 2, 2]);
  assert.deepEqual(tagged(root, 'td').map((x) => x.textContent), ['only', '', '1', '2', 'bold', 'x']);
  assert.equal(tagged(root, 'strong').length, 1);
  assert.equal(tagged(root, 'a')[0].getAttribute('href'), 'https://e.com/p');
});

test('markdown: a line with pipes and no delimiter line under it stays a paragraph', () => {
  assert.equal(md('a | b\nc | d'), '<p>a | b\nc | d</p>');
  assert.equal(md('| a | b |\n| c | d |'), '<p>| a | b |\n| c | d |</p>');
  assert.equal(md('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |'), '<p>| a | b | c |\n|---|---|\n| 1 | 2 | 3 |</p>', 'a delimiter with another cell count is not one');
  assert.equal(md('a | b\n---'), '<p>a | b\n---</p>');
});

test('markdown: a link to http(s) is an anchor that opens a new tab; any other target is a plain reference with a tooltip', () => {
  const root = load().api.renderMarkdown('See [the docs](https://example.com/a?b=1) and [Session code](/home/dev/acme-shop/src/http/session.ts:13) and [rel](./x.md).');
  const [a] = tagged(root, 'a');
  assert.equal(a.getAttribute('href'), 'https://example.com/a?b=1');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.textContent, 'the docs');
  const refs = tagged(root, 'span');
  assert.deepEqual(refs.map((x) => x.textContent), ['Session code', 'rel']);
  assert.deepEqual(refs.map((x) => x.className), ['ref', 'ref']);
  assert.equal(refs[0].getAttribute('title'), '/home/dev/acme-shop/src/http/session.ts:13');
  assert.equal(root.textContent, 'See the docs and Session code and rel.', 'the target never shows in the text');
});

test('markdown: nothing but an http(s) URL ever becomes an href', () => {
  for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x', 'file:///etc/passwd', 'ftp://x/y', 'mailto:a@b.c', 'https://', 'http://a b']) {
    const root = load().api.renderMarkdown(`[click](${target})`);
    assert.equal(tagged(root, 'a').length, 0, target);
    assert.equal(all(root, (c) => c.getAttribute('href') !== null).length, 0, target);
  }
  assert.equal(tagged(load().api.renderMarkdown('[a](http://x.example/y)'), 'a').length, 1);
  assert.equal(tagged(load().api.renderMarkdown('Go to https://example.com/z now'), 'a').length, 0, 'a bare URL stays text');
});

test('markdown: link text keeps bold and code, and a link does not nest in a link', () => {
  const root = load().api.renderMarkdown('[**Session** `code`](/a/b.ts:1) and [[x](https://e.com)](https://f.com)');
  const ref = tagged(root, 'span').find((x) => x.className === 'ref');
  assert.equal(ref.textContent, 'Session code');
  assert.equal(tagged(ref, 'strong').length, 1);
  assert.equal(tagged(ref, 'code').length, 1);
  assert.equal(tagged(root, 'a').every((x) => tagged(x, 'a').length === 0), true);
  assert.equal(md('**[a](https://e.com)**'), '<p><strong><a>a</a></strong></p>');
});

test('markdown: a typical codex-style reply keeps its headings, bold, lists and code', () => {
  const out = md('## Findings\n\n1. **Session** is in [code](/a/b.ts:3).\n2. Second\n\n- one\n- two\n\n```\nx | y\n```');
  assert.equal(out, '<h4>Findings</h4><ol><li><strong>Session</strong> is in <span>code</span>.</li><li>Second</li></ol><ul><li>one</li><li>two</li></ul><pre><code>x | y</code></pre>');
});

test('markdown: a heading with a known section name gets its colour class, a heading level its size class', () => {
  const root = load().api.renderMarkdown('# Result\n\n### 2. Open questions\n\n#### Other thing\n\n## Not tested');
  assert.deepEqual(tagged(root, 'h4').map((x) => x.className), ['l1 tone-ok', 'l3 tone-open', 'l3', 'l1 tone-warn']);
});

test('sectionTone: section names map to a tone, ignoring case, numbers and emoji, and whole words only', () => {
  const { sectionTone } = load().api;
  const cases = {
    Decided: 'decided', Decision: 'decided', 'Decisions made': 'decided', '1. Decisions': 'decided', '2) decided:': 'decided',
    Changed: 'changed', 'Changes': 'changed', '**Changed files**': 'changed',
    Open: 'open', 'Open questions': 'open', Next: 'open', 'Next steps': 'open', 'To do': 'open', 'Follow-ups': 'open', 'follow ups': 'open', 'Todo': 'open',
    Found: 'found', Findings: 'found', 'FINDINGS': 'found',
    Risks: 'warn', Warnings: 'warn', Blockers: 'warn', 'Not covered': 'warn', 'Not tested': 'warn', 'Caveats': 'warn',
    Summary: 'ok', Result: 'ok', Done: 'ok', Verdict: 'ok', Results: '',
    Did: 'did', Happened: 'did',
    '✅ Summary': 'ok', '⚠️ Risks': 'warn', '🔎 Findings': 'found', '- Decided': 'decided',
    'Opening remarks': '', 'Nextcloud setup': '', 'Changelog': '', 'Overview': '', '': '', 'Not done yet': '', 'Decidedly': '',
  };
  for (const [text, tone] of Object.entries(cases)) assert.equal(sectionTone(text), tone, text);
});

test('markdown: a bold line that is only a section name is a heading; a bold lead on a paragraph or item gets the colour', () => {
  assert.equal(md('**Decisions**\n- a'), '<h4>Decisions</h4><ul><li>a</li></ul>');
  const root = load().api.renderMarkdown('**Decisions**\n\n**Open:**\n\n**Decided:** we use X\n\n**Whatever**\n\n**Risks** are many\n\n- **Found:** a thing');
  assert.deepEqual(tagged(root, 'h4').map((x) => x.className), ['l3 tone-decided', 'l3 tone-open']);
  assert.deepEqual(tagged(root, 'strong').map((x) => x.className), ['tone-decided', '', 'tone-warn', 'tone-found']);
  assert.deepEqual(tagged(root, 'p').map((x) => x.textContent), ['Decided: we use X', 'Whatever', 'Risks are many']);
});

test('plainMd strips the markers a one-line place would show raw', () => {
  const { plainMd } = load().api;
  assert.equal(plainMd('## Plan\n**Do** `this` [now](https://e.com) and [Session](/a/b.ts:3), __ok__'), 'Plan\nDo this now and Session, ok');
  assert.equal(plainMd('plain text, 2 * 3 and a_b_c'), 'plain text, 2 * 3 and a_b_c');
  assert.equal(plainMd(undefined), '');
});

test('inline plain mode: a link is its text, with no anchor and no span', () => {
  const { api, doc } = load();
  const el = doc.createElement('span');
  api.inline(el, 'see [**x**](https://e.com) and `c`', 'plain');
  assert.equal(el.textContent, 'see x and c');
  assert.equal(tagged(el, 'a').length + tagged(el, 'span').length, 0);
});

test('the board page has no HTML sink', () => {
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(html), false);
});
