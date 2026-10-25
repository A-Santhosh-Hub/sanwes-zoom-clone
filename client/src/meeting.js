// Meeting features: participants list, host / co-host controls (mute, mute all, make co-host, remove, lock, end for all),
// Host tools switches, waiting-room admission, raise hand, reactions, quick feedback and the invite link.
// Built from scratch on LiveKit participant metadata and attributes, data messages and the token server's /api/host/* endpoints.
const REACT_TOPIC = 'sanwes.react';
const REACTIONS = ['👏', '👍', '❤️', '😂', '😮', '🎉'];
const EFFECTS = ['🎈', '🚀', '👍', '😂', '🎉', '❤️'];
const ALLOWED = new Set([...REACTIONS, ...EFFECTS]);
// Quick feedback buttons: shown next to your name until you click again.
const FEEDBACK = [['yes', '✅', 'Yes'], ['no', '❌', 'No'], ['slow', '⏪', 'Go slower'], ['fast', '⏩', 'Go faster'], ['coffee', '☕', 'Coffee break']];
const STATUS_ICON = Object.fromEntries([...FEEDBACK.map(([k, e]) => [k, e]), ['brb', '⏳']]);
const SVG = 'http://www.w3.org/2000/svg';

function icon(name, cls = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', `ic ${cls}`.trim());
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

import { paintAvatar, safePic, store } from './ui.js';

export function initMeeting({ $, getRoom, getSession, toast, setChatOpen, openPop, closePops }) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let waitTimer = null, lastWaiting = new Set(), locked = false, lastReact = 0, handUp = false, myStatus = '', roomMeta = {};

  const me = () => getRoom()?.localParticipant;
  const roleOf = (p) => { try { return JSON.parse(p?.metadata || '{}').role ?? 'member'; } catch { return 'member'; } };
  const isHostRole = () => (me() ? roleOf(me()) === 'host' : false);   // the host: whoever created the meeting, or was handed the role
  const isManager = () => { const r = me() ? roleOf(me()) : 'member'; return r === 'host' || r === 'cohost'; };

  // Host proves identity with the secret; a co-host with their own (signed) join token.
  async function hostApi(path, body = {}) {
    const s = getSession();
    // the secret proves the original host; the join token names this person (needed for co-hosts and a host handed the role)
    const res = await fetch(`/api/host/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: s.roomName, hostSecret: s.hostSecret || undefined, token: s.token, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
    return j;
  }
  // The classroom tools (spotlight, ask to unmute, allow to talk, lower hand) live in /api/class/* and prove who is asking with the join token.
  async function classCall(path, body = {}) {
    const s = getSession();
    const res = await fetch(`/api/class/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: s.roomName, hostSecret: s.hostSecret || undefined, token: s.token, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
    return j;
  }
  const act = (fn) => fn().catch((e) => toast(e.message));
  const menuItem = (text, onclick, { danger = false, on = false } = {}) => {
    const b = document.createElement('button'); b.type = 'button';
    const chk = document.createElement('span'); chk.className = 'chk';
    b.append(chk, document.createTextNode(text));
    if (danger) b.style.color = '#ff8a8d';
    b.classList.toggle('on', on);
    b.onclick = () => { closePops(); onclick(); };
    return b;
  };

  // ------------------------------------------------------------ participants list
  const cleanName = (n) => String(n ?? '').trim().replace(/[^\w .\-]/g, '').slice(0, 32);
  async function renameSelf() {
    const lp = me(); if (!lp) return;
    const n = cleanName(window.prompt('Rename yourself in this meeting:', lp.name || ''));
    if (!n) return;
    try { await lp.setName(n); renderPeople(); } catch (e) { toast(`Rename failed: ${e.message}`); }
  }
  function rowItems(p) {
    if (p.isLocal) return roomMeta.allowRename !== false || isManager() ? [menuItem('Rename', renameSelf)] : [];
    const role = roleOf(p), myRole = me() ? roleOf(me()) : 'member', host = isHostRole();
    const mic = p.getTrackPublication('microphone'), micOn = !!mic && !mic.isMuted;
    const items = [];
    if (micOn) items.push(menuItem('Mute', () => act(() => hostApi('action', { action: 'mute', identity: p.identity }))));
    else if (role !== 'host') items.push(menuItem('Ask to unmute', () => act(async () => { await classCall('ask', { identity: p.identity, what: 'unmute' }); toast(`Asked ${p.name || p.identity} to unmute.`, 'info'); })));
    if (!p.isCameraEnabled && role !== 'host') items.push(menuItem('Ask to start video', () => act(async () => { await classCall('ask', { identity: p.identity, what: 'video' }); toast(`Asked ${p.name || p.identity} to start their video.`, 'info'); })));
    const spot = (roomMeta.spotlight ?? []).includes(p.identity);
    if (p.getTrackPublication('camera')) items.push(menuItem(spot ? 'Remove spotlight' : 'Spotlight video', () => act(() => classCall('spotlight', { identity: p.identity, on: !spot }))));
    if (role === 'member' || role === 'spectator') {
      const talker = (roomMeta.talkers ?? []).includes(p.identity);
      items.push(menuItem(talker ? 'Take back the floor' : 'Allow to talk', () => act(async () => { await classCall('talk', { identity: p.identity, on: !talker }); toast(talker ? `${p.name || p.identity} can no longer unmute.` : `${p.name || p.identity} can unmute and use video now.`, 'info'); })));
    }
    if (p.attributes?.hand === '1') items.push(menuItem('Lower hand', () => act(() => classCall('lowerhand', { identity: p.identity }))));
    if (host && role !== 'host') items.push(menuItem('Make host', () => { if (confirm(`Make ${p.name || p.identity} the host? You will become a co-host.`)) act(() => hostApi('action', { action: 'makehost', identity: p.identity })); }));
    if (host && role !== 'host') items.push(menuItem(role === 'cohost' ? 'Revoke co-host' : 'Make co-host', () => act(() => hostApi('action', { action: role === 'cohost' ? 'uncohost' : 'cohost', identity: p.identity }))));
    if (!(myRole === 'cohost' && role === 'cohost')) {
      items.push(menuItem('Remove', () => { if (confirm(`Remove ${p.name || p.identity} from the meeting?`)) act(() => hostApi('action', { action: 'remove', identity: p.identity })); }, { danger: true }));
    }
    return items;
  }
  function openRowMenu(anchor, p) {
    $('row-menu').replaceChildren(...rowItems(p));
    openPop('row-menu', anchor);
  }

  function row(p) {
    const role = roleOf(p);
    const li = document.createElement('li');
    li.className = 'person';
    const av = document.createElement('span'); av.className = 'pav'; paintAvatar(av, p.name || p.identity, roomMeta.hideAvatars ? '' : p.attributes?.pic);
    const nm = document.createElement('span'); nm.className = 'pname';
    const tags = [role === 'host' && 'Host', role === 'cohost' && 'Co-host', p.isLocal && 'me'].filter(Boolean);
    nm.append(document.createTextNode(p.name || p.identity));
    if (tags.length) { const t = document.createElement('span'); t.className = 'prole'; t.textContent = ` (${tags.join(', ')})`; nm.append(t); }
    li.append(av, nm);
    if (p.attributes?.hand === '1') { const h = document.createElement('span'); h.className = 'phand'; h.title = 'Hand raised'; h.textContent = '✋'; li.append(h); }
    if ((roomMeta.talkers ?? []).includes(p.identity)) { const t = document.createElement('span'); t.className = 'status-chip'; t.title = 'Allowed to talk'; t.textContent = '\u{1F399}\uFE0F'; li.append(t); }
    if ((roomMeta.spotlight ?? []).includes(p.identity)) { const t = document.createElement('span'); t.className = 'status-chip'; t.title = 'Spotlighted'; t.textContent = '\u{1F526}'; li.append(t); }
    if (p.attributes?.rec) { const r = document.createElement('span'); r.className = 'status-chip'; r.title = p.attributes.rec === '2' ? 'Recording (paused)' : 'Recording'; r.textContent = '\u{1F534}'; li.append(r); }
    const status = p.attributes?.status;
    if (STATUS_ICON[status]) { const s = document.createElement('span'); s.className = 'status-chip'; s.title = 'Feedback'; s.textContent = STATUS_ICON[status]; li.append(s); }

    const mic = p.getTrackPublication('microphone');
    const micOff = !mic || mic.isMuted;
    const st = document.createElement('span'); st.className = 'pstate';
    st.title = `${micOff ? 'Muted' : 'Mic on'}${p.isCameraEnabled ? ', camera on' : ', camera off'}`;
    st.append(icon(micOff ? 'mic-off' : 'mic', micOff ? 'off' : ''), icon(p.isCameraEnabled ? 'cam' : 'cam-off', p.isCameraEnabled ? '' : 'off'));
    li.append(st);

    // The "..." menu: only for the host and co-hosts, and never on the host. A co-host cannot act on another co-host.
    if ((p.isLocal || (isManager() && role !== 'host')) && rowItems(p).length) {
      const dots = document.createElement('button'); dots.type = 'button'; dots.className = 'row-dots'; dots.setAttribute('aria-label', `More for ${p.name || p.identity}`);
      dots.append(icon('dots', 'small'));
      dots.onclick = (e) => { e.stopPropagation(); openRowMenu(dots, p); };
      li.append(dots);
    }
    return li;
  }

  // A big meeting shows the first 100 matching people and a search box; the list is redrawn at most ~2.5 times a second.
  let pplTimer = 0, query = '';
  const LIST_MAX = 100;
  function renderPeople() {
    const room = getRoom();
    if (!room) return;
    if (room.remoteParticipants.size < 30) { renderPeopleNow(); return; }
    if (!pplTimer) pplTimer = setTimeout(() => { pplTimer = 0; renderPeopleNow(); }, 400);
  }
  $('people-search').oninput = () => { query = $('people-search').value.trim().toLowerCase(); renderPeopleNow(); };
  function renderPeopleNow() {
    const room = getRoom();
    if (!room) return;
    const people = [room.localParticipant, ...room.remoteParticipants.values()].filter((p) => { try { return JSON.parse(p.metadata || '{}').role !== 'bot'; } catch { return true; } });
    const rank = (p) => ({ host: 0, cohost: 1 }[roleOf(p)] ?? 2);
    const handOrder = people.filter((p) => p.attributes?.hand === '1').sort((a, b) => (Number(a.attributes?.handAt) || 0) - (Number(b.attributes?.handAt) || 0));
    people.sort((a, b) => rank(a) - rank(b) || (b.attributes?.hand === '1') - (a.attributes?.hand === '1') || handOrder.indexOf(a) - handOrder.indexOf(b));
    const big = people.length > 30;
    $('people-search').hidden = !big;
    const hits = query ? people.filter((p) => (p.name || p.identity).toLowerCase().includes(query)) : people;
    const rows = hits.slice(0, LIST_MAX).map(row);
    if (hits.length > LIST_MAX) { const li = document.createElement('li'); li.className = 'person more'; li.textContent = `${hits.length - LIST_MAX} more: use the search box to find someone`; rows.push(li); }
    $('people-list').replaceChildren(...rows);
    $('people-count').textContent = String(people.length);
    if (!$('people-pane').hidden) $('panel-title').textContent = `Participants (${people.length})`;
    const mgr = isManager();
    $('host-tools').hidden = !mgr;
    $('btn-host').hidden = !mgr;
    $('info-hosttools').hidden = !mgr;
    if (!mgr) closeHostTools();
    ensurePolling();
  }

  // ------------------------------------------------------------ status (raise hand, be right back, quick feedback)
  async function setAttr(attrs) { const lp = me(); if (lp) await lp.setAttributes(attrs); }
  const paintStatus = () => {
    $('btn-hand').setAttribute('aria-pressed', String(handUp));
    $('btn-hand').querySelector('.lbl').textContent = handUp ? 'Lower Hand' : 'Raise Hand';
    $('btn-brb').setAttribute('aria-pressed', String(myStatus === 'brb'));
    $('btn-brb').querySelector('.lbl').textContent = myStatus === 'brb' ? "I'm back" : 'Be right back';
    for (const b of $('feedback-row').children) b.setAttribute('aria-pressed', String(b.dataset.key === myStatus));
  };
  $('btn-hand').onclick = async () => {
    handUp = !handUp; $('react-menu').hidden = true;
    try { await setAttr(handUp ? { hand: '1', handAt: String(Date.now()) } : { hand: '0', handAt: '' }); } catch (e) { handUp = !handUp; toast(`Hand: ${e.message}`); }
    paintStatus();
  };
  async function setStatus(key) {
    const next = myStatus === key ? '' : key; $('react-menu').hidden = true;
    try { await setAttr({ status: next }); myStatus = next; } catch (e) { toast(`Status: ${e.message}`); }
    paintStatus();
  }
  $('btn-brb').onclick = () => setStatus('brb');
  $('feedback-row').replaceChildren(...FEEDBACK.map(([key, emoji, label]) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.key = key; b.textContent = emoji; b.title = label; b.setAttribute('aria-label', label);
    b.onclick = () => setStatus(key);
    return b;
  }));
  function onAttributesChanged(changed, participant) {
    renderPeople();
    if (participant?.isLocal && changed?.hand === '0' && handUp) { handUp = false; paintStatus(); toast('The host lowered your hand.', 'info'); }
    if (participant && !participant.isLocal && changed?.hand === '1' && isManager()) toast(`${participant.name || participant.identity} raised a hand`, 'info');
    if (participant && !participant.isLocal && 'rec' in (changed ?? {})) {
      if (changed.rec === '1') toast(`${participant.name || participant.identity} is recording this meeting.`, 'info');
      else if (changed.rec === '') toast(`${participant.name || participant.identity} stopped recording.`, 'info');
    }
  }

  // ------------------------------------------------------------ reactions + effects
  const emojiButton = (e, fx) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', `${fx ? 'Effect' : 'React'} ${e}`);
    b.onclick = async () => {
      $('react-menu').hidden = true;
      const lp = me(); if (!lp || Date.now() - lastReact < 300) return;
      lastReact = Date.now();
      float(e, 'You', fx);
      try { await lp.publishData(enc.encode(JSON.stringify({ e, fx })), { topic: REACT_TOPIC, reliable: false }); } catch { /* best effort */ }
    };
    return b;
  };
  $('react-emojis').replaceChildren(...REACTIONS.map((e) => emojiButton(e, false)));
  $('effect-row').replaceChildren(...EFFECTS.map((e) => emojiButton(e, true)));

  function float(emoji, who, fx = false) {
    const box = $('reactions');
    if (box.children.length > 30) return;
    const el = document.createElement('div');
    el.className = fx ? 'float-react fx' : 'float-react';
    el.style.left = `${8 + Math.random() * 70}%`;
    const big = document.createElement('span'); big.textContent = emoji;
    const small = document.createElement('small'); small.textContent = who;
    el.append(big, small);
    el.addEventListener('animationend', () => el.remove());
    box.append(el);
    if (fx) for (let i = 0; i < 5; i++) setTimeout(() => { if (box.isConnected) { const c = el.cloneNode(true); c.classList.remove('fx'); c.style.left = `${5 + Math.random() * 85}%`; c.addEventListener('animationend', () => c.remove()); box.append(c); } }, 120 * (i + 1));
  }
  // Only whitelisted emoji are ever rendered, whatever a remote client sends.
  let reactWindow = 0, reactCount = 0;
  function onReaction(participant, payload) {
    const now = Date.now(); if (now - reactWindow > 1000) { reactWindow = now; reactCount = 0; }
    if (++reactCount > 20) return; // a crowd cannot flood the screen
    let m; try { m = JSON.parse(dec.decode(payload)); } catch { return; }
    if (ALLOWED.has(m?.e) && participant) float(m.e, participant.name || participant.identity, m.fx === true);
  }

  // ------------------------------------------------------------ invite link (panel footer, info popup, More menu)
  async function invite() {
    const s = getSession(); if (!s) return;
    const url = `${location.origin}/?room=${encodeURIComponent(s.roomName)}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied. If the meeting has a passcode, share it separately.', 'info'); }
    catch { window.prompt('Copy this invite link:', url); }
  }
  for (const b of document.querySelectorAll('.js-invite')) b.addEventListener('click', invite);

  // ------------------------------------------------------------ participants footer + Host tools panel
  // Mute all: ask whether people may unmute themselves, mute everyone now and mute people who join later
  $('hb-muteall').onclick = () => { $('mute-allow').checked = roomMeta.allowUnmute !== false; $('mute-dialog').showModal(); };
  $('mute-no').onclick = () => $('mute-dialog').close();
  $('mute-form').addEventListener('submit', () => act(async () => {
    await hostApi('action', { action: 'muteAll' });
    await setSetting('muteOnEntry', true);
    await setSetting('allowUnmute', $('mute-allow').checked);
    toast('Everyone is muted, and so is anyone who joins.', 'info');
  }));
  $('hb-more').onclick = (e) => {
    e.stopPropagation();
    $('row-menu').replaceChildren(
      menuItem(locked ? 'Unlock meeting' : 'Lock meeting', () => act(setLocked)),
      menuItem('Lower all hands', () => act(() => classCall('lowerhand', {}))),
      menuItem('Remove spotlight for everyone', () => act(() => classCall('spotlight', { identity: '' }))),
      menuItem('Host tools', () => openHostTools()),
    );
    openPop('row-menu', $('hb-more'));
  };
  async function setLocked() { const r = await hostApi('action', { action: locked ? 'unlock' : 'lock' }); locked = r.locked; paintHost(); }
  $('hb-lock').onchange = () => act(async () => { const r = await hostApi('action', { action: $('hb-lock').checked ? 'lock' : 'unlock' }); locked = r.locked; paintHost(); });
  // One helper for every switch / list in Host tools: send the setting, and put the control back if the server says no.
  const setSetting = (key, value) => hostApi('action', { action: 'setting', key, value });
  const control = (id, key, read = () => $(id).checked) => { $(id).onchange = () => act(async () => { try { await setSetting(key, read()); } catch (e) { onRoomMeta(roomMeta); throw e; } }); };
  control('ht-waiting', 'waiting');
  control('ht-hide', 'hideAvatars');
  control('ht-chat', 'chatWho', () => ($('ht-chat').checked ? 'all' : 'none'));
  control('ht-rename', 'allowRename');
  control('ht-unmute', 'allowUnmute');
  control('ht-video', 'allowVideo');
  control('ht-record', 'allowRecord');
  control('ht-files', 'allowFiles');
  control('ht-qa', 'qaOn');
  control('ht-qaanon', 'qaAnon');
  control('ht-sharemax', 'shareMax', () => $('ht-sharemax').value);
  control('ht-sharewho', 'allowShare', () => $('ht-sharewho').value === 'all');
  control('ht-sharewhen', 'shareWhen', () => $('ht-sharewhen').value);
  control('ht-wbwho', 'wbWho', () => $('ht-wbwho').value);
  control('ht-protect', 'protect', () => $('ht-protect').value);
  $('ht-suspend').onclick = () => act(async () => {
    if (roomMeta.suspended) { await hostApi('action', { action: 'resume' }); toast('Participant activities are back on.', 'info'); return; }
    if (!confirm('Suspend participant activities? Everyone except hosts is muted and stops video and sharing, chat is turned off, and the meeting is locked.')) return;
    await hostApi('action', { action: 'suspend' });
  });

  // The Host tools pages: a main list, with Participants and Advanced (Share, Whiteboard) one step in.
  const VIEWS = ['hp-main', 'hp-people', 'hp-adv', 'hp-share', 'hp-wb'];
  const showView = (id) => { for (const v of VIEWS) $(v).hidden = v !== id; };
  for (const b of document.querySelectorAll('#host-pane [data-view]')) b.onclick = () => showView(b.dataset.view);
  for (const b of document.querySelectorAll('#host-pane .hp-back')) b.onclick = () => showView(b.dataset.back);
  const paintHost = () => { $('hb-lock').checked = locked; $('btn-host').setAttribute('aria-pressed', String(!$('host-pane').hidden)); };
  function closeHostTools() { $('host-pane').hidden = true; $('chat').classList.remove('host-open'); paintHost(); }
  function openHostTools() {
    if (!isManager()) return;
    if ($('chat').hidden) setChatOpen(true, 'people');
    showView('hp-main');
    $('host-pane').hidden = false; $('chat').classList.add('host-open'); paintHost();
  }
  $('btn-host').onclick = () => { if ($('host-pane').hidden) openHostTools(); else closeHostTools(); };
  $('host-close').onclick = closeHostTools;
  for (const b of document.querySelectorAll('#host-pane .hp-x')) b.onclick = closeHostTools;
  $('info-hosttools').onclick = () => { closePops(); openHostTools(); };

  // Switch positions follow the room's own settings, so a co-host's change shows for the host and vice versa.
  function onRoomMeta(meta) {
    const was = roomMeta; roomMeta = meta;
    $('ht-waiting').checked = meta.waiting === true;
    $('ht-hide').checked = meta.hideAvatars === true;
    $('ht-chat').checked = (meta.chatWho ?? 'all') !== 'none';
    $('ht-rename').checked = meta.allowRename !== false;
    $('ht-unmute').checked = meta.allowUnmute !== false;
    $('ht-video').checked = meta.allowVideo !== false;
    $('ht-record').checked = meta.allowRecord === true;
    $('ht-files').checked = meta.allowFiles === true;
    $('ht-qa').checked = meta.qaOn !== false;
    $('ht-qaanon').checked = meta.qaAnon !== false;
    $('ht-sharemax').value = meta.shareMax ?? 'multi';
    $('ht-sharewho').value = meta.allowShare === false ? 'host' : 'all';
    $('ht-sharewhen').value = meta.shareWhen ?? 'all';
    $('ht-wbwho').value = meta.wbWho ?? 'all';
    $('ht-protect').value = meta.protect ?? 'off';
    $('ht-suspend').textContent = meta.suspended ? 'Resume participant activities' : 'Suspend participant activities';
    if (meta.suspended && !was.suspended && !isManager()) toast('The host suspended participant activities.', 'info');
    if (!!was.hideAvatars !== !!meta.hideAvatars) renderPeople();
  }

  function renderWaiting(list) {
    $('waiting-box').hidden = list.length === 0;
    $('wb-title').textContent = `Waiting room (${list.length})`;
    $('waiting-list').replaceChildren(...list.map((w) => {
      const li = document.createElement('li'); li.className = 'person';
      const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = w.name;
      const mk = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn; return b; };
      li.append(nm,
        mk('Admit', 'primary', () => act(async () => { await hostApi('admit', { ticket: w.ticket, allow: true }); poll(); })),
        mk('Deny', 'secondary', () => act(async () => { await hostApi('admit', { ticket: w.ticket, allow: false }); poll(); })));
      return li;
    }));
  }
  $('wb-all').onclick = () => act(async () => { for (const t of lastWaiting) await hostApi('admit', { ticket: t, allow: true }); poll(); });

  async function poll() {
    if (!isManager() || !getRoom()) return;
    try {
      const r = await hostApi('waiting');
      locked = r.locked; paintHost();
      const fresh = r.waiting.filter((w) => !lastWaiting.has(w.ticket));
      lastWaiting = new Set(r.waiting.map((w) => w.ticket));
      renderWaiting(r.waiting);
      if (fresh.length) { toast(`${fresh.map((w) => w.name).join(', ')} ${fresh.length > 1 ? 'are' : 'is'} waiting to join`, 'info'); if ($('chat').hidden) setChatOpen(true, 'people'); }
    } catch { /* meeting ended or media server hiccup */ }
  }
  // Hosts and co-hosts watch the waiting room; someone made co-host later starts watching, someone demoted stops.
  function ensurePolling() {
    if (isManager() && !waitTimer) { poll(); waitTimer = setInterval(poll, 2000); }
    else if (!isManager() && waitTimer) { clearInterval(waitTimer); waitTimer = null; renderWaiting([]); }
  }

  return {
    renderPeople,
    onAttributesChanged,
    onReaction,
    onRoomMeta,
    openHostTools,
    closeHostTools,
    setSetting,
    isManager,
    REACT_TOPIC,
    roomMeta: () => roomMeta,
    classCall,
    canEnd: () => isHostRole(),
    endForAll: () => hostApi('action', { action: 'end' }),
    onJoined() {
      handUp = false; myStatus = ''; paintStatus(); locked = false; paintHost();
      const pic = store.get('sanwes.pic'); if (safePic(pic) && (getRoom()?.remoteParticipants.size ?? 0) < 100) setAttr({ pic }).catch(() => {}); // share my profile picture (not in huge rooms)
      renderPeople();
    },
    reset() {
      clearInterval(waitTimer); waitTimer = null; lastWaiting = new Set(); locked = false; handUp = false; myStatus = '';
      $('people-list').replaceChildren(); $('waiting-list').replaceChildren(); $('waiting-box').hidden = true;
      roomMeta = {}; closeHostTools(); $('host-tools').hidden = true; $('btn-host').hidden = true; $('reactions').replaceChildren(); $('react-menu').hidden = true;
      paintStatus();
    },
  };
}
