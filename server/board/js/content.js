  // ---------- markdown subset (DOM nodes only) ----------

  const BULLET_RE = /^(\s*)(?:[-*+•])\s+(.*)$/;
  const NUM_RE = /^(\s*)\d+[.)]\s+(.*)$/;
  const NONE_RE = /^(none|nothing|nil|n\/a|no changes?|no open (?:items?|questions?|issues?)|no decisions?)(?!\s+of\b)\b.{0,48}$/i;

  function inline(parent, text) {
    const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] !== undefined) parent.appendChild(h('code', null, m[2]));
      else parent.appendChild(h('strong', null, m[3] !== undefined ? m[3] : m[4]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function inlineEl(tag, cls, text) { const e = h(tag, cls); inline(e, text); return e; }

  function renderMarkdown(src) {
    const root = h('div', 'md');
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0, para = [];
    const flush = () => { if (para.length) { root.appendChild(inlineEl('p', null, para.join(' '))); para = []; } };
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
      m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (m) { flush(); root.appendChild(inlineEl('h4', m[1].length <= 2 ? 'l1' : '', m[2])); i++; continue; }
      if (BULLET_RE.test(line) || NUM_RE.test(line)) {
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

