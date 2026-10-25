// Builds "SanWes Viewer.exe": the small student app that hides itself from screen recorders.
//   node build-viewer.mjs      (or double-click build-sanwes-viewer.bat in the project folder)
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'viewer'), stage = path.join(here, 'stage-viewer'), out = path.join(here, 'dist');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(src, stage, { recursive: true });
const electronVersion = JSON.parse(readFileSync(path.join(here, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8'));
console.log('packaging the Viewer...');
const dirs = await packager({
  dir: stage, out, name: 'SanWes Viewer', executableName: 'SanWes Viewer', platform: 'win32', arch: 'x64', overwrite: true, asar: false, prune: false,
  electronVersion, appVersion: pkg.version, quiet: true,
  win32metadata: { CompanyName: "SanWe's", ProductName: "SanWe's Viewer", FileDescription: "SanWe's Viewer" },
});
rmSync(stage, { recursive: true, force: true });
console.log(`\nDone:\n  ${path.join(dirs[0], 'SanWes Viewer.exe')}`);
