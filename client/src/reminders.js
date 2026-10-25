// Meeting reminders: "Design review starts in 5 minutes" with a chime, a card on screen and (when the tab is not in
// front) a desktop notification. Modelled on how a desktop meeting client behaves: a few default reminders for every
// meeting, optional different reminders per meeting, one card per upcoming meeting, Start / Snooze / Dismiss.
// Reminders are computed in this browser from your scheduled meetings, so they fire while SanWe's is open in a tab.
// (Calendar apps ring when the page is closed: the .ics file from "Outlook / .ics" carries the same alarms.)
export const REMINDER_CHOICES = [[0, 'At the start'], [1, '1 minute before'], [2, '2 minutes before'], [3, '3 minutes before'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before']];
const KEYS = { defaults: 'sanwes.rem.defaults', sound: 'sanwes.rem.sound', desktop: 'sanwes.rem.desktop', fired: 'sanwes.rem.fired' };
const SETTING_CHOICES = [0, 1, 2, 5, 10, 15, 30];
const SNOOZE_MS = 60_000, LATE_MS = 5 * 60_000; // a meeting that started more than 5 minutes ago no longer gets a reminder
const lead = (n) => (n === 0 ? 'at the start' : n === 60 ? '1 hour before' : `${n} minute${n === 1 ? '' : 's'} before`);

export function initReminders({ $, store, getMeetings, occurrences, onStart, getRoomName, toast }) {
  const cards = new Map();   // key -> { el, m, start }
  const snoozed = new Map(); // key -> time to show again
  let audio = null;

  // ---------------------------------------------------------------- what the user asked for
  const defaults = () => { try { const v = JSON.parse(store.get(KEYS.defaults) ?? '[5]'); return Array.isArray(v) ? v.filter((n) => REMINDER_CHOICES.some(([k]) => k === n)) : [5]; } catch { return [5]; } };
  const setDefaults = (arr) => store.set(KEYS.defaults, JSON.stringify([...new Set(arr)].sort((a, b) => b - a)));
  const soundOn = () => store.get(KEYS.sound) !== '0';
  const desktopOn = () => store.get(KEYS.desktop) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  const effective = (m) => (Array.isArray(m.reminders) ? m.reminders : defaults());

  const fired = () => { try { return JSON.parse(store.get(KEYS.fired) ?? '{}'); } catch { return {}; } };
  const saveFired = (o) => { const cut = Date.now() - 36 * 3600_000; for (const k of Object.keys(o)) if (o[k] < cut) delete o[k]; store.set(KEYS.fired, JSON.stringify(o)); };

  // ---------------------------------------------------------------- sound: two soft notes. Needs one earlier tap on the page (browser rule).
  const unlock = () => { try { audio ??= new AudioContext(); audio.resume?.(); } catch { /* no audio */ } };
  addEventListener('pointerdown', unlock, { once: true, capture: true });
  addEventListener('keydown', unlock, { once: true, capture: true });
  function chime() {
    if (!soundOn() || !audio || audio.state !== 'running') return;
    const t = audio.currentTime;
    [[880, 0], [1175, 0.18]].forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
      o.start(t + d); o.stop(t + d + 0.55);
    });
  }

  // ---------------------------------------------------------------- cards
  const host = $('reminders');
  const whenText = (start) => {
    const mins = Math.round((start.getTime() - Date.now()) / 60_000);
    if (mins > 1) return `Starts in ${mins} minutes`;
    if (mins === 1) return 'Starts in 1 minute';
    if (mins === 0) return 'Starting now';
    return mins === -1 ? 'Started 1 minute ago' : `Started ${-mins} minutes ago`;
  };
  const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isOpen = () => { try { return host.matches(':popover-open'); } catch { return true; } };
  function paintHost() {
    if (cards.size && !isOpen()) { try { host.showPopover(); } catch { /* old browser: the card is fixed-position anyway */ } }
    if (!cards.size && isOpen()) { try { host.hidePopover(); } catch { /* ignore */ } }
  }
  function dismiss(key) { const c = cards.get(key); c?.el.remove(); cards.delete(key); paintHost(); }
  function show(key, m, start) {
    dismiss(key);
    const el = document.createElement('div'); el.className = 'reminder'; el.setAttribute('role', 'alert');
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); ic.setAttribute('class', 'ic'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-bell'); ic.append(u);
    const body = document.createElement('div'); body.className = 'rm-body';
    const head = document.createElement('div'); head.className = 'rm-head'; head.textContent = 'Upcoming meeting';
    const title = document.createElement('div'); title.className = 'rm-title'; title.textContent = m.topic;
    const sub = document.createElement('div'); sub.className = 'rm-sub';
    body.append(head, title, sub);
    const acts = document.createElement('div'); acts.className = 'rm-actions';
    const mk = (text, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn; acts.append(b); return b; };
    const inCall = !$('call').hidden;
    const startBtn = mk('Start', 'primary', () => { dismiss(key); onStart(m); });
    if (inCall) { startBtn.disabled = true; startBtn.title = 'Leave your current meeting first'; }
    mk('Snooze', 'secondary', () => { snoozed.set(key, Date.now() + SNOOZE_MS); dismiss(key); toast('Reminder snoozed for 1 minute.', 'info'); });
    mk('Dismiss', 'secondary', () => dismiss(key));
    const x = document.createElement('button'); x.type = 'button'; x.className = 'rm-x'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×'; x.onclick = () => dismiss(key);
    el.append(ic, body, acts, x);
    host.append(el);
    while (cards.size >= 4) dismiss(cards.keys().next().value);
    cards.set(key, { el, m, start, sub });
    const t = () => { sub.textContent = `${whenText(start)} · ${clock(start)}`; };
    t(); cards.get(key).paint = t;
    paintHost();
  }

  // ---------------------------------------------------------------- the clock: look at the next hour of meetings
  function notify(key, m, start) {
    show(key, m, start);
    chime();
    if (desktopOn() && (document.hidden || !document.hasFocus())) {
      try {
        const n = new Notification(m.topic, { body: `${whenText(start)} · ${clock(start)}`, tag: key });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* the browser refused */ }
    }
  }
  function tick() {
    const now = Date.now();
    for (const [k, c] of cards) { // keep the wording fresh; drop cards for meetings you are already in or that are long over
      if (getRoomName?.() === c.m.id || now > c.start.getTime() + 10 * 60_000) dismiss(k); else c.paint?.();
    }
    const list = getMeetings();
    if (!list?.length) return;
    const done = fired(); let dirty = false;
    for (const m of list) {
      const leads = effective(m);
      if (!leads.length) continue;
      if (getRoomName?.() === m.id) continue;
      for (const occ of occurrences(m, new Date(now - LATE_MS - 60_000), new Date(now + 61 * 60_000))) {
        const T = occ.start.getTime();
        if (now > T + LATE_MS) continue;
        const key = `${m.id}@${T}`;
        const due = leads.filter((l) => now >= T - l * 60_000);                   // reminders whose time has come
        const fresh = due.filter((l) => !done[`${key}/${l}`]);
        if (fresh.length) {                                                       // opened late? one card with the real time left
          for (const l of due) done[`${key}/${l}`] = now;
          dirty = true; notify(key, m, occ.start);
        } else if (snoozed.has(key) && now >= snoozed.get(key)) { snoozed.delete(key); notify(key, m, occ.start); }
      }
    }
    if (dirty) saveFired(done);
  }
  setInterval(tick, 10_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  // ---------------------------------------------------------------- Settings > General
  function paintSettings() {
    const box = $('rem-defaults'); box.replaceChildren();
    const have = new Set(defaults());
    for (const n of SETTING_CHOICES) {
      const lab = document.createElement('label'); lab.className = 'chip';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = have.has(n);
      cb.onchange = () => { const now = new Set(defaults()); if (cb.checked) now.add(n); else now.delete(n); setDefaults([...now]); };
      lab.append(cb, document.createTextNode(n === 0 ? 'At the start' : n === 60 ? '1 hour' : `${n} min`));
      box.append(lab);
    }
    $('rem-sound').checked = soundOn();
    $('rem-desktop').checked = desktopOn();
    $('rem-note').textContent = typeof Notification === 'undefined' ? 'This browser cannot show desktop notifications.' : Notification.permission === 'denied' ? 'Desktop notifications are blocked for this site in the browser settings.' : '';
  }
  $('rem-sound').onchange = () => { store.set(KEYS.sound, $('rem-sound').checked ? '1' : '0'); unlock(); if ($('rem-sound').checked) chime(); };
  $('rem-desktop').onchange = async () => {
    if (!$('rem-desktop').checked) { store.set(KEYS.desktop, '0'); return; }
    if (typeof Notification === 'undefined') { $('rem-desktop').checked = false; paintSettings(); return; }
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    store.set(KEYS.desktop, p === 'granted' ? '1' : '0');
    paintSettings();
  };
  $('rem-test').onclick = () => {
    unlock();
    const start = new Date(Date.now() + 5 * 60_000);
    notify('test@' + Date.now(), { id: 'test', topic: 'Test reminder', repeat: 'none' }, start);
  };

  return {
    paintSettings, tick, defaults, effective,
    // reminder alarms for a calendar file, same list the app itself uses
    icsAlarms: (m) => effective(m).flatMap((l) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${String(m.topic).replace(/[\r\n,;\\]/g, ' ')}`, `TRIGGER:${l === 0 ? 'PT0S' : `-PT${l}M`}`, 'END:VALARM']),
    describe: (m) => (Array.isArray(m.reminders) ? (m.reminders.length ? m.reminders.map(lead).join(', ') : 'no reminders') : `your default (${defaults().map(lead).join(', ') || 'none'})`),
  };
}
