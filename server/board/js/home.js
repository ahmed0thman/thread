  // ---------- projects home and project views ----------

  // ---- projects home (shell-page.test.mjs runs this block on its own) ----
  // 'C:\\x\\shop' or '/x/shop' as the part that may be cut short and the folder name that never is
  function dirParts(dir) {
    const d = String(dir || '');
    const cut = Math.max(d.lastIndexOf('/'), d.lastIndexOf('\\'));
    return cut > 0 ? { head: d.slice(0, cut), tail: d.slice(cut) } : { head: '', tail: d };
  }
  const countOf = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  // What a project's tile shows. open, done and waiting are null (shown as a dash) when the server sent none: an older one does not.
  // `chatSeen`: this page has opened the project and found it chat-only (the project list has no mode of its own yet).
  function tileModel(p, chatSeen) {
    const parts = dirParts(p.projectDir);
    return {
      key: p.key,
      name: String(p.name || p.key),
      dir: String(p.projectDir || ''),
      dirHead: parts.head,
      dirTail: parts.tail,
      missing: p.exists === false,
      open: countOf(p.open),
      done: countOf(p.done),
      waiting: countOf(p.waiting),
      running: countOf(p.running) || 0,
      last: typeof p.lastActivity === 'string' ? p.lastActivity : '',
      chat: p.mode === 'chat' || chatSeen === true,
    };
  }
  // ---- end projects home ----

  function buildTile(m) {
    const a = h('a', 'tile' + (m.missing ? ' is-missing' : ''));
    a.href = hashFor(m.key, '');
    a.dataset.key = m.key;
    const top = h('div', 'tile-top');
    top.appendChild(h('h3', 'tile-name', m.name));
    if (m.chat) top.appendChild(h('span', 'tag chat-tag', 'chat-only'));
    if (m.missing) top.appendChild(h('span', 'tag attn', 'folder missing'));
    a.appendChild(top);
    const dir = h('div', 'tile-dir');
    dir.title = m.dir + (m.missing ? ' (folder missing)' : '');
    dir.append(h('span', 'dir-head', m.dirHead), h('span', 'dir-tail', m.dirTail));
    a.appendChild(dir);
    const stats = h('dl', 'tile-stats');
    [['Open', m.open], ['Done', m.done], ['Waiting', m.waiting]].forEach(([k, v]) => {
      const box = h('div', 'stat' + (k === 'Waiting' && v > 0 ? ' hot' : ''));
      box.appendChild(h('dt', null, k));
      const dd = h('dd', 'tnum', v === null ? '–' : String(v));
      if (v === null) dd.title = 'This board server does not send it';
      box.appendChild(dd);
      stats.appendChild(box);
    });
    a.appendChild(stats);
    const foot = h('div', 'tile-foot');
    if (m.running > 0) {
      const run = h('span', 'tile-run');
      const dot = shape('s-pulse');
      dot.dataset.run = 'running';
      run.append(dot, h('span', null, m.running + ' running'));
      foot.appendChild(run);
    }
    if (m.last) foot.append(h('span', 'grow'), h('span', 'tile-when', 'Active '), timeEl(m.last));
    if (foot.children.length) a.appendChild(foot);
    return a;
  }

  function renderHome() {
    const list = projects || [];
    const wrap = h('section', 'home');
    const head = h('div', 'home-head');
    head.appendChild(h('h2', 'home-title', 'Projects'));
    head.appendChild(h('span', 'muted tnum', list.length + (list.length === 1 ? ' project' : ' projects')));
    wrap.appendChild(head);
    const grid = h('div', 'tiles');
    list.forEach((p) => grid.appendChild(buildTile(tileModel(p, modeSeen[p.key]))));
    wrap.appendChild(grid);
    elPane.appendChild(wrap);
  }

  // ---- what is showing: the home, or a view of the selected project ----
  function showsBoard() { return !showingHome && !!selKey && (viewSel === 'board' || viewSel === 'waiting'); }
  const SEARCH_VIEWS = ['board', 'waiting', 'list'];    // the views the search box filters

  // The parts of the page that depend on where we are. Called from updateToolbar, which every change of state goes through.
  function updateChrome() {
    const proj = !showingHome && !!selKey;
    const board = showsBoard();
    elSwitcher.hidden = !proj;
    elToolbar.hidden = !(proj && viewSel);
    elSearchWrap.hidden = !SEARCH_VIEWS.includes(viewSel);
    elFilters.hidden = !(board || viewSel === 'list');
    elChips.hidden = !(board || viewSel === 'list');
    elListFilters.hidden = viewSel !== 'list';
    elListToggles.hidden = viewSel !== 'list';
    if (viewSel === 'list') elThreadsOnly.hidden = true;   // the List has its own Type filter
    elBoard.hidden = !board;
    elPane.hidden = !(showingHome || (proj && viewSel && !board));
  }

  function showView(view) {
    if (view === viewSel && !showingHome) return;
    showingHome = false;
    viewSel = view;
    closeMenu(false);
    updateToolbar();
    renderViews();
    renderPane();
    if (showsBoard()) renderBoard(true);
  }
  function goView(view) { if (selKey) location.hash = hashFor(selKey, view); }

  // The projects home: no project is selected, so nothing is polled but the project list.
  function enterHome() {
    if (showingHome) { maybeRenderChrome(); return; }
    closeMenu(false);
    saveFilters();
    if (panel) removePanel(false);
    showingHome = true;
    selKey = '';
    viewSel = '';
    lanes = null; lanesSig = ''; lanesAt = 0; agents = null; agentsSig = '';
    current = null; currentKey = ''; lastRaw = null; boardKey = null; synced = false; pendingRender = false;
    loadFilters();
    setDir('');
    elBoard.replaceChildren();
    elNote.replaceChildren();
    updateSessionOptions();
    updateMilestoneOptions();
    updateToolbar();
    renderNotice();
    renderSwitcher();
    renderViews();
    renderPane();
  }

  // ---- the top bar of a project: Summary, Board, List, Milestones, Waiting (N) ----
  function waitingNow() {
    const p = projectByKey(selKey);
    return p ? tabWaiting(p) : 0;
  }
  function viewsKey() { return JSON.stringify([showingHome, selKey, viewSel, !!current, current ? isChat() : false, waitingNow()]); }
  let viewsSig = '';
  function maybeRenderViews() { if (viewsKey() !== viewsSig) renderViews(); }
  function renderViews() {
    viewsSig = viewsKey();
    const show = !showingHome && !!selKey && !!current && !!viewSel;
    elViews.hidden = !show;
    const a = document.activeElement;
    const focusView = (a && a.classList && a.classList.contains('vtab') && elViews.contains(a)) ? a.dataset.view : null;
    if (!show) { elViews.replaceChildren(); return; }
    const n = waitingNow();
    const frag = document.createDocumentFragment();
    let focusEl = null;
    viewsOf(isChat()).forEach((v) => {
      const link = h('a', 'vtab');
      link.href = hashFor(selKey, v);
      link.dataset.view = v;
      if (v === viewSel) link.setAttribute('aria-current', 'page');
      link.appendChild(h('span', null, VIEW_LABEL[v]));
      if (v === 'waiting' && n > 0) {
        const badge = h('span', 'wait-badge tnum', String(n));
        badge.setAttribute('aria-hidden', 'true');
        link.appendChild(badge);
        link.appendChild(h('span', 'sr-only', ', ' + n + (n === 1 ? ' item' : ' items') + ' waiting for you'));
      }
      frag.appendChild(link);
      if (v === focusView) focusEl = link;
    });
    elViews.replaceChildren(frag);
    if (focusEl) focusEl.focus({ preventScroll: true });
  }

  // ---- the pane: the home, and the views that are not the board ----
  let paneSig = '';
  function clearPane() { paneSig = ''; elPane.replaceChildren(); }
  function paneKey() {
    if (showingHome) return JSON.stringify(['home', (projects || []).map((p) => tileModel(p, modeSeen[p.key]))]);
    if (!selKey || !current || !viewSel || showsBoard()) return '';
    if (viewSel === 'milestones') return milestonesPaneKey();
    if (viewSel === 'list') return listPaneKey();
    if (viewSel === 'summary') return JSON.stringify(['summary', selKey, summaryModel(current.cards, cfg(), Date.now(), sumFilters())]);
    return JSON.stringify([viewSel, selKey]);
  }
  function maybeRenderPane() { if (paneKey() !== paneSig) renderPane(); }
  // What has the focus in the pane, so a redraw of the same view can give it back: a link by its address, a card or row by its id,
  // a button by its text. (The List keeps its own snapshot.)
  function paneFocusKey() {
    const a = document.activeElement;
    if (!a || !a.getAttribute || !elPane.contains(a)) return null;
    const href = a.getAttribute('href');
    if (href) return ['a', href];
    if (a.dataset && a.dataset.id) return ['id', a.dataset.id];
    if (a.tagName === 'BUTTON') return ['button', a.textContent];
    return null;
  }
  function restorePaneFocus(k) {
    if (!k) return;
    const found = Array.prototype.find.call(elPane.querySelectorAll('a[href], [data-id], button'), (el) => (
      k[0] === 'a' ? el.getAttribute('href') === k[1] : k[0] === 'id' ? el.dataset && el.dataset.id === k[1] : el.tagName === 'BUTTON' && el.textContent === k[1]
    ));
    if (found) found.focus({ preventScroll: true });
  }
  let paneWhere = '';
  function renderPane() {
    paneSig = paneKey();
    const top = elPane.scrollTop;
    const where = showingHome ? 'home' : selKey + '/' + viewSel;
    const keep = !showingHome && viewSel === 'list' ? listSnapshot() : null;
    const focus = !keep && where === paneWhere ? paneFocusKey() : null;   // only when the same view is drawn again
    const msFocus = !showingHome && viewSel === 'milestones' && where === paneWhere ? msFocusSnapshot() : null;   // what the generic restore does not know: a line, the name being typed
    paneWhere = where;
    elPane.replaceChildren();
    if (!paneSig) return;
    if (showingHome) renderHome();
    else if (viewSel === 'milestones') renderMilestones();
    else if (viewSel === 'list') renderList(keep);
    else if (viewSel === 'summary') renderSummary();
    elPane.scrollTop = top;
    restorePaneFocus(focus);
    if (msFocus) msFocusRestore(msFocus);
  }

  // The projects, the top bar and the pane follow the data: each is drawn only when what it shows changed.
  function maybeRenderChrome() {
    maybeRenderSwitcher();
    maybeRenderViews();
    maybeRenderPane();
    updateChrome();
  }

