  // ---------- the List view: a sortable, filterable table of the project's cards ----------

  // ---- list model (list-page.test.mjs runs this block on its own, with the "milestones and stages" block) ----
  // The number a card is ordered by: its count (c37 is 37) or, for a repo-backed project's random id (c8k2x1), its creation time, which is
  // greater than any count, so the older numbered cards come first and the others in the order they were made.
  function cardNum(c) {
    const m = /^c(\d+)$/.exec(String(c.id));
    return m ? Number(m[1]) : Date.parse(c.createdAt) || 0;
  }

  const PRIORITY_RANK = { high: 3, normal: 2, low: 1 };
  const PRIORITY_LABEL = { high: 'High', normal: 'Normal', low: 'Low' };
  const TYPE_ORDER = ['task', 'bug', 'idea', 'thread', 'milestone'];
  const TYPE_LABEL = { task: 'Task', bug: 'Bug', idea: 'Idea', thread: 'Thread', milestone: 'Milestone' };
  // What a card is in the Type column. A bug is a task (or idea) with the type field; a card of a kind this page does not know shows as a task.
  function rowType(c) {
    if (c.kind === 'milestone' || c.kind === 'thread' || c.kind === 'idea') return c.kind;
    return c.type === 'bug' ? 'bug' : 'task';
  }
  // 'agent:worker' -> 'agent worker'
  function workerText(w) { return String(w).replace(':', ' '); }
  // One row per card. Every field a card may lack (data from an older version) has a plain default: normal priority, no labels,
  // no blockers, nobody who worked on it.
  function listRows(cards, config) {
    const stageIdx = {}, stageName = {};
    config.stages.forEach((s, i) => { stageIdx[s.id] = i; stageName[s.id] = s.label; });
    const milestones = {}, byId = {};
    cards.forEach((c) => { byId[c.id] = c; if (c.kind === 'milestone') milestones[c.id] = c; });
    // blocked: at least one blocker that is not finished, i.e. not in the done stage or a later one (a blocker that is gone does not
    // count), as on the board's face
    const unfinished = (c) => (Array.isArray(c.blockedBy) ? c.blockedBy.filter((id) => typeof id === 'string' && id && byId[id] && !finishedIn(byId[id], config)) : []);
    return cards.map((c) => {
      const milestone = c.kind !== 'milestone' && c.parent && milestones[c.parent] ? milestones[c.parent] : null;
      const workers = Array.isArray(c.workedBy) ? c.workedBy.filter((w) => typeof w === 'string' && w) : [];
      const updatedMs = Date.parse(c.updatedAt);
      return {
        id: c.id,
        num: cardNum(c),
        card: c,
        type: rowType(c),
        bug: c.kind !== 'milestone' && c.type === 'bug',   // an idea or a thread keeps its bug mark beside its own type
        title: String(c.title || ''),
        status: c.status,
        stageLabel: stageName[c.status] || String(c.status),
        stageIdx: c.kind === 'milestone' || !(c.status in stageIdx) ? null : stageIdx[c.status],
        progress: c.kind === 'milestone' ? progressOf(cards, c.id, config) : null,
        msState: c.kind === 'milestone' ? msStateOf(c, cards, config) : null,
        priority: PRIORITY_RANK[c.priority] ? c.priority : 'normal',
        labels: Array.isArray(c.labels) ? c.labels.filter((l) => typeof l === 'string' && l) : [],
        milestoneId: milestone ? milestone.id : '',
        milestoneTitle: milestone ? String(milestone.title || '') : '',
        lastWorker: workers.length ? workers[workers.length - 1] : '',
        moreWorkers: Math.max(0, workers.length - 1),
        waits: c.kind === 'milestone' ? 0 : openWaitsOf(c).length,
        updated: typeof c.updatedAt === 'string' ? c.updatedAt : '',
        updatedMs: Number.isFinite(updatedMs) ? updatedMs : null,
        blockedBy: unfinished(c),
        unverified: c.verified === false,
        work: workState(c),
      };
    });
  }
  // What a row draws, as plain data. The List's pane key is made of these, so a change no row shows (a note, a history entry, a card of
  // another project) leaves the table alone.
  function listRowSig(r) {
    return [r.id, r.type, r.bug, r.title, r.status, r.stageLabel, r.progress, r.msState, r.priority, r.labels, r.milestoneId, r.milestoneTitle, r.lastWorker, r.moreWorkers, r.waits, r.updated, r.blockedBy, r.unverified, r.work ? r.work.sig : ''];
  }
  // The columns. `first` is the direction of the first click; `key` is what a row is compared by (null sorts last in either direction).
  // Priority and Waiting start with the most important at the top and Updated with the newest; the stage is in the order of the board's columns.
  const LIST_COLS = [
    { id: 'id', label: 'ID', first: 'asc', key: (r) => r.num },
    { id: 'type', label: 'Type', first: 'asc', key: (r) => TYPE_ORDER.indexOf(r.type) },
    { id: 'title', label: 'Title', first: 'asc', key: (r) => r.title.toLowerCase() || null },
    { id: 'stage', label: 'Stage', first: 'asc', key: (r) => r.stageIdx },
    { id: 'priority', label: 'Priority', first: 'desc', key: (r) => PRIORITY_RANK[r.priority] },
    { id: 'labels', label: 'Labels', first: 'asc', key: (r) => r.labels.length ? r.labels.slice().sort().join(' ') : null },
    { id: 'milestone', label: 'Milestone', first: 'asc', key: (r) => r.milestoneTitle.toLowerCase() || null },
    { id: 'worked', label: 'Worked by', first: 'asc', key: (r) => r.lastWorker ? workerText(r.lastWorker).toLowerCase() : null },
    { id: 'waiting', label: 'Waiting', first: 'desc', key: (r) => r.waits },
    { id: 'updated', label: 'Updated', first: 'desc', key: (r) => r.updatedMs },
  ];
  const LIST_DEFAULT_SORT = { col: 'updated', dir: 'desc' };
  // A new copy of the rows in the order of column `col`; equal rows go by card number, the same way round.
  function sortRows(rows, col, dir) {
    const spec = LIST_COLS.find((c) => c.id === col) || LIST_COLS.find((c) => c.id === LIST_DEFAULT_SORT.col);
    const sign = dir === 'asc' ? 1 : -1;
    return rows.slice().sort((x, y) => {
      // a milestone has no stage: in the Stage column the milestones come after every stage, open first, then empty, then done
      if (col === 'stage' && (x.msState !== null) !== (y.msState !== null)) return x.msState === null ? -1 : 1;
      if (col === 'stage' && x.msState !== null && x.msState !== y.msState) return MS_ORDER[x.msState] - MS_ORDER[y.msState];
      const a = spec.key(x), b = spec.key(y);
      if (a === null || b === null) {
        if (a === b) return sign * (x.num - y.num);
        return a === null ? 1 : -1;
      }
      const d = typeof a === 'string' ? a.localeCompare(b, undefined, { numeric: true }) : a - b;
      return d ? sign * d : sign * (x.num - y.num);
    });
  }
  // The sort a click on a header leads to: the same column reverses, another column starts in its own first direction.
  function nextSort(sort, col) {
    if (sort.col === col) return { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
    const spec = LIST_COLS.find((c) => c.id === col);
    return { col, dir: spec ? spec.first : 'asc' };
  }
  // "Bug" is the type field, whatever the kind: an idea or a thread that has it is listed (the Summary counts open bugs the same way).
  // The other types go by what the row shows.
  const isBugRow = (r) => r.card.kind !== 'milestone' && r.card.type === 'bug';
  const typeMatches = (r, t) => (t === 'bug' ? isBugRow(r) : r.type === t);
  // f: { q (lower case), session, milestone, type, priority, label, blocked, unverified }. The search, session and milestone filters are the board's.
  function listFilter(rows, f) {
    const base = { q: f.q || '', session: f.session || '', milestone: f.milestone || '' };
    return rows.filter((r) => matches(r.card, base)
      && (!f.type || typeMatches(r, f.type))
      && (!f.priority || r.priority === f.priority)
      && (!f.label || r.labels.includes(f.label))
      && (!f.blocked || r.blockedBy.length > 0)
      && (!f.unverified || r.unverified));
  }
  function listFiltering(f) { return !!(f.q || f.session || f.milestone || f.type || f.priority || f.label || f.blocked || f.unverified); }
  // What the selects offer: only values some card has, types and priorities in their own order, labels A to Z.
  function listChoices(rows) {
    const labels = [];
    rows.forEach((r) => r.labels.forEach((l) => { if (!labels.includes(l)) labels.push(l); }));
    return {
      types: TYPE_ORDER.filter((t) => rows.some((r) => typeMatches(r, t))),
      priorities: ['high', 'normal', 'low'].filter((p) => rows.some((r) => r.priority === p)),
      labels: labels.sort((a, b) => a.localeCompare(b)),
    };
  }
  // ---- end list model ----

  // The list's own state, kept per project: how it is sorted and the filters of the toolbar that are not the board's.
  const listMemo = {};
  function listUi() {
    return listMemo[selKey] || (listMemo[selKey] = { sort: Object.assign({}, LIST_DEFAULT_SORT), type: '', priority: '', label: '', blocked: false, unverified: false });
  }
  const elListFilters = $('list-filters'), elListType = $('ltype-filter'), elListPrio = $('lprio-filter'), elListLabel = $('llabel-filter');
  const elListBlocked = $('lblocked'), elListUnver = $('lunverified'), elListToggles = $('list-toggles');

  function listFilterState() {
    const u = listUi();
    return { q: elSearch.value.trim().toLowerCase(), session: sessionSel, milestone: milestoneSel, type: u.type, priority: u.priority, label: u.label, blocked: u.blocked, unverified: u.unverified };
  }
  // The pane is drawn again when this changes: the data, the sort, the filters.
  // It is made of what the table shows (each row, and which rows the search and filters keep: the search also reads the note), not of the whole
  // state, so the poll does not redraw the table when nothing in it changed. The session select's options are in it too.
  function listPaneKey() {
    if (!current) return JSON.stringify(['list', selKey]);
    const f = listFilterState();
    const all = listRows(current.cards, cfg());
    const parents = [];
    current.cards.forEach((c) => { if (isThread(c) && c.thread.parentSessionId && !parents.some((p) => p[0] === c.thread.parentSessionId)) parents.push([c.thread.parentSessionId, sessionLabel(c.thread.parentSessionId)]); });
    return JSON.stringify(['list', selKey, listUi(), f.q, sessionSel, milestoneSel, all.map(listRowSig), listFilter(all, f).map((r) => r.id), parents.sort()]);
  }

  const TYPE_SHAPE = { task: 's-square', bug: 's-beetle', idea: 's-diamond', thread: 's-ring', milestone: 's-tri' };
  function typeMark(type) {
    const km = h('span', 'kindmark type-mark');
    km.dataset.ck = type;
    km.appendChild(shape(TYPE_SHAPE[type] || 's-square'));
    km.appendChild(h('span', 'tm-word', TYPE_LABEL[type] || type));
    return km;
  }
  function priorityCell(p) {
    const el = h('span', 'prio prio-' + p);
    if (p === 'high') el.appendChild(shape('s-tri'));
    else if (p === 'low') el.appendChild(shape('s-tri down'));
    el.appendChild(h('span', null, PRIORITY_LABEL[p]));
    return el;
  }
  function blockedMark(ids) {
    const tag = h('span', 'tag attn');
    tag.appendChild(shape('s-square'));
    tag.appendChild(h('span', null, 'blocked by ' + ids.slice(0, 3).join(', ') + (ids.length > 3 ? ' +' + (ids.length - 3) : '')));
    tag.title = 'Blocked by ' + ids.join(', ');
    return tag;
  }
  function unverifiedMark() {
    const tag = h('span', 'tag attn');
    tag.appendChild(shape('s-dring'));
    tag.appendChild(h('span', null, 'done, not verified'));
    tag.title = 'This card has acceptance criteria and was moved to the done stage without anyone approving them';
    return tag;
  }

  function buildListRow(r) {
    const tr = h('tr', 'lrow');
    tr.dataset.id = r.id;
    tr.tabIndex = 0;
    const cell = (cls, ...kids) => { const td = h('td', cls); td.append(...kids); tr.appendChild(td); return td; };

    cell('c-id', h('span', 'idchip', r.id));
    const typeKids = [typeMark(r.type)];
    if (r.bug && r.type !== 'bug') typeKids.push(bugMark({ bug: true }));
    cell('c-type', ...typeKids);
    const title = cell('c-title');
    const t = h('div', 'l-title', r.title);
    t.title = r.title;
    title.appendChild(t);
    if (r.work || r.blockedBy.length || r.unverified) {
      const marks = h('div', 'l-marks');
      if (r.work) marks.appendChild(workEl(r.work, true));
      if (r.blockedBy.length) marks.appendChild(blockedMark(r.blockedBy));
      if (r.unverified) marks.appendChild(unverifiedMark());
      title.appendChild(marks);
    }
    if (r.progress) {
      // a milestone has no stage: its state and how far its cards are, such as "Open · 5/14"
      const st = h('span', null, MS_STATE_LABEL[r.msState] + (r.progress.total ? ' · ' + r.progress.done + '/' + r.progress.total : ''));
      st.title = MS_STATE_HINT[r.msState] || '';
      cell('c-stage tnum', st);
    }
    else cell('c-stage', h('span', null, r.stageLabel));
    cell('c-priority', priorityCell(r.priority));
    const labels = cell('c-labels');
    r.labels.slice(0, 2).forEach((l) => labels.appendChild(h('span', 'lbl', l)));
    if (r.labels.length > 2) {
      const more = h('span', 'lbl-more tnum', '+' + (r.labels.length - 2));
      more.title = r.labels.slice(2).join(', ');
      labels.appendChild(more);
    }
    const ms = cell('c-milestone');
    if (r.milestoneTitle) { ms.textContent = r.milestoneTitle; ms.title = r.milestoneId + ' ' + r.milestoneTitle; }
    const wk = cell('c-worked');
    if (r.lastWorker) {
      wk.appendChild(h('span', null, workerText(r.lastWorker)));
      if (r.moreWorkers) wk.appendChild(h('span', 'lbl-more tnum', '+' + r.moreWorkers));
      wk.title = workerText(r.lastWorker) + (r.moreWorkers ? ' and ' + r.moreWorkers + ' more who worked on it' : '');
    }
    const wt = cell('c-waiting tnum');
    if (r.waits) {
      wt.appendChild(h('span', 'wait-count', String(r.waits)));
      wt.appendChild(h('span', 'sr-only', ' waiting for you'));
    }
    const up = cell('c-updated');
    if (r.updated) up.appendChild(timeEl(r.updated));

    tr.addEventListener('click', () => openCard(r.id, tr));
    tr.addEventListener('keydown', (e) => {
      if (e.target === tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCard(r.id, tr); }
    });
    return tr;
  }

  function buildListHead(sort) {
    const tr = h('tr');
    LIST_COLS.forEach((col) => {
      const th = h('th', 'c-' + col.id);
      th.scope = 'col';
      const on = sort.col === col.id;
      if (on) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
      const b = h('button', 'th-btn' + (on ? ' on' : ''));
      b.type = 'button';
      b.dataset.col = col.id;
      b.append(h('span', null, col.label), h('span', 'sort-ind', on ? (sort.dir === 'asc' ? '▲' : '▼') : ''));
      b.title = 'Sort by ' + col.label.toLowerCase() + (on ? ', ' + (sort.dir === 'asc' ? 'now ascending' : 'now descending') + '; click to reverse' : '');
      b.addEventListener('click', () => {
        listUi().sort = nextSort(listUi().sort, col.id);
        maybeRenderPane();
      });
      th.appendChild(b);
      tr.appendChild(th);
    });
    const head = h('thead');
    head.appendChild(tr);
    return head;
  }

  function clearListFilters() {
    const u = listUi();
    u.type = u.priority = u.label = ''; u.blocked = u.unverified = false;
    elSearch.value = '';
    sessionSel = '';
    milestoneSel = '';
    updateSessionOptions();
    updateMilestoneOptions();
    maybeRenderPane();
  }

  // The selects and buttons in the toolbar follow the data: a select offers the values some card has (and is hidden when there is
  // nothing to choose between), and a filter whose value is gone is dropped, as a vanished milestone is.
  function updateListControls(rows) {
    const u = listUi();
    const ch = listChoices(rows);
    if (u.type && !ch.types.includes(u.type)) u.type = '';
    if (u.priority && !ch.priorities.includes(u.priority)) u.priority = '';
    if (u.label && !ch.labels.includes(u.label)) u.label = '';
    const set = (sel, values, text, want, all) => {
      sel.parentNode.hidden = values.length < 2 && !want;
      fillSelect(sel, [['', all]].concat(values.map((v) => [v, text(v)])), want);
      markSet(sel);
    };
    set(elListType, ch.types, (t) => TYPE_LABEL[t], u.type, 'All types');
    set(elListPrio, ch.priorities, (p) => PRIORITY_LABEL[p], u.priority, 'All priorities');
    set(elListLabel, ch.labels, (l) => l, u.label, 'All labels');
    elListBlocked.setAttribute('aria-pressed', u.blocked ? 'true' : 'false');
    elListUnver.setAttribute('aria-pressed', u.unverified ? 'true' : 'false');
  }

  function emptyList(title, text, action) {
    const box = h('div', 'list-empty');
    box.appendChild(h('h3', 'list-empty-title', title));
    box.appendChild(h('p', 'muted', text));
    box.appendChild(action);
    return box;
  }

  // Where the user is in the drawn table: the scroll, and the row or header button that has the focus. Taken before the pane is cleared.
  function listSnapshot() {
    const sc = elPane.querySelector('.list-scroll');
    const a = document.activeElement;
    const mine = !!(a && a.classList && elPane.contains(a));
    return {
      key: selKey,
      scroll: sc ? [sc.scrollTop, sc.scrollLeft] : [0, 0],
      row: mine && a.classList.contains('lrow') ? a.dataset.id : null,
      col: mine && a.classList.contains('th-btn') ? a.dataset.col : null,
    };
  }

  function renderList(keep) {
    const was = keep && keep.key === selKey ? keep : { scroll: [0, 0], row: null, col: null };
    const scroll = was.scroll, focusRow = was.row, focusCol = was.col;

    updateSessionOptions();
    updateMilestoneOptions();
    const all = listRows(current.cards, cfg());
    updateListControls(all);
    const f = listFilterState();
    const filtering = listFiltering(f);
    const rows = sortRows(listFilter(all, f), listUi().sort.col, listUi().sort.dir);

    // the line beside the toolbar, as on the board
    elNote.replaceChildren();
    if (all.length && filtering) {
      elNote.appendChild(h('span', 'tnum tb-count', rows.length + ' of ' + all.length + (all.length === 1 ? ' card' : ' cards')));
      elNote.appendChild(plainBtn('Clear filters', 'small', clearListFilters));
    }

    const wrap = h('section', 'list-view');
    if (!all.length) {
      const open = h('a', 'btn', 'Open the Board');
      open.href = hashFor(selKey, 'board');
      wrap.appendChild(emptyList('No cards yet', 'Cards you add on the Board show up here.', open));
    } else if (!rows.length) {
      wrap.appendChild(emptyList('No cards match', 'Nothing fits the search and filters you set.', plainBtn('Clear filters', '', clearListFilters)));
    } else {
      const sc = h('div', 'list-scroll');
      const table = h('table', 'list-table');
      table.setAttribute('aria-label', 'Cards, ' + rows.length + (rows.length === 1 ? ' row' : ' rows'));
      table.appendChild(buildListHead(listUi().sort));
      const body = h('tbody');
      rows.forEach((r) => body.appendChild(buildListRow(r)));
      table.appendChild(body);
      sc.appendChild(table);
      wrap.appendChild(sc);
      wrap.appendChild(h('p', 'sr-only', 'Sorted by ' + LIST_COLS.find((c) => c.id === listUi().sort.col).label.toLowerCase() + ', ' + (listUi().sort.dir === 'asc' ? 'ascending' : 'descending') + '.'));
    }
    elPane.appendChild(wrap);

    const sc = wrap.querySelector('.list-scroll');
    if (sc) { sc.scrollTop = scroll[0]; sc.scrollLeft = scroll[1]; }
    let target = null;
    if (focusRow) target = wrap.querySelector('.lrow[data-id="' + cssEscape(focusRow) + '"]');
    else if (focusCol) target = wrap.querySelector('.th-btn[data-col="' + cssEscape(focusCol) + '"]');
    if (target) target.focus({ preventScroll: true });
  }

  elListType.addEventListener('change', () => { listUi().type = elListType.value; maybeRenderPane(); });
  elListPrio.addEventListener('change', () => { listUi().priority = elListPrio.value; maybeRenderPane(); });
  elListLabel.addEventListener('change', () => { listUi().label = elListLabel.value; maybeRenderPane(); });
  elListBlocked.addEventListener('click', () => { listUi().blocked = !listUi().blocked; maybeRenderPane(); });
  elListUnver.addEventListener('click', () => { listUi().unverified = !listUi().unverified; maybeRenderPane(); });
  // the board's own controls: they redraw the board, which is not showing, so the list follows them here
  const listFollows = () => { if (viewSel === 'list' && !showingHome) maybeRenderPane(); };
  elSearch.addEventListener('input', listFollows);
  // Escape clears the box in the board's own handler, which runs after this one: follow it once that has happened
  elSearch.addEventListener('keydown', (e) => { if (e.key === 'Escape') setTimeout(listFollows, 0); });
  elSession.addEventListener('change', listFollows);
  elMilestone.addEventListener('change', listFollows);
