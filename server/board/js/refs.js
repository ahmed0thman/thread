  // ---------- references to cards and waiting items ----------
  // A card id or a waiting item id in Markdown text is a link (content.js makes it: <a class="cref" data-card data-wait>). Here is what it
  // does: a small preview (one shared popover) after a short hover or at once on keyboard focus, and a click that opens the card's page and,
  // for an item, scrolls to it and puts focus on it. The popover is built from DOM nodes only.

  let waitFocus = null;      // { card, wid }: the item a clicked reference points at; used (or dropped) when the next card page is built
  let pendingVisit = null;   // { card, wid }: a reference followed while the open page has unsaved edits, until Discard or Keep editing
  let refMute = false;       // true while the page puts focus back on a reference itself: that is not a keyboard visit
  let refPop = null;         // the popover element while it is in the page
  let refCur = null;         // { link, card, wait } the popover shows
  let refShowT = 0, refHideT = 0, refWatchT = 0;
  const REF_DELAY = 300, REF_GRACE = 200;
  const refLink = (t) => (t && t.closest ? t.closest('a.cref') : null);
  const WAIT_STATE_TEXT = { open: 'Open', answered: 'Answered', withdrawn: 'Withdrawn' };

  // Opens a card's page (the one in the address when it is already open) and, for an item, brings it into view.
  function visitRef(cardId, wid) {
    hideRefPop();
    clearTimeout(refShowT);
    if (panel && panel.target !== cardId && panel.isDirty && panel.isDirty()) {
      // unsaved edits: nothing moves. The discard prompt asks; Discard comes back here (takePendingVisit), Keep editing drops it.
      pendingVisit = { card: cardId, wid };
      panel.showDiscard();
      return;
    }
    waitFocus = wid ? { card: cardId, wid } : null;
    if (panel && panel.target === cardId) { revealWait(); return; }
    // From one card's page to another's the address entry is replaced, so Back and Esc go where "Back to ..." says (the view, or the
    // entry under the page). From a view the card opens as a board card does, one entry that Back takes away again.
    if (panel) { location.replace(hashFor(selKey, cardId)); return; }
    openCard(cardId, true);
  }
  // Discard changes was pressed: go on to the reference that was waiting. False when nothing was (then the page just closes).
  function takePendingVisit() {
    const v = pendingVisit;
    pendingVisit = null;
    if (!v) return false;
    visitRef(v.card, v.wid);
    return true;
  }
  function dropPendingVisit() { pendingVisit = null; }
  // Scrolls to the item the last clicked reference named, moves focus to it and marks it for a moment. A closed item may sit in the
  // collapsed "Earlier items": that is opened first.
  function revealWait() {
    const f = waitFocus;
    waitFocus = null;
    if (!f || !panel || panel.target !== f.card) return;
    const li = Array.from(panel.root.querySelectorAll('[data-wid]')).find((e) => e.dataset.wid === f.wid);
    if (!li) return;
    for (let d = li.closest('details'); d; d = d.parentElement ? d.parentElement.closest('details') : null) d.open = true;
    li.tabIndex = -1;
    li.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    li.focus({ preventScroll: true });
    li.classList.add('ref-flash');
    setTimeout(() => li.classList.remove('ref-flash'), 2400);
  }

  function refStage(card) {
    const st = cfg().stages.find((x) => x.id === card.status);
    return st ? st.label : '';
  }
  // What the popover says about a reference: a waiting item (state, its text, the card it is on) or a card (type, stage, items waiting).
  function refPopBody(card, wait) {
    const root = h('div', 'cp-body');
    const top = h('div', 'cp-top');
    if (wait) top.append(waitKindMark(wait.kind, false), h('span', 'idchip', wait.id), h('span', 'cp-state', WAIT_STATE_TEXT[wait.state] || String(wait.state || '')));
    else {
      top.appendChild(kindMark(card.kind));
      if (card.kind !== 'milestone' && card.type === 'bug') top.appendChild(h('span', 'tag', 'Bug'));
      top.appendChild(h('span', 'idchip', card.id));
    }
    root.appendChild(top);
    if (wait) {
      root.appendChild(h('p', 'cp-text', clip(plainMd(wait.text), 160)));
      if (wait.state !== 'open') root.appendChild(h('p', 'cp-note', wait.state === 'withdrawn' ? 'Claude no longer needs this item.' : 'This item has been answered.'));
      const on = h('p', 'cp-meta');
      on.append('On ', h('strong', null, card.id), ': ' + clip(plainMd(card.title), 80));
      root.appendChild(on);
    } else {
      root.appendChild(h('p', 'cp-title', clip(plainMd(card.title), 120)));
      const bits = [];
      if (card.kind === 'milestone') {
        const n = childrenOf(current.cards, card.id).length;
        bits.push(n + (n === 1 ? ' card' : ' cards'));
      } else if (refStage(card)) bits.push(refStage(card));
      const open = openWaitsOf(card).length;
      bits.push(open ? open + ' waiting for you' : 'nothing waiting');
      root.appendChild(h('p', 'cp-meta', bits.join(' · ')));
    }
    return root;
  }
  function buildRefPop(card, wait) {
    const pop = h('div', 'cref-pop');
    pop.id = 'cref-pop';
    pop.setAttribute('role', 'group');
    pop.setAttribute('aria-label', wait ? 'Waiting item ' + wait.id : 'Card ' + card.id);
    const go = h('button', 'btn small primary', 'Visit');
    go.type = 'button';
    go.setAttribute('aria-label', 'Visit ' + (wait ? wait.id : card.id));
    go.addEventListener('click', () => visitRef(card.id, wait ? wait.id : ''));
    pop.append(refPopBody(card, wait), go);
    return pop;
  }
  // Below the link, moved to the other side or in as far as it takes to stay inside the window (and clear of the send bar).
  function placeRefPop(pop, link) {
    const r = link.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    const bar = typeof elSendBar !== 'undefined' && !elSendBar.hidden ? elSendBar.getBoundingClientRect().height : 0;
    const floor = vh - bar - 8;
    const left = Math.min(Math.max(16, r.left), Math.max(16, vw - w - 16));
    let top = r.bottom + 6;
    if (top + ph > floor && r.top - 6 - ph >= 8) top = r.top - 6 - ph;
    top = Math.max(8, Math.min(top, floor - ph));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  function showRefPop(link) {
    clearTimeout(refShowT);
    clearTimeout(refHideT);
    if (refCur && refCur.link === link) return;
    hideRefPop();
    if (!link.isConnected || typeof refCard !== 'function') return;
    const card = refCard(link.dataset.card);
    const wait = card && link.dataset.wait && !isChat() ? waitsOf(card).find((w) => w.id === link.dataset.wait) : null;
    if (!card || (link.dataset.wait && !wait)) return;
    const pop = refPop = buildRefPop(card, wait);
    pop.style.visibility = 'hidden';
    (link.closest('[role="dialog"]') || document.body).appendChild(pop);
    placeRefPop(pop, link);
    pop.style.visibility = '';
    link.setAttribute('aria-describedby', 'cref-pop');
    refCur = { link, card, wait, at: Date.now() };
    // the reference can go away under the popover (the page is drawn again): then so does the popover
    refWatchT = setInterval(() => { if (!link.isConnected) hideRefPop(); }, 500);
  }
  function hideRefPop() {
    clearTimeout(refHideT);
    clearInterval(refWatchT);
    // the state goes first: taking the focused Visit button out of the page fires focusout, which comes back here
    const pop = refPop, cur = refCur;
    refPop = null;
    refCur = null;
    if (cur) cur.link.removeAttribute('aria-describedby');
    if (pop) pop.remove();
  }
  // focus back on a reference without opening its preview (Esc from Visit, the page closing)
  function focusRef(el) {
    refMute = true;
    try { el.focus({ preventScroll: true }); } finally { refMute = false; }
  }
  const keyFocus = (el) => { try { return el.matches(':focus-visible'); } catch (e) { return true; } };
  const canHover = () => !window.matchMedia || window.matchMedia('(hover: hover)').matches;

  document.addEventListener('mouseover', (e) => {
    const a = refLink(e.target);
    if (a) {
      clearTimeout(refHideT);
      if (!canHover() || (refCur && refCur.link === a)) return;
      clearTimeout(refShowT);
      refShowT = setTimeout(() => showRefPop(a), REF_DELAY);
    } else if (refPop && refPop.contains(e.target)) clearTimeout(refHideT);
  });
  document.addEventListener('mouseout', (e) => {
    const a = refLink(e.target);
    const inPop = refPop && refPop.contains(e.target);
    if (!a && !inPop) return;
    const to = e.relatedTarget;
    if (to && ((refPop && refPop.contains(to)) || refLink(to) === (a || (refCur && refCur.link)))) return;
    clearTimeout(refShowT);
    if (!refCur) return;
    const f = document.activeElement;
    if (f && (f === refCur.link || refPop.contains(f)) && keyFocus(f)) return;   // the keyboard is on it: it stays until the keyboard leaves (a click's focus is not that)
    clearTimeout(refHideT);
    refHideT = setTimeout(hideRefPop, REF_GRACE);
  });
  document.addEventListener('focusin', (e) => {
    const a = refLink(e.target);
    if (a && !refMute && keyFocus(a)) showRefPop(a);
    else if (refCur && !(refPop && refPop.contains(e.target)) && a !== refCur.link) hideRefPop();
  });
  document.addEventListener('focusout', (e) => {
    if (!refCur) return;
    const to = e.relatedTarget;
    if (to && (refPop.contains(to) || to === refCur.link)) return;
    if (e.target === refCur.link || refPop.contains(e.target)) hideRefPop();
  });
  // Escape closes the preview and nothing else (the card's page stays); Tab from the link goes to Visit and on from there. In the capture
  // phase so the page's own keys do not see these.
  window.addEventListener('keydown', (e) => {
    if (!refCur) return;
    const link = refCur.link, inPop = refPop.contains(e.target);
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      hideRefPop();
      if (inPop) focusRef(link);
    } else if (e.key === 'Tab' && (e.target === link || inPop)) {
      e.stopPropagation();
      if (e.target === link && !e.shiftKey) { e.preventDefault(); refPop.querySelector('button').focus({ preventScroll: true }); }
      else if (inPop && e.shiftKey) { e.preventDefault(); link.focus({ preventScroll: true }); }
      else if (inPop) { hideRefPop(); focusRef(link); }   // the browser's Tab then goes on from the link
    }
  }, true);
  // a scroll just after it opened is the browser bringing the focused link into view: move with it
  window.addEventListener('scroll', (e) => {
    if (!refCur || refPop.contains(e.target)) return;
    if (Date.now() - refCur.at < 300) placeRefPop(refPop, refCur.link); else hideRefPop();
  }, true);
  window.addEventListener('resize', hideRefPop);
  // A plain click goes to the card; a click with a modifier is the browser's own (the card's address in a new tab).
  document.addEventListener('click', (e) => {
    const a = refLink(e.target);
    if (!a || e.defaultPrevented || (e.button !== undefined && e.button !== 0) || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    visitRef(a.dataset.card, a.dataset.wait || '');
  });
