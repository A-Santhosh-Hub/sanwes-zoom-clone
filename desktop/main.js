// SanWe's Studio: runs SanWe's on this computer, opens the meeting in its own window, makes a public link for guests
// and records that window (picture + the sound this computer plays + optionally your microphone).
//
// Two windows:
//   - the MEETING window: the normal SanWe's page (what you and your guests use). This is what gets recorded.
//   - the STUDIO window: a small control panel (links, public link, recording). It is never part of the recording.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, clipboard, dialog, Menu, screen } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const PORT_APP = Number(process.env.SANWES_APP_PORT) || 3000, PORT_MEDIA = Number(process.env.SANWES_MEDIA_PORT) || 7880;
const TEST = process.env.SANWES_TEST === '1'; // tests: mute the local speakers while recording, no dialogs
const OFFSCREEN = process.env.SANWES_OFFSCREEN === '1'; // tests: keep the windows off the visible screen
// Class mode: the app is started by Windows (or by hand) to run the day's classes by itself: it opens the class window when a class
// starts and records that window; the meeting window stays closed until then.
const CLASS_MODE = process.argv.includes('--class-mode') || process.env.SANWES_CLASS_MODE === '1';
const WANT_TUNNEL = process.argv.includes('--tunnel');
const ROOT = fs.existsSync(path.join(__dirname, 'backend')) ? path.join(__dirname, 'backend') : path.resolve(__dirname, '..');
// When this app sits inside the SanWe's project folder (desktop\\dist\\SanWes Studio-...\\), use that project's own accounts, videos and classes,
// so there is one set of accounts whether SanWe's was started by start-sanwes.bat or by this app.
const PROJECT = (() => {
  if (!fs.existsSync(path.join(__dirname, 'backend'))) return path.resolve(__dirname, '..');
  const up = path.resolve(path.dirname(process.execPath), '..', '..', '..');
  try { if (fs.existsSync(path.join(up, 'server', 'index.js')) && JSON.parse(fs.readFileSync(path.join(up, 'package.json'), 'utf8')).name === 'sanwes') return up; } catch { /* not inside the project */ }
  return null;
})();
const DATA_DIR = process.env.SANWES_DATA_DIR || (PROJECT ? path.join(PROJECT, 'data') : '');

let meetingWin = null, studioWin = null, pickerWin = null;
const children = []; // processes this app started (and must stop)
let tunnel = null, tunnelUrl = '';
const status = { media: 'starting', app: 'starting', note: '' };

