  // ---------- board ----------

  function filterState() {
    // chat-only shows threads only; its Threads only button is hidden, so a pressed state does not count
    return { q: elSearch.value.trim().toLowerCase(), threadsOnly: elThreadsOnly.getAttribute('aria-pressed') === 'true' && !isChat(), session: sessionSel, milestone: milestoneSel, waiting: (waitingOn() || viewSel === 'waiting') && !isChat() };
  }
  // the text of an empty column: the written ones for the default stages, else a plain one
  function emptyText(stage) {
    if (isChat()) return chatEmptyText(stage, cfg().roles) || 'Nothing in ' + stage.label + '.';
    return LABELS[stage.id] === stage.label ? EMPTY[stage.id] : 'Nothing in ' + stage.label + '.';
  }

  function renderBoard(force) {
    if (!current || !showsBoard()) return;      // the other views draw their own pane; the board is drawn again when it shows
    if (dragId !== null) { pendingRender = true; return; }
    updateSessionOptions();
    updateMilestoneOptions();
    const f = filterState();
    const key = currentKey + '|' + f.q + '|' + f.threadsOnly + '|' + f.session + '|' + f.milestone + '|' + f.waiting + '|' + lanesSig;
    if (!force && key === boardKey) return;
    boardKey = key;
    pendingRender = false;

    const scrollLeft = elBoard.scrollLeft;
    const colScroll = {};
    elBoard.querySelectorAll('.col').forEach((c) => { colScroll[c.dataset.status] = c.querySelector('.col-body').scrollTop; });
    const a = document.activeElement;
    const focusCard = (a && a.closest && elBoard.contains(a)) ? a.closest('.card') : null;
    const focusId = focusCard ? focusCard.dataset.id : null;
    const focusTag = !!(a && a.classList && a.classList.contains('ms-tag'));
    const focusGear = !!(a && a.classList && a.classList.contains('gear'));
    gearCtx = menuCtx();

    const conf = cfg();
    const chat = conf.mode === 'chat';
    const stages = chat ? chatStages(conf) : conf.stages;
    const pool = chat ? current.cards.filter(isThread) : current.cards;   // chat-only shows threads only
    const filtering = !!(f.q || f.threadsOnly || f.session || f.milestone || f.waiting);
    const shown = pool.filter((c) => matches(c, f));
    const byStatus = {};
    stages.forEach((st) => { byStatus[st.id] = []; });
    shown.forEach((c) => { if (byStatus[c.status]) byStatus[c.status].push(c); });

    const frag = document.createDocumentFragment();
    stages.forEach((st) => frag.appendChild(buildColumn(st, byStatus[st.id], filtering, f.session)));
    elBoard.style.setProperty('--cols', String(stages.length));
    elBoard.replaceChildren(frag);
    elBoard.scrollLeft = scrollLeft;
    elBoard.querySelectorAll('.col').forEach((c) => {
      if (colScroll[c.dataset.status]) c.querySelector('.col-body').scrollTop = colScroll[c.dataset.status];
    });
    if (focusId) {
      const t = elBoard.querySelector('.card[data-id="' + cssEscape(focusId) + '"]');
      if (t) (focusGear && t.querySelector('.gear') || focusTag && t.querySelector('.ms-tag') || t).focus({ preventScroll: true });
    }
    syncMenu();

    // the line beside the toolbar
    elNote.replaceChildren();
    if (!pool.length) {
      elNote.textContent = chat ? 'No threads yet. Start one with /thread:new.' : 'The board is empty. Press N to add the first card.';
    } else if (filtering) {
      const total = pool.length;
      if (!shown.length) {
        let what;
        if (f.milestone) what = f.q ? 'No cards in that milestone match “' + elSearch.value.trim() + '”.' : 'No cards to show for that milestone filter.';
        else if (f.session) what = f.q ? 'No threads from ' + sessionLabel(f.session) + ' match “' + elSearch.value.trim() + '”.' : 'No threads from ' + sessionLabel(f.session) + ' on this board. Tasks and ideas are hidden while a session is selected.';
        else if (f.waiting && !waitingCount()) what = 'Nothing is waiting for you.';
        else if (f.waiting) what = f.q ? 'Nothing waiting for you matches “' + elSearch.value.trim() + '”.' : 'Nothing waiting for you matches these filters.';
        else what = f.q ? 'No cards match “' + elSearch.value.trim() + '”' + (f.threadsOnly ? ' among threads.' : '.') : 'No threads on the board yet.';
        elNote.appendChild(h('span', null, what));
      } else {
        elNote.appendChild(h('span', 'tnum', 'Showing ' + shown.length + ' of ' + total + ' cards.' + (f.session ? ' Tasks and ideas are hidden while a session is selected.' : '')));
      }
      const clear = plainBtn('Clear filters', 'small', () => {
        elSearch.value = '';
        elThreadsOnly.setAttribute('aria-pressed', 'false');
        sessionSel = '';
        milestoneSel = '';
        setWaitingOn(false);
        renderBoard(true);
        elSearch.focus();
      });
      // on the Waiting view that filter is the view itself, so there is nothing to clear when it is the only one
      if (viewSel !== 'waiting' || f.q || f.threadsOnly || f.session || f.milestone) elNote.appendChild(clear);
    }
  }

  function buildColumn(stage, cards, filtering, session) {
    const col = h('section', 'col');
    col.dataset.status = stage.id;
    col.setAttribute('aria-label', stage.label + ', ' + cards.length + (cards.length === 1 ? ' card' : ' cards'));

    const head = h('div', 'col-head');
    head.appendChild(h('h2', null, stage.label));
    head.appendChild(h('span', 'count', String(cards.length)));
    col.appendChild(head);

    const body = h('div', 'col-body');
    if (!cards.length) body.appendChild(h('div', 'col-empty', session ? 'No threads from this session here.' : filtering ? 'No matching cards in this column.' : emptyText(stage)));
    cards.forEach((c) => body.appendChild(buildCard(c)));
    col.appendChild(body);

    col.addEventListener('dragenter', (e) => { if (dragId === null) return; e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragover', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      col.classList.add('over');
    });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
    col.addEventListener('drop', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      const id = dragId;
      endDrag();
      moveCard(id, stage.id);
    });
    return col;
  }

  function buildCard(card) {
    const thread = isThread(card);
    const t = thread ? card.thread : null;
    const milestone = card.kind === 'milestone';
    const ms = milestoneOf(card);
    const fm = faceModel(card, { cards: current.cards, done: cfg().roles.done, label });
    const el = h('article', 'card' + (thread ? ' is-thread' : milestone ? ' is-milestone' : ''));
    el.dataset.id = card.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const top = h('div', 'card-top');
    top.appendChild(h('span', 'idchip', card.id));
    const kind = thread ? 'thread' : String(card.kind);
    top.appendChild(kindMark(kind));
    [bugMark(fm), priorityMark(fm)].forEach((mark) => { if (mark) top.appendChild(mark); });
    if (cardActions(card, gearCtx).length) top.appendChild(gearBtn(card));
    el.appendChild(top);

    el.appendChild(h('h3', 'card-title', card.title));
    const lbls = faceLabels(card, fm);
    if (lbls) el.appendChild(lbls);
    if (ms) el.appendChild(milestoneTag(ms));
    if (card.note) el.appendChild(h('p', 'card-note', card.note));
    const prog = milestone ? progressFor(card) : null;
    if (prog) el.appendChild(progressEl(prog));
    if (thread && t.parentSessionId) {
      const from = h('p', 'card-from', 'from ' + sessionLabel(t.parentSessionId));
      from.title = sessionLabel(t.parentSessionId);
      el.appendChild(from);
    }

    const foot = h('div', 'card-foot');
    if (thread) {
      foot.appendChild(runPill(t.runState));
      const n = turnsOf(card).length;
      foot.appendChild(h('span', 'tnum', n + (n === 1 ? ' turn' : ' turns')));
      const rt = reportTag(card);
      if (rt) foot.appendChild(rt);
      const tk = threadTokens(turnsOf(card));
      if (tk) { const e = h('span', 'tnum', totalText(tk)); e.title = tokensText(tk); foot.appendChild(e); }
      if (t.agent) { const e = h('span', 'card-agent', t.agent); e.title = 'Runs as the ' + t.agent + ' agent'; foot.appendChild(e); }
    }
    const lt = laneTag(card);
    if (lt) foot.appendChild(lt);
    faceTags(fm).forEach((tag) => foot.appendChild(tag));
    const waits = cardWaits(card);
    const wt = waitTag(waits, milestone ? 'milestone' : 'card');
    if (wt) foot.appendChild(wt);
    if (card.seenByClaude === false) foot.appendChild(unseenEl('span'));
    if (foot.childNodes.length) el.appendChild(foot);

    const rs = thread ? reportState(card) : '';
    el.setAttribute('aria-label', card.id + ', ' + kind + ', ' + card.title + (thread ? ', ' + (RUN[t.runState] || t.runState).toLowerCase() : '') + (thread && t.parentSessionId ? ', from ' + sessionLabel(t.parentSessionId) : '') + (thread && t.agent ? ', agent ' + t.agent : '') + (rs === 'not' ? ', not reported' : rs === 'queued' ? ', report queued' : rs === 'yes' ? ', reported' : '') + (ms ? ', in milestone ' + ms.title : '') + (laneInfo(card) ? ', lane ' + laneTagText(laneInfo(card)) : '') + fm.aria.map((a) => ', ' + a).join('') + (prog ? ', ' + prog.done + ' of ' + prog.total + ' done' : '') + (waits.length ? ', ' + waits.length + (milestone ? ' waiting for you on its cards' : ' waiting for you') : '') + (card.seenByClaude === false ? ', Claude has not seen this yet' : ''));

    el.addEventListener('click', () => {
      if (Date.now() - lastDragEnd < 200) return;
      openCard(card.id, el);
    });
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(card.id, el); }
    });

    if (!thread && !isRO()) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (dragBlocked(e)) return;
        dragId = card.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', endDrag);
    }
    return el;
  }

  // 'not' = a successful result the main session has not pulled, 'queued' = the same, with a report requested here,
  // 'yes' = the newest result was pulled, '' = no result yet
  function reportState(card) {
    const t = card.thread;
    if (!t || t.lastResult === null || t.lastResult === undefined) return '';
    if (t.reported) return 'yes';
    return t.reportRequestedAt ? 'queued' : 'not';
  }
  const REPORT_TAG = {
    not: ['attn', 's-diamond', 'Not reported', 'The main session has not pulled this thread’s result yet'],
    queued: ['queued', 's-dring', 'Report queued', 'The main session will pull this result with your next message'],
    yes: ['quiet', 's-ring', 'Reported', 'The main session has pulled this thread’s newest result'],
  };
  function reportTag(card) {
    const spec = REPORT_TAG[reportState(card)];
    if (!spec) return null;
    const tag = h('span', 'tag ' + spec[0]);
    tag.appendChild(shape(spec[1]));
    tag.appendChild(h('span', null, spec[2]));
    tag.title = spec[3];
    return tag;
  }
  // a web page cannot write into a Claude session, so a request waits for the main session's next message
  function queuedSentence(card) {
    const p = card.thread.parentSessionId;
    return 'Queued: it will be delivered with your next message in ' + (p ? sessionLabel(p) : 'the main session') + '.';
  }
  function stepsText(n) { return n + (n === 1 ? ' step' : ' steps'); }

  function runPill(state) {
    const p = h('span', 'pill');
    p.dataset.run = state;
    p.appendChild(shape(RUN_SHAPE[state] || 's-circle'));
    p.appendChild(h('span', null, (RUN[state] || String(state))));
    return p;
  }

  function endDrag() {
    const was = dragId !== null;
    dragId = null;
    if (was) lastDragEnd = Date.now();
    document.querySelectorAll('.col.over').forEach((c) => c.classList.remove('over'));
    document.querySelectorAll('.card.dragging').forEach((c) => c.classList.remove('dragging'));
    if (was && pendingRender) renderBoard(false);
  }
  document.addEventListener('dragend', endDrag);

  async function moveCard(id, status) {
    const card = findCard(id);
    if (!card || isThread(card) || card.status === status || isRO()) return;
    const key = selKey;
    clearError();
    await runAction('move:' + key + ':' + id, async () => {
      try { applyCard(await api('PATCH', pp(key, 'cards/' + encodeURIComponent(id)), { status }), key); wrote(); }
      catch (e) { showError(e.message); }
    });
    poll();
  }

  // ----- card actions shared by the board's gear menu and the card pages -----
  // Each runs one request with the usual error handling. `after` runs once the request has settled, before the next poll.
  // an ended thread goes to the stage with the done role, whatever the project calls it
  function endConfirmText() { return 'End this thread? It stops taking messages and the card moves to ' + label(cfg().roles.done) + '.'; }
  function deleteConfirmText(card) {
    if (isThread(card)) return 'Delete ' + card.id + ' and its history? This cannot be undone.';
    return 'Delete ' + card.id + '? ' + (card.kind === 'milestone' ? 'Its cards stay on the board. ' : '') + 'This cannot be undone.';
  }
  async function endThread(id, after) {
    clearError();
    const pk = selKey;
    await runAction('end:' + pk + ':' + id, async () => {
      try { applyCard(await api('POST', pp(pk, 'threads/' + encodeURIComponent(id) + '/end'), {}), pk); wrote(); }
      catch (e) { showError(e.message); }
    });
    if (after) after();
    poll();
  }
  // after(ok, here): ok = the card is gone from the server, here = the same project is still selected
  async function deleteCard(id, after) {
    clearError();
    let ok = false;
    const pk = selKey;
    await runAction('delete:' + pk + ':' + id, async () => {
      try { await api('DELETE', pp(pk, 'cards/' + encodeURIComponent(id)), {}); ok = true; wrote(); }
      catch (e) { showError(e.message); }
    });
    if (after) after(ok, pk === selKey);
    poll();
  }
  // Ask for a thread's report to arrive with the main session's next message, or take the request back.
  async function requestReport(id, on, after) {
    clearError();
    const pk = selKey;
    await runAction('report:' + pk + ':' + id, async () => {
      try { applyCard(await api(on ? 'POST' : 'DELETE', pp(pk, 'threads/' + encodeURIComponent(id) + '/report-request'), {}), pk); wrote(); }
      catch (e) { showError(e.message); }
    });
    if (after) after();
    poll();
  }
  // Put a task or idea in a milestone; '' takes it out. after(ok)
  async function setParent(id, parent, after) {
    clearError();
    let ok = false;
    const pk = selKey;
    await runAction('parent:' + pk + ':' + id, async () => {
      try { applyCard(await api('PATCH', pp(pk, 'cards/' + encodeURIComponent(id)), { parent }), pk); ok = true; wrote(); }
      catch (e) { showError(e.message); }
    });
    if (after) after(ok);
    poll();
  }

  // ---------- gear menu ----------
  // Every card with an action has a gear that opens a menu of them. Each item calls the code its card page uses.
  // ---- gear menu (page.test.mjs runs this block against a small fake DOM) ----

  function menuCtx() { return { ro: isRO(), stages: cfg().stages, choices: milestoneChoices(), reportState, waits: (c) => (isChat() ? 0 : openWaitsOf(c).length) }; }
  function menuActions(card) { return halted ? [] : cardActions(card, menuCtx()); }
  function menuItems(actions) { return actions.reduce((all, a) => all.concat(a.items || (a.sep ? [] : [a])), []); }
  function gearOf(id) { return elBoard.querySelector('.card[data-id="' + cssEscape(id) + '"] .gear'); }

  function gearBtn(card) {
    const b = h('button', 'btn ghost gear');
    b.type = 'button';
    b.title = 'Actions';
    b.setAttribute('aria-label', 'Actions for ' + card.id);
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', menu && menu.id === card.id ? 'true' : 'false');
    const g = h('span', null, '⚙︎');
    g.setAttribute('aria-hidden', 'true');
    b.appendChild(g);
    b.addEventListener('pointerdown', () => { gearDown = true; });
    // a held key repeats; only the first press may act
    b.addEventListener('keydown', (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu && menu.id === card.id) closeMenu(true); else openMenu(card.id, b);
    });
    return b;
  }
  // gearDown must not outlive its press: a press that never ends in a pointerup (a right-click) would cancel the next drag
  ['pointerup', 'pointercancel', 'dragend', 'contextmenu'].forEach((ev) => document.addEventListener(ev, () => { gearDown = false; }, true));
  // The card's dragstart asks this: true (and the drag is cancelled) when the press began on a gear.
  function dragBlocked(e) {
    if (!gearDown) return false;
    gearDown = false;
    e.preventDefault();
    return true;
  }

  function openMenu(id, gear) {
    closeMenu(false);
    const card = findCard(id);
    if (!card || !menuActions(card).length) return;
    const el = h('div', 'menu');
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Actions for ' + id);
    el.addEventListener('keydown', menuKeydown);
    menu = { id, el, gear, confirm: null, sig: '', timer: 0 };
    document.body.appendChild(el);
    gear.setAttribute('aria-expanded', 'true');
    renderMenu(true);
  }

  // refocus: put focus back on the card's gear (or, if it is gone, the card, or the New card button)
  function closeMenu(refocus) {
    const m = menu;
    if (!m) return;
    menu = null;
    clearTimeout(m.timer);
    m.el.remove();
    const g = gearOf(m.id);
    m.gear.setAttribute('aria-expanded', 'false');
    if (g) g.setAttribute('aria-expanded', 'false');
    if (!refocus) return;
    const t = g || elBoard.querySelector('.card[data-id="' + cssEscape(m.id) + '"]') || elNewBtn;
    t.focus({ preventScroll: true });
  }

  function menuEntry(a) {
    const b = h('button', 'menu-item' + (a.danger ? ' danger' : ''));
    b.type = 'button';
    b.tabIndex = -1;
    b.dataset.key = a.id;
    b.setAttribute('role', a.radio ? 'menuitemradio' : 'menuitem');
    if (a.radio) {
      b.setAttribute('aria-checked', a.checked ? 'true' : 'false');
      const mark = h('span', 'menu-mark', a.checked ? '✓' : '');
      mark.setAttribute('aria-hidden', 'true');
      b.appendChild(mark);
    }
    b.appendChild(h('span', 'menu-text', a.label));
    if (a.hint) b.appendChild(h('span', 'menu-hint', a.hint));
    if (a.disabled) { b.setAttribute('aria-disabled', 'true'); if (a.why) b.title = a.why; }
    b.addEventListener('click', () => { if (b.getAttribute('aria-disabled') !== 'true') menuDo(a, b); });
    return b;
  }

  // Draw the items (or the confirm step); focus stays on the same item, or goes to the first one.
  function renderMenu(focusFirst) {
    const m = menu, card = findCard(m.id), el = m.el;
    const a = document.activeElement;
    const had = a && el.contains(a) ? a.dataset.key : null;
    const scrolled = el.scrollTop;
    el.replaceChildren();
    const actions = menuActions(card);
    if (m.confirm) {
      const p = h('p', 'menu-confirm', m.confirm === 'end' ? endConfirmText() : deleteConfirmText(card));
      p.id = 'menu-confirm-text';
      el.setAttribute('aria-describedby', p.id);
      el.append(p, menuEntry({ id: 'keep', label: m.confirm === 'end' ? 'Keep it open' : 'Keep it' }), menuEntry({ id: 'go', label: m.confirm === 'end' ? 'End thread' : 'Delete card', danger: true }));
    } else {
      el.removeAttribute('aria-describedby');
      actions.forEach((x, i) => {
        if (x.sep) { const s = h('div', 'menu-sep'); s.setAttribute('role', 'separator'); el.appendChild(s); }
        else if (x.group) {
          const g = h('div', 'menu-group');
          g.setAttribute('role', 'group');
          const l = h('div', 'menu-label', x.group);
          l.id = 'menu-group-' + i;
          g.setAttribute('aria-labelledby', l.id);
          g.appendChild(l);
          x.items.forEach((it) => g.appendChild(menuEntry(it)));
          el.appendChild(g);
        } else el.appendChild(menuEntry(x));
      });
    }
    m.sig = menuSig(actions);
    placeMenu();
    const items = Array.from(el.querySelectorAll('[role^="menuitem"]'));
    el.scrollTop = scrolled;
    if (focusFirst || had !== null) focusItem(el, items.find((i) => i.dataset.key === had) || items[0]);
  }
  function menuSig(actions) { return JSON.stringify([actions, menu.confirm]); }

  // Below the gear and right-aligned with it; above it near the bottom edge; always inside the viewport.
  function placeMenu() {
    const el = menu.el, g = menu.gear.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight, pad = 8;
    const w = el.offsetWidth, ht = el.offsetHeight;
    const left = Math.min(Math.max(g.right - w, pad), Math.max(pad, vw - w - pad));
    let top = g.bottom + 4;
    if (top + ht > vh - pad) top = g.top - 4 - ht >= pad ? g.top - 4 - ht : Math.max(pad, vh - pad - ht);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  // The gear is inside a column's scrolling area: once it has scrolled out of sight the menu has nothing to hang from.
  function gearInView(gear) {
    const col = gear.closest('.col-body');
    if (!col) return true;
    const a = gear.getBoundingClientRect(), c = col.getBoundingClientRect(), b = elBoard.getBoundingClientRect();
    return a.bottom > c.top && a.top < c.bottom && a.right > b.left && a.left < b.right;
  }

  // After the board was drawn again: follow the new gear, update the items, or close.
  function syncMenu() {
    const m = menu;
    if (!m) return;
    const card = findCard(m.id), gear = card && gearOf(m.id);
    const actions = card ? menuActions(card) : [];
    const items = menuItems(actions);
    if (!gear || !actions.length) { closeMenu(true); return; }
    // a step waiting for a yes is void once its action no longer applies
    if (m.confirm && !items.some((i) => i.id === (m.confirm === 'end' ? 'end' : 'delete') && !i.disabled)) m.confirm = null;
    m.gear = gear;
    gear.setAttribute('aria-expanded', 'true');
    if (menuSig(actions) !== m.sig) renderMenu(false); else placeMenu();
  }

  function menuKeydown(e) {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return; }   // holding the key that opened the menu must not choose an item
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    if (e.key === 'Tab') { closeMenu(true); return; }      // the Tab then moves on from the gear
    const items = Array.from(menu.el.querySelectorAll('[role^="menuitem"]'));
    const i = items.indexOf(document.activeElement);
    let n;
    if (e.key === 'ArrowDown') n = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else return;
    e.preventDefault();
    focusItem(menu.el, items[n]);
  }
  // Focus an item without scrolling the page, then scroll the menu itself to show it (a long menu scrolls).
  function focusItem(el, item) {
    item.focus({ preventScroll: true });
    const top = item.offsetTop, bottom = top + item.offsetHeight;
    if (item === el.querySelector('[role^="menuitem"]')) el.scrollTop = 0;     // the first item brings its group label with it
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }

  document.addEventListener('pointerdown', (e) => {
    if (!(e.target.closest && e.target.closest('.gear'))) gearDown = false;
    if (menu && !menu.el.contains(e.target) && !menu.gear.contains(e.target)) closeMenu(false);
  }, true);
  document.addEventListener('scroll', (e) => {
    if (!menu || menu.el.contains(e.target) || !menu.gear.isConnected) return;
    if (gearInView(menu.gear)) placeMenu(); else closeMenu(true);
  }, true);
  window.addEventListener('resize', () => { if (menu) placeMenu(); });

  // One item was chosen. Each calls what the card's page calls.
  function menuDo(a, btn) {
    const m = menu, id = m.id, card = findCard(id);
    if (!card) { closeMenu(true); return; }
    if (a.id === 'end' || a.id === 'delete') { m.confirm = a.id; renderMenu(true); return; }
    if (a.id === 'keep') { closeMenu(true); return; }
    if (a.id === 'copy') {
      const conf = cfg();
      copyOrWarn(milestoneReport(card, current.cards, conf.stages, conf.roles.done)).then((ok) => {
        if (menu !== m) return;
        btn.querySelector('.menu-text').textContent = ok ? 'Copied' : 'Copy failed';
        m.timer = setTimeout(() => { if (menu === m) closeMenu(true); }, 900);
      });
      return;
    }
    if (a.id === 'start') {
      closeMenu(false);
      startFor = id;
      setTimeout(() => { if (startFor === id) startFor = ''; }, 1500);
      openCard(id, true);
      return;
    }
    if (a.id === 'waits') {
      closeMenu(false);
      waitsFor = id;
      setTimeout(() => { if (waitsFor === id) waitsFor = ''; }, 1500);
      openCard(id, true);
      return;
    }
    const confirmed = m.confirm;
    closeMenu(true);
    if (a.id === 'go' && confirmed === 'end') endThread(id);
    else if (a.id === 'go') {
      deleteCard(id, (ok, here) => {
        if (!ok || !here) return;
        dropCard(id);
        renderBoard(false);
        if (!document.activeElement || document.activeElement === document.body) elNewBtn.focus({ preventScroll: true });
      });
    }
    else if (a.id === 'report') requestReport(id, a.on);
    else if (a.id.startsWith('move:')) moveCard(id, a.value);
    else if (a.id.startsWith('ms:')) setParent(id, a.value);
  }
  // ---- end gear menu ----

  elSearch.addEventListener('input', () => renderBoard(false));
  elThreadsOnly.addEventListener('click', () => {
    elThreadsOnly.setAttribute('aria-pressed', elThreadsOnly.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    renderBoard(false);
  });
  elWaiting.addEventListener('click', () => toggleWaiting());
  elNewBtn.addEventListener('click', () => { if (elNewBtn.getAttribute('aria-disabled') === 'true') return; openNew(); });
  elSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elSearch.value) { e.stopPropagation(); elSearch.value = ''; renderBoard(false); }
  });

