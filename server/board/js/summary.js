  // ---------- the Summary view ----------

  // ---- summary (summary-page.test.mjs runs this block on its own, after the "tokens and agents" and "milestones and stages" blocks) ----
  // What the Summary shows is worked out here from the cards the page already has; nothing is asked of the server. Dates are local:
  // a week runs from Monday 00:00 to the next Monday 00:00 in the browser's time zone.
  const SUM_WEEKS = 8;          // weeks in the chart, the current one last
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
  // Everything the Summary shows. cards: the project's cards; config: its stages and roles; now: ms.
  function summaryModel(cards, config, now) {
    const roles = config.roles;
    const list = (Array.isArray(cards) ? cards : []).filter((c) => c && typeof c === 'object');
    const work = list.filter((c) => c.kind !== 'milestone');
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

    const edges = weekEdges(now, SUM_WEEKS);
    const weeks = edges.slice(0, -1).map((start) => ({ start, created: 0, done: 0 }));
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
      if (c.kind === 'thread' && c.thread) {
        const th = c.thread;
        const name = typeof th.agent === 'string' && th.agent ? derivedWorker('agent:', th.agent)
          : th.lane && typeof th.lane.name === 'string' && th.lane.name ? derivedWorker('lane:', th.lane.name) : 'thread';
        addTokens(name, threadTokens(Array.isArray(th.turns) ? th.turns : []));
      }
    });
    const rows = [...byWorker.values()].map((r) => ({ name: r.name, done: r.done, tokens: r.in + r.out }))
      .filter((r) => r.done > 0 || r.tokens > 0)
      .sort((a, b) => b.done - a.done || b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const shown = rows.slice(0, SUM_WORKERS);

    const spent = new Map();
    work.forEach((c) => stageTimes(c).forEach(([stage, ms]) => { if (!spent.has(stage)) spent.set(stage, []); spent.get(stage).push(ms); }));
    const stages = config.stages.filter((s) => !stageFinishedIn(config, s.id) && spent.has(s.id))
      .map((s) => ({ id: s.id, label: s.label, n: spent.get(s.id).length, median: median(spent.get(s.id)) }));

    // the order the Milestones view lists them in, before the panel keeps its first few
    const milestones = milestonesOrdered(list.filter((c) => c.kind === 'milestone'), list, config).map((m) => ({ id: m.id, title: String(m.title || m.id), state: msStateOf(m, list, config), ...progressOf(list, m.id, config) }));
    const working = stageOf(roles.working);
    return {
      empty: list.length === 0,
      cards: work.length,
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

  // Created and done per week as pairs of bars: a hollow bar for created, a solid one for done, each with its number on top.
  function weeksChart(m) {
    const W = 400, H = 210, L = 30, R = 8, T = 18, B = 30;
    const plotW = W - L - R, plotH = H - T - B;
    const gw = plotW / m.weeks.length, bw = Math.min(14, (gw - 8) / 2);
    const y = (v) => T + plotH - v / m.scale.top * plotH;
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const created = m.weeks.reduce((n, w) => n + w.created, 0), done = m.weeks.reduce((n, w) => n + w.done, 0);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'sum-svg', role: 'img', 'aria-label': 'Cards created and done per week over the last ' + m.weeks.length + ' weeks: ' + created + ' created, ' + done + ' done.' });
    m.scale.ticks.forEach((v) => {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      svg.appendChild(svgEl('text', { x: L - 5, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(v)));
    });
    m.weeks.forEach((w, i) => {
      const g = svgEl('g');
      const cx = L + gw * i + gw / 2;
      g.appendChild(svgEl('title', {}, 'Week of ' + fmt(w.start) + ': ' + w.created + ' created, ' + w.done + ' done'));
      [['created', w.created, cx - bw - 1], ['done', w.done, cx + 1]].forEach(([kind, v, x]) => {
        if (v > 0) {
          g.appendChild(svgEl('rect', { x, y: y(v), width: bw, height: y(0) - y(v), rx: 2, class: 'bar-' + kind }));
          g.appendChild(svgEl('text', { x: x + bw / 2, y: y(v) - 4, 'text-anchor': 'middle', class: 'val' }, String(v)));
        }
      });
      g.appendChild(svgEl('text', { x: cx, y: H - 10, 'text-anchor': 'middle', class: 'tick' }, fmt(w.start)));
      svg.appendChild(g);
    });
    return svg;
  }

  function renderSummary() {
    const m = summaryModel(current.cards, cfg(), Date.now());
    const wrap = h('section', 'sum');
    const head = h('div', 'home-head');
    head.append(h('h2', 'home-title', 'Summary'), h('span', 'muted tnum', m.cards + (m.cards === 1 ? ' card' : ' cards')));
    wrap.appendChild(head);

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

    const flow = sumPanel('sum-flow', 'Created and done per week', 'Last ' + m.weeks.length + ' weeks, weeks start on Monday.');
    if (m.weeks.some((w) => w.created || w.done)) {
      flow.appendChild(weeksChart(m));
      const key = h('div', 'sum-legend');
      const a = h('span', 'sum-key'), b = h('span', 'sum-key');
      a.append(h('span', 'swatch created'), h('span', null, 'Created'));
      b.append(h('span', 'swatch done'), h('span', null, 'Done'));
      key.append(a, b);
      flow.appendChild(key);
    } else flow.appendChild(h('p', 'sum-none muted', 'Nothing was created or finished in these weeks.'));
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
        a.append(top, h('span', 'sum-wait-text', w.text));
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
    } else ms.appendChild(h('p', 'sum-none muted', 'No milestones in this project yet.'));
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
      'Weeks start on Monday in this browser’s time zone.',
    ].forEach((t) => ul.appendChild(h('li', null, t)));
    p.appendChild(ul);
    return p;
  }
  // ---- end summary page ----
