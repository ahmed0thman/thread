  // ---------- global keys ----------

  function trapList() {
    const sel = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]';
    const list = Array.from(panel.root.querySelectorAll(sel)).filter((e) => e.tabIndex >= 0 && !e.closest('[hidden]') && e.getClientRects().length);
    if (!elSendBar.hidden) list.push(elSendBtn);
    if (!elBanner.hidden) list.push($('banner-close'));
    return list;
  }

  // ---- global keys (page.test.mjs runs this block with stand-ins) ----
  function onGlobalKey(e) {
    if (e.defaultPrevented || e.isComposing || halted) return;
    if (menu && menu.el.contains(e.target)) return;
    if (panel) {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      if (e.key === 'Tab') {
        const list = trapList();
        if (!list.length) { e.preventDefault(); return; }
        const first = list[0], last = list[list.length - 1], a = document.activeElement;
        const inside = panel.root.contains(a) || a === $('banner-close') || a === elSendBtn;
        if (!inside) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && (a === first || a === panel.root)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    if (e.key === '/') { e.preventDefault(); elSearch.focus(); elSearch.select(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openNew(); }
    else if (e.key === 'w' || e.key === 'W') { e.preventDefault(); toggleWaiting(); }
  }
  document.addEventListener('keydown', onGlobalKey);
  // ---- end global keys ----

  // ---------- start ----------

  (async function start() {
    if (!token) { haltForAuth(); return; }
    await loadCaps();   // before anything is drawn, so no control that the tunnel refuses is ever shown
    try { applyProjects(await loadProjects()); if (!selKey) setOnline(true); }   // a project's own poll shows the connection
    catch (e) { if (e.auth) return; setOnline(false); }
    projectsAt = Date.now();
    if (!halted) loopTimer = setTimeout(tick, POLL_MS);
  })();
