// An on-screen game controller for phones and tablets (Game Hub). Laid out like a console pad: L2/L1 and R2/R1 on top, a d-pad and a
// thumbstick on the left, the four face buttons and a thumbstick on the right, L3/R3 in the corners, small buttons in the middle.
// It makes the same numbers as a real gamepad read through the browser (Xbox 360 layout), so the rest of Game Hub does not care where they come from:
//   state() -> [buttons, leftTrigger 0..255, rightTrigger 0..255, leftX, leftY, rightX, rightY]  (sticks -32768..32767, up is positive)
// Every finger is tracked on its own (pointer events), so a stick, a face button and a shoulder button can be held at the same time.
//
// Sizes: the whole pad is drawn on a 16:9 board and every size is a multiple of --u (one hundredth of the board's height).
//   landscape: the board is the whole screen (--u = 1vh), portrait: the board is the bottom part of the screen (--u = 0.5625vw) and the picture sits above it.
// Ideas taken from the open-source touch pads kw-m/virtual-gamepad-lib, GDur/gamepad and nipplejs (all MIT): multi-touch, the standard gamepad
// mapping, big hit areas. No code was copied; there is no dependency.
const XBTN = { A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000, LB: 0x0100, RB: 0x0200, BACK: 0x0020, START: 0x0010, L3: 0x0040, R3: 0x0080, UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008 };
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const U = (n) => `calc(${n} * var(--u))`; // n board units
const stroke = (c, w = 3.2) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const SVG = {
  triangle: `<svg viewBox="0 0 40 40"><path d="M20 7 L34 31 H6 Z" ${stroke('#2ed3b7')}/></svg>`,
  circle: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="12.5" ${stroke('#ff4d4d')}/></svg>`,
  square: `<svg viewBox="0 0 40 40"><rect x="8" y="8" width="24" height="24" rx="2" ${stroke('#f06bd0')}/></svg>`,
  cross: `<svg viewBox="0 0 40 40"><path d="M9 9 L31 31 M31 9 L9 31" ${stroke('#3b9bff', 3.6)}/></svg>`,
  up: `<svg viewBox="0 0 24 24"><path d="M6 15 L12 9 L18 15" ${stroke('#dfe3ea', 2.4)}/></svg>`,
  down: `<svg viewBox="0 0 24 24"><path d="M6 9 L12 15 L18 9" ${stroke('#dfe3ea', 2.4)}/></svg>`,
  left: `<svg viewBox="0 0 24 24"><path d="M15 6 L9 12 L15 18" ${stroke('#dfe3ea', 2.4)}/></svg>`,
  right: `<svg viewBox="0 0 24 24"><path d="M9 6 L15 12 L9 18" ${stroke('#dfe3ea', 2.4)}/></svg>`,
  screen: '<svg viewBox="0 0 32 32"><rect x="5" y="6" width="16" height="12" rx="2" fill="none" stroke="#fff" stroke-width="2.2"/><rect x="11" y="13" width="16" height="12" rx="2" fill="#111" stroke="#fff" stroke-width="2.2"/></svg>',
  pad: '<svg viewBox="0 0 32 32"><path d="M9 10h14a5 5 0 0 1 5 5v4a4 4 0 0 1-7 2.6L19 19h-6l-2 2.6A4 4 0 0 1 4 19v-4a5 5 0 0 1 5-5z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M10 13v4M8 15h4M21 14.5v.01M23.5 16.5v.01" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 32 32"><path d="M7 10h18M7 16h18M7 22h18" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>',
  stop: '<svg viewBox="0 0 32 32"><rect x="9" y="9" width="14" height="14" rx="2.5" fill="#fff"/></svg>',
};

export function createTouchPad({ onChange, onStop, getStats }) {
  const st = { bits: 0, lt: 0, rt: 0, ls: [0, 0], rs: [0, 0] };
  const held = new Map();                    // pointerId -> release function
  const pref = { haptics: true, opacity: 0.85, ...(() => { try { return JSON.parse(localStorage.getItem('sanwes.tp') || '{}'); } catch { return {}; } })() };
  const save = () => { try { localStorage.setItem('sanwes.tp', JSON.stringify(pref)); } catch { /* storage blocked */ } };
  let root = null, menu = null, waitCard = null, shown = false, hidden = false, last = '', weEnteredFullscreen = false;

  const changed = () => { const s = JSON.stringify([st.bits, st.lt, st.rt, st.ls, st.rs]); if (s !== last) { last = s; onChange?.(); } };
  const buzz = (ms = 8) => { if (pref.haptics) try { navigator.vibrate?.(ms); } catch { /* not supported */ } };
  const num = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

  // ---- full screen. Browsers only allow it right after a tap, so Game Hub calls enterFullscreen() from the tap on "Ask to play".
  async function enterFullscreen() {
    if (document.fullscreenElement || !document.documentElement.requestFullscreen) return false;
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      weEnteredFullscreen = true;
      try { await screen.orientation?.lock?.('landscape'); } catch { /* not allowed on this phone: portrait layout is used */ }
      return true;
    } catch { return false; }
  }
  async function exitFullscreen() {
    try { screen.orientation?.unlock?.(); } catch { /* none */ }
    if (weEnteredFullscreen && document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* already out */ } }
    weEnteredFullscreen = false;
  }
  async function toggleFullscreen() {
    if (document.fullscreenElement) { weEnteredFullscreen = true; await exitFullscreen(); } else await enterFullscreen();
  }

  // ---- one finger on one control. Calls down() once, up() once, and move() while it slides (if given).
  function bindFinger(node, { down, up, move }) {
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (held.has(e.pointerId)) return;
      try { node.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      node.classList.add('on'); buzz();
      const ctx = down?.(e) ?? {};
      held.set(e.pointerId, () => { node.classList.remove('on'); up?.(ctx); });
      changed();
    });
    node.addEventListener('pointermove', (e) => { if (held.has(e.pointerId)) { e.preventDefault(); move?.(e); changed(); } });
    const end = (e) => { const r = held.get(e.pointerId); if (!r) return; held.delete(e.pointerId); r(); changed(); };
    node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end); node.addEventListener('lostpointercapture', end);
  }
  const bit = (node, b) => bindFinger(node, { down: () => { st.bits |= b; }, up: () => { st.bits &= ~b; } });
  const trig = (node, key) => bindFinger(node, { down: () => { st[key] = 255; }, up: () => { st[key] = 0; } });

  // ---- thumbstick: the knob follows the finger inside the ring; letting go centres it
  function stick(node, knob, key) {
    const apply = (e, ring) => {
      const cx = ring.left + ring.width / 2, cy = ring.top + ring.height / 2, R = ring.width * 0.32;
      let dx = e.clientX - cx, dy = e.clientY - cy; const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      st[key] = [dx / R, -dy / R];
    };
    bindFinger(node, {
      down: (e) => { apply(e, node.getBoundingClientRect()); },
      move: (e) => { apply(e, node.getBoundingClientRect()); },
      up: () => { st[key] = [0, 0]; knob.style.transform = ''; },
    });
  }

  // ---- d-pad: one zone, the finger can slide between directions and make diagonals
  function dpad(node, arrows) {
    const DIRS = XBTN.UP | XBTN.DOWN | XBTN.LEFT | XBTN.RIGHT;
    const set = (e) => {
      const r = node.getBoundingClientRect(); const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      let b = 0;
      if (Math.hypot(dx, dy) > r.width * 0.12) {
        const a = Math.atan2(-dy, dx) * 180 / Math.PI; // 0 = right, 90 = up
        if (a > -67.5 && a < 67.5) b |= XBTN.RIGHT;
        if (a > 22.5 && a < 157.5) b |= XBTN.UP;
        if (Math.abs(a) > 112.5) b |= XBTN.LEFT;
        if (a < -22.5 && a > -157.5) b |= XBTN.DOWN;
      }
      st.bits = (st.bits & ~DIRS) | b;
      for (const [name, a] of Object.entries(arrows)) a.classList.toggle('on', !!(b & XBTN[name.toUpperCase()]));
    };
    bindFinger(node, { down: set, move: set, up: () => { st.bits &= ~DIRS; for (const a of Object.values(arrows)) a.classList.remove('on'); } });
  }

  // ---- build the pad
  function build() {
    root = el('div', 'tp-root'); root.hidden = true;
    const place = (cls, node, css) => { node.className = `tp ${cls}`; Object.assign(node.style, css); root.append(node); return node; };

    // shoulders
    const sh = (cls, label, css, fn) => { const n = el('div', '', `<span>${label}</span>`); place(`tp-btn tp-shoulder ${cls}`, n, css); fn(n); };
    sh('tp-l2', 'L2', { left: U(4.2), top: U(3.7), width: U(27), height: U(10.3) }, (n) => trig(n, 'lt'));
    sh('tp-l1', 'L1', { left: U(3.7), top: U(16.7), width: U(24), height: U(11.5) }, (n) => bit(n, XBTN.LB));
    sh('tp-r2', 'R2', { right: U(4.2), top: U(3.7), width: U(27), height: U(10.3) }, (n) => trig(n, 'rt'));
    sh('tp-r1', 'R1', { right: U(3.7), top: U(16.7), width: U(24), height: U(11.5) }, (n) => bit(n, XBTN.RB));

    // d-pad
    const dp = el('div'); place('tp-dpad', dp, { left: U(20), top: U(46.2), width: U(34), height: U(34) });
    const arrows = {};
    for (const [n, x, y, w, h] of [['up', 0, -10.4, 11.7, 13.3], ['down', 0, 10.2, 11.7, 13.3], ['left', -10.9, 0, 13.3, 11.7], ['right', 10.9, 0, 13.3, 11.7]]) {
      const a = el('div', `tp-arrow tp-${n}`, SVG[n]); Object.assign(a.style, { left: `calc(50% + ${x} * var(--u))`, top: `calc(50% + ${y} * var(--u))`, width: U(w), height: U(h) }); dp.append(a); arrows[n] = a;
    }
    dpad(dp, arrows);

    // face buttons (cross = A, circle = B, square = X, triangle = Y)
    for (const [n, dx, dy, b] of [['triangle', 0, -10.6, XBTN.Y], ['square', -10.6, 0, XBTN.X], ['circle', 10.6, 0, XBTN.B], ['cross', 0, 10.6, XBTN.A]]) {
      const f = el('div', '', SVG[n]); place(`tp-btn tp-face tp-${n}`, f, { right: U(19.8 - dx - 5.85), top: U(46.2 + dy - 5.85), width: U(11.7), height: U(11.7) }); bit(f, b);
    }

    // sticks and their clicks
    for (const [side, ringCss, key, clickCss, b] of [['l', { left: U(21.55) }, 'ls', { left: U(6.9) }, XBTN.L3], ['r', { right: U(21.65) }, 'rs', { right: U(7) }, XBTN.R3]]) {
      const ring = el('div', 'tp-ring'), knob = el('div', 'tp-knob'); ring.append(knob);
      place('tp-stick', ring, { ...ringCss, top: U(61.2), width: U(31.7), height: U(31.7) }); stick(ring, knob, key);
      const c = el('div', '', `<span>${side.toUpperCase()}3</span>`); place('tp-btn tp-click', c, { ...clickCss, top: U(84.5), width: U(9.4), height: U(9.4) }); bit(c, b);
    }

    // the small buttons across the top: full screen, hide the pad, menu, and a plain STOP so nobody has to dig through a menu to leave
    const top = (cls, svg, offset) => { const n = el('div', `tp tp-btn tp-top ${cls}`, svg); n.style.left = `calc(50% + ${offset} * var(--u))`; root.append(n); return n; };
    const full = top('', SVG.screen, -18.5), hide = top('', SVG.pad, 0), more = top('', SVG.menu, 18.6), stop = top('tp-stop', SVG.stop, 37.2);
    stop.title = 'Stop playing';
    const tap = (node, fn) => {
      node.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.add('on'); buzz(); });
      node.addEventListener('pointerup', (e) => { e.preventDefault(); e.stopPropagation(); node.classList.remove('on'); fn(); });
      node.addEventListener('pointercancel', () => node.classList.remove('on'));
    };
    tap(full, toggleFullscreen); tap(hide, () => setHidden(true)); tap(more, () => toggleMenu()); tap(stop, () => { toggleMenu(false); onStop?.(); });

    // a small button to bring the pad back after hiding it (it always stays within reach of the stop button)
    const back = el('div', 'tp-back', SVG.pad); back.hidden = true; back.addEventListener('pointerup', (e) => { e.preventDefault(); setHidden(false); });
    const stop2 = el('div', 'tp-back tp-back2', SVG.stop); stop2.hidden = true; stop2.addEventListener('pointerup', (e) => { e.preventDefault(); onStop?.(); });
    root.append(back, stop2); root.back = back; root.stop2 = stop2;

    // the menu: Start, Back, settings, stop
    menu = el('div', 'tp-menu'); menu.hidden = true;
    const mbtn = (txt, fn, cls = '') => { const b = el('button', `tp-mb ${cls}`, txt); b.type = 'button'; b.addEventListener('pointerdown', (e) => e.stopPropagation()); b.addEventListener('click', fn); return b; };
    const pulse = (b) => { st.bits |= b; changed(); setTimeout(() => { st.bits &= ~b; changed(); }, 140); };
    const hap = mbtn('', () => { pref.haptics = !pref.haptics; save(); menu.paint(); });
    const opa = mbtn('', () => { pref.opacity = pref.opacity > 0.8 ? 0.55 : pref.opacity > 0.6 ? 0.35 : 0.9; save(); menu.paint(); });
    const stats = el('div', 'tp-stats', '');
    menu.append(mbtn('Start', () => pulse(XBTN.START)), mbtn('Back', () => pulse(XBTN.BACK)), hap, opa, stats,
      mbtn('Stop playing', () => { toggleMenu(false); onStop?.(); }, 'danger'), mbtn('Close', () => toggleMenu(false), 'ghost'));
    menu.paint = () => { hap.textContent = `Vibration: ${pref.haptics ? 'on' : 'off'}`; opa.textContent = `Controller opacity: ${Math.round(pref.opacity * 100)}%`; root.style.setProperty('--tp-op', String(pref.opacity)); stats.textContent = getStats?.() || ''; };
    document.body.append(menu);
    menu.paint();
    // nothing on the pad may scroll, zoom or open a context menu
    for (const t of ['contextmenu', 'selectstart', 'dragstart', 'gesturestart']) root.addEventListener(t, (e) => e.preventDefault());
    document.body.append(root);
  }
  function toggleMenu(on) { menu.hidden = on === undefined ? !menu.hidden : !on; if (!menu.hidden) menu.paint(); }
  function setHidden(h) {
    hidden = h; releaseAll();
    for (const c of root.children) if (!c.classList.contains('tp-back')) c.style.visibility = h ? 'hidden' : '';
    root.back.hidden = !h; root.stop2.hidden = !h;
  }
  function releaseAll() { for (const [id, r] of [...held]) { held.delete(id); r(); } st.bits = 0; st.lt = st.rt = 0; st.ls = [0, 0]; st.rs = [0, 0]; changed(); }

  // ---- the "waiting for the streamer" screen: the page goes clean (full screen) as soon as the player asks, so allowing it does not change the view
  function wait(text, onCancel) {
    if (!waitCard) {
      waitCard = el('div', 'tp-wait'); waitCard.hidden = true;
      waitCard.innerHTML = '<div class="tp-wait-text"></div><div class="tp-wait-dots"><i></i><i></i><i></i></div>';
      const c = el('button', 'tp-mb ghost', 'Cancel'); c.type = 'button'; c.addEventListener('click', () => waitCard.onCancel?.()); waitCard.append(c);
      document.body.append(waitCard);
    }
    waitCard.querySelector('.tp-wait-text').textContent = text; waitCard.onCancel = onCancel; waitCard.hidden = false;
    document.body.classList.add('gh-touch');
  }
  function endWait() { if (waitCard) waitCard.hidden = true; if (!shown) document.body.classList.remove('gh-touch'); }

  return {
    show() { if (!root) build(); endWait(); shown = true; root.hidden = false; document.body.classList.add('gh-touch'); },
    hide() { if (!root) { endWait(); return; } releaseAll(); shown = false; hidden = false; root.hidden = true; menu.hidden = true; document.body.classList.remove('gh-touch'); for (const c of root.children) c.style.visibility = ''; root.back.hidden = true; root.stop2.hidden = true; if (waitCard) waitCard.hidden = true; },
    wait, endWait, enterFullscreen, exitFullscreen,
    get active() { return shown && !hidden; },
    get shown() { return shown; },
    releaseAll,
    state: () => [st.bits, st.lt, st.rt, num(st.ls[0]), num(st.ls[1]), num(st.rs[0]), num(st.rs[1])],
    refreshMenu: () => { if (menu && !menu.hidden) menu.paint(); },
  };
}
