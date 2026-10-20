  // ---------- the Milestones view's map: the milestones in number order, the dependencies their cards make, laid out in layers ----------

  // ---- milestone map model (milestones-map.test.mjs runs this block on its own, with the "milestones and stages" block) ----
  // The number a title starts with: "M3: Checkout", "10 Launch", "1. Setup", "v2.1: Beta". Not "M1.2.3" or "M3x", and not a title
  // that has no number in front ("Holiday sale").
  const MS_NUM_RE = /^\s*([A-Za-z]{0,3}\d{1,3}(?:\.\d{1,2})?)(?!\w|\.\w)/;
  const MS_NAME_MAX = 24;
  // The milestones in number order: by title with numbers compared as numbers (M0, M1, M2 … M10), whatever their state. A title with
  // no number in front has no place in that order, so it comes after the numbered ones.
  function milestonesByNumber(list) {
    const numbered = (m) => (MS_NUM_RE.test(String(m.title || '')) ? 0 : 1);
    return list.map((m, i) => ({ m, i })).sort((a, b) => numbered(a.m) - numbered(b.m) || msTitleCmp(a.m, b.m) || a.i - b.i).map((x) => x.m);
  }
  // The number a milestone's title starts with ("M3"), or '' when it has none.
  function msShort(m) {
    const x = MS_NUM_RE.exec(String(m.title || ''));
    return x ? x[1] : '';
  }
  // What the lists call a milestone: its number, or its title cut to MS_NAME_MAX characters when it has no number.
  function msLabel(m) {
    const s = msShort(m);
    if (s) return s;
    const t = String(m.title || m.id).trim() || String(m.id);
    return t.length > MS_NAME_MAX ? t.slice(0, MS_NAME_MAX - 1).trimEnd() + '…' : t;
  }
  // The name of a map node in a list ("Now: M2, Holiday sale"): its label, with the card id after it when another milestone has the same label.
  function msName(n) { return n.dup ? n.label + ' (' + n.id + ')' : n.label; }
  // Milestone A depends on milestone B when a card in A is blocked by a card in B. Ideas do not count (as everywhere in the view),
  // and a link inside one milestone is not a dependency. Each edge keeps the card links that make it: [{ card, by }]. (A milestone
  // cannot itself be a blocker, but a stored `blockedBy` naming one is read as a link to that milestone.)
  function milestoneDeps(list, cards) {
    const ms = new Set(list.map((m) => m.id));
    const home = new Map(list.map((m) => [m.id, m.id]));
    const counted = (c) => c.kind !== 'milestone' && c.kind !== 'idea' && ms.has(c.parent);
    cards.forEach((c) => { if (counted(c)) home.set(c.id, c.parent); });
    const edges = new Map();
    cards.forEach((c) => {
      if (!counted(c) || !Array.isArray(c.blockedBy)) return;
      new Set(c.blockedBy.filter((b) => typeof b === 'string')).forEach((b) => {
        const to = home.get(b);
        if (!to || to === c.parent) return;
        const k = c.parent + '>' + to;
        if (!edges.has(k)) edges.set(k, { from: c.parent, to, links: [] });
        edges.get(k).links.push({ card: c.id, by: b });
      });
    });
    return [...edges.values()];
  }
  // The strongly connected components of the milestones (Tarjan), each a list of ids, dependencies first. One with several milestones
  // is a cycle: they wait on each other.
  function msComponents(nodes, at) {
    let i = 0;
    const index = new Map(), low = new Map(), on = new Set(), stack = [], comps = [];
    const visit = (n) => {
      index.set(n.id, i); low.set(n.id, i); i++;
      stack.push(n.id); on.add(n.id);
      n.deps.forEach((d) => {
        if (!index.has(d)) { visit(at.get(d)); low.set(n.id, Math.min(low.get(n.id), low.get(d))); }
        else if (on.has(d)) low.set(n.id, Math.min(low.get(n.id), index.get(d)));
      });
      if (low.get(n.id) === index.get(n.id)) {
        const c = [];
        let x;
        do { x = stack.pop(); on.delete(x); c.push(x); } while (x !== n.id);
        comps.push(c);
      }
    };
    nodes.forEach((n) => { if (!index.has(n.id)) visit(n); });
    return comps;
  }
  // The map as plain data. mode 'deps': each milestone in a layer after every milestone it depends on (columns, left to right), a
  // milestone with no link at all in a lane of its own ('loose'). mode 'order': no card links anywhere, so the milestones stand in
  // number order on one line, which is an order and not a dependency. Milestones that wait on each other (a cycle: a strongly
  // connected component) stand in number order in the layers after what they depend on from outside, and only the edges between
  // two of them are marked `cycle`: a link on the way into or out of a cycle is no part of it.
  function milestoneMap(list, cards, config) {
    const order = milestonesByNumber(list);
    const edges = milestoneDeps(order, cards);
    // the links drawn by hand (a milestone's `dependsOn`) are edges too: one line that says both when cards link the same two
    const known = new Set(order.map((m) => m.id));
    const edgeAt = new Map(edges.map((e) => [e.from + '>' + e.to, e]));
    order.forEach((m) => {
      if (!Array.isArray(m.dependsOn)) return;
      new Set(m.dependsOn.filter((d) => typeof d === 'string' && d !== m.id && known.has(d))).forEach((d) => {
        const e = edgeAt.get(m.id + '>' + d);
        if (e) e.hand = true;
        else { const x = { from: m.id, to: d, links: [], hand: true }; edges.push(x); edgeAt.set(m.id + '>' + d, x); }
      });
    });
    const idx = new Map(order.map((m, i) => [m.id, i]));
    const nodes = order.map((m) => {
      const p = progressOf(cards, m.id, config);
      return { id: m.id, title: String(m.title || m.id), short: msShort(m), label: msLabel(m), dup: false, state: msStateOf(m, cards, config), done: p.done, total: p.total, deps: [], neededBy: [], byHand: [], layer: 0, row: 0, loose: false, cycle: false };
    });
    const labels = new Map();
    nodes.forEach((n) => labels.set(n.label, (labels.get(n.label) || 0) + 1));
    nodes.forEach((n) => { n.dup = labels.get(n.label) > 1; });
    const at = new Map(nodes.map((n) => [n.id, n]));
    const byNum = (a, b) => idx.get(a) - idx.get(b);
    edges.forEach((e) => { at.get(e.from).deps.push(e.to); at.get(e.to).neededBy.push(e.from); if (e.hand) at.get(e.from).byHand.push(e.to); });
    nodes.forEach((n) => { n.deps.sort(byNum); n.neededBy.sort(byNum); n.byHand.sort(byNum); });
    edges.sort((a, b) => byNum(a.from, b.from) || byNum(a.to, b.to));
    const mode = edges.length ? 'deps' : 'order';
    if (mode === 'order') nodes.forEach((n, i) => { n.layer = i; });
    else {
      const comps = msComponents(nodes, at);
      const home = new Map();
      comps.forEach((c, k) => c.forEach((id) => home.set(id, k)));
      comps.forEach((c, k) => {
        const members = c.map((id) => at.get(id)).sort((a, b) => byNum(a.id, b.id));
        let base = 0;
        members.forEach((n) => n.deps.forEach((d) => { if (home.get(d) !== k) base = Math.max(base, at.get(d).layer + 1); }));
        members.forEach((n, j) => { n.layer = base + j; n.cycle = members.length > 1; });
      });
      edges.forEach((e) => { e.cycle = home.get(e.from) === home.get(e.to); });
      nodes.forEach((n) => { n.loose = !n.deps.length && !n.neededBy.length; });
      // rows: a layer's milestones by the mean row of what they depend on (fewer crossings), then by number
      const layers = [];
      nodes.filter((n) => !n.loose).forEach((n) => { (layers[n.layer] = layers[n.layer] || []).push(n); });
      layers.forEach((ls) => {
        const mean = (n) => { const r = n.deps.filter((d) => at.get(d).layer < n.layer).map((d) => at.get(d).row); return r.length ? r.reduce((s, x) => s + x, 0) / r.length : -1; };
        ls.map((n) => ({ n, k: mean(n) })).sort((a, b) => a.k - b.k || byNum(a.n.id, b.n.id)).forEach((x, r) => { x.n.row = r; });
      });
      nodes.filter((n) => n.loose).forEach((n, i) => { n.layer = i; });
    }
    nodes.forEach((n) => {
      n.waitingOn = n.deps.filter((d) => at.get(d).state !== 'done');
      n.now = n.state === 'open' && !n.waitingOn.length;
    });
    return { mode, nodes, edges };
  }
  // Every milestone `id` depends on, directly or through others, in number order (not `id` itself, even in a cycle). The walk stops at a
  // done milestone: it is listed (its line is drawn) but what it waits on is not, as "ready" (`now`) looks at direct dependencies only.
  function msUpstream(map, id) {
    const at = new Map(map.nodes.map((n) => [n.id, n]));
    const seen = new Set([id]);
    const todo = [id];
    while (todo.length) (at.get(todo.pop()) || { deps: [] }).deps.forEach((d) => { if (!seen.has(d)) { seen.add(d); if (at.get(d).state !== 'done') todo.push(d); } });
    seen.delete(id);
    return map.nodes.filter((n) => seen.has(n.id)).map((n) => n.id);
  }
  // The milestone the map shows: the one asked for while it exists, else where the project is (the first open milestone with nothing
  // left to wait on), else the first open, else the first not done, else the first.
  function msMapPick(map, want) {
    const ns = map.nodes;
    const n = ns.find((x) => x.id === want) || ns.find((x) => x.now) || ns.find((x) => x.state === 'open') || ns.find((x) => x.state !== 'done') || ns[0];
    return n ? n.id : '';
  }
  // The map's grid: a cell is MS_COL wide and MS_ROW high, a milestone fills most of one. The routes of the lines run through the gaps between cells,
  // so a milestone is always in a cell, never between two. The owner's saved positions (see layout.mjs) are cells too.
  const MS_NODE_W = 140, MS_NODE_H = 148, MS_COL = 204, MS_ROW = 180, MS_R = 24, MS_TOP = 40, MS_PAD = 16;
  const MS_MAX_CELL = 79;     // as MAX_CELL in layout.mjs
  const MS_LOOSE_GAP = 30;    // the space above the row of milestones nothing links, which has a label
  const msCellOk = (v) => Number.isInteger(v) && v >= 0 && v <= MS_MAX_CELL;
  // The cell of every milestone: the one the owner saved (`layout`: id -> { col, row }) while it is a good cell that no other saved milestone
  // has, else the one the map gives it (its layer, and its row; a milestone nothing links in the row after the last). An automatic milestone
  // whose cell is taken moves down to the next free one. Returns { cells: Map id -> { col, row, saved }, R0 } where R0 is the automatic row
  // of the milestones nothing links. The layout may hold ids that are gone: they are ignored.
  function msPlace(map, layout) {
    const saved = layout !== null && typeof layout === 'object' ? layout : {};
    const main = map.nodes.filter((n) => !n.loose);
    const R0 = main.length ? 1 + Math.max(...main.map((n) => n.row)) : 0;
    const taken = new Set();
    const cells = new Map();
    const key = (c, r) => c + ':' + r;
    map.nodes.forEach((n) => {
      const p = saved[n.id];
      if (p && typeof p === 'object' && msCellOk(p.col) && msCellOk(p.row) && !taken.has(key(p.col, p.row))) {
        taken.add(key(p.col, p.row));
        cells.set(n.id, { col: p.col, row: p.row, saved: true });
      }
    });
    map.nodes.forEach((n) => {
      if (cells.has(n.id)) return;
      const col = n.layer;
      let row = n.loose ? R0 : n.row;
      while (taken.has(key(col, row))) row++;
      taken.add(key(col, row));
      cells.set(n.id, { col, row, saved: false });
    });
    return { cells, R0 };
  }
  // The top of a row, and the grid's other measures, as one object: `loose` is true while a milestone nothing links stands in the automatic row
  // for them, which has a label above it and so a gap of MS_LOOSE_GAP more.
  function msGrid(R0, loose) {
    const off = loose ? MS_LOOSE_GAP : 0;
    const rowTop = (r) => MS_TOP + r * MS_ROW + (r >= R0 ? off : 0);
    // the middle of the gap above a row, where the lines run along; the row with the label has its own gap just below the row before it
    const gapAbove = (r) => rowTop(r) - (MS_ROW - MS_NODE_H) / 2 - (loose && r === R0 ? off : 0);
    const left = (c) => MS_PAD + c * MS_COL;
    return { rowTop, gapAbove, left, R0, loose };
  }
  // The cell nearest a point of the map (x, y from its top left corner), by the middle of each cell.
  function msSnap(grid, x, y) {
    const col = Math.max(0, Math.min(MS_MAX_CELL, Math.round((x - MS_PAD - MS_NODE_W / 2) / MS_COL)));
    let row = 0, best = Infinity;
    for (let r = 0; r <= MS_MAX_CELL; r++) {
      const d = Math.abs(y - (grid.rowTop(r) + MS_NODE_H / 2));
      if (d < best) { best = d; row = r; } else if (r > row + 1) break;
    }
    return { col, row };
  }
  // The positions to save when milestone `id` is dropped in a cell (`cells`: the placement now): its own, and when another milestone stands
  // there, that one goes to the cell `id` leaves (a swap). {} when it is dropped where it is.
  function msMovePlan(cells, id, col, row) {
    const me = cells.get(id);
    if (!me || !msCellOk(col) || !msCellOk(row) || (me.col === col && me.row === row)) return {};
    const plan = {};
    plan[id] = { col, row };
    for (const [other, c] of cells) if (other !== id && c.col === col && c.row === row) plan[other] = { col: me.col, row: me.row };
    return plan;
  }
  // ---- end milestone map model ----

  // ---- milestone map page ----
  // What the view remembers, per project: the mode (the map, or every milestone as a block), the milestone picked on the map ('' = where
  // the project is), the map box's sideways scroll, the milestones whose "Which cards link it" fold is open, a milestone being moved from the
  // keyboard (`move`: { id, col, row }), the line picked on the map (`edge`: 'from>to'), whether Reset layout asks to be confirmed, and the
  // layout that is being saved (`pending`) until the server has answered.
  const msUiAll = new Map();
  function msUi() {
    let u = msUiAll.get(selKey);
    if (!u) { u = { mode: 'map', sel: '', scroll: 0, open: new Set(), move: null, edge: '', confirmReset: false, pending: null }; msUiAll.set(selKey, u); }
    return u;
  }
  const MS_SVG_NS = 'http://www.w3.org/2000/svg';
  function msSvg(tag, attrs, text) {
    const e = document.createElementNS(MS_SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, String(attrs[k])));
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const msPlural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  function msNames(map, ids) { const at = new Map(map.nodes.map((n) => [n.id, n])); return ids.map((id) => msName(at.get(id))); }
  // a line through points, its corners rounded
  function msRounded(pts, r) {
    const p = pts.filter((q, i) => !i || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
    let d = 'M' + p[0][0] + ' ' + p[0][1];
    for (let i = 1; i < p.length - 1; i++) {
      const [px, py] = p[i - 1], [x, y] = p[i], [nx, ny] = p[i + 1];
      const a = Math.hypot(x - px, y - py), b = Math.hypot(nx - x, ny - y), k = Math.min(r, a / 2, b / 2);
      d += ' L' + (x + (px - x) / a * k) + ' ' + (y + (py - y) / a * k) + ' Q' + x + ' ' + y + ' ' + (x + (nx - x) / b * k) + ' ' + (y + (ny - y) / b * k);
    }
    return d + ' L' + p[p.length - 1][0] + ' ' + p[p.length - 1][1];
  }
  // the point `f` (0 to 1) of the way along a line through points
  function msAlong(pts, f) {
    const len = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
    let left = len.reduce((s, x) => s + x, 0) * f;
    for (let i = 0; i < len.length; i++) {
      if (left <= len[i] || i === len.length - 1) { const u = len[i] ? Math.min(1, left / len[i]) : 0; return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u }; }
      left -= len[i];
    }
    return { x: pts[0][0], y: pts[0][1] };
  }

  // Pick a milestone on the map. From the keyboard the focus goes with it (the redraw alone would give it back to the old node).
  function msPickNode(id, focus) {
    const u = msUi();
    u.sel = id;
    u.edge = '';
    renderPane();
    const b = focus ? Array.prototype.find.call(elPane.querySelectorAll('.ms-node'), (x) => x.dataset.id === id) : null;
    if (b) b.focus({ preventScroll: true });
  }

  // One line per milestone: title, state, progress, waiting, what it depends on and what needs it. The node's name and the text view say the same.
  function msNodeLabel(map, n, waits) {
    const parts = [n.title + (n.dup ? ' (' + n.id + ')' : ''), MS_STATE_LABEL[n.state] || n.state, n.total ? n.done + ' of ' + n.total + ' done' : 'no cards'];
    if (waits) parts.push(waits + ' waiting');
    if (map.mode === 'deps') {
      parts.push(n.deps.length ? 'depends on ' + msNames(map, n.deps).join(', ') : 'depends on nothing');
      if (n.neededBy.length) parts.push('needed by ' + msNames(map, n.neededBy).join(', '));
      if (n.cycle) parts.push('in a cycle');
    }
    if (n.now) parts.push('ready: nothing left to wait on');
    return parts.join('; ');
  }

  // The map: an SVG of the edges (decoration, hidden from screen readers) under one button per milestone, each in a cell of the grid (the one
  // the owner saved, else the one the map picks: its layer and row, see msPlace). An edge runs from the milestone that comes first to the one
  // that waits on it. Between neighbours on one row it is a straight line; any other edge goes through the gaps between the columns and the
  // rows (never over a node), each in a lane of its own. `pl` is the placement (msPlace).
  function msMapEl(map, sel, u, pl) {
    const up = new Set(msUpstream(map, sel));
    const at = new Map(map.nodes.map((n) => [n.id, n]));
    const cellOf = (n) => pl.cells.get(n.id);
    const editable = msCanEdit();
    const mv = editable && u.move && at.has(u.move.id) ? u.move : null;
    const looseAuto = map.nodes.some((n) => n.loose && !cellOf(n).saved) && map.nodes.some((n) => !n.loose);
    const grid = msGrid(pl.R0, looseAuto);
    const cols = 1 + Math.max(0, mv ? mv.col : 0, ...map.nodes.map((n) => cellOf(n).col));
    const rows = 1 + Math.max(0, mv ? mv.row : 0, ...map.nodes.map((n) => cellOf(n).row));
    const pos = (n) => ({ x: grid.left(cellOf(n).col), y: grid.rowTop(cellOf(n).row) });
    const centre = (n) => { const p = pos(n); return { x: p.x + MS_NODE_W / 2, y: p.y + MS_R + 9 }; };
    const width = MS_PAD * 2 + (cols - 1) * MS_COL + MS_NODE_W;
    const height = grid.rowTop(rows - 1) + MS_NODE_H + 16;
    const boxes = map.nodes.map((n) => { const p = pos(n); return { x: p.x - 2, y: p.y - 2, w: MS_NODE_W + 4, h: MS_NODE_H + 4 }; });
    const pills = [];

    const box = h('div', 'ms-map-box');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', map.mode === 'deps' ? 'Milestone map: each milestone after the ones it depends on' : 'Milestone map: the milestones in number order');
    const canvas = h('div', 'ms-map');
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    const svg = msSvg('svg', { class: 'ms-edges', width, height, viewBox: '0 0 ' + width + ' ' + height, 'aria-hidden': 'true', focusable: 'false' });
    if (map.mode === 'order') {
      // number order: a dotted line between neighbours on one row (a milestone moved elsewhere has no line: the order is the numbers')
      for (let i = 1; i < map.nodes.length; i++) {
        const a = map.nodes[i - 1], b = map.nodes[i];
        if (cellOf(a).row !== cellOf(b).row || cellOf(b).col <= cellOf(a).col) continue;
        const p = centre(a), q = centre(b);
        svg.appendChild(msSvg('line', { class: 'ms-edge ms-edge-order', x1: p.x + MS_R + 4, y1: p.y, x2: q.x - MS_R - 4, y2: q.y }));
      }
    }

    // the route of each edge: a line through points, or (a link back, in a cycle) an arc over the rings
    const routes = map.edges.map((e) => {
      const sn = at.get(e.to), tn = at.get(e.from);
      const sc = cellOf(sn), tc = cellOf(tn);
      const s = centre(sn), t = centre(tn);
      let kind = 'step';
      if (t.x <= s.x) kind = 'back';
      else if (sc.row === tc.row && !map.nodes.some((o) => o !== sn && o !== tn && cellOf(o).row === sc.row && cellOf(o).col > sc.col && cellOf(o).col < tc.col)) kind = 'straight';
      else if (tc.col > sc.col + 1) kind = 'skip';
      return { e, sn, tn, sc, tc, s, t, kind, cy0: grid.gapAbove(tc.row) };
    });
    // lanes: the edges that run down a gap between two columns each get an own x there, the ones that run along the gap above a row an own y
    const lanes = new Map();
    const lane = (key, r, field) => { if (!lanes.has(key)) lanes.set(key, []); lanes.get(key).push({ r, field }); };
    routes.forEach((r) => {
      if (r.kind === 'step') lane('c' + r.sc.col, r, 'xs');
      if (r.kind === 'skip') { lane('c' + r.sc.col, r, 'xs'); lane('c' + (r.tc.col - 1), r, 'xt'); lane('r' + r.tc.row, r, 'cy'); }
      if (r.kind === 'back') {
        lane('r' + r.sc.row, r, 'cys');
        if (r.tc.row !== r.sc.row) { lane('r' + r.tc.row, r, 'cyt'); lane('c' + r.tc.col, r, 'xm'); }
      }
    });
    lanes.forEach((list, key) => {
      const vertical = key[0] === 'c';
      // a line that runs the farthest goes on the outside, so the ones that branch off earlier do not cross it
      const end = (x) => (x.field === 'xs' && x.r.kind === 'skip' ? x.r.cy0 : x.r.t.y);
      const down = (x) => end(x) > x.r.s.y;
      const side = (a, b) => (down(a) === down(b) ? 0 : down(a) ? -1 : 1);
      list.sort((a, b) => (vertical && side(a, b)) || (down(a) ? end(b) - end(a) : end(a) - end(b)) || a.r.e.from.localeCompare(b.r.e.from));
      const step = vertical ? Math.min(8, 38 / Math.max(1, list.length - 1)) : Math.min(3.5, 10 / Math.max(1, list.length - 1));
      const mid = vertical ? grid.left(Number(key.slice(1))) + MS_NODE_W + (MS_COL - MS_NODE_W) / 2 : grid.gapAbove(Number(key.slice(1)));
      list.forEach((x, k) => { x.r[x.field] = mid + (k - (list.length - 1) / 2) * step; });
    });
    const onNode = (rc) => boxes.some((b) => rc.x < b.x + b.w && b.x < rc.x + rc.w && rc.y < b.y + b.h && b.y < rc.y + rc.h);
    const onPill = (rc) => pills.some((q) => rc.x < q.x + q.w + 2 && q.x < rc.x + rc.w + 2 && rc.y < q.y + q.h + 2 && q.y < rc.y + rc.h + 2);

    routes.forEach((r) => {
      const { e, sn, tn, s, t } = r;
      const onPath = (e.from === sel || up.has(e.from)) && up.has(e.to);
      const cls = 'ms-edge' + (e.cycle ? ' ms-edge-cycle' : '') + (sn.state === 'done' ? ' ms-edge-met' : '') + (onPath ? ' ms-edge-path' : '')
        + (e.hand ? (e.links.length ? ' ms-edge-both' : ' ms-edge-hand') : '') + (u.edge === e.from + '>' + e.to ? ' ms-edge-sel' : '');
      const g = msSvg('g', { class: cls });
      const text = e.links.length ? String(e.links.length) + (e.hand ? ' + hand' : '') : 'hand';
      const w = 10 + text.length * 7;
      // a link back (the milestones wait on each other) leaves the top of the ring of the one that waits, on the right, runs through the
      // gap above the row and comes down on the top of the one it waits for, so it never lies on the line the other way
      const back = r.kind === 'back';
      const x0 = s.x + MS_R + 3, x1 = t.x - MS_R - 3;
      const top = MS_R + 3;
      const pts = back ? [[s.x, s.y - top], [s.x, r.cys], [r.xm === undefined ? t.x : r.xm, r.cys], [r.xm === undefined ? t.x : r.xm, r.cyt === undefined ? r.cys : r.cyt], [t.x, r.cyt === undefined ? r.cys : r.cyt], [t.x, t.y - top]]
        : r.kind === 'straight' ? [[x0, s.y], [x1, t.y]]
          : r.kind === 'step' ? [[x0, s.y], [r.xs, s.y], [r.xs, t.y], [x1, t.y]]
            : [[x0, s.y], [r.xs, s.y], [r.xs, r.cy], [r.xt, r.cy], [r.xt, t.y], [x1, t.y]];
      g.appendChild(msSvg('path', { d: msRounded(pts, 7) }));
      g.appendChild(msSvg('path', { class: 'ms-arrow', d: 'M' + (back ? t.x : x1) + ' ' + (back ? t.y - top : t.y) + (back ? ' l-4 -7 h8 z' : ' l-7 -4 v8 z') }));
      // a wider line nobody sees that takes the click: it selects the line, and the details say where it comes from
      g.appendChild(msSvg('path', { class: 'ms-edge-hit', d: msRounded(pts, 7) }));
      // the count sits on the line where it is clear of every node and every other count
      const spots = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85, 0.1, 0.9, 0.05, 0.95].map((f) => msAlong(pts, f));
      const rect = (q) => ({ x: q.x - w / 2, y: q.y - 9, w, h: 18 });
      const mid = spots.find((q) => !onNode(rect(q)) && !onPill(rect(q))) || spots.find((q) => !onNode(rect(q))) || spots[0];

      pills.push({ x: mid.x - w / 2, y: mid.y - 9, w, h: 18 });
      g.appendChild(msSvg('rect', { class: 'ms-count', x: mid.x - w / 2, y: mid.y - 9, width: w, height: 18, rx: 9 }));
      g.appendChild(msSvg('text', { class: 'ms-count-text', x: mid.x, y: mid.y + 4, 'text-anchor': 'middle' }, text));
      g.addEventListener('click', () => msPickEdge(e));
      svg.appendChild(g);
    });
    canvas.appendChild(svg);
    if (looseAuto) {
      const first = map.nodes.find((n) => n.loose && !cellOf(n).saved);
      const lane = h('p', 'ms-lane-label muted', 'Not linked to another milestone');
      lane.style.top = (grid.rowTop(cellOf(first).row) - 26) + 'px';
      lane.style.left = MS_PAD + 'px';
      canvas.appendChild(lane);
    }
    if (mv) {
      // where a milestone being moved from the keyboard would land
      const g = h('div', 'ms-snap');
      g.style.left = grid.left(mv.col) + 'px';
      g.style.top = grid.rowTop(mv.row) + 'px';
      canvas.appendChild(g);
    }

    const list = h('ol', 'ms-nodes');
    map.nodes.forEach((n, i) => {
      const li = h('li', 'ms-node-wrap' + (mv && mv.id === n.id ? ' is-moving' : ''));
      const p = pos(n);
      li.style.left = p.x + 'px';
      li.style.top = p.y + 'px';
      li.dataset.node = n.id;
      const b = h('button', 'ms-node ms-node-' + n.state + (n.id === sel ? ' is-sel' : '') + (up.has(n.id) ? ' on-path' : '') + (n.now ? ' is-now' : ''));
      b.type = 'button';
      b.dataset.id = n.id;
      b.tabIndex = n.id === sel ? 0 : -1;
      b.setAttribute('aria-pressed', n.id === sel ? 'true' : 'false');
      const waits = milestoneWaits(current.cards, n.id);
      b.setAttribute('aria-label', msNodeLabel(map, n, waits.length) + (mv && mv.id === n.id ? '; moving: column ' + (mv.col + 1) + ', row ' + (mv.row + 1) : ''));
      const ring = msSvg('svg', { class: 'ms-ring', width: MS_R * 2 + 8, height: MS_R * 2 + 8, viewBox: '0 0 ' + (MS_R * 2 + 8) + ' ' + (MS_R * 2 + 8), 'aria-hidden': 'true', focusable: 'false' });
      const c = MS_R + 4, r = MS_R - 2, len = 2 * Math.PI * r;
      ring.appendChild(msSvg('circle', { class: 'ms-ring-bg', cx: c, cy: c, r }));
      if (n.total && n.done) ring.appendChild(msSvg('circle', { class: 'ms-ring-fill', cx: c, cy: c, r, 'stroke-dasharray': (len * n.done / n.total).toFixed(1) + ' ' + len.toFixed(1), transform: 'rotate(-90 ' + c + ' ' + c + ')' }));
      ring.appendChild(msSvg('text', { class: 'ms-ring-text', x: c, y: c + 4, 'text-anchor': 'middle' }, n.short ? clip(n.short, 5) : '•'));
      b.appendChild(ring);
      b.appendChild(h('span', 'ms-node-title', (n.short && n.title.replace(new RegExp(MS_NUM_RE.source + '\\s*[:.\\-–—]?\\s*'), '')) || n.title));
      const meta = h('span', 'ms-node-meta tnum');
      meta.appendChild(shape(MS_STATE_SHAPE[n.state] || 's-dring'));
      meta.appendChild(h('span', null, n.total ? n.done + '/' + n.total : MS_STATE_LABEL[n.state]));
      if (waits.length) {
        const wt = h('span', 'ms-node-wait');
        waitSummary(waits).kinds.forEach((k) => { const sh = shape(WAIT_SPEC[k].shape); sh.dataset.wk = k; wt.appendChild(sh); });
        wt.appendChild(h('span', null, String(waits.length)));
        meta.appendChild(wt);
      }
      b.appendChild(meta);
      if (n.now) b.appendChild(h('span', 'ms-node-flag', 'Now'));
      else if (n.state !== 'done' && n.waitingOn.length) b.appendChild(h('span', 'ms-node-flag ms-node-flag-wait', 'After ' + msNames(map, n.waitingOn).join(', ')));
      b.addEventListener('click', (e) => msNodeClick(e, n.id));
      b.addEventListener('keydown', (e) => {
        const k = e.key;
        if (editable && u.move && u.move.id === n.id) { msMoveKey(e, n.id); return; }
        if (editable && (k === 'm' || k === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); msStartMove(n.id); return; }
        const to = k === 'ArrowRight' || k === 'ArrowDown' ? i + 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? i - 1 : k === 'Home' ? 0 : k === 'End' ? map.nodes.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        const next = map.nodes[Math.max(0, Math.min(map.nodes.length - 1, to))];
        if (next && next.id !== sel) msPickNode(next.id, true);
      });
      li.appendChild(b);
      if (editable) {
        // the dot on the right of the ring: dragged onto another milestone it makes that one depend on this one (pointer only; the keyboard has the details)
        const hd = h('span', 'ms-handle');
        hd.setAttribute('aria-hidden', 'true');
        hd.title = 'Drag onto the milestone that waits for ' + n.label + ' to link them';
        hd.addEventListener('pointerdown', (e) => msHandleDown(e, n.id));
        li.appendChild(hd);
        b.addEventListener('pointerdown', (e) => msNodeDown(e, n.id));
      }
      list.appendChild(li);
    });
    canvas.appendChild(list);
    box.appendChild(canvas);
    box.addEventListener('scroll', () => { u.scroll = box.scrollLeft; });
    // what the pointer handlers (milestones-drag.js) work on: this drawing's grid and cells
    msView = { box, canvas, grid, cells: pl.cells, map, key: selKey, width, height };
    return box;
  }
  // On paper the map is scaled down to the page's width instead of being cut off.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeprint', () => { document.querySelectorAll('.ms-map').forEach((c) => { const w = parseFloat(c.style.width) || 0; if (w > 680) c.style.zoom = String(680 / w); }); });
    window.addEventListener('afterprint', () => { document.querySelectorAll('.ms-map').forEach((c) => { c.style.zoom = ''; }); });
  }

  // The key under the map: what each mark means, so the shapes and lines never rely on colour.
  function msLegend(map) {
    const lg = h('div', 'ms-legend muted');
    [['s-circle', 'Done'], ['s-ring', 'Open'], ['s-dring', 'Empty']].forEach(([s, t]) => { const x = h('span', 'ms-legend-item'); x.append(shape(s), h('span', null, t)); lg.appendChild(x); });
    const line = (cls, text) => { const x = h('span', 'ms-legend-item'); const l = h('span', 'ms-legend-line ' + cls); l.setAttribute('aria-hidden', 'true'); x.append(l, h('span', null, text)); lg.appendChild(x); };
    if (map.mode === 'deps') {
      line('ms-line-dep', 'depends on: the arrow points at the milestone that waits; the number is how many card links make it');
      if (map.edges.some((e) => e.cycle)) line('ms-line-cycle', 'dashed: part of a cycle');
      if (map.edges.some((e) => e.hand)) line('ms-line-hand', 'dotted, "hand": a link you drew; "+ hand" after a number: you drew it too');
    } else line('ms-line-order', 'number order only: no card in one milestone is blocked by a card in another');
    return lg;
  }
  // What the owner can do on the map, said once under the key (not on a phone through the tunnel, where nothing can be changed).
  function msHint() {
    return h('p', 'ms-hint muted', 'Drag a milestone to put it in another cell (on a cell that is taken the two swap); the layout is saved on this computer. '
      + 'Drag the dot on its right onto the milestone that waits for it to link the two, or use Add dependency below. With a milestone picked, M moves it with the arrow keys. '
      + 'A link you draw is a picture of the plan: it holds up no card.');
  }

  // "Depends on", "Needed by", what is left before it, and which card links make each dependency: the same facts as the lines, in text, and
  // what can be changed (remove a link you drew, add one, move the milestone).
  function msRelations(map, n, u) {
    const at = new Map(map.nodes.map((x) => [x.id, x]));
    const editable = msCanEdit();
    const box = h('div', 'ms-rel');
    const pickBtn = (id, extra) => {
      const b = plainBtn(msName(at.get(id)) + (extra || ''), 'small ghost ms-rel-btn', () => { msEndMove(); u.sel = id; u.mode = 'map'; u.edge = ''; renderPane(); });
      b.title = at.get(id).title;
      return b;
    };
    const rmBtn = (from, to) => {
      const text = msName(at.get(from)) + ' depends on ' + msName(at.get(to));
      const b = plainBtn('Remove', 'small ghost ms-rel-rm', () => msRemoveLink(from, to));
      b.setAttribute('aria-label', 'Remove the link you drew: ' + text);
      b.title = 'Remove the link you drew: ' + text;
      return b;
    };
    const row = (label, ids, extra, tail) => {
      const p = h('p', 'ms-rel-row');
      p.appendChild(h('span', 'ms-rel-k', label));
      if (!ids.length) p.appendChild(h('span', 'muted', 'nothing'));
      ids.forEach((id) => {
        p.appendChild(pickBtn(id, extra ? extra(id) : ''));
        const t = tail ? tail(id) : null;
        if (t) p.appendChild(t);
      });
      box.appendChild(p);
    };
    if (map.mode === 'order') {
      const i = map.nodes.indexOf(n);
      box.appendChild(h('p', 'ms-rel-row muted', (i > 0 ? 'Comes after ' + msName(map.nodes[i - 1]) + ' in number order' : 'First in number order') + '. No card links it to another milestone.'));
      if (editable) box.appendChild(msEditor(map, n, u));
      return box;
    }
    const edgeOf = (from, to) => map.edges.find((e) => e.from === from && e.to === to) || { links: [] };
    const how = (from, to) => { const e = edgeOf(from, to); const k = e.links.length; return (k ? msPlural(k, 'link', 'links') : '') + (e.hand ? (k ? ' + ' : '') + 'drawn by hand' : ''); };
    const handOf = (from, to) => !!edgeOf(from, to).hand;
    row('Depends on', n.deps, (d) => ' · ' + how(n.id, d) + (at.get(d).state === 'done' ? ' · done' : ''), (d) => (editable && handOf(n.id, d) ? rmBtn(n.id, d) : null));
    row('Needed by', n.neededBy, (w) => (handOf(w, n.id) ? ' · ' + how(w, n.id) : ''), (w) => (editable && handOf(w, n.id) ? rmBtn(w, n.id) : null));
    // the line that was clicked on the map: where it comes from, and whether it can be removed here
    const picked = u.edge ? map.edges.find((e) => e.from + '>' + e.to === u.edge && (e.from === n.id || e.to === n.id)) : null;
    if (picked) {
      const p = h('p', 'ms-rel-row ms-rel-edge');
      p.appendChild(h('span', 'ms-rel-k', 'Selected line'));
      const cardsText = picked.links.slice(0, 4).map((l) => l.card + ' → ' + l.by).join(', ') + (picked.links.length > 4 ? ' and ' + (picked.links.length - 4) + ' more' : '');
      p.appendChild(h('span', null, msName(at.get(picked.from)) + ' depends on ' + msName(at.get(picked.to)) + '. '
        + (picked.links.length ? 'It comes from cards ' + cardsText + (picked.hand ? ', and you drew it by hand too' : '') + '.' : 'You drew it by hand.')));
      if (picked.links.length && !picked.hand) p.appendChild(h('span', 'muted', ' Edit those cards to change it.'));
      if (editable && picked.hand) p.appendChild(rmBtn(picked.from, picked.to));
      box.appendChild(p);
    }
    const up = msUpstream(map, n.id).filter((id) => at.get(id).state !== 'done');
    const left = up.reduce((s, id) => s + at.get(id).total - at.get(id).done, 0) + n.total - n.done;
    box.appendChild(h('p', 'ms-rel-row ms-rel-far', n.state === 'done' ? 'Done.'
      : up.length ? 'To reach it: ' + msNames(map, up).join(', ') + ' still to finish first; ' + msPlural(left, 'open card', 'open cards') + ' in all, its own included.'
        : 'Nothing before it is left: ' + msPlural(left, 'open card', 'open cards') + ' to go.'));
    const said = new Set();
    map.edges.filter((e) => e.cycle && (e.from === n.id || e.to === n.id)).forEach((e) => {
      const a = at.get(e.from), b = at.get(e.to);
      const mutual = map.edges.some((x) => x.from === e.to && x.to === e.from);
      const text = mutual ? 'Cycle: ' + msName(a.id < b.id ? a : b) + ' and ' + msName(a.id < b.id ? b : a) + ' depend on each other.'
        : 'Cycle: ' + msName(a) + ' depends on ' + msName(b) + ', and ' + msName(b) + ' depends, through other milestones, on ' + msName(a) + '.';
      if (!said.has(text)) { said.add(text); box.appendChild(h('p', 'ms-rel-row ms-rel-cycle', text)); }
    });
    const mine = map.edges.filter((e) => (e.from === n.id || e.to === n.id) && e.links.length);
    if (mine.length) {
      const det = h('details', 'ms-why');
      det.open = u.open.has(n.id);
      det.addEventListener('toggle', () => { if (det.open) u.open.add(n.id); else u.open.delete(n.id); });
      det.appendChild(h('summary', null, 'Which cards link it (' + mine.reduce((s, e) => s + e.links.length, 0) + ')'));
      const ul = h('ul', 'ms-why-list');
      const byId = new Map(current.cards.map((c) => [c.id, c]));
      const cardLink = (id) => {
        const c = byId.get(id);
        const a = h('a', 'ms-why-card');
        a.href = hashFor(selKey, id);
        bindCardLink(a, id);
        a.append(h('span', 'idchip', id), h('span', 'ms-why-text', c ? c.title : id));
        if (c && c.kind !== 'milestone' && finishedIn(c, cfg())) a.appendChild(h('span', 'muted ms-why-done', 'done'));
        return a;
      };
      mine.forEach((e) => e.links.forEach((l) => {
        const li = h('li');
        li.append(h('span', 'ms-why-ms', msName(at.get(e.from))), cardLink(l.card), h('span', 'muted ms-why-k', 'is blocked by'), h('span', 'ms-why-ms', msName(at.get(e.to))), cardLink(l.by));
        ul.appendChild(li);
      }));
      det.appendChild(ul);
      box.appendChild(det);
    }
    if (editable) box.appendChild(msEditor(map, n, u));
    return box;
  }

  // The controls under a milestone's details that do what the pointer does on the map: Add dependency (a select and a button), and Move
  // (a button that starts the keyboard's move mode, with arrow buttons while it runs).
  function msEditor(map, n, u) {
    const at = new Map(map.nodes.map((x) => [x.id, x]));
    const box = h('div', 'ms-edit');
    const form = h('div', 'ms-add');
    const lab = h('label', 'ms-edit-k', 'Add dependency');
    lab.setAttribute('for', 'ms-add-sel');
    const pick = h('select', 'ms-add-sel');
    pick.id = 'ms-add-sel';
    const none = h('option', null, 'Choose a milestone');
    none.value = '';
    pick.appendChild(none);
    map.nodes.filter((x) => x.id !== n.id && !n.byHand.includes(x.id)).forEach((x) => {
      const o = h('option', null, clip(x.title, 40) + (x.dup ? ' (' + x.id + ')' : ''));
      o.value = x.id;
      pick.appendChild(o);
    });
    const add = plainBtn('Add', 'small', () => { if (pick.value) msAddLink(n.id, pick.value); });
    add.disabled = true;
    pick.addEventListener('change', () => { add.disabled = !pick.value; });
    form.append(lab, pick, add);
    box.appendChild(form);
    box.appendChild(h('p', 'ms-edit-hint muted', msName(n) + ' will depend on the milestone you pick: the arrow points at ' + msName(n) + '. It holds up no card.'));
    const mv = u.move && u.move.id === n.id ? u.move : null;
    const move = h('div', 'ms-move');
    if (!mv) {
      const b = plainBtn('Move', 'small ghost', () => msStartMove(n.id));
      b.title = 'Move it to another cell of the map with the arrow keys or the buttons (the M key does the same on the map)';
      move.appendChild(b);
    } else {
      move.appendChild(h('span', 'ms-edit-k', 'Moving to column ' + (mv.col + 1) + ', row ' + (mv.row + 1)));
      const pad = h('span', 'ms-pad');
      pad.setAttribute('role', 'group');
      pad.setAttribute('aria-label', 'Move ' + msName(n));
      [['←', 'Move left', -1, 0], ['↑', 'Move up', 0, -1], ['↓', 'Move down', 0, 1], ['→', 'Move right', 1, 0]].forEach(([t, name, dc, dr]) => {
        const b = plainBtn(t, 'small ghost ms-pad-btn', () => msMoveBy(dc, dr));
        b.setAttribute('aria-label', name);
        pad.appendChild(b);
      });
      move.appendChild(pad);
      move.appendChild(plainBtn('Drop here', 'small', () => msDrop()));
      move.appendChild(plainBtn('Cancel', 'small ghost', () => msCancelMove()));
    }
    box.appendChild(move);
    return box;
  }

  // The plain data the map draws, for the pane key: the edges with their card links and the titles they show.
  function msMapSig(map) {
    const byId = new Map(current.cards.map((c) => [c.id, c]));
    const title = (id) => { const c = byId.get(id); return c ? [c.title, c.kind === 'milestone' ? '' : String(finishedIn(c, cfg()))] : null; };
    return map.edges.map((e) => [e.from, e.to, !!e.cycle, ...(e.hand ? [true] : []), e.links.map((l) => [l.card, l.by, title(l.card), title(l.by)])]);
  }

  // The picked milestone's block is in a polite live region that stays the same element from one drawing to the next, so a screen
  // reader hears it change when the pick moves.
  let msLive = null;
  function renderMsMap(wrap, map, list, u) {
    const sel = msMapPick(map, u.sel);
    const n = map.nodes.find((x) => x.id === sel);
    const pl = msPlace(map, msLayout());
    const box = msMapEl(map, sel, u, pl);
    wrap.appendChild(box);
    wrap.appendChild(msLegend(map));
    if (msCanEdit()) wrap.appendChild(msHint());
    wrap.appendChild(msNote());
    if (!msLive) { msLive = h('div', 'ms-live'); msLive.setAttribute('aria-live', 'polite'); msLive.setAttribute('aria-atomic', 'true'); }
    wrap.appendChild(msLive);
    msLive.replaceChildren();
    if (n) msLive.appendChild(msItem(list.find((x) => x.id === sel), cfg(), 'div', 'ms-detail', msRelations(map, n, u)));
    // run once the pane holds it and has a width: the old sideways scroll, moved just enough to show the picked milestone (or the cell it is being moved to)
    return () => {
      if (!n) return;
      const cell = u.move && u.move.id === n.id ? u.move : pl.cells.get(n.id);
      const x = MS_PAD + cell.col * MS_COL;
      let left = u.scroll;
      if (x < left) left = x - MS_PAD;
      else if (x + MS_NODE_W > left + box.clientWidth) left = x + MS_NODE_W + MS_PAD - box.clientWidth;
      box.scrollLeft = Math.max(0, left);
    };
  }
  // ---- end milestone map page ----
