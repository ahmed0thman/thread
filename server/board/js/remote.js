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

  // ---------- the one-time code of the link /thread:board opens ----------
  // The browser is opened with ?c=<code>, not the token (a token in a command line can be read by any process of the user). The code is
  // used once: the server answers the token, which replaces whatever was stored. A code that is not valid (used, expired, or from another
  // board) leaves the stored token, if there is one, to be tried; with none the access-link page shows.
  async function exchangeCode() {
    const code = pendingCode;
    pendingCode = '';
    let got = '';
    try {
      const res = await fetch('/api/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store' });
      const data = res.ok ? parseJson(await res.text()) : null;
      if (data && typeof data.token === 'string' && /^[0-9a-f]{32,128}$/.test(data.token)) got = data.token;
    } catch (e) { /* the server could not be reached: the stored token, if any, is tried */ }
    if (got) {
      token = got;
      storeToken(got);
    } else token = readStoredToken();
  }

  // ---------- the phone link ----------
  // While the tunnel is open, the page on this computer offers its remote link (with the tunnel's token, so the server hands it only to
  // this page, over the board token): "Phone link" with a Copy button, in the top bar. The link is made here, for the project that is open.
  const elPhone = $('phone-link');
  const elPhoneUntil = $('phone-until');
  let phoneLink = null;      // { url, token, expiresAt } while the tunnel is open
  let phoneTimer = null;
  let phoneCopy = null;
  function phoneHref() {
    return phoneLink ? phoneLink.url + '#t=' + phoneLink.token + (selKey ? '/' + selKey : '') : '';
  }
  function showPhoneLink() {
    elPhone.hidden = !phoneLink || remote;
    if (!phoneLink) return;
    const d = new Date(phoneLink.expiresAt);
    const sameDay = d.toDateString() === new Date().toDateString();
    elPhoneUntil.textContent = isNaN(d) ? '' : 'until ' + d.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    if (!phoneCopy) {
      phoneCopy = plainBtn('Copy', 'small');
      phoneCopy.setAttribute('aria-label', 'Copy the phone link');
      // the link is made when the button is pressed, so it is for the project that is open then
      phoneCopy.addEventListener('click', async () => {
        const ok = await copyOrWarn(phoneHref());
        phoneCopy.textContent = ok ? 'Copied' : 'Copy failed';
        clearTimeout(phoneCopy._t);
        phoneCopy._t = setTimeout(() => { phoneCopy.textContent = 'Copy'; }, 1600);
      });
      elPhone.appendChild(phoneCopy);
    }
  }
  async function refreshPhoneLink() {
    clearTimeout(phoneTimer);
    if (halted || remote) return;
    try {
      const { res, text } = await request('GET', '/api/tunnel-link', null, 5000);
      const data = res.ok ? parseJson(text) : null;
      phoneLink = data && data.active === true && typeof data.url === 'string' && typeof data.token === 'string' ? { url: data.url, token: data.token, expiresAt: data.expiresAt } : null;
    } catch (e) { /* an older board has no such route: no item */ }
    showPhoneLink();
    phoneTimer = setTimeout(refreshPhoneLink, PROJECTS_MS);
  }
