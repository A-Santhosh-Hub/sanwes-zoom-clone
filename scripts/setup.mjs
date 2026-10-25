#!/usr/bin/env node
// SanWe's one-command setup. Safe to run again: it only does what is missing.
//   npm run setup        (or: node scripts/setup.mjs)
// What it does, in order:
//   1. checks Node.js (20.6 or newer)
//   2. installs the packages of the server and of the web client
//   3. makes this computer's own keys: .env and livekit.yaml (random secret, never shared, never committed)
//   4. downloads the LiveKit media server for this system (official release, SHA-256 checked) into bin/
//   5. builds the web client (this also uses the face/background models that are in client/public)
//   6. Windows only: fetches the ViGEm library and builds the Game Hub input helper (needed only to let viewers play with a gamepad/keyboard)
// Options by environment variable: SANWES_APP_PORT (default 3000), SANWES_LK_PORT (default 7880).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVEKIT_VERSION = '1.13.10';
const VIGEM_VERSION = '1.21.256';
const VIGEM_NUPKG_SHA256 = 'ff460031b33e0882cd1166fe2d072d0fe97578480c61ed85dccfa6c930fdb55e'; // the official nuget.org package, checked when it was first downloaded
const APP_PORT = Number(process.env.SANWES_APP_PORT) || 3000;
const LK_PORT = Number(process.env.SANWES_LK_PORT) || 7880;
const WIN = process.platform === 'win32';
const at = (...p) => path.join(ROOT, ...p);
const step = (n, t) => console.log(`\n[${n}/6] ${t}`);
const ok = (m) => console.log(`   ok    ${m}`);
const note = (m) => console.log(`   ..    ${m}`);
const warn = (m) => console.log(`   !!    ${m}`);
const die = (m) => { console.error(`\n   FAILED: ${m}\n`); process.exit(1); };

