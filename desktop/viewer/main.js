// SanWe's Viewer: the student's app for classes with "Recording protection". It opens the class link in its own window and asks
// Windows to hide that window from every screen capture (screenshots, Game Bar, OBS, screen sharing): recorders get a black/empty
// area instead. This is the same operating-system switch the big meeting clients use (SetWindowDisplayAffinity); see
// docs/ZOOM_CAPTURE_PROTECTION_REPORT.md. It does not stop a phone camera pointed at the screen.
const { app, BrowserWindow, session, ipcMain, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const TEST = process.env.SANWES_TEST === '1'; // tests only: lets a test compare with and without protection
app.setName("SanWe's Viewer");
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, origin = '';
const stateFile = () => path.join(app.getPath('userData'), 'last.json');
const lastLink = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')).link || ''; } catch { return ''; } };
const saveLink = (link) => { try { fs.writeFileSync(stateFile(), JSON.stringify({ link })); } catch { /* read-only profile */ } };

function parseLink(text) {
  try {
    const u = new URL(String(text).trim().replace(/^(?!https?:\/\/)/i, 'https://'));
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

function open(link) {
  const u = parseLink(link);
  if (!u || !win) return false;
  origin = u.origin;
  saveLink(u.href);
  win.loadURL(u.href);
  return true;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 520, title: "SanWe's Viewer (protected)", backgroundColor: '#14171a', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, devTools: false, autoplayPolicy: 'no-user-gesture-required', partition: 'persist:viewer', backgroundThrottling: false },
  });
  if (!(TEST && process.env.SANWES_VIEWER_UNPROTECTED === '1')) win.setContentProtection(true); // the whole point of this app
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    try { if (new URL(url).origin === origin) return; } catch { /* bad url */ }
    e.preventDefault(); // never wander off to other sites inside the protected window
  });
  win.on('closed', () => { win = null; });
  const arg = process.argv.slice(1).find((a) => /^https?:\/\//i.test(a));
  if (arg && open(arg)) return;
  win.loadFile(path.join(__dirname, 'start.html'));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ses = session.fromPartition('persist:viewer');
  // Tell the server this is the Viewer app (classes set to "Viewer app only" check this)
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    try { if (origin && new URL(details.url).origin === origin) h['X-SanWes-Viewer'] = '1'; } catch { /* not a url */ }
    cb({ requestHeaders: h });
  });
  const sameSite = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  const allowed = ['media', 'audioCapture', 'videoCapture', 'fullscreen', 'clipboard-sanitized-write', 'notifications'];
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(sameSite(details.requestingUrl) && allowed.includes(permission)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => sameSite(requestingOrigin) && allowed.includes(permission));
  ses.setDisplayMediaRequestHandler((_req, cb) => cb({})); // students cannot share their screen from the Viewer
  ipcMain.handle('viewer:last', (e) => (e.senderFrame.url.startsWith('file:') ? lastLink() : ''));
  ipcMain.handle('viewer:open', (e, link) => (e.senderFrame.url.startsWith('file:') ? open(link) : false));
  createWindow();
  app.on('second-instance', (_e, argv) => {
    const a = argv.find((x) => /^https?:\/\//i.test(x));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (a) open(a); }
  });
});
app.on('window-all-closed', () => app.quit());
