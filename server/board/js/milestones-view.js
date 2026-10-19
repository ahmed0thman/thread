  // ---------- the Milestones view: each milestone with its progress, its stages in numbers and its open cards ----------

  // ---- milestone view model (list-page.test.mjs runs this block on its own, with the "milestones and stages" block) ----
  const MS_OPEN_SHOWN = 5;    // open cards listed under a milestone; the rest are counted
  // The cards that count under a milestone (not its ideas) by what the stage's role says. Done: the done stage and any stage after it.
  // In progress: the working and review stages. To do: every other stage (new, blocked, a stage of your own). `open` is every counted
  // card not done, in stage order and then by number.
  function milestoneStats(cards, m, config) {
    const kids = countedKids(cards, m.id);
    const r = config.roles;
    const order = (c) => { const i = config.stages.findIndex((s) => s.id === c.status); return i < 0 ? config.stages.length : i; };
    const num = (c) => { const m = /^c(\d+)$/.exec(String(c.id)); return m ? Number(m[1]) : Date.parse(c.createdAt) || 0; };   // as cardNum in the list model
    const out = { total: kids.length, todo: 0, working: 0, done: 0, open: [] };
    kids.forEach((c) => {
      if (finishedIn(c, config)) out.done++;
      else {
        if (c.status === r.working || c.status === r.review) out.working++; else out.todo++;
        out.open.push(c);
      }
    });
    out.open.sort((a, b) => order(a) - order(b) || num(a) - num(b));
    out.shown = out.open.slice(0, MS_OPEN_SHOWN);
    out.more = out.open.length - out.shown.length;
    return out;
  }
  // What the view draws, as plain data: each milestone with its numbers, the open cards it lists and the name of their stages. The pane is
  // drawn again only when this changes, so an edit to a card that is not listed (a note, a label, a card of another milestone) does not.
  function milestonesShown(list, cards, config) {
    const stageName = {};
    config.stages.forEach((s) => { stageName[s.id] = s.label; });
    return list.map((m) => {
      const st = milestoneStats(cards, m, config);
      return [m.id, m.title, msStateOf(m, cards, config), milestoneWaits(cards, m.id).map((w) => w.kind).sort().join(), st.total, st.todo, st.working, st.done, st.more, st.shown.map((c) => [c.id, c.title, stageName[c.status] || c.status, (workState(c) || {}).sig || ''])];
    });
  }
  // ---- end milestone view model ----


  // The key of the pane: the milestones in number order with their numbers and open cards, the map's edges, and what is picked.
  function milestonesPaneKey() {
    if (!current) return JSON.stringify(['milestones', selKey, null]);
    const conf = cfg();
    const list = milestonesByNumber(milestoneCards());
    const map = milestoneMap(list, current.cards, conf);
    const u = msUi();
    return JSON.stringify(['milestones', selKey, u.mode, u.mode === 'map' ? msMapPick(map, u.sel) : '', milestonesShown(list, current.cards, conf), msMapSig(map)]);
  }

  // One milestone as a block: its title (a link to its page) with a state tag, progress, waiting items, `rel` (what it depends on),
  // the counts per stage role and up to MS_OPEN_SHOWN open cards. The Cards view lists one per milestone; the map shows the picked one.
  function msItem(m, conf, tag, cls, rel) {
    const st = milestoneStats(current.cards, m, conf);
    const li = h(tag, cls);
    if (tag === 'li') li.dataset.id = m.id;
    const a = h('a', 'ms-item-head');
    a.href = hashFor(selKey, m.id);
    bindCardLink(a, m.id);
    a.append(h('span', 'idchip', m.id), h('span', 'ms-item-title', m.title), msStateTag(msStateOf(m, current.cards, conf)));
    li.appendChild(a);
    li.appendChild(progressEl({ done: st.done, total: st.total }));
    const wt = waitTag(milestoneWaits(current.cards, m.id), 'milestone');
    if (wt) li.appendChild(wt);
    if (rel) li.appendChild(rel);
    if (st.total) {
      const counts = h('dl', 'ms-counts tnum');
      [['To do', st.todo], ['In progress', st.working], ['Done', st.done]].forEach(([k, n]) => {
        const box = h('div');
        box.append(h('dt', null, k), h('dd', null, String(n)));
        counts.appendChild(box);
      });
      li.appendChild(counts);
    }
    if (st.shown.length) {
      li.appendChild(h('h3', 'ms-open-title', 'Open cards'));
      const open = h('ul', 'ms-open');
      st.shown.forEach((c) => {
        const row = h('li');
        const link = h('a', 'ms-open-link');
        link.href = hashFor(selKey, c.id);
        bindCardLink(link, c.id);
        const work = workState(c);
        link.append(h('span', 'idchip', c.id), h('span', 'ms-open-text', c.title));
        if (work) link.appendChild(workEl(work, 'dot'));
        link.appendChild(h('span', 'ms-open-stage muted', label(c.status)));
        row.appendChild(link);
        open.appendChild(row);
      });
      if (st.more > 0) {
        const row = h('li');
        const all = plainBtn('and ' + st.more + ' more', 'small ghost', () => { milestoneSel = m.id; goView('list'); });
        all.title = 'Show every card of this milestone in the List';
        row.appendChild(all);
        open.appendChild(row);
      }
      li.appendChild(open);
    } else if (st.total) li.appendChild(h('p', 'muted ms-allDone', 'Every card is done.'));
    return li;
  }

  // The view: a line on where the project stands, then the map (or every milestone as a block), always in number order.
  function renderMilestones() {
    const conf = cfg();
    const list = milestonesByNumber(milestoneCards());
    const map = milestoneMap(list, current.cards, conf);
    const u = msUi();
    const wrap = h('section', 'ms-view');
    const head = h('div', 'home-head ms-head');
    head.appendChild(h('h2', 'home-title', 'Milestones'));
    head.appendChild(h('span', 'muted tnum', list.length + (list.length === 1 ? ' milestone' : ' milestones')));
    if (list.length) {
      const modes = h('div', 'ms-modes');
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', 'Show the milestones as');
      [['map', 'Map'], ['cards', 'Cards']].forEach(([v, t]) => {
        const b = plainBtn(t, 'small ghost', () => { if (u.mode !== v) { u.mode = v; renderPane(); } });
        b.setAttribute('aria-pressed', u.mode === v ? 'true' : 'false');
        modes.appendChild(b);
      });
      head.appendChild(modes);
    }
    wrap.appendChild(head);
    if (!list.length) {
      wrap.appendChild(h('p', 'muted', 'No milestones in this project yet.'));
      elPane.appendChild(wrap);
      return;
    }
    // at a glance: how many are done, where the project is, and what waits for you
    const doneN = map.nodes.filter((n) => n.state === 'done').length;
    const now = map.nodes.filter((n) => n.now);
    const waits = list.reduce((s, m) => s + milestoneWaits(current.cards, m.id).length, 0);
    const glance = h('p', 'ms-glance');
    glance.appendChild(h('span', 'tnum', doneN + ' of ' + list.length + ' done'));
    const openN = map.nodes.filter((n) => n.state === 'open').length;
    const stuck = map.nodes.filter((n) => n.cycle && n.state !== 'done');
    glance.appendChild(h('span', null, now.length ? 'Now: ' + now.map(msName).join(', ')
      : doneN === list.length ? 'Every milestone is done'
        : openN ? openN + ' open, none ready' + (stuck.length ? ' (a cycle: ' + stuck.map(msName).join(', ') + ')' : '')
          : 'Nothing is open'));
    if (waits) glance.appendChild(h('span', 'tnum', waits + ' waiting for you'));
    if (map.mode === 'deps') glance.appendChild(h('span', 'tnum muted', msPlural(map.edges.length, 'dependency', 'dependencies') + ' from ' + msPlural(map.edges.reduce((s, e) => s + e.links.length, 0), 'card link', 'card links')));
    wrap.appendChild(glance);
    let after = null;
    if (u.mode === 'map') after = renderMsMap(wrap, map, list, u);
    else {
      const at = new Map(map.nodes.map((n) => [n.id, n]));
      const ul = h('ul', 'ms-items');
      list.forEach((m) => {
        const n = at.get(m.id);
        const rel = map.mode === 'deps' ? h('p', 'ms-rel-row muted', 'Depends on: ' + (n.deps.length ? msNames(map, n.deps).join(', ') : 'nothing')) : null;
        ul.appendChild(msItem(m, conf, 'li', 'ms-item', rel));
      });
      wrap.appendChild(ul);
    }
    elPane.appendChild(wrap);
    if (after) after();
  }