// ------------------------------------------------------------------ helpers
const portOpen = (port) => new Promise((res) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); s.setTimeout(800, () => { s.destroy(); res(false); }); });
const httpOk = (url) => new Promise((res) => { const r = http.get(url, (m) => { m.resume(); res(m.statusCode < 500); }); r.on('error', () => res(false)); r.setTimeout(1500, () => { r.destroy(); res(false); }); });
async function waitFor(fn, ms = 25000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; }
function lanIp() {
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  return (all.find((i) => /^192\.168\./.test(i.address)) ?? all.find((i) => /^10\./.test(i.address)) ?? all[0])?.address ?? '127.0.0.1';
}
const push = () => studioWin?.webContents.send('state', snapshot());
function snapshot() {
  const ip = lanIp();
  return { ...status, local: `http://localhost:${PORT_APP}`, lan: `http://${ip}:${PORT_APP}`, tunnel: tunnelUrl, tunnelBusy: !!tunnel && !tunnelUrl, cloudflared: !!findCloudflared(), test: TEST,
    recordingsDir: recordingsDir() };
}
function killTree(p) { try { if (p?.pid) execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }

// ------------------------------------------------------------------ the servers (media server + the app's own server)
async function startServices() {
  const ip = lanIp();
  if (await portOpen(PORT_MEDIA)) status.media = 'running (already started)';
  else {
    const exe = path.join(ROOT, 'bin', 'livekit-server.exe');
    if (!fs.existsSync(exe)) { status.media = 'missing'; status.note = `The media server is missing: ${exe}`; push(); return; }
    const p = spawn(exe, ['--config', 'livekit.yaml'], { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
    children.push(p); p.on('exit', () => { status.media = 'stopped'; push(); });
    status.media = (await waitFor(() => portOpen(PORT_MEDIA))) ? 'running' : 'did not start';
  }
  push();
  if (await portOpen(PORT_APP)) status.app = 'running (already started)';
  else {
    // the Electron binary doubles as Node: ELECTRON_RUN_AS_NODE makes it run the server script
    const p = spawn(process.execPath, ['--env-file=.env', path.join('server', 'index.js')], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LIVEKIT_URL: `ws://${ip}:${PORT_MEDIA}`, PORT: String(PORT_APP), ...(DATA_DIR ? { DATA_DIR } : {}) },
    });
    children.push(p); p.on('exit', () => { status.app = 'stopped'; push(); });
    status.app = (await waitFor(() => httpOk(`http://127.0.0.1:${PORT_APP}/`))) ? 'running' : 'did not start';
  }
  push();
}

// ------------------------------------------------------------------ public link (Cloudflare quick tunnel, if cloudflared is installed)
function findCloudflared() {
  const cands = [process.env.CLOUDFLARED, 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe', path.join(os.homedir(), 'cloudflared.exe')].filter(Boolean);
  const hit = cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (hit) return hit;
  try { return execFileSync('where', ['cloudflared'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}
function startTunnel() {
  if (tunnel) return;
  const exe = findCloudflared();
  if (!exe) { status.note = 'cloudflared was not found. Install it (winget install Cloudflare.cloudflared) to get a public link.'; push(); return; }
  tunnelUrl = '';
  tunnel = spawn(exe, ['tunnel', '--url', `http://localhost:${PORT_APP}`, '--no-autoupdate'], { windowsHide: true });
  const scan = (b) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(b));
    if (m && !tunnelUrl) {
      tunnelUrl = m[0]; push();
      try { fs.writeFileSync(path.join(PROJECT ?? app.getPath('videos'), 'public-link.txt'), `Public link for students (changes every time SanWe's starts):\r\n${tunnelUrl}\r\n\r\nWritten at ${new Date()}\r\n`); } catch { /* read-only folder */ }
    }
  };
  tunnel.stdout.on('data', scan); tunnel.stderr.on('data', scan);
  tunnel.on('exit', () => { tunnel = null; tunnelUrl = ''; push(); });
  push();
}
function stopTunnel() { killTree(tunnel); tunnel = null; tunnelUrl = ''; push(); }

// ------------------------------------------------------------------ windows
// Open at a normal size, not maximized: a maximized window is captured as "the whole screen" (taskbar and all)
function place(win, w, h, anchor) {
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);
  const a = screen.getPrimaryDisplay().workArea;
  w = Math.min(w, a.width - 40); h = Math.min(h, a.height - 40);
  win.setBounds({ x: OFFSCREEN ? -4000 : anchor === 'right' ? a.x + a.width - w - 16 : a.x + 24, y: OFFSCREEN ? 0 : a.y + 16, width: w, height: h });
}
function makeMeetingWindow(url) {
  meetingWin = new BrowserWindow({
    width: 1366, height: 860, minWidth: 860, minHeight: 560, title: "SanWe's meeting", backgroundColor: '#14171a', autoHideMenuBar: true, show: false,
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', contextIsolation: true, sandbox: true },
  });
  meetingWin.once('ready-to-show', () => { place(meetingWin, 1280, 800, 'left'); meetingWin.show(); setTimeout(() => { if (meetingWin) place(meetingWin, 1280, 800, 'left'); }, 250); /* some launchers start the first window maximized */ if (process.env.SANWES_DEBUG) fs.writeFileSync(path.join(os.tmpdir(), 'sanwes-bounds.txt'), JSON.stringify({ meeting: meetingWin.getBounds(), max: meetingWin.isMaximized(), studio: studioWin?.getBounds(), studioMax: studioWin?.isMaximized() })); });
  meetingWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  meetingWin.on('page-title-updated', (e) => e.preventDefault());
  meetingWin.on('closed', () => { meetingWin = null; if (studioWin) studioWin.webContents.send('meeting-closed'); });
  meetingWin.loadURL(url || `http://localhost:${PORT_APP}/`);
  if (process.env.SANWES_DEBUG) for (const ms of [500, 2000, 5000]) setTimeout(() => { try { fs.appendFileSync(path.join(os.tmpdir(), 'sanwes-bounds.txt'), `
${ms}ms ${JSON.stringify({ b: meetingWin.getBounds(), max: meetingWin.isMaximized(), vis: meetingWin.isVisible() })}`); } catch { /* closed */ } }, ms);
}
function makeStudioWindow() {
  studioWin = new BrowserWindow({
    width: 500, height: 780, minWidth: 440, title: "SanWe's Studio", backgroundColor: '#181a1d', autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, partition: 'persist:studio', backgroundThrottling: false },
  });
  studioWin.setMenu(null);
  studioWin.once('ready-to-show', () => studioWin.show());
  place(studioWin, 500, 800, 'right');
  studioWin.once('ready-to-show', () => setTimeout(() => { if (studioWin) place(studioWin, 500, 800, 'right'); }, 250));
  studioWin.loadFile(path.join(__dirname, 'control.html'));
  // closing the Studio ends the meeting for everyone (the servers stop), so never do that in the middle of a recording by accident
  studioWin.on('close', (e) => {
    if (files.size && !TEST) {
      const r = dialog.showMessageBoxSync(studioWin, { type: 'warning', buttons: ['Keep recording', 'Quit and lose the end of the recording'], defaultId: 0, cancelId: 0, title: 'Recording in progress', message: 'A recording is still running.', detail: 'Press Stop in the Studio first so the files are saved properly.' });
      if (r === 0) e.preventDefault();
    }
  });
  studioWin.on('closed', () => { studioWin = null; app.quit(); });
}

// ------------------------------------------------------------------ screen sharing inside the meeting (the page's own "Share" button)
function chooseSource(sources) {
  return new Promise((resolve) => {
    pickerWin = new BrowserWindow({ width: 760, height: 560, parent: meetingWin ?? undefined, modal: !!meetingWin, title: 'Choose what to share', autoHideMenuBar: true, backgroundColor: '#1d1f23',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false } });
    pickerWin.setMenu(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; ipcMain.removeHandler('picker:items'); ipcMain.removeAllListeners('picker:choose'); try { pickerWin?.close(); } catch { /* closed */ } pickerWin = null; resolve(v); };
    ipcMain.handle('picker:items', () => sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL(), screen: s.id.startsWith('screen') })));
    ipcMain.on('picker:choose', (_e, choice) => finish(choice));
    pickerWin.on('closed', () => finish(null));
    pickerWin.loadFile(path.join(__dirname, 'picker.html'));
  });
}
function setupSharing() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const own = new Set([studioWin?.getMediaSourceId(), pickerWin?.getMediaSourceId()].filter(Boolean));
      const sources = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 220 } })).filter((s) => !own.has(s.id));
      // tests: SANWES_TEST_SHARE picks the window whose title contains that text (so a test can share its own test window)
      const wanted = TEST && process.env.SANWES_TEST_SHARE ? sources.find((s) => s.name.includes(process.env.SANWES_TEST_SHARE)) : null;
      const choice = TEST ? { id: (wanted ?? sources[0])?.id, sound: process.env.SANWES_TEST_SOUND === '1' } : await chooseSource(sources);
      const src = sources.find((s) => s.id === choice?.id);
      if (!src) { callback({}); return; }
      callback({ video: src, ...(choice.sound ? { audio: 'loopback' } : {}) });
    } catch { callback({}); }
  });
  // the Studio window records the MEETING window, with the sound this computer plays
  session.fromPartition('persist:studio').setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      if (!meetingWin) { callback({}); return; }
      const id = meetingWin.getMediaSourceId();
      const src = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })).find((s) => s.id === id);
      if (!src) { callback({}); return; }
      callback({ video: src, audio: TEST ? 'loopbackWithMute' : 'loopback' });
    } catch { callback({}); }
  });
  for (const s of [session.defaultSession, session.fromPartition('persist:studio')]) {
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
    s.setPermissionCheckHandler(() => true);
  }
}

