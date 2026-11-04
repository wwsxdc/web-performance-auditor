/**
 * Verifies that the release zip can be unpacked and loaded as an extension.
 * Usage: npm run verify:release (expects release/*.zip from npm run package).
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { extensionLaunchArgs, findChrome } from '../e2e/chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const headless = process.env.HEADLESS !== '0';

const archives = (await readdir(releaseDir)).filter((name) => name.endsWith('.zip'));
if (archives.length === 0) {
  throw new Error('В release/ нет zip. Сначала выполните npm run package.');
}
archives.sort();
const archiveName = archives.at(-1);
const archivePath = path.join(releaseDir, archiveName);

const unpacked = mkdtempSync(path.join(tmpdir(), 'wpa-release-'));
const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-release-profile-'));
let browser;

try {
  const files = unzipSync(readFileSync(archivePath));
  for (const [name, bytes] of Object.entries(files)) {
    const destination = path.join(unpacked, ...name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }

  const manifest = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== packageJson.version) {
    throw new Error(`Версия manifest (${manifest.version}) != package.json (${packageJson.version})`);
  }
  if (!manifest.background?.service_worker || !manifest.side_panel?.default_path) {
    throw new Error('В архиве отсутствуют service worker или side panel');
  }

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

  console.log(`Архив: ${archiveName} (${Object.keys(files).length} файлов)`);
  console.log(`Расширение загружено: ${extensionId}`);
  console.log('RELEASE PASS: zip устанавливается и side panel рендерится.');
} finally {
  await browser?.close().catch(() => undefined);
  rmSync(unpacked, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
