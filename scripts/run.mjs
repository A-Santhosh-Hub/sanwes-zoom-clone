#!/usr/bin/env node
// Starts SanWe's: the LiveKit media server and the app, together. Press Ctrl+C to stop both.
//   npm run launch                 both
//   node scripts/run.mjs media     only the media server
//   node scripts/run.mjs app       only the app
//   add  --open  to open the browser,  --no-lan  to keep the media address on "localhost" (only this computer can then join)
// Run "npm run setup" (or "npm start", which does it for you) before the first start.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const only = args.find((a) => a === 'media' || a === 'app');
const openBrowser = args.includes('--open'), keepLocal = args.includes('--no-lan');
const log = (m) => console.log(m);

if (!existsSync(path.join(ROOT, '.env')) || !existsSync(path.join(ROOT, 'livekit.yaml'))) { console.error('Not set up yet. Run:  npm run setup'); process.exit(1); }
const env0 = Object.fromEntries(readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const appPort = Number(process.env.PORT || env0.PORT) || 3000;
const lkPort = Number(/^port:\s*(\d+)/m.exec(readFileSync(path.join(ROOT, 'livekit.yaml'), 'utf8'))?.[1]) || 7880;

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))\./.test(i.address)) return i.address;
  return null;
}
const portBusy = (port) => new Promise((res) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); s.setTimeout(700, () => { s.destroy(); res(false); }); });
async function waitHttp(url, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 600)); }
  return false;
}

const children = [];
let stopping = false;
function stopAll(code = 0) { if (stopping) return; stopping = true; for (const c of children) { try { c.kill(); } catch { /* gone */ } } setTimeout(() => process.exit(code), 400).unref(); }
process.on('SIGINT', () => { log('\nStopping ...'); stopAll(0); });
process.on('SIGTERM', () => stopAll(0));

function startMedia() {
  const local = path.join(ROOT, 'bin', WIN ? 'livekit-server.exe' : 'livekit-server');
  const cmd = existsSync(local) ? local : 'livekit-server'; // on macOS: brew install livekit
  const c = spawn(cmd, ['--config', 'livekit.yaml'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  c.on('error', () => { console.error('Could not start the media server. Run "npm run setup" to download it.'); stopAll(1); });
  c.on('exit', (code) => { if (!stopping) { console.error(`The media server stopped (${code}).`); stopAll(1); } });
  children.push(c); return c;
}
function startApp(lan) {
  const env = { ...process.env };
  // other devices on the same network must reach the media server by this computer's address, not by "localhost"
  if (lan && /^wss?:\/\/(localhost|127\.0\.0\.1)/.test(env0.LIVEKIT_URL ?? '') && !process.env.LIVEKIT_URL) env.LIVEKIT_URL = `ws://${lan}:${lkPort}`;
  const c = spawn(process.execPath, ['--env-file=.env', 'server/index.js', 'sanwes-app'], { cwd: ROOT, stdio: 'inherit', env });
  c.on('exit', (code) => { if (!stopping) { console.error(`The app stopped (${code}).`); stopAll(code || 1); } });
  children.push(c); return c;
}

const lan = keepLocal ? null : lanIp();
if (only !== 'app') {
  if (await portBusy(lkPort)) { console.error(`Port ${lkPort} is already in use (is SanWe's already running?). Stop that first, or change the port with SANWES_LK_PORT when running setup.`); process.exit(1); }
  log(`Starting the media server on port ${lkPort} ...`); startMedia();
  if (!(await waitHttp(`http://127.0.0.1:${lkPort}`, 45))) { console.error('The media server did not answer within 45 seconds.'); stopAll(1); }
}
if (only !== 'media') {
  if (await portBusy(appPort)) { console.error(`Port ${appPort} is already in use (is SanWe's already running?).`); stopAll(1); }
  log(`Starting the app on port ${appPort} ...`); startApp(lan);
  if (!(await waitHttp(`http://127.0.0.1:${appPort}/api/health`, 30))) { console.error('The app did not answer within 30 seconds.'); stopAll(1); }
  log('\n=================================================================');
  log("  SanWe's is running");
  log(`  This computer : http://localhost:${appPort}`);
  if (lan) log(`  Same network  : http://${lan}:${appPort}   (phones and other PCs; camera and microphone there need HTTPS, see README)`);
  log('  First visit   : create your account. The first account is the administrator.');
  log('  Stop          : press Ctrl+C in this window');
  log('=================================================================\n');
  if (openBrowser) spawn(WIN ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', WIN ? ['/c', 'start', '', `http://localhost:${appPort}`] : [`http://localhost:${appPort}`], { stdio: 'ignore', detached: true }).unref();
}
