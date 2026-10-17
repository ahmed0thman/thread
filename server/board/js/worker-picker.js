  // ---------- the Worker picker ----------
  // The modal behind a card's Worker button: "Claude (default)" pinned on top, then three tabs (Sub-agents, Project lanes, Global lanes) and one
  // search box over all of them. It only chooses. The caller keeps the choice (the card form's Save, or the start step) and says what follows.
  let workerModal = null;   // the open picker: { close }
  function closeWorkerPicker() { if (workerModal) workerModal.close(); }

  // The Worker button's content: its text and a caret.
  function workerButtonContent(key) {
    const caret = h('span', 'wk-caret');
    caret.setAttribute('aria-hidden', 'true');
    return [h('span', 'wk-text', workerLabel(key)), caret];
  }

  // The card page's Worker button: the effective worker (see effectiveWorker in model.js). A worker working now has the live dot, a quiet one the
  // ring (the same marks as the card's work indicator); one only last used is muted.
  function workerFieldContent(eff) {
    const caret = h('span', 'wk-caret');
    caret.setAttribute('aria-hidden', 'true');
    const main = h('span', 'wk-main');
    if (eff.state === 'now' || eff.state === 'quiet') {
      const dot = h('span', 'work-compact wk-dot ' + (eff.state === 'now' ? 'work-live' : 'work-quiet'));
      dot.appendChild(shape(eff.state === 'now' ? 's-pulse' : 's-dring'));
      main.appendChild(dot);
    }
    main.appendChild(h('span', 'wk-text' + (eff.state === 'quiet' || eff.state === 'last' ? ' wk-muted' : ''), eff.text));
    return [main, caret];
  }

  // The lists loaded again (a lane approved, a sub-agent added): an open picker shows the new rows.
  function refreshWorkerPicker() { if (workerModal) workerModal.refresh(); }

  // `value` is the worker now chosen (a key, see model.js), `opener` the button to give the focus back to, `onPick(key)` what to do with a choice.
  // `findOpener()` finds the button again when the page was drawn again meanwhile and `opener` is gone.
  // `marks()` says which listed workers work on the card now or were used last: { 'agent:x': 'now', 'lane:y': 'last' } (see workerMarks).
  function openWorkerPicker({ value, opener, onPick, findOpener, marks: getMarks }) {
    closeWorkerPicker();
    let rows = workerRows();
    let found = true;
    let query = '';
    let tab = workerTabOf(rows, value) || (WORKER_TABS.find(([id]) => rows[id].length) || WORKER_TABS[0])[0];
    let active = null;   // the row that is a tab stop; the arrows move it
    let cardMarks = {};  // read again each time the lists are drawn

    const scrim = h('div', 'wp-scrim');
    const box = h('div', 'wp');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'wp-title');
    box.tabIndex = -1;
    scrim.appendChild(box);

    const head = h('div', 'wp-head');
    const title = h('h2', 'wp-title', 'Choose a worker');
    title.id = 'wp-title';
    const x = plainBtn('×', 'icon ghost', () => close());
    x.setAttribute('aria-label', 'Close');
    x.title = 'Close (Esc)';
    head.append(title, x);

    const search = h('input', 'input wp-search');
    search.type = 'search';
    search.placeholder = 'Search by name, provider or model';
    search.setAttribute('aria-label', 'Search workers by name, provider or model');
    search.autocomplete = 'off';

    const pinned = h('div', 'wp-pinned');
    pinned.setAttribute('role', 'listbox');
    pinned.setAttribute('aria-label', 'Claude without a lane or sub-agent');
    const tabs = h('div', 'wp-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Kinds of worker');
    const tabBtns = WORKER_TABS.map(([id, label]) => {
      const b = h('button', 'wp-tab');
      b.type = 'button';
      b.id = 'wp-tab-' + id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'wp-list');
      b.addEventListener('click', () => { tab = id; active = null; draw(); b.focus(); });
      tabs.appendChild(b);
      return b;
    });
    const list = h('div', 'wp-list');
    list.id = 'wp-list';
    list.setAttribute('role', 'listbox');
    box.append(head, search, pinned, tabs, list);

    function badge(text, title, cls) {
      const t = h('span', 'tag wp-badge' + (cls ? ' ' + cls : ''), text);
      if (title) t.title = title;
      return t;
    }
    // One choice: its name and dials, its badges, and what else it has to say (a sub-agent's description, why a lane cannot be picked).
    function rowEl(r) {
      const el = h('div', 'wp-row');
      el.setAttribute('role', 'option');
      el.tabIndex = -1;
      el.dataset.key = r.key;
      const cur = r.key === value;
      el.setAttribute('aria-selected', cur ? 'true' : 'false');
      const off = !!r.why;
      if (off) el.setAttribute('aria-disabled', 'true');
      const top = h('div', 'wp-top');
      top.appendChild(h('span', 'wp-name', r.name));
      const line = r.line !== undefined ? r.line : workerRowLine(r);
      if (line) top.appendChild(h('span', 'wp-line', line));
      const marks = h('span', 'wp-marks');
      if (cardMarks[r.key] === 'now') marks.appendChild(badge('Working now', 'This worker is working on this card right now', 'wp-now'));
      else if (cardMarks[r.key] === 'last') marks.appendChild(badge('Last used', 'Claude used this worker last on this card', 'wp-last'));
      if (cur) marks.appendChild(badge('Current', '', 'wp-cur'));
      if (r.kind === 'agent' && r.why !== 'not found') marks.appendChild(badge(r.where === 'user' ? 'User' : 'Project', r.where === 'user' ? 'Defined in your own .claude/agents folder' : 'Defined in this project’s .claude/agents folder', 'wp-where'));
      if (r.readOnly) marks.appendChild(badge('Read-only', 'This lane cannot edit files'));
      if (r.overrides) marks.appendChild(badge('Overrides global', 'A global lane has the same name; this project’s lane is used instead'));
      if (off) marks.appendChild(badge(r.why === 'not found' ? 'Not found' : r.why.charAt(0).toUpperCase() + r.why.slice(1), '', 'attn'));
      top.appendChild(marks);
      el.appendChild(top);
      if (r.desc) el.appendChild(h('p', 'wp-desc', r.desc));
      if (off && r.hint) el.appendChild(h('p', 'wp-hint', r.hint));
      el.addEventListener('click', () => choose(el, r));
      return el;
    }
    const defaultRow = { key: '', kind: '', name: 'Claude (default)', line: 'Runs on this session’s model', desc: '', why: '', hint: '' };
    const lostRow = { key: value, kind: workerKind(value), name: (workerKind(value) === 'agent' ? 'agent: ' : '') + workerName(value), line: '', desc: '', why: 'not found', hint: 'No longer available. Pick another worker.' };

    const navRows = () => Array.from(box.querySelectorAll('.wp-row'));
    function setActive(el) {
      navRows().forEach((r) => { r.tabIndex = r === el ? 0 : -1; });
      active = el;
    }
    function emptyText(id) {
      if (query.trim() && rows[id].length) return 'Nothing in this tab matches “' + query.trim() + '”.';
      if (id === 'agents') return 'No sub-agents are defined. Add a file under .claude/agents in the project or in your own folder.';
      if (lanes && !lanes.available) return 'The delegate skills could not be read, so there are no lanes.';
      return id === 'project' ? 'This project has no lanes of its own. Set them up with the delegate-setup skill.' : 'No global lanes are set up. Use the delegate-setup skill.';
    }
    function draw() {
      cardMarks = (getMarks && getMarks()) || {};
      found = value === '' || WORKER_TABS.some(([id]) => rows[id].some((r) => r.key === value));
      const shown = workerFilter(rows, query);
      tabBtns.forEach((b, i) => {
        const [id, label] = WORKER_TABS[i];
        b.replaceChildren(label, h('span', 'wp-count', String(shown[id].length)));
        b.setAttribute('aria-selected', id === tab ? 'true' : 'false');
        b.tabIndex = id === tab ? 0 : -1;
        b.setAttribute('aria-label', label + ', ' + shown[id].length + (query.trim() ? ' matching' : ''));
      });
      list.setAttribute('aria-labelledby', 'wp-tab-' + tab);
      pinned.replaceChildren(rowEl(defaultRow), ...(found ? [] : [rowEl(lostRow)]));
      list.replaceChildren(...shown[tab].map(rowEl));
      if (!shown[tab].length) list.appendChild(h('p', 'wp-empty', emptyText(tab)));
      const all = navRows();
      setActive(all.find((r) => r.dataset.key === value && r.getAttribute('aria-selected') === 'true') || all[0]);
    }
    // drawn again for new lists: the search, the tab and the row that has the focus stay, the row found again by its key
    function refresh() {
      const a = document.activeElement;
      const key = a && box.contains(a) && a.classList.contains('wp-row') ? a.dataset.key : null;
      rows = workerRows();
      draw();
      if (key !== null) {
        const same = navRows().find((r) => r.dataset.key === key);
        if (same) { setActive(same); same.focus({ preventScroll: true }); }
        else if (active) active.focus({ preventScroll: true });
      }
    }
    function choose(el, r) {
      if (el.getAttribute('aria-disabled') === 'true') return;
      close();
      onPick(r.key);
    }
    function close() {
      if (workerModal !== api) return;
      workerModal = null;
      scrim.remove();
      elOverlay.inert = false;
      document.removeEventListener('focusin', keepIn, true);
      const back = opener && opener.isConnected ? opener : findOpener ? findOpener() : null;
      if (back) back.focus({ preventScroll: true });
    }
    // focus never leaves the dialog: something that gets it from outside is brought back
    function keepIn(e) { if (!box.contains(e.target)) { e.stopPropagation(); (active || search).focus(); } }

    search.addEventListener('input', () => { query = search.value; draw(); });
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();   // the page's own keys (Esc closes the card, / and n) stay out of the dialog
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const stops = Array.from(box.querySelectorAll('button:not([disabled]), input, [tabindex="0"]')).filter((el) => el.tabIndex >= 0 && el.getClientRects().length);
        if (!stops.length) { e.preventDefault(); return; }
        const first = stops[0], last = stops[stops.length - 1], a = document.activeElement;
        if (!box.contains(a) || a === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
        else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
        return;
      }
      const t = e.target;
      if (t.classList && t.classList.contains('wp-tab') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const i = WORKER_TABS.findIndex(([id]) => 'wp-tab-' + id === t.id);
        tab = WORKER_TABS[(i + (e.key === 'ArrowRight' ? 1 : WORKER_TABS.length - 1)) % WORKER_TABS.length][0];
        active = null;
        draw();
        tabBtns[WORKER_TABS.findIndex(([id]) => id === tab)].focus();
        return;
      }
      const rowsNow = navRows();
      const i = rowsNow.indexOf(t);
      if (e.key === 'ArrowDown' && (t === search || i >= 0)) {
        e.preventDefault();
        const next = t === search ? rowsNow[0] : rowsNow[Math.min(i + 1, rowsNow.length - 1)];
        if (next) { setActive(next); next.focus(); }
      } else if (e.key === 'ArrowUp' && i >= 0) {
        e.preventDefault();
        if (i === 0) search.focus(); else { setActive(rowsNow[i - 1]); rowsNow[i - 1].focus(); }
      } else if ((e.key === 'Home' || e.key === 'End') && i >= 0) {
        e.preventDefault();
        const to = e.key === 'Home' ? rowsNow[0] : rowsNow[rowsNow.length - 1];
        setActive(to); to.focus();
      } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
        e.preventDefault();
        choose(t, { key: t.dataset.key });
      }
    });

    const api = { close, refresh };
    workerModal = api;
    draw();
    elOverlay.inert = true;
    document.body.appendChild(scrim);
    document.addEventListener('focusin', keepIn, true);
    search.focus();
  }
