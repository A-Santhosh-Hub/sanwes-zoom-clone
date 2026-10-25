// Home screen: clock, Meet / Join / Schedule / Share tiles, upcoming meetings, the Meetings page (calendar + agenda),
// Join and Schedule dialogs, invitations + calendar export, personal meeting id, and the live rooms list.
import { initReminders, REMINDER_CHOICES } from './reminders.js';
import { initTasksUi } from './tasks-ui.js';
import { $, store, guestName, TYPE_LABEL, coverEl, fmtId, paintAvatar, safePic, resizePicture } from './ui.js';

const DAY = 86_400_000;
const api = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && j.auth) window.dispatchEvent(new Event('sanwes:signed-out')); // the session ended: back to the sign-in screen
  if (!res.ok) throw Object.assign(new Error(j.error ?? `Request failed (${res.status})`), { status: res.status, passwordRequired: !!j.passwordRequired });
  return j;
};

// ------------------------------------------------------------------ date helpers
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const fmt = (d, o, tz) => new Intl.DateTimeFormat(undefined, { ...o, ...(tz ? { timeZone: tz } : {}) }).format(d);
const timeStr = (d, tz) => fmt(d, { hour: '2-digit', minute: '2-digit' }, tz);
const pad = (n) => String(n).padStart(2, '0');

