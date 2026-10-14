  // ---------- remote access (the tunnel) ----------
  // Through the tunnel the server answers /api/caps with { remote: true, expiresAt } and refuses starting a thread, messaging one,
  // ending one, deleting a card or a project, stopping a run and the other controls below. The page hides what would be refused.
  // An address that does not answer /api/caps (a board from an older version) is a local one.
  let remote = false;
  let remoteUntil = 0;       // when the tunnel's link stops working (ms since 1970), 0 when unknown
  const elRemote = $('remote-badge');
  const REMOTE_DENIED = ['start', 'end', 'delete'];   // ids in a card's gear menu
  function isRemote() { return remote; }
  // A card's gear menu without the actions the tunnel refuses; no divider is left at an end or twice in a row.
  function remoteActions(list) {
    if (!remote) return list;
    const out = [];
    list.forEach((x) => {
      if (x.id && REMOTE_DENIED.includes(x.id)) return;
      if (x.sep && (!out.length || out[out.length - 1].sep)) return;
      out.push(x);
    });
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  }
  function remoteUntilText() {
    const d = new Date(remoteUntil);
    if (isNaN(d)) return '';
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function showRemote() {
    const until = remote && remoteUntil ? remoteUntilText() : '';
    elRemote.hidden = !remote;
    elRemote.textContent = until ? 'Remote · until ' + until : 'Remote';
    elRemote.title = 'You are using the board through a tunnel. Starting or messaging threads, ending threads and deleting are only possible on the computer itself.' + (until ? ' The link stops working at ' + until + '.' : '');
  }
  async function loadCaps() {
    try {
      const { res, text } = await request('GET', '/api/caps', null, 5000);
      const data = res.ok ? parseJson(text) : null;
      remote = !!(data && data.remote === true);
      remoteUntil = remote && Number.isFinite(data.expiresAt) ? data.expiresAt : 0;
    } catch (e) { /* not known yet: the next version check asks again when the server says it is remote */ }
    showRemote();
  }
