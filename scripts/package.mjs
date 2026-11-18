// Builds release/toxtickety-host.zip: everything a hosting panel needs, ready to upload.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const hostPackage = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: pkg.main,
  engines: pkg.engines,
  scripts: { start: 'node index.js' },
  dependencies: pkg.dependencies,
};

// A lockfile matching the upload makes every install on the host identical.
const work = mkdtempSync(join(tmpdir(), 'toxtickety-'));
writeFileSync(join(work, 'package.json'), `${JSON.stringify(hostPackage, null, 2)}\n`);
cpSync('package-lock.json', join(work, 'package-lock.json'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--package-lock-only', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: work,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const files = {};
const add = (path, name = path) => {
  files[name.split(sep).join('/')] = new Uint8Array(readFileSync(path));
};
const addFolder = (folder) => {
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) addFolder(path);
    else if (!entry.endsWith('.map')) add(path, relative('.', path));
  }
};

addFolder('dist');
add('index.js');
add('.env.example');
add('HOSTING.md');
add(join(work, 'package.json'), 'package.json');
add(join(work, 'package-lock.json'), 'package-lock.json');

mkdirSync('release', { recursive: true });
writeFileSync('release/toxtickety-host.zip', zipSync(files, { level: 9 }));
rmSync(work, { recursive: true, force: true });
console.log(`Created release/toxtickety-host.zip with ${Object.keys(files).length} files`);
