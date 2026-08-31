#!/usr/bin/env node
/**
 * Builds dist/chrome and dist/firefox unpacked extension folders from src/,
 * with the small manifest differences each browser needs (MV3 background
 * worker vs. background scripts array, Firefox's browser_specific_settings).
 * Then, on Windows, best-effort zips each into dist/*.zip for store upload
 * via PowerShell's Compress-Archive (skipped silently elsewhere -- the
 * unpacked folders are all you need for `load unpacked` / `about:debugging`).
 *
 * Usage: node build/build.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const ICONS = path.join(ROOT, 'icons');
const DIST = path.join(ROOT, 'dist');

const VERSION = require(path.join(ROOT, 'package.json')).version;

const CONTENT_SCRIPT_JS = [
  'lib/constants.js',
  'lib/browserApi.js',
  'lib/heuristics.js',
  'content/pageData.js',
  'content/badge.js',
  'content/panel.js',
  'content/scanner.js',
  'content/content.js',
];

const BACKGROUND_LIB_JS = [
  'lib/constants.js',
  'lib/browserApi.js',
  'lib/heuristics.js',
  'lib/storage.js',
  'lib/rss.js',
  'lib/dataApi.js',
];

function baseManifest() {
  return {
    manifest_version: 3,
    name: 'AI Slop Detector for YouTube',
    version: VERSION,
    // Chrome Web Store rejects manifest descriptions over 132 characters.
    description:
      'Rates YouTube videos for signs of AI-generated content (TTS voiceover, stock footage, clickbait titling) before you click.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_popup: 'popup/popup.html',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    permissions: ['storage'],
    host_permissions: ['*://www.youtube.com/*', '*://m.youtube.com/*', 'https://www.googleapis.com/*'],
    content_scripts: [
      {
        matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
        js: CONTENT_SCRIPT_JS,
        css: ['content/styles.css'],
        run_at: 'document_end',
      },
    ],
  };
}

function chromeManifest() {
  const m = baseManifest();
  m.background = { service_worker: 'background/background.js' };
  m.minimum_chrome_version = '110';
  return m;
}

function firefoxManifest() {
  const m = baseManifest();
  m.background = { scripts: [...BACKGROUND_LIB_JS, 'background/background.js'] };
  m.browser_specific_settings = {
    gecko: {
      id: 'ai-slop-detector@tillerdawg.github.io',
      strict_min_version: '115.0',
    },
  };
  return m;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else fs.copyFileSync(src, dest);
  }
}

function buildTarget(browser, manifest) {
  const outDir = path.join(DIST, browser);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  copyDir(SRC, outDir);
  if (fs.existsSync(ICONS)) {
    const iconsOut = path.join(outDir, 'icons');
    fs.mkdirSync(iconsOut, { recursive: true });
    for (const f of fs.readdirSync(ICONS)) {
      if (f.endsWith('.png')) fs.copyFileSync(path.join(ICONS, f), path.join(iconsOut, f));
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Built ${browser} -> ${path.relative(ROOT, outDir)}`);
  return outDir;
}

function tryZip(outDir, browser) {
  if (process.platform !== 'win32') return;
  const zipPath = path.join(DIST, `${browser}.zip`);
  try {
    fs.rmSync(zipPath, { force: true });
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
    console.log(`Zipped -> ${path.relative(ROOT, zipPath)}`);
  } catch (e) {
    console.warn(`(skipped zip for ${browser}: ${e.message})`);
  }
}

function main() {
  if (!fs.existsSync(path.join(ICONS, 'icon-128.png'))) {
    console.warn('Warning: icons/icon-*.png not found yet. Run `python icons/generate_icons.py` first.');
  }
  const chromeDir = buildTarget('chrome', chromeManifest());
  const firefoxDir = buildTarget('firefox', firefoxManifest());
  tryZip(chromeDir, 'chrome');
  tryZip(firefoxDir, 'firefox');
}

main();
