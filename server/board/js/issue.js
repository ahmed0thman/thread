  // ---------- task / idea / create panel ----------

  function field(labelText, control, id) {
    const f = h('div', 'field');
    const l = h('label', null, labelText);
    l.htmlFor = id;
    control.id = id;
    f.append(l, control);
    return f;
  }
  const stagePairs = () => cfg().stages.map((st) => [st.id, st.label]);
  const milestonePairs = () => [['', 'None']].concat(milestoneChoices());

  // The card fields' controls: type, priority, labels, blocked by and acceptance criteria. values() reads them the way fieldValues
  // reads a card, set(vals) writes them, show(keys) offers only those fields (a new card turns into a milestone, which takes none).
  // onChange runs after a criterion was added or removed (typing is seen by the form itself).
  function fieldsEditor(keys, onChange, withIdea) {
    const root = h('div', 'fx');
    const fType = h('select', 'input');
    // an existing task or idea can switch between the three; a new card chooses its kind in its own select
    fillSelect(fType, [['task', 'Task'], ['bug', 'Bug']].concat(withIdea ? [['idea', 'Idea']] : []), 'task');
    const fPrio = h('select', 'input');
    fillSelect(fPrio, [['high', 'High'], ['normal', 'Normal'], ['low', 'Low']], 'normal');
    const row = h('div', 'row2');
    const wType = field('Type', fType, 'f-type'), wPrio = field('Priority', fPrio, 'f-priority');
    row.append(wType, wPrio);

    const fLabels = h('input', 'input');
    fLabels.type = 'text';
    fLabels.autocomplete = 'off';
    fLabels.placeholder = 'api, checkout';
    const chips = h('div');
    const wLabels = field('Labels', fLabels, 'f-labels');
    wLabels.append(chips, h('span', 'foot-note', 'Separated by commas: up to 8, each up to 24 characters.'));
    const drawChips = () => {
      const l = parseLabels(fLabels.value);
      chips.replaceChildren(...(l.length ? [labelChips(l, 0)] : []));
    };
    fLabels.addEventListener('input', drawChips);

    const fBlock = h('input', 'input');
    fBlock.type = 'text';
    fBlock.autocomplete = 'off';
    fBlock.placeholder = 'c4, c7';
    const blockList = h('ul', 'blk-list');
    const wBlock = field('Blocked by', fBlock, 'f-blocked');
    wBlock.append(blockList, h('span', 'foot-note', 'Ids of the cards that must be finished first, separated by commas.'));
    // each blocker as a link to its card, with its stage; one that is not on the board is said so
    function drawBlockers() {
      const done = cfg().roles.done;
      blockList.replaceChildren(...parseBlockers(fBlock.value).map((id) => {
        const li = h('li');
        const c = findCard(id);
        if (!c) { li.append(h('span', 'idchip', id), h('span', 'muted', 'No card with this id')); return li; }
        const a = h('a', 'ms-row blk-row');
        a.href = hashFor(selKey, id);
        const st = label(c.status);
        // "(done)" says the stage has the done role, which a stage called Done already says
        a.append(h('span', 'idchip', id), h('span', 'ms-row-title', c.title), h('span', 'blk-stage', st + (c.status === done && st.toLowerCase() !== 'done' ? ' (done)' : '')));
        li.appendChild(a);
        return li;
      }));
    }
    fBlock.addEventListener('input', drawBlockers);

    const critList = h('ul', 'crit-list');
    const addBtn = plainBtn('Add criterion', 'small');
    const critHint = h('span', 'foot-note', 'What must be true for this card to count as done. Claude may add lines but not change or remove them, and cannot move the card to done until you approve a review item.');
    const wCrit = h('div', 'field');
    const critLabel = h('span', 'fl', 'Acceptance criteria');
    critLabel.id = 'f-crit-label';
    critList.setAttribute('aria-labelledby', critLabel.id);
    wCrit.append(critLabel, critList, h('div', 'crit-add'), critHint);
    wCrit.querySelector('.crit-add').append(addBtn);
    let off = false, offWhy = '';
    function critRow(text, focus) {
      const li = h('li', 'crit-row');
      const inp = h('input', 'input');
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.maxLength = MAX_CRITERION;
      inp.value = text;
      const rm = plainBtn('×', 'small crit-rm');
      li.append(inp, rm);
      critList.appendChild(li);
      rm.addEventListener('click', () => { li.remove(); renumber(); if (onChange) onChange(); });
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.isComposing) return;
        e.preventDefault();
        if (inp.value.trim() && critList.children.length < MAX_CRITERIA) { critRow('', true); renumber(); if (onChange) onChange(); }
      });
      if (focus) inp.focus();
    }
    function renumber() {
      Array.from(critList.children).forEach((li, i) => {
        const inp = li.children[0], rm = li.children[1];
        inp.setAttribute('aria-label', 'Criterion ' + (i + 1));
        rm.setAttribute('aria-label', 'Remove criterion ' + (i + 1));
        inp.disabled = rm.disabled = off;
        inp.title = rm.title = off ? offWhy : '';
      });
      addBtn.disabled = off || critList.children.length >= MAX_CRITERIA;
      addBtn.title = off ? offWhy : critList.children.length >= MAX_CRITERIA ? 'A card has at most ' + MAX_CRITERIA + ' criteria.' : '';
    }
    addBtn.addEventListener('click', () => { critRow('', true); renumber(); if (onChange) onChange(); });
    function setCriteria(list) {
      critList.replaceChildren();
      list.forEach((t) => critRow(t, false));
      renumber();
    }
    const critValues = () => parseCriteria(Array.from(critList.children).map((li) => li.children[0].value));

    root.append(row, wLabels, wBlock, wCrit);
    const api = {
      root, controls: [fType, fPrio, fLabels, fBlock],
      values: () => ({ type: fType.value, priority: fPrio.value, labels: parseLabels(fLabels.value), blockedBy: parseBlockers(fBlock.value), criteria: critValues() }),
      setKey(k, v) {
        if (k === 'type') fType.value = v;
        else if (k === 'priority') fPrio.value = v;
        else if (k === 'labels') { fLabels.value = v.join(', '); drawChips(); }
        else if (k === 'blockedBy') { fBlock.value = v.join(', '); drawBlockers(); }
        else if (k === 'criteria') setCriteria(v);
      },
      set(vals) { FIELD_KEYS.forEach((k) => api.setKey(k, vals[k])); },
      show(ks) {
        const has = (k) => ks.includes(k);
        wType.hidden = !has('type');
        wPrio.hidden = !has('priority');
        row.hidden = wType.hidden && wPrio.hidden;
        wLabels.hidden = !has('labels');
        wBlock.hidden = !has('blockedBy');
        wCrit.hidden = !has('criteria');
        root.hidden = !ks.length;
      },
      refresh: drawBlockers,
      setDisabled(ro, why) {
        off = ro; offWhy = why || '';
        api.controls.forEach((c) => { c.disabled = ro; c.title = ro ? offWhy : ''; });
        renumber();
      },
    };
    api.show(keys);
    return api;
  }

  // startNow: open at the "Start as thread" step (the gear menu asked for it)
  function buildTaskPanel(card, startNow) {
    const create = !card;
    const P = panel = { target: create ? 'new' : card.id, type: create ? 'create' : 'task', cardKey: card ? panelKey(card) : '', confirmDelete: false, starting: !!startNow && !create && card.kind !== 'milestone' && !isRO(), scrollers: {}, actOpen: {} };
    const page = !create;      // a new card stays a side drawer
    const isMs = !create && card.kind === 'milestone';
    const ws = page && !isMs;  // a task or idea opens the workspace of a thread; a milestone keeps its page
    let S = null, runsView = null;
    if (ws) {
      S = workspaceShell(P, { lead: h('span', 'ws-ids'), tabsLabel: 'Card views', labels: { about: 'Card', conversation: 'Agent runs', trace: 'Trace' }, names: { about: 'About this card', conversation: 'Agent runs', trace: 'Trace' }, panes: cardCollapsed, key: CARD_PANES_KEY });
      S.paneL.classList.add('is-card');
      if (!(Array.isArray(card.runs) && card.runs.length)) P.view = 'about';   // narrow: with no agent run the form is the page
      runsView = attachRuns(P, S);
    } else mountDrawer(P, page);

    // the Type select of an existing card says Task, Bug or Idea (see typeChoice), so its field values carry that choice; base.type is the stored type field
    const cardValues = (c) => Object.assign(fieldValues(c), { type: typeChoice(c) });
    P.base = create ? { title: '', note: '', status: cfg().roles.start, kind: 'task', parent: '', fields: fieldValues(null) } : { title: card.title, note: card.note || '', status: card.status, kind: card.kind, type: fieldValues(card).type, parent: card.parent || '', fields: isMs ? fieldValues(card) : cardValues(card) };
    P.baseUpdatedAt = card ? card.updatedAt : '';

    const head = ws ? null : h('div', page ? 'ws-bar' : 'dr-head');
    if (head && page) head.appendChild(backBtn());
    const headRowWrap = ws ? S.bar.querySelector('.ws-ids') : h('div', page ? 'ws-ids' : null);
    if (head) head.appendChild(headRowWrap);
    const title = ws ? S.titleEl : h('h2', page ? 'ws-title' : 'dr-title', create ? 'New card' : card.title);
    if (!ws) title.id = 'drawer-title';
    if (head) head.appendChild(title);
    const seenWrap = h(ws ? 'span' : 'div');
    if (head) head.appendChild(seenWrap);

    const body = h('div', 'dr-body');
    const warnSlot = h('div');
    const conflict = h('div', 'callout warn');
    conflict.hidden = true;
    conflict.appendChild(h('span', 'grow', 'This card was changed on the board while you were editing. Saving will overwrite those changes.'));
    const roNote = h('div', 'callout warn', READONLY_WHY);
    roNote.setAttribute('role', 'status');
    roNote.hidden = true;
    // a task or idea card that opens as a page has its waiting items at the top
    const W = !create && !isMs ? attachWaits(P) : null;
    body.append(...(W ? [W.host] : []), warnSlot, roNote, conflict);
    if (W) P.focusWaits = () => { if (ws) S.reveal(); W.focus(); };

    const fTitle = h('input', 'input');
    fTitle.type = 'text';
    fTitle.maxLength = 200;
    fTitle.value = P.base.title;
    fTitle.autocomplete = 'off';
    const titleErr = h('div', 'err');
    titleErr.hidden = true;
    titleErr.id = 'title-err';
    const fTitleWrap = field('Title', fTitle, 'f-title');
    fTitleWrap.appendChild(titleErr);
    const fNote = h('textarea', 'input');
    fNote.rows = 7;
    fNote.value = P.base.note;
    // a milestone has no stage: its state follows its cards
    const fStatus = isMs ? null : h('select', 'input');
    if (fStatus) fillSelect(fStatus, stagePairs(), P.base.status);
    body.appendChild(fTitleWrap);
    body.appendChild(field('Note', fNote, 'f-note'));
    // the milestone this card belongs to (none for a milestone itself); hidden while no milestone exists
    let fKind = null;
    const fMs = isMs ? null : h('select', 'input');
    if (fMs) fillSelect(fMs, milestonePairs(), P.base.parent);
    const msField = fMs ? field('Milestone', fMs, 'f-milestone') : null;
    let wStatus = null;
    function syncMsField() {
      if (msField) msField.hidden = (fKind ? fKind.value === 'milestone' : false) || milestonePairs().length < 2;
      if (wStatus) wStatus.hidden = fKind.value === 'milestone';
    }
    if (create) {
      // one select for what the card is, in the List's words: Bug is a task with type bug, so the form has no second Type field
      fKind = h('select', 'input');
      fillSelect(fKind, [['task', 'Task'], ['bug', 'Bug'], ['idea', 'Idea'], ['milestone', 'Milestone']], P.base.kind);
      fKind.addEventListener('change', () => { if (fKind.value === 'milestone') fMs.value = ''; syncMsField(); if (FX) FX.show(fxKeys()); });
      const row = h('div', 'row2');
      wStatus = field('Status', fStatus, 'f-status');
      row.append(wStatus, field('Type', fKind, 'f-kind'));
      body.appendChild(row);
    } else if (fStatus) {
      body.appendChild(field('Status', fStatus, 'f-status'));
    }
    // a card in the done stage with acceptance criteria and no approved review (the server says so with verified: false)
    const verifyNote = h('div', 'callout warn verify-note');
    verifyNote.hidden = true;
    verifyNote.append(h('span', 'tag attn', 'Done, not verified'), h('span', 'grow', 'Claude may not move it to done or a later stage until you approve a review item; you moved it yourself.'));
    if (!create) body.appendChild(verifyNote);
    if (msField) body.appendChild(msField);
    syncMsField();
    // the fields of a task or idea: type, priority, labels, blockers and criteria; a new card offers the first three, a milestone none
    const newKind = () => (fKind.value === 'bug' ? 'task' : fKind.value);
    const fxKeys = () => (create ? fieldKeys(newKind(), true).filter((k) => k !== 'type') : fieldKeys(card.kind, false));
    const FX = isMs ? null : fieldsEditor(fxKeys(), () => onTouched(), !create);
    if (FX) { body.appendChild(FX.root); FX.set(P.base.fields); FX.show(fxKeys()); }

    // a milestone's page lists its cards, grouped by stage, and copies that list as a report
    const msSection = isMs ? h('section', 'ms-cards') : null;
    if (msSection) { body.appendChild(msSection); P.root.classList.add('is-ms'); fNote.rows = 3; }

    const metaKind = h('dd'), metaBy = h('dd'), metaCreated = h('dd'), metaUpdated = h('dd'), metaWorked = h('dd');
    let metaDl = null, laneNodes = [], workedDt = null;
    if (!create) {
      const dl = metaDl = h('dl', 'meta-grid');
      [['Kind', metaKind], ['Added by', metaBy], ['Created', metaCreated], ['Updated', metaUpdated], ['Worked by', metaWorked]].forEach(([k, dd]) => { const dt = h('dt', null, k); dl.appendChild(dt); dl.appendChild(dd); if (dd === metaWorked) workedDt = dt; });
      body.appendChild(dl);
    }

    const foot = h('div', 'dr-foot');
    if (ws) {
      // the form and the card's own record in the left pane, the buttons pinned under them
      S.scAbout.append(body, runsView.side);
      S.paneL.insertBefore(foot, S.paneL.querySelector('.pane-rail'));
      fNote.rows = 6;
    } else P.root.append(head, body, foot);

    P.isDirty = () => {
      if (fTitle.value !== P.base.title || fNote.value !== P.base.note || (fStatus && fStatus.value !== P.base.status)) return true;
      if (fMs && fMs.value !== P.base.parent) return true;
      if (FX && Object.keys(fieldsPatch(P.base.fields, FX.values(), fxKeys())).length) return true;
      return create ? fKind.value !== P.base.kind : false;
    };
    P.initialFocus = () => (create ? fTitle : P.starting ? foot.querySelector('select') || foot.querySelector('button') : P.root);

    function refreshConflict() {
      conflict.hidden = !(!create && P.isDirty() && P.latestUpdatedAt && P.latestUpdatedAt !== P.baseUpdatedAt);
    }
    const onTouched = () => { msgEl.textContent = ''; if (!titleErr.hidden && fTitle.value.trim()) clearTitleErr(); refreshConflict(); syncStart(); };
    ['input', 'change'].forEach((ev) => body.addEventListener(ev, onTouched));

    function clearTitleErr() { titleErr.hidden = true; fTitle.removeAttribute('aria-invalid'); fTitle.removeAttribute('aria-describedby'); }
    function setTitleErr(text) { titleErr.textContent = text; titleErr.hidden = false; fTitle.setAttribute('aria-invalid', 'true'); fTitle.setAttribute('aria-describedby', 'title-err'); }

    P.showDiscard = () => {
      if (ws) S.reveal();   // the prompt sits in the form: it must be in view
      if (warnSlot.firstChild) { warnSlot.querySelector('button').focus(); return; }
      const c = h('div', 'callout warn');
      c.setAttribute('role', 'alert');
      c.appendChild(h('span', 'grow', 'You have unsaved changes. Discard them and close?'));
      const keep = plainBtn('Keep editing', 'small', () => { warnSlot.replaceChildren(); fTitle.focus(); });
      const discard = plainBtn('Discard changes', 'small danger', () => {
        resetFields();
        warnSlot.replaceChildren();
        navigateClose();
      });
      c.append(keep, discard);
      warnSlot.replaceChildren(c);
      keep.focus();
    };

    const msgEl = h('span', 'foot-note');
    msgEl.setAttribute('role', 'status');

    async function save() {
      const newTitle = fTitle.value.trim();
      if (!newTitle) { setTitleErr('A title is required.'); fTitle.focus(); return; }
      clearError();
      if (isRO()) return;
      const pk = selKey;
      const key = create ? 'create:' + pk : 'save:' + pk + ':' + card.id;
      await runAction(key, async () => {
        try {
          if (create) {
            const bodyObj = { title: newTitle, kind: newKind() };
            if (fKind.value !== 'milestone') bodyObj.status = fStatus.value;   // a milestone has no stage
            if (fKind.value === 'bug') bodyObj.type = 'bug';
            if (fKind.value !== 'milestone' && fMs.value) bodyObj.parent = fMs.value;
            if (fNote.value.trim()) bodyObj.note = fNote.value.trim();
            if (FX) Object.assign(bodyObj, fieldsPatch(P.base.fields, FX.values(), fxKeys()));
            const made = await api('POST', pp(pk, 'cards'), bodyObj);
            wrote();
            applyCard(made, pk);
            resetFields();
            if (panel === P && pk === selKey) {
              history.replaceState(null, '', location.pathname + location.search + hashFor(pk, made.id));
              syncFromHash();
            }
          } else {
            const patch = {};
            if (newTitle !== P.base.title) patch.title = newTitle;
            if (fNote.value !== P.base.note) patch.note = fNote.value;
            if (fStatus && fStatus.value !== P.base.status) patch.status = fStatus.value;
            if (fMs && fMs.value !== P.base.parent) patch.parent = fMs.value;   // '' takes the card out of its milestone
            if (FX) {
              const fp = fieldsPatch(P.base.fields, FX.values(), fxKeys());
              // the Type select is the card's kind and type together
              if (fp.type !== undefined) { const tp = typePatch(fp.type, P.base.kind, P.base.type); delete fp.type; Object.assign(fp, tp); }
              Object.assign(patch, fp);
            }
            if (!Object.keys(patch).length) {
              // A Type choice that the card already is (its kind changed elsewhere to match) sends nothing: it is the baseline now, so the form is clean.
              if (FX) P.base.fields.type = FX.values().type;
              msgEl.textContent = 'No changes to save.';
              syncStart();
              return;
            }
            const saved = await api('PATCH', pp(pk, 'cards/' + encodeURIComponent(card.id)), patch);
            wrote();
            P.base = { title: saved.title, note: saved.note || '', status: saved.status, kind: saved.kind, type: fieldValues(saved).type, parent: saved.parent || '', fields: isMs ? fieldValues(saved) : cardValues(saved) };
            if (FX) FX.set(P.base.fields);
            P.baseUpdatedAt = saved.updatedAt;
            P.latestUpdatedAt = saved.updatedAt;
            if (fTitle.value === saved.title) fTitle.value = saved.title; else if (fTitle.value.trim() === saved.title) fTitle.value = saved.title;
            msgEl.textContent = 'Saved.';
            applyCard(saved, pk);
            refreshConflict();
          }
        } catch (e) { showError(e.message); }
      });
      poll();
    }

    function resetFields() {
      fTitle.value = P.base.title; fNote.value = P.base.note;
      if (fStatus) fStatus.value = P.base.status;
      if (fMs) fMs.value = P.base.parent;
      if (fKind) fKind.value = P.base.kind;
      if (FX) { FX.set(P.base.fields); FX.show(fxKeys()); }
      syncMsField();
    }
    function cancel() {
      resetFields();
      navigateClose();
    }

    // The Start as thread button, or its Start button once the step is open: both wait for saved fields.
    let startBtn = null, goBtn = null, whyEl = null, startWhyEl = null;
    function syncStart() {
      if (create) return;   // a new card has no saved card to start from
      const savedCard = findCard(P.target) || card;
      const lp = laneStartPlan(savedCard);
      const cardWhy = cardThreadStartWhy(savedCard);
      const why = isRO() ? READONLY_WHY : P.isDirty() ? 'Save or discard your changes first' : cardWhy || (lp && lp.blocked ? lp.blocked : '');
      if (startBtn) { startBtn.disabled = !!why; startBtn.title = why; }
      if (startWhyEl) { startWhyEl.textContent = cardWhy; startWhyEl.hidden = !cardWhy; }
      if (goBtn) { setOff(goBtn, !!why); whyEl.textContent = why; }
    }
    // known sessions of this project, most recently active first
    function startSessions() {
      const all = (current && current.sessions) || {};
      return Object.keys(all).map((id) => [id, all[id] || {}]).sort((a, b) => String(b[1].lastSeenAt || '').localeCompare(String(a[1].lastSeenAt || '')));
    }

    const CONTEXT_NOTE = { brief: 'Gets only this card’s title and note.', full: 'Copies the whole session; uses far more tokens.' };
    // A labelled radio choice; the first option is checked.
    function radioGroup(name, legend, options) {
      const box = h('fieldset', 'start-mode');
      box.appendChild(h('legend', null, legend));
      const radios = options.map(([value, text], i) => {
        const r = h('input');
        r.type = 'radio'; r.name = name; r.value = value; r.checked = i === 0;
        const l = h('label', 'radio');
        l.append(r, h('span', null, text));
        box.appendChild(l);
        return r;
      });
      return { box, value: () => radios.find((r) => r.checked).value };
    }

    function renderFoot(focusFirst) {
      foot.replaceChildren();
      if (isRemote()) P.starting = P.confirmDelete = false;
      startBtn = goBtn = whyEl = startWhyEl = null;
      if (P.starting) {
        const step = h('div', 'start-step');
        const lp0 = laneStartPlan(findCard(P.target) || card);
        step.appendChild(h('p', null, lp0 ? 'This card becomes a thread: a background ' + (lp0.provider ? lp0.provider + ' session' : 'session') + ' on lane ' + lp0.name + ', working on this card’s title and note.' : 'This card becomes a thread: a background Claude session working on this card’s title and note.'));
        const list = startSessions();
        const cancel = plainBtn('Cancel', null, () => { P.starting = false; renderFoot(); startBtn.focus(); });
        if (!list.length) {
          step.appendChild(h('p', 'muted', 'No Claude session has been seen in this project yet. Open the project in Claude Code and send one message, then try again.'));
          step.appendChild(h('div', 'start-btns')).appendChild(cancel);
          if (focusFirst) cancel.focus();
        } else {
          const sel = h('select', 'input');
          list.forEach(([id, info]) => {
            const o = h('option', null, (info.label || sessionLabel(id)) + (info.lastSeenAt ? ' · last active ' + rel(info.lastSeenAt) : ''));
            o.value = id;
            sel.appendChild(o);
          });
          step.appendChild(field('Started from session', sel, 'f-start-session'));

          // A card with a lane runs on it: no Full copy and no agent, and read-only only when the lane is.
          const lp = laneStartPlan(findCard(P.target) || card);
          let ctx = null;
          if (lp) {
            const lt = h('p', 'lane-start');
            lt.append(shape('s-hex'), h('span', null, lp.line));
            step.appendChild(lt);
            if (lp.detail) step.appendChild(h('p', 'foot-note', lp.detail));
            step.appendChild(h('p', 'foot-note', 'The lane’s own CLI runs it and sends the brief, and the files it reads, to that provider.'));
          } else {
            ctx = radioGroup('start-context', 'Context', [['brief', 'Brief'], ['full', 'Full copy']]);
            const ctxNote = h('p', 'foot-note', CONTEXT_NOTE.brief);
            ctxNote.id = 'f-start-context-note';
            ctx.box.setAttribute('aria-describedby', ctxNote.id);
            ctx.box.appendChild(ctxNote);
            ctx.box.addEventListener('change', () => { ctxNote.textContent = CONTEXT_NOTE[ctx.value()]; });
          }

          const mode = radioGroup('start-mode', 'Mode', lp && lp.readOnly ? [['read', 'Read-only']] : [['read', 'Read-only'], ['write', 'Can edit files']]);
          mode.box.appendChild(h('p', 'foot-note', lp ? lp.modeNote || 'Edits the same files as your main session.' : 'Edits the same files as your main session.'));
          const opts = h('div', 'start-opts');
          if (ctx) opts.appendChild(ctx.box);
          opts.appendChild(mode.box);
          step.appendChild(opts);

          // The agents of this project and of the user; if they cannot be listed, "Same as session" is still there.
          const agentSel = h('select', 'input');
          const same = h('option', null, 'Same as session');
          same.value = '';
          agentSel.appendChild(same);
          if (!lp) step.appendChild(field('Agent', agentSel, 'f-start-agent'));
          const pk = selKey;
          if (!lp) api('GET', pp(pk, 'agents')).then((r) => {
            if (panel !== P || !agentSel.isConnected) return;
            ((r && r.agents) || []).forEach((a) => {
              const o = h('option', null, agentLabel(a));
              o.value = a.name;
              if (a.description) o.title = a.description;
              agentSel.appendChild(o);
            });
          }).catch(() => { /* the list is optional */ });

          goBtn = actionBtn('Start', 'primary', 'start:' + selKey + ':' + card.id, () => doStart({ sessionId: sel.value, mode: mode.value(), context: ctx ? ctx.value() : 'brief', agent: lp ? '' : agentSel.value }));
          whyEl = h('span', 'foot-note');
          whyEl.setAttribute('role', 'status');
          step.appendChild(h('div', 'start-btns')).append(goBtn, cancel, whyEl);
          if (focusFirst) sel.focus();
        }
        foot.appendChild(step);
        syncBusy();
        syncStart();
        return;
      }
      if (P.confirmDelete) {
        foot.appendChild(h('span', 'confirm-text', deleteConfirmText(card)));
        foot.appendChild(h('span', 'grow'));
        const del = actionBtn('Delete card', 'danger solid', 'delete:' + selKey + ':' + card.id, () => doDelete(card.id));
        const keep = plainBtn('Keep it', null, () => { P.confirmDelete = false; renderFoot(true); });
        foot.append(keep, del);
        if (focusFirst) keep.focus();
        syncBusy();
        return;
      }
      const ro = isRO();
      const away = isRemote();   // through the tunnel there is no Start as thread and no Delete
      const saveBtn = actionBtn(create ? 'Create card' : 'Save', 'primary', create ? 'create:' + selKey : 'save:' + selKey + ':' + card.id, save);
      if (focusFirst) setTimeout(() => saveBtn.focus(), 0);
      saveBtn.title = ro ? READONLY_WHY : 'Save (Ctrl or Cmd + Enter)';
      if (ro) setOff(saveBtn, true);
      foot.append(saveBtn, plainBtn('Cancel', null, cancel), msgEl);
      foot.appendChild(h('span', 'grow'));
      if (!create) {
        if (!isMs && !away) {      // a milestone cannot be a thread
          startBtn = plainBtn('Start as thread', null, () => { P.starting = true; renderFoot(true); });
          startWhyEl = h('span', 'foot-note');
          startWhyEl.setAttribute('role', 'status');
          foot.append(startBtn, startWhyEl);
        }
        if (!away) {
          const del = plainBtn('Delete', 'danger', () => { P.confirmDelete = true; renderFoot(true); });
          if (ro) { del.disabled = true; del.title = READONLY_WHY; }
          foot.appendChild(del);
        }
        syncStart();
      }
      syncBusy();
    }

    // The server turns the card into a thread under the same id; updatePanel then swaps this page for the workspace.
    async function doStart({ sessionId, mode, context, agent }) {
      clearError();
      const pk = selKey;
      await runAction('start:' + pk + ':' + card.id, async () => {
        try { const started = await api('POST', pp(pk, 'cards/' + encodeURIComponent(card.id) + '/start'), { sessionId, mode, context, agent: agent || undefined }); wrote(); applyCard(started, pk); }
        catch (e) { showError(e.message); }
      });
      poll();
    }

    async function doDelete(id) {
      await deleteCard(id, (ok, here) => {
        if (!ok) P.confirmDelete = false;
        if (ok && panel === P && here) {
          dropCard(id);
          P.isDirty = null;
          returnFocus = { el: elNewBtn };
          navigateClose();
          renderBoard(false);
        } else if (panel === P) renderFoot();
      });
    }

    let roShown = null;
    function applyRO() {
      const ro = isRO();
      if (ro === roShown) return;
      roShown = ro;
      roNote.hidden = !ro;
      [fTitle, fNote, fStatus, fMs, fKind].forEach((f) => { if (f) { f.disabled = ro; f.title = ro ? READONLY_WHY : ''; } });
      if (FX) FX.setDisabled(ro, READONLY_WHY);
      if (ro) P.confirmDelete = P.starting = false;
      renderFoot();
    }

    P.update = (c) => {
      P.latestUpdatedAt = c.updatedAt;
      if (W) W.update(c);
      title.textContent = c.title;
      const fm = faceModel(c, { cards: current.cards, finished: (b) => finishedIn(b, cfg()), label });
      headRowWrap.replaceChildren(h('span', 'idchip', c.id), kindMark(c.kind), ...[bugMark(fm), priorityMark(fm)].filter(Boolean));
      seenWrap.replaceChildren();
      if (c.seenByClaude === false) seenWrap.appendChild(unseenEl(ws ? 'span' : 'div'));
      if (ws) {
        const n = Array.isArray(c.runs) ? c.runs.length : 0;
        S.meta.replaceChildren(h('span', null, label(c.status)), h('span', 'tnum', n ? n + (n === 1 ? ' agent run' : ' agent runs') : 'No agent runs'), seenWrap);
        runsView.update(c);
      }
      // follow the server only for fields the user has not touched
      const nb = { title: c.title, note: c.note || '', status: c.status, parent: c.parent || '' };
      [[fTitle, 'title'], [fNote, 'note']].forEach(([f, k]) => {
        if (f.value === P.base[k]) { f.value = nb[k]; P.base[k] = nb[k]; }
      });
      // the stages and milestones may have changed too: refill the lists, keeping what the user picked
      [[fStatus, stagePairs(), 'status'], [fMs, milestonePairs(), 'parent']].forEach(([f, pairs, k]) => {
        if (!f) return;
        const clean = f.value === P.base[k];
        fillSelect(f, pairs, clean ? nb[k] : f.value);
        if (clean) P.base[k] = nb[k];
      });
      syncMsField();
      if (FX) {
        // the fields follow the server too, one by one, where the user has not touched them
        const nv = cardValues(c), cur = FX.values();
        FIELD_KEYS.forEach((k) => {
          if (!sameField(cur[k], P.base.fields[k])) {
            // the user changed it: keep their choice, but when the server now says the same (a kind changed elsewhere), that is the baseline
            if (sameField(nv[k], cur[k])) P.base.fields[k] = nv[k];
            return;
          }
          if (!sameField(nv[k], cur[k])) FX.setKey(k, nv[k]);
          P.base.fields[k] = nv[k];
        });
        FX.refresh();
      }
      verifyNote.hidden = c.verified !== false;
      const wc = workerChips(c.workedBy);
      metaWorked.replaceChildren(...(wc ? [wc] : []));
      if (workedDt) workedDt.hidden = metaWorked.hidden = !wc;
      P.base.kind = c.kind;
      P.base.type = fieldValues(c).type;
      if (!P.isDirty()) P.baseUpdatedAt = c.updatedAt;
      metaKind.textContent = c.kind;
      metaBy.textContent = c.source === 'user' ? 'You' : 'Claude';
      metaCreated.replaceChildren(timeEl(c.createdAt));
      metaUpdated.replaceChildren(timeEl(c.updatedAt));
      if (metaDl) laneNodes = showLaneRows(metaDl, laneNodes, c);
      const ls = laneSig(c);
      if (P.laneSig !== undefined && P.laneSig !== ls) { if (P.starting) renderFoot(); else syncStart(); }   // the lane changed: the start step, or the button, follows
      P.laneSig = ls;
      if (msSection) renderMsCards(c);
      refreshConflict();
      syncStart();
      applyRO();
    };

    // "Cards in this milestone": a link per card, grouped by stage, and the same list as a plain-text report
    function renderMsCards(m) {
      const a = document.activeElement;
      const fid = a && msSection.contains(a) && a.dataset ? a.dataset.fid : null;
      const conf = cfg();
      const kids = childrenOf(current.cards, m.id);
      msSection.replaceChildren();
      const head = h('div', 'ms-cards-head');
      head.append(h('h3', 'ms-h', 'Cards in this milestone'), msStateTag(msStateOf(m, current.cards, conf)), progressEl(progressFor(m)));
      const cp = copyBtn(milestoneReport(m, current.cards, conf), 'milestone report', 'Copy report');
      cp.dataset.fid = 'ms-copy';
      head.appendChild(cp);
      msSection.appendChild(head);
      if (!kids.length) msSection.appendChild(h('p', 'muted', 'No cards in this milestone yet. Open a task or idea and pick this milestone to add it.'));
      groupByStage(kids, conf.stages).forEach((g) => {
        const sh = h('h4', 'ms-stage', g.stage.label);
        sh.appendChild(h('span', 'count', String(g.cards.length)));
        const ul = h('ul', 'ms-list');
        g.cards.forEach((k) => {
          const li = h('li');
          const link = h('a', 'ms-row');
          link.href = hashFor(selKey, k.id);
          link.dataset.fid = 'ms-' + k.id;
          link.append(h('span', 'idchip', k.id), kindMark(k.kind), h('span', 'ms-row-title', k.title));
          li.appendChild(link);
          ul.appendChild(li);
        });
        msSection.append(sh, ul);
      });
      if (fid) { const t = msSection.querySelector('[data-fid="' + fid + '"]'); if (t) t.focus({ preventScroll: true }); }
    }

    if (create) {
      headRowWrap.appendChild(headRow(null, true));
    } else {
      if (ws) { if (P.starting) S.reveal(); S.applyPanes(); }   // opened at the start step: its select must be in view to take focus
      P.update(card);
    }
    renderFoot();

    P.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); if (!P.confirmDelete && !P.starting) save(); }
      else if (e.key === 'Enter' && e.target === fTitle && !e.isComposing) { e.preventDefault(); save(); }
    });
  }
