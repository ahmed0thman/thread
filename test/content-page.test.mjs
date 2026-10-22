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
  const timers = [];
  const doc = { activeElement: null, createElement: (tag) => new FakeEl(doc, tag), createElementNS: (ns, tag) => new FakeEl(doc, tag), createTextNode: (t) => { const e = new FakeEl(doc, '#text'); e.textContent = t; return e; } };
  doc.body = new FakeEl(doc, 'body');
  const env = {
    document: doc,
    navigator: {},
    URL,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    h(tag, cls, text) { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; },
    ...extra,
  };
  const api = vm.runInNewContext(`${m[1]}\n({ renderMarkdown, clampable, splitSteps, sectionTone, plainMd, inline, copyText, redactToken })`, vm.createContext(env));
  return { api, doc, env, timers };
}
// a tree as text: <p>text</p>, <ol><li>a</li></ol>
const dump = (el) => el.tagName === '#TEXT' ? el.textContent : `<${el.tagName.toLowerCase()}>${el._text}${el.children.map(dump).join('')}</${el.tagName.toLowerCase()}>`;
const all = (el, pred, out = []) => { el.children.forEach((c) => { if (pred(c)) out.push(c); all(c, pred, out); }); return out; };
const tagged = (el, tag) => all(el, (c) => c.tagName === tag.toUpperCase());
// what the fake DOM makes of the Copy tools under a code block: the button holds the two icons, the state text and the hidden label
const COPY_TOOLS = (label, lang = '') => `<div>${lang ? `<span>${lang}</span>` : ''}<button><svg><rect></rect><path></path></svg><svg><path></path></svg><span></span><span>${label}</span></button><span></span></div>`;
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
  assert.equal(md('```\n1) x 2) y 3) z\n```'), '<div><pre><code>1) x 2) y 3) z</code></pre>' + COPY_TOOLS('Copy code') + '</div>');
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
  for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example/x', 'file:///etc/passwd', 'ftp://x/y', 'mailto:a@b.c', 'https://']) {
    const root = load().api.renderMarkdown(`[click](${target})`);
    assert.equal(tagged(root, 'a').length, 0, target);
    assert.equal(all(root, (c) => c.getAttribute('href') !== null).length, 0, target);
  }
  assert.equal(tagged(load().api.renderMarkdown('[a](http://x.example/y)'), 'a').length, 1);
  const half = tagged(load().api.renderMarkdown('[click](http://a b)'), 'a');
  assert.deepEqual(half.map((x) => x.getAttribute('href')), ['http://a'], 'not a Markdown link, but its text holds a bare address');
  assert.equal(tagged(load().api.renderMarkdown('Go to ftp://example.com/z or mailto:a@b.c now'), 'a').length, 0, 'only http and https addresses are linked');
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
  assert.equal(out, '<h4>Findings</h4><ol><li><strong>Session</strong> is in <span>code</span>.</li><li>Second</li></ol><ul><li>one</li><li>two</li></ul><div><pre><code>x | y</code></pre>' + COPY_TOOLS('Copy code') + '</div>');
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
  assert.deepEqual(tagged(root, 'strong').map((x) => x.className), ['tone-decided', 'lead', 'tone-warn', 'tone-found']);
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

const block = (root) => tagged(root, 'div').filter((x) => x.className.split(' ').includes('codeblock'));
const copyOf = (box) => tagged(box, 'button')[0];

test('code block: a fenced block is a pre with a Copy button, and the text is exactly what was fenced', () => {
  const root = load().api.renderMarkdown('Run this:\n\n```\nnpm run build\nnpm test\n```\n\nthen tell me.');
  const [box] = block(root);
  assert.equal(root.children.length, 3);
  assert.equal(tagged(box, 'pre')[0].tabIndex, 0);
  assert.equal(tagged(box, 'code')[0].textContent, 'npm run build\nnpm test', 'no trailing newline added');
  const btn = copyOf(box);
  assert.equal(btn.type, 'button');
  assert.equal(btn.getAttribute('title'), 'Copy code');
  assert.equal(btn.textContent, 'Copy code', 'the icon has no text; the hidden label names the button');
  assert.deepEqual(tagged(btn, 'svg').map((x) => x.getAttribute('class')), ['cb-ico cb-ico-copy', 'cb-ico cb-ico-ok']);
  assert.equal(tagged(btn, 'svg')[0].getAttribute('aria-hidden'), 'true');
  assert.equal(box.className, 'codeblock', 'no language: no prompt look');
});

