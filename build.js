// Builds store packages into the project root:
//   teams-transcript-exporter-{chrome,edge,firefox}-v<version>.zip
//
// Usage: node build.js
//
// Firefox needs background.scripts + browser_specific_settings; Chrome Web Store
// and Edge Add-ons reject background.scripts in MV3, so their manifest drops both.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, 'teams-transcript-extension');
const FILES = [
  'background.js',
  'popup.html',
  'popup.js',
  'styles/popup.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

function chromiumManifest(m) {
  const out = structuredClone(m);
  out.background = { service_worker: m.background.service_worker };
  delete out.browser_specific_settings;
  return out;
}

const targets = {
  chrome:  chromiumManifest(manifest),
  edge:    chromiumManifest(manifest),
  firefox: manifest,
};

for (const [store, m] of Object.entries(targets)) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `tte-${store}-`));
  for (const file of FILES) {
    fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
    fs.copyFileSync(path.join(SRC, file), path.join(stage, file));
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

  const zip = path.join(__dirname, `teams-transcript-exporter-${store}-v${m.version}.zip`);
  fs.rmSync(zip, { force: true });
  // bsdtar (Windows 10+, macOS) writes forward-slash paths, which AMO requires.
  // On Windows call System32's bsdtar explicitly — Git Bash's GNU tar can't write zips.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-a', '-cf', 'package.zip', 'manifest.json', ...FILES], { cwd: stage });
  fs.copyFileSync(path.join(stage, 'package.zip'), zip);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`${path.basename(zip)}  ${(fs.statSync(zip).size / 1024).toFixed(0)} KB`);
}
