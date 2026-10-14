  // ---------- milestones ----------
  let milestoneSel = '';     // the Milestone filter: '' = all, NO_MS = cards in no milestone, else a milestone id
  // A chat-only project has no visible task cards, so no milestones either.
  function milestoneCards() { return current && !isChat() ? current.cards.filter((c) => c.kind === 'milestone') : []; }
  function milestoneOf(card) {
    if (!card.parent || card.kind === 'milestone') return null;
    return milestoneCards().find((m) => m.id === card.parent) || null;
  }
  // [[id, label]] by title; two milestones with one title get their ids
  function milestoneChoices() {
    const list = milestoneCards().slice().sort((a, b) => a.title.localeCompare(b.title));
    const seen = {};
    list.forEach((m) => { seen[m.title] = (seen[m.title] || 0) + 1; });
    return list.map((m) => [m.id, seen[m.title] > 1 ? m.title + ' (' + m.id + ')' : m.title]);
  }
  let msSig = '';
  function updateMilestoneOptions() {
    const choices = milestoneChoices();
    // a deleted milestone (or none left) takes its filter with it
    if (current && milestoneSel && milestoneSel !== NO_MS && !choices.some((c) => c[0] === milestoneSel)) milestoneSel = '';
    if (current && !choices.length) milestoneSel = '';
    const sig = JSON.stringify([choices, milestoneSel]);
    if (sig === msSig) return;
    msSig = sig;
    elMilestoneWrap.hidden = !choices.length;
    fillSelect(elMilestone, [['', 'All']].concat(choices, [[NO_MS, 'No milestone']]), milestoneSel);
  }
  elMilestone.addEventListener('change', () => { milestoneSel = elMilestone.value; renderBoard(false); });
  // a card's milestone tag: show only that milestone and its cards
  function filterToMilestone(id) {
    milestoneSel = id;
    updateMilestoneOptions();
    renderBoard(false);
    elMilestone.focus({ preventScroll: true });
  }
  function milestoneTag(m) {
    const b = h('button', 'tag ms-tag');
    b.type = 'button';
    b.appendChild(shape('s-tri'));
    b.appendChild(h('span', 'ms-tag-text', clip(m.title, 30)));
    b.title = 'Show only the cards in “' + m.title + '”';
    b.setAttribute('aria-label', 'Milestone ' + m.title + ': show only its cards');
    b.addEventListener('click', (e) => { e.stopPropagation(); filterToMilestone(m.id); });
    return b;
  }
  // "3/5 done" with a thin bar
  function progressEl(p) {
    const row = h('div', 'ms-prog');
    const bar = h('span', 'ms-bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = h('i');
    fill.style.width = (p.total ? Math.round(100 * p.done / p.total) : 0) + '%';
    bar.appendChild(fill);
    row.append(bar, h('span', 'tnum', p.total ? p.done + '/' + p.total + ' done' : 'No cards yet'));
    return row;
  }
  function progressFor(m) { return progressOf(current.cards, m.id, cfg().roles.done); }

  // A <select>'s options from [[value, text]]; rebuilt only when they changed. `want` is the value to show (the first option if it is gone).
  function fillSelect(sel, pairs, want) {
    const sig = JSON.stringify(pairs);
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.replaceChildren(...pairs.map(([v, t]) => { const o = h('option', null, t); o.value = v; return o; }));
    }
    sel.value = pairs.some((p) => p[0] === want) ? want : (pairs.length ? pairs[0][0] : '');
  }

  let dirShown = null;
  function setDir(dir) {
    if (dir === dirShown) return;
    dirShown = dir;
    const parts = dirParts(dir);
    $('dir-head').textContent = parts.head;
    $('dir-tail').textContent = parts.tail;
    $('dir').title = dir;
    $('dir').classList.toggle('none', !dir);
  }