function run(cmd, args, opts = {}) {
  // one command line through the shell (on Windows "npm" is npm.cmd, which needs a shell)
  const r = spawnSync([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
  return r.status === 0;
}
// Unpack a .zip or .tar.gz. On Windows use the system's own tar.exe by its full path (another "tar", such as Git's, cannot unpack zips or C: paths), then PowerShell as a fallback.
function unpack(archive, dest, only) {
  if (WIN) {
    const sysTar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
    if (existsSync(sysTar) && spawnSync(sysTar, ['-xf', archive, '-C', dest, ...(only ? [only] : [])], { stdio: 'inherit' }).status === 0) return true;
    return spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`], { stdio: 'inherit' }).status === 0;
  }
  return spawnSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' }).status === 0;
}
async function download(url, label) {
  note(`downloading ${label} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} from ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

console.log("SanWe's setup");
// ---------------------------------------------------------------- 1. Node
step(1, 'Node.js');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 6)) die(`Node.js ${process.versions.node} is too old. Install Node.js 20.6 or newer (https://nodejs.org, the LTS version).`);
ok(`Node.js ${process.versions.node}`);

// ---------------------------------------------------------------- 2. packages
step(2, 'Packages');
if (!existsSync(at('node_modules', 'express'))) { note('installing the server packages (first time only) ...'); if (!run('npm', ['install', '--no-audit', '--no-fund'])) die('npm install failed.'); }
ok('server packages');
if (!existsSync(at('client', 'node_modules', 'vite'))) { note('installing the web client packages (first time only) ...'); if (!run('npm', ['install', '--prefix', 'client', '--no-audit', '--no-fund'])) die('npm install for the client failed.'); }
ok('web client packages');

// ---------------------------------------------------------------- 3. this computer's own keys
step(3, 'Keys for this computer (.env and livekit.yaml)');
const envPath = at('.env'), yamlPath = at('livekit.yaml');
const yamlFor = (secret) => readFileSync(at('livekit.example.yaml'), 'utf8')
  .replace('replace-me-on-first-start', secret)
  .replace(/^port: \d+/m, `port: ${LK_PORT}`).replace(/tcp_port: \d+/, `tcp_port: ${LK_PORT + 1}`).replace(/udp_port: \d+/, `udp_port: ${LK_PORT + 2}`);
if (!existsSync(envPath)) {
  const secret = randomBytes(32).toString('hex');
  const envText = readFileSync(at('.env.example'), 'utf8')
    .replace(/^LIVEKIT_API_SECRET=.*$/m, `LIVEKIT_API_SECRET=${secret}`)
    .replace(/^LIVEKIT_URL=.*$/m, `LIVEKIT_URL=ws://localhost:${LK_PORT}`)
    .replace(/^PORT=.*$/m, `PORT=${APP_PORT}`)
    .replace(/^# LIVEKIT_API_URL=.*$/m, `LIVEKIT_API_URL=http://127.0.0.1:${LK_PORT}`); // how the app reaches the media server's API
  writeFileSync(envPath, envText, { mode: 0o600 });
  writeFileSync(yamlPath, yamlFor(secret), { mode: 0o600 });
  ok('created .env and livekit.yaml with a new random secret (they stay on this computer)');
} else if (!existsSync(yamlPath)) {
  const m = /^LIVEKIT_API_SECRET=(\S+)$/m.exec(readFileSync(envPath, 'utf8'));
  if (!m || m[1].startsWith('<')) die('.env has no LIVEKIT_API_SECRET. Delete .env and run setup again.');
  writeFileSync(yamlPath, yamlFor(m[1]), { mode: 0o600 });
  ok('created livekit.yaml from the secret in .env');
} else ok('.env and livekit.yaml already exist');

// ---------------------------------------------------------------- 4. media server
step(4, `LiveKit media server ${LIVEKIT_VERSION}`);
const lkName = WIN ? 'livekit-server.exe' : 'livekit-server';
const lkBin = at('bin', lkName);
if (existsSync(lkBin)) ok(`already there: bin/${lkName}`);
else {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const asset = WIN ? `livekit_${LIVEKIT_VERSION}_windows_${arch}.zip` : process.platform === 'linux' ? `livekit_${LIVEKIT_VERSION}_linux_${arch}.tar.gz` : null;
  if (!asset) {
    warn('There is no ready-made media server file for this system. On macOS install it with:  brew install livekit');
    warn(`then start SanWe's with that on your PATH (the "livekit-server" command). Everything else is set up.`);
  } else {
    const base = `https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}`;
    let tmp;
    try {
      const sums = (await download(`${base}/checksums.txt`, 'checksums')).toString('utf8');
      const want = sums.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).find((p) => p[1] === asset)?.[0];
      if (!want) throw new Error(`no checksum for ${asset}`);
      const buf = await download(`${base}/${asset}`, asset);
      if (sha256(buf) !== want) throw new Error('the downloaded file does not match the published checksum, so it was thrown away');
      ok('checksum matches the official release');
      tmp = mkdtempSync(path.join(os.tmpdir(), 'sanwes-lk-'));
      const file = path.join(tmp, asset); writeFileSync(file, buf);
      mkdirSync(at('bin'), { recursive: true });
      if (!unpack(file, at('bin')) || !existsSync(lkBin)) throw new Error('could not unpack the download');
      if (!WIN) chmodSync(lkBin, 0o755);
      ok(`installed bin/${lkName}`);
    } catch (e) { die(`${e.message}\n   You can also download it by hand from https://github.com/livekit/livekit/releases/tag/v${LIVEKIT_VERSION} and put ${lkName} into the bin folder.`); }
    finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  }
}

// ---------------------------------------------------------------- 5. web client
step(5, 'Web client');
if (existsSync(at('client', 'dist', 'index.html'))) ok('already built');
else { note('building (about 10 seconds) ...'); if (!run('npm', ['run', 'build'])) die('building the web client failed.'); ok('built'); }
for (const f of ['client/public/models/selfie_segmenter.tflite', 'client/public/mediapipe/vision_wasm_internal.wasm']) if (!existsSync(at(f))) warn(`missing ${f}: blurring the camera background will not work`);
ok('background-blur models are in client/public');

// ---------------------------------------------------------------- 6. Windows: Game Hub helper
step(6, 'Game Hub input helper (Windows only, optional)');
if (!WIN) note('skipped: letting viewers press keys on your PC is Windows-only. Everything else works on this system.');
else {
  const dir = at('desktop', 'input'), dll = path.join(dir, 'Nefarius.ViGEm.Client.dll'), exe = path.join(dir, 'sanwes-input.exe');
  try {
    if (!existsSync(dll)) {
      const buf = await download(`https://www.nuget.org/api/v2/package/Nefarius.ViGEm.Client/${VIGEM_VERSION}`, `Nefarius.ViGEm.Client ${VIGEM_VERSION} (MIT)`);
      if (sha256(buf) !== VIGEM_NUPKG_SHA256) throw new Error('the ViGEm package does not match the expected checksum');
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'sanwes-vigem-')), pkg = path.join(tmp, 'vigem.zip');
      writeFileSync(pkg, buf);
      if (!unpack(pkg, tmp, 'lib/netstandard2.0/Nefarius.ViGEm.Client.dll')) throw new Error('could not unpack the ViGEm package');
      copyFileSync(path.join(tmp, 'lib', 'netstandard2.0', 'Nefarius.ViGEm.Client.dll'), dll);
      rmSync(tmp, { recursive: true, force: true });
      ok('fetched Nefarius.ViGEm.Client.dll (checksum verified)');
    } else ok('ViGEm library present');
    if (!existsSync(exe)) {
      note('building sanwes-input.exe from desktop/input/sanwes-input.cs with the compiler that comes with Windows ...');
      if (!run('cmd', ['/c', path.join(dir, 'build-input.bat')])) throw new Error('the build failed (the .NET Framework compiler csc.exe was not found?)');
    }
    ok('input helper ready');
    note('Gamepad play also needs the free ViGEmBus driver: https://github.com/nefarius/ViGEmBus/releases (keyboard and mouse play works without it).');
  } catch (e) { warn(`${e.message}. Game Hub still works for watching; only letting viewers play on your PC is unavailable.`); }
}

console.log(`\nSetup finished.  Start it with:  npm start     (Windows: double-click START-HERE.bat)`);
console.log(`Then open http://localhost:${APP_PORT} and create your account: the first account becomes the administrator.\n`);
