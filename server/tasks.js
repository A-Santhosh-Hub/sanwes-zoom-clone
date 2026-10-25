// Class tasks: a scheduled meeting can start itself, play videos in it, and record itself.
//   - A video library (data/media/*) the administrator fills once (waiting-room song, prayer, ...).
//   - A scheduler that, at the meeting's start time, opens the room with its owner as host and sends a "class bot".
//   - The class bot is a hidden Edge/Chrome page (client/bot.html) that joins the room as the participant "Class video",
//     plays the chosen videos on a timeline, and records the class (picture and sound) to this computer's Videos folder.
//   - Endpoints for the "Class tasks" board (start now, stop video, record on/off) and for the bot itself.
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { createLimiter } from './limiter.js';

const MEDIA_MAX = (Number(process.env.MEDIA_MAX_MB) || 4096) * 1024 * 1024;
const MEDIA_TYPES = { mp4: 'video/mp4', webm: 'video/webm' };
const RECORD_MODES = new Set(['off', 'start', 'videos', 'speech']);
const PROTECT_MODES = new Set(['off', 'watermark', 'app']);
const MAX_STEPS = 6;
// What the class video costs: every student receives it, so 400 students pull 400 times this from the host computer's upload.
const QUALITY = { low: { w: 640, h: 360, fps: 24, kbps: 350 }, standard: { w: 1280, h: 720, fps: 30, kbps: 1100 }, high: { w: 1280, h: 720, fps: 30, kbps: 1800 } };

// ---- time zones: the n-th occurrence of a repeating meeting, on the wall clock of the meeting's own time zone
function wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
function zonedToUtc(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) { const w = wall(guess, tz); const diff = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - want; if (!diff) break; guess -= diff; }
  return guess;
}
function occurrence(m, k) {
  const startMs = Date.parse(m.start);
  if (k === 0 || m.repeat === 'none') return startMs;
  const b = wall(startMs, m.tz);
  if (m.repeat === 'daily') return zonedToUtc(b.y, b.mo, b.d + k, b.h, b.mi, m.tz);
  if (m.repeat === 'weekly') return zonedToUtc(b.y, b.mo, b.d + 7 * k, b.h, b.mi, m.tz);
  const mo = b.mo - 1 + k, y = b.y + Math.floor(mo / 12), mm = (mo % 12 + 12) % 12;
  if (b.d > new Date(Date.UTC(y, mm + 1, 0)).getUTCDate()) return null; // e.g. the 31st in a 30-day month
  return zonedToUtc(y, mm + 1, b.d, b.h, b.mi, m.tz);
}
/** The occurrence of m that is running at `now` (started, not yet past its length), or null. */
export function activeOccurrence(m, now = Date.now()) {
  if (!m.start || m.personal) return null;
  const dur = (m.durationMin || 30) * 60_000;
  if (m.repeat === 'none') { const s = Date.parse(m.start); return now >= s && now < s + dur ? s : null; }
  const s0 = Date.parse(m.start); if (now < s0) return null;
  const day = 86_400_000;
  const est = m.repeat === 'daily' ? Math.floor((now - s0) / day) : m.repeat === 'weekly' ? Math.floor((now - s0) / (7 * day)) : Math.floor((now - s0) / (30 * day));
  for (let k = Math.max(0, est + 2); k >= Math.max(0, est - 2); k--) {
    const o = occurrence(m, k);
    if (o !== null && o <= now && now < o + dur) return o;
  }
  return null;
}
/** The next occurrence that has not started yet. */
export function nextOccurrence(m, now = Date.now()) {
  if (!m.start || m.personal) return null;
  const s0 = Date.parse(m.start);
  if (m.repeat === 'none' || now < s0) return s0 > now ? s0 : null;
  const day = 86_400_000;
  const est = m.repeat === 'daily' ? Math.floor((now - s0) / day) : m.repeat === 'weekly' ? Math.floor((now - s0) / (7 * day)) : Math.floor((now - s0) / (30 * day));
  for (let k = Math.max(0, est); k <= est + 40; k++) { const o = occurrence(m, k); if (o !== null && o > now) return o; }
  return null;
}

