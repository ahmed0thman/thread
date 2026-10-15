  function elapsedEl(iso) {
    const e = h('span', 'elapsed', fmtMs(Date.now() - new Date(iso).getTime()));
    e.dataset.since = iso;
    return e;
  }
  setInterval(() => {
    document.querySelectorAll('time[data-rel]').forEach((t) => {
      const v = rel(t.dataset.rel);
      if (t.textContent !== v) t.textContent = v;
    });
    document.querySelectorAll('[data-since]').forEach((e) => {
      const v = fmtMs(Date.now() - new Date(e.dataset.since).getTime());
      if (e.textContent !== v) e.textContent = v;
    });
  }, 1000);

  function isTyping(t) {
    if (!t || !t.tagName) return false;
    const n = t.tagName;
    return n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT' || t.isContentEditable;
  }

  // ---------- errors, connection, busy buttons ----------

  function showError(message) {
    if (halted) return;                          // the access-link page is showing instead
    elBannerText.textContent = String(message || 'Something went wrong.');
    elBanner.hidden = false;
  }
  function clearError() { elBanner.hidden = true; }
  $('banner-close').addEventListener('click', () => {
    clearError();
    if (panel && panel.root) panel.root.focus({ preventScroll: true });
  });

  // ---------- theme ----------
  // The page follows the system theme until the user picks one with the button.
  const THEME_KEY = 'thread-board-theme';
  function savedTheme() {
    try { const t = localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; } catch (e) { return null; }
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const btn = $('theme-btn');
    btn.textContent = theme === 'dark' ? 'Theme: Dark' : 'Theme: Light';
    btn.title = 'Switch to the ' + (theme === 'dark' ? 'light' : 'dark') + ' theme';
  }
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $('theme-btn').addEventListener('click', function () {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* not saved: the choice lasts for this page only */ }
    applyTheme(next);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
    if (!savedTheme()) applyTheme(e.matches ? 'dark' : 'light');
  });

  function setOnline(ok) {
    const state = ok ? 'online' : 'offline';
    const el = $('conn');
    if (el.dataset.state === state) return;
    el.dataset.state = state;
    $('conn-text').textContent = ok ? 'Online' : 'Offline';
    el.querySelector('.shape').className = 'shape ' + (ok ? 's-circle' : 's-cross');
  }

  function syncBusy() {
    document.querySelectorAll('[data-busykey]').forEach((b) => {
      const busy = !!inflight[b.dataset.busykey];
      b.classList.toggle('busy', busy);
      if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      b.disabled = busy || b.dataset.off === '1';
    });
  }
  async function runAction(key, fn) {
    if (inflight[key]) return undefined;
    inflight[key] = true;
    syncBusy();
    try { return await fn(); }
    finally { delete inflight[key]; syncBusy(); }
  }
  // A button tied to a request key: busy while in flight, never double-submitted.
  function actionBtn(text, cls, key, onClick) {
    const b = h('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.dataset.busykey = key;
    b.addEventListener('click', () => { if (!inflight[key] && b.dataset.off !== '1') onClick(); });
    return b;
  }
  function setOff(b, off) { b.dataset.off = off ? '1' : '0'; b.disabled = off || !!inflight[b.dataset.busykey]; }
  function plainBtn(text, cls, onClick) {
    const b = h('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ---------- network ----------

  function authError() { const e = new Error('The board needs its access link.'); e.auth = true; return e; }

  // One place that talks to the server: always sends the token, turns 401 into the access-link page.
  async function request(method, path, body, timeoutMs) {
    if (!token) { haltForAuth(); throw authError(); }
    const opts = { method, headers: { 'X-Thread-Token': token }, cache: 'no-store' };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body || {}); }
    if (timeoutMs && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
    let res, text;
    try { res = await fetch(path, opts); text = await res.text(); }
    catch (e) { throw new Error('Could not reach the board server.'); }
    if (res.status === 401) { haltForAuth(/expired/.test((parseJson(text) || {}).error || '')); throw authError(); }
    return { res, text };
  }
  function parseJson(text) { try { return JSON.parse(text); } catch (e) { return null; } }
  async function api(method, path, body) {
    const { res, text } = await request(method, path, body);
    const data = parseJson(text);
    if (!res.ok) throw new Error((data && data.error) ? data.error : 'Request failed (status ' + res.status + ')');
    return data;
  }
  function pp(key, rest) { return '/api/p/' + encodeURIComponent(key) + '/' + rest; }

  // ----- access-link page -----
  let loopTimer = null;
  function haltForAuth(expired) {
    if (halted) return;
    halted = true;
    $('gate-default').hidden = !!expired;
    $('gate-expired').hidden = !expired;
    clearTimeout(loopTimer); loopTimer = null;
    closeMenu(false);
    if (panel) { if (panel.dispose) panel.dispose(); panel = null; }
    elOverlay.replaceChildren();
    elOverlay.hidden = true;
    elApp.inert = false;
    elBanner.hidden = true;
    elSendBar.hidden = true;
    elApp.hidden = true;
    elGate.hidden = false;
    elGateRetry.focus({ preventScroll: true });
  }
  function resumeAfterAuth() {
    halted = false;
    elGate.hidden = true;
    elApp.hidden = false;
    elGateMsg.textContent = '';
    if (selKey) { const k = selKey; selKey = ''; selectProject(k); }
    else syncFromHash();
    loopTimer = setTimeout(tick, POLL_MS);
  }
  elGateRetry.addEventListener('click', async () => {
    if (elGateRetry.classList.contains('busy')) return;
    elGateRetry.classList.add('busy'); elGateRetry.disabled = true;
    elGateMsg.textContent = '';
    token = readStoredToken();
    try {
      if (!token) elGateMsg.textContent = 'No access link is stored in this tab. Open the link that /thread:board prints.';
      else { applyProjects(await loadProjects()); resumeAfterAuth(); }
    } catch (e) {
      elGateMsg.textContent = e.auth ? 'That access link is not valid (any more). Run /thread:board again and open the new link.' : e.message;
    } finally {
      elGateRetry.classList.remove('busy'); elGateRetry.disabled = false;
    }
  });

  // ----- loops -----
  // ---- tick (page.test.mjs runs this function with stubs) ----
  async function tick() {
    loopTimer = null;
    if (halted) return;
    await poll();
    if (halted) return;
    if (!projects || Date.now() - projectsAt >= PROJECTS_MS) await refreshProjects();
    if (halted) return;
    if (Date.now() - versionAt >= PROJECTS_MS) await refreshVersion();
    if (halted) return;
    if (Date.now() - lanesAt >= PROJECTS_MS) refreshLanes();   // not awaited: the delegate script may take seconds
    loopTimer = setTimeout(tick, POLL_MS);
  }
  // ---- end tick ----

  async function poll() {
    if (halted || !selKey) return;
    const key = selKey;
    const seq = ++pollSeq;
    let res, text;
    try { ({ res, text } = await request('GET', pp(key, 'state'), null, 5000)); }
    catch (e) {
      if (!e.auth && key === selKey && seq > appliedSeq) setOnline(false);
      return;
    }
    if (key !== selKey) return;                 // the user moved to another project meanwhile
    if (!res.ok) {
      if (res.status === 404) refreshProjects(); // the project vanished: the list will move us on
      else if (seq > appliedSeq) setOnline(false);
      return;
    }
    if (seq < appliedSeq) return;
    appliedSeq = seq;
    setOnline(true);
    if (text === lastRaw) return;               // nothing changed: no DOM work
    const data = parseJson(text);
    if (!data || !Array.isArray(data.cards)) return;
    lastRaw = text;
    try { apply(data); } catch (e) { console.error(e); }
  }

  // Use a card the server just returned without waiting for the next poll.
  function applyCard(card, key) { applyCards([card], key); }
  // Several cards at once (the answers sent together), drawn once.
  function applyCards(list, key) {
    if (!current || (key !== undefined && key !== selKey)) return;
    const cards = current.cards.slice();
    let any = false;
    (list || []).forEach((card) => {
      if (!card) return;
      any = true;
      const i = cards.findIndex((c) => c.id === card.id);
      if (i >= 0) cards[i] = card; else cards.push(card);
    });
    if (!any) return;
    appliedSeq = ++pollSeq;                     // older polls still in flight are ignored
    lastRaw = null;
    apply(Object.assign({}, current, { cards }));
  }

  // Remove a card from the state at once (it was just deleted on the server); older polls still in flight are ignored.
  function dropCard(id) {
    if (!current || !current.cards.some((c) => c.id === id)) return;
    appliedSeq = ++pollSeq;
    lastRaw = null;
    current = Object.assign({}, current, { cards: current.cards.filter((c) => c.id !== id) });
    currentKey = JSON.stringify(current);
  }

  function apply(data) {
    current = data;
    currentKey = JSON.stringify(data);
    setDir(data.projectDir ? String(data.projectDir) : '');
    modeSeen[selKey] = isChat();
    updateToolbar();
    renderNotice();
    maybeRenderChrome();
    renderBoard(false);
    if (!synced) { synced = true; syncFromHash(); }
    else updatePanel();
  }

