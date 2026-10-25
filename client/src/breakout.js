// Breakout rooms in the page: the host's setup and control panel, the "join your room" prompt, the banner while inside a room,
// and the countdown when the host closes them. The rooms themselves are ordinary rooms named "<main>~b<n>" (see server/breakout.js).
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const btn = (txt, fn, cls = 'secondary') => { const b = el('button', cls, txt); b.type = 'button'; b.onclick = fn; return b; };
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function initBreakoutUi({ $, getSession, toast, meeting, setChatOpen, onClosing, switchRoom, returnToMain }) {
  const isMgr = () => meeting.isManager();
  const mainName = () => { const s = getSession(); return s?.boMain ?? s?.roomName; };
  async function call(path, body = {}) {
    const s = getSession(); if (!s) throw new Error('You are not in a meeting.');
    const r = await fetch(`/api/bo/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: mainName(), token: s.token, hostSecret: s.mainSecret ?? s.hostSecret ?? undefined, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  }
  const act = (fn) => fn().catch((e) => toast(e.message));
  const paneOpen = () => !$('chat').hidden && !$('bo-pane').hidden;
  let state = null, endsAt = 0, closingAt = 0, setup = { count: 3, mode: 'auto', minutes: 0, allowReturn: true }, drawn = '';

  async function refresh() {
    if (!getSession()) return;
    try { state = await call('state'); endsAt = state.open ? state.endsAt : 0; render(); paintBar(); } catch { /* the meeting may be ending */ }
  }
  // Redraw the pane only when what it shows changed, and never while someone is typing in it (a redraw would swallow the keystrokes).
  const clockEls = () => document.querySelectorAll('#bo-body [data-end]');
  function tickClocks() { for (const e of clockEls()) e.textContent = `closes in ${clock(Number(e.dataset.end) - Date.now())}`; }

  // ---------------------------------------------------------------- pane
  function hostView(box) {
    const s = state;
    if (!s.rooms.length) {
      box.append(el('p', 'muted', 'Split the meeting into smaller rooms. Everyone but the hosts can be placed in a room.'));
      const f = el('form', 'bo-form');
      const num = document.createElement('input'); num.type = 'number'; num.min = '1'; num.max = '50'; num.value = String(setup.count); num.oninput = () => { setup.count = Number(num.value) || 1; };
      const nl = el('label', 'field', 'Number of rooms '); nl.append(num);
      const sel = document.createElement('select');
      for (const [v, t] of [['auto', 'Assign participants automatically'], ['manual', 'Assign participants manually'], ['choose', 'Let participants choose a room']]) sel.append(new Option(t, v));
      sel.value = setup.mode; sel.onchange = () => { setup.mode = sel.value; };
      const min = document.createElement('input'); min.type = 'number'; min.min = '0'; min.max = '240'; min.value = String(setup.minutes); min.oninput = () => { setup.minutes = Number(min.value) || 0; };
      const ml = el('label', 'field', 'Close the rooms automatically after (minutes, 0 = never) '); ml.append(min);
      const ret = document.createElement('input'); ret.type = 'checkbox'; ret.checked = setup.allowReturn; ret.onchange = () => { setup.allowReturn = ret.checked; };
      const rl = el('label', 'check'); rl.append(ret, document.createTextNode(' Allow participants to return to the main session at any time'));
      const go = el('button', 'primary', 'Create rooms'); go.type = 'submit';
      f.append(nl, sel, ml, rl, go);
      f.onsubmit = (e) => { e.preventDefault(); act(async () => { await call('create', setup); await refresh(); }); };
      box.append(f); return;
    }
    const head = el('div', 'bo-head');
    head.append(el('strong', '', `${s.rooms.length} rooms · ${s.open ? 'open' : 'not opened yet'}`));
    if (s.open && s.endsAt) { const c = el('span', 'muted', ''); c.dataset.end = String(s.endsAt); head.append(c); }
    box.append(head);
    const people = s.people ?? [];
    if (!s.open) {
      box.append(el('p', 'muted', s.opts.allowChoose ? 'Participants will pick their own room when you open them.' : 'Check who goes where, then open the rooms.'));
    }
    for (const r of s.rooms) {
      const card = el('div', 'bo-room');
      const t = el('div', 'bo-title'); t.append(el('strong', '', r.name), el('span', 'muted', s.open ? ` · ${r.now ?? 0} here now · ${r.size} assigned` : ` · ${r.size} assigned`));
      if (s.open) t.append(btn('Join', () => act(() => switchRoom(`${mainName()}~b${r.n}`, { main: mainName(), n: r.n })), 'secondary'));
      card.append(t);
      const names = people.filter((p) => p.room === r.n).map((p) => p.name);
      if (names.length) card.append(el('div', 'muted small-note', names.join(', ')));
      box.append(card);
    }
    const un = people.filter((p) => !p.room);
    if (!s.opts.allowChoose || people.some((p) => p.room)) {
      box.append(el('div', 'sec-title', `People (${people.length})${un.length ? ` · ${un.length} not in a room` : ''}`));
      const list = el('div', 'bo-people');
      for (const p of people) {
        const row = el('div', 'bo-person'); row.append(el('span', 'bo-pn', p.name));
        const sel = document.createElement('select'); sel.append(new Option('Not assigned', '0')); for (const r of s.rooms) sel.append(new Option(r.name, String(r.n)));
        sel.value = String(p.room); sel.onchange = () => act(async () => { await call('assign', { uid: p.uid, n: Number(sel.value) }); await refresh(); });
        row.append(sel); list.append(row);
      }
      box.append(list);
    }
    const acts = el('div', 'bo-acts');
    if (!s.open) {
      acts.append(btn('Open all rooms', () => act(async () => { await call('open'); toast('The breakout rooms are open.', 'info'); await refresh(); }), 'primary'));
      acts.append(btn('Start over', () => { if (confirm('Delete these rooms and the assignments?')) act(async () => { await call('discard'); await refresh(); }); }));
    } else {
      const f = el('form', 'bo-bc'); const t = document.createElement('input'); t.maxLength = 300; t.placeholder = 'Broadcast a message to all rooms'; const g = el('button', 'secondary', 'Send'); g.type = 'submit';
      f.append(t, g); f.onsubmit = (e) => { e.preventDefault(); if (!t.value.trim()) return; act(async () => { await call('broadcast', { text: t.value }); t.value = ''; toast('Message sent to all rooms.', 'info'); }); };
      box.append(f);
      acts.append(btn('Close all rooms', () => { if (confirm('Close all breakout rooms? People get a one-minute countdown, then return to the main session.')) act(async () => { await call('close', { secs: 60 }); await refresh(); }); }, 'primary'));
    }
    box.append(acts);
  }
  function memberView(box) {
    const s = state, sess = getSession();
    if (sess?.boMain) {
      box.append(el('p', '', `You are in ${s.rooms.find((r) => r.n === sess.boN)?.name ?? 'a breakout room'}.`));
      if (s.endsAt) { const c = el('p', 'muted', ''); c.dataset.end = String(s.endsAt); box.append(c); }
      box.append(btn('Ask the host for help', () => act(async () => { const r = await call('help'); toast(r.sent ? 'The host was asked to join you.' : 'No host is available right now.', 'info'); }), 'primary'));
      if (s.opts.allowReturn || isMgr()) box.append(btn('Return to the main session', () => act(returnToMain)));
      return;
    }
    if (!s.open) { box.append(el('p', 'muted', 'The host has not opened any breakout rooms.')); return; }
    if (s.mine) { box.append(el('p', '', `You are assigned to ${s.rooms.find((r) => r.n === s.mine)?.name}.`), btn(`Join ${s.rooms.find((r) => r.n === s.mine)?.name}`, () => act(() => switchRoom(`${mainName()}~b${s.mine}`, { main: mainName(), n: s.mine })), 'primary')); return; }
    if (s.opts.allowChoose) {
      box.append(el('p', '', 'Choose a room to join.'));
      for (const r of s.rooms) box.append(btn(`Join ${r.name}`, () => act(() => switchRoom(`${mainName()}~b${r.n}`, { main: mainName(), n: r.n })), 'secondary'));
      return;
    }
    box.append(el('p', 'muted', 'You have not been assigned to a room yet. The host will move you.'));
  }
  function render(force = false) {
    const box = $('bo-body');
    const key = JSON.stringify([state, isMgr(), getSession()?.boMain ?? '', getSession()?.boN ?? 0]);
    if (!force && key === drawn) return;
    if (!force && box.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    drawn = key; box.replaceChildren();
    if (!state) { box.append(el('p', 'muted', 'Loading…')); return; }
    if (isMgr() && !getSession()?.boMain) hostView(box); else memberView(box);
    tickClocks();
  }

  // ---------------------------------------------------------------- the strip while you are inside a room
  function paintBar() {
    const s = getSession(), bar = $('bo-bar');
    bar.hidden = !s?.boMain;
    if (!s?.boMain) return;
    const name = state?.rooms.find((r) => r.n === s.boN)?.name ?? `Breakout Room ${s.boN}`;
    $('bo-bar-t').textContent = `${name}${closingAt ? ` · closing in ${clock(closingAt - Date.now())}` : endsAt ? ` · ${clock(endsAt - Date.now())} left` : ''}`;
    $('bo-help').hidden = isMgr();
  }
  $('bo-help').onclick = () => act(async () => { const r = await call('help'); toast(r.sent ? 'The host was asked to join you.' : 'No host is available right now.', 'info'); });
  $('bo-return').onclick = () => act(returnToMain);
  let tick = 0;
  setInterval(() => {
    const s = getSession(); if (!s) return;
    if (s.boMain) { $('bo-return').hidden = !(state?.opts.allowReturn ?? true) && !isMgr(); paintBar(); }
    if (paneOpen()) { if (!document.hidden && ++tick % 4 === 0) refresh(); else tickClocks(); } // the countdown moves every second; the server is asked every 4
  }, 1000);

  // ---------------------------------------------------------------- messages from the server
  function joinPrompt(m) {
    const s = getSession();
    if (s?.boMain && (!m.n || m.n === s.boN)) return; // already where they should be (or only invited to choose)
    $('boj-t').textContent = m.n ? `You have been assigned to ${m.name}.` : 'Breakout rooms are open. Pick a room to join.';
    $('boj-go').textContent = m.n ? `Join ${m.name}` : 'Choose a room';
    $('boj-go').onclick = () => { $('bo-join').close(); if (m.n) act(() => switchRoom(`${mainName()}~b${m.n}`, { main: mainName(), n: m.n })); else openPane(); };
    if ($('bo-join').open) $('bo-join').close();
    $('boj-later').onclick = () => $('bo-join').close();
    if (!$('bo-join').open) $('bo-join').showModal();
  }
  let endTimer = 0;
  function onMessage(m) {
    if (m.k === 'bo-open') { if (!isMgr()) joinPrompt(m); refresh(); }
    else if (m.k === 'bo-end') {
      onClosing?.();
      closingAt = Date.now() + (Number(m.secs) || 0) * 1000;
      toast(`The breakout rooms close in ${m.secs} seconds. You will return to the main session.`, 'info');
      clearInterval(endTimer); endTimer = setInterval(() => { if (Date.now() > closingAt + 1500) { clearInterval(endTimer); closingAt = 0; } paintBar(); }, 1000);
    } else if (m.k === 'bo-msg') toast(`${String(m.from).slice(0, 40)} (to all rooms): ${String(m.text).slice(0, 300)}`, 'info');
    else if (m.k === 'bo-help') toast(`${String(m.from).slice(0, 40)} asked for help in Breakout Room ${Number(m.n)}.`, 'info');
    else if (m.k === 'bo-closed') { closingAt = 0; state = null; refresh(); }
  }
  function openPane() { setChatOpen(true, 'bo'); refresh(); }
  $('btn-bo').onclick = () => { $('more-menu').hidden = true; openPane(); };
  return { onMessage, refresh, paintBar, openPane, inRoom: () => !!getSession()?.boMain, reset() { state = null; endsAt = 0; closingAt = 0; clearInterval(endTimer); $('bo-join').open && $('bo-join').close(); paintBar(); } };
}
