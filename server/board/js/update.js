  // ---------- update notes ----------
  // Two notes under the header, each put away for good, per version, in this browser: "Updated to X" (this computer's plugin was updated;
  // What's new shows the entry the server read from the plugin's own CHANGELOG.md) and "thread X is out" (the opt-in update check found
  // a newer release; the two commands that update it). The page makes no network call of its own: the server answers /api/update.
  // ---- update notes (update-page.test.mjs runs this block with stand-ins) ----
  const UPDATE_KEY = 'thread-board-update';
  const UPDATE_COMMANDS = ['claude plugin marketplace update thread-marketplace', 'claude plugin update thread@thread-marketplace'];
  const box = () => $('update-note');
  function updateDismissed(kind, version) {
    try { return localStorage.getItem(UPDATE_KEY + ':' + kind + ':' + version) === '1'; } catch (e) { return false; }
  }
  function dismissUpdate(kind, version) {
    try { localStorage.setItem(UPDATE_KEY + ':' + kind + ':' + version, '1'); } catch (e) { /* not saved: it comes back on the next load */ }
  }
  function updateItem(kind, version, lead, parts) {
    const item = h('section', 'mode-note update-item');
    item.dataset.kind = kind;
    item.setAttribute('aria-label', kind === 'out' ? 'A newer thread version is out' : 'thread was updated');
    const row = h('div', 'update-row');
    row.appendChild(h('span', 'grow', lead));
    const dismiss = plainBtn('Dismiss', 'small', () => { dismissUpdate(kind, version); item.remove(); box().hidden = !box().children.length; });
    dismiss.setAttribute('aria-label', 'Dismiss this note');
    row.append(...parts, dismiss);
    item.appendChild(row);
    return item;
  }
  function updatedItem(info) {
    const lead = 'Updated to ' + info.version + (info.from ? ' (from ' + info.from + ')' : '') + '.';
    const panel = h('div', 'update-panel md');
    panel.hidden = true;
    if (info.notes) panel.appendChild(renderMarkdown(info.notes));
    else panel.appendChild(h('p', null, 'See the release notes: ' + info.releases));
    const more = plainBtn('What’s new', 'small');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      more.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });
    const item = updateItem('updated', info.version, lead, [more]);
    item.appendChild(panel);
    return item;
  }
  function outItem(info) {
    const item = updateItem('out', info.latest, 'thread ' + info.latest + ' is out (this is ' + info.version + '). To update, run these, then reload the window:', []);
    const cmds = h('div', 'md update-cmds');
    UPDATE_COMMANDS.forEach((c) => cmds.appendChild(codeBlock(c, 'bash', true, true)));
    item.appendChild(cmds);
    return item;
  }
  // info: the answer of /api/update, or null; shows what is not put away yet
  function renderUpdate(info) {
    const items = [];
    if (info && typeof info.version === 'string') {
      if ((info.from || info.updated === true) && !updateDismissed('updated', info.version)) items.push(updatedItem(info));
      if (info.latest && !updateDismissed('out', info.latest)) items.push(outItem(info));
    }
    box().replaceChildren(...items);
    box().hidden = !items.length;
  }
  async function refreshUpdate() {
    if (isRemote()) return;    // the tunnel does not serve it
    let info = null;
    try {
      const { res, text } = await request('GET', '/api/update', null, 5000);
      info = res.ok ? parseJson(text) : null;
    } catch (e) { /* no notes this time */ }
    renderUpdate(info);
  }
  // ---- end update notes ----

