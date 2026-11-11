/**
 * Verifies that the release zips are structurally sound, that their published
 * SHA-256 checksums match, and that the Chrome archive can be unpacked and
 * loaded as an extension.
 * Usage: npm run verify:release (expects release/*.zip from npm run package).
 */
import puppeteer from 'puppeteer-core';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { extensionLaunchArgs, findChrome } from '../e2e/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const headless = process.env.HEADLESS === '1';
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

let archiveNames = [];
try {
  archiveNames = (await readdir(releaseDir)).filter((name) => name.endsWith('.zip'));
} catch {
  archiveNames = [];
}
if (archiveNames.length === 0) {
  throw new Error('В release/ нет zip. Сначала выполните npm run package.');
}

function versionParts(name) {
  const match = name.match(/-(\d+)\.(\d+)\.(\d+)\.zip$/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function latestOf(names) {
  // Sort by semver, not lexically: 1.10.0 must win over 1.9.0.
  return [...names]
    .sort((left, right) => {
      const a = versionParts(left);
      const b = versionParts(right);
      for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) return a[index] - b[index];
      }
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .at(-1);
}

const firefoxPattern = /-firefox-\d+\.\d+\.\d+\.zip$/;
const sourcePattern = /-source\.zip$/;
const chromeNames = archiveNames.filter(
  (name) => !firefoxPattern.test(name) && !sourcePattern.test(name),
);
const firefoxNames = archiveNames.filter((name) => firefoxPattern.test(name));
const sourceNames = archiveNames.filter((name) => sourcePattern.test(name));
const chromeName = latestOf(chromeNames);
if (!chromeName) {
  throw new Error('В release/ нет Chrome-zip. Сначала выполните npm run package.');
}

const tempDirectories = [];

/**
 * Reads the archive bytes and checks them against the published `.sha256`.
 * Without this the documented checksum could be stale and still "pass".
 */
function readVerifiedArchive(name) {
  const archivePath = path.join(releaseDir, name);
  const bytes = readFileSync(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  let published;
  try {
    published = readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
  } catch {
    throw new Error(`Отсутствует ${name}.sha256 — пересоберите npm run package.`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (published !== actual) {
    throw new Error(`${name}: SHA-256 не совпадает (${actual} != ${published})`);
  }
  return bytes;
}

function unpack(files) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wpa-release-'));
  tempDirectories.push(directory);
  for (const [name, bytes] of Object.entries(files)) {
    const segments = name.split('/');
    if (segments.some((segment) => segment === '..' || segment === '')) {
      throw new Error(`Небезопасный путь в архиве: ${name}`);
    }
    const destination = path.join(directory, ...segments);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  return directory;
}

function verifyFirefoxPackage() {
  const name = latestOf(firefoxNames);
  if (!name) {
    throw new Error(
      'В release/ нет Firefox-zip. Сначала выполните npm run package (он собирает dist-firefox).',
    );
  }

  const files = unzipSync(readVerifiedArchive(name));
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('Firefox-zip: нет manifest.json');
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));

  if (manifest.version !== packageJson.version) {
    throw new Error(
      `Firefox-zip: версия ${manifest.version} != package.json ${packageJson.version}`,
    );
  }
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('Firefox-zip: отсутствует browser_specific_settings.gecko.id');
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    throw new Error('Firefox-zip: отсутствует background.scripts');
  }
  if (!manifest.sidebar_action?.default_panel) {
    throw new Error('Firefox-zip: отсутствует sidebar_action.default_panel');
  }
  for (const required of [
    manifest.sidebar_action.default_panel,
    ...manifest.background.scripts,
  ]) {
    if (!files[required]) throw new Error(`Firefox-zip: отсутствует ${required}`);
  }

  console.log(`Firefox-архив: ${name} (${Object.keys(files).length} файлов, SHA-256 OK)`);
  console.log(`Firefox id: ${manifest.browser_specific_settings.gecko.id}`);
  console.log('FIREFOX PACKAGE PASS: структура, версия и контрольная сумма совпадают.');
}

function verifySourcePackage() {
  const name = sourceNames.sort().at(-1);
  if (!name) return;

  const files = unzipSync(readVerifiedArchive(name));
  const required = [
    'package.json',
    'package-lock.json',
    'manifest.firefox.json',
    'vite.config.ts',
    'src/content/page-script.ts',
    'src/content/index.ts',
    'scripts/build-firefox.mjs',
    'docs/amo/build-instructions.md',
  ];
  for (const file of required) {
    if (!files[file]) throw new Error(`Source-zip: отсутствует ${file}`);
  }

  for (const file of Object.keys(files)) {
    if (
      /^(node_modules|dist|dist-firefox|release|public\/generated|\.git|\.opencode)\//.test(file)
    ) {
      throw new Error(`Source-zip: запрещённый путь ${file}`);
    }
  }

  const sourcePackage = JSON.parse(Buffer.from(files['package.json']).toString('utf8'));
  const sourceManifest = JSON.parse(Buffer.from(files['manifest.firefox.json']).toString('utf8'));
  if (sourcePackage.version !== packageJson.version) {
    throw new Error(
      `Source-zip: package.json ${sourcePackage.version} != package.json ${packageJson.version}`,
    );
  }
  if (sourceManifest.version !== packageJson.version) {
    throw new Error(
      `Source-zip: manifest.firefox.json ${sourceManifest.version} != ${packageJson.version}`,
    );
  }

  console.log(`Source-архив: ${name} (${Object.keys(files).length} файлов, SHA-256 OK)`);
  console.log('SOURCE PACKAGE PASS: версия, lockfile и build instructions на месте.');
}

const chromeFiles = unzipSync(readVerifiedArchive(chromeName));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-release-profile-'));
tempDirectories.push(userDataDir);
let browser;

try {
  const unpacked = unpack(chromeFiles);
  const manifest = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
  if (manifest.version !== packageJson.version) {
    throw new Error(`Версия manifest (${manifest.version}) != package.json (${packageJson.version})`);
  }
  if (!manifest.background?.service_worker || !manifest.side_panel?.default_path) {
    throw new Error('В архиве отсутствуют service worker или side panel');
  }

  verifyFirefoxPackage();
  verifySourcePackage();

  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    userDataDir,
    args: extensionLaunchArgs(unpacked),
  });
  const worker = await browser.waitForTarget(
    (target) =>
      target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 30000 },
  );
  const extensionId = new URL(worker.url()).host;

  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await panel.waitForSelector('#root');
  await panel.waitForFunction(
    () => (document.getElementById('root')?.textContent ?? '').trim().length > 0,
    { timeout: 15000 },
  );

  console.log(`Chrome-архив: ${chromeName} (${Object.keys(chromeFiles).length} файлов, SHA-256 OK)`);
  console.log(`Расширение загружено: ${extensionId}`);
  console.log('RELEASE PASS: Chrome zip устанавливается и side panel рендерится.');
} finally {
  await browser?.close().catch(() => undefined);
  for (const directory of tempDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
}
