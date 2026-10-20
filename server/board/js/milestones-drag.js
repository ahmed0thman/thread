  // ---------- the Milestones map: arranging, linking and moving by keyboard ----------
  // The map can be changed on the computer itself (through the tunnel it is only looked at; the server refuses these routes there too):
  // - Drag a milestone to another cell. The layout is saved on this machine (PUT .../milestone-layout), never in the repo. A cell that is
  //   taken is swapped. Reset layout forgets all of it.
  // - Drag the dot on the right of a milestone onto the milestone that waits for it: that one now depends on this one, a link drawn by hand
  //   (POST .../milestones/<id>/depends-on). Cards are not held up by it; it is part of the picture.
  // - The same from the keyboard and on touch: M moves the picked milestone with the arrow keys (Enter drops, Escape cancels), and the details
  //   have Move, Add dependency and Remove.

  let msView = null;            // the last drawing's grid, cells and map (msMapEl sets it)
  let msDrag = null;            // what the pointer is doing right now (see msNodeDown, msHandleDown)
  let msEdgeTab = '';           // the line that is the tab stop of the lines on the map
  let msSuppressUntil = 0;      // the click that ends a drag must not pick
  const MS_DRAG_PX = 5;         // how far a press must move to be a drag: a click still picks
  const MS_HOLD_MS = 450;       // a finger must rest this long to take a milestone (moving sooner is a scroll)
  const MS_EDGE_PX = 40;        // near the side of the map box, a drag scrolls it

  function msCanEdit() { return !isRemote(); }
  // The saved layout: the one being saved while the server has not answered, else the server's.
  function msLayout() { const u = msUi(); return u.pending || (current && current.milestoneLayout) || {}; }
  // What the pane's key holds of the layout and of what is in progress, so a change to either draws the map again.
  function msUiSig(u, list) {
    const ids = new Set(list.map((m) => m.id));
    const lay = msLayout();
    return [Object.keys(lay).filter((id) => ids.has(id) && lay[id]).sort().map((id) => [id, lay[id].col, lay[id].row]), u.move ? [u.move.id, u.move.col, u.move.row] : null, u.edge, !!u.confirmReset, u.pop ? [u.pop.key, u.pop.mode] : null];
  }

  // ---- what the map says back: one polite line under the key ----
  let msNoteEl = null;
  let msNoteTimer = 0;
  let msNoteKey = '';   // the project the line speaks about
  function msNote() {
    if (!msNoteEl) { msNoteEl = h('p', 'ms-note'); msNoteEl.setAttribute('role', 'status'); msNoteEl.setAttribute('aria-live', 'polite'); }
    if (msNoteKey !== selKey) { msNoteEl.textContent = ''; msNoteEl.className = 'ms-note'; msNoteKey = selKey; }   // another project: not this one's news
    return msNoteEl;
  }
  function msSay(text, bad) {
    const e = msNote();
    msNoteKey = selKey;
    e.textContent = text;
    e.className = 'ms-note' + (bad ? ' is-bad' : '');
    clearTimeout(msNoteTimer);
    msNoteTimer = setTimeout(() => { if (e.textContent === text) { e.textContent = ''; e.className = 'ms-note'; } }, 9000);
  }
  // an error of the server without the name of the field it was sent under
  const msClean = (e) => String((e && e.message) || 'Something went wrong.').replace(/^depends_on: /, '');
  function msShake(id) {
    const li = msNodeLi(id);
    if (!li) return;
    li.className += ' ms-shake';
    setTimeout(() => { li.className = li.className.replace(' ms-shake', ''); }, 600);
  }

  const msNodeLi = (id) => (msView ? Array.prototype.find.call(msView.canvas.querySelectorAll('li.ms-node-wrap'), (x) => x.dataset.node === id) : null) || null;
  const msNodeOf = (id) => (msView ? msView.map.nodes.find((n) => n.id === id) : null);
  const msNameOfId = (id) => { const n = msNodeOf(id); return n ? msName(n) : id; };
  const msCellText = (c) => 'column ' + (c.col + 1) + ', row ' + (c.row + 1);
  function msFocusNode(id) {
    const b = Array.prototype.find.call(elPane.querySelectorAll('button.ms-node'), (x) => x.dataset.id === id);
    if (b) b.focus({ preventScroll: true });
  }
  // the click that ends a drag, or follows the press that started a move, must not pick a milestone again
  function msNodeClick(e, id) {
    if (Date.now() < msSuppressUntil) { if (e && e.preventDefault) e.preventDefault(); return; }
    const u = msUi();
    if (u.move && u.move.id === id) return;   // the milestone being moved: its keys are the move's
    msEndMove();
    msPickNode(id);
  }
  // A line picked on the map picks the milestone that waits on it, and the details say where the line comes from.
  // A move from the keyboard that something else ends (a click on another milestone or line, the Cards view): said, as Escape says it.
  function msEndMove() {
    const u = msUi();
    if (!u.move) return;
    u.move = null;
    msSay('Move cancelled.');
  }
  function msPickEdge(e) {
    const u = msUi();
    msEndMove();
    u.sel = e.from;
    u.edge = e.from + '>' + e.to;
    if (msCanEdit()) u.pop = { key: u.edge, mode: 'view', draft: e.name || '', fresh: true };
    msEdgeTab = u.edge;
    renderPane();
    if (u.pop) msFocusPop();
  }
  // ---- a line's own box ----
  const msEdgeEl = (key) => Array.prototype.find.call(elPane.querySelectorAll('g.ms-edge'), (g) => g.dataset.edge === key) || null;
  function msFocusEdge(key) { const g = msEdgeEl(key); if (g && g.focus) g.focus({ preventScroll: true }); }
  // The first button (or the field) of the open box gets the focus.
  function msFocusPop() {
    const pop = elPane.querySelector('.ms-pop');
    // a step that confirms a removal starts on Back, never on the button that removes
    const back = pop && msUi().pop && msUi().pop.mode === 'cards' ? Array.prototype.find.call(pop.querySelectorAll('.ms-pop-actions button'), (b) => b.textContent === 'Back') : null;
    const first = back || (pop && (pop.querySelector('input') || pop.querySelector('.ms-pop-actions button')));
    if (first) first.focus({ preventScroll: true });
  }
  function msOpenPop(key, mode) {
    const u = msUi();
    const e = msView && msView.key === selKey ? msView.map.edges.find((x) => x.from + '>' + x.to === key) : null;
    if (!e) return;
    u.sel = e.from;
    u.edge = key;
    u.pop = { key, mode: mode || 'view', draft: e.name || '', fresh: true };
    msEdgeTab = key;
    renderPane();
    msFocusPop();
  }
  function msClosePop(refocus) {
    const u = msUi();
    const key = u.pop && u.pop.key;
    u.pop = null;
    renderPane();
    if (refocus && key) { msFocusEdge(key); if (!msEdgeEl(key)) msFocusNode(u.sel); }
  }
  // Keys on a line: Enter or Space open its box, Delete too (the box is where removing is confirmed), the arrows move to the next line.
  function msEdgeKey(ev, map, e) {
    const k = ev.key;
    const key = e.from + '>' + e.to;
    if (k === 'Escape') { if (msUi().pop) { ev.preventDefault(); msClosePop(true); } return; }
    if (ev.repeat && (k === 'Enter' || k === ' ' || k === 'Delete' || k === 'Backspace')) { ev.preventDefault(); return; }
    if (k === 'Enter' || k === ' ' || k === 'Delete' || k === 'Backspace') { ev.preventDefault(); if (msCanEdit()) msOpenPop(key, 'view'); else msPickEdge(e); return; }
    const to = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
    if (!to) return;
    ev.preventDefault();
    const i = map.edges.indexOf(e);
    const next = map.edges[Math.max(0, Math.min(map.edges.length - 1, i + to))];
    const nk = next.from + '>' + next.to;
    msEdgeTab = nk;
    const g = msEdgeEl(nk);
    if (g) { Array.prototype.forEach.call(elPane.querySelectorAll('g.ms-edge'), (x) => x.setAttribute('tabindex', x === g ? '0' : '-1')); g.focus({ preventScroll: true }); }
  }
  // The map's own focus over a redraw (a poll that changed something): the name being typed, with its caret, and a line that has the focus.
  // (The pane's generic restore knows links, [data-id] elements and buttons by text; it does not know these.)
  function msFocusSnapshot() {
    const a = document.activeElement;
    if (!a || !a.getAttribute || !elPane.contains(a)) return null;
    if (a.className === 'ms-pop-input') return { k: 'name', s: a.selectionStart, e: a.selectionEnd };
    if (a.dataset && a.dataset.edge) return { k: 'edge', key: a.dataset.edge };
    return null;
  }
  function msFocusRestore(snap) {
    if (!snap) return;
    if (snap.k === 'edge') { msFocusEdge(snap.key); return; }
    const input = elPane.querySelector('.ms-pop-input');
    if (!input) return;
    input.focus({ preventScroll: true });
    if (input.setSelectionRange && typeof snap.s === 'number') input.setSelectionRange(snap.s, snap.e);
  }
  // A press anywhere but on the box or a line closes the box.
  function msOutsideDown(ev) {
    const u = msUiAll.get(selKey);
    if (!u || !u.pop || !elPane.querySelector('.ms-pop')) return;
    const t = ev.target;
    if (t && t.closest && (t.closest('.ms-pop') || t.closest('g.ms-edge') || t.closest('.ms-rel-line'))) return;
    u.pop = null;
    renderPane();
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('pointerdown', msOutsideDown, true);

  // Names the line (an empty text takes the name away): the waiting milestone's card keeps it.
  async function msRenameLine(e, text) {
    const u = msUi();
    const key = selKey;
    const name = String(text).trim();
    try {
      const card = await api('POST', pp(key, 'milestones/' + encodeURIComponent(e.from) + '/link-name'), { link: e.to, name });
      applyCard(card, key);
      const here = e.from + '>' + e.to;
      // back to the box of this line, unless the owner has moved on to another line or closed it meanwhile
      const stay = u.pop && u.pop.key === here;
      if (stay) u.pop = { key: here, mode: 'view', draft: name };
      renderPane();
      if (stay) msFocusPop();
      msSay(name ? 'The line from ' + msNameOfId(e.to) + ' to ' + msNameOfId(e.from) + ' is named "' + name + '".' : 'The line from ' + msNameOfId(e.to) + ' to ' + msNameOfId(e.from) + ' has no name now.');
    } catch (err) {
      if (!err.auth) msSay('The name was not saved: ' + msClean(err), true);
    }
  }
  // Takes the card links that make the line off their cards (the server uses the normal card update, so history, the repo and the other rules apply).
  async function msRemoveCardLinks(e) {
    const u = msUi();
    const key = selKey;
    const still = e.hand;
    try {
      // exactly the pairs the owner confirmed: the server takes only those, from the cards as they are now
      const data = await api('POST', pp(key, 'milestones/' + encodeURIComponent(e.from) + '/unlink-cards'), { dep: e.to, cards: e.links.map((l) => [l.card, l.by]) });
      u.pop = null;
      u.edge = still ? e.from + '>' + e.to : '';
      applyCards(data.cards, key);
      renderPane();
      const done = (data.removed || []).map((l) => l.card + ' no longer blocked by ' + l.by).join(', ');
      msSay((done ? 'Removed the card links: ' + done + '.' : 'Nothing was removed: the cards had changed since the list was shown.') + (data.skipped && done ? ' ' + msPlural(data.skipped, 'link had', 'links had') + ' already changed.' : '') + (still ? ' The link you drew is still there.' : ''));
      msFocusNode(u.sel);
    } catch (err) {
      if (!err.auth) msSay('The card links were not removed: ' + msClean(err), true);
    }
  }

  // ---- saving a layout ----
  // The state the page holds, with this layout in it (a reply of the server, or the older one after a refusal).
  function msApplyLayout(layout, key) {
    if (!current || key !== selKey) return;
    appliedSeq = ++pollSeq;       // answers of polls that left before this one are ignored
    lastRaw = null;
    apply(Object.assign({}, current, { milestoneLayout: layout }));
  }
  // Drops milestone `id` in a cell: the cell is taken by another milestone, they swap. The page shows the new layout at once and
  // puts the server's answer in its place; a refusal brings the old layout back.
  async function msCommitMove(id, col, row) {
    const u = msUi();
    const key = selKey;
    const cells = msView && msView.key === key ? msView.cells : null;
    if (!cells || !cells.get(id)) return;
    const plan = msMovePlan(cells, id, col, row);
    u.sel = id;
    u.edge = '';
    if (!Object.keys(plan).length) { msSay(msNameOfId(id) + ' stays in ' + msCellText(cells.get(id)) + '.'); renderPane(); msFocusNode(id); return; }
    const swapped = Object.keys(plan).filter((x) => x !== id);
    const saying = 'Moved ' + msNameOfId(id) + ' to ' + msCellText({ col, row }) + (swapped.length ? '; ' + msNameOfId(swapped[0]) + ' took its place' : '') + '.';
    u.pending = Object.assign({}, msLayout(), plan);
    renderPane();
    msFocusNode(id);
    try {
      const data = await api('PUT', pp(key, 'milestone-layout'), { set: plan });
      u.pending = null;
      msApplyLayout(data.layout || {}, key);
      msSay(saying);
    } catch (e) {
      u.pending = null;
      if (key === selKey) renderPane();
      if (!e.auth) msSay('The move was not saved: ' + msClean(e), true);
    }
  }
  async function msResetLayout() {
    const u = msUi();
    const key = selKey;
    u.confirmReset = false;
    u.pending = {};
    renderPane();
    try {
      const data = await api('DELETE', pp(key, 'milestone-layout'));
      u.pending = null;
      msApplyLayout(data.layout || {}, key);
      msSay('The layout is reset: the map places the milestones again.');
    } catch (e) {
      u.pending = null;
      if (key === selKey) renderPane();
      if (!e.auth) msSay('The layout was not reset: ' + msClean(e), true);
    }
    msFocusNode(msMapPick(msView && msView.key === key ? msView.map : { nodes: [] }, u.sel));
  }
  // "Reset layout", with a question before it does anything (a layout takes some work to make). Null when no milestone has a saved place.
  function msResetControl(list, u) {
    if (!msCanEdit()) return null;
    const ids = new Set(list.map((m) => m.id));
    const lay = msLayout();
    if (!Object.keys(lay).some((id) => ids.has(id))) { u.confirmReset = false; return null; }
    const box = h('span', 'ms-reset');
    if (!u.confirmReset) {
      const b = plainBtn('Reset layout', 'small ghost', () => { u.confirmReset = true; renderPane(); const y = elPane.querySelector('.ms-reset-yes'); if (y) y.focus({ preventScroll: true }); });
      b.title = 'Put every milestone back where the map places it';
      box.appendChild(b);
      return box;
    }
    box.appendChild(h('span', 'ms-reset-ask', 'Forget your layout?'));
    const yes = plainBtn('Reset', 'small ms-reset-yes', () => msResetLayout());
    const no = plainBtn('Keep it', 'small ghost', () => { u.confirmReset = false; renderPane(); const b = Array.prototype.find.call(elPane.querySelectorAll('.ms-reset button'), (x) => x.textContent === 'Reset layout'); if (b) b.focus({ preventScroll: true }); });
    box.append(yes, no);
    return box;
  }

  // ---- links ----
  // `waiter` now depends on `dep`: the arrow points at `waiter`.
  async function msAddLink(waiter, dep) {
    const u = msUi();
    const key = selKey;
    try {
      const card = await api('POST', pp(key, 'milestones/' + encodeURIComponent(waiter) + '/depends-on'), { add: dep });
      u.sel = waiter;
      u.edge = waiter + '>' + dep;
      applyCard(card, key);
      renderPane();
      msSay(msNameOfId(waiter) + ' now depends on ' + msNameOfId(dep) + ': the arrow points at ' + msNameOfId(waiter) + '. It holds up no card.');
    } catch (e) {
      if (!e.auth) { msSay('No link was made: ' + msClean(e), true); msShake(waiter); }
    }
  }
  async function msRemoveLink(waiter, dep) {
    const u = msUi();
    const key = selKey;
    const text = msNameOfId(waiter) + ' no longer depends on ' + msNameOfId(dep) + ' by a link you drew.';
    try {
      const card = await api('POST', pp(key, 'milestones/' + encodeURIComponent(waiter) + '/depends-on'), { remove: dep });
      u.edge = '';
      u.pop = null;
      applyCard(card, key);
      renderPane();
      msSay(text + (msView && msView.map.edges.some((e) => e.from === waiter && e.to === dep && e.links.length) ? ' Cards still link them.' : ''));
      msFocusNode(u.sel);
    } catch (e) {
      if (!e.auth) msSay('The link was not removed: ' + msClean(e), true);
    }
  }

  // ---- moving from the keyboard (and from the buttons of the details, for touch) ----
  function msStartMove(id) {
    const u = msUi();
    const c = msView && msView.key === selKey ? msView.cells.get(id) : null;
    if (!c) return;
    u.sel = id;
    u.edge = '';
    u.move = { id, col: c.col, row: c.row };
    msSay('Moving ' + msNameOfId(id) + ' from ' + msCellText(c) + '. The arrow keys move it, Enter drops it, Escape cancels.');
    renderPane();
    msFocusNode(id);
  }
  function msMoveBy(dc, dr) {
    const u = msUi();
    const mv = u.move;
    if (!mv) return;
    mv.col = Math.max(0, Math.min(MS_MAX_CELL, mv.col + dc));
    mv.row = Math.max(0, Math.min(MS_MAX_CELL, mv.row + dr));
    let there = null;
    if (msView) for (const [other, c] of msView.cells) if (other !== mv.id && c.col === mv.col && c.row === mv.row) there = other;
    msSay(msCellText(mv) + (there ? ': taken by ' + msNameOfId(there) + ', dropping swaps them' : ''));
    renderPane();
  }
  function msMoveKey(e, id) {
    const k = e.key;
    const d = k === 'ArrowLeft' ? [-1, 0] : k === 'ArrowRight' ? [1, 0] : k === 'ArrowUp' ? [0, -1] : k === 'ArrowDown' ? [0, 1] : null;
    if (d) { e.preventDefault(); msMoveBy(d[0], d[1]); msFocusNode(id); }
    else if (k === 'Enter') { e.preventDefault(); msDrop(); }
    else if (k === 'Escape') { e.preventDefault(); msCancelMove(); }
  }
  function msDrop() {
    const u = msUi();
    const mv = u.move;
    if (!mv) return;
    u.move = null;
    return msCommitMove(mv.id, mv.col, mv.row);
  }
  function msCancelMove() {
    const u = msUi();
    const id = u.move && u.move.id;
    if (!id) return;
    u.move = null;
    msSay('Move cancelled.');
    renderPane();
    msFocusNode(id);
  }

  // ---- the pointer ----
  // A press on a milestone is a click until it moves MS_DRAG_PX (a finger: until it has rested MS_HOLD_MS, then any movement drags; a
  // finger that moves first is scrolling the map). While one runs the pane is not drawn again (milestonesPaneKey), so the milestone stays in the hand.
  const msWin = () => window;
  function msListen(on) {
    const w = msWin();
    const fn = on ? w.addEventListener.bind(w) : w.removeEventListener.bind(w);
    fn('pointermove', msPointerMove);
    fn('pointerup', msPointerUp);
    fn('pointercancel', msPointerCancel);
    fn('keydown', msDragKey, true);
    fn('blur', msPointerCancel);
    fn('contextmenu', msPointerCancel, true);   // a ctrl+click is a right click on a Mac: no pointerup follows
    fn('touchmove', msTouchMove, { passive: false });
  }
  // a drag with a finger must not scroll the page under it
  function msTouchMove(e) { if (msDrag && msDrag.armed && e.cancelable) e.preventDefault(); }
  function msDragKey(e) {
    const d = msDrag;
    if (!d || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    msDragEnd(false);
    if (d.kind === 'move' || d.started) msSay('Cancelled: nothing was changed.');
  }
  function msPointerCancel() { if (msDrag) msDragEnd(false); }
  // the point of the map (from its top left corner) that the pointer is over
  function msAt(e) {
    const r = msView.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // a press that must not start a drag: another button, a ctrl+click (a right click on a Mac), or a move or drag already running
  const msIgnoreDown = (e) => !msView || msView.key !== selKey || (typeof e.button === 'number' && e.button !== 0) || (e.pointerType === 'mouse' && e.ctrlKey) || !!msUi().move;
  // A press whose end was never seen (no pointerup came) is ended by the next press, so a drag can never stay stuck.
  function msNodeDown(e, id) {
    if (msDrag) msDragEnd(false);
    if (msIgnoreDown(e)) return;
    const touch = e.pointerType === 'touch';
    msDrag = { kind: 'press', id, pid: e.pointerId, x0: e.clientX, y0: e.clientY, touch, armed: false, t: Date.now(), timer: 0 };
    if (touch) {
      msDrag.timer = setTimeout(() => { if (msDrag && msDrag.kind === 'press' && msDrag.id === id) { msDrag.armed = true; const li = msNodeLi(id); if (li) li.className += ' is-armed'; } }, MS_HOLD_MS);
    }
    msListen(true);
  }
  function msHandleDown(e, id) {
    if (msDrag) msDragEnd(false);
    if (msIgnoreDown(e)) return;
    e.preventDefault();       // no text selection, and the milestone is not focused by the press
    e.stopPropagation();
    msDrag = { kind: 'link', id, pid: e.pointerId, x0: e.clientX, y0: e.clientY, touch: e.pointerType === 'touch', armed: true, started: false, t: Date.now(), timer: 0 };
    msListen(true);
  }

  // the milestone under a point of the map, if any
  function msNodeAt(x, y) {
    for (const [id, c] of msView.cells) {
      const left = msView.grid.left(c.col), top = msView.grid.rowTop(c.row);
      if (x >= left && x <= left + MS_NODE_W && y >= top && y <= top + MS_NODE_H) return id;
    }
    return null;
  }
  // grows the map's box while a milestone is carried, so there is a cell to drop it in beyond the ones in use
  function msRoom(col, row) {
    const w = Math.max(msView.width, msView.grid.left(col) + MS_NODE_W + MS_COL), hgt = Math.max(msView.height, msView.grid.rowTop(row) + MS_NODE_H + MS_ROW);
    msView.canvas.style.width = w + 'px';
    msView.canvas.style.height = hgt + 'px';
  }
  function msScrollBy(e) {
    const r = msView.box.getBoundingClientRect();
    if (e.clientX < r.left + MS_EDGE_PX) msView.box.scrollLeft -= 24;
    else if (e.clientX > r.right - MS_EDGE_PX) msView.box.scrollLeft += 24;
  }

  function msPointerMove(e) {
    const d = msDrag;
    if (!d || !msView || (d.pid !== undefined && e.pointerId !== d.pid)) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) { msDragEnd(false); return; }   // the button was let go where no pointerup reached us
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    const far = Math.hypot(dx, dy) > MS_DRAG_PX;
    if (d.kind === 'press') {
      if (d.touch && !d.armed) { if (Math.hypot(dx, dy) > 10) msDragEnd(false); return; }   // a scroll, not a drag
      if (!far) return;
      msBeginMove(d);
    } else if (d.kind === 'link' && !d.started) {
      if (!far) return;
      msBeginLink(d);
    }
    if (d.kind === 'move') msCarry(d, e, dx, dy);
    else if (d.kind === 'link') msStretch(d, e);
  }

  function msBeginMove(d) {
    clearTimeout(d.timer);
    d.kind = 'move';
    d.li = msNodeLi(d.id);
    d.cell = msView.cells.get(d.id);
    d.target = { col: d.cell.col, row: d.cell.row };
    if (d.li) d.li.className += ' is-dragging';
    d.snap = h('div', 'ms-snap');
    d.snap.style.left = msView.grid.left(d.cell.col) + 'px';
    d.snap.style.top = msView.grid.rowTop(d.cell.row) + 'px';
    msView.canvas.appendChild(d.snap);
    document.documentElement.className += ' ms-dragging';
  }
  function msCarry(d, e, dx, dy) {
    if (d.li) d.li.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
    msScrollBy(e);
    const p = msAt(e);
    d.target = msSnap(msView.grid, p.x, p.y);
    msRoom(d.target.col, d.target.row);
    d.snap.style.left = msView.grid.left(d.target.col) + 'px';
    d.snap.style.top = msView.grid.rowTop(d.target.row) + 'px';
    let there = null;
    for (const [other, c] of msView.cells) if (other !== d.id && c.col === d.target.col && c.row === d.target.row) there = other;
    if (d.there !== there) {
      if (d.there) { const o = msNodeLi(d.there); if (o) o.className = o.className.replace(' is-swap', ''); }
      if (there) { const o = msNodeLi(there); if (o) o.className += ' is-swap'; }
      d.there = there;
    }
    d.snap.className = 'ms-snap' + (there ? ' is-swap' : '');
  }

  function msBeginLink(d) {
    d.started = true;
    d.li = msNodeLi(d.id);
    if (d.li) d.li.className += ' is-linking';
    const c = msView.cells.get(d.id);
    d.from = { x: msView.grid.left(c.col) + MS_NODE_W / 2 + MS_R + 14, y: msView.grid.rowTop(c.row) + MS_R + 9 };
    d.line = msSvg('path', { class: 'ms-link-preview' });
    d.tip = msSvg('path', { class: 'ms-link-tip' });
    const svg = msView.canvas.querySelector('svg.ms-edges');
    svg.appendChild(d.line);
    svg.appendChild(d.tip);
    document.documentElement.className += ' ms-dragging';
  }
  // the line from the dot to the pointer, and the milestone it would link to marked as a target (or as refused)
  function msStretch(d, e) {
    msScrollBy(e);
    const p = msAt(e);
    d.line.setAttribute('d', 'M' + d.from.x + ' ' + d.from.y + ' L' + p.x + ' ' + p.y);
    d.tip.setAttribute('d', 'M' + p.x + ' ' + p.y + ' m-5 -5 l5 5 l-5 5');
    const over = msNodeAt(p.x, p.y);
    const why = over ? msLinkRefusal(d.id, over) : '';
    if (d.over !== over) {
      if (d.over) { const o = msNodeLi(d.over); if (o) o.className = o.className.replace(' is-target', '').replace(' is-refused', ''); }
      if (over) { const o = msNodeLi(over); if (o) o.className += why ? ' is-refused' : ' is-target'; }
      d.over = over;
    }
  }
  // why a link from `dep` (the one that comes first) to `waiter` cannot be made without asking the server, or ''
  function msLinkRefusal(dep, waiter) {
    if (dep === waiter) return 'A milestone cannot depend on itself.';
    const n = msNodeOf(waiter);
    if (n && n.byHand.includes(dep)) return msNameOfId(waiter) + ' already depends on ' + msNameOfId(dep) + ' by a link you drew.';
    return '';
  }

  function msPointerUp(e) {
    const d = msDrag;
    if (!d || (d.pid !== undefined && e.pointerId !== d.pid)) return;
    const kind = d.kind;
    const view = msView;
    let finish = null;
    if (view && kind === 'move') {
      finish = { id: d.id, col: d.target.col, row: d.target.row, same: d.target.col === d.cell.col && d.target.row === d.cell.row };
    } else if (view && kind === 'link' && d.started) {
      const p = msAt(e);
      const over = msNodeAt(p.x, p.y);
      finish = { link: true, from: d.id, over };
    }
    const dragged = kind === 'move' || (kind === 'link' && d.started);
    msDragEnd(true);
    if (!dragged) { if (kind === 'link') msPickNode(d.id); return; }   // a click on a milestone: its click handler picks
    msSuppressUntil = Date.now() + 400;
    if (!finish) return;
    if (finish.link) {
      if (!finish.over) { msSay('No link was made: drop the line on a milestone.'); return; }
      const why = msLinkRefusal(finish.from, finish.over);
      if (why) { msSay(why, true); msShake(finish.over); return; }
      msAddLink(finish.over, finish.from);
    } else msCommitMove(finish.id, finish.col, finish.row);
  }

  // Ends a press, a carry or a link, and puts everything the drag changed back. `done` is false when it was cancelled.
  function msDragEnd(done) {
    const d = msDrag;
    if (!d) return;
    msDrag = null;
    clearTimeout(d.timer);
    msListen(false);
    document.documentElement.className = document.documentElement.className.replace(' ms-dragging', '');
    if (d.li) {
      d.li.style.transform = '';
      d.li.className = d.li.className.replace(' is-dragging', '').replace(' is-armed', '').replace(' is-linking', '');
    }
    [d.there, d.over].forEach((id) => { if (id) { const o = msNodeLi(id); if (o) o.className = o.className.replace(' is-swap', '').replace(' is-target', '').replace(' is-refused', ''); } });
    if (d.snap) d.snap.remove();
    if (d.line) d.line.remove();
    if (d.tip) d.tip.remove();
    if (!done && msView && (d.kind === 'move' || d.started)) {
      msView.canvas.style.width = msView.width + 'px';
      msView.canvas.style.height = msView.height + 'px';
      msSuppressUntil = Date.now() + 400;
    }
  }
