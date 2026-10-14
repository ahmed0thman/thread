  // ---------- the Milestones view: each milestone with its progress, its stages in numbers and its open cards ----------

  // ---- milestone view model (list-page.test.mjs runs this block on its own, with the "milestones and stages" block) ----
  const MS_OPEN_SHOWN = 5;    // open cards listed under a milestone; the rest are counted
  // The cards under a milestone by what the stage's role says. Done: the done stage. In progress: the working and review stages.
  // To do: every other stage (new, blocked, ideas, a stage of your own). `open` is every card not done, in stage order and then by number.
  function milestoneStats(cards, m, config) {
    const kids = childrenOf(cards, m.id);
    const r = config.roles;
    const order = (c) => { const i = config.stages.findIndex((s) => s.id === c.status); return i < 0 ? config.stages.length : i; };
    const num = (c) => parseInt(String(c.id).replace(/\D/g, ''), 10) || 0;
    const out = { total: kids.length, todo: 0, working: 0, done: 0, open: [] };
    kids.forEach((c) => {
      if (c.status === r.done) out.done++;
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
      return [m.id, m.title, st.total, st.todo, st.working, st.done, st.more, st.shown.map((c) => [c.id, c.title, stageName[c.status] || c.status])];
    });
  }
  // ---- end milestone view model ----

  function milestonesPaneKey() { return JSON.stringify(['milestones', selKey, current ? milestonesShown(milestoneCards(), current.cards, cfg()) : null]); }

  function renderMilestones() {
    const list = milestoneCards();
    const conf = cfg();
    const stageName = (c) => label(c.status);
    const wrap = h('section', 'ms-view');
    const head = h('div', 'home-head');
    head.appendChild(h('h2', 'home-title', 'Milestones'));
    head.appendChild(h('span', 'muted tnum', list.length + (list.length === 1 ? ' milestone' : ' milestones')));
    wrap.appendChild(head);
    if (!list.length) wrap.appendChild(h('p', 'muted', 'No milestones in this project yet.'));
    const ul = h('ul', 'ms-items');
    list.forEach((m) => {
      const st = milestoneStats(current.cards, m, conf);
      const li = h('li', 'ms-item');
      li.dataset.id = m.id;
      const a = h('a', 'ms-item-head');
      a.href = hashFor(selKey, m.id);
      bindCardLink(a, m.id);
      a.append(h('span', 'idchip', m.id), h('span', 'ms-item-title', m.title));
      li.appendChild(a);
      li.appendChild(progressEl({ done: st.done, total: st.total }));
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
          link.append(h('span', 'idchip', c.id), h('span', 'ms-open-text', c.title), h('span', 'ms-open-stage muted', stageName(c)));
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
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    elPane.appendChild(wrap);
  }
