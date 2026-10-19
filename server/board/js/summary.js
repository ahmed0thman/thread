  // ---------- the Summary view ----------

  // ---- summary (summary-page.test.mjs runs this block on its own, after the "tokens and agents" and "milestones and stages" blocks) ----
  // What the Summary shows is worked out here from the cards the page already has; nothing is asked of the server. Dates are local:
  // a week runs from Monday 00:00 to the next Monday 00:00 in the browser's time zone.
  const SUM_RANGES = [4, 8, 12, 26];    // the weeks the chart can show, the current one last
  const SUM_RANGE = 8;                  // the default
  const SUM_DONE_DAYS = 7;      // "done lately" tile
  const SUM_WORKERS = 8;        // rows in the work chart
  const SUM_WAITS = 8;
  const SUM_MILESTONES = 6;
  const atMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

  // n + 1 Mondays at 00:00 local, oldest first: week i is [edges[i], edges[i + 1]) and the last edge is the end of this week.
  // Calendar arithmetic, not 7 * 86400000, so a week with a clock change keeps its Monday.
  function weekEdges(now, n) {
    const d = new Date(now);
    const sinceMonday = (d.getDay() + 6) % 7;
    const out = [];
    for (let i = n - 1; i >= -1; i--) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday - 7 * i).getTime());
    return out;
  }
  // The week t falls in, or -1 when it is outside the weeks shown (or has no time).
  function weekOf(t, edges) {
    if (t === null || t < edges[0] || t >= edges[edges.length - 1]) return -1;
    let i = edges.length - 2;
    while (edges[i] > t) i--;
    return i;
  }
  // When a card was completed: the last time it entered the finished stages (the done stage or a later one) from a stage that is not
  // finished, or was created in one. A move from Done to Released is no completion; reopening a card and finishing it again gives a
  // new date. A thread: the end of its last turn. Without such an entry (the history keeps 50): the time it was last updated.
  // null when none of them is a usable time.
  function completedAt(c, config) {
    if (c.kind === 'thread' && c.thread && Array.isArray(c.thread.turns)) {
      for (let i = c.thread.turns.length - 1; i >= 0; i--) {
        const t = c.thread.turns[i] && atMs(c.thread.turns[i].finishedAt);
        if (t) return t;
      }
    } else if (Array.isArray(c.history)) {
      let at = null;
      c.history.forEach((e) => {
        const enters = e && ((e.type === 'moved' && stageFinishedIn(config, e.to) && !stageFinishedIn(config, e.from)) || (e.type === 'created' && stageFinishedIn(config, e.to)));
        const t = enters ? atMs(e.at) : null;
        if (t !== null && (at === null || t > at)) at = t;
      });
      if (at !== null) return at;
    }
    return atMs(c.updatedAt);
  }
  // The times a card spent in stages it left: [[stage, ms]], from the created entry and the moved entries that follow it.
  // A stage whose entry is no longer in the history (it keeps 50) has no time.
  function stageTimes(c) {
    const out = [];
    let here = null;
    (Array.isArray(c.history) ? c.history : []).forEach((e) => {
      if (!e) return;
      const t = atMs(e.at);
      if (e.type === 'created') here = t === null ? null : { stage: e.to, at: t };
      else if (e.type === 'moved') {
        if (here && here.stage === e.from && t !== null && t >= here.at) out.push([e.from, t - here.at]);
        here = t === null ? null : { stage: e.to, at: t };
      }
    });
    return out;
  }
  function median(list) {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }
  // 'agent:worker' as workedBy names it: a name that was cut short with … loses the dots and is cut to fit 64 characters
  const derivedWorker = (prefix, name) => prefix + String(name).replace(/…$/, '').slice(0, 64 - prefix.length);
  // The chart's top value and its gridlines: whole numbers, four steps, at least 4.
  function chartScale(max) {
    const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
    return { top, ticks: [0, 1, 2, 3, 4].map((i) => i * top / 4) };
  }
  // The name a thread's tokens are listed under in Work by worker
  function threadWorker(th) {
    return typeof th.agent === 'string' && th.agent ? derivedWorker('agent:', th.agent)
      : th.lane && typeof th.lane.name === 'string' && th.lane.name ? derivedWorker('lane:', th.lane.name) : 'thread';
  }
  // Every worker a card has, named as Work by worker names them: those it records in workedBy, its sub-agent runs and its thread.
  function cardWorkers(c) {
    const out = [];
    const add = (w) => { if (typeof w === 'string' && w && !out.includes(w)) out.push(w); };
    (Array.isArray(c.workedBy) ? c.workedBy : []).forEach(add);
    (Array.isArray(c.runs) ? c.runs : []).forEach((r) => { if (r && typeof r === 'object') add(derivedWorker('agent:', typeof r.agentType === 'string' && r.agentType ? r.agentType : 'unknown')); });
    if (c.kind === 'thread' && c.thread) add(threadWorker(c.thread));
    return out;
  }
  // The Type filter's own idea of a type: "bug" is the type field whatever the kind (as in the List); otherwise the kind, a task by default.
  function sumTypeOf(c) {
    if (c.type === 'bug') return 'bug';
    return c.kind === 'idea' || c.kind === 'thread' ? c.kind : 'task';
  }
  const SUM_TYPES = [['task', 'Task'], ['bug', 'Bug'], ['idea', 'Idea'], ['thread', 'Thread']];
  const SUM_PRIORITIES = [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
  const sumPriorityOf = (c) => (c.priority === 'high' || c.priority === 'low' ? c.priority : 'normal');
  const SUM_CARD_FILTERS = ['milestone', 'worker', 'type', 'priority', 'label'];
  // The values the filters offer, from the cards of the project. A select with fewer than two real options is not worth showing.
  function sumChoices(work, milestones) {
    const ms = milestones.slice().sort(msTitleCmp);
    const seen = {};
    ms.forEach((m) => { seen[m.title] = (seen[m.title] || 0) + 1; });
    const workers = [], labels = [];
    work.forEach((c) => {
      cardWorkers(c).forEach((w) => { if (!workers.includes(w)) workers.push(w); });
      (Array.isArray(c.labels) ? c.labels : []).forEach((l) => { if (typeof l === 'string' && l && !labels.includes(l)) labels.push(l); });
    });
    const types = SUM_TYPES.filter(([t]) => work.some((c) => sumTypeOf(c) === t));
    const priorities = SUM_PRIORITIES.filter(([p]) => work.some((c) => sumPriorityOf(c) === p));
    return {
      milestones: ms.map((m) => [m.id, seen[m.title] > 1 ? m.title + ' (' + m.id + ')' : String(m.title || m.id)]),
      workers: workers.sort((a, b) => a.localeCompare(b)),
      types, priorities,
      labels: labels.sort((a, b) => a.localeCompare(b)),
    };
  }
  // The filters as the model uses them: a value that is not offered (a milestone that is gone, a label no card has) filters nothing.
  function sumNormalize(f, ch) {
    const o = f && typeof f === 'object' ? f : {};
    const pick = (v, ok) => (typeof v === 'string' && ok(v) ? v : '');
    return {
      range: SUM_RANGES.includes(Number(o.range)) ? Number(o.range) : SUM_RANGE,
      milestone: pick(o.milestone, (v) => v === NO_MS || ch.milestones.some((m) => m[0] === v)),
      worker: pick(o.worker, (v) => ch.workers.includes(v)),
      type: pick(o.type, (v) => ch.types.some((t) => t[0] === v)),
      priority: pick(o.priority, (v) => ch.priorities.some((p) => p[0] === v)),
      label: pick(o.label, (v) => ch.labels.includes(v)),
    };
  }
  function sumMatches(c, f) {
    if (f.milestone === NO_MS) { if (c.parent) return false; }
    else if (f.milestone && c.parent !== f.milestone) return false;
    if (f.type && sumTypeOf(c) !== f.type) return false;
    if (f.priority && sumPriorityOf(c) !== f.priority) return false;
    if (f.label && !(Array.isArray(c.labels) && c.labels.includes(f.label))) return false;
    return !f.worker || cardWorkers(c).includes(f.worker);
  }
  // Cards open at the end of each week (the end is the next week's edge): created before it, and not completed before it. A card with no
  // usable creation time is not counted, nor is a finished one with no usable completion time (nothing says when it stopped being open).
  function openAt(work, doneTimes, end) {
    return work.filter((c) => {
      const born = atMs(c.createdAt);
      if (born === null || born >= end) return false;
      if (!doneTimes.has(c)) return true;
      const t = doneTimes.get(c);
      return t !== null && t >= end;
    }).length;
  }
  // Everything the Summary shows. cards: the project's cards; config: its stages and roles; now: ms; filters: { range (weeks), milestone,
  // worker, type, priority, label } (see sumNormalize). The filters apply to every count below but the lately-done tile's seven days.
  function summaryModel(cards, config, now, filters) {
    const roles = config.roles;
    const list = (Array.isArray(cards) ? cards : []).filter((c) => c && typeof c === 'object');
    const every = list.filter((c) => c.kind !== 'milestone');
    const choices = sumChoices(every, list.filter((c) => c.kind === 'milestone'));
    const f = sumNormalize(filters, choices);
    const work = every.filter((c) => sumMatches(c, f));
    // finished: the done stage or a later one (see finishedIn); a card's date is when it was completed (see completedAt)
    const open = work.filter((c) => !finishedIn(c, config));
    const doneCards = work.filter((c) => finishedIn(c, config));
    const doneTimes = new Map(doneCards.map((c) => [c, completedAt(c, config)]));
    const stageOf = (id) => config.stages.find((s) => s.id === id);

    const waits = [];
    work.forEach((c) => openWaitsOf(c).forEach((w) => waits.push({ id: w.id, card: c.id, kind: w.kind, text: clip(w.text, 160), askedAt: typeof w.askedAt === 'string' ? w.askedAt : '' })));
    // oldest first; an item with no usable time goes last
    const askedMs = (w) => { const t = atMs(w.askedAt); return t === null ? Infinity : t; };
    waits.sort((a, b) => (askedMs(a) === askedMs(b) ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : askedMs(a) < askedMs(b) ? -1 : 1));

    const edges = weekEdges(now, f.range);
    const weeks = edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1], created: 0, done: 0, open: openAt(work, doneTimes, edges[i + 1]) }));
    work.forEach((c) => { const i = weekOf(atMs(c.createdAt), edges); if (i >= 0) weeks[i].created += 1; });
    doneCards.forEach((c) => { const i = weekOf(doneTimes.get(c), edges); if (i >= 0) weeks[i].done += 1; });

    const byWorker = new Map();
    const rowOf = (name) => { if (!byWorker.has(name)) byWorker.set(name, { name, done: 0, in: 0, out: 0 }); return byWorker.get(name); };
    const addTokens = (name, t) => { if (t) { const r = rowOf(name); r.in += t.in; r.out += t.out; } };
    doneCards.forEach((c) => (Array.isArray(c.workedBy) ? c.workedBy : []).forEach((w) => { rowOf(w).done += 1; }));
    work.forEach((c) => {
      (Array.isArray(c.runs) ? c.runs : []).forEach((r) => {
        if (r && typeof r === 'object') addTokens(derivedWorker('agent:', typeof r.agentType === 'string' && r.agentType ? r.agentType : 'unknown'), turnTokens(r));
      });
      if (c.kind === 'thread' && c.thread) addTokens(threadWorker(c.thread), threadTokens(Array.isArray(c.thread.turns) ? c.thread.turns : []));
    });
    const rows = [...byWorker.values()].map((r) => ({ name: r.name, done: r.done, tokens: r.in + r.out }))
      .filter((r) => (r.done > 0 || r.tokens > 0) && (!f.worker || r.name === f.worker))   // a worker filter keeps that worker's row
      .sort((a, b) => b.done - a.done || b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const shown = rows.slice(0, SUM_WORKERS);

    const spent = new Map();
    work.forEach((c) => stageTimes(c).forEach(([stage, ms]) => { if (!spent.has(stage)) spent.set(stage, []); spent.get(stage).push(ms); }));
    const stages = config.stages.filter((s) => !stageFinishedIn(config, s.id) && spent.has(s.id))
      .map((s) => ({ id: s.id, label: s.label, n: spent.get(s.id).length, median: median(spent.get(s.id)) }));

    // the order the Milestones view lists them in (by number, M0, M1 … M10), before the panel keeps its first few
    // the milestone filter keeps one milestone (none for "No milestone"); another filter keeps the milestones that have a card it lets through
    const cardFiltered = ['worker', 'type', 'priority', 'label'].some((k) => f[k]);
    const shownMs = list.filter((c) => c.kind === 'milestone' && (!f.milestone || c.id === f.milestone) && (!cardFiltered || work.some((k) => k.parent === c.id)));
    const milestones = milestonesByNumber(shownMs).map((m) => ({ id: m.id, title: String(m.title || m.id), state: msStateOf(m, list, config), ...progressOf(list, m.id, config) }));
    const working = stageOf(roles.working);
    return {
      empty: list.length === 0,
      cards: work.length,
      total: every.length,
      filters: f,
      filtering: SUM_CARD_FILTERS.some((k) => f[k]),
      choices,
      tiles: {
        open: open.length,
        working: open.filter((c) => c.status === roles.working).length,
        workingLabel: working ? working.label : 'In progress',
        doneRecent: doneCards.filter((c) => { const t = doneTimes.get(c); return t !== null && t >= now - SUM_DONE_DAYS * 86400000; }).length,
        bugs: open.filter((c) => c.type === 'bug').length,
        waiting: waits.length,
      },
      weeks,
      scale: chartScale(Math.max(0, ...weeks.map((w) => Math.max(w.created, w.done)))),
      openScale: chartScale(Math.max(0, ...weeks.map((w) => w.open))),
      workers: shown,
      workersMore: rows.length - shown.length,
      workersMaxDone: Math.max(0, ...shown.map((r) => r.done)),
      workersMaxTokens: Math.max(0, ...shown.map((r) => r.tokens)),
      waits: waits.slice(0, SUM_WAITS),
      waitsMore: Math.max(0, waits.length - SUM_WAITS),
      stages,
      milestones: milestones.slice(0, SUM_MILESTONES),
      milestonesMore: Math.max(0, milestones.length - SUM_MILESTONES),
    };
  }
  // 40 s, 12 min, 5 h, 3 d: one unit, for a typical time rather than an exact one
  function spanText(ms) {
    const min = ms / 60000;
    if (min < 1) return 'under 1 min';
    if (min < 60) return Math.round(min) + ' min';
    const hr = min / 60;
    if (hr < 48) return +hr.toFixed(hr < 10 ? 1 : 0) + ' h';
    return +(hr / 24).toFixed(hr / 24 < 10 ? 1 : 0) + ' d';
  }
  // ---- end summary ----

  // ---- summary page (summary-page.test.mjs runs this block against a fake DOM) ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, String(attrs[k])));
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function sumPanel(cls, title, sub) {
    const p = h('section', 'sum-panel ' + cls);
    p.appendChild(h('h3', 'sum-title', title));
    if (sub) p.appendChild(h('p', 'sum-sub muted', sub));
    return p;
  }
  function sumTile(label, n, hot, href, hint) {
    const t = h(href ? 'a' : 'div', 'sum-tile' + (hot && n > 0 ? ' hot' : '') + (href ? ' is-link' : ''));
    if (href) t.href = href;
    if (hint) t.title = hint;
    t.append(h('span', 'sum-tile-n tnum', String(n)), h('span', 'sum-tile-label', label));
    return t;
  }

  // ---- the filters, kept per project for the session (sessionStorage; without it they last until the page is reloaded) ----
  const SUM_STORE_KEY = 'thread.summary.filters';
  const SUM_KEYS = ['milestone', 'worker', 'type', 'priority', 'label'];
  const sumMemo = {};
  let sumStore = null;
  try { sumStore = sessionStorage; } catch (e) { /* no storage */ }
  function sumStored() {
    try { const o = JSON.parse(sumStore.getItem(SUM_STORE_KEY)); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  // the selected project's state: the filters (see sumNormalize), whether the chart's table is open and the week the chart shows (-1: none)
  function sumUi() {
    if (!sumMemo[selKey]) {
      const s = sumStored()[selKey] || {};
      const u = { range: SUM_RANGES.includes(Number(s.range)) ? Number(s.range) : SUM_RANGE, table: false, week: -1 };
      SUM_KEYS.forEach((k) => { u[k] = typeof s[k] === 'string' ? s[k] : ''; });
      sumMemo[selKey] = u;
    }
    return sumMemo[selKey];
  }
  function sumFilters() { const u = sumUi(); const f = { range: u.range }; SUM_KEYS.forEach((k) => { f[k] = u[k]; }); return f; }
  function sumPersist() {
    try { const all = sumStored(); all[selKey] = sumFilters(); sumStore.setItem(SUM_STORE_KEY, JSON.stringify(all)); } catch (e) { /* kept in memory only */ }
  }
  function sumSet(patch) {
    Object.assign(sumUi(), patch, { week: -1 });
    sumPersist();
    maybeRenderPane();
  }
  function sumClear() {
    sumSet({ range: SUM_RANGE, milestone: '', worker: '', type: '', priority: '', label: '' });
    const r = elPane.querySelector('[data-id="sum-range"]');    // the button that was pressed is gone: the focus goes to the first filter
    if (r) r.focus();
  }
  // A filter that nothing offers any more (its milestone was deleted, its label is gone) must not come back when it is offered again:
  // what the model made of the filters is written back.
  function sumSettle(m) {
    if (m.empty) return;
    const u = sumUi();
    const f = m.filters;
    if (SUM_KEYS.every((k) => u[k] === f[k]) && u.range === f.range) return;
    Object.assign(u, f);
    sumPersist();
  }

  function sumSelect(id, label, pairs, value, isSet, onChange) {
    const wrap = h('label', 'sel');
    const sel = h('select', 'input' + (isSet ? ' is-set' : ''));
    sel.setAttribute('aria-label', label);
    sel.dataset.id = id;
    pairs.forEach(([v, t]) => { const o = h('option', null, t); o.value = v; if (v === value) o.selected = true; sel.appendChild(o); });
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    wrap.appendChild(sel);
    return wrap;
  }
  let sumNote = null;
  // The bar under the heading: the time range and the card filters, then how many cards are left and Clear filters.
  function sumFilterBar(m) {
    const f = m.filters, ch = m.choices;
    const bar = h('div', 'sum-filters');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Summary filters');
    bar.appendChild(sumSelect('sum-range', 'Time range of the chart', SUM_RANGES.map((n) => [String(n), 'Last ' + n + ' weeks']), String(f.range), f.range !== SUM_RANGE, (v) => sumSet({ range: Number(v) })));
    const add = (key, id, label, all, pairs, min) => {
      if (pairs.length < min && f[key] === '') return;
      bar.appendChild(sumSelect(id, label, [['', all]].concat(pairs), f[key], f[key] !== '', (v) => sumSet({ [key]: v })));
    };
    add('milestone', 'sum-milestone', 'Filter cards by milestone', 'All milestones', ch.milestones.concat([[NO_MS, 'No milestone']]), 2);
    add('worker', 'sum-worker', 'Filter cards by worker', 'All workers', ch.workers.map((w) => [w, w]), 2);
    add('type', 'sum-type', 'Filter cards by type', 'All types', ch.types, 2);
    add('priority', 'sum-priority', 'Filter cards by priority', 'All priorities', ch.priorities, 2);
    add('label', 'sum-label', 'Filter cards by label', 'All labels', ch.labels.map((l) => [l, l]), 2);
    // one live region for the page's life, so that a change in it is announced; the bar around it is made anew
    if (!sumNote) { sumNote = h('span', 'toolbar-note'); sumNote.setAttribute('aria-live', 'polite'); }
    const note = sumNote;
    note.replaceChildren();
    if (m.filtering) note.appendChild(h('span', 'tnum tb-count', m.cards + ' of ' + m.total + (m.total === 1 ? ' card' : ' cards')));
    if (m.filtering || f.range !== SUM_RANGE) note.appendChild(plainBtn('Clear filters', 'small', sumClear));
    bar.appendChild(note);
    return bar;
  }

  // ---- the line chart ----
  // Three series: created and done per week on one axis, and the cards still open at the end of each week on a second, shorter plot below
  // it with its own axis (the backlog is usually many times a week's flow, and one shared axis would flatten the two lines that matter).
  // Each series has its own colour, line style and marker shape, so none depends on colour alone.
  const SUM_SERIES = [
    { key: 'created', label: 'Created', mark: 'circle' },
    { key: 'done', label: 'Done', mark: 'diamond' },
    { key: 'open', label: 'Open at week end', mark: 'triangle' },
  ];
  // k scales the marker down when the weeks are many
  function sumMark(kind, cx, cy, cls, k) {
    const u = k || 1;
    if (kind === 'circle') return svgEl('circle', { cx, cy, r: 3.5 * u, class: cls });
    const a = 5 * u, b = 4 * u;
    const d = kind === 'diamond' ? ['M', cx, cy - a, 'L', cx + a, cy, 'L', cx, cy + a, 'L', cx - a, cy, 'Z'] : ['M', cx, cy - a, 'L', cx + a, cy + b, 'L', cx - a, cy + b, 'Z'];
    return svgEl('path', { d: d.join(' '), class: cls });
  }
  const sumDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const sumWeekText = (w) => sumDate(w.start) + ' to ' + sumDate(w.end - 1);

  function weeksChart(m) {
    const n = m.weeks.length;
    const W = 420, H = 248, L = 34, R = 10, PAD = 8;
    const T1 = 12, H1 = 120, T2 = 170, H2 = 48;
    const step = (W - L - R - 2 * PAD) / (n - 1);
    const x = (i) => L + PAD + i * step;
    const yOf = { created: (v) => T1 + H1 - v / m.scale.top * H1, done: (v) => T1 + H1 - v / m.scale.top * H1, open: (v) => T2 + H2 - v / m.openScale.top * H2 };
    const first = m.weeks[0], last = m.weeks[n - 1];
    const created = m.weeks.reduce((k, w) => k + w.created, 0), done = m.weeks.reduce((k, w) => k + w.done, 0);

    const box = h('div', 'sum-chart');
    box.tabIndex = 0;
    box.dataset.id = 'sum-chart';   // the pane gives the focus back to it after a redraw
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Weekly chart. Use the left and right arrow keys to step through the weeks, Home and End to jump to the first and last, and Escape to close the details.');
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'sum-svg', role: 'img',
      'aria-label': 'Line chart of cards created, done and still open, week by week over the last ' + n + ' weeks: ' + created + ' created and ' + done + ' done in all; open went from ' + first.open + ' to ' + last.open + ' cards. The table has each week.' });
    const grid = (ticks, y) => ticks.forEach((v) => {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      svg.appendChild(svgEl('text', { x: L - 5, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(v)));
    });
    grid(m.scale.ticks, yOf.created);
    grid(m.openScale.ticks.filter((_, i) => i % 2 === 0), yOf.open);
    svg.appendChild(svgEl('text', { x: L, y: T2 - 10, class: 'cap' }, 'Open at the end of the week'));
    // week labels: every few weeks when they would run into each other, counted back from the current week so that one is always named
    const every = Math.max(1, Math.ceil(46 / step));
    m.weeks.forEach((w, i) => { if ((n - 1 - i) % every === 0) svg.appendChild(svgEl('text', { x: x(i), y: T2 + H2 + 18, 'text-anchor': 'middle', class: 'tick' }, sumDate(w.start))); });

    const guide = svgEl('line', { x1: 0, x2: 0, y1: T1, y2: T2 + H2, class: 'guide' });
    svg.appendChild(guide);
    const pts = [];
    SUM_SERIES.forEach((s) => {
      svg.appendChild(svgEl('polyline', { points: m.weeks.map((w, i) => x(i) + ',' + yOf[s.key](w[s.key])).join(' '), class: 'ln ln-' + s.key, fill: 'none' }));
    });
    m.weeks.forEach((w, i) => pts.push(SUM_SERIES.map((s) => {
      const mk = sumMark(s.mark, x(i), yOf[s.key](w[s.key]), 'pt pt-' + s.key, n > 14 ? 0.7 : 1);
      svg.appendChild(mk);
      return mk;
    })));
    box.appendChild(svg);

    const tip = h('div', 'sum-tip');
    tip.setAttribute('aria-hidden', 'true');
    tip.hidden = true;
    // what a screen reader hears: only when the week was chosen with the keyboard, not on every move of the mouse
    const live = h('div', 'sr-only');
    live.setAttribute('aria-live', 'polite');
    box.append(tip, live);

    const ui = sumUi();
    const rowsOf = (w, i) => SUM_SERIES.map((s) => [s.key === 'open' && i === n - 1 ? 'Open now' : s.label, w[s.key]]);   // the current week has not ended
    let at = -1;
    function show(i, announce) {
      at = i;
      ui.week = i;
      tip.hidden = i < 0;
      guide.setAttribute('class', i < 0 ? 'guide' : 'guide on');
      pts.forEach((col, j) => col.forEach((mk, k) => mk.setAttribute('class', 'pt pt-' + SUM_SERIES[k].key + (j === i ? ' on' : ''))));
      if (i < 0) return;
      guide.setAttribute('x1', x(i));
      guide.setAttribute('x2', x(i));
      const w = m.weeks[i];
      const rows = rowsOf(w, i);
      tip.replaceChildren(
        h('div', 'sum-tip-head', 'Week of ' + sumWeekText(w)),
        ...rows.map(([label, v]) => { const r = h('div', 'sum-tip-row'); r.append(h('span', null, label), h('span', 'tnum', String(v))); return r; }),
      );
      // beside the guide line, on the side with room, and never outside the chart
      const gx = x(i) / W * (box.offsetWidth || 0), tw = tip.offsetWidth || 0, bw = box.offsetWidth || 0;
      const side = bw && tw ? (gx + 10 + tw <= bw ? 'to-right' : 'to-left') : (i > (n - 1) / 2 ? 'to-left' : 'to-right');
      tip.className = 'sum-tip ' + side;
      tip.style.left = bw && tw ? Math.max(0, Math.min(bw - tw, side === 'to-right' ? gx + 10 : gx - 10 - tw)) + 'px' : (x(i) / W * 100) + '%';
      if (announce) live.textContent = 'Week of ' + sumWeekText(w) + ': ' + rows.map(([label, v]) => label + ' ' + v).join(', ');
    }
    const weekUnder = (e) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return -1;
      const u = (e.clientX - r.left) / r.width * W;
      return Math.min(n - 1, Math.max(0, Math.round((u - L - PAD) / step)));
    };
    const aim = (e) => { const i = weekUnder(e); if (i >= 0 && i !== at) show(i, false); };
    box.addEventListener('pointermove', aim);
    box.addEventListener('pointerdown', aim);
    box.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && document.activeElement !== box) show(-1); });
    // a swipe that scrolls the page is cancelled by the browser, and a touch that ends on a chart that did not take the focus has nothing to keep
    box.addEventListener('pointercancel', () => show(-1));
    box.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch' && document.activeElement !== box) show(-1); });
    box.addEventListener('focus', () => { if (at < 0) show(ui.week >= 0 && ui.week < n ? ui.week : n - 1, true); });
    // a redraw takes the focused chart out of the page, which is not the user leaving it: once the redraw is over the old chart is no longer
    // in the page, and only a chart that is still there and has lost the focus puts its tooltip away
    box.addEventListener('blur', () => { Promise.resolve().then(() => { if (box.isConnected !== false && document.activeElement !== box) show(-1); }); });
    box.addEventListener('keydown', (e) => {
      const to = e.key === 'ArrowRight' ? (at < 0 ? n - 1 : Math.min(n - 1, at + 1)) : e.key === 'ArrowLeft' ? (at < 0 ? n - 1 : Math.max(0, at - 1))
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'Escape' && at >= 0 ? -1 : null;
      if (to === null) return;
      e.preventDefault();
      if (to !== at) show(to, true);
    });
    // the page drew the chart again for new data: the week that was shown stays shown
    if (ui.week >= 0 && ui.week < n) show(ui.week, false);
    else ui.week = -1;
    return box;
  }
  function sumLegend() {
    const key = h('div', 'sum-legend');
    SUM_SERIES.forEach((s) => {
      const k = h('span', 'sum-key');
      const sw = svgEl('svg', { viewBox: '0 0 28 12', width: 28, height: 12, class: 'sum-swatch', 'aria-hidden': 'true' });
      sw.appendChild(svgEl('line', { x1: 1, x2: 27, y1: 6, y2: 6, class: 'ln ln-' + s.key }));
      sw.appendChild(sumMark(s.mark, 14, 6, 'pt pt-' + s.key));
      k.append(sw, h('span', null, s.label));
      key.appendChild(k);
    });
    return key;
  }
  // The same numbers as the chart, as a table
  function sumTable(m) {
    const t = h('table', 'sum-table');
    const cap = h('caption', 'sr-only', 'Cards created, done and open at the end of each week');
    const head = h('tr');
    ['Week', 'Created', 'Done', 'Open at week end'].forEach((c, i) => { const th = h('th', i ? 'tnum' : '', c); th.scope = 'col'; head.appendChild(th); });
    const body = h('tbody');
    m.weeks.forEach((w, i) => {
      const tr = h('tr');
      const th = h('th', null, sumWeekText(w) + (i === m.weeks.length - 1 ? ' (open now)' : ''));
      th.scope = 'row';
      tr.appendChild(th);
      ['created', 'done', 'open'].forEach((k) => tr.appendChild(h('td', 'tnum', String(w[k]))));
      body.appendChild(tr);
    });
    const thead = h('thead');
    thead.appendChild(head);
    t.append(cap, thead, body);
    return t;
  }
  // ---- end the line chart ----

  function renderSummary() {
    const m = summaryModel(current.cards, cfg(), Date.now(), sumFilters());
    sumSettle(m);
    const wrap = h('section', 'sum');
    const head = h('div', 'home-head');
    head.append(h('h2', 'home-title', 'Summary'), h('span', 'muted tnum', m.total + (m.total === 1 ? ' card' : ' cards')));
    wrap.appendChild(head);
    if (!m.empty) wrap.appendChild(sumFilterBar(m));

    const tiles = h('div', 'sum-tiles');
    const t = m.tiles;
    tiles.append(
      sumTile('Open', t.open, false, '', 'Cards that are not in the done stage or a later one'),
      sumTile(t.workingLabel, t.working, false, '', 'Cards in the ' + t.workingLabel + ' stage'),
      sumTile('Done, last ' + SUM_DONE_DAYS + ' days', t.doneRecent, false, '', 'Cards completed (moved into the done stage or a later one) in the last ' + SUM_DONE_DAYS + ' days'),
      sumTile('Open bugs', t.bugs, true, '', 'Open cards of type bug'),
      sumTile('Waiting for you', t.waiting, true, t.waiting > 0 ? hashFor(selKey, 'waiting') : '', 'Items Claude is waiting on you for'),
    );
    wrap.appendChild(tiles);

    if (m.empty) {
      const box = h('div', 'sum-empty');
      box.appendChild(h('p', null, 'No cards in this project yet. The charts fill in as cards are added and finished.'));
      const link = h('a', 'btn', 'Open the Board');
      link.href = hashFor(selKey, 'board');
      box.appendChild(link);
      wrap.appendChild(box);
      wrap.appendChild(aboutNote());
      elPane.appendChild(wrap);
      return;
    }

    const grid = h('div', 'sum-cols');
    const left = h('div', 'sum-col'), right = h('div', 'sum-col');
    grid.append(left, right);

    const flow = sumPanel('sum-flow', 'Created, done and open by week', 'Last ' + m.weeks.length + ' weeks, weeks start on Monday. Open is how many cards were still open when the week ended.');
    if (m.weeks.some((w) => w.created || w.done || w.open)) {
      flow.appendChild(weeksChart(m));
      flow.appendChild(sumLegend());
      const ui = sumUi();
      const tbl = sumTable(m);
      tbl.id = 'sum-table';
      tbl.hidden = !ui.table;
      const tog = h('button', 'btn small sum-table-btn', ui.table ? 'Hide table' : 'Show as table');
      tog.type = 'button';
      tog.setAttribute('aria-expanded', ui.table ? 'true' : 'false');
      tog.setAttribute('aria-controls', 'sum-table');
      tog.addEventListener('click', () => {
        ui.table = !ui.table;
        tbl.hidden = !ui.table;
        tog.textContent = ui.table ? 'Hide table' : 'Show as table';
        tog.setAttribute('aria-expanded', ui.table ? 'true' : 'false');
      });
      flow.append(tog, tbl);
    } else flow.appendChild(h('p', 'sum-none muted', 'Nothing was created or finished in these weeks, and nothing is open.'));
    left.appendChild(flow);

    const who = sumPanel('sum-who', 'Work by worker', 'Done cards and tokens, all time. Work by the main session shows only where Claude recorded a worker.');
    if (m.workers.length) {
      const ul = h('ul', 'sum-rows');
      m.workers.forEach((r) => {
        const li = h('li', 'sum-row');
        const name = h('span', 'sum-name', r.name);
        name.title = r.name;
        const bars = h('div', 'sum-bars');
        const line = (label, cls, frac, text) => {
          const l = h('div', 'sum-line');
          const track = h('span', 'sum-track');
          track.setAttribute('aria-hidden', 'true');
          const fill = h('i', cls);
          fill.style.width = Math.round(100 * frac) + '%';
          if (frac > 0) track.appendChild(fill);
          l.append(h('span', 'sum-lab muted', label), track, h('span', 'sum-val tnum', text));
          return l;
        };
        bars.append(
          line('done', 'fill-done', m.workersMaxDone ? r.done / m.workersMaxDone : 0, String(r.done)),
          line('tokens', 'fill-tokens', m.workersMaxTokens ? r.tokens / m.workersMaxTokens : 0, r.tokens ? fmtTokens(r.tokens) : '–'),
        );
        li.append(name, bars);
        ul.appendChild(li);
      });
      who.appendChild(ul);
      if (m.workersMore > 0) who.appendChild(h('p', 'sum-more muted', 'and ' + m.workersMore + ' more'));
    } else who.appendChild(h('p', 'sum-none muted', 'No work by a recorded worker yet.'));
    right.appendChild(who);

    const wait = sumPanel('sum-wait', 'Waiting for you', 'Oldest first.');
    if (m.waits.length) {
      const ul = h('ul', 'sum-waits');
      m.waits.forEach((w) => {
        const li = h('li');
        const a = h('a', 'sum-wait-item');
        a.href = hashFor(selKey, w.card);
        bindCardLink(a, w.card, () => {
          waitsFor = w.card;
          setTimeout(() => { if (waitsFor === w.card) waitsFor = ''; }, 1500);
        });
        const top = h('span', 'sum-wait-top');
        top.append(waitKindMark(w.kind, false), h('span', 'idchip', w.card), h('span', 'grow'));
        if (w.askedAt) top.appendChild(timeEl(w.askedAt));
        a.append(top, h('span', 'sum-wait-text', plainMd(w.text)));
        li.appendChild(a);
        ul.appendChild(li);
      });
      wait.appendChild(ul);
      if (m.waitsMore > 0) {
        const more = h('a', 'sum-more', 'and ' + m.waitsMore + ' more on the Waiting view');
        more.href = hashFor(selKey, 'waiting');
        wait.appendChild(more);
      }
    } else wait.appendChild(h('p', 'sum-none muted', 'Nothing is waiting for you.'));
    left.appendChild(wait);

    const ms = sumPanel('sum-ms', 'Milestones');
    if (m.milestones.length) {
      const ul = h('ul', 'sum-ms-list');
      m.milestones.forEach((x) => {
        const li = h('li');
        const a = h('a', 'sum-ms-item');
        a.href = hashFor(selKey, x.id);
        bindCardLink(a, x.id);
        const top = h('span', 'sum-ms-top');
        top.append(h('span', 'idchip', x.id), h('span', 'sum-ms-title', x.title), msStateTag(x.state));
        a.append(top, progressEl({ done: x.done, total: x.total }));
        li.appendChild(a);
        ul.appendChild(li);
      });
      ms.appendChild(ul);
      if (m.milestonesMore > 0) {
        const more = h('a', 'sum-more', 'and ' + m.milestonesMore + ' more on the Milestones view');
        more.href = hashFor(selKey, 'milestones');
        ms.appendChild(more);
      }
    } else ms.appendChild(h('p', 'sum-none muted', m.filters.milestone === NO_MS ? 'The filter shows cards in no milestone, so no milestone is listed.' : m.filtering ? 'No milestone has a card that matches the filters.' : 'No milestones in this project yet.'));
    right.appendChild(ms);

    const st = sumPanel('sum-stage', 'Time in a stage', 'The median time a card stayed in a stage before it was moved on.');
    if (m.stages.length) {
      const ul = h('ul', 'sum-stages');
      m.stages.forEach((s) => {
        const li = h('li');
        li.append(h('span', 'sum-stage-name', s.label), h('span', 'grow'), h('span', 'tnum', spanText(s.median)), h('span', 'sum-stage-n muted tnum', s.n + (s.n === 1 ? ' move' : ' moves')));
        ul.appendChild(li);
      });
      st.appendChild(ul);
    } else st.appendChild(h('p', 'sum-none muted', 'Not enough moves between stages yet.'));
    left.appendChild(st);

    wrap.append(grid, aboutNote());
    elPane.appendChild(wrap);
  }

  function aboutNote() {
    const p = sumPanel('sum-about', 'About these numbers');
    const ul = h('ul', 'sum-notes muted');
    [
      'A card keeps the last 50 entries of its history. An older card may show only when it was created, and a move that fell out of the history is not counted.',
      'A card counts as done on the day it last moved into the done stage or a later one from an earlier stage; if that move is not in the history, on the day it was last updated.',
      'Work by the main session shows only where Claude recorded a worker. Tokens come from sub-agent runs and thread turns, not from the main session.',
      'The filters apply to every number here, and the time range sets only the weeks of the chart; the Done tile always counts the last ' + SUM_DONE_DAYS + ' days.',
      'Open at the end of a week counts the cards created before it that were not yet completed. A card that was done, then reopened, shows as open for the whole time. The line can be a little lower than the Open tile: a card with no creation time is on the tile but cannot be placed on the line.',
      'Weeks start on Monday in this browser’s time zone.',
    ].forEach((t) => ul.appendChild(h('li', null, t)));
    p.appendChild(ul);
    return p;
  }
  // ---- end summary page ----