// ------------------------------------------------------------------ recording: files are written as they are produced
const recordingsDir = () => path.join(app.getPath('videos'), "SanWe's Recordings");
const files = new Map(); let fileSeq = 0;
ipcMain.handle('rec:begin', async (_e, { kinds }) => {
  let title = 'meeting';
  try { title = (await meetingWin?.webContents.executeJavaScript("document.getElementById('room-title')?.textContent || 'meeting'")) || 'meeting'; } catch { /* page not ready */ }
  const safe = String(title).replace(/[^\w .\-]/g, '').trim().slice(0, 50) || 'meeting';
  const now = new Date(), p2 = (n) => String(n).padStart(2, '0'); // this computer's own clock, like the class bot's folders
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}.${p2(now.getMinutes())}`;
  const dir = path.join(recordingsDir(), `${stamp} ${safe}`);
  fs.mkdirSync(dir, { recursive: true });
  const ids = {};
  for (const [kind, name] of Object.entries(kinds)) { const id = ++fileSeq; const file = path.join(dir, name); files.set(id, { stream: fs.createWriteStream(file), file }); ids[kind] = { id, file }; }
  // tell everyone in the meeting that it is being recorded
  meetingWin?.webContents.executeJavaScript("window.__sanwes?.room?.localParticipant?.setAttributes({ rec: '1' })").catch(() => {});
  return { dir, ids };
});
ipcMain.handle('rec:write', (_e, id, bytes) => new Promise((res) => { const f = files.get(id); if (!f) return res(false); f.stream.write(Buffer.from(bytes), () => res(true)); }));
ipcMain.handle('rec:end', (_e, id) => new Promise((res) => { const f = files.get(id); if (!f) return res(null); f.stream.end(() => { files.delete(id); let size = 0; try { size = fs.statSync(f.file).size; } catch { /* gone */ } res({ file: f.file, size }); }); }));
ipcMain.handle('rec:flag', (_e, value) => { meetingWin?.webContents.executeJavaScript(`window.__sanwes?.room?.localParticipant?.setAttributes({ rec: ${JSON.stringify(value)} })`).catch(() => {}); });
ipcMain.handle('rec:folder', (_e, dir) => shell.openPath(dir || recordingsDir()));

// ------------------------------------------------------------------ class mode: this app opens the class window by itself and records it
// The server (this computer only) says when a class has started: this app then loads the class into its meeting window (signed in as the
// class owner, joined as host, no clicks) and, when the class says "record now", the control panel records that window with its sound.
const getJson = (url) => new Promise((resolve, reject) => { const r = http.get(url, (m) => { let b = ''; m.on('data', (d) => { b += d; }); m.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.setTimeout(3000, () => r.destroy(new Error('timeout'))); });
const postJson = (url, body) => new Promise((resolve) => { const data = JSON.stringify(body); const r = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (m) => { m.resume(); m.on('end', () => resolve(true)); }); r.on('error', () => resolve(false)); r.setTimeout(3000, () => r.destroy()); r.end(data); });
let classJob = null, classRecording = false;
function openClassWindow(job) {
  const url = `http://localhost:${PORT_APP}${job.url}`;
  if (!meetingWin) makeMeetingWindow(url); else meetingWin.loadURL(url);
  const show = () => { if (!meetingWin) return; if (meetingWin.isMinimized()) meetingWin.restore(); place(meetingWin, 1600, 900, 'left'); meetingWin.show(); if (!OFFSCREEN) meetingWin.focus(); };
  if (meetingWin.webContents.isLoading() || !meetingWin.isVisible()) meetingWin.once('ready-to-show', show); show();
  push();
}
function setAutoRecord(on, run) { classRecording = on; studioWin?.webContents.send('auto-record', { on, run }); }
async function classTick() {
  if (!status.app.startsWith('running')) return;
  let r; try { r = await getJson(`http://127.0.0.1:${PORT_APP}/api/auto/studio/poll`); } catch { return; }
  const job = r?.job;
  if (!job) { if (classJob) { classJob = null; if (classRecording) setAutoRecord(false); } return; }
  if (!classJob || classJob.run !== job.run || classJob.n !== job.n) { classJob = job; openClassWindow(job); }
  if (r.record && !classRecording) setAutoRecord(true, job.run);
  else if (!r.record && classRecording) setAutoRecord(false, job.run);
}
ipcMain.handle('auto:status', (_e, body) => postJson(`http://127.0.0.1:${PORT_APP}/api/auto/studio/status`, body));
setInterval(() => classTick().catch(() => {}), 3000).unref();

