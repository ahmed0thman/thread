  // ---------- projects and tabs ----------

  function projectByKey(key) {
    if (!projects || !key) return null;
    for (const p of projects) if (p.key === key) return p;
    return null;
  }
  function isRO() {
    if (current && typeof current.exists === 'boolean') return !current.exists;
    const p = projectByKey(selKey);
    return !!(p && p.exists === false);
  }
  function parentName(dir) {
    const parts = String(dir || '').split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }

  async function loadProjects() {
    const { res, text } = await request('GET', '/api/projects', null, 5000);
    const data = parseJson(text);
    if (!res.ok || !data || !Array.isArray(data.projects)) throw new Error((data && data.error) ? data.error : 'Request failed (status ' + res.status + ')');
    return data;
  }
  let projectsAgain = false;
  async function refreshProjects() {
    if (halted) return;
    if (projectsBusy) { projectsAgain = true; return; }
    projectsBusy = true;
    try { applyProjects(await loadProjects()); if (!selKey) setOnline(true); }
    catch (e) { if (!e.auth && !selKey) setOnline(false); }   // 401 shows the access-link page; with a project selected its state poll shows the connection
    finally {
      projectsBusy = false;
      projectsAt = Date.now();
      if (projectsAgain) { projectsAgain = false; refreshProjects(); }
    }
  }
  // The lanes of the selected project, on the slow cycle and when a project is shown. A lane is only read here, never set.
  let lanesBusy = false;
  async function refreshLanes() {
    lanesAt = Date.now();
    const key = selKey;
    if (halted || !key || lanesBusy) return;
    lanesBusy = true;
    let data = null;
    try {
      const { res, text } = await request('GET', pp(key, 'lanes'), null, 9000);
      data = res.ok ? parseJson(text) : null;
    } catch (e) { /* the lanes are optional: keep what is shown */ }
    finally { lanesBusy = false; }
    if (key !== selKey || !data || typeof data.available !== 'boolean' || !Array.isArray(data.lanes)) return;
    const sig = JSON.stringify(data);
    if (sig === lanesSig) return;
    lanes = data;
    lanesSig = sig;
    if (current) { renderBoard(false); updatePanel(); }
  }
  // a write went through: counts and activity in the project list have changed
  function wrote() { refreshProjects(); }

  function applyProjects(data) {
    const incoming = data.projects.filter((p) => p && typeof p.key === 'string');
    const byKey = {};
    incoming.forEach((p) => { byKey[p.key] = p; });
    // keep the projects where they are; the server sorts by activity, which would shuffle them under the pointer
    const order = [];
    if (projects) projects.forEach((p) => { if (byKey[p.key]) order.push(p.key); });
    incoming.forEach((p) => { if (!order.includes(p.key)) order.push(p.key); });
    const first = projects === null;
    projects = order.map((k) => byKey[k]);
    homeKey = (typeof data.home === 'string' && byKey[data.home]) ? data.home : (projects.length ? projects[0].key : '');
    maybeRenderChrome();
    if (first) { syncFromHash(); return; }
    if (selKey && !byKey[selKey]) {
      history.replaceState(null, '', location.pathname + location.search + hashFor(homeKey, ''));
      syncFromHash();
      return;
    }
    updateToolbar();
    renderNotice();
  }

  // ---- project switcher (waits-page.test.mjs runs this block with stand-ins) ----
  // The select in the header: [[key, text]] for the projects in their stable order. Two projects with one name get their parent
  // folder, a project whose folder is gone says so, and one with items waiting for the user says how many.
  function switchOptions() {
    const list = projects || [];
    const nameCount = {};
    list.forEach((p) => { nameCount[p.name] = (nameCount[p.name] || 0) + 1; });
    return list.map((p) => {
      const parent = nameCount[p.name] > 1 ? parentName(p.projectDir) : '';
      const nw = tabWaiting(p);
      return [p.key, p.name + (parent ? ' (' + parent + ')' : '') + (p.exists === false ? ' (folder missing)' : '') + (nw > 0 ? ' · ' + nw + ' waiting' : '')];
    });
  }
  let switcherSig = '';
  function maybeRenderSwitcher() { if (JSON.stringify([selKey, switchOptions()]) !== switcherSig) renderSwitcher(); }
  function renderSwitcher() {
    const opts = switchOptions();
    switcherSig = JSON.stringify([selKey, opts]);
    fillSelect(elProjSelect, opts, selKey);
    const p = projectByKey(selKey);
    elProjSelect.title = p ? p.projectDir : '';
  }
  // ---- end project switcher ----

  function goProject(key) {
    if (!key || key === selKey) return;
    location.hash = hashFor(key, '');
    syncFromHash();                              // do not wait for the hashchange event
  }
  elProjSelect.addEventListener('change', () => {
    const key = elProjSelect.value;
    goProject(key);
    if (key !== selKey) elProjSelect.value = selKey;   // the switch was held back (unsaved edits): show where we still are
  });

  // Switch to a project: forget the old state, show the new project, fetch the new board.
  function selectProject(key) {
    closeMenu(false);
    saveFilters();
    showingHome = false;
    selKey = key;
    viewSel = '';
    lanes = null; lanesSig = ''; lanesAt = 0;
    current = null; currentKey = ''; lastRaw = null; boardKey = null; synced = false; pendingRender = false;
    loadFilters();
    const p = projectByKey(key);
    setDir(p ? p.projectDir : '');
    renderSwitcher();
    elBoard.replaceChildren();
    elNote.replaceChildren();
    clearPane();
    updateSessionOptions();
    updateMilestoneOptions();
    updateToolbar();
    renderViews();
    renderNotice();
    poll();
    refreshLanes();
  }

  function saveFilters() {
    if (!selKey) return;
    filterMemo[selKey] = { q: elSearch.value, threadsOnly: elThreadsOnly.getAttribute('aria-pressed') === 'true', session: sessionSel, milestone: milestoneSel, waiting: waitingOn() };
  }
  function loadFilters() {
    const m = filterMemo[selKey] || { q: '', threadsOnly: false, session: '', milestone: '', waiting: false };
    elSearch.value = m.q;
    elThreadsOnly.setAttribute('aria-pressed', m.threadsOnly ? 'true' : 'false');
    elWaiting.setAttribute('aria-pressed', m.waiting ? 'true' : 'false');
    sessionSel = m.session;
    milestoneSel = m.milestone;
  }

  // The toolbar follows the selected project's state: read-only, and chat-only (no New card, no Threads only, a note).
  function updateToolbar() {
    const ro = !!selKey && isRO();
    const chat = !!selKey && isChat();
    elNewBtn.setAttribute('aria-disabled', ro ? 'true' : 'false');
    elNewBtn.title = ro ? READONLY_WHY : '';
    elNewBtn.hidden = chat;
    elThreadsOnly.hidden = chat;
    elModeNote.hidden = !chat;
    updateWaitingPill();
    updateSendBar();
    elOldNote.hidden = !(current && !current.config);
    showVersionNote();
    updateChrome();
  }

  // The bar above the columns for a project whose folder is gone.
  let noticeSig = '';
  let forgetAsk = '';          // project key whose forget confirm step is showing
  // Card files of a repo-backed project that could not be read (a git merge conflict, invalid JSON): named, so they can be fixed in the repo.
  // The server never touches such a file. A notice marked `shown` is a card that is shown but shares its id with a thread on this machine.
  // Text only.
  let filesNoticeSig = '';
  function renderFilesNotice() {
    const all = selKey && current && Array.isArray(current.notices) ? current.notices.filter((n) => n && typeof n.file === 'string') : [];
    const list = all.filter((n) => !n.shown);
    const kept = all.filter((n) => n.shown);
    const sig = selKey + '|' + JSON.stringify(all);
    if (sig === filesNoticeSig) return;
    filesNoticeSig = sig;
    elFilesNotice.replaceChildren();
    elFilesNotice.hidden = !all.length;
    if (!all.length) return;
    const grow = h('span', 'grow');
    if (list.length) {
      grow.append(list.length === 1 ? 'A card file in the repo is not shown, and is left as it is: ' : list.length + ' card files in the repo are not shown, and are left as they are: ');
      list.slice(0, 8).forEach((n, i) => {
        if (i) grow.append('; ');
        grow.appendChild(h('code', null, n.file));
        grow.append(' ' + String(n.reason || 'could not be read'));
      });
      if (list.length > 8) grow.append('; and ' + (list.length - 8) + ' more');
      grow.append('. Fix them in the repo (resolve the git conflict, or correct the JSON).');
    }
    if (kept.length) {
      if (list.length) grow.append(' ');
      grow.append(kept.length === 1 ? 'A card shares its id with a thread on this machine: ' : kept.length + ' cards share their id with a thread on this machine: ');
      kept.slice(0, 8).forEach((n, i) => {
        if (i) grow.append('; ');
        grow.appendChild(h('code', null, n.file));
      });
      if (kept.length > 8) grow.append('; and ' + (kept.length - 8) + ' more');
      grow.append('. Both are shown.');
    }
    elFilesNotice.appendChild(grow);
  }

  function renderNotice() {
    renderFilesNotice();
    const ro = !!selKey && isRO();
    if (!ro) { noticeSig = ''; forgetAsk = ''; elNotice.hidden = true; elNotice.replaceChildren(); return; }
    const p = projectByKey(selKey);
    const dir = (current && current.projectDir) || (p && p.projectDir) || '';
    const key = selKey;
    const sig = key + '|' + dir + '|' + (forgetAsk === key);
    if (sig === noticeSig) return;
    noticeSig = sig;
    const hadFocus = elNotice.contains(document.activeElement);
    elNotice.replaceChildren();
    elNotice.hidden = false;
    if (forgetAsk === key) {
      elNotice.appendChild(h('span', 'confirm-text', 'Forget this project? Its stored cards are removed from the board and this cannot be undone.'));
      const keep = plainBtn('Keep it', 'small', () => { forgetAsk = ''; renderNotice(); });
      elNotice.append(keep, actionBtn('Forget project', 'small danger solid', 'forget:' + key, () => forgetProject(key)));
      if (hadFocus) keep.focus();
    } else {
      const grow = h('span', 'grow');
      grow.append('This project’s folder was not found at ');
      grow.appendChild(h('code', null, dir));
      grow.append('. Its cards are shown read-only.');
      elNotice.appendChild(grow);
      if (!isRemote()) {   // forgetting a project is only possible on the computer itself
        const ask = plainBtn('Forget this project', 'small', () => { forgetAsk = key; renderNotice(); });
        elNotice.appendChild(ask);
        if (hadFocus) ask.focus();
      }
    }
    syncBusy();
  }
  async function forgetProject(key) {
    clearError();
    let ok = false;
    await runAction('forget:' + key, async () => {
      try { await api('DELETE', '/api/p/' + encodeURIComponent(key), {}); ok = true; }
      catch (e) { showError(e.message); forgetAsk = ''; noticeSig = ''; }
    });
    if (ok) {
      forgetAsk = '';
      delete filterMemo[key];
      await refreshProjects();
      if (selKey === key) {
        history.replaceState(null, '', location.pathname + location.search + hashFor(homeKey, ''));
        syncFromHash();
      }
    } else if (selKey === key) renderNotice();
  }

  // ---------- parent sessions ----------
  let sessionSel = '';       // selected parent session id in the Session filter ('' = all)
  function sessionInfo(id) {
    return (current && current.sessions && id && current.sessions[id] && typeof current.sessions[id] === 'object') ? current.sessions[id] : null;
  }
  function sessionLabel(id) {
    const s = sessionInfo(id);
    if (s && s.label) return String(s.label);
    return id ? 'session ' + String(id).slice(0, 8) : '';
  }
  let sessSig = '';
  function updateSessionOptions() {
    const map = {};
    if (current) current.cards.forEach((c) => { if (isThread(c) && c.thread.parentSessionId) map[c.thread.parentSessionId] = sessionLabel(c.thread.parentSessionId); });
    if (sessionSel && !map[sessionSel] && current) sessionSel = '';
    const ids = Object.keys(map).sort((a, b) => map[a].localeCompare(map[b]));
    const sig = JSON.stringify([ids.map((i) => [i, map[i]]), sessionSel]);
    if (sig === sessSig) return;
    sessSig = sig;
    elSessionWrap.hidden = !ids.length;
    const frag = document.createDocumentFragment();
    const all = h('option', null, 'All sessions'); all.value = ''; frag.appendChild(all);
    ids.forEach((i) => { const o = h('option', null, map[i]); o.value = i; o.title = map[i]; frag.appendChild(o); });
    elSession.replaceChildren(frag);
    elSession.value = sessionSel;
    markSet(elSession);
  }
  elSession.addEventListener('change', () => { sessionSel = elSession.value; renderBoard(false); });

