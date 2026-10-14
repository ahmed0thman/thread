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
  const waitDrafts = {};         // what the user typed or picked in an open item, by project and item id: it survives a redraw
  const waitSent = {};           // 'project/item' answers being sent

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

  // ----- an item on a card's page -----
  function waitDraft(w) {
    const k = selKey + '/' + w.id;
    if (!waitDrafts[k]) waitDrafts[k] = { text: '', choices: [], done: false, verdict: '', comment: '' };
    return waitDrafts[k];
  }
  // Ready to send? And the body of the request.
  function waitReady(w, d) {
    if (w.kind === 'question') return !!d.text.trim();
    if (w.kind === 'choice') return w.multi === true ? d.choices.length > 0 : d.choices.length === 1;
    if (w.kind === 'todo') return d.done === true;
    return d.verdict === 'approve' || d.verdict === 'changes';
  }
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
    const key = 'wait:' + selKey + ':' + w.id;
    const send = actionBtn('Send', 'primary', key, () => sendWait(card, w, send, ctl));
    send.dataset.fid = 'w-send-' + w.id;
    const sync = () => { setOff(send, ro || !waitReady(w, d)); };
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
        r.addEventListener('change', () => { onPick(value, r.checked); sync(); });
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
      ta.addEventListener('input', () => { d.text = ta.value; sync(); });
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
      r.addEventListener('change', () => { d.done = r.checked; sync(); });
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
      c.addEventListener('input', () => { d.comment = c.value; });
      li.appendChild(c);
    }
    const row = h('div', 'wait-send');
    send.title = ro ? READONLY_WHY : 'Send (Ctrl or Cmd + Enter)';
    row.appendChild(send);
    li.appendChild(row);
    if (ro) { const n = h('span', 'foot-note', READONLY_WHY); row.appendChild(n); }
    sync();
    // Ctrl or Cmd + Enter sends. The card form's own shortcut (save) must not also fire.
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (!ro && waitReady(w, d)) sendWait(card, w, send, ctl);
    });
    ctl.firstControl = ctl.firstControl || first;
    return li;
  }

  async function sendWait(card, w, btn, ctl) {
    const d = waitDraft(w);
    if (isRO() || !waitReady(w, d) || (btn && btn.dataset.off === '1')) return;
    clearError();
    const pk = selKey;
    let sent = false;
    await runAction('wait:' + pk + ':' + w.id, async () => {
      try {
        applyCard(await api('POST', pp(pk, 'cards/' + encodeURIComponent(card.id) + '/waits/' + encodeURIComponent(w.id)), waitBody(w, d)), pk);
        delete waitDrafts[pk + '/' + w.id];
        sent = true;
        wrote();
      } catch (e) { showError(e.message); }
    });
    if (sent && ctl) ctl.focusAfter(w.id);
    poll();
  }

  // The section at the top of a card's page. host is kept for the life of the page and redrawn only when the items change.
  function attachWaits(P) {
    const host = h('section', 'waits');
    host.setAttribute('aria-label', 'Waiting for you');
    host.hidden = true;
    const ctl = { host, sig: '', firstControl: null };
    ctl.update = (card) => {
      const items = isChat() ? [] : waitsOf(card);
      const ro = isRO();
      const sig = JSON.stringify([items, ro, items.map((w) => (w.askedBy ? sessionLabel(w.askedBy) : ''))]);
      if (sig === ctl.sig) return;
      ctl.sig = sig;
      const open = items.filter((w) => w.state === 'open');
      const closed = items.filter((w) => w.state !== 'open').reverse();   // newest first
      Object.keys(waitDrafts).forEach((k) => { if (k.startsWith(selKey + '/' + card.id + '.') && !open.some((w) => selKey + '/' + w.id === k)) delete waitDrafts[k]; });
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
    // The Send button is gone once the item folds: focus goes to the next open item, else to the folded line's button (unless the user went elsewhere)
    ctl.focusAfter = (id) => {
      const a = document.activeElement;
      if (a && a !== document.body && !host.contains(a)) return;
      const t = ctl.firstControl || host.querySelector('[data-fid="w-copy-' + id + '"]');
      if (t) t.focus({ preventScroll: true });
    };
    // bring the section into view and put focus on the first open item's control
    ctl.focus = () => {
      const t = ctl.firstControl || host.querySelector('button');
      if (host.scrollIntoView) host.scrollIntoView({ block: 'start' });
      if (t) t.focus({ preventScroll: true });
    };
    return ctl;
  }
  // ---- end waiting for you ----