// ------------------------------------------------------------------ the rest of the control panel's requests
ipcMain.handle('state', () => snapshot());
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('open-meeting', () => { if (!meetingWin) makeMeetingWindow(); else { if (meetingWin.isMinimized()) meetingWin.restore(); meetingWin.focus(); } return true; });
ipcMain.handle('tunnel', (_e, on) => { if (on) startTunnel(); else stopTunnel(); return true; });
ipcMain.handle('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('meeting-info', async () => {
  try { return await meetingWin?.webContents.executeJavaScript("({ inMeeting: !!window.__sanwes?.room, title: document.getElementById('room-title')?.textContent || '' })"); } catch { return { inMeeting: false, title: '' }; }
});
ipcMain.handle('meeting-size', (_e, large) => { if (!meetingWin) return false; if (meetingWin.isMinimized()) meetingWin.restore(); if (large) meetingWin.maximize(); else place(meetingWin, 1280, 800, 'left'); meetingWin.focus(); return meetingWin.isMaximized(); });
ipcMain.handle('meeting-minimized', () => !!meetingWin?.isMinimized());

// ------------------------------------------------------------------ start / stop
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (studioWin) { if (studioWin.isMinimized()) studioWin.restore(); studioWin.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    setupSharing();
    makeStudioWindow();
    await startServices();
    if (status.app.startsWith('running')) {
      if (CLASS_MODE) { status.note = "Class mode: the class window opens by itself when a class starts, and is recorded."; push(); studioWin?.once('ready-to-show', () => studioWin.minimize()); if (studioWin?.isVisible()) studioWin.minimize(); }
      else makeMeetingWindow();
      if (WANT_TUNNEL) startTunnel();
    } else { status.note = status.note || "SanWe's did not start. Close other programs using port 3000 and try again."; push(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { stopTunnel(); for (const p of children) killTree(p); });
}
