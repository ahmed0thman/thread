  function sendBlock(card) {
    const t = card.thread;
    if (isRO()) return READONLY_WHY;
    if (isRemote()) return 'Messaging a thread is only possible on the computer itself, not through the tunnel.';
    if (t.runState === 'ended') return 'This thread has ended, so it cannot take new messages.';
    if (t.runState === 'running') return 'A turn is still running. You can send a message when it finishes.';
    if (t.lane) { const f = laneFollowUp(card); return f.ok ? '' : 'This thread cannot take a follow-up. ' + f.why; }
    if (!t.sessionId) {
      return t.runState === 'failed'
        ? 'This thread never started a session because its first turn failed, so there is nothing to continue.'
        : 'This thread has no session id yet. You can send a message once its first turn has finished.';
    }
    return '';
  }

  const traceHidden = {};   // kinds switched off in the Trace filters, kept across polls
  const actCache = {};      // events of finished turns, by project, card, turn and start time: fetched once per page session
  // ---- pane memory (page.test.mjs runs this block on its own) ----
  const THREAD_PANES_KEY = 'thread-board-panes';
  const CARD_PANES_KEY = 'thread-board-card-panes';   // a task or idea page remembers its own hidden panes
  function loadCollapsed(store, key) {
    try {
      const v = JSON.parse(store.getItem(key) || '{}');
      return { left: !!(v && v.left), right: !!(v && v.right) };
    } catch (e) { return { left: false, right: false }; }
  }
  function saveCollapsedTo(store, key, mem) { try { store.setItem(key, JSON.stringify(mem)); } catch (e) { /* storage unavailable: keep the in-page value */ } }
  // Bring the card pane (the form) into view: the About tab when the panes are tabs, else the left pane, opened if it was folded away. true when that changed anything.
  function revealCardPane(P, mem) {
    if (P.narrow) { if (P.view === 'about') return false; P.view = 'about'; return true; }
    if (!mem.left) return false;
    mem.left = false;
    return true;
  }
  // ---- end pane memory ----
  let paneStore = null;
  try { paneStore = sessionStorage; } catch (e) { /* no storage: the panes start open */ }
  const wsCollapsed = loadCollapsed(paneStore, THREAD_PANES_KEY);
  const cardCollapsed = loadCollapsed(paneStore, CARD_PANES_KEY);
  function chev(dir) { const c = h('span', 'chev ' + dir); c.setAttribute('aria-hidden', 'true'); return c; }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  // the full-view workspace for a thread card
  function mountWorkspace(P) {
    const ws = h('section', 'ws');
    ws.setAttribute('role', 'dialog');
    ws.setAttribute('aria-modal', 'true');
    ws.setAttribute('aria-labelledby', 'ws-title');
    ws.tabIndex = -1;
    P.root = ws;
    elOverlay.replaceChildren(ws);
    elOverlay.hidden = false;
    elApp.inert = true;
  }

  // ----- activity rows and trace steps, shared by the thread and the card workspaces -----
  const UNAVAILABLE = 'Activity is unavailable right now';
  // A tool row starts in progress; its result (matched by id) updates the same row.
  function toolRow(e, result) {
    const state = !result ? 'run' : result.ok === false ? 'fail' : 'ok';
    const li = h('li', 'act-row');
    li.dataset.state = state;
    const verb = h('span', 'act-verb', TOOL_VERB[e.name] || e.name);
    if (TOOL_VERB[e.name]) verb.title = e.name;
    const sum = h('span', 'act-sum', e.summary || '');
    sum.title = e.summary || '';
    const mark = shape(state === 'run' ? 's-pulse' : state === 'ok' ? 's-check' : 's-cross');
    mark.classList.add('act-state');
    const kind = shape('s-circle');
    kind.classList.add('act-kind');
    li.append(kind, verb, sum, mark, h('span', 'sr-only', state === 'run' ? ', in progress' : state === 'ok' ? ', done' : ', failed'));
    if (state === 'fail') {
      const err = h('div', 'act-err', result.preview || 'It failed without a message.');
      err.title = result.preview || '';
      li.appendChild(err);
    }
    return li;
  }
  function actList(events, note) {
    const ul = h('ul', 'act-list');
    const results = {};
    events.forEach((e) => { if (e.kind === 'tool_result') results[e.id] = e; });
    events.forEach((e) => {
      let li = null;
      if (e.kind === 'tool') li = toolRow(e, results[e.id]);
      else if (e.kind === 'text' && e.text && e.text.trim()) { li = h('li', 'act-text'); inline(li, e.text, 'plain'); }
      else if (e.kind === 'truncated') li = h('li', 'act-text', 'More happened than is shown here.');
      else if (e.kind === 'earlier') li = h('li', 'act-text', 'Earlier steps are not shown here.');
      if (!li) return;
      if (e.nested) li.classList.add('nested');
      ul.appendChild(li);
    });
    if (note) ul.appendChild(h('li', 'act-text', note));
    return ul;
  }

  // a step is a button that calls jump(turnIdx), which brings its turn in the conversation into view; `o.label` replaces the label of its kind and `o.plain` sets its text without markup
  function stepEl(kind, text, ref, turnIdx, fid, jump, o) {
    o = o || {};
    const li = h('li', 'step' + (kind === 'error' ? ' err' : ''));
    li.dataset.kind = kind;
    const node = h('span', 'node' + (kind === 'error' ? ' err' : ''));
    node.appendChild(shape(kind === 'error' ? 's-cross' : kind === 'working' ? 's-pulse' : KIND_SHAPE[kind]));
    li.appendChild(node);
    const body = h('button', 'step-link');
    body.type = 'button';
    body.dataset.fid = fid;
    body.title = o.title || 'Show turn ' + (turnIdx + 1) + ' in the conversation';
    body.addEventListener('click', () => jump(turnIdx));
    const top = h('span', 'step-top');
    top.appendChild(h('span', 'klabel', o.label || (kind === 'error' ? 'Failed' : kind === 'working' ? 'Working' : KIND_LABEL[kind])));
    if (ref) top.appendChild(h('span', 'refchip', ref));
    body.appendChild(top);
    const tx = h('span', 'step-text');
    if (text) { if (kind === 'error' || o.plain) tx.textContent = text; else inline(tx, text, 'plain'); }
    body.appendChild(tx);
    li.appendChild(body);
    return li;
  }

  // ---- sub-agent runs (page.test.mjs runs this block on its own) ----
  const TOOL_VERB = { Read: 'Read', Bash: 'Ran', Grep: 'Searched', Glob: 'Searched', WebFetch: 'Fetched', WebSearch: 'Searched the web', Edit: 'Edited', Write: 'Edited', NotebookEdit: 'Edited', Task: 'Delegated', Agent: 'Delegated' };
  const TOOL_KIND = { Read: 'found', Glob: 'found', Grep: 'found', WebFetch: 'found', WebSearch: 'found', Edit: 'changed', Write: 'changed', NotebookEdit: 'changed' };   // any other tool: 'did'
  const RUN_EVENT_CAP = 2000;   // the newest events a run's view keeps, as the server's snapshot does
  const RUN_QUIET_MS = 10 * 60 * 1000;   // a running run with no new activity for this long may have stopped
  // The title of a run: the Agent call's description without its [cN] marker.
  function runTitle(run) { return String(run.description || '').replace(/^\s*\[c(?=[a-z]*[0-9])[0-9a-z]+\]\s*/, '').trim() || String(run.agentType || '') || 'Sub-agent'; }
  // A run's state as a thread's pill names it.
  function runPillState(run) { return run.state === 'running' ? 'running' : run.state === 'stopped' ? 'ended' : 'idle'; }
  // The note under a running run that has been quiet for a long time, else ''.
  function quietNote(ms) {
    if (!(ms >= RUN_QUIET_MS)) return '';
    return 'No activity for ' + Math.floor(ms / 60000) + ' min; it may have stopped.';
  }
  // The events a run's view shows: those kept, with a marker in front when earlier ones were let go.
  function shownEvents(d) { return d.dropped ? [{ kind: 'earlier', dropped: d.dropped }].concat(d.events) : d.events; }
  // The trace of a run: one step per tool call, the verb as its label, a failed call as an error step.
  function runSteps(events) {
    const results = {};
    events.forEach((e) => { if (e.kind === 'tool_result') results[e.id] = e; });
    return events.filter((e) => e.kind === 'tool').map((e) => {
      const failed = !!results[e.id] && results[e.id].ok === false;
      return { kind: failed ? 'error' : TOOL_KIND[e.name] || 'did', label: (TOOL_VERB[e.name] || e.name) + (failed ? ' failed' : ''), text: e.summary || '' };
    });
  }
  // The card's history for the page, newest first: [{ text, at }]. A card from before the history has its creation as the one entry.
  function historyRows(card, labelOf) {
    const list = Array.isArray(card.history) ? card.history.filter((x) => x && typeof x === 'object') : [];
    // a Claude entry says which worker did the work, when the entry names one: 'Claude (agent:worker)'
    const who = (x) => (x.by === 'user' ? 'You' : 'Claude' + (typeof x.worker === 'string' && x.worker ? ' (' + x.worker + ')' : ''));
    const ASKED = { question: 'asked you a question', choice: 'asked you to choose', todo: 'asked you to do something', review: 'asked you to review it' };
    const rows = [];
    list.forEach((x) => {
      if (x.type === 'created') rows.push({ text: who(x) + ' created it' + (x.to ? ' in ' + labelOf(x.to) : ''), at: x.at });
      else if (x.type === 'moved') rows.push({ text: who(x) + ' moved it from ' + labelOf(x.from) + ' to ' + labelOf(x.to), at: x.at });
      else if (x.type === 'edited') rows.push({ text: who(x) + ' edited the ' + (Array.isArray(x.fields) && x.fields.length ? x.fields.join(', ') : 'card'), at: x.at });
      else if (x.type === 'worked') rows.push({ text: 'Worked on by ' + who(x), at: x.at });
      else if (x.type === 'waiting') rows.push({ text: who(x) + ' ' + (ASKED[x.kind] || 'raised a waiting item'), at: x.at });
    });
    if (!list.some((x) => x.type === 'created')) rows.unshift({ text: (card.source === 'user' ? 'You' : 'Claude') + ' created it', at: card.createdAt });
    return rows.reverse();
  }
  // ---- end sub-agent runs ----

  // ---- run views (page.test.mjs runs this against a small fake DOM) ----
  // ----- the sub-agent runs of a task or idea card: the centre and right panes, and their summary and the history in the left pane -----
  const runData = {};   // what each run did, by project, card and run number: kept while the page is open
  function attachRuns(P, S) {
    const { scConvo, scTrace, rebuild, jumpToTurn } = S;
    const runsOf = (c) => (Array.isArray(c.runs) ? c.runs.filter((r) => r && typeof r === 'object') : []);
    const side = h('div', 'runs-side');
    const dataOf = (c, run) => {
      const key = selKey + ':' + c.id + ':' + run.n;
      let d = runData[key];
      if (!d || (d.final && run.state === 'running')) d = runData[key] = { events: [], dropped: 0, offset: 0, prompt: '', promptFull: '', promptTried: false, reportFull: '', reportFor: null, quietMs: null, loading: false, final: false, failed: false, gone: false };
      return d;
    };
    S.composer.appendChild(h('p', 'foot-note', 'Only the main session can message these agents. Start as thread gives you an agent you can message.'));

    // Read what the run did, a chunk at a time; a finished run's answer is whole and replaces what was read. Only the newest events are kept,
    // so a long run is followed to its end; an offset the server found past the end of the file starts the list over.
    async function pump(c, run) {
      const d = dataOf(c, run);
      if (d.loading || d.final) return;
      d.loading = true;
      const pk = selKey;
      try {
        for (let guard = 0; guard < 200; guard++) {
          const r = await api('GET', pp(pk, 'cards/' + encodeURIComponent(c.id) + '/runs/' + run.n + '/activity?offset=' + d.offset));
          const events = Array.isArray(r.events) ? r.events : [];
          d.failed = false;
          d.gone = !!r.gone;
          d.quietMs = typeof r.quietMs === 'number' ? r.quietMs : null;
          if (typeof r.prompt === 'string' && r.prompt) d.prompt = r.prompt;
          if (r.reset) { d.events = []; d.dropped = 0; d.offset = 0; }
          if (r.next == null) { d.events = events.length > RUN_EVENT_CAP + 1 ? events.slice(-RUN_EVENT_CAP) : events; d.dropped = 0; }   // the snapshot's own marker for earlier steps stays
          else {
            d.events = d.events.concat(events);
            d.offset = r.next;
            if (d.events.length > RUN_EVENT_CAP) { d.dropped += d.events.length - RUN_EVENT_CAP; d.events = d.events.slice(-RUN_EVENT_CAP); }
          }
          if (!r.more) { d.final = !r.running; break; }
          if (panel !== P) break;
        }
      } catch (e) { d.failed = true; }
      d.loading = false;
      if (panel === P) draw();
    }
    // The state holds a preview of the prompt and the report; the full text comes from the run's route, once.
    async function loadTexts(c, run) {
      const d = dataOf(c, run);
      const pk = selKey;
      const get = async (part) => { try { return (await api('GET', pp(pk, 'cards/' + encodeURIComponent(c.id) + '/runs/' + run.n + '/' + part))).text || ''; } catch (e) { return ''; } };
      let got = false;
      if (run.promptFile && !d.promptTried) { d.promptTried = true; d.promptFull = await get('prompt'); got = true; }
      if (run.reportFile && run.state !== 'running' && d.reportFor !== run.finishedAt) { d.reportFor = run.finishedAt; d.reportFull = await get('report'); got = true; }
      if (got && panel === P) draw();
    }
    // While a run is open, ask for its steps every POLL_MS, newest run first; the next round starts only after the last one ended.
    async function cycle() {
      P.runTimer = null;
      const c = panel === P ? findCard(P.target) : null;
      if (!c) return;
      P.runBusy = true;
      const list = runsOf(c).slice().reverse();
      for (const run of list) {
        if (panel !== P) break;
        await pump(c, run);
        await loadTexts(c, run);
      }
      P.runBusy = false;
      const again = panel === P && runsOf(findCard(P.target) || c).some((r) => r.state === 'running');
      if (again) P.runTimer = setTimeout(cycle, POLL_MS);
    }
    function schedule() { if (!P.runTimer && !P.runBusy) P.runTimer = setTimeout(cycle, 0); }

    const stepsIn = (c, run) => dataOf(c, run).events.filter((e) => e.kind === 'tool');
    const durationOf = (run) => (run.finishedAt && run.startedAt ? fmtMs(new Date(run.finishedAt) - new Date(run.startedAt)) : '');

    // ----- left: the runs in short, and the history -----
    function renderSide(c) {
      const list = runsOf(c);
      side.replaceChildren(h('h3', 'dg-h', 'Agent runs'));
      if (!list.length) side.appendChild(h('p', 'muted', 'No agent has worked on this card.'));
      list.forEach((run, i) => {
        const b = h('button', 'run-row');
        b.type = 'button';
        b.dataset.fid = 'run-' + run.n;
        b.title = 'Show run ' + run.n + ' in the conversation';
        b.addEventListener('click', () => jumpToTurn(i));
        const top = h('span', 'run-top');
        top.append(h('span', 'tnum', 'Run ' + run.n), h('span', 'run-type', run.agentType || 'agent'), runPill(runPillState(run)));
        const sub = h('span', 'run-sub');
        const tk = turnTokens(run);
        const bits = [run.mode === 'background' ? 'background' : '', tk ? totalText(tk) : ''].filter(Boolean);
        if (bits.length) sub.append(bits.join(' · ') + ' · ');
        sub.appendChild(timeEl(run.startedAt));
        if (tk) b.title += '. ' + tokensText(tk);
        b.append(top, h('span', 'run-title', runTitle(run)), sub);
        side.appendChild(b);
      });
      side.appendChild(h('h3', 'dg-h', 'History'));
      const ul = h('ul', 'hist-list');
      historyRows(c, label).forEach((row) => {
        const li = h('li');
        li.append(h('span', null, row.text), timeEl(row.at));
        ul.appendChild(li);
      });
      side.appendChild(ul);
    }

    // ----- centre: each run as a turn -----
    function actBlock(c, run, d, i) {
      const wrap = h('div', 'act');
      wrap.dataset.act = String(i);
      if (run.state === 'running') {
        if (!(d.events.length || d.failed)) return null;
        wrap.appendChild(actList(shownEvents(d), d.failed ? UNAVAILABLE : ''));
        return wrap;
      }
      const steps = typeof run.steps === 'number' ? run.steps : stepsIn(c, run).length;   // the true count; the events kept may be fewer
      if (!steps && !d.gone && !d.failed) return null;
      const open = !!P.actOpen[run.n];
      const toggle = h('button', 'act-toggle');
      toggle.type = 'button';
      toggle.dataset.fid = 'a-' + run.n;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const tk = turnTokens(run);
      const dur = durationOf(run);
      toggle.append(chev(open ? 'd' : 'r'), h('span', 'tnum', stepsText(steps) + (dur ? ' · ' + dur : '') + (tk ? ' · ' + totalText(tk) : '')));
      if (tk) toggle.title = tokensText(tk);
      toggle.addEventListener('click', () => { P.actOpen[run.n] = !P.actOpen[run.n]; draw(); });
      wrap.appendChild(toggle);
      if (open) {
        if (d.failed) wrap.appendChild(actList([], UNAVAILABLE));
        else if (d.gone && !d.events.length) wrap.appendChild(actList([], 'The activity of this run was not kept.'));
        else if (!d.final && !d.events.length) wrap.appendChild(actList([], 'Loading…'));
        else wrap.appendChild(actList(shownEvents(d), d.events.length ? '' : 'No activity was recorded for this run.'));
      }
      return wrap;
    }
    async function markStopped(c, run, key) {
      clearError();
      const pk = selKey;
      await runAction(key, async () => {
        try { const saved = await api('POST', pp(pk, 'cards/' + encodeURIComponent(c.id) + '/runs/' + run.n + '/stop'), {}); wrote(); applyCard(saved, pk); }
        catch (e) { showError(e.message); }
      });
      poll();
    }
    function runTurn(c, run, i) {
      const d = dataOf(c, run);
      const tn = h('div', 'turn');
      tn.dataset.turn = String(i);
      if (P.flash && P.flash.i === i && Date.now() < P.flash.until) tn.classList.add('flash');
      const u = h('div', 'msg user');
      const um = h('div', 'msg-meta');
      um.appendChild(h('strong', null, 'Main session'));
      if (run.sessionId) um.appendChild(h('span', 'tnum', sessionLabel(run.sessionId)));
      um.appendChild(timeEl(run.startedAt));
      u.appendChild(um);
      const pb = h('div', 'bubble run-prompt');
      pb.appendChild(clampable(renderMarkdown(d.promptFull || run.prompt || d.prompt || 'The prompt of this run was not recorded.'), null, 'run-prompt:' + selKey + ':' + c.id + ':' + run.n));
      u.appendChild(pb);
      tn.appendChild(u);

      const b = h('div', 'msg bot');
      const bm = h('div', 'msg-meta');
      bm.appendChild(h('strong', null, run.agentType || 'Sub-agent'));
      bm.appendChild(h('span', 'tnum', 'run ' + run.n + (run.mode === 'background' ? ' · background' : '')));
      const dur = durationOf(run);
      if (dur) bm.appendChild(h('span', 'tnum', 'took ' + dur));
      const tk = turnTokens(run);
      if (tk && !(run.steps > 0)) { const e = h('span', 'tnum', totalText(tk)); e.title = tokensText(tk); bm.appendChild(e); }
      b.appendChild(bm);
      const act = actBlock(c, run, d, i);
      if (act) b.appendChild(act);
      if (run.state === 'running') {
        const ty = h('div', 'typing');
        ty.setAttribute('role', 'status');
        const dots = h('span', 'dots'); dots.append(h('i'), h('i'), h('i'));
        ty.appendChild(dots);
        const tx = h('span'); tx.append('Working · ', elapsedEl(run.startedAt));
        ty.appendChild(tx);
        b.appendChild(ty);
        const quiet = quietNote(d.quietMs);
        if (quiet) { const q = h('p', 'foot-note run-quiet', quiet); q.setAttribute('role', 'status'); b.appendChild(q); }
        // a run that will never be closed (its session ended, or its stop was lost) can be marked as stopped
        const key = 'stoprun:' + selKey + ':' + c.id + ':' + run.n;
        const stopBtn = actionBtn('Mark as stopped', 'small run-stop', key, () => markStopped(c, run, key));
        stopBtn.dataset.fid = 'stop-' + run.n;
        if (isRO()) { setOff(stopBtn, true); stopBtn.title = READONLY_WHY; }
        else stopBtn.title = 'Use this when the agent is no longer running but the run never finished';
        if (!isRemote()) b.appendChild(stopBtn);
      } else if (typeof run.result === 'string' && run.result.trim()) {
        const bub = h('div', 'bubble');
        bub.appendChild(renderMarkdown(d.reportFull || run.result));
        b.appendChild(bub);
      } else b.appendChild(h('div', 'typing', run.state === 'stopped' ? run.note || 'This run was marked as stopped.' : 'No report was recorded for this run.'));
      tn.appendChild(b);
      return tn;
    }
    function renderConvo(c) {
      const list = runsOf(c);
      rebuild('conversation', () => {
        const wrap = h('div', 'convo');
        if (!list.length) {
          const e = h('div', 'empty-state');
          e.appendChild(h('strong', null, 'No agent has worked on this card'));
          e.appendChild(document.createTextNode('When the main session hands this card to a sub-agent and starts the Agent call’s description with [' + c.id + '], its prompt, steps and report appear here. Start as thread gives you an agent you can message.'));
          wrap.appendChild(e);
        }
        list.forEach((run, i) => wrap.appendChild(runTurn(c, run, i)));
        return wrap;
      });
    }

    // ----- right: the trace, one block per run -----
    function renderTrace(c) {
      const list = runsOf(c);
      rebuild('trace', () => {
        if (!list.length) {
          const e = h('div', 'empty-state');
          e.appendChild(h('strong', null, 'No steps yet'));
          e.appendChild(document.createTextNode('The tool calls of an agent working on this card appear here.'));
          return [e];
        }
        return list.map((run, i) => {
          const d = dataOf(c, run);
          const block = h('section', 'turn-block');
          const th = h('h3', 'turn-head');
          const tl = h('button', 'turn-link');
          tl.type = 'button';
          tl.dataset.fid = 'rt-' + run.n;
          tl.title = 'Show run ' + run.n + ' in the conversation';
          tl.addEventListener('click', () => jumpToTurn(i));
          tl.appendChild(h('span', 'tnum', 'Run ' + run.n + ' ·'));
          tl.appendChild(h('span', 'tp', runTitle(run)));
          const when = h('span', 'when'); when.appendChild(timeEl(run.startedAt));
          tl.appendChild(when);
          th.appendChild(tl);
          block.appendChild(th);
          const rail = h('ol', 'rail');
          if (d.dropped || (d.events[0] && d.events[0].kind === 'earlier')) block.appendChild(h('p', 'muted', 'Earlier steps are not shown.'));
          runSteps(d.events).forEach((st, si) => rail.appendChild(stepEl(st.kind, st.text, null, i, 'r' + i + '-' + si, jumpToTurn, { label: st.label, plain: true, title: 'Show run ' + run.n + ' in the conversation' })));
          if (run.state === 'running') {
            const li = stepEl('working', '', null, i, 'rw' + i, jumpToTurn, { title: 'Show run ' + run.n + ' in the conversation' });
            li.querySelector('.step-text').append('working… ', elapsedEl(run.startedAt));
            rail.appendChild(li);
          }
          if (!rail.childNodes.length) {
            block.appendChild(h('p', 'muted', d.failed ? UNAVAILABLE : d.gone ? 'The activity of this run was not kept.' : d.final ? 'This run made no tool calls.' : 'Loading…'));
          } else block.appendChild(rail);
          return block;
        });
      });
    }
    function draw() {
      const c = panel === P ? findCard(P.target) : null;
      if (!c) return;
      renderConvo(c);
      renderTrace(c);
    }

    return {
      side,
      update(c) {
        const k = JSON.stringify([runsOf(c), c.history, c.source, c.createdAt, cfg().stages]);
        if (k !== P.runKey) { P.runKey = k; renderSide(c); draw(); }
        schedule();
      },
    };
  }

  // ---- end run views ----

  // The three-pane workspace a thread and a task or idea card share: the bar, the view tabs (one pane at a time when narrow),
  // the collapsible side panes and their scrolling. o: { lead (a node after Back), tabsLabel, labels, names } for the panes about, conversation and trace, and { panes, key }: which panes are folded away, and the storage key that remembers it.
  function workspaceShell(P, o) {
    mountWorkspace(P);
    const ws = P.root;
    Object.assign(P, { view: 'conversation', scrollSaved: { about: 0, conversation: 0, trace: 0 }, convAtBottom: true, narrow: false, flash: null });

    // ----- top bar -----
    const bar = h('header', 'ws-bar');
    const back = backBtn();
    const titleEl = h('h2', 'ws-title');
    titleEl.id = 'ws-title';
    const meta = h('div', 'ws-meta');
    const actions = h('div', 'ws-actions');
    const queuedNote = h('p', 'ws-queued');
    queuedNote.setAttribute('role', 'status');
    queuedNote.hidden = true;
    const saveNote = h('span', 'sr-only');     // says aloud that the milestone was saved
    saveNote.setAttribute('role', 'status');
    bar.append(back, o.lead, titleEl, meta, actions, queuedNote, saveNote);

    // ----- view tabs (single-pane layout only) -----
    const tabs = h('div', 'tabs ws-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', o.tabsLabel);
    tabs.hidden = true;
    const tabBtns = {};
    const views = [['conversation', o.labels.conversation], ['about', o.labels.about], ['trace', o.labels.trace]];
    views.forEach(([id, text]) => {
      const b = h('button', 'tab', text);
      b.type = 'button';
      b.id = 'tab-' + id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'pane-' + id);
      b.addEventListener('click', () => selectView(id));
      b.addEventListener('keydown', (e) => {
        const i = views.findIndex((x) => x[0] === P.view);
        let n = -1;
        if (e.key === 'ArrowRight') n = (i + 1) % views.length;
        else if (e.key === 'ArrowLeft') n = (i + views.length - 1) % views.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = views.length - 1;
        if (n < 0) return;
        e.preventDefault();
        selectView(views[n][0]);
        tabBtns[views[n][0]].focus();
      });
      tabs.appendChild(b);
      tabBtns[id] = b;
    });

    // ----- panes -----
    const main = h('div', 'ws-main');
    const paneL = h('section', 'ws-pane ws-left'); paneL.id = 'pane-about';
    const paneC = h('section', 'ws-pane ws-center'); paneC.id = 'pane-conversation';
    const paneR = h('section', 'ws-pane ws-right'); paneR.id = 'pane-trace';
    const panes = { about: paneL, conversation: paneC, trace: paneR };
    const paneName = o.names;
    const scrollerOf = (name) => { const s = h('div', 'scroller'); s.tabIndex = 0; s.setAttribute('aria-label', name); return s; };
    const scAbout = scrollerOf(o.names.about), scConvo = scrollerOf(o.names.conversation), scTrace = scrollerOf(o.names.trace);
    P.scrollers = { about: scAbout, conversation: scConvo, trace: scTrace };

    const sideCtl = {};
    function sidePane(side, pane, title, scroller) {
      const head = h('div', 'pane-head');
      head.appendChild(h('h3', null, title));
      const collapse = plainBtn('', 'icon ghost small');
      collapse.appendChild(chev(side === 'left' ? 'l' : 'r'));
      collapse.setAttribute('aria-label', 'Hide ' + title + ' pane');
      collapse.title = 'Hide ' + title;
      collapse.setAttribute('aria-expanded', 'true');
      collapse.style.width = '28px';
      const rail = h('button', 'pane-rail');
      rail.type = 'button';
      rail.appendChild(chev(side === 'left' ? 'r' : 'l'));
      rail.appendChild(h('span', 'rail-label', title));
      rail.setAttribute('aria-label', 'Show ' + title + ' pane');
      rail.title = 'Show ' + title;
      rail.setAttribute('aria-expanded', 'false');
      head.appendChild(collapse);
      collapse.addEventListener('click', () => setCollapsed(side, true));
      rail.addEventListener('click', () => setCollapsed(side, false));
      pane.append(head, scroller, rail);
      sideCtl[side] = { collapse, rail };
    }
    sidePane('left', paneL, o.labels.about, scAbout);
    sidePane('right', paneR, o.labels.trace, scTrace);
    const composer = h('div', 'composer');
    paneC.append(scConvo, composer);
    main.append(paneL, paneC, paneR);
    ws.append(bar, tabs, main);

    Object.keys(P.scrollers).forEach((k) => {
      P.scrollers[k].addEventListener('scroll', () => {
        const s = P.scrollers[k];
        if (!s.clientHeight) return;      // hidden panes report 0 and must not overwrite the saved position
        P.scrollSaved[k] = s.scrollTop;
        if (k === 'conversation') P.convAtBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
      });
    });
    function restoreScroll(id) {
      const s = P.scrollers[id];
      if (!s.clientHeight) return;
      if (id === 'conversation' && P.convAtBottom) s.scrollTop = s.scrollHeight;
      else s.scrollTop = P.scrollSaved[id];
    }
    // rebuild one scroller's content, keeping scroll position and focus
    function rebuild(id, build) {
      const s = P.scrollers[id];
      const a = document.activeElement;
      const fid = (a && s.contains(a) && a.dataset) ? a.dataset.fid : null;
      s.replaceChildren(...[].concat(build()));
      restoreScroll(id);
      if (fid) { const t = s.querySelector('[data-fid="' + fid + '"]'); if (t) t.focus({ preventScroll: true }); }
    }

    // wide: three panes with collapsible sides. narrow: one pane at a time, chosen by the tabs.
    function applyPanes() {
      const narrow = P.narrow;
      ws.toggleAttribute('data-narrow', narrow);
      tabs.hidden = !narrow;
      views.forEach(([id]) => {
        const p = panes[id], on = id === P.view;
        p.toggleAttribute('data-on', on);
        if (narrow) {
          p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'tab-' + id); p.removeAttribute('aria-label');
        } else {
          p.setAttribute('role', 'region'); p.setAttribute('aria-label', paneName[id]); p.removeAttribute('aria-labelledby');
        }
        tabBtns[id].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[id].tabIndex = on ? 0 : -1;
      });
      paneL.classList.toggle('collapsed', !narrow && o.panes.left);
      paneR.classList.toggle('collapsed', !narrow && o.panes.right);
      views.forEach(([id]) => restoreScroll(id));
    }
    function selectView(id) { P.view = id; applyPanes(); }
    function setCollapsed(side, on) {
      o.panes[side] = on;
      saveCollapsedTo(paneStore, o.key, o.panes);
      applyPanes();
      (on ? sideCtl[side].rail : sideCtl[side].collapse).focus({ preventScroll: true });
    }
    const mq = window.matchMedia ? window.matchMedia('(max-width: 999px)') : null;
    P.narrow = !!(mq && mq.matches);
    const onMq = () => { P.narrow = mq.matches; applyPanes(); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMq); else mq.addListener(onMq); }
    P.dispose = () => {
      clearTimeout(P.flashTimer);
      clearTimeout(P.actTimer);
      clearTimeout(P.runTimer);
      if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onMq); else mq.removeListener(onMq); }
    };

    // bring a turn of the conversation into view and flash it
    function jumpToTurn(i) {
      if (P.narrow && P.view !== 'conversation') selectView('conversation');
      const el = scConvo.querySelector('.turn[data-turn="' + i + '"]');
      if (!el) return;
      const top = scConvo.scrollTop + el.getBoundingClientRect().top - scConvo.getBoundingClientRect().top - 16;
      scConvo.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
      P.flash = { i, until: Date.now() + 1800 };
      scConvo.querySelectorAll('.turn.flash').forEach((x) => x.classList.remove('flash'));
      el.classList.add('flash');
      clearTimeout(P.flashTimer);
      P.flashTimer = setTimeout(() => { P.flash = null; scConvo.querySelectorAll('.turn.flash').forEach((x) => x.classList.remove('flash')); }, 1800);
    }

    // show the card pane, for a prompt or a step that lives in it
    function reveal() { if (revealCardPane(P, o.panes)) { saveCollapsedTo(paneStore, o.key, o.panes); applyPanes(); } }
    return { ws, bar, titleEl, meta, actions, queuedNote, saveNote, composer, paneL, scAbout, scConvo, scTrace, rebuild, applyPanes, selectView, jumpToTurn, reveal };
  }

  function buildThreadPanel(card) {
    const P = panel = {
      target: card.id, type: 'thread', cardKey: panelKey(card), isDirty: null,
      confirm: null, keys: {}, scrollers: {}, briefOpen: false,
      live: null, actOpen: {}, actState: {}, actBusy: false, actTimer: null,   // activity: see "activity" below
    };
    KINDS.forEach((k) => { delete traceHidden[k]; });
    const S = workspaceShell(P, { lead: h('span', 'idchip', card.id), tabsLabel: 'Thread views', labels: { about: 'About', conversation: 'Conversation', trace: 'Trace' }, names: { about: 'About this thread', conversation: 'Conversation', trace: 'Trace' }, panes: wsCollapsed, key: THREAD_PANES_KEY });
    const { ws, titleEl, meta, actions, queuedNote, saveNote, composer, scAbout, scConvo, scTrace, rebuild, applyPanes, selectView, jumpToTurn } = S;
    const W = attachWaits(P);   // the waiting items sit at the top of the About pane; the section outlives the pane's redraws
    P.focusWaits = () => { S.reveal(); W.focus(); };
    // ----- bar -----
    function renderHead(c) {
      const t = c.thread;
      titleEl.textContent = c.title;
      titleEl.title = c.title;
      meta.replaceChildren();
      meta.appendChild(runPill(t.runState));
      meta.appendChild(h('span', null, t.mode === 'write' ? 'Can edit files' : 'Read-only'));
      if (t.parentSessionId) {
        const from = h('span', 'ws-from', 'from ' + sessionLabel(t.parentSessionId));
        from.title = sessionLabel(t.parentSessionId);
        meta.appendChild(from);
      }
      const rt = reportTag(c);
      if (rt) {
        const wrap = h('span', 'ws-rep');
        wrap.appendChild(rt);
        const rs = reportState(c);
        if (rs !== 'yes') {
          const cb = copyBtn('/thread:report ' + c.id, 'report command', 'Copy report command');
          cb.dataset.fid = 'c-report-bar';
          wrap.appendChild(cb);
          const queued = rs === 'queued';
          const rb = actionBtn(queued ? 'Cancel' : 'Report to main session', queued ? 'small narrow' : 'small', 'report:' + selKey + ':' + c.id, () => setReportRequest(!queued));
          rb.dataset.fid = 'c-report-req';
          if (queued) rb.setAttribute('aria-label', 'Cancel the queued report');
          if (isRO()) { setOff(rb, true); rb.title = READONLY_WHY; }
          wrap.appendChild(rb);
        }
        meta.appendChild(wrap);
      }
      queuedNote.hidden = reportState(c) !== 'queued';
      queuedNote.textContent = queuedNote.hidden ? '' : queuedSentence(c);
      const turns = turnsOf(c);
      const started = turns.length ? turns[0].startedAt : c.createdAt;
      const st = h('span'); st.append('Started ', timeEl(started));
      meta.appendChild(st);
      meta.appendChild(h('span', 'tnum', turns.length + (turns.length === 1 ? ' turn' : ' turns')));
      if (c.seenByClaude === false) meta.appendChild(unseenEl('span'));
      syncBusy();
    }
    // Ask for the report to be delivered with the main session's next message, or take the request back.
    async function setReportRequest(on) {
      await requestReport(card.id, on, () => {
        // the clicked button was replaced (and disabled while busy), so focus would fall to the page
        const next = meta.querySelector('[data-fid="c-report-req"]');
        if (panel === P && next && (!document.activeElement || document.activeElement === document.body)) next.focus({ preventScroll: true });
      });
    }

    // ----- trace (right pane) -----
    function renderTrace(c) {
      const turns = turnsOf(c);
      const all = turns.map((t, i) => ({ t, i, state: turnState(c, i), steps: stepsOf(t) }));
      const counts = {};
      KINDS.forEach((k) => { counts[k] = 0; });
      all.forEach((x) => x.steps.forEach((s) => { counts[s.kind]++; }));

      rebuild('trace', () => {
        const out = [];
        const filters = h('div', 'filters');
        filters.setAttribute('role', 'group');
        filters.setAttribute('aria-label', 'Show step kinds');
        KINDS.forEach((k) => {
          const b = h('button', 'fchip');
          b.type = 'button';
          b.dataset.kind = k;
          b.dataset.fid = 'f-' + k;
          b.setAttribute('aria-pressed', traceHidden[k] ? 'false' : 'true');
          b.appendChild(shape(KIND_SHAPE[k]));
          b.appendChild(h('span', null, KIND_LABEL[k]));
          b.appendChild(h('span', 'n tnum', String(counts[k])));
          b.addEventListener('click', () => {
            if (traceHidden[k]) delete traceHidden[k]; else traceHidden[k] = true;
            renderTrace(findCard(P.target) || c);
          });
          filters.appendChild(b);
        });
        out.push(filters);
        const laneNote = laneTraceNote(c);
        if (laneNote) { const ln = h('p', 'muted lane-note', laneNote); ln.setAttribute('role', 'status'); out.push(ln); }

        const anything = all.some((x) => x.steps.length || x.state === 'failed' || x.state === 'running');
        if (!anything) {
          const e = h('div', 'empty-state');
          e.appendChild(h('strong', null, 'No steps yet'));
          e.appendChild(document.createTextNode(laneNote ? 'Steps from the report appear here once the thread reports back.' : 'Steps appear here once the thread reports back with what it did.'));
          out.push(e);
          return out;
        }
        all.forEach((x) => {
          const block = h('section', 'turn-block');
          const th = h('h3', 'turn-head');
          const tl = h('button', 'turn-link');
          tl.type = 'button';
          tl.dataset.fid = 't-' + x.i;
          tl.title = 'Show turn ' + (x.i + 1) + ' in the conversation';
          tl.addEventListener('click', () => jumpToTurn(x.i));
          tl.appendChild(h('span', 'tnum', 'Turn ' + (x.i + 1) + ' ·'));
          const tp = h('span', 'tp', plainMd(firstLine(x.t.prompt)) || '(no prompt)');
          tl.appendChild(tp);
          const when = h('span', 'when'); when.appendChild(timeEl(x.t.startedAt));
          tl.appendChild(when);
          th.appendChild(tl);
          block.appendChild(th);

          const rail = h('ol', 'rail');
          x.steps.forEach((s, si) => {
            if (!traceHidden[s.kind]) rail.appendChild(stepEl(s.kind, s.text, s.ref, x.i, 's' + x.i + '-' + si, jumpToTurn));
          });
          if (x.state === 'failed') {
            rail.appendChild(stepEl('error', x.t.error || 'The turn failed without an error message.', null, x.i, 'e' + x.i, jumpToTurn));
          } else if (x.state === 'running') {
            const li = stepEl('working', '', null, x.i, 'w' + x.i, jumpToTurn);
            li.querySelector('.step-text').append('working… ', elapsedEl(x.t.startedAt), h('span', 'live-steps', liveSteps()));
            rail.appendChild(li);
          } else if (x.state === 'pending') {
            rail.appendChild(stepEl('working', 'No result was recorded for this turn.', null, x.i, 'w' + x.i, jumpToTurn));
          }
          if (!rail.childNodes.length) {
            const msg = x.steps.length ? 'All steps in this turn are hidden by the filters.' : 'This turn reported no steps.';
            block.appendChild(h('p', 'muted', msg));
          } else block.appendChild(rail);
          out.push(block);
        });
        return out;
      });
    }
    // ----- conversation (centre pane) -----
    function renderConvo(c) {
      const turns = turnsOf(c);
      rebuild('conversation', () => {
        const wrap = h('div', 'convo');
        if (!turns.length) wrap.appendChild(h('div', 'empty-state', 'No messages yet.'));
        turns.forEach((t, i) => {
          const st = turnState(c, i);
          const tn = h('div', 'turn');
          tn.dataset.turn = String(i);
          if (P.flash && P.flash.i === i && Date.now() < P.flash.until) tn.classList.add('flash');
          const u = h('div', 'msg user');
          const um = h('div', 'msg-meta');
          um.appendChild(h('strong', null, i === 0 ? 'You · task' : 'You'));
          um.appendChild(timeEl(t.startedAt));
          u.appendChild(um);
          const ub = h('div', 'bubble');
          ub.appendChild(clampable(renderMarkdown(t.prompt || ''), null, 'turn-prompt:' + selKey + ':' + c.id + ':' + i));
          u.appendChild(ub);
          tn.appendChild(u);

          const b = h('div', 'msg bot');
          const bm = h('div', 'msg-meta');
          bm.appendChild(h('strong', null, 'Thread'));
          bm.appendChild(h('span', 'tnum', 'turn ' + (i + 1)));
          if (t.finishedAt && t.startedAt) bm.appendChild(h('span', 'tnum', 'took ' + fmtMs(new Date(t.finishedAt) - new Date(t.startedAt))));
          // with steps, the tokens ride on the steps line below
          const tk = turnTokens(t);
          if (tk && !(t.steps > 0)) { const e = h('span', 'tnum', totalText(tk)); e.title = tokensText(tk); bm.appendChild(e); }
          b.appendChild(bm);
          const act = buildAct(c, i);
          if (act) b.appendChild(act);
          if (st === 'running') {
            const ty = h('div', 'typing');
            ty.setAttribute('role', 'status');
            const dots = h('span', 'dots'); dots.append(h('i'), h('i'), h('i'));
            ty.appendChild(dots);
            const tx = h('span'); tx.append('Working · ', elapsedEl(t.startedAt));
            ty.appendChild(tx);
            b.appendChild(ty);
          } else if (st === 'failed') {
            const co = h('div', 'callout danger');
            co.appendChild(h('div', 'callout-title', 'This turn failed'));
            co.appendChild(h('div', 'callout-body', t.error || 'No error message was recorded.'));
            b.appendChild(co);
          } else if (st === 'ok' && typeof t.result === 'string') {
            const v = viewOf(t);
            const bub = h('div', 'bubble');
            if (v && v.body) bub.appendChild(renderMarkdown(v.body));
            if (v) SECTIONS.forEach(([key, name, kind]) => {
              const txt = v.sections && v.sections[key];
              if (!txt || !txt.trim() || !itemsOf(txt).length) return;
              const s = h('section');
              s.dataset.kind = kind;
              const st2 = h('h4', 'sec-title'); st2.appendChild(shape(KIND_SHAPE[kind])); st2.appendChild(h('span', null, name));
              s.append(st2, renderMarkdown(txt));
              bub.appendChild(s);
            });
            if (!bub.childNodes.length) bub.appendChild(h('span', 'muted', 'The reply was empty.'));
            b.appendChild(bub);
          } else {
            b.appendChild(h('div', 'typing', 'No result was recorded for this turn.'));
          }
          tn.appendChild(b);
          wrap.appendChild(tn);
        });
        return wrap;
      });
    }

    // ----- activity: what a turn did, between the prompt and the reply -----
    const actKey = (c, i) => selKey + ':' + c.id + ':' + (i + 1) + ':' + turnsOf(c)[i].startedAt;
    function runningTurn(c) { return turnsOf(c).findIndex((tt, i) => turnState(c, i) === 'running'); }
    function liveSteps() {
      const n = P.live ? P.live.events.filter((e) => e.kind === 'tool').length : 0;
      return n ? ' · ' + stepsText(n) + ' so far' : '';
    }

    // The block above a turn's reply: the live list while it runs, else a disclosure line. null when there is nothing to show.
    function buildAct(c, i) {
      const t = turnsOf(c)[i];
      const wrap = h('div', 'act');
      wrap.dataset.act = String(i);
      if (turnState(c, i) === 'running') {
        const d = P.live && P.live.i === i ? P.live : null;
        if (!d || !(d.events.length || d.failed)) return null;
        wrap.appendChild(actList(d.events, d.failed ? UNAVAILABLE : ''));
        return wrap;
      }
      if (!(t.steps > 0)) return null;
      const open = !!P.actOpen[i];
      const toggle = h('button', 'act-toggle');
      toggle.type = 'button';
      toggle.dataset.fid = 'a-' + i;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const tk = turnTokens(t);
      toggle.append(chev(open ? 'd' : 'r'), h('span', 'tnum', stepsText(t.steps) + (t.finishedAt && t.startedAt ? ' · ' + fmtMs(new Date(t.finishedAt) - new Date(t.startedAt)) : '') + (tk ? ' · ' + totalText(tk) : '')));
      if (tk) toggle.title = tokensText(tk);
      toggle.addEventListener('click', () => toggleAct(i));
      wrap.appendChild(toggle);
      if (open) {
        const key = actKey(c, i);
        const events = actCache[key];
        if (events) wrap.appendChild(actList(events, events.length ? '' : 'No activity was recorded for this turn.'));
        else wrap.appendChild(actList([], P.actState[key] === 'failed' ? UNAVAILABLE : 'Loading…'));
      }
      return wrap;
    }
    // Swap one turn's activity block in place; the rest of the conversation, its scroll position and its focus stay put.
    function refreshAct(i) {
      const c = findCard(P.target);
      const old = scConvo.querySelector('.act[data-act="' + i + '"]');
      const fresh = c && isThread(c) ? buildAct(c, i) : null;
      const host = scConvo.querySelector('.turn[data-turn="' + i + '"] .msg.bot .msg-meta');
      if (!host || (!old && !fresh)) return;
      const hadFocus = !!old && old.contains(document.activeElement);
      const top = scConvo.scrollTop;
      if (old && fresh) old.replaceWith(fresh);
      else if (old) old.remove();
      else host.after(fresh);
      // swapping the node would otherwise let the browser re-anchor the scroll position
      scConvo.scrollTop = c && turnState(c, i) === 'running' && P.convAtBottom ? scConvo.scrollHeight : top;
      if (hadFocus && fresh) { const f = fresh.querySelector('[data-fid]'); if (f) f.focus({ preventScroll: true }); }
    }
    function toggleAct(i) {
      P.actOpen[i] = !P.actOpen[i];
      const c = findCard(P.target);
      if (P.actOpen[i] && c) loadAct(c, i);
      refreshAct(i);
    }
    // A finished turn's events never change, so they are fetched once and kept.
    async function loadAct(c, i) {
      const key = actKey(c, i);
      if (actCache[key] || P.actState[key] === 'loading') return;
      P.actState[key] = 'loading';
      try { actCache[key] = (await api('GET', pp(selKey, 'threads/' + encodeURIComponent(c.id) + '/activity?turn=' + (i + 1)))).events || []; delete P.actState[key]; }
      catch (e) { P.actState[key] = 'failed'; }
      if (panel === P) refreshAct(i);
    }

    // While a turn runs, fetch its activity every POLL_MS; the next request starts only after the last one ended.
    async function pollActivity() {
      P.actTimer = null;
      const c = findCard(P.target);
      const i = panel === P && c && isThread(c) ? runningTurn(c) : -1;
      if (i < 0) { P.live = null; return; }
      P.actBusy = true;
      let data = null;
      try { data = await api('GET', pp(selKey, 'threads/' + encodeURIComponent(P.target) + '/activity?turn=' + (i + 1))); }
      catch (e) { /* shown as one muted line in the list; the next tick tries again */ }
      P.actBusy = false;
      if (panel !== P) return;
      const kept = P.live && P.live.i === i ? P.live.events : [];
      P.live = data && Array.isArray(data.events) ? { i, events: data.events, failed: false } : { i, events: kept, failed: true };
      refreshAct(i);
      const el = scTrace.querySelector('.live-steps');
      if (el) el.textContent = liveSteps();
      P.actTimer = setTimeout(pollActivity, POLL_MS);
    }
    function syncActivity(c) {
      const i = runningTurn(c);
      if (P.live && P.live.i !== i) P.live = null;
      if (i >= 0 && !P.actTimer && !P.actBusy) pollActivity();
    }

    // ----- composer (pinned under the conversation) -----
    const ta = h('textarea', 'input');
    ta.rows = 2;
    ta.id = 'composer-input';
    ta.setAttribute('aria-label', 'Message to this thread');
    ta.setAttribute('aria-describedby', 'composer-reason');
    ta.placeholder = 'Message the thread…';
    ta.value = drafts[selKey + ':' + card.id] || '';
    ta.addEventListener('input', () => { drafts[selKey + ':' + card.id] = ta.value; updateSendOff(); });
    const reasonEl = h('div', 'reason');
    reasonEl.id = 'composer-reason';
    const sendBtn = actionBtn('Send', 'primary', 'send:' + selKey + ':' + card.id, () => send());
    const hint = h('span', 'foot-note', 'Ctrl or Cmd + Enter to send. A follow-up sees this thread\u2019s own history, not what the main session did after the thread started.');
    const crow = h('div', 'composer-row');
    crow.append(reasonEl, sendBtn);
    const composerIn = h('div', 'composer-in');
    composerIn.append(ta, crow);
    composer.appendChild(composerIn);
    composer.hidden = isRemote();   // no message box through the tunnel
    function updateSendOff() { setOff(sendBtn, ta.disabled || !ta.value.trim()); }
    function renderComposer(c) {
      const why = sendBlock(c);
      ta.disabled = !!why;
      reasonEl.className = 'reason' + (why ? ' blocked' : '');
      reasonEl.replaceChildren();
      if (why) reasonEl.textContent = why; else reasonEl.appendChild(hint);
      updateSendOff();
    }
    async function send() {
      const text = ta.value.trim();
      if (!text) return;
      if (isRO()) return;
      clearError();
      const pk = selKey;
      await runAction('send:' + pk + ':' + card.id, async () => {
        try {
          const updated = await api('POST', pp(pk, 'threads/' + encodeURIComponent(card.id) + '/messages'), { message: text });
          if (ta.value.trim() === text) { ta.value = ''; drafts[pk + ':' + card.id] = ''; }
          P.convAtBottom = true;
          applyCard(updated, pk);
          wrote();
        } catch (e) { showError(e.message); }
      });
      poll();
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); if (!sendBtn.disabled) send(); }
    });

    // ----- about (left pane): ids, then the digest -----
    function renderAbout(c) {
      const t = c.thread;
      const turns = turnsOf(c);
      let newest = -1;
      turns.forEach((tt, i) => { if (tt.ok === true && typeof tt.result === 'string') newest = i; });
      rebuild('about', () => {
        const out = [W.host];
        out.push(h('h3', 'dg-h', 'Session'));
        const ids = h('div', 'ab-ids');
        const mkRow = (k, v, what, fid, lead) => {
          const r = h('div', 'ab-row');
          r.appendChild(h('span', 'k', k));
          if (lead) r.appendChild(lead);
          const line = h('div', 'line');
          if (v) {
            line.appendChild(h('span', 'v', v));
            const cb = copyBtn(v, what);
            cb.dataset.fid = fid;
            line.appendChild(cb);
          } else line.appendChild(h('span', 'v muted', 'Not known yet'));
          r.appendChild(line);
          return r;
        };
        const row = (k, v, what, fid, lead) => { ids.appendChild(mkRow(k, v, what, fid, lead)); };
        row(t.lane ? 'Session id (' + t.lane.implementer + ')' : 'Session id', t.lane ? t.lane.session : t.sessionId, 'session id', 'c-session');
        {
          let lead = null, seen = null;
          if (t.parentSessionId) {
            lead = h('div', 'ab-who', sessionLabel(t.parentSessionId));
            lead.title = sessionLabel(t.parentSessionId);
            const si = sessionInfo(t.parentSessionId);
            if (si && si.lastSeenAt) { seen = h('div', 'ab-seen'); seen.append('last active ', timeEl(si.lastSeenAt)); }
          }
          const r = mkRow('Started by', t.parentSessionId, 'parent session id', 'c-parent', lead);
          if (seen) r.appendChild(seen);
          ids.appendChild(r);
        }
        if (t.sessionId) {
          row('Resume', 'claude --resume ' + t.sessionId, 'resume command', 'c-resume');
          ids.appendChild(h('p', 'ab-note', 'Run this in a terminal to open this thread as a normal conversation.'));
        }
        out.push(ids);

        out.push(h('h3', 'dg-h', 'Details'));
        const facts = h('div', 'ab-ids');
        // the milestone, saved as soon as it is picked
        const choices = milestoneChoices();
        if (choices.length) {
          const sel = h('select', 'input');
          sel.id = 'c-milestone';
          sel.dataset.fid = 'c-milestone';
          fillSelect(sel, milestonePairs(), c.parent || '');
          if (isRO()) { sel.disabled = true; sel.title = READONLY_WHY; }
          sel.addEventListener('change', () => setMilestone(sel));
          const lab = h('label', 'k', 'Milestone');
          lab.htmlFor = 'c-milestone';
          const r = h('div', 'ab-row');
          r.append(lab, sel);
          facts.appendChild(r);
        }
        const fact = (k, v) => {
          const line = h('div', 'line');
          line.appendChild(h('span', 'v plain', v));
          const r = h('div', 'ab-row');
          r.append(h('span', 'k', k), line);
          facts.appendChild(r);
        };
        fact('Context', isBrief(t) ? 'Brief' : 'Full copy');
        if (t.lane) laneRows(c).forEach(([k, v]) => fact(k, v));
        else if (t.agent) fact('Agent', t.agent);
        else if (modelText(t)) fact('Model', modelText(t));
        const tk = threadTokens(turns);
        if (tk) fact('Tokens', tokensText(tk));
        fieldFacts(c).forEach(([k, v]) => fact(k, v));   // the type, priority, labels and workers: this page has no card form
        out.push(facts);
        if (isBrief(t) && t.brief) {
          const d = h('details', 'ab-brief');
          d.open = P.briefOpen;
          d.addEventListener('toggle', () => { P.briefOpen = d.open; });
          const sm = h('summary', null, 'Brief given to the thread');
          sm.dataset.fid = 'c-brief';
          d.append(sm, clampable(renderMarkdown(t.brief), 'brief-text', 'brief:' + selKey + ':' + c.id));
          out.push(d);
        }

        out.push(h('h3', 'dg-h', 'Digest'));
        if (newest < 0) {
          const e = h('div', 'empty-state');
          e.appendChild(h('strong', null, 'No digest yet'));
          e.appendChild(document.createTextNode(turns.length ? 'None of this thread’s turns has finished successfully.' : 'The digest appears when the first turn finishes.'));
          out.push(e);
          return out;
        }
        const tn = turns[newest];
        const v = viewOf(tn);
        const top = h('div', 'dg-top');
        top.appendChild(h('strong', null, 'Turn ' + (newest + 1) + (newest === turns.length - 1 ? ' (newest)' : ' (newest successful)')));
        top.appendChild(timeEl(tn.finishedAt || tn.startedAt));
        out.push(top);
        const grid = h('div', 'dg-grid');
        SECTIONS.forEach(([key, name, kind]) => {
          const b = h('section', 'dg-block');
          b.dataset.kind = kind;
          const hh = h('h4', 'sec-title'); hh.appendChild(shape(KIND_SHAPE[kind])); hh.appendChild(h('span', null, name));
          b.appendChild(hh);
          const txt = v && v.sections ? v.sections[key] : '';
          if (txt && txt.trim() && itemsOf(txt).length) b.appendChild(renderMarkdown(txt));
          else b.appendChild(h('div', 'none', 'Nothing reported.'));
          grid.appendChild(b);
        });
        out.push(grid);

        out.push(h('h3', 'dg-h', 'All decisions'));
        const decisions = [];
        turns.forEach((tt, i) => {
          if (!(tt.ok === true && typeof tt.result === 'string')) return;
          let items = itemsOf((viewOf(tt).sections || {}).decided);
          if (!items.length) items = stepsOf(tt).filter((s) => s.kind === 'decided').map((s) => s.text);
          items.forEach((text) => decisions.push({ n: i + 1, text }));
        });
        if (!decisions.length) out.push(h('p', 'muted', 'No decisions recorded in any turn.'));
        else {
          const ul = h('ul', 'decisions');
          decisions.forEach((d) => {
            const li = h('li');
            li.appendChild(h('span', 'tn', 'Turn ' + d.n));
            li.appendChild(inlineEl('span', null, d.text));
            ul.appendChild(li);
          });
          out.push(ul);
        }

        const note = h('div', 'callout report-note');
        if (t.reported) {
          note.appendChild(h('span', 'grow', 'This result has been reported to the main session.'));
        } else {
          const sp = h('span', 'grow', t.reportRequestedAt
            ? queuedSentence(c) + ' To bring it in right away, run this command in the main session.'
            : 'Not reported yet. Run this command in the main session to bring the result into its context.');
          note.classList.add('warn');
          note.appendChild(sp);
          const cmd = mkRow('Report command', '/thread:report ' + c.id, 'report command', 'c-report');
          cmd.style.flex = '1 1 100%';
          note.appendChild(cmd);
        }
        out.push(note);
        return out;
      });
    }

    async function setMilestone(sel) {
      await setParent(card.id, sel.value, (ok) => {
        if (ok) saveNote.textContent = sel.value ? 'Milestone saved.' : 'Removed from its milestone.';
        else {
          const c = findCard(P.target);
          sel.value = c && c.parent ? c.parent : '';
        }
      });
    }

    // ----- bar actions: End thread and Delete, with their confirm steps -----
    function renderActions(c, focusFirst) {
      const t = c.thread;
      actions.replaceChildren();
      if (isRemote()) return;   // End thread and Delete are only offered on the computer itself
      const running = t.runState === 'running';
      if (P.confirm === 'end') {
        actions.appendChild(h('span', 'confirm-text', endConfirmText()));
        const keep = plainBtn('Keep it open', null, () => { P.confirm = null; renderActions(findCard(P.target) || c, true); });
        actions.append(keep, actionBtn('End thread', 'danger solid', 'end:' + selKey + ':' + c.id, doEnd));
        if (focusFirst) keep.focus();
      } else if (P.confirm === 'delete') {
        actions.appendChild(h('span', 'confirm-text', deleteConfirmText(c)));
        const keep = plainBtn('Keep it', null, () => { P.confirm = null; renderActions(findCard(P.target) || c, true); });
        actions.append(keep, actionBtn('Delete card', 'danger solid', 'delete:' + selKey + ':' + c.id, doDelete));
        if (focusFirst) keep.focus();
      } else {
        const ro = isRO();
        if (running && !ro) actions.appendChild(h('span', 'foot-note', 'Delete is unavailable while a turn is running.'));
        if (t.runState !== 'ended') {
          const endBtn = plainBtn('End thread', null, () => { P.confirm = 'end'; renderActions(findCard(P.target) || c, true); });
          if (ro) { endBtn.disabled = true; endBtn.title = READONLY_WHY; }
          actions.appendChild(endBtn);
        }
        const del = plainBtn('Delete', 'danger', () => { if (running) return; P.confirm = 'delete'; renderActions(findCard(P.target) || c, true); });
        if (ro) {
          del.disabled = true;
          del.title = READONLY_WHY;
        } else if (running) {
          del.disabled = true;
          del.title = 'A turn is running. End the thread or wait for it to finish before deleting.';
        }
        actions.appendChild(del);
      }
      syncBusy();
    }
    async function doEnd() {
      await endThread(card.id, () => {
        P.confirm = null;
        if (panel === P) renderActions(findCard(P.target) || card);
      });
    }
    async function doDelete() {
      await deleteCard(card.id, (ok, here) => {
        if (!ok) P.confirm = null;
        if (ok && panel === P && here) {
          dropCard(card.id);
          returnFocus = { el: elNewBtn };
          navigateClose();
          renderBoard(false);
        } else if (panel === P) renderActions(findCard(P.target) || card);
      });
    }

    // ----- update from polling -----
    P.update = (c) => {
      if (!isThread(c)) return;
      const t = c.thread, turns = turnsOf(c);
      const ro = isRO();
      const sess = sessionInfo(t.parentSessionId);
      const k = {
        head: JSON.stringify([c.title, t.runState, t.mode, turns.length, turns[0] && turns[0].startedAt, c.seenByClaude, reportState(c), sess && sess.label, ro]),
        about: JSON.stringify([t.sessionId, t.lane, laneFollowUp(c), t.parentSessionId, turns, reportState(c), sess, t.context, t.brief, t.agent, t.model, t.effort, c.parent, milestoneChoices(), ro]),
        trace: JSON.stringify([turns, t.runState, t.lane && t.lane.implementer]),
        convo: JSON.stringify([turns, t.runState]),
        composer: t.runState + '|' + t.sessionId + '|' + (t.lane ? laneSig(c) : '') + '|' + ro,
        foot: t.runState + '|' + ro,
      };
      W.update(c);
      if (k.head !== P.keys.head) { renderHead(c); P.keys.head = k.head; }
      if (k.about !== P.keys.about) { renderAbout(c); P.keys.about = k.about; }
      if (k.trace !== P.keys.trace) { renderTrace(c); P.keys.trace = k.trace; }
      if (k.convo !== P.keys.convo) { renderConvo(c); P.keys.convo = k.convo; }
      syncActivity(c);
      if (k.composer !== P.keys.composer) { renderComposer(c); P.keys.composer = k.composer; }
      if (k.foot !== P.keys.foot) {
        P.keys.foot = k.foot;
        if (t.runState === 'ended' && P.confirm === 'end') P.confirm = null;
        if (t.runState === 'running' && P.confirm === 'delete') P.confirm = null;
        renderActions(c);
      }
    };

    applyPanes();
    P.update(card);
    renderActions(card);
  }

