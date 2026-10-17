  // ---- tokens and agents (page.test.mjs runs this block on its own) ----
  // 945, 48.2k, 1.35M: three significant digits
  function fmtTokens(n) {
    const short = (v) => String(+v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0));
    if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n) || 0));
    return n < 999500 ? short(n / 1000) + 'k' : short(n / 1e6) + 'M';
  }
  // A turn's tokens, input side (fresh, cache read, cache write) and output; null when the turn recorded none.
  function turnTokens(t) {
    const u = t && t.usage;
    if (!u || typeof u !== 'object') return null;
    const n = (x) => (Number.isFinite(x) ? x : 0);
    return { in: n(u.input) + n(u.cacheRead) + n(u.cacheWrite), out: n(u.output) };
  }
  function threadTokens(turns) {
    let sum = null;
    turns.forEach((t) => {
      const x = turnTokens(t);
      if (x) sum = { in: (sum ? sum.in : 0) + x.in, out: (sum ? sum.out : 0) + x.out };
    });
    return sum;
  }
  function tokensText(x) { return fmtTokens(x.in) + ' in · ' + fmtTokens(x.out) + ' out'; }
  function totalText(x) { return fmtTokens(x.in + x.out) + ' tokens'; }
  function effortText(e) { return e === 'xhigh' ? 'extra-high' : e || ''; }
  // 'worker · claude-sonnet-5-5 · extra-high'
  function agentLabel(a) { return [a.name, a.model, effortText(a.effort)].filter(Boolean).join(' · '); }
  // The model a thread runs on: 'claude-sonnet-5-5 · extra-high', '' when neither is known.
  function modelText(t) { return [t.model, effortText(t.effort)].filter(Boolean).join(' · '); }
  // A thread without the field is an old one: a full copy.
  function isBrief(t) { return t.context === 'brief'; }
  // ---- end tokens and agents ----
  // ---- delegation lanes (page.test.mjs runs this block against a small fake DOM) ----
  // `lanes` is the server's { available, projectTrusted, lanes }, or null until it has answered.
  // The state of a card's lane: loading, ok, missing (not in the loaded lanes, or no delegate skills) or unapproved. null: no lane.
  // A thread shows the lane it started on (its snapshot), whatever the lanes are now.
  function laneInfo(card) {
    const tl = card && card.kind === 'thread' && card.thread ? card.thread.lane : null;
    if (tl && typeof tl.name === 'string' && tl.name) return { name: tl.name, state: 'ok', lane: tl };
    if (!card || typeof card.lane !== 'string' || !card.lane || (card.kind !== 'task' && card.kind !== 'idea')) return null;
    if (!lanes) return { name: card.lane, state: 'loading', lane: null };
    const lane = lanes.lanes.find((l) => l.name === card.lane) || null;
    if (!lane) return { name: card.lane, state: 'missing', lane: null };
    return { name: card.lane, state: lane.approved === false ? 'unapproved' : 'ok', lane };
  }
  function laneHint(info) {
    if (info.state === 'missing') return lanes && !lanes.available ? 'The delegate skills could not be read, so this lane cannot be checked.' : 'No lane has this name. Pick another one or set it up with the delegate-setup skill.';
    if (info.state === 'unapproved') return 'This lane comes from the project’s lane config, which is not approved yet. Approve it with the delegate-setup skill.';
    return '';
  }
  // The tag's text in two parts: the name (which a long name may cut short) and what follows it, which is never cut:
  // 'code-codex' and ' · codex', or the name with its problem.
  function laneTagParts(info) {
    if (info.state === 'ok') return [info.name, ' · ' + info.lane.implementer];
    if (info.state === 'missing') return [info.name, ' · not found'];
    if (info.state === 'unapproved') return [info.name, ' · not approved'];
    return [info.name, ''];
  }
  function laneTagText(info) { return laneTagParts(info).join(''); }
  // The icon (a hexagon) tells the tag from the milestone and agent ones without colour; a problem also says so in words.
  function laneTag(card) {
    const info = laneInfo(card);
    if (!info) return null;
    const tag = h('span', 'tag lane-tag' + (info.state === 'ok' || info.state === 'loading' ? ' lane-ok' : ' attn'));
    const parts = laneTagParts(info);
    tag.appendChild(shape('s-hex'));
    tag.appendChild(h('span', 'lane-tag-name', parts[0]));
    if (parts[1]) tag.appendChild(h('span', 'lane-tag-state', parts[1]));
    tag.title = info.state === 'ok'
      ? 'Delegation lane ' + info.name + ': ' + [info.lane.implementer, info.lane.model, info.lane.variant || effortText(info.lane.effort)].filter(Boolean).join(' · ') + (card.kind === 'thread' ? '. This thread runs on that lane.' : '. Starting this card as a thread runs it on that lane.')
      : 'Delegation lane ' + info.name + (laneHint(info) ? '. ' + laneHint(info) : '');
    return tag;
  }
  // What a lane's thread or card may do: agy is read-only in this version, a codex lane without a sandbox has full access.
  function laneAccess(card, l) {
    if (l.readOnly || l.implementer === 'agy' || (card.kind === 'thread' && card.thread.mode !== 'write')) return 'Read-only';
    return l.sandbox === 'danger-full-access' ? 'Full access (no sandbox)' : 'Can edit files';
  }
  // The rows on a task's or idea's page: [label, text]. A lane that is not found or not approved gets its Lane row and a hint.
  function laneRows(card) {
    const info = laneInfo(card);
    if (!info) return [];
    if (info.state === 'loading') return [['Lane', info.name]];
    if (info.state !== 'ok') return [['Lane', info.name + (info.state === 'missing' ? ' (not found)' : ' (not approved)')], ['Hint', laneHint(info)]];
    const l = info.lane;
    return [
      ['Lane', info.name], ['Provider', l.implementer], ['Model', l.model || 'CLI default'],
      l.variant ? ['Variant', l.variant] : ['Effort', effortText(l.effort) || 'CLI default'],
      ['Access', laneAccess(card, l)], ['Source', l.source === 'project' ? 'This project' : 'All projects'],
    ].concat(card.kind === 'thread' ? [['Follow-up', laneFollowUp(card).text]] : []);
  }
  // Whether a lane thread can take a follow-up: it needs the provider's session, and the lane must still be found, approved, on the same
  // provider, with its relay installed (once the lanes have loaded). `why` is the reason when it cannot, in a sentence of its own.
  function laneFollowUp(card) {
    const t = card.thread, l = t && t.lane;
    if (!l) return { ok: false, text: '', why: '' };
    const no = (why) => ({ ok: false, text: 'Not possible: ' + why, why: why.charAt(0).toUpperCase() + why.slice(1) });
    if (!l.session) {
      if (t.runState === 'running') return { ok: false, text: 'Not yet: the provider gives its session when the first turn ends', why: 'A turn is still running.' };
      return no(l.implementer + ' gave no session to continue. Start a new thread instead.');
    }
    if (lanes) {
      const now = lanes.available ? lanes.lanes.find((x) => x.name === l.name) : null;
      if (!lanes.available) return no('the delegate skills could not be read, so the lane cannot be checked.');
      if (!now) return no('lane “' + l.name + '” is no longer one of the loaded lanes.');
      if (now.approved === false) return no('lane “' + l.name + '” is not approved. Approve this project’s lane config with the delegate-setup skill.');
      if (now.implementer !== l.implementer) return no('lane “' + l.name + '” now runs on ' + now.implementer + ', which cannot continue a ' + l.implementer + ' session. Start a new thread instead.');
      if (now.relay === false) return no('the ' + now.implementer + ' relay (the ' + now.implementer + '-delegate skill) is not installed.');
      if (t.mode === 'write' && (now.readOnly || now.implementer === 'agy')) return no('lane “' + l.name + '” is read-only now.');
    }
    return { ok: true, text: 'Possible', why: '' };
  }
  // The one line over a lane thread's Trace: what the provider shows of a turn. '' when there is nothing to say.
  function laneTraceNote(card) {
    const t = card && card.thread, l = t && t.lane;
    if (!l) return '';
    if (l.implementer !== 'claude') return l.implementer + ' gives no live steps in this version. The report appears when the turn ends; any steps shown here come from that report.';
    return t.runState === 'running' ? 'The steps and token use of this turn appear when it ends.' : '';
  }
  // What the card page's start step shows for a card that has a lane: the line, the dials, whether it is read-only (and the note for
  // the Mode choice), what runs it, and why it cannot start.
  // `name` (the start step's own Lane choice, '' for none) stands in for the card's lane when given: the plan is for the lane the card
  // would run on if it were started now.
  function laneStartPlan(card, name) {
    if (name !== undefined && card) card = Object.assign({}, card, { lane: name });
    const info = laneInfo(card);
    if (!info || card.kind === 'thread') return null;
    if (info.state !== 'ok') {
      return { name: info.name, provider: '', line: 'Lane ' + info.name, detail: '', readOnly: false, modeNote: '', blocked: info.state === 'loading' ? 'The lane is still loading.' : (info.state === 'missing' ? 'Lane “' + info.name + '” was not found. ' : 'Lane “' + info.name + '” is not approved. ') + laneHint(info) };
    }
    const l = info.lane;
    const readOnly = l.readOnly === true || l.implementer === 'agy';
    const modeNote = l.implementer === 'agy' ? 'agy lanes are read-only in this version.' : readOnly ? 'This lane is read-only.' : l.sandbox === 'danger-full-access' ? 'This lane has no sandbox: in write mode it has full access.' : '';
    return { name: info.name, provider: l.implementer, line: 'Runs on lane ' + info.name + ' · ' + l.implementer, detail: [l.model, l.variant || effortText(l.effort)].filter(Boolean).join(' · '), readOnly, modeNote, blocked: '' };
  }
  // The lane name a task or idea holds, '' for none. A card file written by hand can hold anything: only a name counts.
  const laneOf = (card) => (card && typeof card.lane === 'string' ? card.lane : '');
  // Puts the card's lane rows at the end of a details list, in place of the ones put there before. Returns the new nodes.
  function showLaneRows(dl, before, card) {
    before.forEach((n) => n.remove());
    const nodes = [];
    laneRows(card).forEach(([k, v]) => {
      const dt = h('dt', null, k), dd = h('dd', null, v);
      dl.append(dt, dd);
      nodes.push(dt, dd);
    });
    return nodes;
  }
  // What the lanes change on a card or its page, for the keys that decide whether they are drawn again.
  const laneSig = (card) => JSON.stringify([laneInfo(card), card && card.thread ? laneFollowUp(card) : null]);
  // ---- end delegation lanes ----
  // ---- workers (page.test.mjs runs this block, with the delegation lanes one, against a small fake DOM) ----
  // A task or idea has one worker: a delegation lane, a sub-agent (a file in .claude/agents), or neither (Claude on the session's model).
  // Here a worker is one string: '' for neither, 'lane:<name>' or 'agent:<name>'. `agents` is the server's { agents: [...] }, null until it answered.
  const agentOf = (card) => (card && typeof card.agent === 'string' ? card.agent : '');
  // A card file can hold both (an older version only knows the lane): the lane is the worker, as the server starts it.
  const workerOf = (card) => (laneOf(card) ? 'lane:' + laneOf(card) : agentOf(card) ? 'agent:' + agentOf(card) : '');
  const workerKind = (key) => (typeof key === 'string' && key.startsWith('lane:') ? 'lane' : typeof key === 'string' && key.startsWith('agent:') ? 'agent' : '');
  const workerName = (key) => (workerKind(key) ? key.slice(key.indexOf(':') + 1) : '');
  const descLine = (t) => String(t || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  // What the picker lists, in its three tabs. A row is { key, kind, name, provider, model, effort, ... }; one that cannot be picked has `why`.
  function workerRows() {
    const rows = { agents: [], project: [], global: [] };
    ((agents && agents.agents) || []).forEach((a) => {
      if (!a || typeof a.name !== 'string') return;
      rows.agents.push({ key: 'agent:' + a.name, kind: 'agent', name: a.name, provider: 'claude', model: a.model || '', effort: effortText(a.effort), desc: descLine(a.description), where: a.scope === 'user' ? 'user' : 'project', why: '', hint: '', readOnly: false, overrides: false });
    });
    ((lanes && lanes.available && lanes.lanes) || []).forEach((l) => {
      const why = l.approved === false ? 'not approved' : l.relay === false ? 'relay not installed' : '';
      const hint = why === 'not approved' ? 'Approve this project’s lane config with the delegate-setup skill.' : why ? 'Install the ' + l.implementer + '-delegate skill to use this lane.' : '';
      (l.source === 'project' ? rows.project : rows.global).push({ key: 'lane:' + l.name, kind: 'lane', name: l.name, provider: l.implementer, model: l.model || '', effort: l.variant || effortText(l.effort), desc: '', where: l.source === 'project' ? 'project' : 'global', why, hint, readOnly: l.readOnly === true || l.implementer === 'agy', overrides: l.source === 'project' && l.overridesGlobal === true });
    });
    return rows;
  }
  const workerRowLine = (r) => [r.provider, r.model, r.effort].filter(Boolean).join(' · ');
  const WORKER_TABS = [['agents', 'Sub-agents'], ['project', 'Project lanes'], ['global', 'Global lanes']];
  // The rows whose name, provider or model has `q` in it (case-insensitive); an empty search keeps them all.
  function workerFilter(rows, q) {
    const n = String(q || '').trim().toLowerCase();
    const hit = (r) => !n || [r.name, r.provider, r.model].some((t) => String(t).toLowerCase().includes(n));
    const out = {};
    WORKER_TABS.forEach(([id]) => { out[id] = rows[id].filter(hit); });
    return out;
  }
  // The tab that holds `key`, '' when none does.
  const workerTabOf = (rows, key) => (WORKER_TABS.find(([id]) => rows[id].some((r) => r.key === key)) || [''])[0];
  // The text on the Worker button. A choice the lists do not know says '(not found)': it is never shown as Claude (default).
  function workerLabel(key) {
    const kind = workerKind(key), name = workerName(key);
    if (!kind) return 'Claude (default)';
    const rows = workerRows();
    const row = [].concat(rows.agents, rows.project, rows.global).find((r) => r.key === key);
    if (kind === 'agent') return 'agent: ' + name + (row || !agents ? '' : ' (not found)');
    if (!row) return name + (lanes ? ' (not found)' : '');
    return [row.name + (row.why === 'not approved' ? ' (not approved)' : ''), row.provider, row.model, row.effort].filter(Boolean).join(' · ');
  }
  // What a card's Worker field edits. `base` is the saved worker; `value` what is picked. It follows the card while untouched, keeps what was
  // picked when the card changes under it (also a worker the lists no longer know), and sends only what changed: the key of a lane or an
  // agent, and null for each one the card holds when Claude (default) is picked.
  function workerEditor() {
    let base = '', picked = '', held = { lane: '', agent: '' };
    const ed = {
      get base() { return base; },
      get value() { return picked; },
      sync(card) {
        if (picked === base) { base = workerOf(card); picked = base; }
        held = { lane: laneOf(card), agent: agentOf(card) };
      },
      pick(key) { picked = key; },
      dirty: () => picked !== base,
      patch: () => (picked !== base ? workerPatch(picked, held) : {}),
      saved(card) { base = workerOf(card); held = { lane: laneOf(card), agent: agentOf(card) }; },
      reset() { picked = base; },
    };
    return ed;
  }
  // The body of a save that sets `key` on a card that holds `held` ({ lane, agent }). The server takes the other kind off by itself.
  function workerPatch(key, held) {
    const kind = workerKind(key);
    if (kind === 'lane') return { lane: workerName(key) };
    if (kind === 'agent') return { agent: workerName(key) };
    const out = {};
    if (laneOf(held)) out.lane = null;
    if (agentOf(held)) out.agent = null;
    return Object.keys(out).length ? out : { lane: null, agent: null };
  }
  // What Start does about the worker. `shown` is the card's worker as the start step showed it, `picked` the step's own choice (undefined: not
  // touched, so the card's). A choice other than the one shown is saved on the card first (`patch`); the server is told what was seen.
  function startWorkerArgs(shown, picked, card) {
    const worker = picked !== undefined ? picked : shown;
    return { worker, save: worker !== shown, patch: workerPatch(worker, card), expectLane: workerKind(worker) === 'lane' ? workerName(worker) : null, expectAgent: workerKind(worker) === 'agent' ? workerName(worker) : null };
  }
  // What the card page's start step shows for a sub-agent: the line, the dials and why it cannot start (it is not one of the loaded agents).
  function agentStartPlan(name) {
    const a = ((agents && agents.agents) || []).find((x) => x && x.name === name);
    if (!a) return { name, line: 'Runs as sub-agent ' + name, detail: '', blocked: agents ? 'Sub-agent “' + name + '” was not found. Pick another worker, or add it under .claude/agents.' : '' };
    return { name, line: 'Runs as sub-agent ' + name, detail: [a.model, effortText(a.effort)].filter(Boolean).join(' · '), blocked: '' };
  }
  // Why the start step's Start cannot run on the worker chosen in it ('' when it can); `picked` as in startWorkerArgs.
  function workerStartBlocked(card, picked) {
    const key = picked !== undefined ? picked : workerOf(card);
    if (workerKind(key) === 'lane') { const lp = laneStartPlan(card, workerName(key)); return lp ? lp.blocked : ''; }
    if (workerKind(key) === 'agent') return agentStartPlan(workerName(key)).blocked;
    return '';
  }
  // Whether a task or idea's page offers the Worker field: when lanes or sub-agents can be read, or the card has a worker already (so that
  // one that is gone can be taken off).
  function workerOffered(card) {
    if (!card || (card.kind !== 'task' && card.kind !== 'idea')) return false;
    return !!(lanes && lanes.available) || !!(agents && Array.isArray(agents.agents) && agents.agents.length) || workerOf(card) !== '';
  }
  // ---- end workers ----
  // ---- working now (work-page.test.mjs runs this block on its own) ----
  // Whether anything is running on a card right now, as plain data, or null. A task or idea: its sub-agent runs in the state `running`
  // (the server marks one `quiet` after a long time without activity: it may have stopped, so it is not shown as live
  // work). A thread: a turn that is running. { live, quiet, count, text, aria, kind, lane, since, runs, sig }: `text` is the short label
  // ("worker working", "3 agents working", "Running on code-codex"), `sig` what a pane compares to know whether to draw it again.
  function workState(card) {
    if (!card || typeof card !== 'object') return null;
    if (card.kind === 'thread' && card.thread) {
      const t = card.thread;
      if (t.runState !== 'running') return null;
      const lane = t.lane && typeof t.lane.name === 'string' ? t.lane.name : '';
      const turns = Array.isArray(t.turns) ? t.turns : [];
      const last = turns.length ? turns[turns.length - 1] : null;
      const w = { kind: 'thread', live: true, quiet: false, count: 1, lane, since: last && typeof last.startedAt === 'string' ? last.startedAt : '', runs: [], text: lane ? 'Running on ' + lane : 'Running', aria: 'working now: thread turn running' + (lane ? ' on lane ' + lane : '') };
      w.sig = ['thread', lane, w.since].join('|');
      return w;
    }
    const running = Array.isArray(card.runs) ? card.runs.filter((r) => r && typeof r === 'object' && r.state === 'running') : [];
    if (!running.length) return null;
    const runs = running.map((r) => ({ type: typeof r.agentType === 'string' && r.agentType ? r.agentType : 'agent', since: typeof r.startedAt === 'string' ? r.startedAt : '', quiet: r.quiet === true }));
    const live = runs.filter((r) => !r.quiet);
    const shown = live.length ? live : runs;
    const isLive = live.length > 0;
    const types = shown.map((r) => r.type).filter((x, i, a) => a.indexOf(x) === i);
    const text = (shown.length === 1 ? shown[0].type : shown.length + ' agents') + (isLive ? ' working' : ' quiet');
    const what = shown.length === 1 ? shown[0].type : shown.length + ' agents (' + types.join(', ') + ')';
    return {
      kind: 'runs', live: isLive, quiet: !isLive, count: shown.length, lane: '', since: '', runs, text,
      aria: isLive ? 'working now: ' + what : what + (shown.length === 1 ? ' run' : ' runs') + ' quiet, may have stopped',
      sig: ['runs', runs.map((r) => r.type + (r.quiet ? '!' : '') + '@' + r.since).join(',')].join('|'),
    };
  }
  // The tooltip of the indicator: what runs, since when, and for a quiet run why it is not shown as live. `nowMs` is the clock.
  function workTitle(w, nowMs) {
    const age = (iso) => { const ms = nowMs - Date.parse(iso); return Number.isFinite(ms) ? ' for ' + fmtMs(ms) : ''; };
    if (w.kind === 'thread') return 'A turn of this thread is running' + age(w.since) + (w.lane ? ' on the ' + w.lane + ' lane' : '') + '.';
    const lines = w.runs.map((r) => r.type + (r.quiet ? ': no recent activity, it may have stopped' : ': running') + age(r.since));
    return (w.live ? 'Working now' : 'Nothing has happened for a while') + '\n' + lines.join('\n');
  }
  // The indicator as an element: the pulsing dot of a thread's Running pill and the text. A quiet run gets a muted look and a ring instead
  // of the dot, so it differs without colour. `compact` is for a table row, which has no room for a pill; 'dot' is the mark alone (its text is for screen readers).
  function workEl(w, compact) {
    const el = h('span', (compact ? 'work work-compact' : 'pill work') + (w.live ? ' work-live' : ' work-quiet') + (compact === 'dot' ? ' work-dot' : ''));
    if (w.live) el.dataset.run = 'running';
    el.appendChild(shape(w.live ? 's-pulse' : 's-dring'));
    el.appendChild(h('span', compact === 'dot' ? 'sr-only' : 'work-text', w.text));
    const set = () => { el.title = workTitle(w, Date.now()); };
    set();
    el.addEventListener('mouseenter', set);   // the elapsed time moves on between two drawings
    return el;
  }
  // ---- end working now ----
  // ---- milestones and stages (page.test.mjs runs this block on its own) ----
  const NO_MS = ':none';     // the Milestone filter's "No milestone"; a colon is not valid in a card id
  const CHAT_ROLES = ['working', 'review', 'blocked', 'done'];
  function isThread(c) { return c.kind === 'thread' && !!c.thread; }
  // The items Claude is waiting on the user for: a card's own records, skipping what this page does not know (a newer kind).
  function waitsOf(c) {
    return c && Array.isArray(c.waits) ? c.waits.filter((w) => w && typeof w === 'object' && typeof w.id === 'string' && ['question', 'choice', 'todo', 'review'].includes(w.kind)) : [];
  }
  function openWaitsOf(c) { return waitsOf(c).filter((w) => w.state === 'open'); }
  function clip(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  // The columns a chat-only project shows: the stages the thread roles point to, in stage order.
  function chatStages(config) {
    const ids = CHAT_ROLES.map((r) => config.roles[r]);
    return config.stages.filter((s) => ids.includes(s.id));
  }
  // chat-only has three fixed columns: a thread runs in New, a thread whose turn finished or failed waits in Review, an ended one is Done
  const CHAT_EMPTY = { working: 'No thread is running.', review: 'No finished thread to look at.', done: 'No ended thread.' };
  // The text of an empty chat-only column, by the role its stage has (not by its id); '' for a stage with none of these roles.
  function chatEmptyText(stage, roles) {
    const role = ['working', 'review', 'done'].find((r) => roles[r] === stage.id);
    return role ? CHAT_EMPTY[role] : '';
  }
  // f: { q, threadsOnly, session, milestone, waiting }; q is lower case
  function matches(c, f) {
    if (f.waiting && !openWaitsOf(c).length) return false;
    if (f.session && !(isThread(c) && c.thread.parentSessionId === f.session)) return false;
    if (f.threadsOnly && !isThread(c)) return false;
    if (f.milestone === NO_MS) { if (c.kind === 'milestone' || c.parent) return false; }
    else if (f.milestone && c.id !== f.milestone && c.parent !== f.milestone) return false;
    if (!f.q) return true;
    return (c.id + ' ' + c.title + ' ' + (c.note || '')).toLowerCase().includes(f.q);
  }
  function childrenOf(cards, id) { return cards.filter((c) => c.parent === id); }
  // The open waiting items on the cards under a milestone (all of them, ideas too): to look at only, the answer is on the card.
  function milestoneWaits(cards, id) { return childrenOf(cards, id).flatMap(openWaitsOf); }
  // One meaning of "finished" (the server's rule, in core.mjs): a card that is not a thread is finished when its stage is the done
  // stage or any stage after it, in stage order; a thread, when its shown stage is the done role. `config` is { stages, roles }.
  function stageFinishedIn(config, stageId) {
    const doneAt = config.stages.findIndex((s) => s.id === config.roles.done);
    return doneAt >= 0 && config.stages.findIndex((s) => s.id === stageId) >= doneAt;
  }
  function finishedIn(c, config) {
    return isThread(c) ? c.status === config.roles.done : stageFinishedIn(config, c.status);
  }
  // A milestone has no stage: its state follows its cards. The cards that count are its children except ideas.
  function countedKids(cards, id) { return childrenOf(cards, id).filter((c) => c.kind !== 'idea'); }
  function progressOf(cards, id, config) {
    const kids = countedKids(cards, id);
    return { done: kids.filter((c) => finishedIn(c, config)).length, total: kids.length };
  }
  // 'empty' (no counted cards), 'open' (one is not finished) or 'done' (all are). Always worked out here from the cards the page holds,
  // never taken from the server's msState: that can lag behind a card the page has just changed, and the progress beside it must agree.
  const MS_STATE_LABEL = { empty: 'Empty', open: 'Open', done: 'Done' };
  const MS_ORDER = { open: 0, empty: 1, done: 2 };    // the order the Milestones view and the List's Stage sort put them in
  function msStateOf(m, cards, config) {
    const p = progressOf(cards, m.id, config);
    return p.total === 0 ? 'empty' : p.done === p.total ? 'done' : 'open';
  }
  // Milestones by title, numbers compared as numbers (M2 before M10), then by when they were made. Not by id: in a project kept in
  // the repo the ids are random.
  function msTitleCmp(a, b) {
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' })
      || (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
  }
  // The milestones in the order the view lists them: open first, then empty, then done; each group by title (msTitleCmp).
  function milestonesOrdered(list, cards, config) {
    return list.map((m, i) => ({ m, i, r: MS_ORDER[msStateOf(m, cards, config)] })).sort((a, b) => a.r - b.r || msTitleCmp(a.m, b.m) || a.i - b.i).map((x) => x.m);
  }
  // [{ stage, cards }] in stage order; a stage with no card is left out
  function groupByStage(cards, stages) {
    return stages.map((stage) => ({ stage, cards: cards.filter((c) => c.status === stage.id) })).filter((g) => g.cards.length);
  }
  // The plain-text report of a milestone, in the shape of the board_list tool's report.
  function milestoneReport(m, cards, config) {
    const p = progressOf(cards, m.id, config);
    const lines = ['Milestone ' + m.id + ' "' + clip(m.title, 120) + '": ' + msStateOf(m, cards, config) + ', ' + p.done + ' of ' + p.total + ' done.'];
    if (!childrenOf(cards, m.id).length) lines.push('No cards in this milestone yet.');   // ideas are cards too, though they do not count
    groupByStage(childrenOf(cards, m.id), config.stages).forEach((g) => {
      lines.push(g.stage.label + ' (' + g.cards.length + ')');
      g.cards.forEach((c) => lines.push('- ' + c.id + ' [' + (c.kind === 'thread' && c.thread ? 'thread:' + c.thread.runState : c.kind) + '] ' + clip(c.title, 120)));
    });
    return lines.join('\n');
  }
  // ---- end milestones and stages ----
  // ---- gear menu actions (page.test.mjs runs this block on its own) ----
  // Can the board ask a session to look at this card? A task or an idea: '' when not, 'ready' while it is new from the user, or 'sent' while a
  // request is open (the server says so with notified: true; the request stays open until the session picked lists the board, even if another
  // session has listed the card). A seen card with no open request has nothing to point out, a thread and a milestone are not asked about.
  function notifyState(c) {
    if (c.kind !== 'task' && c.kind !== 'idea') return '';
    if (c.notified === true) return 'sent';
    return c.seenByClaude === false || c.newInRepo === true ? 'ready' : '';
  }
  function cardThreadStartWhy(c) {
    return (c.criteria || []).length || (c.blockedBy || []).length ? 'A card with acceptance criteria or a Blocked by list cannot be started as a thread; clear them first.' : '';
  }
  // What the gear menu on a card offers, under the conditions the card's page uses.
  // o: { ro, stages, choices: [[id, title]], reportState(card), waits(card): the number of open waiting items, notify(card): '', 'ready' or 'sent' (see notifyState) }. An item is { id, label, ... }; { group, items } is a labelled set
  // and { sep: true } a divider. A read-only board gets nothing that writes, so a card may have no action at all.
  function cardActions(c, o) {
    if (c.kind === 'milestone') return [];   // a milestone is not on the board and has no stage to move to: its page has its own actions
    if (o.ro) return [];
    const out = [];
    const waits = o.waits ? o.waits(c) : 0;
    const notify = o.notify ? o.notify(c) : '';
    if (waits || notify) {
      if (waits) out.push({ id: 'waits', label: 'Answer waiting items (' + waits + ')' });
      if (notify) out.push({ id: 'notify', label: notify === 'sent' ? 'Notify Claude again…' : 'Notify Claude…' });
      out.push({ sep: true });
    }
    if (c.kind === 'thread') {
      if (!c.thread) return [];
      if (c.thread.runState !== 'ended') out.push({ id: 'end', label: 'End thread' });
      const rs = o.reportState(c);
      if (rs === 'not') out.push({ id: 'report', label: 'Report to main session', on: true });
      else if (rs === 'queued') out.push({ id: 'report', label: 'Cancel queued report', on: false });
      const running = c.thread.runState === 'running';
      out.push({ id: 'delete', label: 'Delete', danger: true, disabled: running, hint: running ? 'a turn is running' : '', why: running ? 'A turn is running. End the thread or wait for it to finish before deleting.' : '' });
      return out;
    }
    out.push({ group: 'Move to', items: o.stages.map((s) => ({ id: 'move:' + s.id, value: s.id, label: s.label, radio: true, checked: c.status === s.id, disabled: c.status === s.id })) });
    if (o.choices.length) {
      const cur = o.choices.some((m) => m[0] === c.parent) ? c.parent : '';
      out.push({ group: 'Set milestone', items: [['', 'No milestone']].concat(o.choices).map(([id, label]) => ({ id: 'ms:' + id, value: id, label, radio: true, checked: id === cur })) });
    }
    const startWhy = cardThreadStartWhy(c);
    out.push({ sep: true }, { id: 'start', label: 'Start as thread…', disabled: !!startWhy, why: startWhy }, { id: 'delete', label: 'Delete', danger: true });
    return out;
  }
  // ---- end gear menu actions ----
