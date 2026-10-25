// Shared whiteboard: everyone in the meeting sees the same board and, if the host allows it, draws on it.
// Built from scratch on a <canvas> and LiveKit data messages (topic sanwes.wb). The board has a fixed virtual size
// (1600 x 900); every object is stored in those units, so people with different window sizes see the same picture.
const TOPIC = 'sanwes.wb';
const W = 1600, H = 900;
const COLORS = ['#1d2530', '#e5484d', '#f59e0b', '#2ea043', '#0e72ed', '#8e4ec6'];
const SIZES = [3, 6, 12];
const SHAPES = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']];
const MAX_OBJECTS = 600, MAX_POINTS = 1500, MAX_TEXT = 200;
const enc = new TextEncoder(), dec = new TextDecoder();
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : lo);
const color = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v : '#1d2530');

// Anything that comes over the network is rebuilt field by field, so a hostile client cannot add odd properties or huge data.
function cleanObject(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || o.id.length > 16) return null;
  const base = { id: o.id, t: o.t, c: color(o.c), w: num(o.w, 1, 40) };
  if (o.t === 'pen') {
    const pts = Array.isArray(o.pts) ? o.pts.slice(0, MAX_POINTS * 2).map((n) => num(n, 0, 2000)) : [];
    return { ...base, a: o.a === 0.35 ? 0.35 : 1, pts: pts.length % 2 ? pts.slice(0, -1) : pts };
  }
  if (['rect', 'ellipse', 'line', 'arrow'].includes(o.t)) return { ...base, x1: num(o.x1, 0, W), y1: num(o.y1, 0, H), x2: num(o.x2, 0, W), y2: num(o.y2, 0, H) };
  if (o.t === 'text' || o.t === 'note') return { ...base, x: num(o.x, 0, W), y: num(o.y, 0, H), s: String(o.s ?? '').slice(0, MAX_TEXT) };
  return null;
}