test('code block: the language of the fence is a small label, and bash-like languages get the prompt look', () => {
  for (const lang of ['bash', 'sh', 'shell', 'zsh', 'console', 'cmd', 'powershell', 'ps1', 'BASH']) {
    const [box] = block(load().api.renderMarkdown('```' + lang + '\ngit status\n```'));
    assert.equal(box.className, /^(bash|sh|shell|zsh)$/i.test(lang) ? 'codeblock cb-shell' : 'codeblock', lang);
    assert.equal(tagged(box, 'span')[0].textContent, lang.toLowerCase());
    assert.equal(copyOf(box).getAttribute('title'), 'Copy command');
    assert.equal(tagged(box, 'code')[0].textContent, 'git status', 'the prompt is never in the text');
  }
  const [js] = block(load().api.renderMarkdown('~~~js\nconst a = 1;\n~~~'));
  assert.equal(js.className, 'codeblock');
  assert.equal(tagged(js, 'span')[0].textContent, 'js');
  assert.equal(tagged(js, 'code')[0].textContent, 'const a = 1;');
});

test('code block: a paragraph that is only one command in backticks becomes a block; code in a sentence and lone words stay inline', () => {
  const [box] = block(load().api.renderMarkdown('`npm run build`'));
  assert.ok(box);
  assert.equal(box.className, 'codeblock cb-shell');
  assert.equal(tagged(box, 'code')[0].textContent, 'npm run build');
  assert.equal(copyOf(box).getAttribute('title'), 'Copy command');
  assert.equal(block(load().api.renderMarkdown('  `ls`  ')).length, 1, 'a command word alone');
  assert.equal(md('Run `npm run build` now'), '<p>Run <code>npm run build</code> now</p>');
  assert.equal(md('`open`'), '<p><code>open</code></p>');
  assert.equal(md('`src/server/page.mjs`'), '<p><code>src/server/page.mjs</code></p>');
  assert.equal(md('`a` and `b c`'), '<p><code>a</code> and <code>b c</code></p>');
  assert.equal(md('- `npm run build`'), '<ul><li><code>npm run build</code></li></ul>', 'a list item keeps its inline code');
});

test('code block: a card reference inside code stays text', () => {
  const root = load({ current: { cards: [{ id: 'c37' }] }, selKey: 'k', hashFor: () => '#x', waitsOf: () => [], isChat: () => false }).api.renderMarkdown('```\nthread update c37\n```\n\n`git show c37`');
  assert.equal(all(root, (c) => c.tagName === 'A').length, 0);
  assert.deepEqual(tagged(root, 'code').map((x) => x.textContent), ['thread update c37', 'git show c37']);
});

test('plainMd: unchanged by code blocks', () => {
  const { plainMd } = load().api;
  assert.equal(plainMd('Run `npm run build` then **go**'), 'Run npm run build then go');
});

