  // The stages come from the project's config; these are the defaults, for a server that sends none.
  const LABELS = { idea: 'Idea', new: 'New', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done' };
  const DEFAULT_CONFIG = {
    mode: 'tasks',
    stages: Object.keys(LABELS).map((id) => ({ id, label: LABELS[id] })),
    roles: { start: 'new', working: 'in_progress', review: 'review', blocked: 'blocked', done: 'done' },
  };
  const EMPTY = {
    idea: 'No ideas yet. Park half-formed thoughts here.',
    new: 'Nothing waiting. New work lands here.',
    in_progress: 'Nothing in progress right now.',
    review: 'Nothing to review.',
    blocked: 'Nothing is blocked.',
    done: 'Nothing finished yet.',
  };
  const KINDS = ['did', 'found', 'decided', 'changed', 'open'];
  const KIND_LABEL = { did: 'Did', found: 'Found', decided: 'Decided', changed: 'Changed', open: 'Open' };
  const KIND_SHAPE = { did: 's-circle', found: 's-hdiamond', decided: 's-diamond', changed: 's-square', open: 's-dring' };
  const SECTIONS = [['happened', 'Happened', 'did'], ['decided', 'Decided', 'decided'], ['changed', 'Changed', 'changed'], ['open', 'Open', 'open']];
  const RUN = { running: 'Running', idle: 'Finished', failed: 'Failed', ended: 'Ended' };
  const RUN_SHAPE = { running: 's-pulse', idle: 's-check', failed: 's-cross', ended: 's-square' };
  const CK_SHAPE = { task: 's-square', idea: 's-diamond', thread: 's-ring', milestone: 's-tri' };
  const POLL_MS = 2000;
  const PROJECTS_MS = 5000;
  const TOKEN_KEY = 'thread-board-token';
  const READONLY_WHY = 'This project’s folder was not found, so its cards are read-only.';

  const $ = (id) => document.getElementById(id);
  const elApp = $('app'), elBoard = $('board'), elSearch = $('search'), elThreadsOnly = $('threads-only');
  const elNote = $('filter-note'), elNewBtn = $('new-btn'), elOverlay = $('overlay');
  const elBanner = $('banner'), elBannerText = $('banner-text');
  const elNotice = $('notice'), elFilesNotice = $('files-notice'), elSwitcher = $('switcher'), elProjSelect = $('proj-select'), elViews = $('views');
  const elToolbar = $('toolbar'), elSearchWrap = $('search-wrap'), elFilters = $('filters'), elChips = $('chips'), elPane = $('pane');
  const elSession = $('session-filter'), elSessionWrap = $('session-wrap');
  const elMilestone = $('milestone-filter'), elMilestoneWrap = $('milestone-wrap'), elModeNote = $('mode-note'), elOldNote = $('old-note');
  const elWaiting = $('waiting-btn'), elWaitN = $('waiting-n'), elWaitLegend = $('wait-legend');
  const elSendBar = $('send-bar'), elSendText = $('send-text'), elSendBtn = $('send-btn');
  const elGate = $('gate'), elGateRetry = $('gate-retry'), elGateMsg = $('gate-msg');

  // ---------- plugin version ----------
  const pageVersion = document.querySelector('meta[name="thread-version"]').content;
  $('plugin-version').textContent = 'v' + pageVersion;
  $('version-reload').addEventListener('click', () => location.reload());
  let versionAt = 0;         // when the server's version was last asked for
  let versionSays = null;    // the note the server's version calls for: { text, reload }, or null while the versions agree
  function parts(v) { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v)); return m ? m.slice(1).map(Number) : null; }
  // True when x.y.z version a is lower than b; false when either is not x.y.z.
  function olderThan(a, b) {
    const x = parts(a), y = parts(b);
    if (!x || !y) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  }
  // Shown unless the older-session note is: the two would contradict each other. The text is written only when it changes.
  function showVersionNote() {
    const say = $('old-note').hidden ? versionSays : null;
    const text = say ? say.text : '';
    if ((say || !versionSays) && $('version-text').textContent !== text) $('version-text').textContent = text;
    $('version-reload').hidden = !(say && say.reload);
    $('version-note').hidden = !say;
  }
  async function refreshVersion() {
    versionAt = Date.now();
    let version;
    try {
      const { res, text } = await request('GET', '/api/ping', null, 5000);
      const data = res.ok ? parseJson(text) : null;
      if (data && typeof data.version === 'string') version = data.version;
      if (data && typeof data.remote === 'boolean' && data.remote !== remote) loadCaps();   // the first answer was lost
    } catch (e) { /* an old or unreachable server has no version to compare */ }
    if (!version || version === pageVersion) versionSays = null;
    else if (olderThan(version, pageVersion)) versionSays = { reload: false, text: 'This page is from version ' + pageVersion + ', but the board is now served by an older session on version ' + version + '. Run /thread:board in an updated session, then reload this page.' };
    else versionSays = { reload: true, text: 'This page is from version ' + pageVersion + ', but the board is now served by version ' + version + '. Reload the page.' };
    showVersionNote();
  }

  // ---------- access token ----------
  let halted = false;        // true while the access-link page is showing: no polling at all
  // ---- token in the address (tunnel.test.mjs runs this block on its own) ----
  let token = '';
  function readStoredToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  // A local link carries the token as ?t=. A link through the tunnel carries it in the fragment, '#t=<token>' followed by the usual
  // route ('#t=<token>/<project>'): a fragment is never sent to a server, so Cloudflare does not see it. Either way it is kept for
  // this tab and taken out of the address bar before the route is read.
  (function initToken() {
    let fromUrl = '';
    let route = '';
    const fm = /^#t=([0-9a-f]{32,128})(\/.*)?$/.exec(location.hash || '');
    if (fm) {
      fromUrl = fm[1];
      route = fm[2] || '';
    } else {
      try { fromUrl = new URLSearchParams(location.search).get('t') || ''; } catch (e) { fromUrl = ''; }
    }
    if (!fromUrl) { token = readStoredToken(); return; }
    token = fromUrl;
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) { /* storage unavailable: keep it in the variable */ }
    try {
      if (fm) {
        history.replaceState(null, '', location.pathname + location.search + (route ? '#' + route : ''));
      } else {
        const sp = new URLSearchParams(location.search);
        sp.delete('t');
        const qs = sp.toString();
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      }
    } catch (e) { /* leave the address bar as it is */ }
  })();
  // ---- end token in the address ----

  // ---------- projects ----------
  let projects = null;       // [{ key, projectDir, name, exists, cards, threads, running, open, done, waiting, lastActivity }] in a stable order
  let homeKey = '';          // the project the server calls home: where an address without a known project lands
  let selKey = '';           // the selected project; '' on the projects home
  let showingHome = false;   // the projects home (#/) is showing
  let viewSel = '';          // the view of the selected project that is showing ('' until its board has loaded): summary, board, list, milestones or waiting
  const modeSeen = {};       // chat-only or not, by project, for the projects this page has opened (the project list does not say)
  let projectsAt = 0;
  let projectsBusy = false;
  let lanes = null;          // the selected project's delegation lanes: { available, projectTrusted, lanes }, null until loaded
  let lanesSig = '';         // lanes as text, to tell a change
  let lanesAt = 0;           // when the lanes were last asked for
  let agents = null;         // the selected project's sub-agents: { agents: [{ name, description, model, effort, scope }] }, null until loaded
  let agentsSig = '';        // agents as text, to tell a change
  const filterMemo = {};     // per project: { q, threadsOnly, session, milestone, waiting }

  let current = null;        // newest state from the server
  let currentKey = '';
  let lastRaw = null;
  let pollSeq = 0, appliedSeq = 0;
  let boardKey = null;
  let dragId = null, pendingRender = false, lastDragEnd = 0;
  let gearCtx = null;        // what the gear menus may offer, worked out once per board render
  let menu = null;           // the open gear menu: { id, el, gear, confirm, sig, timer }
  let gearDown = false;      // a press that began on a card's gear: it must not start a drag
  let startFor = '';         // a card whose page should open at the "Start as thread" step
  let waitsFor = '';         // a card whose page should open at its "Waiting for you" section
  let notifyFor = '';        // a card whose page should open at the "Notify Claude" step
  let panel = null;          // the open drawer or thread workspace, if any
  let hashPushed = false;    // true when the open panel added a history entry
  let returnFocus = null;    // where focus goes when the panel closes
  let synced = false;
  const drafts = {};         // composer drafts by thread id
  const inflight = {};       // request keys currently in flight

  // ---------- small helpers ----------

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function shape(cls) { const s = h('span', 'shape ' + cls); s.setAttribute('aria-hidden', 'true'); return s; }
  // the small "task / idea / thread" marker beside a card id
  function kindMark(kind) {
    const km = h('span', 'kindmark');
    km.dataset.ck = kind;
    km.appendChild(shape(CK_SHAPE[kind] || 's-square'));
    km.appendChild(h('span', null, kind));
    return km;
  }
  // the "Claude has not seen this yet" marker
  function unseenEl(tag) {
    const u = h(tag, 'unseen');
    u.appendChild(shape('s-circle'));
    u.appendChild(h('span', null, 'Claude has not seen this yet'));
    return u;
  }
  // the "Claude notified" marker: a Notify Claude request is open on the card (the session picked is named in the tooltip)
  function notifiedEl(tag, card) {
    const u = h(tag, 'notified');
    u.appendChild(shape('s-check'));
    u.appendChild(h('span', null, 'Claude notified'));
    if (card && card.notifySession) u.title = 'Asked ' + sessionLabel(card.notifySession) + ' to look at this card';
    return u;
  }
  // The board's settings as the server sent them (stages, which stage each role uses, chat-only or not).
  function cfg() {
    const c = current && current.config;
    return c && Array.isArray(c.stages) && c.stages.length && c.roles ? c : DEFAULT_CONFIG;
  }
  function isChat() { return cfg().mode === 'chat'; }
  function label(status) {
    const s = cfg().stages.find((x) => x.id === status);
    return s ? s.label : String(status);
  }
  function findCard(id) {
    if (!current) return null;
    for (const c of current.cards) if (c.id === id) return c;
    return null;
  }
  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, ''); }
  function turnsOf(c) { return (c.thread && Array.isArray(c.thread.turns)) ? c.thread.turns : []; }

  function exact(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }
  function rel(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + ' s ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const hr = Math.floor(m / 60);
    if (hr < 24) return hr + ' h ago';
    const dd = Math.floor(hr / 24);
    if (dd < 14) return dd + ' d ago';
    return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }
  function timeEl(iso) {
    const t = h('time', null, rel(iso));
    t.dateTime = iso || '';
    t.title = exact(iso);
    t.dataset.rel = iso || '';
    return t;
  }
  function fmtMs(ms) {
    let s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    let m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's';
    const hr = Math.floor(m / 60); m = m % 60;
    return hr + 'h ' + String(m).padStart(2, '0') + 'm';
  }