function findBrowser() {
  const c = [process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return c.find((p) => p && existsSync(p)) ?? null;
}

const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Class';
const pad2 = (n) => String(n).padStart(2, '0');

export async function initTasks(ctx) {
  const { app, auth, scheduled, persist, roomService, startScheduledRoom, findRoom, dataDir, port, apiKey, apiSecret, livekitApiUrl, cleanTitle } = ctx;
  const mediaDir = path.join(dataDir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const mediaFile = path.join(dataDir, 'media.json');
  const library = new Map(); // id -> { id, owner, name, size, ext, createdAt }
  try { for (const x of JSON.parse(await fs.readFile(mediaFile, 'utf8')).media ?? []) library.set(x.id, x); } catch { /* first run */ }
  let saveT;
  const saveLibrary = () => { clearTimeout(saveT); saveT = setTimeout(async () => { try { const tmp = `${mediaFile}.tmp`; await fs.writeFile(tmp, JSON.stringify({ media: [...library.values()] }, null, 1)); await fs.rename(tmp, mediaFile); } catch (e) { console.error(`saving media list failed: ${e.message}`); } }, 200); };
  const recordingsRoot = process.env.RECORDINGS_DIR || path.join(os.homedir(), 'Videos', "SanWe's Recordings");
  const rate = createLimiter({ windowMs: 60_000, max: 240 });
  const uploadLimiter = createLimiter({ windowMs: 60 * 60_000, max: 60 });

  // =================================================================== video library
  const mediaView = (x) => ({ id: x.id, name: x.name, size: x.size, ext: x.ext, createdAt: x.createdAt });
  const canSee = (x, u) => x.owner === u.id || u.role === 'admin';
  const usedBy = (id) => [...scheduled.values()].filter((m) => m.auto?.steps?.some((s) => s.media === id)).map((m) => m.topic);

  app.get('/api/media', (req, res) => {
    const u = auth.requireUser(req, res); if (!u) return;
    res.set('Cache-Control', 'no-store').json({ media: [...library.values()].filter((x) => canSee(x, u)).sort((a, b) => b.createdAt - a.createdAt).map(mediaView), maxMb: Math.round(MEDIA_MAX / 1048576) });
  });

  app.put('/api/media', (req, res) => {
    const u = auth.requireUser(req, res); if (!u) return;
    if (!uploadLimiter.hit(req.ip).ok) return res.status(429).json({ error: 'Too many uploads. Try again later.' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > MEDIA_MAX) return res.status(413).json({ error: `Videos can be up to ${Math.round(MEDIA_MAX / 1048576)} MB.` });
    const id = randomBytes(8).toString('hex'), tmp = path.join(mediaDir, `${id}.part`);
    const name = cleanTitle(String(req.query.name ?? '').replace(/\.[A-Za-z0-9]{2,5}$/, ''), 80) || 'Video';
    const out = createWriteStream(tmp);
    let size = 0, head = Buffer.alloc(0), done = false;
    const fail = (code, error) => { if (done) return; done = true; out.destroy(); fs.rm(tmp, { force: true }).catch(() => {}); if (!res.headersSent) res.status(code).json({ error }); };
    req.on('data', (c) => {
      size += c.length;
      if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
      if (size > MEDIA_MAX) { fail(413, `Videos can be up to ${Math.round(MEDIA_MAX / 1048576)} MB.`); req.destroy(); }
    });
    req.on('aborted', () => fail(400, 'Upload cancelled.'));
    req.on('error', () => fail(400, 'Upload failed.'));
    req.pipe(out);
    out.on('error', () => fail(500, 'Could not save the video on this computer.'));
    out.on('finish', async () => {
      if (done) return;
      const ext = head.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4' : head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' : null;
      if (!ext || size < 1024) return fail(400, 'That is not a video SanWe\u2019s can play. Use MP4 (H.264 + AAC) or WebM.');
      try { await fs.rename(tmp, path.join(mediaDir, `${id}.${ext}`)); } catch { return fail(500, 'Could not save the video on this computer.'); }
      done = true;
      const x = { id, owner: u.id, name, size, ext, createdAt: Date.now() };
      library.set(id, x); saveLibrary();
      res.json({ media: mediaView(x) });
    });
  });

  app.post('/api/media/delete', async (req, res) => {
    const u = auth.requireUser(req, res); if (!u) return;
    const x = library.get(String(req.body?.id ?? ''));
    if (!x || !canSee(x, u)) return res.status(404).json({ error: 'Video not found.' });
    const used = usedBy(x.id);
    if (used.length) return res.status(409).json({ error: `This video is used by: ${used.slice(0, 3).join(', ')}${used.length > 3 ? '…' : ''}. Remove it from those first.` });
    library.delete(x.id); saveLibrary();
    await fs.rm(path.join(mediaDir, `${x.id}.${x.ext}`), { force: true }).catch(() => {});
    res.json({ ok: true });
  });

  const sendMedia = (x, req, res) => res.set('Cache-Control', 'private, max-age=3600').type(MEDIA_TYPES[x.ext]).sendFile(path.join(mediaDir, `${x.id}.${x.ext}`), { acceptRanges: true });
  app.get('/api/media/:id/file', (req, res) => { // the owner previewing a video, or the class bot of a run that uses it
    const x = library.get(String(req.params.id));
    const run = runs.get(String(req.query.run ?? ''));
    if (x && run && keyOk(run, req.query.key) && run.mediaIds.has(x.id)) return sendMedia(x, req, res);
    const u = auth.requireUser(req, res); if (!u) return;
    if (!x || !canSee(x, u)) return res.status(404).json({ error: 'Video not found.' });
    sendMedia(x, req, res);
  });

  // =================================================================== what a scheduled meeting stores about tasks
  /** Validate the task fields of a "save meeting" request. Returns { cohosts, auto, protect } or { error }. */
  function sanitize(b, user) {
    const cohosts = [...new Set((Array.isArray(b.cohosts) ? b.cohosts : []).map((x) => String(x)).filter((x) => /^[\w-]{8,64}$/.test(x)))].slice(0, 100);
    for (const id of cohosts) if (!auth.userById(id)) return { error: 'One of the co-hosts you picked no longer has an account.' };
    const protect = PROTECT_MODES.has(b.protect) ? b.protect : 'off';
    const a = b.auto && typeof b.auto === 'object' ? b.auto : null;
    let auto = null;
    if (a && a.enabled === true) {
      // The steps play in the order listed. A step starts at a minute after the meeting starts, or (after: true) the moment the video above it ends.
      const steps = [];
      let lastMin = -1;
      for (const [i, s] of (Array.isArray(a.steps) ? a.steps : []).slice(0, MAX_STEPS).entries()) {
        const x = library.get(String(s?.media ?? ''));
        if (!x || !canSee(x, user)) return { error: 'Pick a video from your library for every step (or remove the empty step).' };
        const after = i > 0 && s.after === true;
        if (after) {
          if (steps[i - 1].loop) return { error: `Step ${i + 1} cannot start "right after" step ${i}, because step ${i} repeats and never ends. Give step ${i + 1} its own minute.` };
          steps.push({ media: x.id, atMin: 0, after: true, loop: s.loop === true });
          continue;
        }
        const atMin = Math.round(Number(s.atMin) * 10) / 10;
        if (!(atMin >= 0 && atMin <= 600)) return { error: `Step ${i + 1}: a video must start between 0 and 600 minutes after the meeting starts.` };
        if (atMin <= lastMin) return { error: `Step ${i + 1} starts at minute ${atMin}, which is not later than the step above it (minute ${lastMin}). Two videos cannot start at the same time.` };
        lastMin = atMin;
        steps.push({ media: x.id, atMin, after: false, loop: s.loop === true });
      }
      const record = RECORD_MODES.has(a.record) ? a.record : 'off';
      auto = { enabled: true, steps, record, recordAudio: a.recordAudio !== false, quality: QUALITY[a.quality] ? a.quality : 'standard', window: a.window !== false };
    }
    return { cohosts, auto, protect };
  }

  // =================================================================== runs (one per meeting occurrence)
  const runs = new Map(); // run id -> run
  const byMeeting = new Map(); // meeting id -> run id (the latest)
  const keyOk = (run, key) => !!run && typeof key === 'string' && key.length === run.key.length && key === run.key;
  const logDir = path.join(dataDir, 'logs');
  fs.mkdir(logDir, { recursive: true }).catch(() => {});
  const log = (run, msg) => {
    run.log.push(`${new Date().toLocaleTimeString()} ${msg}`); if (run.log.length > 60) run.log.shift();
    // every class run is also written to data/logs/classes-<date>.log, so a class that did not go as planned can be explained afterwards
    const d = new Date();
    fs.appendFile(path.join(logDir, `classes-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.log`), `${d.toLocaleTimeString()}  [${run.topic}]  ${msg}\n`).catch(() => {});
  };
  let browserPath = null, browserChecked = false;

  function killTree(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else proc.kill('SIGKILL');
    } catch { /* already gone */ }
  }

  function launchBot(run) {
    if (!browserChecked) { browserPath = findBrowser(); browserChecked = true; }
    if (!browserPath) { run.status = 'failed'; run.error = 'No Microsoft Edge or Google Chrome found on this computer (set BROWSER_PATH in .env).'; log(run, run.error); return; }
    const profile = path.join(os.tmpdir(), `sanwes-bot-${run.id}`);
    const url = `http://127.0.0.1:${port}/bot.html#run=${run.id}&key=${run.key}`;
    const args = ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
      '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion,MediaEngagementBypassAutoplayPolicies', '--window-size=1280,720', '--hide-scrollbars', url];
    const proc = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
    run.proc = proc; run.launchedAt = Date.now();
    log(run, `class bot started (${path.basename(browserPath)})`);
    proc.on('exit', () => {
      fs.rm(profile, { recursive: true, force: true }).catch(() => {});
      if (run.proc !== proc) return;
      run.proc = null; run.connected = false;
      if (run.status === 'running' && !run.stopRequested && run.restarts < 5) { // crashed: bring it back, it works out where the timeline is by itself
        run.restarts++; log(run, `class bot stopped unexpectedly, restarting (${run.restarts})`);
        setTimeout(() => { if (run.status === 'running' && !run.stopRequested) launchBot(run); }, 3000);
      } else if (run.status === 'running' || run.status === 'stopping') { run.status = run.stopRequested ? 'stopped' : 'failed'; if (!run.stopRequested) run.error = 'The class bot kept stopping.'; log(run, `class bot finished (${run.status})`); markEnded(run); }
    });
  }

  // SanWe's Studio (the desktop app) can open the class window itself and record it with the sound of the computer. It asks this server
  // every few seconds (from this computer only) whether a class needs a window.
  const studio = { seenAt: 0 };
  const studioUp = () => Date.now() - studio.seenAt < 12_000;
  const thisComputerOnly = (req) => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  function ensureBrowser() { if (!browserChecked) { browserPath = findBrowser(); browserChecked = true; } return browserPath; }

  // The class window: a REAL, visible meeting window that opens by itself on this computer, signs in as the person who owns the class,
  // joins as host with microphone (and camera, if chosen) on, exactly as if that person had clicked Start. The class bot still plays
  // the videos and records; this window is the host's own view of it, and the host can use every host tool in it.
  function openWindow(run) {
    if (!ensureBrowser()) { log(run, 'could not open the class window: no Edge or Chrome found'); return false; }
    if (run.win && run.win.exitCode === null) killTree(run.win);
    run.winN = (run.winN ?? 0) + 1; // a fresh profile folder each time, so closing an old window cannot pull the folder from under a new one
    const profile = path.join(os.tmpdir(), `sanwes-win-${run.id}-${run.winN}`);
    const url = `http://127.0.0.1:${port}/api/auto/open?run=${run.id}&key=${encodeURIComponent(run.key)}`;
    const extra = (process.env.CLASS_WINDOW_ARGS || '').split(' ').filter(Boolean); // tests: run it headless / off screen
    const args = [`--app=${url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream', '--disable-features=CalculateNativeWinOcclusion,Translate', '--disable-session-crashed-bubble', '--disable-infobars',
      ...(extra.some((x) => x.startsWith('--headless') || x === '--no-maximize') ? [] : ['--start-maximized']), ...extra.filter((x) => x !== '--no-maximize')];
    const proc = spawn(browserPath, args, { stdio: 'ignore' });
    run.win = proc;
    proc.on('error', (e) => log(run, `class window failed: ${e.message}`));
    proc.on('exit', () => { fs.rm(profile, { recursive: true, force: true }).catch(() => {}); if (run.win === proc) { run.win = null; log(run, 'class window closed'); } });
    log(run, 'class window opened on this computer');
    return true;
  }
  const windowOpen = (run) => (run.windowBy === 'studio' ? !!run.studioTaken : !!(run.win && run.win.exitCode === null));

  async function startRun(m, occ, { manual = false } = {}) {
    const old = runs.get(byMeeting.get(m.id));
    if (old && ['running', 'starting', 'stopping'].includes(old.status)) return old;
    const ownerUid = m.ownerUid;
    if (!ownerUid || !auth.userById(ownerUid)) throw new Error('Save this meeting once more so it knows who its host is.');
    const hostName = m.hostName || 'Host';
    await startScheduledRoom(m, hostName, ownerUid); // opens the room; the owner is its host from now on
    const steps = (m.auto?.steps ?? []).map((s) => ({ ...s, x: library.get(s.media) })).filter((s) => s.x);
    const run = {
      id: randomBytes(6).toString('hex'), key: randomBytes(18).toString('base64url'), meetingId: m.id, topic: m.topic, occ, manual,
      status: 'running', stopRequested: false, step: -1, playing: false, recording: false, recFile: null, connected: false, restarts: 0, error: '',
      cmds: [], log: [], proc: null, startedAt: Date.now(), lastSeen: 0, steps, mediaIds: new Set(steps.map((s) => s.media)), speaking: false, remote: 0,
      recDir: null, recParts: 0,
    };
    runs.set(run.id, run); byMeeting.set(m.id, run.id);
    const act = manual ? activeOccurrence(m) : null;
    m.autoLast = new Date(act ?? occ).toISOString(); persist();
    log(run, manual ? 'started by hand' : 'started by the schedule');
    run.windowBy = m.auto?.window === false ? 'none' : studioUp() ? 'studio' : 'edge';
    launchBot(run);
    if (run.windowBy === 'studio') {
      log(run, "class window: handed to SanWe's Studio (it also records the window)");
      setTimeout(() => { if (['running', 'starting'].includes(run.status) && !run.studioTaken) { log(run, "SanWe's Studio did not pick the class up: opening a normal window instead"); run.windowBy = 'edge'; openWindow(run); } }, 20_000);
    } else if (run.windowBy === 'edge') setTimeout(() => { if (['running', 'starting'].includes(run.status)) openWindow(run); }, 1500);
    return run;
  }
  function markEnded(run) { // a class that has finished is not started again by the schedule, even after a restart of this server
    const m = scheduled.get(run.meetingId);
    if (!m) return;
    m.autoResult = { at: Date.now(), startedAt: run.startedAt, status: run.status, error: run.error || '', recFile: run.recFile || '', manual: !!run.manual };
    if (m.autoLast && m.autoEnded !== m.autoLast) m.autoEnded = m.autoLast;
    persist();
  }
  function stopRun(run) {
    if (!run || !['running', 'starting'].includes(run.status)) return;
    run.stopRequested = true; run.status = 'stopping'; run.cmds.push({ cmd: 'quit' });
    log(run, 'stop requested');
    setTimeout(() => { if (run.proc) killTree(run.proc); if (run.status === 'stopping') { run.status = 'stopped'; markEnded(run); } }, 15_000).unref();
  }

  // The scheduler: every few seconds, start the class of any auto meeting whose time has come (once per occurrence).
  let tickBusy = false;
  async function tick() {
    if (tickBusy) return; tickBusy = true;
    try {
      const now = Date.now();
      for (const m of scheduled.values()) {
        if (!m.auto?.enabled) continue;
        const occ = activeOccurrence(m, now); if (occ === null) continue;
        const iso = new Date(occ).toISOString();
        if (m.autoLast === iso && m.autoEnded !== iso && !runs.has(byMeeting.get(m.id))) { // server restarted mid-class: carry on
          try { await startRun(m, occ); } catch (e) { console.error(`resume class task failed: ${e.message}`); }
          continue;
        }
        if (m.autoLast === iso) continue;
        try { await startRun(m, occ); } catch (e) { console.error(`class task for "${m.topic}" failed: ${e.message}`); m.autoLast = iso; persist(); }
      }
    } finally { tickBusy = false; }
  }
  setInterval(() => tick().catch(() => {}), 4000).unref();
  setTimeout(() => tick().catch(() => {}), 1500).unref();

  // =================================================================== board (for the signed-in owner)
  const mineAuto = (u) => [...scheduled.values()].filter((m) => m.ownerUid === u.id && m.auto?.enabled && !m.personal);
  const runView = (run) => run && ({
    id: run.id, status: run.status, step: run.step, stepName: run.steps[run.step]?.x?.name ?? '', playing: run.playing, recording: run.recording || !!run.studioRecording, recFile: run.recFile,
    connected: run.connected, error: run.error, remote: run.remote, speaking: run.speaking, log: run.log.slice(-14), manual: run.manual, startedAt: run.startedAt,
    nextName: run.nextName || '', nextAt: run.nextAt || 0, window: windowOpen(run), windowBy: run.windowBy || 'none',
  });
  app.get('/api/tasks/board', (req, res) => {
    const u = auth.requireUser(req, res); if (!u) return;
    if (!rate.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
    const now = Date.now();
    res.set('Cache-Control', 'no-store').json({
      browser: !!(browserChecked ? browserPath : (browserPath = findBrowser(), browserChecked = true, browserPath)),
      tasks: mineAuto(u).map((m) => ({
        id: m.id, topic: m.topic, active: activeOccurrence(m, now), next: nextOccurrence(m, now), durationMin: m.durationMin, record: m.auto.record, tz: m.tz,
        lastResult: m.autoResult ?? null,
        steps: m.auto.steps.map((s) => ({ ...s, name: library.get(s.media)?.name ?? '(deleted video)' })),
        run: runView(runs.get(byMeeting.get(m.id))),
      })).sort((a, b) => (a.active ? 0 : 1) - (b.active ? 0 : 1) || (a.next ?? 9e15) - (b.next ?? 9e15)),
    });
  });

  app.post('/api/tasks/cmd', async (req, res) => {
    const u = auth.requireUser(req, res); if (!u) return;
    if (!rate.hit(req.ip).ok) return res.status(429).json({ error: 'Too many requests.' });
    const m = scheduled.get(String(req.body?.id ?? ''));
    if (!m || m.ownerUid !== u.id || !m.auto?.enabled) return res.status(404).json({ error: 'Task not found.' });
    const cmd = String(req.body?.cmd ?? '');
    const run = runs.get(byMeeting.get(m.id));
    const live = run && ['running', 'starting'].includes(run.status);
    try {
      if (cmd === 'start') {
        if (live) return res.status(409).json({ error: 'This class is already running.' });
        const r = await startRun(m, Date.now(), { manual: true });
        return res.json({ run: runView(r) });
      }
      if (!live) return res.status(409).json({ error: 'This class is not running.' });
      if (cmd === 'stop') { stopRun(run); return res.json({ ok: true }); }
      if (cmd === 'play') { const i = Math.round(Number(req.body?.step)); if (!(i >= 0 && i < run.steps.length)) return res.status(400).json({ error: 'No such step.' }); run.cmds.push({ cmd: 'play', step: i }); return res.json({ ok: true }); }
      if (cmd === 'stopvideo') { run.cmds.push({ cmd: 'stopvideo' }); return res.json({ ok: true }); }
      if (cmd === 'window') {
        if (run.windowBy === 'studio' && studioUp()) { run.windowN = (run.windowN ?? 0) + 1; return res.json({ ok: true }); } // Studio opens it again
        run.windowBy = 'edge';
        if (!openWindow(run)) return res.status(400).json({ error: 'No Microsoft Edge or Google Chrome was found on this computer.' });
        return res.json({ ok: true });
      }
      if (cmd === 'rec') { run.cmds.push({ cmd: 'rec', on: req.body?.on === true }); return res.json({ ok: true }); }
    } catch (e) { return res.status(400).json({ error: e.message }); }
    res.status(400).json({ error: 'Unknown command.' });
  });

  app.get('/api/auto/studio/poll', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!thisComputerOnly(req)) return res.status(403).json({ error: 'This computer only.' });
    studio.seenAt = Date.now();
    const run = [...runs.values()].filter((r) => r.windowBy === 'studio' && ['running', 'starting'].includes(r.status)).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!run) return res.json({ job: null });
    run.studioTaken = true;
    res.json({ job: { run: run.id, n: run.windowN ?? 0, topic: run.topic, url: `/api/auto/open?run=${run.id}&key=${encodeURIComponent(run.key)}` }, record: !!run.wantRecord });
  });
  app.post('/api/auto/studio/status', (req, res) => { // Studio says whether it is recording, and where the file is
    if (!thisComputerOnly(req)) return res.status(403).json({ error: 'This computer only.' });
    const run = runs.get(String(req.body?.run ?? ''));
    if (run) { run.studioRecording = req.body?.recording === true; if (typeof req.body?.file === 'string' && req.body.file) run.recFile = req.body.file.slice(0, 300); if (run.studioRecording) log(run, "SanWe's Studio is recording the class window"); }
    res.json({ ok: true });
  });

  // The class window signs in through this link (made by the server for one class run; the secret in it works only while the run is live).
  app.get('/api/auto/open', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const run = runs.get(String(req.query.run ?? ''));
    const m = run && scheduled.get(run.meetingId);
    const direct = !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!keyOk(run, req.query.key) || !m?.ownerUid || !direct || !['running', 'starting', 'stopping'].includes(run.status)) return res.status(404).type('text').send('This class window link is not valid any more.');
    if (!auth.startSessionFor(req, res, m.ownerUid, false)) return res.status(404).type('text').send('The class owner has no account any more.');
    res.redirect(`/?room=${encodeURIComponent(m.id)}&autopilot=1`);
  });

  // =================================================================== the class bot talks to these (a per-run secret is the key)
  const wsUrl = livekitApiUrl.replace(/^http/, 'ws');
  const botRun = (req, res) => {
    const run = runs.get(String(req.query.run ?? ''));
    if (!keyOk(run, req.query.key)) { res.status(404).json({ error: 'Unknown run.' }); return null; }
    run.lastSeen = Date.now();
    return run;
  };
  app.get('/api/bot/config', async (req, res) => {
    const run = botRun(req, res); if (!run) return;
    const m = scheduled.get(run.meetingId);
    if (!m || run.status === 'stopped' || run.status === 'failed') return res.status(410).json({ error: 'This run is over.' });
    const at = new AccessToken(apiKey, apiSecret, { identity: `bot-${run.id}`, name: 'Class video', ttl: '12h', metadata: JSON.stringify({ role: 'bot' }) });
    at.addGrant({ roomJoin: true, room: m.id, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true, canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] });
    const q = `run=${run.id}&key=${encodeURIComponent(run.key)}`;
    res.set('Cache-Control', 'no-store').json({
      url: wsUrl, token: await at.toJwt(), room: m.id, topic: m.topic, serverNow: Date.now(), occ: run.occ, restarts: run.restarts,
      steps: run.steps.map((s, i) => ({ name: s.x.name, atMs: Math.round(s.atMin * 60_000), after: s.after === true, loop: s.loop, url: `/api/media/${s.media}/file?${q}` })),
      record: { mode: m.auto.record, audioToo: m.auto.recordAudio !== false, external: run.windowBy === 'studio' }, pub: QUALITY[m.auto.quality] ?? QUALITY.standard,
    });
  });
  app.post('/api/bot/status', (req, res) => {
    const run = botRun(req, res); if (!run) return;
    const b = req.body ?? {};
    run.connected = b.connected === true; run.step = Number.isInteger(b.step) ? b.step : -1; run.playing = b.playing === true;
    run.recording = b.recording === true; run.speaking = b.speaking === true; run.remote = Math.max(0, Number(b.remote) || 0);
    run.nextName = typeof b.nextName === 'string' ? b.nextName.slice(0, 80) : ''; run.nextAt = Number(b.nextAt) > 0 ? Number(b.nextAt) : 0;
    run.wantRecord = b.wantRecord === true; if (b.playing === true) run.error = ''; // a problem that has passed is not shown any more
    if (Array.isArray(b.logs)) for (const l of b.logs.slice(0, 20)) log(run, `bot: ${String(l).slice(0, 160)}`);
    if (typeof b.error === 'string' && b.error) { run.error = b.error.slice(0, 200); log(run, `bot: ${run.error}`); }
    if (b.event === 'bye') { run.connected = false; if (run.status === 'running' || run.status === 'stopping') run.status = run.stopRequested ? 'stopped' : 'ended'; log(run, `class ended (${run.status})`); markEnded(run); setTimeout(() => killTree(run.proc), 2000).unref(); }
    const cmds = run.cmds.splice(0);
    res.json({ cmds });
  });
  const recLimits = express.raw({ type: '*/*', limit: '64mb' });
  app.put('/api/bot/rec', recLimits, async (req, res) => {
    const run = botRun(req, res); if (!run) return;
    const kind = req.query.kind === 'audio' ? 'audio' : 'video', ext = /^(mp4|m4a|webm|ogg)$/.test(String(req.query.ext)) ? String(req.query.ext) : (kind === 'audio' ? 'm4a' : 'mp4');
    const part = Math.max(0, Math.min(99, Number(req.query.part) || 0));
    try {
      if (!run.recDir) {
        const d = new Date(run.startedAt), stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`;
        run.recDir = path.join(recordingsRoot, `${stamp} ${safeName(run.topic)}`);
        await fs.mkdir(run.recDir, { recursive: true });
      }
      const file = path.join(run.recDir, `${kind === 'audio' ? 'class_audio' : 'class'}${part ? `_${part + 1}` : ''}.${ext}`);
      if (Buffer.isBuffer(req.body) && req.body.length) await fs.appendFile(file, req.body);
      if (kind === 'video') run.recFile = file;
      res.json({ ok: true });
    } catch (e) { console.error(`saving class recording failed: ${e.message}`); res.status(500).json({ error: 'Could not save the recording.' }); }
  });

  process.on('exit', () => { for (const r of runs.values()) { killTree(r.proc); killTree(r.win); } });
  // A class bot left running by a server that was killed (not closed) would stay in its meeting: close any such window on start.
  if (process.platform === 'win32') {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome)\.exe$' -and $_.CommandLine -like '*--user-data-dir=*sanwes-bot-*' -and $_.CommandLine -like '*127.0.0.1:" + port + "/bot.html*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome)\\.exe$' -and $_.CommandLine -like '*--user-data-dir=*sanwes-win-*' -and $_.CommandLine -like '*127.0.0.1:" + port + "/api/auto/open*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
    { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  }
  return { sanitize, library, runs };
}
