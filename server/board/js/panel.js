  // ---------- panel plumbing ----------

  function openCard(id, fromEl) {
    returnFocus = fromEl ? { id } : null;
    navigateOpen(id);
  }
  // ---- card link (list-page.test.mjs runs this block on its own) ----
  // A link to a card's page in the Milestones and the Summary. A plain click opens the page the way a board card does: one history entry
  // that Back takes away again, and focus coming back to the link. A click with a modifier is the browser's own (a new tab, a new window).
  // `before` runs just ahead of the opening.
  function bindCardLink(a, id, before) {
    a.addEventListener('click', (e) => {
      if (e.defaultPrevented || (e.button !== undefined && e.button !== 0) || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (before) before();
      openCard(id, a);
    });
  }
  // ---- end card link ----
  function openNew() { if (halted || !selKey || isRO() || isChat()) return; returnFocus = { el: elNewBtn }; navigateOpen('new'); }
  function navigateOpen(target) {
    if (panel) return;
    hashPushed = true;
    location.hash = hashFor(selKey, target);
  }

  window.addEventListener('hashchange', syncFromHash);

  // ---- address sync (shell-page.test.mjs runs this block with stand-ins) ----
  function syncFromHash() {
    if (halted || !projects) return;
    const r = parseRoute(location.hash);
    if (r.home) {
      if (panel && panel.isDirty && panel.isDirty()) {
        // leaving with unsaved edits: put the hash back and ask first
        history.pushState(null, '', hashFor(selKey, panel.target));
        panel.showDiscard();
        return;
      }
      enterHome();
      return;
    }
    // no project in the hash: stay on the selected one (home at first); an unknown project: home
    const wanted = r.key ? (projectByKey(r.key) ? r.key : homeKey) : (selKey || homeKey);
    if (!wanted) { enterHome(); return; }
    if (wanted !== selKey) {
      if (panel && panel.isDirty && panel.isDirty()) {
        // leaving with unsaved edits: put the hash back and ask first
        history.pushState(null, '', hashFor(selKey, panel.target));
        panel.showDiscard();
        return;
      }
      if (panel) removePanel(false);
      selectProject(wanted);
    }
    if (r.key !== wanted) history.replaceState(null, '', location.pathname + location.search + hashFor(wanted, r.view || r.card));
    if (!current) return;                        // the board is still loading; apply() comes back here
    const target = r.card;
    if (target === 'new' && (isRO() || isChat())) {
      // no new card here: back to the view on screen, or the project's first one (viewSel is still '' when this is the first address)
      const v = viewSel || defaultView(isChat());
      history.replaceState(null, '', location.pathname + location.search + hashFor(selKey, v));
      if (panel) removePanel(false);
      showView(v);
      return;
    }
    if (panel && panel.target === target) { updatePanel(); return; }
    if (panel && panel.isDirty && panel.isDirty()) {
      history.pushState(null, '', hashFor(selKey, panel.target));
      panel.showDiscard();
      return;
    }
    // the view: a card's page opens over the view that is showing; a chat-only project has the board only
    const rv = resolveView(r, isChat(), viewSel);
    if (rv.fix) history.replaceState(null, '', location.pathname + location.search + hashFor(selKey, rv.view));
    showView(rv.view);
    if (panel) removePanel(!!target);
    if (target) buildPanel(target);
  }
  // ---- end address sync ----

  function requestClose() {
    if (!panel) return;
    if (panel.isDirty && panel.isDirty()) { panel.showDiscard(); return; }
    navigateClose();
  }
  function navigateClose() {
    if (hashPushed) { hashPushed = false; history.back(); }
    else {
      history.replaceState(null, '', location.pathname + location.search + hashFor(selKey, viewSel));
      syncFromHash();
    }
  }

  function removePanel(swapping) {
    if (!panel) return;
    if (panel.dispose) panel.dispose();
    panel = null;
    elOverlay.replaceChildren();
    if (swapping) return;      // another panel is about to replace this one
    elOverlay.hidden = true;
    elApp.inert = false;
    const rf = returnFocus;
    returnFocus = null;
    hashPushed = false;
    let target = null;
    if (rf && rf.id) {
      const href = hashFor(selKey, rf.id);
      target = elBoard.querySelector('.card[data-id="' + cssEscape(rf.id) + '"]') || elPane.querySelector('.lrow[data-id="' + cssEscape(rf.id) + '"]')
        || Array.prototype.find.call(elPane.querySelectorAll('a[href]'), (a) => a.getAttribute('href') === href) || null;   // a link in the Milestones or the Summary
    }
    else if (rf && rf.el) target = rf.el;
    (target || elNewBtn).focus({ preventScroll: true });
  }

  // page: the form fills the view (no board behind it to click on)
  function mountDrawer(P, page) {
    const scrim = h('div', 'scrim');
    scrim.addEventListener('click', requestClose);
    const drawer = h('aside', page ? 'drawer page' : 'drawer');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'drawer-title');
    drawer.tabIndex = -1;
    P.root = drawer;
    elOverlay.replaceChildren(...(page ? [drawer] : [scrim, drawer]));
    elOverlay.hidden = false;
    elApp.inert = true;
  }

  // the view a card's page was opened over
  function backName() { return VIEW_LABEL[viewSel] ? VIEW_LABEL[viewSel].toLowerCase() : 'board'; }
  function backBtn() {
    const back = h('button', 'btn back');
    back.type = 'button';
    back.title = 'Back to the ' + backName() + ' (Esc)';
    back.setAttribute('aria-keyshortcuts', 'Escape');
    back.append(chev('l'), h('span', null, 'Back to ' + backName()));
    const kb = h('kbd', 'hint', 'Esc'); kb.setAttribute('aria-hidden', 'true');
    back.appendChild(kb);
    back.addEventListener('click', requestClose);
    return back;
  }

  function headRow(card, createMode) {
    const row = h('div', 'dr-head-row');
    if (createMode) row.appendChild(h('span', 'muted', 'Draft'));
    else {
      row.appendChild(h('span', 'idchip', card.id));
      row.appendChild(kindMark(card.kind));
    }
    row.appendChild(h('span', 'grow'));
    const x = plainBtn('×', 'icon ghost', requestClose);
    x.setAttribute('aria-label', 'Close panel');
    x.title = 'Close (Esc)';
    row.appendChild(x);
    return row;
  }

  function buildPanel(target) {
    closeMenu(false);
    const startNow = startFor === target;
    startFor = '';
    const atWaits = waitsFor === target;
    waitsFor = '';
    const notifyNow = notifyFor === target;
    notifyFor = '';
    if (target === 'new') { buildTaskPanel(null); }
    else {
      const card = shownCard(target);
      if (!card) buildMissing(target);
      else if (isThread(card)) buildThreadPanel(card);
      else buildTaskPanel(card, startNow, notifyNow);
    }
    if (panel) {
      const first = panel.initialFocus ? panel.initialFocus() : panel.root;
      (first || panel.root).focus({ preventScroll: true });
      if (atWaits && panel.focusWaits) panel.focusWaits();   // the gear menu's "Answer waiting items"
    }
  }

  // a chat-only project shows its threads only; a task card is as good as missing
  function shownCard(id) {
    const c = findCard(id);
    return c && (isThread(c) || !isChat()) ? c : null;
  }
  function buildMissing(id) {
    const P = panel = { target: id, type: 'missing', isDirty: null };
    mountDrawer(P);
    const head = h('div', 'dr-head');
    head.appendChild(headRow({ id }, true));
    const t = h('h2', 'dr-title', 'Card not found');
    t.id = 'drawer-title';
    head.appendChild(t);
    const body = h('div', 'dr-body');
    body.appendChild(h('p', 'muted', findCard(id) ? 'Card ' + id + ' is hidden because the task board is off for this project (chat-only).' : 'There is no card ' + id + ' on this board. It may have been deleted.'));
    P.root.append(head, body);
    head.querySelector('.dr-head-row .muted').textContent = id;
  }

  // A panel also shows the stages, the milestones to pick from and, on a milestone, its cards: a change in any of them redraws it.
  function panelCtx(card) {
    const ctx = [current.config, milestoneChoices()];
    if (card.lane || (card.thread && card.thread.lane)) ctx.push(laneSig(card));
    if (card.kind === 'task' || card.kind === 'idea') ctx.push([workerRows(), workerOffered(card), !!lanes, !!agents, isRemote()]);   // the Worker field and the start step's worker choice
    if (card.kind === 'milestone') ctx.push(childrenOf(current.cards, card.id).map((k) => [k.id, k.kind, k.title, k.status, k.thread && k.thread.runState]));
    return ctx;
  }
  function panelKey(card) { return JSON.stringify([card, isRO(), isThread(card) ? sessionInfo(card.thread.parentSessionId) : null, panelCtx(card)]); }
  function updatePanel() {
    if (!panel || panel.target === 'new') return;
    const card = shownCard(panel.target);
    if (!card) {
      if (panel.type !== 'missing') { const id = panel.target; removePanel(true); buildMissing(id); panel.root.focus({ preventScroll: true }); }
      return;
    }
    if (panel.type === 'missing') { const id = panel.target; panel = null; buildPanel(id); return; }
    // a task that just became a thread (started here or elsewhere) opens as the workspace under the same address
    if (panel.type === 'task' && isThread(card)) { const id = panel.target; removePanel(true); buildPanel(id); return; }
    const key = panelKey(card);
    if (key === panel.cardKey) return;
    panel.cardKey = key;
    panel.update(card);
  }