export function initWhiteboard({ $, getRoom, getSession, toast, isManager, allowedToDraw }) {
  const root = $('wb'), canvas = $('wb-canvas'), ctx = canvas.getContext('2d');
  let objects = [], owner = null, open = false, tool = 'pen', shape = 'rect', col = COLORS[0], size = 1, drawing = null;
  let view = { s: 1, ox: 0, oy: 0 }, undoStack = [], redoStack = [], pan = null, liveTimer = 0, sentPts = 0, dirty = true;
  const remoteLive = new Map(); // id -> partial object from someone else's stroke in progress

  const room = () => getRoom();
  const me = () => room()?.localParticipant;
  const canDraw = () => open && allowedToDraw();

  // ---------------------------------------------------------------- sending
  async function send(msg, { to, reliable = true } = {}) {
    const r = room(); if (!r || !me()) return;
    try { await me().publishData(enc.encode(JSON.stringify(msg)), { topic: TOPIC, reliable, ...(to ? { destinationIdentities: to } : {}) }); } catch { /* best effort */ }
  }
  function sendSync(to) { // the whole board, in packets small enough for a reliable data message
    const chunks = []; let cur = [], len = 0;
    for (const o of objects) { const n = JSON.stringify(o).length; if (len + n > 9000 && cur.length) { chunks.push(cur); cur = []; len = 0; } cur.push(o); len += n; }
    chunks.push(cur);
    chunks.forEach((c, i) => send({ k: 'sync', owner, first: i === 0, objs: c }, { to: [to] }));
  }

  // ---------------------------------------------------------------- receiving
  function onData(payload, participant) {
    let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
    if (!m || typeof m.k !== 'string' || !participant) return;
    const fromMgr = (() => { try { return ['host', 'cohost'].includes(JSON.parse(participant.metadata || '{}').role); } catch { return false; } })();
    const mayDraw = fromMgr || (getSession()?.meta?.wbWho ?? 'all') === 'all';
    switch (m.k) {
      case 'open': // someone started a whiteboard: everyone follows it
        if (!open) { reset(); owner = participant.identity; show(true); }
        break;
      case 'sync': {
        if (!open) { owner = participant.identity; show(true); }
        if (m.first) objects = [];
        for (const o of (Array.isArray(m.objs) ? m.objs : []).slice(0, MAX_OBJECTS)) { const c = cleanObject(o); if (c) objects.push(c); }
        dirty = true; break;
      }
      case 'close': if (open && (participant.identity === owner || fromMgr)) { show(false); reset(); toast(`${participant.name || participant.identity} stopped the whiteboard.`, 'info'); } break;
      case 'seg': if (open && mayDraw) { // a piece of someone's stroke while they are still drawing
        const c = cleanObject({ id: m.id, t: 'pen', c: m.c, w: m.w, a: m.a, pts: [] }); if (!c) break;
        const cur = remoteLive.get(m.id) ?? c; cur.pts.push(...(Array.isArray(m.pts) ? m.pts.slice(0, 200).map((n) => num(n, 0, 2000)) : []));
        if (cur.pts.length <= MAX_POINTS * 2) remoteLive.set(m.id, cur); dirty = true;
      } break;
      case 'add': if (open && mayDraw) { const c = cleanObject(m.o); if (c && objects.length < MAX_OBJECTS) { remoteLive.delete(c.id); objects = objects.filter((x) => x.id !== c.id); objects.push(c); dirty = true; } } break;
      case 'del': if (open && mayDraw) { objects = objects.filter((x) => x.id !== m.id); dirty = true; } break;
      case 'clear': if (open && mayDraw) { objects = []; remoteLive.clear(); dirty = true; } break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- drawing the board
  const toBoard = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left - view.ox) / view.s, (e.clientY - r.top - view.oy) / view.s]; };
  function fit() {
    const r = canvas.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const cw = Math.max(200, r.width), ch = Math.max(200, r.height);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); canvas.style.width = `${cw}px`; canvas.style.height = `${ch}px`;
    const s = Math.min(cw / W, ch / H);
    view = { s, ox: (cw - W * s) / 2, oy: (ch - H * s) / 2 };
    dirty = true;
  }
  function paintObject(g, o) {
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = o.c; g.fillStyle = o.c; g.lineWidth = o.w; g.globalAlpha = o.a ?? 1;
    if (o.t === 'pen') {
      if (o.pts.length === 2) { g.beginPath(); g.arc(o.pts[0], o.pts[1], o.w / 2, 0, Math.PI * 2); g.fill(); }
      else if (o.pts.length > 2) { g.beginPath(); g.moveTo(o.pts[0], o.pts[1]); for (let i = 2; i < o.pts.length; i += 2) g.lineTo(o.pts[i], o.pts[i + 1]); g.stroke(); }
    } else if (o.t === 'rect') g.strokeRect(Math.min(o.x1, o.x2), Math.min(o.y1, o.y2), Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1));
    else if (o.t === 'ellipse') { g.beginPath(); g.ellipse((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1) / 2 || 1, Math.abs(o.y2 - o.y1) / 2 || 1, 0, 0, Math.PI * 2); g.stroke(); }
    else if (o.t === 'line' || o.t === 'arrow') {
      g.beginPath(); g.moveTo(o.x1, o.y1); g.lineTo(o.x2, o.y2); g.stroke();
      if (o.t === 'arrow') { const a = Math.atan2(o.y2 - o.y1, o.x2 - o.x1), L = 14 + o.w * 2; g.beginPath(); g.moveTo(o.x2, o.y2); g.lineTo(o.x2 - L * Math.cos(a - 0.45), o.y2 - L * Math.sin(a - 0.45)); g.moveTo(o.x2, o.y2); g.lineTo(o.x2 - L * Math.cos(a + 0.45), o.y2 - L * Math.sin(a + 0.45)); g.stroke(); }
    } else if (o.t === 'text') { g.font = `${18 + o.w * 3}px system-ui, sans-serif`; g.textBaseline = 'top'; o.s.split('\n').forEach((ln, i) => g.fillText(ln, o.x, o.y + i * (22 + o.w * 3))); }
    else if (o.t === 'note') {
      g.fillStyle = '#fde68a'; g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 8; g.fillRect(o.x, o.y, 220, 160); g.shadowBlur = 0;
      g.fillStyle = '#1d2530'; g.font = '18px system-ui, sans-serif'; g.textBaseline = 'top';
      const words = o.s.split(/\s+/); let line = '', y = o.y + 12;
      for (const w of words) { const test = line ? `${line} ${w}` : w; if (g.measureText(test).width > 196 && line) { g.fillText(line, o.x + 12, y); y += 24; line = w; } else line = test; if (y > o.y + 130) break; }
      g.fillText(line, o.x + 12, y);
    }
    g.restore();
  }
  function render() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    for (const o of objects) paintObject(ctx, o);
    for (const o of remoteLive.values()) paintObject(ctx, o);
    if (drawing) paintObject(ctx, drawing);
    ctx.restore();
  }
  (function loop() { if (open && dirty) { dirty = false; render(); } requestAnimationFrame(loop); })();
  new ResizeObserver(() => { if (open && !root.classList.contains('behind')) fit(); }).observe(canvas.parentElement);

  // ---------------------------------------------------------------- tools
  const eraseAt = (x, y) => {
    const hit = (o) => {
      const r = 14 / view.s + o.w;
      if (o.t === 'pen') { for (let i = 0; i < o.pts.length; i += 2) if (Math.hypot(o.pts[i] - x, o.pts[i + 1] - y) < r) return true; return false; }
      if (o.t === 'text' || o.t === 'note') return x > o.x - 6 && x < o.x + (o.t === 'note' ? 220 : 12 * Math.max(...o.s.split('\n').map((l) => l.length), 1)) && y > o.y - 6 && y < o.y + (o.t === 'note' ? 160 : 30 * o.s.split('\n').length);
      const x0 = Math.min(o.x1, o.x2) - r, x1 = Math.max(o.x1, o.x2) + r, y0 = Math.min(o.y1, o.y2) - r, y1 = Math.max(o.y1, o.y2) + r;
      if (!(x > x0 && x < x1 && y > y0 && y < y1)) return false;
      if (o.t === 'rect' || o.t === 'ellipse') { const inner = x > x0 + 2 * r && x < x1 - 2 * r && y > y0 + 2 * r && y < y1 - 2 * r; return !inner; }
      const dx = o.x2 - o.x1, dy = o.y2 - o.y1, len = Math.hypot(dx, dy) || 1;
      return Math.abs(dy * (x - o.x1) - dx * (y - o.y1)) / len < r;
    };
    const target = [...objects].reverse().find(hit);
    if (target) { objects = objects.filter((o) => o !== target); undoStack.push({ del: target }); redoStack = []; send({ k: 'del', id: target.id }); dirty = true; }
  };
  function add(o) {
    if (objects.length >= MAX_OBJECTS) { toast('The board is full. Clear it to keep drawing.'); return; }
    objects.push(o); undoStack.push({ add: o }); redoStack = []; dirty = true; send({ k: 'add', o });
  }
  function askText(x, y, note) {
    const s = window.prompt(note ? 'Sticky note:' : 'Text:', '');
    if (s && s.trim()) add({ id: uid(), t: note ? 'note' : 'text', c: col, w: SIZES[size] / 3, x, y, s: s.trim().slice(0, MAX_TEXT) });
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!open) return;
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'hand' || e.button === 1) { pan = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy }; return; }
    if (!canDraw()) { toast('The host has limited who can draw on the whiteboard.', 'info'); return; }
    const [x, y] = toBoard(e);
    if (tool === 'eraser') { drawing = { erasing: true }; eraseAt(x, y); return; }
    if (tool === 'text' || tool === 'note') { askText(x, y, tool === 'note'); return; }
    if (tool === 'pen' || tool === 'highlighter') { drawing = { id: uid(), t: 'pen', c: col, w: tool === 'highlighter' ? SIZES[size] * 3 : SIZES[size], a: tool === 'highlighter' ? 0.35 : 1, pts: [x, y] }; sentPts = 0; startLive(); }
    else drawing = { id: uid(), t: shape, c: col, w: SIZES[size], x1: x, y1: y, x2: x, y2: y };
    dirty = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pan) { view.ox = pan.ox + (e.clientX - pan.x); view.oy = pan.oy + (e.clientY - pan.y); dirty = true; return; }
    if (!drawing) return;
    const [x, y] = toBoard(e);
    if (drawing.erasing) { eraseAt(x, y); return; }
    if (drawing.t === 'pen') { const n = drawing.pts.length; if (n < MAX_POINTS * 2 && Math.hypot(x - drawing.pts[n - 2], y - drawing.pts[n - 1]) > 1.5) drawing.pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10); }
    else { drawing.x2 = x; drawing.y2 = y; }
    dirty = true;
  });
  const endStroke = () => {
    pan = null; clearInterval(liveTimer);
    if (!drawing || drawing.erasing) { drawing = null; return; }
    const o = drawing; drawing = null;
    const tiny = o.t === 'pen' ? false : Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 3;
    if (!tiny) add(o); else dirty = true;
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  function startLive() { // while a stroke is in progress, send the new points a few times a second so others see it grow
    clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!drawing || drawing.t !== 'pen') return;
      const pts = drawing.pts.slice(Math.max(0, sentPts - 2)); // overlap one point so the pieces join
      if (pts.length > 2) { sentPts = drawing.pts.length; send({ k: 'seg', id: drawing.id, c: drawing.c, w: drawing.w, a: drawing.a, pts: pts.slice(0, 200) }, { reliable: false }); }
    }, 90);
  }
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e); }, { passive: false });
  function zoomBy(f, e) {
    const r = canvas.getBoundingClientRect(), cx = e ? e.clientX - r.left : r.width / 2, cy = e ? e.clientY - r.top : r.height / 2;
    const s = clamp(view.s * f, 0.25, 4), k = s / view.s;
    view = { s, ox: cx - (cx - view.ox) * k, oy: cy - (cy - view.oy) * k }; dirty = true; paintZoom();
  }
  const paintZoom = () => { const base = Math.min(canvas.clientWidth / W, canvas.clientHeight / H) || 1; $('wb-zoom').textContent = `${Math.round((view.s / base) * 100)}%`; };

  // ---------------------------------------------------------------- toolbar
  function undo() {
    const a = undoStack.pop(); if (!a) return;
    if (a.add) { objects = objects.filter((o) => o.id !== a.add.id); send({ k: 'del', id: a.add.id }); redoStack.push(a); }
    else if (a.del) { objects.push(a.del); send({ k: 'add', o: a.del }); redoStack.push(a); }
    dirty = true;
  }
  function redo() {
    const a = redoStack.pop(); if (!a) return;
    if (a.add) { objects.push(a.add); send({ k: 'add', o: a.add }); undoStack.push(a); }
    else if (a.del) { objects = objects.filter((o) => o.id !== a.del.id); send({ k: 'del', id: a.del.id }); undoStack.push(a); }
    dirty = true;
  }
  function paintTools() {
    for (const b of root.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    for (const b of root.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', String(b.dataset.color === col));
    for (const b of root.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === size));
    $('wb-shape-label').textContent = SHAPES.find(([k]) => k === shape)[1];
    canvas.style.cursor = tool === 'hand' ? 'grab' : tool === 'text' || tool === 'note' ? 'text' : 'crosshair';
  }
  for (const b of root.querySelectorAll('[data-tool]')) b.onclick = () => { tool = b.dataset.tool; if (tool === 'shape') { /* handled below */ } paintTools(); };
  for (const b of root.querySelectorAll('[data-color]')) b.onclick = () => { col = b.dataset.color; paintTools(); };
  for (const b of root.querySelectorAll('[data-size]')) b.onclick = () => { size = Number(b.dataset.size); paintTools(); };
  $('wb-shape-next').onclick = () => { const i = SHAPES.findIndex(([k]) => k === shape); shape = SHAPES[(i + 1) % SHAPES.length][0]; tool = 'shape'; paintTools(); };
  $('wb-undo').onclick = undo; $('wb-redo').onclick = redo;
  $('wb-zoom-in').onclick = () => zoomBy(1.2); $('wb-zoom-out').onclick = () => zoomBy(1 / 1.2);
  $('wb-clear').onclick = () => { if (!canDraw() || !objects.length) return; if (confirm('Clear the whole whiteboard for everyone?')) { objects = []; undoStack = []; redoStack = []; remoteLive.clear(); send({ k: 'clear' }); dirty = true; } };
  $('wb-save').onclick = () => {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); for (const o of objects) paintObject(g, o);
    c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `whiteboard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); });
  };
  $('wb-tab-meeting').onclick = () => { root.classList.add('behind'); paintTabs(); };
  $('wb-tab-board').onclick = () => { root.classList.remove('behind'); paintTabs(); fit(); };
  $('wb-stop').onclick = () => { // the one who started it (or a host) ends it for everyone
    if (owner === me()?.identity || isManager()) { send({ k: 'close' }); toast('Whiteboard stopped. Use Save to keep a picture of it next time.', 'info'); }
    show(false); reset();
  };
  $('wb-close-tab').onclick = $('wb-stop').onclick;
  function paintTabs() {
    const onBoard = !root.classList.contains('behind');
    $('wb-tab-board').setAttribute('aria-selected', String(onBoard)); $('wb-tab-meeting').setAttribute('aria-selected', String(!onBoard));
  }

  // ---------------------------------------------------------------- open / close
  function show(on) {
    open = on; root.hidden = !on; root.classList.remove('behind'); paintTabs();
    document.body.classList.toggle('wb-open', on);
    if (on) { fit(); paintTools(); paintZoom(); }
  }
  function reset() { objects = []; undoStack = []; redoStack = []; remoteLive.clear(); drawing = null; owner = null; clearInterval(liveTimer); dirty = true; }

  return {
    onData,
    get isOpen() { return open; },
    get canvas() { return open && !root.classList.contains('behind') ? canvas : null; },
    newBoard() {
      if (open) { root.classList.remove('behind'); paintTabs(); return; }
      reset(); owner = me()?.identity ?? null; show(true); send({ k: 'open' });
      toast('Whiteboard started. Everyone in the meeting can see it.', 'info');
    },
    onParticipantConnected(p) { if (open && owner === me()?.identity) { send({ k: 'open' }, { to: [p.identity] }); setTimeout(() => sendSync(p.identity), 400); } },
    close() { show(false); reset(); },
    canDraw,
  };
}
