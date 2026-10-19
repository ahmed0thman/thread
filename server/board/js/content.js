  // ---- markdown subset (DOM nodes only) ----

  const BULLET_RE = /^(\s*)(?:[-*+•])\s+(.*)$/;
  const NUM_RE = /^(\s*)\d+[.)]\s+(.*)$/;
  const NONE_RE = /^(none|nothing|nil|n\/a|no changes?|no open (?:items?|questions?|issues?)|no decisions?)(?!\s+of\b)\b.{0,48}$/i;

  // Inline text: `code`, [text](target), **bold**. A link to an http(s) URL is an <a>; any other target (a file path with :line, a
  // relative path, a javascript: URL) is only a marked span with the target in its tooltip, never an href. Bare URLs stay text.
  const WEB_URL_RE = /^https?:\/\/[^\s<>"']+$/i;
  const INLINE_RE = /(`+)([^`]+?)\1|\[([^\]]+)\]\(\s*([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\s*\)|\*\*([^*]+?)\*\*|__([^_]+?)__/g;
  // A card id (c37, c8k2x1; the shape of CARD_ID_SRC in server/fields.mjs) or a waiting item id (c37.w2) in running text is a link when the
  // card is on this board (and, for an item, when the card has it). The first group is what may stand before it: not a word, a path, an
  // address, an e-mail, an assignment or a drive letter path. A word with "://" in it (a web address) is never searched.
  const REF_RE = /(^|[^\w./#@=?&\\~:-])(c(?=[a-z]*[0-9])[0-9a-z]+)(\.w[0-9]+)?(?![\w-]|\.\w)/g;
  // the cards by id, built again when the page gets a new list of them; a chat-only project shows its threads only (shownCard)
  let refIdx = { src: null, n: -1, map: null };
  function refCard(id) {
    if (typeof current === 'undefined' || !current || !Array.isArray(current.cards)) return null;
    if (refIdx.src !== current.cards || refIdx.n !== current.cards.length) refIdx = { src: current.cards, n: current.cards.length, map: new Map(current.cards.map((c) => [c.id, c])) };
    const c = refIdx.map.get(id) || null;
    return c && typeof isChat === 'function' && isChat() && typeof shownCard === 'function' ? shownCard(id) : c;
  }
  // The references in a text that are links now: [{ at, end, id, wid }]
  function refsIn(text) {
    const out = [];
    if (typeof current === 'undefined' || !/c[0-9a-z]*[0-9]/.test(text)) return out;
    const chat = typeof isChat === 'function' && isChat();
    const re = new RegExp(REF_RE.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const card = refCard(m[2]);
      const wid = m[3] ? m[2] + m[3] : '';
      if (!card || (wid && (chat || !waitsOf(card).some((w) => w.id === wid)))) continue;
      const at = m.index + m[1].length;
      let from = at, to = re.lastIndex;
      while (from > 0 && !/\s/.test(text[from - 1])) from--;
      while (to < text.length && !/\s/.test(text[to])) to++;
      if (text.slice(from, to).indexOf('://') >= 0) continue;
      out.push({ at, end: re.lastIndex, id: m[2], wid });
    }
    return out;
  }
  function refEl(id, wid) {
    const a = h('a', 'cref', wid || id);
    a.setAttribute('href', hashFor(selKey, id));
    a.dataset.card = id;
    if (wid) a.dataset.wait = wid;
    return a;
  }
  function textRefs(parent, text) {
    let last = 0;
    refsIn(text).forEach((r) => {
      if (r.at > last) parent.appendChild(document.createTextNode(text.slice(last, r.at)));
      parent.appendChild(refEl(r.id, r.wid));
      last = r.end;
    });
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  // Which references in a text are links now, as text: a text drawn again only when this changes (a card or an item may appear later).
  function refSig(text) { return refsIn(String(text || '')).map((r) => r.wid || r.id).join(' '); }
  // mode 'plain': a link is just its text (a single line inside a button); 'nested': inside a link's text, where a link is left as written.
  // Both leave a card id as text; in the other mode a known id is a link of its own (see textRefs).
  function inline(parent, text, mode) {
    const words = (t) => (mode ? parent.appendChild(document.createTextNode(t)) : textRefs(parent, t));
    const re = new RegExp(INLINE_RE.source, 'g');
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (mode === 'nested' && m[3] !== undefined) { re.lastIndex = m.index + 1; continue; }
      if (m.index > last) words(text.slice(last, m.index));
      if (m[2] !== undefined) parent.appendChild(h('code', null, m[2]));
      else if (m[3] !== undefined && mode === 'plain') inline(parent, m[3], 'nested');
      else if (m[3] !== undefined) {
        const web = WEB_URL_RE.test(m[4]);
        const el = h(web ? 'a' : 'span', web ? null : 'ref');
        if (web) { el.setAttribute('href', m[4]); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
        else if (m[4]) el.setAttribute('title', m[4]);
        inline(el, m[3], 'nested');
        parent.appendChild(el);
      } else if (m[5] !== undefined) { const s = h('strong'); inline(s, m[5], mode); parent.appendChild(s); }
      else parent.appendChild(h('strong', null, m[6]));
      last = re.lastIndex;
    }
    if (last < text.length) words(text.slice(last));
  }
  function inlineEl(tag, cls, text) { const e = h(tag, cls); inline(e, text); return e; }

  // The semantic colour of a section heading, by its first words ("2. Decisions", "Open questions", "Not tested"); '' for any other.
  // Leading numbers, bullets and emoji are ignored; the match is on whole words, case-insensitively.
  const TONES = [
    ['decided', /^(decided|decisions?)\b/], ['changed', /^(changed|changes?)\b/], ['found', /^(found|findings?)\b/],
    ['open', /^(open|next|to do|todo|follow[- ]?ups?)\b/], ['did', /^(did|happened)\b/],
    ['warn', /^(risks?|warnings?|blockers?|caveats?|not covered|not tested)\b/], ['ok', /^(summary|result|done|verdict)\b/],
  ];
  function sectionTone(text) {
    const t = String(text || '').replace(/[*_`]/g, '').replace(/^[^\p{L}]+/u, '').toLowerCase();
    const hit = TONES.find((x) => x[1].test(t));
    return hit ? hit[0] : '';
  }
  // Marks the bold lead of a paragraph or list item ("**Decided:** ...") with its section colour.
  function leadTone(el, text) {
    const m = /^\*\*([^*]+?)\*\*/.exec(text);
    const tone = m && sectionTone(m[1]);
    const lead = el.childNodes[0];
    if (m && lead && lead.tagName === 'STRONG') lead.className = tone ? 'tone-' + tone : 'lead';
  }
  // One line of text with its Markdown markers removed, for the places that show a single plain line (a tile, a chip, a list cell).
  function plainMd(text) {
    return String(text == null ? '' : text)
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/\[([^\]]+)\]\(\s*[^()\s]*(?:\([^()\s]*\)[^()\s]*)*\s*\)/g, '$1')
      .replace(/(`+)([^`]+?)\1/g, '$2')
      .replace(/\*\*([^*]+?)\*\*/g, '$1')
      .replace(/__([^_]+?)__/g, '$1');
  }

  // A paragraph with steps run together ("Do this: 1) a 2) b 3) c"): the text before them and the steps, or null.
  // Conservative: the numbers must run 1, 2, 3 ... with one delimiter style, each after whitespace, the first at the start or after
  // sentence punctuation, so "v2.5", "§7.3", "1.5 s", a date or a lone "1)" are left alone.
  function splitSteps(text) {
    const re = /(^|\s)(\d{1,2})([.)])(?=\s+\S)/g;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) marks.push({ n: Number(m[2]), d: m[3], at: m.index + m[1].length, end: re.lastIndex });
    for (const first of marks) {
      if (first.n !== 1 || (first.at > 0 && !/[.:;!?]\s+$/.test(text.slice(0, first.at)))) continue;
      const chain = [first];
      for (;;) {
        const cur = chain[chain.length - 1];
        const next = marks.find((x) => x.n === cur.n + 1 && x.d === first.d && x.at >= cur.end);
        if (!next) break;
        chain.push(next);
      }
      if (chain.length < 3) continue;
      const items = chain.map((x, k) => text.slice(x.end, k + 1 < chain.length ? chain[k + 1].at : undefined).trim());
      if (items.some((x) => !x)) continue;
      return { lead: text.slice(0, first.at).trim(), items };
    }
    return null;
  }

  // GFM tables. A row is split on pipes that are not escaped (\|) and not inside a `code` span; the outer pipes are optional.
  function splitRow(line) {
    const src = line.trim();
    const cells = [];
    let cur = '', i = 0, sep = false;
    while (i < src.length) {
      const c = src[i];
      sep = false;
      if (c === '\\' && src[i + 1] === '|') { cur += '|'; i += 2; continue; }
      if (c === '`') {
        let n = 1;
        while (src[i + n] === '`') n++;
        const close = src.indexOf('`'.repeat(n), i + n);
        if (close !== -1) { cur += src.slice(i, close + n).replace(/\\\|/g, '|'); i = close + n; continue; }
        cur += src.slice(i, i + n); i += n; continue;
      }
      if (c === '|') { cells.push(cur.trim()); cur = ''; sep = true; i++; continue; }
      cur += c; i++;
    }
    cells.push(cur.trim());
    if (src[0] === '|') cells.shift();
    if (sep) cells.pop();
    return cells;
  }
  // The alignments ('', 'l', 'c', 'r') of a delimiter line ("|---|:--:|"), or null when the line is not one.
  function delimiterOf(line) {
    if (line.indexOf('|') < 0 || !/^[\s|:-]+$/.test(line)) return null;
    const cells = splitRow(line);
    if (!cells.length || !cells.every((x) => /^:?-+:?$/.test(x))) return null;
    return cells.map((x) => (x[0] === ':' ? (x[x.length - 1] === ':' ? 'c' : 'l') : x[x.length - 1] === ':' ? 'r' : ''));
  }
  // Rows with fewer cells than the header are padded, rows with more are cut. The wrapper may scroll sideways on a narrow window.
  function tableEl(head, aligns, rows) {
    const wrap = h('div', 'md-table');
    wrap.tabIndex = 0;
    const table = h('table');
    const mk = (tag, cells) => {
      const tr = h('tr');
      aligns.forEach((al, k) => {
        const cell = h(tag, al ? 'al-' + al : null);
        inline(cell, (cells[k] || '').replace(/<br\s*\/?>/gi, '\n'));
        tr.appendChild(cell);
      });
      return tr;
    };
    const thead = h('thead');
    thead.appendChild(mk('th', head));
    const tbody = h('tbody');
    rows.forEach((r) => tbody.appendChild(mk('td', r)));
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function headingEl(big, text) {
    const tone = sectionTone(text);
    return inlineEl('h4', (big ? 'l1' : 'l3') + (tone ? ' tone-' + tone : ''), text);
  }

  function renderMarkdown(src) {
    const root = h('div', 'md');
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0, para = [];
    const flush = () => {
      if (!para.length) return;
      const text = para.join('\n');
      para = [];
      const steps = splitSteps(text);
      if (!steps) { const p = inlineEl('p', null, text); leadTone(p, text); root.appendChild(p); return; }
      if (steps.lead) root.appendChild(inlineEl('p', null, steps.lead));
      const ol = h('ol');
      steps.items.forEach((t) => ol.appendChild(inlineEl('li', null, t)));
      root.appendChild(ol);
    };
    while (i < lines.length) {
      const line = lines[i];
      let m = /^\s*(```+|~~~+)/.exec(line);
      if (m) {
        flush();
        const fence = m[1][0];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + (fence === '`' ? '```' : '~~~')).test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const pre = h('pre');
        pre.tabIndex = 0;
        pre.appendChild(h('code', null, buf.join('\n')));
        root.appendChild(pre);
        continue;
      }
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      if (line.indexOf('|') >= 0 && i + 1 < lines.length) {
        const aligns = delimiterOf(lines[i + 1]);
        const head = aligns && splitRow(line);
        if (aligns && head.length === aligns.length) {
          flush();
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*(```|~~~|#{1,6}\s)/.test(lines[i])) rows.push(splitRow(lines[i++]));
          root.appendChild(tableEl(head, aligns, rows));
          continue;
        }
      }
      m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) { flush(); root.appendChild(headingEl(m[1].length <= 2, m[2])); i++; continue; }
      // a line that is only a bold section name ("**Decisions**", "**Open:**") is a heading too
      m = /^\s*(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*:?\s*$/.exec(line);
      if (m && sectionTone(m[1])) { flush(); root.appendChild(headingEl(false, m[1].replace(/\s*:$/, ''))); i++; continue; }
      // a line that is one paragraph of steps run together ("1) a 2) b 3) c") is not a one-item list
      if ((BULLET_RE.test(line) || NUM_RE.test(line)) && (BULLET_RE.test(line) || !splitSteps(line.trim()))) {
        flush();
        const ordered = !BULLET_RE.test(line);
        const baseIndent = (BULLET_RE.exec(line) || NUM_RE.exec(line))[1].length;
        const list = h(ordered ? 'ol' : 'ul');
        let lastLi = null, nested = null;
        while (i < lines.length) {
          const l = lines[i];
          const bm = BULLET_RE.exec(l), nm = NUM_RE.exec(l);
          const mm = bm || nm;
          if (mm) {
            const indent = mm[1].length;
            if (indent >= baseIndent + 2 && lastLi) {
              if (!nested) { nested = h(bm ? 'ul' : 'ol'); lastLi.appendChild(nested); }
              nested.appendChild(inlineEl('li', null, mm[2]));
            } else {
              nested = null;
              lastLi = inlineEl('li', null, mm[2]);
              leadTone(lastLi, mm[2]);
              list.appendChild(lastLi);
            }
            i++;
          } else if (/^\s+\S/.test(l) && lastLi) {
            lastLi.appendChild(document.createTextNode(' ' + l.trim()));
            i++;
          } else break;
        }
        root.appendChild(list);
        continue;
      }
      para.push(line.trim());
      i++;
    }
    flush();
    return root;
  }

  // Long text in one message: shown clamped to about 12 lines with a fade, and a Show more button under it. The button is there
  // only when the text overflows (measured once the box has a size, and again when it changes), and it is a real button with aria-expanded.
  // key keeps the opened state across the redraws of the page.
  const clampOpen = new Set();
  function clampable(content, cls, key) {
    const box = h('div', 'clamp' + (cls ? ' ' + cls : ''));
    const body = h('div', 'clamp-body');
    body.appendChild(content);
    const btn = h('button', 'clamp-toggle', 'Show more');
    btn.type = 'button';
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    const paint = (open) => {
      if (open) box.dataset.open = '1'; else delete box.dataset.open;
      btn.textContent = open ? 'Show less' : 'Show more';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const measure = () => {
      if (box.dataset.open) { btn.hidden = false; delete box.dataset.over; return; }   // it overflowed when it was opened
      const over = body.scrollHeight > body.clientHeight + 1;
      btn.hidden = !over;
      if (over) box.dataset.over = '1'; else delete box.dataset.over;
    };
    btn.addEventListener('click', () => {
      const open = !box.dataset.open;
      paint(open);
      if (key) { if (open) clampOpen.add(key); else clampOpen.delete(key); }
      measure();
    });
    if (key && clampOpen.has(key)) { paint(true); btn.hidden = false; }
    // focus (the Tab key) reaching something below the fold: the browser would scroll the hidden part into view, so open the text instead
    body.addEventListener('focusin', (e) => {
      if (box.dataset.open || !box.dataset.over || !e.target.getBoundingClientRect) return;
      const r = e.target.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.bottom <= b.bottom + 1 && r.top >= b.top - 1) { body.scrollTop = 0; return; }
      btn.click();
      body.scrollTop = 0;
      if (e.target.scrollIntoView) e.target.scrollIntoView({ block: 'nearest' });
    });
    box.append(body, btn);
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(body);
    return box;
  }

  // ---- end markdown subset ----

  // Digest text -> clean items; none-like lines are dropped.
  function isNone(s) {
    const t = String(s).replace(/[*_`]/g, '').trim().replace(/[.;:!\s]+$/, '');
    return !t || NONE_RE.test(t);
  }
  function itemsOf(text) {
    const out = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw) => {
      if (!raw.trim() || /^\s*#{1,6}\s/.test(raw)) return;
      const m = BULLET_RE.exec(raw) || NUM_RE.exec(raw);
      if (m) out.push(m[2].trim());
      else if (out.length && /^\s+/.test(raw)) out[out.length - 1] += ' ' + raw.trim();
      else out.push(raw.trim());
    });
    return out.filter((s) => !isNone(s));
  }

  // Fallback if the server did not attach a view.
  function viewOf(turn) {
    if (turn.view && typeof turn.view === 'object') return turn.view;
    if (typeof turn.result !== 'string') return null;
    const out = { body: '', sections: { happened: '', decided: '', changed: '', open: '' }, map: [] };
    const re = /^##\s+(Happened|Decided|Changed|Open)\s*$/gim;
    const marks = [];
    let m;
    while ((m = re.exec(turn.result)) !== null) marks.push({ k: m[1].toLowerCase(), s: m.index, e: re.lastIndex });
    if (!marks.length) { out.body = turn.result.trim(); return out; }
    out.body = turn.result.slice(0, marks[0].s).trim();
    marks.forEach((mk, i) => { out.sections[mk.k] = turn.result.slice(mk.e, i + 1 < marks.length ? marks[i + 1].s : undefined).trim(); });
    return out;
  }

  // ---------- trace model ----------

  function turnState(card, i) {
    const t = turnsOf(card)[i];
    if (t.ok === false) return 'failed';
    if (t.ok === true) return 'ok';
    if (!t.finishedAt && card.thread.runState === 'running' && i === turnsOf(card).length - 1) return 'running';
    return 'pending';
  }
  function stepsOf(turn) {
    const v = viewOf(turn);
    if (!v) return [];
    if (Array.isArray(v.map) && v.map.length) return v.map.map((s) => ({ kind: KINDS.includes(s.kind) ? s.kind : 'did', text: String(s.text || ''), ref: s.ref }));
    const out = [];
    SECTIONS.forEach(([key, , kind]) => itemsOf(v.sections && v.sections[key]).forEach((text) => out.push({ kind, text })));
    return out;
  }
  function firstLine(s) { return String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || ''; }

