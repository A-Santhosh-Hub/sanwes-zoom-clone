// Class tasks in the browser: the co-host picker and "Class automation" part of the schedule dialog,
// the video upload, and the live status line (with buttons) under a meeting that runs itself.
const REC_LABEL = { speech: 'starts when the teacher speaks', videos: 'starts when the videos end', start: 'records from the start', off: 'not recorded by itself' };
const mb = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(n / (1 << 20)))} MB`);

export function initTasksUi({ $, api, toast, getStart }) {
  const getJson = async (path) => {
    const r = await fetch(path, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.auth) window.dispatchEvent(new Event('sanwes:signed-out'));
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  };

  // ---------------------------------------------------------------- the schedule dialog
  let people = [], canList = false, library = [], maxMb = 4096;
  const picked = new Map(); // id -> { id, username, displayName }
  let steps = [];           // { media, atMin, after, loop }: atMin minutes after the start, or after (right after the video above ends)
  let isNew = true;

  async function loadLists() {
    try { const d = await getJson('/api/directory'); canList = !!d.canList; people = d.users ?? []; } catch { people = []; canList = false; }
    try { const m = await getJson('/api/media'); library = m.media ?? []; maxMb = m.maxMb ?? maxMb; } catch { library = []; }
  }

  function paintChips() {
    $('s-co-chips').replaceChildren(...[...picked.values()].map((u) => {
      const c = document.createElement('span'); c.className = 'chip';
      c.append(document.createTextNode(`${u.displayName || u.username} (@${u.username})`));
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `Remove ${u.username}`);
      x.onclick = () => { picked.delete(u.id); paintChips(); paintList(); };
      c.append(x); return c;
    }));
    $('s-co-note').textContent = picked.size ? `${picked.size} account${picked.size === 1 ? '' : 's'} will become co-host as soon as they join.` : '';
  }
  function paintList() {
    const box = $('s-co-list'), q = $('s-co-search').value.trim().toLowerCase();
    if (!canList) { box.hidden = true; return; }
    const all = people.filter((u) => !q || `${u.username} ${u.displayName}`.toLowerCase().includes(q));
    const shown = all.slice(0, 40);
    if (!q && !picked.size && all.length > 40) { /* a long list: show the first ones, search narrows it */ }
    box.replaceChildren(...shown.map((u) => {
      const l = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = picked.has(u.id);
      cb.onchange = () => { if (cb.checked) picked.set(u.id, u); else picked.delete(u.id); paintChips(); };
      l.append(cb, document.createTextNode(` ${u.displayName || u.username}  @${u.username}${u.role === 'admin' ? '  (administrator)' : ''}`));
      return l;
    }), ...(all.length > shown.length ? [Object.assign(document.createElement('div'), { className: 'co-more', textContent: `${all.length - shown.length} more: type to search` })] : []),
    ...(!all.length ? [Object.assign(document.createElement('div'), { className: 'co-more', textContent: q ? 'No account matches.' : 'No accounts yet.' })] : []));
    box.hidden = false;
  }
  $('s-co-search').addEventListener('input', paintList);
  $('s-co-search').addEventListener('focus', paintList);
  $('s-co-search').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = $('s-co-search').value.trim().replace(/^@/, ''); if (!name) return;
    const known = people.find((u) => u.username.toLowerCase() === name.toLowerCase());
    try {
      const u = known ?? (await getJson(`/api/directory/lookup?username=${encodeURIComponent(name)}`)).user;
      if (!u) { $('s-co-note').textContent = `No account called "${name}".`; return; }
      picked.set(u.id, u); $('s-co-search').value = ''; paintChips(); paintList();
    } catch (ex) { $('s-co-note').textContent = ex.message; }
  });

  // "04:40 AM" for a step that starts N minutes after the meeting starts (in the meeting's own time zone)
  const clockAt = (min) => {
    const st = getStart?.();
    if (!st?.at) return '';
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: st.tz }).format(new Date(st.at.getTime() + min * 60_000));
  };
  const stepsProblem = () => {
    let last = -1;
    for (const [i, s] of steps.entries()) {
      if (!s.media) return `Step ${i + 1}: choose a video (or remove the step).`;
      if (s.after) { if (i === 0) return 'Step 1 cannot start "right after" another video.'; if (steps[i - 1].loop) return `Step ${i + 1} cannot start right after step ${i}, because step ${i} repeats and never ends.`; continue; }
      if (!(s.atMin >= 0 && s.atMin <= 600)) return `Step ${i + 1}: the minute must be between 0 and 600.`;
      if (s.atMin <= last) return `Step ${i + 1} starts at minute ${s.atMin}, which is not later than the step above it (minute ${last}). Two videos cannot start at the same time.`;
      last = s.atMin;
    }
    return '';
  };
  function stepRow(s, i) {
    const row = document.createElement('div'); row.className = 'step-row';
    const top = document.createElement('div'); top.className = 'step-top';
    const n = Object.assign(document.createElement('span'), { className: 'step-n', textContent: String(i + 1) });
    const sel = document.createElement('select'); sel.setAttribute('aria-label', `Video for step ${i + 1}`);
    sel.append(new Option(library.length ? 'Choose a video…' : 'Upload a video first', ''));
    for (const v of library) sel.append(new Option(`${v.name} (${mb(v.size)})`, v.id));
    sel.value = s.media || ''; sel.onchange = () => { s.media = sel.value; };
    const x = document.createElement('button'); x.type = 'button'; x.className = 'step-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove this step');
    x.onclick = () => { steps.splice(i, 1); paintSteps(); };
    top.append(n, sel, x);

    const canAfter = i > 0 && !steps[i - 1].loop;
    const when = document.createElement('div'); when.className = 'step-when';
    const group = `stw-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const mk = (checked, disabled) => { const r = document.createElement('input'); r.type = 'radio'; r.name = group; r.checked = checked; r.disabled = !!disabled; return r; };
    const rMin = mk(!s.after), rAfter = mk(!!s.after, !canAfter);
    const at = document.createElement('input'); at.type = 'number'; at.min = '0'; at.max = '600'; at.step = '0.5'; at.value = String(s.atMin); at.setAttribute('aria-label', 'Minutes after the start');
    const clock = document.createElement('span'); clock.className = 'step-clock';
    const showClock = () => { const c = clockAt(Number(at.value) || 0); clock.textContent = !s.after && c ? `= ${c}` : ''; };
    at.oninput = () => { s.atMin = Math.max(0, Math.min(600, Number(at.value) || 0)); rMin.checked = true; s.after = false; showClock(); };
    at.onfocus = () => { rMin.checked = true; s.after = false; };
    rMin.onchange = () => { if (rMin.checked) { s.after = false; showClock(); } };
    rAfter.onchange = () => { if (rAfter.checked) { s.after = true; clock.textContent = ''; } };
    const l1 = document.createElement('label'); l1.append(rMin, document.createTextNode(' Starts at minute '), at, clock);
    const l2 = document.createElement('label'); l2.append(rAfter, document.createTextNode(i === 0 ? ' (the first video starts at a minute)' : canAfter ? ' Starts right after the video above ends' : ' Starts right after the video above (not possible: it repeats)'));
    if (!canAfter) l2.classList.add('dim');
    when.append(l1, l2);
    showClock();

    const rep = document.createElement('input'); rep.type = 'checkbox'; rep.checked = s.loop;
    rep.onchange = () => { s.loop = rep.checked; if (s.loop && steps[i + 1]?.after) { steps[i + 1].after = false; steps[i + 1].atMin = Math.max(s.atMin, 0) + 10; } paintSteps(); };
    const repl = document.createElement('label'); repl.className = 'step-rep'; repl.append(rep, document.createTextNode(' Repeat this video again and again until the next step starts (for a waiting-room song)'));
    row.append(top, when, repl);
    return row;
  }
  function paintSteps() {
    $('s-steps').replaceChildren(...steps.map(stepRow));
    const p = steps.length ? stepsProblem() : '';
    $('s-steps-warn').textContent = p; $('s-steps-warn').hidden = !p;
  }
  for (const id of ['s-start-date', 's-start-time', 's-tz']) $(id).addEventListener('change', () => paintSteps());
  $('s-step-add').onclick = () => {
    const last = steps[steps.length - 1];
    if (!last) steps.push({ media: library[0]?.id ?? '', atMin: 0, after: false, loop: false });
    else if (!last.loop) steps.push({ media: library[0]?.id ?? '', atMin: 0, after: true, loop: false }); // the natural next thing: play it right after the video above
    else steps.push({ media: library[0]?.id ?? '', atMin: Math.max(0, ...steps.filter((x) => !x.after).map((x) => x.atMin)) + 10, after: false, loop: false });
    paintSteps();
  };
  const QUALITY_MBIT = { low: 0.35, standard: 1.1, high: 1.8 }; // what one student downloads from this computer
  const paintQuality = () => {
    const r = QUALITY_MBIT[$('s-quality').value];
    $('s-quality-note').textContent = `Every student downloads this from the computer running SanWe's: 100 students about ${Math.round(r * 100)} Mbit/s, 400 students about ${Math.round(r * 400)} Mbit/s of upload (the teacher's camera is extra). If your internet upload is lower, pick Light.`;
  };
  $('s-quality').onchange = paintQuality;
  $('s-auto').onchange = () => {
    $('s-auto-box').hidden = !$('s-auto').checked;
    if ($('s-auto').checked && !steps.length) $('s-step-add').click();
    if ($('s-auto').checked && isNew) { $('s-mute').checked = true; $('s-unmute').checked = false; $('s-auto-people-note').hidden = false; } // a class: students join muted and cannot unmute, hosts and co-hosts can
  };

  // upload with a progress bar (a fetch cannot report upload progress)
  $('s-upload').onclick = () => $('s-upload-file').click();
  $('s-upload-file').onchange = () => {
    const f = $('s-upload-file').files[0]; $('s-upload-file').value = '';
    if (!f) return;
    if (f.size > maxMb * 1048576) { $('s-up-note').textContent = `That file is ${mb(f.size)}; the limit is ${mb(maxMb * 1048576)}.`; return; }
    const bar = $('s-up-bar'), fill = bar.firstElementChild;
    bar.hidden = false; fill.style.width = '0'; $('s-up-note').textContent = `Uploading ${f.name}…`; $('s-upload').disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/media?name=${encodeURIComponent(f.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; $('s-up-note').textContent = `Uploading ${f.name}: ${mb(e.loaded)} of ${mb(e.total)}`; } };
    xhr.onload = async () => {
      $('s-upload').disabled = false; bar.hidden = true;
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status !== 200) { $('s-up-note').textContent = j.error ?? `Upload failed (${xhr.status}).`; return; }
      $('s-up-note').textContent = `"${j.media.name}" is in your library.`;
      library.unshift(j.media);
      const empty = steps.find((s) => !s.media); if (empty) empty.media = j.media.id;
      paintSteps();
    };
    xhr.onerror = () => { $('s-upload').disabled = false; bar.hidden = true; $('s-up-note').textContent = 'Upload failed. Check the connection and try again.'; };
    xhr.send(f);
  };

  /** Fill the co-host / automation / protection parts of the dialog for a new or existing meeting. */
  async function fill(m) {
    isNew = !m; $('s-auto-people-note').hidden = true;
    picked.clear(); steps = []; $('s-co-search').value = ''; $('s-co-list').hidden = true; $('s-up-note').textContent = ''; $('s-up-bar').hidden = true;
    $('s-auto').checked = !!m?.auto?.enabled; $('s-auto-box').hidden = !m?.auto?.enabled;
    $('s-rec').value = m?.auto?.record ?? 'speech'; $('s-rec-audio').checked = m?.auto?.recordAudio !== false;
    $('s-quality').value = m?.auto?.quality ?? 'standard'; paintQuality();
    $('s-window').checked = m?.auto?.window !== false;
    $('s-protect').value = m?.protect ?? 'off';
    paintChips(); paintSteps();
    await loadLists();
    for (const id of m?.cohosts ?? []) {
      let u = people.find((x) => x.id === id);
      if (!u) { try { u = (await getJson(`/api/directory/lookup?id=${encodeURIComponent(id)}`)).user; } catch { /* gone */ } }
      if (u) picked.set(id, u);
    }
    steps = (m?.auto?.steps ?? []).map((s) => ({ media: s.media, atMin: s.atMin, after: s.after === true, loop: s.loop }));
    paintChips(); paintSteps();
    return !!(m?.auto?.enabled || m?.cohosts?.length || (m?.protect && m.protect !== 'off'));
  }
  /** What to send to /api/meetings/save. Returns { error } when something is half-filled. */
  function read() {
    const enabled = $('s-auto').checked;
    if (enabled) {
      if (!steps.length) return { error: 'Add at least one video step, or untick "Run this class by itself".' };
      const problem = stepsProblem(); if (problem) return { error: problem };
    }
    return {
      cohosts: [...picked.keys()], protect: $('s-protect').value,
      auto: enabled ? { enabled: true, steps: steps.map((s) => ({ ...s })), record: $('s-rec').value, recordAudio: $('s-rec-audio').checked, quality: $('s-quality').value, window: $('s-window').checked } : null,
    };
  }

  // ---------------------------------------------------------------- status line under a meeting row
  const lines = new Map(); // meeting id -> Set of line elements
  let board = new Map(), browserOk = true, timer = 0, getMeetings = () => [];
  const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const act = async (id, cmd, extra = {}) => {
    try { await api('/api/tasks/cmd', { id, cmd, ...extra }); await refresh(); } catch (e) { toast(e.message); }
  };

  const hhmm = (ms, tz) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: true, ...(tz ? { timeZone: tz } : {}) }).format(new Date(ms));
  const hhmmss = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  /** "04:30 AM Waiting song (repeats) -> right after: Prayer" in the meeting's time zone, from the next (or running) start */
  function planText(t) {
    const base = t.active ?? t.next; if (!base) return '';
    const parts = t.steps.map((s, i) => `${s.after ? (i ? 'then, right after' : '') : hhmm(base + s.atMin * 60_000, t.tz)} ${s.name}${s.loop ? ' (repeats)' : ''}`.trim());
    return `Plan: ${parts.join('  \u2192  ')}  \u00b7  recording ${REC_LABEL[t.record] ?? ''}`;
  }
  const RESULT_WORD = { stopped: 'stopped from the board', ended: 'finished', failed: 'stopped with a problem' };
  function paintLine(el, m) {
    const t = board.get(m.id);
    const run = t?.run, live = run && ['running', 'starting', 'stopping'].includes(run.status);
    const kids = [];
    const badge = (text, cls = '') => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; kids.push(b); return b; };
    const btn = (text, fn, cls = 'secondary') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = fn; kids.push(b); };
    badge('Runs by itself');
    if (!browserOk) badge('Edge or Chrome not found', 'warn');
    if (live) {
      badge(run.status === 'stopping' ? 'Closing…' : run.connected ? 'Class is running' : 'Starting…', 'live');
      if (run.playing) badge(`Playing: ${run.stepName || 'a video'}`);
      else if (run.nextName) badge(run.nextAt ? `Waiting. Next video "${run.nextName}" at ${hhmmss(run.nextAt)}` : `Waiting. Next video: "${run.nextName}"`);
      else badge('No video playing');
      if (run.playing && run.nextName) badge(run.nextAt ? `Then "${run.nextName}" at ${hhmmss(run.nextAt)}` : `Then "${run.nextName}"`);
      if (run.error) badge(`Problem: ${run.error}`, 'warn');
      if (run.recording) badge('Recording', 'rec');
      else if (t.record !== 'off') badge(`Recording ${REC_LABEL[t.record] ?? ''}`);
      if (run.remote) badge(`${run.remote} in the room`);
      const grow = document.createElement('span'); grow.className = 'grow'; kids.push(grow);
      if (run.playing) btn('Stop video', () => act(m.id, 'stopvideo'));
      if (t.steps.length) {
        const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Play a video now');
        t.steps.forEach((s, i) => sel.append(new Option(`${i + 1}. ${s.name}`, String(i))));
        kids.push(sel); btn('Play now', () => act(m.id, 'play', { step: Number(sel.value) }));
      }
      btn(run.window ? (run.windowBy === 'studio' ? "Class window is open in SanWe's Studio" : 'Class window is open') : 'Open the class window', () => act(m.id, 'window'), run.window ? 'secondary' : 'primary');
      btn(run.recording ? 'Stop recording' : 'Start recording', () => act(m.id, 'rec', { on: !run.recording }));
      btn('End class bot', () => { if (confirm('Stop the video player and recording for this class? The meeting itself stays open. (The class will NOT start again by itself today.)')) act(m.id, 'stop'); }, 'secondary danger-text');
    } else {
      if (run?.status === 'failed') badge(run.error || 'The class bot stopped', 'warn');
      else if (t?.lastResult) {
        const r = t.lastResult;
        badge(`Last class: ${RESULT_WORD[r.status] ?? r.status} at ${hhmm(r.at)}${r.error ? ` (${r.error})` : ''}`, r.status === 'failed' ? 'warn' : '');
      }
      const rec = run?.recFile || t?.lastResult?.recFile;
      if (rec) badge(`Saved: ${rec.replace(/^.*[\\/](?=[^\\/]+[\\/][^\\/]+$)/, '')}`);
      if (t?.active) badge('Time has come: starting', 'live');
      else if (t?.next) badge(`Next class: ${fmtTime(t.next)}`);
      const grow = document.createElement('span'); grow.className = 'grow'; kids.push(grow);
      btn('Start the class now', () => act(m.id, 'start'), 'primary');
    }
    const plan = t ? planText(t) : '';
    if (plan) { const p = document.createElement('div'); p.className = 'task-plan'; p.textContent = plan; kids.push(p); }
    el.replaceChildren(...kids);
  }

  function line(m) {
    if (!m.auto?.enabled) return null;
    const el = document.createElement('div'); el.className = 'task-line';
    if (!lines.has(m.id)) lines.set(m.id, new Set());
    lines.get(m.id).add(el);
    paintLine(el, m);
    queueMicrotask(start);
    return el;
  }
  async function refresh() {
    let b; try { b = await getJson('/api/tasks/board'); } catch { return; }
    board = new Map(b.tasks.map((t) => [t.id, t])); browserOk = b.browser;
    const ms = new Map(getMeetings().map((m) => [m.id, m]));
    for (const [id, set] of lines) {
      for (const el of [...set]) { if (!el.isConnected) { set.delete(el); continue; } const m = ms.get(id); if (m) paintLine(el, m); }
      if (!set.size) lines.delete(id);
    }
  }
  function start() { if (!timer) { refresh(); timer = setInterval(() => { if (document.hidden) return; if (![...lines.values()].some((s) => s.size)) { clearInterval(timer); timer = 0; return; } refresh(); }, 4000); } }

  return { fill, read, line, setMeetings: (fn) => { getMeetings = fn; } };
}
