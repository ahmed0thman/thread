  // ---- card fields (fields-page.test.mjs runs this block on its own) ----
  // The optional fields of a task or idea card: type, priority, labels, blocked by, acceptance criteria. A card from an older version
  // has none of them, and that is the same as the defaults. The server stores only what differs from the default.
  const FIELD_KEYS = ['type', 'priority', 'labels', 'blockedBy', 'criteria'];
  const TYPE_NAME = { task: 'Task', bug: 'Bug' };
  const PRIORITY_NAME = { high: 'High', normal: 'Normal', low: 'Low' };
  const FACE_LABELS = 3;        // labels on a card's face; the rest is "+N"
  const MAX_CRITERIA = 10;      // the server's limits, for the editor's own hints
  const MAX_CRITERION = 200;
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  // The fields of a card with the defaults filled in, whatever the card holds.
  function fieldValues(card) {
    const c = card || {};
    return {
      type: c.type === 'bug' ? 'bug' : 'task',
      priority: c.priority === 'high' || c.priority === 'low' ? c.priority : 'normal',
      labels: strings(c.labels),
      blockedBy: strings(c.blockedBy),
      criteria: strings(c.criteria),
    };
  }
  // 'API, ui ,, api' -> ['api', 'ui']: lower case, each once, in the order typed. Their length and number are for the server to judge.
  function parseLabels(text) {
    const out = [];
    String(text || '').split(/[,\n]/).forEach((x) => { const t = x.trim().toLowerCase(); if (t && !out.includes(t)) out.push(t); });
    return out;
  }
  // 'c4, C7 c4' -> ['c4', 'c7']
  function parseBlockers(text) {
    const out = [];
    String(text || '').split(/[\s,]+/).forEach((x) => { const t = x.trim().toLowerCase(); if (t && !out.includes(t)) out.push(t); });
    return out;
  }
  // The lines of the criteria editor, without the empty ones.
  function parseCriteria(lines) {
    return (Array.isArray(lines) ? lines : []).map((x) => String(x).trim()).filter(Boolean);
  }
  const sameField = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // What the form changed: only the keys whose value differs from `base` (both from fieldValues), among `keys`. {} for no change.
  // A value back at its default is sent as that default ('task', 'normal', []), which the server stores as no field.
  function fieldsPatch(base, vals, keys) {
    const patch = {};
    (keys || FIELD_KEYS).forEach((k) => { if (!sameField(base[k], vals[k])) patch[k] = vals[k]; });
    return patch;
  }
  // The fields a card's form offers: a milestone takes none, a thread and a new card take type, priority and labels.
  function fieldKeys(kind, creating) {
    if (kind === 'milestone') return [];
    return creating || kind === 'thread' ? ['type', 'priority', 'labels'] : FIELD_KEYS.slice();
  }
  // A worker string in words, for a tooltip: 'agent:worker' -> 'Sub-agent worker'.
  function workerTitle(w) {
    const s = String(w);
    if (s === 'main') return 'The main session';
    const what = ({ agent: 'Sub-agent ', thread: 'Side thread ', lane: 'Delegation lane ' })[s.slice(0, s.indexOf(':'))];
    return what ? what + s.slice(s.indexOf(':') + 1) : s;
  }
  // What a card's face shows of its fields. ctx: { cards, done, label(stageId) }. `blocked` lists only the blockers that are not finished:
  // a card whose blockers are all done is not held up. Cards without the fields give an empty model.
  function faceModel(card, ctx) {
    const m = { bug: false, priority: '', labels: [], more: 0, blocked: [], blockedTitle: '', criteria: 0, notVerified: false, aria: [] };
    if (!card || card.kind === 'milestone') return m;
    const v = fieldValues(card);
    const cards = (ctx && ctx.cards) || [];
    m.bug = v.type === 'bug';
    m.priority = v.priority === 'normal' ? '' : v.priority;
    m.labels = v.labels.slice(0, FACE_LABELS);
    m.more = v.labels.length - m.labels.length;
    const parts = [];
    v.blockedBy.forEach((id) => {
      const b = cards.find((x) => x.id === id);
      if (!b || (ctx && b.status === ctx.done)) return;
      m.blocked.push(id);
      parts.push(id + (ctx && ctx.label ? ' (' + ctx.label(b.status) + ')' : ''));
    });
    if (parts.length) m.blockedTitle = 'Blocked by ' + parts.join(', ');
    m.criteria = card.kind === 'thread' ? 0 : v.criteria.length;
    m.notVerified = card.verified === false;
    if (m.bug) m.aria.push('bug');
    if (m.priority) m.aria.push(m.priority + ' priority');
    if (v.labels.length) m.aria.push('labels ' + v.labels.join(', '));
    if (m.blocked.length) m.aria.push('blocked by ' + m.blocked.join(', '));
    if (m.criteria) m.aria.push(criteriaText(m.criteria));
    if (m.notVerified) m.aria.push('done, not verified');
    return m;
  }
  const criteriaText = (n) => n + (n === 1 ? ' criterion' : ' criteria');
  // The read-only rows for a thread's page, which has no card form: [label, text].
  function fieldFacts(card) {
    const v = fieldValues(card), rows = [];
    if (v.type === 'bug') rows.push(['Type', TYPE_NAME.bug]);
    if (v.priority !== 'normal') rows.push(['Priority', PRIORITY_NAME[v.priority]]);
    if (v.labels.length) rows.push(['Labels', v.labels.join(', ')]);
    const w = strings(card && card.workedBy);
    if (w.length) rows.push(['Worked by', w.join(', ')]);
    return rows;
  }
  // ---- end card fields ----
  // ---- card field marks (fields-page.test.mjs runs this block against a small fake DOM) ----
  // visually hidden text for screen readers
  const srText = (t) => h('span', 'sr-only', t);
  // The bug icon beside a card's kind. null for a task.
  function bugMark(m) {
    if (!m.bug) return null;
    const e = h('span', 'fmark fm-bug');
    e.title = 'Bug';
    e.append(shape('s-beetle'), srText('bug'));
    return e;
  }
  // High priority is two arrows up, low two arrows down (a lone one beside the gear reads as a menu); normal has no mark. The words are for screen readers and the tooltip.
  function priorityMark(m) {
    if (!m.priority) return null;
    const hi = m.priority === 'high';
    const e = h('span', 'fmark fm-' + m.priority);
    e.title = hi ? 'High priority' : 'Low priority';
    e.append(...[0, 1].map(() => shape(hi ? 's-up' : 's-dn')));
    e.appendChild(srText(hi ? 'high priority' : 'low priority'));
    return e;
  }
  // Label chips, the first few and "+N" for the rest.
  function labelChips(labels, more, all) {
    const row = h('div', 'cardchips');
    labels.forEach((l) => row.appendChild(h('span', 'cardchip', l)));
    if (more > 0) {
      const e = h('span', 'cardchip more', '+' + more);
      if (all) e.title = all.join(', ');
      row.appendChild(e);
    }
    return row;
  }
  // The row of labels on a face, or null.
  function faceLabels(card, m) {
    return m.labels.length ? labelChips(m.labels, m.more, fieldValues(card).labels) : null;
  }
  // The tags for a face's foot: blocked, criteria, not verified.
  function faceTags(m) {
    const out = [];
    if (m.blocked.length) {
      const t = h('span', 'tag attn');
      t.title = m.blockedTitle;
      t.append(shape('s-block'), h('span', null, 'blocked'));
      out.push(t);
    }
    if (m.criteria) {
      const t = h('span', 'tag quiet fm-crit');
      t.title = 'Acceptance criteria';
      t.append(shape('s-wt'), h('span', 'tnum', criteriaText(m.criteria)));
      out.push(t);
    }
    if (m.notVerified) {
      const t = h('span', 'tag attn');
      t.title = 'In the done stage without an approved review';
      t.append(shape('s-dring'), h('span', null, 'not verified'));
      out.push(t);
    }
    return out;
  }
  // The workers of a card as chips, each with its words as a tooltip. null for none.
  function workerChips(list) {
    const w = strings(list);
    if (!w.length) return null;
    const row = h('div', 'cardchips');
    w.forEach((x) => { const e = h('span', 'cardchip worker', x); e.title = workerTitle(x); row.appendChild(e); });
    return row;
  }
  // ---- end card field marks ----