// A wall-clock time in a given time zone <-> an exact instant (two passes so daylight-saving changes come out right).
function tzOffsetMs(utcMs, tz) {
  utcMs = Math.floor(utcMs / 1000) * 1000; // the formatter below drops milliseconds
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - utcMs;
}
function zonedToUtc(dateStr, timeStr24, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number), [h, mi] = timeStr24.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(first, tz));
}
function wallClock(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const gmtLabel = (tz) => { const m = Math.round(tzOffsetMs(Date.now(), tz) / 60000), a = Math.abs(m); return `(GMT${m < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}) ${tz.replace(/_/g, ' ')}`; };

export function initHome({ startJoin, toast, openSettings }) {
  // ---------------------------------------------------------------- identity
  // Your name and your meetings come from your account (server side); the browser only remembers what to show.
  let myName = store.get('sanwes.name') || '', account = null;
  const owner = (body = {}) => body;
  const paintProfile = () => { paintAvatar($('btn-profile'), myName, store.get('sanwes.pic')); $('btn-profile').title = myName; };
  paintProfile();

  // ---------------------------------------------------------------- state
  let meetings = [], pmi = null, query = '';
  let autopilotMode = false;
  const tasksUi = initTasksUi({ $, api, toast, getStart: () => { try { const d = readStart(); return Number.isNaN(d.getTime()) ? null : { at: d, tz: $('s-tz').value }; } catch { return null; } } });
  tasksUi.setMeetings(() => meetings);
  let homeDay = startOfDay(new Date()), selDay = startOfDay(new Date()), calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1), view = 'agenda';

  // ---------------------------------------------------------------- clock
  const tick = () => { const n = new Date(); $('clock').textContent = fmt(n, { hour: '2-digit', minute: '2-digit', hour12: false }); $('date').textContent = fmt(n, { weekday: 'long', month: 'long', day: 'numeric' }); };
  tick(); setInterval(tick, 1000);

  // ---------------------------------------------------------------- navigation + popovers
  function showPage(name) {
    for (const p of ['home', 'meetings']) $(`page-${p}`).hidden = p !== name;
    for (const b of document.querySelectorAll('.rail-btn[data-page]')) b.classList.toggle('active', b.dataset.page === name);
    if (name === 'meetings') renderMeetingsPage();
    closeMenus();
  }
  for (const b of document.querySelectorAll('.rail-btn[data-page]')) b.onclick = () => showPage(b.dataset.page);
  $('rail-settings').onclick = () => openSettings('general');

  const menus = ['meet-menu'];
  const closeMenus = () => { for (const id of menus) $(id).hidden = true; };
  $('meet-caret').onclick = (e) => {
    e.stopPropagation();
    const m = $('meet-menu'), was = m.hidden; closeMenus(); if (!was) return;
    m.hidden = false;
    const r = $('meet-caret').getBoundingClientRect();
    m.style.left = `${Math.max(8, r.left - 20)}px`; m.style.top = `${r.bottom + 6}px`;
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover')) closeMenus(); });
  $('mm-video').checked = store.get('sanwes.meetVideo') === '1';
  $('mm-pmi').checked = store.get('sanwes.meetPmi') === '1';
  $('mm-video').onchange = () => store.set('sanwes.meetVideo', $('mm-video').checked ? '1' : '0');
  $('mm-pmi').onchange = () => store.set('sanwes.meetPmi', $('mm-pmi').checked ? '1' : '0');

  // ---------------------------------------------------------------- banner (messages when a meeting ends / you were removed)
  let bannerTimer;
  function banner(text) {
    clearTimeout(bannerTimer);
    $('home-banner').textContent = text || '';
    $('home-banner').hidden = !text;
    if (text) bannerTimer = setTimeout(() => { $('home-banner').hidden = true; }, 12000);
  }

  // ---------------------------------------------------------------- entering a meeting
  // The preview window (camera picture, microphone / camera pickers) shown before you start or join, unless switched off.
  let pvStream = null;
  const stopPreview = () => { pvStream?.getTracks().forEach((t) => t.stop()); pvStream = null; $('pv-video').srcObject = null; };
  async function showPreview(opts, verb, title, skip = false) {
    if (skip || store.get('sanwes.preview') === '0') return opts;
    const wantCam = opts.media?.cam === true;
    const wantMic = opts.media?.mic !== false;
    const dlg = $('preview-dialog');
    $('pv-title').textContent = title || 'Meeting';
    $('pv-go').textContent = verb;
    $('pv-always').checked = true;
    paintAvatar($('pv-avatar'), myName, store.get('sanwes.pic'));
    $('pv-avatar').hidden = false; $('pv-video').hidden = true; $('pv-note').textContent = '';
    dlg.showModal();
    const fill = async () => {
      let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { /* none */ }
      const mk = (sel, kind, saved, noun) => {
        const list = devs.filter((d) => d.kind === kind && d.deviceId !== 'communications');
        sel.replaceChildren(...list.map((d, i) => new Option(d.deviceId === 'default' ? `Same as system (${(d.label || noun).replace(/^Default - /, '')})` : d.label || `${noun} ${i + 1}`, d.deviceId)));
        if (!list.length) sel.append(new Option(`No ${noun.toLowerCase()} found`, ''));
        if (saved && list.some((d) => d.deviceId === saved)) sel.value = saved;
      };
      mk($('pv-mic'), 'audioinput', store.get('sanwes.dev.audioinput'), 'Microphone');
      mk($('pv-cam'), 'videoinput', store.get('sanwes.dev.videoinput'), 'Camera');
    };
    const startCam = async () => {
      stopPreview();
      if (!wantCam) { await fill(); return; }
      try {
        pvStream = await navigator.mediaDevices.getUserMedia({ video: $('pv-cam').value ? { deviceId: { exact: $('pv-cam').value } } : true, audio: false });
        $('pv-video').srcObject = pvStream; $('pv-video').hidden = false; $('pv-avatar').hidden = true;
      } catch (e) { $('pv-note').textContent = `The camera preview is unavailable (${e.name}). You can still join.`; }
      await fill();
    };
    // device names need permission: ask once for what we are going to use, then list the devices
    for (const c of [wantMic && { audio: true }, wantCam && { video: true }].filter(Boolean)) {
      try { (await navigator.mediaDevices.getUserMedia(c)).getTracks().forEach((t) => t.stop()); } catch { /* the browser will ask again when joining */ }
    }
    await fill();
    await startCam();
    $('pv-cam').onchange = startCam;
    return new Promise((resolve) => {
      const done = (value) => { stopPreview(); $('pv-cam').onchange = null; dlg.close(); resolve(value); };
      $('pv-go').onclick = () => {
        if ($('pv-mic').value) store.set('sanwes.dev.audioinput', $('pv-mic').value);
        if ($('pv-cam').value) store.set('sanwes.dev.videoinput', $('pv-cam').value);
        store.set('sanwes.preview', $('pv-always').checked ? '1' : '0');
        done(opts);
      };
      $('pv-x').onclick = () => done(null);
      dlg.oncancel = (e) => { e.preventDefault(); done(null); };
      $('pv-bg').onclick = () => openSettings();
    });
  }

  async function enter(opts, verb = 'Start', title, skipPreview = false) {
    banner('');
    const chosen = await showPreview(opts, verb, title, skipPreview);
    if (!chosen) return false;
    const res = await startJoin({ name: myName, ...chosen });
    if (res.ok) return true;
    const ex = res.error;
    if (ex.passwordRequired) openJoin({ id: opts.roomName, needPass: true, msg: ex.message });
    else banner(ex.message);
    return false;
  }

  async function startInstant({ share = false } = {}) {
    const video = $('mm-video').checked;
    try {
      if ($('mm-pmi').checked && pmi) return await startMeeting(pmi, { cam: video, share });
      const id = String(Math.floor(1e9 + Math.random() * 9e9));
      const r = await api('/api/rooms', { room: id, name: myName, type: 'meeting', title: `${myName}'s Meeting` });
      return await enter({ roomName: r.room, hostSecret: r.hostSecret, media: { mic: true, cam: video }, autoShare: share });
    } catch (e) { banner(e.message); }
  }
  $('tile-meet').onclick = () => startInstant();
  $('tile-share').onclick = () => startInstant({ share: true });
  $('tile-join').onclick = () => openJoin();
  $('tile-schedule').onclick = () => openSchedule();
  $('tile-rooms').onclick = () => openCreate();

  // The class window: start the class as its host and go straight in, with microphone on (and camera if the class says so). No dialogs, no clicks.
  async function autopilotJoin(id) {
    banner(`Opening the class…`);
    try {
      const r = await api(`/api/meetings/${encodeURIComponent(id)}/start`, owner({ name: myName }));
      const ok = await enter({ roomName: r.room, hostSecret: r.hostSecret, password: r.passcode, media: { mic: true, cam: !!r.meta?.hostVideo } }, 'Start', undefined, true);
      if (ok) autopilotStrip(id);
    } catch (e) { banner(e.message); }
  }
  // A strip at the top of the class window that says plainly what the class helper is doing: what plays, what is next, whether it records, and any problem.
  function autopilotStrip(id) {
    const bar = $('ap-bar'), time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let firstIdx = 0, tmr = 0;
    const tick = async () => {
      if ($('call').hidden) { bar.hidden = true; clearInterval(tmr); return; }
      let t; try { const r = await fetch('/api/tasks/board', { cache: 'no-store' }); t = (await r.json()).tasks?.find((x) => x.id === id); } catch { return; }
      const run = t?.run;
      bar.hidden = false;
      const parts = [];
      if (!run || !['running', 'starting', 'stopping'].includes(run.status)) parts.push(run ? 'The class helper has finished.' : 'The class helper is not running.');
      else {
        parts.push(run.connected ? 'Class helper connected' : 'Class helper starting…');
        if (run.playing) parts.push(`\u25B6 Playing: ${run.stepName || 'a video'}`);
        else if (run.nextName) parts.push(run.nextAt ? `\u23F3 First video "${run.nextName}" starts at ${time(run.nextAt)}` : `\u23F3 Next: "${run.nextName}"`);
        else parts.push('No video playing');
        if (run.playing && run.nextName) parts.push(run.nextAt ? `then "${run.nextName}" at ${time(run.nextAt)}` : `then "${run.nextName}"`);
        if (run.recording) parts.push('\u25CF Recording');
        if (run.error) parts.push(`\u26A0 ${run.error}`);
      }
      $('ap-text').textContent = parts.join('   \u00B7   ');
      bar.classList.toggle('bad', !!run?.error || !run || run.status === 'failed');
      const play = $('ap-play'); play.hidden = !(run && ['running'].includes(run.status) && !run.playing && t.steps.length);
      firstIdx = 0;
      play.onclick = () => api('/api/tasks/cmd', { id, cmd: 'play', step: firstIdx }).catch((e) => toast(e.message));
    };
    clearInterval(tmr); tmr = setInterval(tick, 2000); tick();
  }

  async function startMeeting(m, { cam, share } = {}) {
    try {
      const r = await api(`/api/meetings/${m.id}/start`, owner({ name: myName }));
      // a class that runs by itself opens straight away: no camera preview in between
      return await enter({ roomName: r.room, hostSecret: r.hostSecret, password: r.passcode, media: { mic: true, cam }, autoShare: !!share }, 'Start', undefined, !!m.auto?.enabled);
    } catch (e) { banner(e.message); }
  }

  // ---------------------------------------------------------------- reminders (see reminders.js)
  let roomNameFn = () => null;
  const optionList = (sel, first) => sel.replaceChildren(...first.map(([v, l]) => new Option(l, v)), ...REMINDER_CHOICES.map(([v, l]) => new Option(l, String(v))));
  optionList($('s-remind'), [['default', 'My default reminders'], ['none', 'No reminder']]);
  optionList($('s-remind2'), [['none', 'No second reminder']]);
  $('s-remind').onchange = () => { const off = ['default', 'none'].includes($('s-remind').value); $('s-remind2').disabled = off; if (off) $('s-remind2').value = 'none'; };
  function readReminders() {
    const a = $('s-remind').value;
    if (a === 'default') return null;
    if (a === 'none') return [];
    return [...new Set([Number(a), $('s-remind2').value === 'none' ? null : Number($('s-remind2').value)].filter((n) => n !== null))];
  }
  const reminders = initReminders({
    $, store, toast,
    getMeetings: () => (autopilotMode ? [] : meetings), // the class window opened by SanWe's must not pop up "meeting starting" cards
    occurrences: (m, from, to) => occurrences(m, from, to),
    onStart: (m) => startMeeting(m, { cam: m.hostVideo }),
    getRoomName: () => roomNameFn(),
  });

  // ---------------------------------------------------------------- join dialog (like the real one: id, name, two checkboxes)
  const joinDlg = $('join-dialog');
  function openJoin({ id = '', pass = '', needPass = false, msg = '' } = {}) {
    $('j-id').value = id; $('j-pass').value = pass; $('j-name').value = myName;
    $('j-pass-l').hidden = !(needPass || pass);
    $('j-error').textContent = msg;
    $('j-noaudio').checked = store.get('sanwes.joinNoAudio') === '1';
    $('j-novideo').checked = store.get('sanwes.joinNoVideo') === '1';
    $('j-submit').disabled = !$('j-id').value.trim();
    if (!joinDlg.open) joinDlg.showModal();
    ($('j-id').value ? ($('j-pass-l').hidden ? $('j-name') : $('j-pass')) : $('j-id')).focus();
  }
  $('j-id').oninput = () => { $('j-submit').disabled = !$('j-id').value.trim(); };
  $('j-cancel').onclick = () => joinDlg.close();
  // A pasted invitation link works too: ?room=<id>&pwd=<passcode>
  function parseTarget(raw) {
    try { const u = new URL(raw); const r = u.searchParams.get('room'); if (r) return { room: r, pwd: u.searchParams.get('pwd') ?? '' }; } catch { /* not a link */ }
    const digits = raw.replace(/[\s-]/g, '');
    return { room: /^\d{9,12}$/.test(digits) ? digits : raw.trim(), pwd: '' };
  }
  $('join-form2').addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = parseTarget($('j-id').value.trim());
    const name = $('j-name').value.trim() || myName;
    if (name !== myName) { myName = name; store.set('sanwes.name', name); paintProfile(); }
    store.set('sanwes.joinNoAudio', $('j-noaudio').checked ? '1' : '0');
    store.set('sanwes.joinNoVideo', $('j-novideo').checked ? '1' : '0');
    const password = $('j-pass').value || target.pwd;
    joinDlg.close(); // the waiting-room screen must not end up underneath the dialog
    banner('');
    const joinOpts = { name, roomName: target.room, password, media: { mic: !$('j-noaudio').checked, cam: !$('j-novideo').checked } };
    let autoClass = false; // a class that runs by itself: people go straight in, muted as the class rules say
    try { const r = await fetch(`/api/meetings/${encodeURIComponent(target.room.replace(/\D/g, '') || target.room)}/public`); if (r.ok) autoClass = !!(await r.json()).autoClass; } catch { /* the join below explains any problem */ }
    const chosen = await showPreview(joinOpts, 'Join', 'Join meeting', autoClass);
    if (!chosen) { openJoin({ id: $('j-id').value, pass: password, needPass: !!password }); return; }
    const res = await startJoin(chosen);
    if (!res.ok) openJoin({ id: $('j-id').value, pass: password, needPass: res.error.passwordRequired || !!password, msg: res.error.message });
  });

  // ---------------------------------------------------------------- profile
  let draftPic = '';
  const paintDraft = () => paintAvatar($('p-pic'), $('p-name').value || myName, draftPic);
  function openProfile() {
    $('p-name').value = myName; draftPic = safePic(store.get('sanwes.pic')); paintDraft();
    $('p-account').textContent = account ? `Signed in as ${account.username} (${account.email})${account.role === 'admin' ? ', administrator' : ''}` : '';
    $('profile-dialog').showModal(); $('p-name').focus();
  }
  $('p-name').addEventListener('input', paintDraft);
  $('p-file').onchange = async () => {
    const f = $('p-file').files?.[0]; $('p-file').value = '';
    if (!f) return;
    try { draftPic = await resizePicture(f); paintDraft(); } catch (e) { alert(e.message); }
  };
  $('p-pic-clear').onclick = () => { draftPic = ''; paintDraft(); };
  $('p-cancel').onclick = () => $('profile-dialog').close();
  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = $('p-name').value.trim().replace(/[^\w .\-]/g, '').slice(0, 32);
    if (n && n !== myName) {
      try { const r = await api('/api/auth/profile', { displayName: n }); myName = r.user.displayName; account = { ...account, ...r.user }; store.set('sanwes.name', myName); loadMeetings(); }
      catch (ex) { alert(ex.message); return; }
    }
    store.set('sanwes.pic', draftPic); paintProfile();
    $('profile-dialog').close();
  });

  // ---------------------------------------------------------------- meetings data
  async function loadMeetings() {
    try {
      const [p, l] = await Promise.all([api('/api/meetings/personal', owner()), api('/api/meetings/list', owner())]);
      pmi = p.meeting; meetings = l.meetings;
    } catch { /* server briefly unreachable: keep what we have */ }
    renderAll();
    reminders?.tick();
  }

  // Every occurrence of a meeting inside [from, to) (repeating meetings expand into several).
  function occurrences(m, from, to) {
    if (!m.start) return [];
    const s = new Date(m.start), dur = m.durationMin * 60_000, out = [];
    const add = (d) => { if (d.getTime() + dur > from && d < to) out.push({ m, start: d, end: new Date(d.getTime() + dur) }); };
    if (m.repeat === 'none') { add(s); return out; }
    for (let i = 0; i < 800; i++) {
      let d;
      if (m.repeat === 'daily') d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i, s.getHours(), s.getMinutes());
      else if (m.repeat === 'weekly') d = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * i, s.getHours(), s.getMinutes());
      else { d = new Date(s.getFullYear(), s.getMonth() + i, s.getDate(), s.getHours(), s.getMinutes()); if (d.getDate() !== s.getDate()) continue; }
      if (d >= to) break;
      add(d);
    }
    return out;
  }
  const matches = (m) => !query || [m.topic, m.id, fmtId(m.id), ...(m.invitees ?? [])].some((v) => String(v).toLowerCase().includes(query));
  const itemsBetween = (from, to) => meetings.filter(matches).flatMap((m) => occurrences(m, from, to)).sort((a, b) => a.start - b.start);
  const dayItems = (day) => itemsBetween(startOfDay(day), new Date(startOfDay(day).getTime() + DAY));

  // ---------------------------------------------------------------- invitation text, calendar export
  const linkFor = (m) => `${location.origin}/?room=${m.id}${m.passcode ? `&pwd=${encodeURIComponent(m.passcode)}` : ''}`;
  function invitation(m) {
    const lines = [`${m.hostName || 'The host'} is inviting you to a scheduled SanWe's meeting.`, '', `Topic: ${m.topic}`];
    if (m.start) {
      const s = new Date(m.start);
      lines.push(`Time: ${fmt(s, { dateStyle: 'medium', timeStyle: 'short' }, m.tz)} (${m.tz.replace(/_/g, ' ')})`);
      if (m.repeat !== 'none') lines.push(`Repeats: ${m.repeat}`);
    }
    lines.push('', "Join SanWe's Meeting", linkFor(m), '', `Meeting ID: ${fmtId(m.id)}`);
    if (m.passcode) lines.push(`Passcode: ${m.passcode}`);
    if (m.agenda) lines.push('', `Agenda: ${m.agenda}`);
    return lines.join('\n');
  }
  const icsTime = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = (line) => { const out = []; let rest = line; while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ` ${rest.slice(74)}`; } out.push(rest); return out.join('\r\n'); };
  function buildIcs(m) {
    const s = new Date(m.start), e = new Date(s.getTime() + m.durationMin * 60_000);
    const rule = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' }[m.repeat];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', "PRODID:-//SanWe's//Meetings//EN", 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      `UID:${m.id}-${s.getTime()}@sanwes`, `DTSTAMP:${icsTime(new Date())}`, `DTSTART:${icsTime(s)}`, `DTEND:${icsTime(e)}`,
      `SUMMARY:${icsText(m.topic)}`, `DESCRIPTION:${icsText(invitation(m))}`, `LOCATION:${icsText(linkFor(m))}`, `URL:${linkFor(m)}`,
      ...(rule ? [`RRULE:${rule}`] : []),
      ...(reminders?.icsAlarms(m) ?? []),
      ...(m.invitees ?? []).map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a}`),
      'END:VEVENT', 'END:VCALENDAR'];
    return `${lines.map(fold).join('\r\n')}\r\n`;
  }
  function downloadIcs(m) {
    const url = URL.createObjectURL(new Blob([buildIcs(m)], { type: 'text/calendar;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${m.topic.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'meeting'}.ics` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function googleUrl(m) {
    const s = new Date(m.start), e = new Date(s.getTime() + m.durationMin * 60_000);
    const q = new URLSearchParams({ action: 'TEMPLATE', text: m.topic, dates: `${icsTime(s)}/${icsTime(e)}`, details: invitation(m), location: linkFor(m) });
    if (m.invitees?.length) q.set('add', m.invitees.join(','));
    if (m.repeat !== 'none') q.set('recur', `RRULE:FREQ=${m.repeat.toUpperCase()}`);
    return `https://calendar.google.com/calendar/render?${q}`;
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg, 'info'); } catch { window.prompt('Copy this text:', text); }
  }

  // ---------------------------------------------------------------- meeting rows (home card + meetings page)
  function row(o) {
    const { m } = o;
    const li = document.createElement('div'); li.className = 'event';
    const time = document.createElement('div'); time.className = 'ev-time';
    time.textContent = `${timeStr(o.start)} - ${timeStr(o.end)}`;
    const body = document.createElement('div'); body.className = 'ev-body';
    const title = document.createElement('div'); title.className = 'ev-title'; title.textContent = m.topic;
    const sub = document.createElement('div'); sub.className = 'ev-sub';
    sub.textContent = `Meeting ID: ${fmtId(m.id)}${m.repeat !== 'none' ? ` · Repeats ${m.repeat}` : ''}${m.personal ? ' · Personal room' : ''}`;
    const mins = Math.round((o.start - Date.now()) / 60_000);
    if (mins >= -5 && mins <= 60) { const soon = document.createElement('span'); soon.className = 'ev-soon'; soon.textContent = mins > 1 ? ` · Starts in ${mins} min` : mins === 1 ? ' · Starts in 1 min' : mins === 0 ? ' · Starting now' : ` · Started ${-mins} min ago`; sub.append(soon); }
    body.append(title, sub);
    const acts = document.createElement('div'); acts.className = 'ev-actions';
    const b = (text, cls, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = text; x.onclick = fn; return x; };
    acts.append(
      b('Start', 'primary', () => startMeeting(m, { cam: m.hostVideo })),
      b('Copy invitation', 'secondary', () => copyText(invitation(m), 'Invitation copied.')),
      b('Edit', 'secondary', () => openSchedule(m)),
    );
    if (!m.personal) acts.append(b('Delete', 'secondary danger-text', async () => {
      if (!confirm(`Delete "${m.topic}"?`)) return;
      try { await api('/api/meetings/delete', owner({ id: m.id })); await loadMeetings(); } catch (e) { toast(e.message); }
    }));
    li.append(time, body, acts);
    const taskLine = tasksUi.line(m); if (taskLine) li.append(taskLine); // status and buttons of a class that runs itself
    return li;
  }

  // ---------------------------------------------------------------- home: upcoming card
  // Meetings you were in recently (kept in this browser), shown under today's schedule like a call history.
  const recentList = () => { try { return JSON.parse(store.get('sanwes.recent') ?? '[]'); } catch { return []; } };
  function renderRecent() {
    const todays = recentList().filter((r) => sameDay(new Date(r.start), homeDay));
    const box = $('recent-list');
    box.replaceChildren(...(todays.length ? [Object.assign(document.createElement('div'), { className: 'recent-head', textContent: 'Recent' })] : []), ...todays.map((r) => {
      const el = document.createElement('div'); el.className = 'recent';
      const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ic.setAttribute('class', 'ic small'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-cam'); ic.append(u);
      const body = document.createElement('div'); body.className = 'rc-body';
      const t = document.createElement('div'); t.className = 'rc-title'; t.textContent = r.title;
      const sub = document.createElement('div'); sub.className = 'rc-sub';
      sub.textContent = `${fmt(new Date(r.start), { month: 'short', day: 'numeric' })} · ${timeStr(new Date(r.start))} - ${timeStr(new Date(r.end))}${r.host ? ` · Host: ${r.host}` : ''}`;
      body.append(t, sub);
      const acts = document.createElement('div'); acts.className = 'rc-actions';
      const mk = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn; return b; };
      acts.append(mk('Rejoin', 'secondary', () => openJoin({ id: r.id })), mk('Remove', 'secondary', () => { store.set('sanwes.recent', JSON.stringify(recentList().filter((x) => x.start !== r.start))); renderRecent(); }));
      el.append(ic, body, acts);
      return el;
    }));
  }

  function renderUpcoming() {
    renderRecent();
    const today = sameDay(homeDay, new Date());
    $('up-title').textContent = today ? `Today, ${fmt(homeDay, { month: 'short', day: 'numeric' })}` : fmt(homeDay, { weekday: 'short', month: 'short', day: 'numeric' });
    const items = dayItems(homeDay);
    $('up-list').replaceChildren(...items.map(row));
    $('up-empty').hidden = items.length > 0;
  }
  $('up-today').onclick = () => { homeDay = startOfDay(new Date()); renderUpcoming(); };
  $('up-prev').onclick = () => { homeDay = new Date(homeDay.getTime() - DAY); renderUpcoming(); };
  $('up-next').onclick = () => { homeDay = new Date(homeDay.getTime() + DAY); renderUpcoming(); };
  $('up-add').onclick = () => openSchedule();
  $('up-empty-link').onclick = () => openSchedule();

  // ---------------------------------------------------------------- meetings page: mini calendar + agenda / day view
  function renderCalendar() {
    $('cal-title').textContent = fmt(calMonth, { month: 'long', year: 'numeric' });
    const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    const busy = new Set(itemsBetween(gridStart, new Date(gridStart.getTime() + 42 * DAY)).map((o) => startOfDay(o.start).getTime()));
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const c = document.createElement('button'); c.type = 'button'; c.className = 'cal-day';
      c.textContent = String(d.getDate());
      c.classList.toggle('other', d.getMonth() !== calMonth.getMonth());
      c.classList.toggle('today', sameDay(d, new Date()));
      c.classList.toggle('selected', sameDay(d, selDay));
      c.classList.toggle('busy', busy.has(startOfDay(d).getTime()));
      c.onclick = () => { selDay = startOfDay(d); if (d.getMonth() !== calMonth.getMonth()) calMonth = new Date(d.getFullYear(), d.getMonth(), 1); renderMeetingsPage(); };
      cells.push(c);
    }
    $('cal-grid').replaceChildren(...cells);
  }
  function renderMeetingsPage() {
    renderCalendar();
    $('mt-title').textContent = fmt(view === 'day' ? selDay : calMonth, view === 'day' ? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' } : { month: 'long', year: 'numeric' });
    const from = startOfDay(selDay), to = new Date(from.getTime() + (view === 'day' ? 1 : 90) * DAY);
    const items = itemsBetween(from, to);
    const out = [];
    let lastDay = null;
    for (const o of items) {
      const k = startOfDay(o.start).getTime();
      if (view === 'agenda' && k !== lastDay) { const h = document.createElement('div'); h.className = 'ag-day'; h.textContent = fmt(o.start, { weekday: 'long', month: 'long', day: 'numeric' }); out.push(h); lastDay = k; }
      out.push(row(o));
    }
    $('mt-list').replaceChildren(...out);
    $('mt-empty').hidden = items.length > 0;
    $('mt-empty-sub').textContent = query ? `Nothing matches "${query}".` : view === 'day' ? 'Nothing scheduled for this day.' : 'Schedule a meeting to see it here.';
    if (pmi) { $('pmi-id').textContent = fmtId(pmi.id); }
  }
  $('cal-prev').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderMeetingsPage(); };
  $('cal-next').onclick = () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderMeetingsPage(); };
  $('mt-today').onclick = () => { selDay = startOfDay(new Date()); calMonth = new Date(selDay.getFullYear(), selDay.getMonth(), 1); renderMeetingsPage(); };
  $('mt-prev').onclick = () => { selDay = new Date(selDay.getTime() - (view === 'day' ? 1 : 30) * DAY); calMonth = new Date(selDay.getFullYear(), selDay.getMonth(), 1); renderMeetingsPage(); };
  $('mt-next').onclick = () => { selDay = new Date(selDay.getTime() + (view === 'day' ? 1 : 30) * DAY); calMonth = new Date(selDay.getFullYear(), selDay.getMonth(), 1); renderMeetingsPage(); };
  $('mt-view').onchange = () => { view = $('mt-view').value; renderMeetingsPage(); };
  $('mt-add').onclick = () => openSchedule();
  $('mt-empty-btn').onclick = () => openSchedule();
  $('pmi-start').onclick = () => pmi && startMeeting(pmi, { cam: false });
  $('pmi-copy').onclick = () => pmi && copyText(invitation(pmi), 'Invitation to your Personal Meeting Room copied.');

  // ---------------------------------------------------------------- search (Ctrl+E)
  $('global-search').oninput = () => { query = $('global-search').value.trim().toLowerCase(); if (query && $('page-meetings').hidden) showPage('meetings'); else renderAll(); };
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && !$('join').hidden) { e.preventDefault(); $('global-search').focus(); } });

  // ---------------------------------------------------------------- schedule dialog ("New event")
  const schedDlg = $('sched-dialog');
  let editing = null, durMin = 30;
  const zones = (() => {
    let list; try { list = Intl.supportedValuesOf('timeZone'); } catch { list = ['UTC']; }
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!list.includes(local)) list = [local, ...list];
    return list.map((z) => ({ z, off: tzOffsetMs(Date.now(), z) })).sort((a, b) => a.off - b.off || a.z.localeCompare(b.z));
  })();
  $('s-tz').replaceChildren(...zones.map(({ z }) => new Option(gmtLabel(z), z)));

  const readStart = () => zonedToUtc($('s-start-date').value, $('s-start-time').value || '00:00', $('s-tz').value);
  function syncEnd() {
    const e = new Date(readStart().getTime() + durMin * 60_000), w = wallClock(e, $('s-tz').value);
    $('s-end-date').value = w.date; $('s-end-time').value = w.time;
  }
  for (const id of ['s-start-date', 's-start-time', 's-tz']) $(id).onchange = () => { if ($('s-start-date').value) syncEnd(); };
  for (const id of ['s-end-date', 's-end-time']) $(id).onchange = () => {
    const end = zonedToUtc($('s-end-date').value, $('s-end-time').value || '00:00', $('s-tz').value), mins = Math.round((end - readStart()) / 60_000);
    if (mins >= 5) durMin = mins; else { $('s-error').textContent = 'The meeting must end at least 5 minutes after it starts.'; syncEnd(); }
  };

  function openSchedule(m = null) {
    editing = m && m.start !== undefined && m.id ? m : null;
    $('s-error').textContent = '';
    $('s-heading').textContent = editing ? 'Edit event' : 'New event';
    const tz = editing?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    $('s-tz').value = tz;
    $('s-title').value = editing?.topic ?? `${myName}'s Meeting`;
    let start;
    if (editing?.start) { start = new Date(editing.start); durMin = editing.durationMin || 30; }
    else { start = new Date(Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000); durMin = 30; }
    const w = wallClock(start, tz);
    $('s-start-date').value = w.date; $('s-start-time').value = w.time; syncEnd();
    $('s-repeat').value = editing?.repeat ?? 'none';
    const rem = Array.isArray(editing?.reminders) ? editing.reminders : null;
    $('s-remind').value = rem === null ? 'default' : rem.length ? String(rem[0]) : 'none';
    $('s-remind2').value = rem && rem.length > 1 ? String(rem[1]) : 'none';
    $('s-remind2').disabled = $('s-remind').value === 'default' || $('s-remind').value === 'none';
    $('s-invitees').value = (editing?.invitees ?? []).join(', ');
    $('s-agenda').value = editing?.agenda ?? '';
    $('s-agenda').hidden = !editing?.agenda; $('s-agenda-link').hidden = !!editing?.agenda;
    $('s-id-auto').checked = !editing?.personal; $('s-id-pmi').checked = !!editing?.personal;
    $('s-id-pmi-label').textContent = `Personal Meeting ID ${pmi ? fmtId(pmi.id) : ''}`;
    $('s-idmode').hidden = !!editing && !editing.personal ? true : false;
    $('s-pass').checked = editing ? !!editing.passcode : true;
    $('s-waiting').checked = editing ? editing.waiting : false;
    $('s-jbh').checked = editing?.joinBeforeHost ?? false;
    $('s-mute').checked = editing?.muteOnEntry ?? false;
    $('s-unmute').checked = editing?.allowUnmute !== false; $('s-allowvid').checked = editing?.allowVideo !== false;
    $('s-hv').checked = editing?.hostVideo ?? false;
    $('s-pv').checked = editing?.participantVideo ?? false;
    $('s-more').hidden = true; $('s-more-btn').textContent = 'More Options';
    $('s-cal-none').checked = true;
    $('s-save').disabled = false;
    schedDlg.showModal();
    $('s-title').select();
    tasksUi.fill(editing).then((has) => { if (has) { $('s-more').hidden = false; $('s-more-btn').textContent = 'Fewer Options'; } });
  }
  $('s-close').onclick = () => schedDlg.close();
  $('s-agenda-link').onclick = () => { $('s-agenda').hidden = false; $('s-agenda-link').hidden = true; $('s-agenda').focus(); };
  $('s-more-btn').onclick = () => { $('s-more').hidden = !$('s-more').hidden; $('s-more-btn').textContent = $('s-more').hidden ? 'More Options' : 'Fewer Options'; };

  $('sched-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('s-error'); err.textContent = '';
    const invitees = $('s-invitees').value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const bad = invitees.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad) { err.textContent = `"${bad}" is not a valid email address.`; return; }
    if (!$('s-title').value.trim()) { err.textContent = 'Give the meeting a topic.'; return; }
    if (!$('s-start-date').value || !$('s-start-time').value) { err.textContent = 'Pick a start date and time.'; return; }
    const extra = tasksUi.read();
    if (extra.error) { err.textContent = extra.error; $('s-more').hidden = false; $('s-more-btn').textContent = 'Fewer Options'; return; }
    const pmiMode = $('s-id-pmi').checked && !editing;
    $('s-save').disabled = true;
    try {
      const { meeting } = await api('/api/meetings/save', owner({
        id: editing?.id, idMode: pmiMode || editing?.personal ? 'personal' : 'auto',
        topic: $('s-title').value.trim(), start: readStart().toISOString(), durationMin: durMin, tz: $('s-tz').value,
        repeat: $('s-repeat').value, invitees, agenda: $('s-agenda').value.trim(),
        passcode: $('s-pass').checked, waiting: $('s-waiting').checked, joinBeforeHost: $('s-jbh').checked,
        muteOnEntry: $('s-mute').checked, allowUnmute: $('s-unmute').checked, allowVideo: $('s-allowvid').checked, hostVideo: $('s-hv').checked, participantVideo: $('s-pv').checked,
        reminders: readReminders(), ...extra,
      }));
      schedDlg.close();
      await loadMeetings();
      const cal = document.querySelector('input[name="s-cal"]:checked')?.value;
      if (cal === 'google') window.open(googleUrl(meeting), '_blank', 'noopener');
      if (cal === 'ics') downloadIcs(meeting);
      showDone(meeting);
    } catch (ex) { err.textContent = ex.message; $('s-save').disabled = false; }
  });

  // ---------------------------------------------------------------- "meeting scheduled" confirmation
  function showDone(m) {
    $('d-title').textContent = editing ? 'Meeting updated' : 'Meeting scheduled';
    $('d-topic').textContent = m.topic;
    const s = new Date(m.start);
    $('d-when').textContent = `${fmt(s, { dateStyle: 'full', timeStyle: 'short' }, m.tz)} · ${m.durationMin} min${m.repeat !== 'none' ? ` · repeats ${m.repeat}` : ''}`;
    $('d-when').textContent += ` · Reminder: ${reminders.describe(m)}`;
    $('d-text').value = invitation(m);
    $('d-copy').onclick = () => copyText(invitation(m), 'Invitation copied.');
    $('d-google').onclick = () => window.open(googleUrl(m), '_blank', 'noopener');
    $('d-ics').onclick = () => downloadIcs(m);
    $('sched-done').showModal();
  }
  $('d-close').onclick = () => $('sched-done').close();

  // ---------------------------------------------------------------- game rooms / hangouts (create dialog) and the live rooms list
  const createDlg = $('create');
  const syncCreateType = () => { $('c-game-l').hidden = $('c-type').value !== 'game'; };
  $('c-type').onchange = syncCreateType;
  function openCreate() { $('c-error').textContent = ''; syncCreateType(); createDlg.showModal(); $('c-title').focus(); }
  $('c-cancel').onclick = () => createDlg.close();
  $('c-cover').onchange = () => { const f = $('c-cover').files[0]; $('c-preview').hidden = !f; if (f) $('c-preview').src = URL.createObjectURL(f); };

  // Crop to 16:9 and shrink to 640x360 JPEG: keeps uploads tiny and strips odd formats / metadata.
  async function prepareCover(file) {
    const bmp = await createImageBitmap(file);
    const W = 640, H = 360, scale = Math.max(W / bmp.width, H / bmp.height);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    canvas.getContext('2d').drawImage(bmp, (W - bmp.width * scale) / 2, (H - bmp.height * scale) / 2, bmp.width * scale, bmp.height * scale);
    return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not read that image'))), 'image/jpeg', 0.88));
  }
  $('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('c-error'), submit = e.submitter ?? $('create-form').querySelector('button[type=submit]');
    err.textContent = '';
    const title = $('c-title').value.trim().replace(/[^\w .\-]/g, '').trim();
    if (!title) { err.textContent = 'Use letters, numbers, spaces, . or - in the name.'; return; }
    submit.disabled = true;
    try {
      let cover = '';
      const file = $('c-cover').files[0];
      if (file) {
        const up = await fetch('/api/covers', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: await prepareCover(file) });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(j.error ?? 'Cover upload failed.');
        cover = j.cover;
      }
      const passcode = $('c-passcode').value.trim();
      const r = await api('/api/rooms', { room: title, name: myName, type: $('c-type').value, game: $('c-game').value, title, cover, password: $('c-password').value, waiting: $('c-waiting').checked, passcode });
      createDlg.close();
      await enter({ roomName: r.room, hostSecret: r.hostSecret, password: passcode, media: { mic: true, cam: false } });
    } catch (ex) {
      if (ex.passwordRequired) $('c-password').hidden = false;
      err.textContent = ex.message;
    } finally { submit.disabled = false; }
  });

  function renderRooms(rooms) {
    const list = $('room-list');
    list.replaceChildren(...rooms.map((r) => {
      const card = document.createElement('div'); card.className = 'room-card';
      const body = document.createElement('div'); body.className = 'rbody';
      const title = document.createElement('div'); title.className = 'rt'; title.textContent = r.title;
      const sub = document.createElement('div'); sub.className = 'rs';
      sub.textContent = [r.type === 'game' && r.game ? r.game : TYPE_LABEL[r.type], r.host && `by ${r.host}`].filter(Boolean).join(' · ');
      const meta = document.createElement('div'); meta.className = 'rs';
      meta.textContent = `${r.locked ? '🔒 ' : ''}${r.participants} ${r.type === 'game' ? 'watching' : 'in call'}${r.play ? ' · 🎮 taking play requests' : ''}`;
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = r.type === 'game' ? 'Watch' : 'Join';
      btn.onclick = () => {
        if (r.locked) openJoin({ id: r.name, needPass: true, msg: 'This room needs a passcode.' }); // the only case that has to ask for anything
        else enter({ roomName: r.name, media: { mic: true, cam: false } });
      };
      body.append(title, sub, meta, btn);
      card.append(coverEl(r.cover, r.title, 'rcover'), body);
      if (r.type === 'game') { const b = document.createElement('span'); b.className = 'badge'; b.textContent = r.play ? 'GAME · PLAY' : 'GAME'; card.append(b); }
      return card;
    }));
    $('rooms-empty').hidden = rooms.length > 0;
  }
  async function refreshRooms() {
    if ($('join').hidden || !account) return;
    try {
      const res = await fetch('/api/rooms');
      if (res.status === 401) { window.dispatchEvent(new Event('sanwes:signed-out')); return; }
      if (!res.ok) return;
      const { rooms, enabled } = await res.json();
      $('rooms').hidden = !enabled;
      if (enabled) renderRooms(rooms);
    } catch { /* server briefly unreachable: keep the last list */ }
  }

  // ---------------------------------------------------------------- render + public hooks
  function renderAll() { renderUpcoming(); if (!$('page-meetings').hidden) renderMeetingsPage(); }

  // An invitation link (?room=ID&pwd=PASSCODE) opens the join dialog with everything filled in.
  // Starts once you are signed in (and again if you sign in as someone else).
  let started = false;
  function start(user) {
    account = user; myName = user.displayName; store.set('sanwes.name', myName); paintProfile();
    meetings = []; pmi = null; renderAll();
    loadMeetings(); refreshRooms();
    if (started) return;
    started = true;
    const params = new URLSearchParams(location.search);
    if (params.get('room') && params.get('autopilot')) { autopilotMode = true; history.replaceState(null, '', '/'); autopilotJoin(params.get('room')); } // the class window SanWe's opened by itself
    else if (params.get('room')) openJoin({ id: params.get('room'), pass: params.get('pwd') ?? '', needPass: !!params.get('pwd') });
    setInterval(refreshRooms, 3000);
    setInterval(() => { if (account && !$('join').hidden && !document.hidden) loadMeetings(); }, 30_000);
    setInterval(() => { if (account && !$('join').hidden && !document.hidden) renderUpcoming(); }, 30_000); // "Starts in N min" stays right
    setInterval(() => { if (account && $('join').hidden && $('auth').hidden && !document.hidden) loadMeetings(); }, 120_000); // in a call: still pick up changes for reminders
  }

  return {
    // called when the meeting window closes and the home screen comes back
    onLeft(message, ended) {
      if (ended && ended.end - ended.start >= 3000) store.set('sanwes.recent', JSON.stringify([ended, ...recentList()].slice(0, 15)));
      banner(message ?? ''); loadMeetings(); refreshRooms(); renderUpcoming();
    },
    name: () => myName,
    start,
    openProfile,
    paintReminderSettings: () => reminders.paintSettings(),
    setRoomNameFn(fn) { roomNameFn = fn; },
  };
}