function copyClick(extra, src = '```bash\nnpm run build\n```') {
  const ctx = load(extra);
  const [box] = block(ctx.api.renderMarkdown(src));
  return { ...ctx, box, btn: copyOf(box), state: tagged(copyOf(box), 'span').find((x) => x.className === 'cb-state'), live: tagged(box, 'span').find((x) => x.getAttribute('role') === 'status') };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('code block copy: writeText gets the exact text, the button says Copied for a moment, and focus stays', async () => {
  const written = [];
  const c = copyClick({ navigator: { clipboard: { writeText: (t) => { written.push(t); return Promise.resolve(); } } } });
  c.btn.focus();
  c.btn.click();
  await settle();
  assert.deepEqual(written, ['npm run build']);
  assert.equal(c.btn.dataset.state, 'copied');
  assert.equal(c.state.textContent, 'Copied');
  assert.equal(c.live.textContent, 'Copied');
  assert.equal(c.live.getAttribute('aria-live'), 'polite');
  assert.equal(c.doc.activeElement, c.btn, 'focus stays on the button');
  assert.equal(c.timers.at(-1).ms, 1500);
  c.timers.at(-1).fn();
  assert.equal(c.btn.dataset.state, undefined);
  assert.equal(c.state.textContent, '');
});

test('code block copy: without a clipboard, or when it rejects, the old copy command is used', async () => {
  const run = async (navigator) => {
    const ran = [];
    const c = copyClick({ navigator });
    const mk = c.doc.createElement;
    c.doc.createElement = (tag) => { const e = mk(tag); e.select = () => { c.doc.activeElement = e; }; return e; };
    c.doc.execCommand = (cmd) => { ran.push([cmd, c.doc.body.children.at(-1).value]); return true; };
    c.btn.focus();
    c.btn.click();
    await settle();
    assert.equal(c.doc.activeElement, c.btn, 'focus goes back to the button');
    assert.deepEqual(ran, [['copy', 'npm run build']]);
    assert.equal(c.btn.dataset.state, 'copied');
    assert.equal(c.doc.body.children.length, 0, 'the helper textarea is gone');
  };
  await run({});
  await run({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
});

test('code block copy: when nothing can copy, the text is selected and the button says to press Ctrl/Cmd+C', async () => {
  const sel = [];
  const c = copyClick({
    navigator: {},
    window: { getSelection: () => ({ removeAllRanges: () => sel.push('clear'), addRange: (r) => sel.push(r.node) }) },
  });
  const mk = c.doc.createElement;
  c.doc.createElement = (tag) => { const e = mk(tag); e.select = () => {}; return e; };
  c.doc.execCommand = () => false;
  c.doc.createRange = () => ({ selectNodeContents(n) { this.node = n; } });
  c.btn.click();
  await settle();
  assert.equal(c.btn.dataset.state, 'failed');
  assert.equal(c.state.textContent, 'Press Ctrl/\u2318+C');
  assert.equal(c.live.textContent, 'Press Ctrl/\u2318+C');
  assert.equal(sel[0], 'clear');
  assert.equal(sel[1].textContent, 'npm run build');
});

test('code block: the clamp still holds a block, and the block page pieces are styled', async () => {
  const { api, doc } = load({ ResizeObserver: class { observe() {} } });
  const box = api.clampable(api.renderMarkdown('```\nx\n```'), 'wait-text', 'k');
  assert.equal(block(box).length, 1);
  const css = await (await import('node:fs/promises')).readFile(new URL('../server/board/css/thread.css', import.meta.url), 'utf8');
  for (const sel of ['.md .codeblock', '.cb-copy', '.cb-copy[data-state="copied"]', '.md .cb-shell::before']) assert.ok(css.includes(sel), sel);
});

const links = (src, extra) => tagged(load(extra).api.renderMarkdown(src), 'a');
const OWN = 'http://127.0.0.1:47999';
const boardEnv = (extra = {}) => ({
  location: { origin: OWN }, selKey: 'proj', current: { cards: [{ id: 'c37' }, { id: 'c8k2x1' }] },
  hashFor: (k, t) => '#/' + encodeURIComponent(k) + (t ? '/' + encodeURIComponent(t) : ''), waitsOf: () => [], isChat: () => false, ...extra,
});

test('bare links: a web address in text is a link that opens in a new tab, without the punctuation after it', () => {
  const [a] = links('See https://example.com/docs/a?b=1#top. Then go on.');
  assert.equal(a.getAttribute('href'), 'https://example.com/docs/a?b=1#top');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.getAttribute('title'), 'https://example.com/docs/a?b=1#top');
  assert.equal(a.textContent, 'https://example.com/docs/a?b=1#top');
  assert.equal(a.className, 'weburl');
  assert.equal(load().api.renderMarkdown('See https://example.com/docs/a?b=1#top. Then go on.').textContent, 'See https://example.com/docs/a?b=1#top. Then go on.');
  for (const [src, want] of [
    ['open https://e.com/a, then', 'https://e.com/a'], ['(see https://e.com/a)', 'https://e.com/a'], ['"https://e.com/a"', 'https://e.com/a'],
    ['is it https://e.com/a?', 'https://e.com/a'], ['[https://e.com/a]', 'https://e.com/a'], ['https://e.com/a;', 'https://e.com/a'], ['wow https://e.com/a!!', 'https://e.com/a'],
    ['http://e.com:8080/x', 'http://e.com:8080/x'], ['HTTPS://E.com/x', 'HTTPS://E.com/x'],
  ]) assert.equal(links(src)[0] && links(src)[0].getAttribute('href'), want, src);
  assert.equal(links('two https://a.example/1 and https://b.example/2.').length, 2);
});

test('bare links: parentheses inside an address stay when they balance', () => {
  assert.equal(links('https://en.wikipedia.org/wiki/Foo_(bar)')[0].getAttribute('href'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(links('(see https://en.wikipedia.org/wiki/Foo_(bar)).')[0].getAttribute('href'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(links('(https://e.com/a)')[0].getAttribute('href'), 'https://e.com/a');
});

test('bare links: other schemes, code, and a word glued to the address stay text', () => {
  for (const src of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://e.com/x', '//evil.example/x', 'https://', 'xhttps://e.com']) assert.equal(links(src).length, 0, src);
  assert.equal(links('Run `curl https://e.com/x` now').length, 0, 'inside a code span');
  assert.equal(links('```\ncurl https://e.com/x\n```').length, 0, 'inside a code block');
  assert.equal(links('`https://e.com/x`').length, 0);
  assert.equal(links('[see https://e.com/in](https://e.com/out)').length, 1, 'no link inside link text');
  assert.equal(links('[see https://e.com/in](https://e.com/out)')[0].getAttribute('href'), 'https://e.com/out');
  assert.equal(links('[text](https://e.com/p)')[0].getAttribute('target'), '_blank', 'a Markdown link still opens in a new tab');
  assert.equal(load().api.plainMd('go to https://e.com/x. or [t](https://e.com/y)'), 'go to https://e.com/x. or t');
});

const TOK = 'ab12'.repeat(8);
const shownText = (src, env) => { const r = load(env).api.renderMarkdown(src); return JSON.stringify(dump(r)) + r.textContent + all(r, () => true).map((e) => `${e.getAttribute('href')}${e.getAttribute('title')}`).join(' '); };

test('board links: this board\'s own card address is the same reference as a card id, and never shows the token', () => {
  const env = boardEnv();
  const [a, ...rest] = links(`Look at ${OWN}/?t=${TOK}#/proj/c37 please.`, env);
  assert.equal(rest.length, 0);
  assert.equal(a.className, 'cref');
  assert.equal(a.dataset.card, 'c37');
  assert.equal(a.textContent, 'c37');
  assert.equal(a.getAttribute('href'), '#/proj/c37');
  assert.equal(a.getAttribute('target'), null, 'opens in place');
  const root = load(env).api.renderMarkdown(`Look at ${OWN}/?t=${TOK}#/proj/c37 please.`);
  assert.equal(shownText(`Look at ${OWN}/?t=${TOK}#/proj/c37 please.`, env).includes(TOK), false);
  assert.equal(root.textContent, 'Look at c37 please.');
  const [l] = links(`[the card](${OWN}/?t=${TOK}#/proj/c8k2x1)`, env);
  assert.equal(l.className, 'cref');
  assert.equal(l.dataset.card, 'c8k2x1');
  assert.equal(l.textContent, 'the card');
  assert.equal(l.getAttribute('href'), '#/proj/c8k2x1');
});

test('board links: any port on 127.0.0.1 or localhost, and the tunnel host, count as this board, in the query or the fragment', () => {
  const env = boardEnv({ location: { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com' } });
  for (const src of [
    `http://localhost:47999/?t=${TOK}#/proj/c37`, `http://127.0.0.1:47800/?t=${TOK}#/proj/c37`, `https://abc.trycloudflare.com/#t=${TOK}/proj/c37`,
    `${OWN}/#/proj/c37?t=${TOK}`, `${OWN}/?a=1&t=${TOK}#/proj/c37`, `http://u:${TOK}@127.0.0.1:1/#/proj/c37`, `${OWN}/?t=${TOK}&T=${TOK}#/proj/c37`,
  ]) {
    const [a] = links(src, env);
    assert.equal(a.className, 'cref', src);
    assert.equal(a.getAttribute('href'), '#/proj/c37', src);
    assert.equal(shownText(src, env).includes(TOK), false, src);
  }
});

test('a page of another local server (a dev app on localhost:3000) is an ordinary link that opens in a new tab', () => {
  const env = boardEnv();
  for (const src of ['http://localhost:3000/en/dev/ui?screen=inbox-pages-disconnected', 'http://127.0.0.1:5173/', 'http://localhost:8080/app#/settings', 'http://[::1]:3000/x?y=1']) {
    const [a] = links(src, env);
    assert.equal(a.className, 'weburl', src);
    assert.equal(a.getAttribute('target'), '_blank', src);
    assert.equal(a.getAttribute('href'), new URL(src).href, src);
  }
  // a loopback address that looks like a board link stays in this tab
  assert.equal(links('http://127.0.0.1:47801/#/2be5b8032e12/c37', env)[0].getAttribute('target'), null);
});

test('board links: a card that is not here, another project, or another page of the board is a link in this tab', () => {
  const env = boardEnv();
  const miss = links(`${OWN}/?t=${TOK}#/proj/c99`, env)[0];
  assert.equal(miss.className, 'weburl');
  assert.equal(miss.getAttribute('href'), '#/proj/c99');
  assert.equal(miss.getAttribute('target'), null, 'same tab');
  assert.equal(miss.dataset.card, undefined);
  const other = links(`${OWN}/?t=${TOK}#/other%20key/c37`, env)[0];
  assert.equal(other.dataset.card, undefined, 'no preview');
  assert.equal(other.getAttribute('href'), '#/other%20key/c37');
  assert.equal(other.getAttribute('target'), null);
  for (const [src, href] of [[`${OWN}/?t=${TOK}#/proj/board`, '#/proj/board'], [`${OWN}/?t=${TOK}`, '#/'], [`http://localhost:1/?t=${TOK}#/proj/waiting`, '#/proj/waiting']]) {
    const view = links(src, env)[0];
    assert.equal(view.getAttribute('target'), null, src);
    assert.equal(view.getAttribute('href'), href, src);
    assert.equal(shownText(src, env).includes(TOK), false, src);
  }
  assert.equal(links(`${OWN}/#/proj/c37`, boardEnv({ current: { cards: [] } }))[0].getAttribute('href'), '#/proj/c37');
});

test('redaction: an access token is dropped from any address and from link text, whatever the host', () => {
  const env = boardEnv();
  const foreign = links(`https://other.example/p?t=${TOK}&a=1#x`, env)[0];
  assert.equal(foreign.getAttribute('target'), '_blank', 'another host is an ordinary web address');
  assert.equal(foreign.getAttribute('href'), 'https://other.example/p?a=1#x');
  assert.equal(foreign.dataset.card, undefined);
  for (const src of [`[see ${OWN}/?t=${TOK}](https://e.com/x)`, `[x](https://e.com/?a=1&t=${TOK})`, `https://e.com/#t=${TOK}/proj`]) assert.equal(shownText(src, env).includes(TOK), false, src);
  const { plainMd, redactToken } = load().api;
  assert.equal(plainMd(`open ${OWN}/?t=${TOK}#/proj/c37 now`), `open ${OWN}/#/proj/c37 now`);
  assert.equal(plainMd(`[a](${OWN}/?t=${TOK}) and http://x/?t=${TOK}&b=2`), 'a and http://x/?b=2');
  assert.equal(redactToken(`http://h/?t=${TOK}`), 'http://h/');
  assert.equal(redactToken(`http://h/?x=1&t=${TOK}&y=2`), 'http://h/?x=1&y=2');
  assert.equal(redactToken(`http://h/#t=${TOK}`), 'http://h/#/');
  assert.equal(redactToken('http://h/?t=short&q=1'), 'http://h/?t=short&q=1', 'only a hex token of 32 or more digits');
});

test('bare links: trimming a very long run of closing brackets is not quadratic', () => {
  const t0 = Date.now();
  const a = links('https://e.com/' + ')'.repeat(60000))[0];
  assert.equal(a.getAttribute('href'), 'https://e.com/');
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('markdown: a fenced block under a list item stays in the item, is dedented, and the numbering goes on', () => {
  for (const src of ['1. Install:\n   ```bash\n   npm install\n   ```\n2. Run it', '1. Install:\n\n   ```bash\n   npm install\n   ```\n\n2. Run it']) {
    const root = load().api.renderMarkdown(src);
    assert.equal(root.children.length, 1, 'one list, not two: ' + JSON.stringify(src));
    const lis = tagged(root, 'li');
    assert.equal(lis.length, 2);
    const [box] = block(lis[0]);
    assert.equal(tagged(box, 'code')[0].textContent, 'npm install', 'no indent in the copied text');
    assert.equal(box.className, 'codeblock cb-shell');
    assert.equal(lis[1].textContent, 'Run it');
  }
  const loose = load().api.renderMarkdown('- a\n\n  ```\n  x\n  y\n  ```\n- b');
  assert.equal(tagged(loose, 'ul').length, 1);
  assert.equal(tagged(block(loose)[0], 'code')[0].textContent, 'x\ny');
  assert.equal(load().api.renderMarkdown('1. a\n```\nz\n```').children.length, 2, 'an unindented fence ends the list');
  const cont = load().api.renderMarkdown('- item\n  goes on with `code` here');
  assert.equal(tagged(cont, 'code')[0].textContent, 'code', 'a continuation line has its inline formatting');
});

test('code block: a lone code span with a space but no command word is a plain code block', () => {
  const [box] = block(load().api.renderMarkdown('`SELECT * FROM users`'));
  assert.equal(box.className, 'codeblock');
  assert.equal(copyOf(box).getAttribute('title'), 'Copy code');
  const [run] = block(load().api.renderMarkdown('`./run.sh`'));
  assert.equal(run.className, 'codeblock cb-shell');
});
