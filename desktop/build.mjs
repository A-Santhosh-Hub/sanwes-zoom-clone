// Builds "SanWes Studio.exe": a self-contained folder with the app, the SanWe's server, the web client and the media server.
//   node build.mjs      (or double-click build-sanwes-studio.bat in the project folder)
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const stage = path.join(here, 'stage'), out = path.join(here, 'dist');
const need = [path.join(root, 'client', 'dist', 'index.html'), path.join(root, 'bin', 'livekit-server.exe'), path.join(root, 'server', 'index.js'), path.join(root, 'livekit.yaml')];
for (const f of need) if (!existsSync(f)) { console.error(`Missing ${f}. Run "npm run build" in the project first.`); process.exit(1); }

console.log('1/3 collecting files...');
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'backend'), { recursive: true });
for (const f of ['main.js', 'preload.js', 'control.html', 'control.js', 'control.css', 'picker.html']) cpSync(path.join(here, f), path.join(stage, f));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8')); delete pkg.devDependencies; delete pkg.scripts;
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));
const b = path.join(stage, 'backend');
cpSync(path.join(root, 'server'), path.join(b, 'server'), { recursive: true });
cpSync(path.join(root, 'client', 'dist'), path.join(b, 'client', 'dist'), { recursive: true });
mkdirSync(path.join(b, 'bin'), { recursive: true });
cpSync(path.join(root, 'bin', 'livekit-server.exe'), path.join(b, 'bin', 'livekit-server.exe'));
if (existsSync(path.join(root, 'bin', 'LICENSE'))) cpSync(path.join(root, 'bin', 'LICENSE'), path.join(b, 'bin', 'LICENSE'));
for (const f of ['livekit.yaml', '.env', 'package.json']) if (existsSync(path.join(root, f))) cpSync(path.join(root, f), path.join(b, f));
// Game Hub input helper (keyboard / mouse / gamepad for viewers the streamer approved): the server starts it. Build it with desktop\input\build-input.bat.
if (!existsSync(path.join(here, 'input', 'sanwes-input.exe'))) { console.error('input\\sanwes-input.exe is missing. Run desktop\\input\\build-input.bat first.'); process.exit(1); }
mkdirSync(path.join(b, 'desktop', 'input'), { recursive: true });
for (const f of ['sanwes-input.exe', 'Nefarius.ViGEm.Client.dll', 'THIRD_PARTY.md']) cpSync(path.join(here, 'input', f), path.join(b, 'desktop', 'input', f));
console.log('2/3 installing the server\'s packages...');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: b, stdio: 'inherit' });

console.log('3/3 packaging the app...');
const electronVersion = JSON.parse(readFileSync(path.join(here, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const dirs = await packager({ dir: stage, out, name: 'SanWes Studio', executableName: 'SanWes Studio', platform: 'win32', arch: 'x64', overwrite: true, asar: false, prune: false, electronVersion, appVersion: pkg.version, quiet: true,
  win32metadata: { CompanyName: "SanWe's", ProductName: "SanWe's Studio", FileDescription: "SanWe's Studio" } });
rmSync(stage, { recursive: true, force: true });
console.log(`\nDone:\n  ${path.join(dirs[0], 'SanWes Studio.exe')}`);
