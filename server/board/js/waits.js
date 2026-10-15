  // ---- waiting for you (page.test.mjs runs this block against a fake DOM) ----
  // Things Claude needs from the user, as items on a card (card.waits). The toolbar has a red pill with their count that filters
  // the board to the cards they are on, a card carries a tag, and a card's page has a section where each is answered.
  const WAIT_ORDER = ['question', 'choice', 'review', 'todo'];   // the most urgent first: Claude is stuck on the first two
  const WAIT_SPEC = {
    question: { label: 'Question', shape: 's-wq', one: 'question', many: 'questions', hint: 'Claude asks something. You answer in words.' },
    choice: { label: 'Choice', shape: 's-wc', one: 'choice', many: 'choices', hint: 'Claude asks you to pick from options.' },
    review: { label: 'Review', shape: 's-wr', one: 'review', many: 'reviews', hint: 'Claude finished something for you to check. You approve it or ask for changes.' },
    todo: { label: 'To do', shape: 's-wt', one: 'to-do', many: 'to-dos', hint: 'Something for you to do yourself. You tick it when it is done.' },
  };
  const WAIT_CLOSED_SHOWN = 5;   // answered items shown as lines on a page; the older ones sit in a fold
  // An answer is a draft until the bar's Send sends them all (one request per WAIT_BATCH_MAX answers, so Claude gets them together). The drafts
  // are kept in this browser, per project, so a reload does not lose them, and two tabs of the same board share them: each save re-reads the
  // storage and merges by item id (what this tab changed wins), and the storage event brings in what the other tab changed.
  const waitDrafts = {};         // what the user typed or picked in an open item, by 'project/item id': it survives a redraw
  const draftsDirty = {};        // 'project/item id' -> true: changed or removed in this tab and not in the storage yet
  const DRAFTS_KEY = 'thread-board-drafts:';   // + the project key
  const draftsLoaded = {};       // projects whose stored drafts are in waitDrafts
  const WAIT_BATCH_MAX = 50;     // answers one request carries (the server's MAX_BATCH; a test keeps them equal)

  // The number of open items on the selected project's cards; a chat-only project shows none.
  function waitingCount() {
    if (!current || isChat()) return 0;
    return current.cards.reduce((n, c) => n + (c.kind === 'milestone' ? 0 : openWaitsOf(c).length), 0);
  }
  // What a tab shows: the selected project from the state on the page (newer), the others from the project list.
  function tabWaiting(p) { return p.key === selKey && current ? waitingCount() : (p.waiting || 0); }
  function waitingOn() { return elWaiting.getAttribute('aria-pressed') === 'true'; }
  function setWaitingOn(on) { elWaiting.setAttribute('aria-pressed', on ? 'true' : 'false'); updateWaitingPill(); }
  // On the board the key is the filter. On the Waiting view, which is that filter as a view of its own, it goes back to the board;
  // on any other view it goes to Waiting.
  function toggleWaiting() {
    if (waitingCount() === 0) return;
    if (viewSel !== 'board') { goView(viewSel === 'waiting' ? 'board' : 'waiting'); return; }
    setWaitingOn(!waitingOn());
    renderBoard(false);
  }
  function waitKindMark(kind, tag) {
    const m = h('span', 'pill');
    m.dataset.wk = kind;
    m.appendChild(shape(WAIT_SPEC[kind].shape));
    m.appendChild(h('span', null, WAIT_SPEC[kind].label));
    if (tag) m.title = WAIT_SPEC[kind].hint;
    return m;
  }
  // The pill and the legend follow the count. A project with nothing waiting takes the filter off, as a vanished milestone does.
  let legendBuilt = false;
  function updateWaitingPill() {
    const n = waitingCount();
    if (current && n === 0 && waitingOn()) elWaiting.setAttribute('aria-pressed', 'false');
    const on = waitingOn();
    elWaiting.hidden = n === 0 || viewSel === 'waiting';   // the Waiting view is the filter, always on
    elWaiting.title = on ? 'Show every card again (W)' : 'Show only the cards with items waiting for you (W)';
    if (elWaitN.textContent !== String(n)) elWaitN.textContent = String(n);
    elWaiting.setAttribute('aria-label', 'Waiting for you, ' + n + (n === 1 ? ' item' : ' items') + (on ? ', filter on' : ''));
    if (!legendBuilt) {
      legendBuilt = true;
      WAIT_ORDER.forEach((k) => elWaitLegend.appendChild(waitKindMark(k, true)));
    }
    elWaitLegend.hidden = !((on || viewSel === 'waiting') && n > 0);
  }

  // The open items a card's tag counts: its own, or for a milestone those of its cards (to look at only). None in a chat-only project.
  function cardWaits(card) {
    if (isChat()) return [];
    return card.kind === 'milestone' ? milestoneWaits(current.cards, card.id) : openWaitsOf(card);
  }
  // { n, kinds (distinct, most urgent first), count (per kind) } for a list of items
  function waitSummary(items) {
    const count = {};
    items.forEach((w) => { count[w.kind] = (count[w.kind] || 0) + 1; });
    return { n: items.length, kinds: WAIT_ORDER.filter((k) => count[k]), count };
  }
  function waitSummaryText(s) { return s.kinds.map((k) => s.count[k] + ' ' + (s.count[k] === 1 ? WAIT_SPEC[k].one : WAIT_SPEC[k].many)).join(', '); }
  // The tag in a card's foot: one small icon per kind, then "2 waiting". For a milestone: its cards' items, to look at only.
  function waitTag(items, scope) {
    const s = waitSummary(items);
    if (!s.n) return null;
    const tag = h('span', 'tag wait-tag');
    const icons = h('span', 'wait-icons');
    s.kinds.forEach((k) => { const sh = shape(WAIT_SPEC[k].shape); sh.dataset.wk = k; icons.appendChild(sh); });
    tag.append(icons, h('span', null, s.n + ' waiting'));
    tag.title = waitSummaryText(s) + (scope === 'milestone' ? ' on this milestone’s cards' : ' waiting for you');
    return tag;
  }

  // ----- the drafts -----
  const draftEmpty = (d) => !d.text.trim() && !d.choices.length && !d.done && !d.verdict && !d.comment.trim();
  // A stored draft as the page uses it, or null when it is not one. The text is cut to what the server accepts.
  function cleanDraft(id, v) {
    if (!/^c[0-9]+\.w[0-9]+$/.test(id) || !v || typeof v !== 'object') return null;
    return {
      text: typeof v.text === 'string' ? v.text.slice(0, 4000) : '',
      choices: Array.isArray(v.choices) ? v.choices.filter((c) => typeof c === 'string').slice(0, 8) : [],
      done: v.done === true,
      verdict: v.verdict === 'approve' || v.verdict === 'changes' ? v.verdict : '',
      comment: typeof v.comment === 'string' ? v.comment.slice(0, 2000) : '',
    };
  }
  // The project's drafts as the storage holds them now, by item id; {} when there are none or they are rubbish, null when the storage cannot be read.
  function readStored(pk) {
    let raw;
    try { raw = localStorage.getItem(DRAFTS_KEY + pk); } catch (e) { return null; }
    const out = {};
    try {
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') Object.keys(o).forEach((id) => { const d = cleanDraft(id, o[id]); if (d) out[id] = d; });
    } catch (e) { /* rubbish: as if empty, and the next save replaces it */ }
    return out;
  }
  // Read the project's stored drafts once. Every access to the storage is guarded: it can be missing or full, and then the drafts last for this page only.
  function loadDrafts(pk) {
    if (draftsLoaded[pk]) return;
    draftsLoaded[pk] = true;
    const stored = readStored(pk) || {};
    Object.keys(stored).forEach((id) => { if (!waitDrafts[pk + '/' + id]) waitDrafts[pk + '/' + id] = stored[id]; });
  }
  // Store the project's drafts. `ids` are the items this tab just changed or removed. The storage is read again first and only the items this
  // tab changed since its last save are written over what it holds, so a draft typed in another tab is not lost. An item that cannot be stored
  // stays marked, and the next save tries again.
  function saveDrafts(pk, ids) {
    (ids || []).forEach((id) => { draftsDirty[pk + '/' + id] = true; });
    const stored = readStored(pk);
    if (stored === null) return;
    const mine = Object.keys(draftsDirty).filter((k) => k.startsWith(pk + '/'));
    mine.forEach((k) => {
      const id = k.slice(pk.length + 1);
      const d = waitDrafts[k];
      if (d && !draftEmpty(d)) stored[id] = d; else delete stored[id];
    });
    try {
      if (Object.keys(stored).length) localStorage.setItem(DRAFTS_KEY + pk, JSON.stringify(stored));
      else localStorage.removeItem(DRAFTS_KEY + pk);
      mine.forEach((k) => { delete draftsDirty[k]; });
    } catch (e) { /* not saved: the drafts last for this page only */ }
  }
  // Take in what another tab stored: its drafts replace this tab's for every item this tab has not changed since its last save, and a draft
  // the other tab removed (discarded or sent) goes. Returns true when anything changed here.
  function mergeStored(pk) {
    const stored = readStored(pk);
    if (stored === null) return false;
    let changed = false;
    Object.keys(stored).forEach((id) => {
      const k = pk + '/' + id;
      if (draftsDirty[k]) return;
      if (!waitDrafts[k] || JSON.stringify(waitDrafts[k]) !== JSON.stringify(stored[id])) { waitDrafts[k] = stored[id]; changed = true; }
    });
    Object.keys(waitDrafts).forEach((k) => {
      if (k.startsWith(pk + '/') && !draftsDirty[k] && !stored[k.slice(pk.length + 1)] && !draftEmpty(waitDrafts[k])) { delete waitDrafts[k]; changed = true; }
    });
    return changed;
  }
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !(typeof e.key === 'string' && e.key.startsWith(DRAFTS_KEY))) return;
    Object.keys(draftsLoaded).forEach((pk) => {
      if ((e.key === null || e.key === DRAFTS_KEY + pk) && mergeStored(pk)) {
        updateSendBar();
        if (panel && panel.redrawWaits) panel.redrawWaits();
      }
    });
  });
  // Drafts of items that are no longer open (answered or withdrawn elsewhere, or their card is gone) are dropped.
  function pruneDrafts(pk) {
    if (!current || pk !== selKey) return;
    loadDrafts(pk);
    const open = {};
    current.cards.forEach((c) => openWaitsOf(c).forEach((w) => { open[pk + '/' + w.id] = true; }));
    const gone = [];
    Object.keys(waitDrafts).forEach((k) => { if (k.startsWith(pk + '/') && !open[k]) { delete waitDrafts[k]; gone.push(k.slice(pk.length + 1)); } });
    if (gone.length) saveDrafts(pk, gone);
  }
  // The drafts that can be sent now: { card, w, d } for each open item of the project with a complete answer. None in a chat-only or read-only project.
  function readyDrafts(pk) {
    if (!current || pk !== selKey || isChat() || isRO()) return [];
    pruneDrafts(pk);
    const out = [];
    current.cards.forEach((c) => {
      if (c.kind === 'milestone') return;
      openWaitsOf(c).forEach((w) => {
        const d = waitDrafts[pk + '/' + w.id];
        if (!d) return;
        if (w.kind === 'choice') d.choices = d.choices.filter((x) => (Array.isArray(w.choices) ? w.choices : []).includes(x));
        if (waitReady(w, d)) out.push({ card: c, w, d });
      });
    });
    return out;
  }
  // The sticky bar under every view of the project while drafts wait. On a narrow window its text is hidden (the stylesheet), so the button
  // says what it sends and its hover text names the cards.
  function updateSendBar() {
    const ready = !halted && selKey && current && !showingHome ? readyDrafts(selKey) : [];
    const n = ready.length;
    elSendBar.hidden = n === 0;
    if (!n) return;
    const label = 'Send ' + n + (n === 1 ? ' answer' : ' answers');
    if (elSendBtn.textContent !== label) elSendBtn.textContent = label;
    const say = n + (n === 1 ? ' answer is' : ' answers are') + ' drafted and not sent yet. Claude gets them together when you send.';
    if (elSendText.textContent !== say) elSendText.textContent = say;
    const cards = [];
    ready.forEach((r) => { if (!cards.includes(r.card.id)) cards.push(r.card.id); });
    elSendBtn.title = 'Send ' + (n === 1 ? 'it' : 'them all') + ' to Claude in one go (' + (cards.length === 1 ? 'card ' : 'cards ') + cards.slice(0, 12).join(', ') + (cards.length > 12 ? ' and ' + (cards.length - 12) + ' more' : '') + '). Ctrl or Cmd + Enter in an answer does the same.';
  }
  // The same answer as the body of an entry in the batch, to tell whether a draft changed while it was being sent.
  const sameBody = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // The drafts, sent in requests of at most WAIT_BATCH_MAX answers, one after another. Each request is all or nothing: when one fails its
  // drafts, and those of the requests after it, stay, and the message says which request it was. Each request is built from the drafts as they
  // are then, so a draft edited while an earlier request was in flight goes as edited. Answers that were given elsewhere meanwhile are reported
  // by the server; their drafts go too.
  async function sendDrafts() {
    const pk = selKey;
    const ready = readyDrafts(pk);
    if (!ready.length) return;
    clearError();
    const ids = ready.map((r) => r.w.id);
    const parts = [];
    for (let i = 0; i < ids.length; i += WAIT_BATCH_MAX) parts.push(ids.slice(i, i + WAIT_BATCH_MAX));
    let sent = 0;
    const gone = [];
    const edited = [];
    let failure = '';
    await runAction('wait-send:' + pk, async () => {
      for (let i = 0; i < parts.length; i++) {
        const now = readyDrafts(pk).filter((r) => parts[i].includes(r.w.id));
        if (!now.length) continue;
        const bodies = now.map((r) => waitBody(r.w, r.d));
        const items = now.map((r, j) => Object.assign({ id: r.w.id }, bodies[j]));
        try {
          const res = await api('POST', pp(pk, 'waits/answer-batch'), { items });
          const done = [];
          now.forEach((r, j) => {
            const cur = waitDrafts[pk + '/' + r.w.id];
            // typed into while the request was in flight: the newer draft is kept, and the user is told what Claude received
            if (cur && !draftEmpty(cur) && !(waitReady(r.w, cur) && sameBody(waitBody(r.w, cur), bodies[j]))) { edited.push(r.w.id); return; }
            delete waitDrafts[pk + '/' + r.w.id];
            done.push(r.w.id);
          });
          saveDrafts(pk, done);
          applyCards(res.cards || [], pk);
          sent += items.length;
          wrote();
          (res.skipped || []).forEach((x) => gone.push(x.id));
        } catch (e) {
          failure = (parts.length > 1 ? 'Part ' + (i + 1) + ' of ' + parts.length + ' was not sent (' + parts[i].join(', ') + '): ' : '') + e.message
            + (parts.length > 1 ? (sent ? ' ' + sent + ' answers were sent before it; the drafts of this part and of the rest are kept.' : ' Nothing was sent; the drafts are kept.') : '');
          return;   // the drafts stay
        }
      }
    });
    const notes = [];
    if (failure) notes.push(failure);
    if (gone.length) notes.push(gone.join(', ') + (gone.length === 1 ? ' was' : ' were') + ' answered or withdrawn elsewhere already, so ' + (gone.length === 1 ? 'its draft was' : 'their drafts were') + ' dropped. The others were sent.');
    if (edited.length) notes.push(edited.join(', ') + (edited.length === 1 ? ' was' : ' were') + ' changed while ' + (edited.length === 1 ? 'it was' : 'they were') + ' being sent; Claude got the version that was sent.');
    if (notes.length) showError(notes.join(' '));
    updateSendBar();
    // the bar is gone with its last draft: focus must not be lost with it
    if (sent && elSendBar.hidden && (!document.activeElement || document.activeElement === document.body || elSendBar.contains(document.activeElement))) {
      const t = panel ? panel.root : elNewBtn;
      if (t && t.focus) t.focus({ preventScroll: true });
    }
    poll();
  }
  elSendBtn.addEventListener('click', () => { if (elSendBtn.disabled || elSendBtn.dataset.off === '1') return; sendDrafts(); });

  // ----- an item on a card's page -----
  function waitDraft(w) {
    loadDrafts(selKey);
    const k = selKey + '/' + w.id;
    if (!waitDrafts[k]) waitDrafts[k] = { text: '', choices: [], done: false, verdict: '', comment: '' };
    return waitDrafts[k];
  }
  // Is the answer complete?
  function waitReady(w, d) {
    if (w.kind === 'question') return !!d.text.trim();
    if (w.kind === 'choice') return w.multi === true ? d.choices.length > 0 : d.choices.length === 1;
    if (w.kind === 'todo') return d.done === true;
    return d.verdict === 'approve' || d.verdict === 'changes';
  }
  // The body of the item's entry in the batch.
  function waitBody(w, d) {
    const b = {};
    if (w.kind === 'question') b.text = d.text.trim();
    else if (w.kind === 'choice') b.choices = d.choices.slice();
    else if (w.kind === 'todo') b.done = true;
    else b.verdict = d.verdict;
    if (w.kind !== 'question' && d.comment.trim()) b.comment = d.comment.trim();
    return b;
  }
  // The answer of a closed item, in words.
  function waitAnswerText(w) {
    const a = w.answer && typeof w.answer === 'object' ? w.answer : {};
    let t;
    if (w.kind === 'question' || w.answeredVia === 'chat') t = a.text || '';
    else if (w.kind === 'choice') t = (Array.isArray(a.choices) ? a.choices : []).join(', ');
    else if (w.kind === 'todo') t = 'Done';
    else t = a.verdict === 'approve' ? 'Approved' : 'Changes requested';
    return w.comment ? (t ? t + ' — ' : '') + w.comment : t;
  }
  // Does the answer sit with the session that asked? Said plainly, with how long ago that session was last active.
  function waitDelivery(w) {
    const out = h('span', 'wait-delivery');
    if (w.state !== 'answered' || w.answeredVia === 'chat') return out;
    if (w.deliveredAt) { out.textContent = 'delivered'; return out; }
    const si = w.askedBy ? sessionInfo(w.askedBy) : null;
    out.append('not yet delivered: it reaches the session that asked with its next message');
    if (si && si.lastSeenAt) { out.append(' (last active '); out.appendChild(timeEl(si.lastSeenAt)); out.append(')'); }
    out.append('. If that session was cleared or closed, any session can read it with wait_list (ask “what did I answer on ' + w.id + '?”).');
    return out;
  }
  function waitIdButton(w) {
    const cb = copyBtn(w.id, 'item id ' + w.id, 'Copy id');
    cb.setAttribute('aria-label', 'Copy id ' + w.id);
    cb.title = 'Copy ' + w.id + ' to ask about it in the main session';
    cb.dataset.fid = 'w-copy-' + w.id;
    return cb;
  }

  // A closed item: a muted line with a tick, the answer, and whether it was delivered.
  function waitLine(w) {
    const li = h('li', 'wait-line');
    li.dataset.wid = w.id;
    li.dataset.state = w.state;
    li.appendChild(shape(w.state === 'withdrawn' ? 's-cross' : 's-check'));
    const body = h('span', 'wait-line-text');
    const head = h('span');
    head.append(h('strong', null, w.id), ' ' + clip(w.text, 90));
    body.appendChild(head);
    const ans = h('span', 'wait-line-ans');
    if (w.state === 'withdrawn') ans.textContent = 'Withdrawn: Claude no longer needs it.';
    else {
      ans.append((w.answeredVia === 'chat' ? 'Answered in the chat: ' : 'Your answer: ') + clip(waitAnswerText(w), 200));
      const d = waitDelivery(w);
      if (d.textContent) { ans.append(' · '); ans.appendChild(d); }
    }
    body.appendChild(ans);
    li.appendChild(body);
    li.appendChild(waitIdButton(w));
    return li;
  }

  // An open item: what Claude needs, who asked, the control for its kind and a Send button.
  function waitRow(card, w, ctl) {
    const d = waitDraft(w);
    const li = h('li', 'wait-item');
    li.dataset.wid = w.id;
    li.dataset.wk = w.kind;
    const top = h('div', 'wait-top');
    top.append(waitKindMark(w.kind, true), h('span', 'idchip', w.id), waitIdButton(w));
    const meta = h('span', 'wait-meta');
    meta.append('asked by ' + (w.askedBy ? sessionLabel(w.askedBy) : 'Claude') + ' · ', timeEl(w.askedAt));
    top.appendChild(meta);
    li.append(top, h('p', 'wait-text', w.text));

    const ro = isRO();
    const pk = selKey;
    // "Draft, not sent" and Discard show while there is anything in the answer; nothing is sent from here
    const draftRow = h('div', 'wait-draft');
    const draftNote = h('span', 'wait-draft-note');
    draftNote.setAttribute('role', 'status');
    const discard = plainBtn('Discard', 'small', () => { delete waitDrafts[pk + '/' + w.id]; saveDrafts(pk, [w.id]); updateSendBar(); ctl.redraw(); });
    discard.dataset.fid = 'w-discard-' + w.id;
    discard.setAttribute('aria-label', 'Discard the draft answer to ' + w.id);
    draftRow.append(draftNote, discard);
    const sync = () => {
      const any = !draftEmpty(d);
      draftRow.hidden = ro || !any;
      draftNote.textContent = waitReady(w, d) ? 'Draft, not sent' : 'Draft, not complete';
      li.dataset.draft = any && waitReady(w, d) ? '1' : '0';
    };
    // every change is kept, and the bar follows
    const touched = () => { sync(); saveDrafts(pk, [w.id]); updateSendBar(); };
    let first = null;
    const radios = (name, legend, options, multi, pick) => {
      const box = h('fieldset', 'wait-opts');
      box.appendChild(h('legend', null, legend));
      options.forEach(([value, text], i) => {
        const r = h('input');
        r.type = multi ? 'checkbox' : 'radio';
        r.name = name;
        r.value = value;
        r.checked = pick(value);
        r.disabled = ro;
        r.dataset.fid = 'w-opt-' + w.id + '-' + i;
        r.addEventListener('change', () => { onPick(value, r.checked); touched(); });
        const l = h('label', 'radio');
        l.append(r, h('span', null, text));
        box.appendChild(l);
        if (!first) first = r;
      });
      return box;
    };
    let onPick = () => {};
    if (w.kind === 'question') {
      const ta = h('textarea', 'input');
      ta.rows = 3;
      ta.value = d.text;
      ta.disabled = ro;
      ta.setAttribute('aria-label', 'Your answer to ' + w.id);
      ta.placeholder = 'Your answer';
      ta.dataset.fid = 'w-answer-' + w.id;
      ta.addEventListener('input', () => { d.text = ta.value; touched(); });
      li.appendChild(ta);
      first = ta;
    } else if (w.kind === 'choice') {
      const multi = w.multi === true;
      const options = (Array.isArray(w.choices) ? w.choices : []).map((c) => [c, c]);
      // a radio button fires change only for the one that was picked, so a single choice replaces the earlier pick
      onPick = (value, on) => { d.choices = d.choices.filter((c) => multi && c !== value); if (on) d.choices.push(value); };
      d.choices = d.choices.filter((c) => options.some((o) => o[0] === c));
      li.appendChild(radios('wait-' + w.id, multi ? 'Pick any that apply' : 'Pick one', options, multi, (v) => d.choices.includes(v)));
    } else if (w.kind === 'todo') {
      const r = h('input');
      r.type = 'checkbox';
      r.checked = d.done;
      r.disabled = ro;
      r.dataset.fid = 'w-done-' + w.id;
      r.addEventListener('change', () => { d.done = r.checked; touched(); });
      const l = h('label', 'radio');
      l.append(r, h('span', null, 'Done: I did this'));
      li.appendChild(l);
      first = r;
    } else {
      onPick = (value) => { d.verdict = value; };
      li.appendChild(radios('wait-' + w.id, 'Your verdict', [['approve', 'Approve'], ['changes', 'Request changes']], false, (v) => d.verdict === v));
    }
    if (w.kind !== 'question') {
      const c = h('input', 'input');
      c.type = 'text';
      c.maxLength = 2000;
      c.value = d.comment;
      c.disabled = ro;
      c.placeholder = 'Comment (optional)';
      c.setAttribute('aria-label', 'Comment on ' + w.id + ' (optional)');
      c.dataset.fid = 'w-comment-' + w.id;
      c.addEventListener('input', () => { d.comment = c.value; touched(); });
      li.appendChild(c);
    }
    li.appendChild(draftRow);
    if (ro) li.appendChild(h('span', 'foot-note', READONLY_WHY));
    sync();
    // Ctrl or Cmd + Enter sends the drafts (all of them, as the bar does). The card form's own shortcut (save) must not also fire.
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (!ro) sendDrafts();
    });
    ctl.firstControl = ctl.firstControl || first;
    return li;
  }

  // The section at the top of a card's page. host is kept for the life of the page and redrawn only when the items change.
  function attachWaits(P) {
    const host = h('section', 'waits');
    host.setAttribute('aria-label', 'Waiting for you');
    host.hidden = true;
    const ctl = { host, sig: '', firstControl: null, last: null };
    ctl.update = (card) => {
      ctl.last = card;
      const items = isChat() ? [] : waitsOf(card);
      const ro = isRO();
      const sig = JSON.stringify([items, ro, items.map((w) => (w.askedBy ? sessionLabel(w.askedBy) : ''))]);
      if (sig === ctl.sig) return;
      ctl.sig = sig;
      const open = items.filter((w) => w.state === 'open');
      const closed = items.filter((w) => w.state !== 'open').reverse();   // newest first
      loadDrafts(selKey);
      const dropped = [];
      Object.keys(waitDrafts).forEach((k) => { if (k.startsWith(selKey + '/' + card.id + '.') && !open.some((w) => selKey + '/' + w.id === k)) { delete waitDrafts[k]; dropped.push(k.slice(selKey.length + 1)); } });
      if (dropped.length) { saveDrafts(selKey, dropped); updateSendBar(); }
      host.hidden = !items.length;
      host.className = open.length ? 'waits' : 'waits quiet';
      const a = document.activeElement;
      const fid = a && host.contains(a) && a.dataset ? a.dataset.fid : null;
      ctl.firstControl = null;
      host.replaceChildren();
      if (!items.length) return;
      const head = h('h3', 'waits-h', 'Waiting for you');
      if (open.length) head.appendChild(h('span', 'wait-badge tnum', String(open.length)));
      host.appendChild(head);
      if (!open.length) host.appendChild(h('p', 'muted', 'Nothing is waiting for you on this card.'));
      if (open.length) {
        const ul = h('ul', 'wait-list');
        open.forEach((w) => ul.appendChild(waitRow(card, w, ctl)));
        host.appendChild(ul);
      }
      if (closed.length) {
        const ul = h('ul', 'wait-list');
        closed.slice(0, WAIT_CLOSED_SHOWN).forEach((w) => ul.appendChild(waitLine(w)));
        host.appendChild(ul);
        if (closed.length > WAIT_CLOSED_SHOWN) {
          const det = h('details', 'wait-done');
          det.appendChild(h('summary', null, 'Earlier items (' + (closed.length - WAIT_CLOSED_SHOWN) + ')'));
          const more = h('ul', 'wait-list');
          closed.slice(WAIT_CLOSED_SHOWN).forEach((w) => more.appendChild(waitLine(w)));
          det.appendChild(more);
          host.appendChild(det);
        }
      }
      syncBusy();
      if (fid) { const t = host.querySelector('[data-fid="' + fid + '"]'); if (t) t.focus({ preventScroll: true }); }
    };
    // Discard empties a draft: the section is drawn again from the card it last showed, and focus goes to the first control
    ctl.redraw = () => {
      ctl.sig = '';
      if (ctl.last) ctl.update(ctl.last);
      if (ctl.firstControl) ctl.firstControl.focus({ preventScroll: true });
    };
    // another tab changed the drafts: draw the section again, leaving focus where it is
    ctl.refresh = () => { ctl.sig = ''; if (ctl.last) ctl.update(ctl.last); };
    if (P) P.redrawWaits = ctl.refresh;
    // bring the section into view and put focus on the first open item's control
    ctl.focus = () => {
      const t = ctl.firstControl || host.querySelector('button');
      if (host.scrollIntoView) host.scrollIntoView({ block: 'start' });
      if (t) t.focus({ preventScroll: true });
    };
    return ctl;
  }
  // ---- end waiting for you ----

