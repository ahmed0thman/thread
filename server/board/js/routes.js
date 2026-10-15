  // ---------- routes ----------

  // ---- routes (shell-page.test.mjs runs this block on its own) ----
  // Every address is a hash. '#/' is the projects home, '#/<project>' a project's default view, '#/<project>/<view>' one of its views
  // and '#/<project>/<card>' a card's page. A view is a word and a card id is 'c' with letters and digits and at least one digit, such as c37 or c8k2x1 (or 'new'), so the two never collide.
  // The old '#<card>' form has no project part and opens the card in the selected project.
  const VIEWS = ['summary', 'board', 'list', 'milestones', 'waiting'];
  const VIEW_LABEL = { summary: 'Summary', board: 'Board', list: 'List', milestones: 'Milestones', waiting: 'Waiting' };
  function decode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  // { home, key, view, card }: at most one of view and card is set; both are '' for a project's default view
  function parseRoute(hash) {
    const raw = String(hash || '').replace(/^#/, '');
    if (raw === '' || raw === '/') return { home: true, key: '', view: '', card: '' };
    let key = '', rest;
    if (raw.startsWith('/')) {
      const tail = raw.slice(1);
      const cut = tail.indexOf('/');
      key = decode(cut < 0 ? tail : tail.slice(0, cut));
      rest = cut < 0 ? '' : decode(tail.slice(cut + 1));
    } else rest = decode(raw);
    const isView = VIEWS.includes(rest);
    return { home: false, key, view: isView ? rest : '', card: isView ? '' : rest };
  }
  function hashFor(key, target) { return '#/' + encodeURIComponent(key) + (target ? '/' + encodeURIComponent(target) : ''); }
  // A chat-only project shows its threads on the board and nothing else; every other project starts at its Summary.
  function defaultView(chat) { return chat ? 'board' : 'summary'; }
  function viewsOf(chat) { return chat ? ['board'] : VIEWS; }
  // The view a route shows. `shown` is the view on screen: a card's page opens over it. `fix` says the address named a view this
  // project does not have, and must be rewritten.
  function resolveView(route, chat, shown) {
    if (chat) return { view: 'board', fix: !!route.view && route.view !== 'board' };
    if (route.view) return { view: route.view, fix: false };
    return { view: route.card && shown ? shown : defaultView(chat), fix: false };
  }
  // ---- end routes ----

