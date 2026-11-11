/**
 * Builds the distributable zips from `dist/` and `dist-firefox/` with
 * reproducible archives: sorted entries, fixed mtime, maximum compression.
 * Writes a checksum next to each archive.
 *
 * Usage: npm run package (builds both targets first) or node scripts/package.mjs.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
// A fixed timestamp keeps the zip checksum stable across machines. fflate
// writes DOS timestamps with local-time getters, so build the date from local
// components; a UTC-based Date would encode a different hour per timezone.
const FIXED_MTIME = new Date(2020, 0, 1, 0, 0, 0);

async function collect(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  // Code-point order keeps the archive independent of ICU/locale collation.
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  const files = {};
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await collect(absolute, relative));
    } else if (entry.isFile()) {
      files[relative] = [await readFile(absolute), { mtime: FIXED_MTIME, level: 9 }];
    }
  }
  return files;
}

async function readManifest(directory, label) {
  try {
    return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(
      `${label}: manifest.json не найден в ${path.relative(root, directory)} — сначала выполните сборку`,
    );
  }
}

function validateChrome(manifest) {
  if (!manifest.background?.service_worker || !manifest.side_panel?.default_path) {
    throw new Error('Chrome-манифест: отсутствуют service_worker или side_panel');
  }
}

function validateFirefox(manifest) {
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('Firefox-манифест: отсутствует browser_specific_settings.gecko.id');
  }
  if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
    throw new Error('Firefox-манифест: отсутствует background.scripts');
  }
  if (!manifest.sidebar_action?.default_panel) {
    throw new Error('Firefox-манифест: отсутствует sidebar_action.default_panel');
  }
}

async function writeArchive({
  directory,
  archiveName,
  manifest,
  validate,
  label,
  buildCommand,
}) {
  try {
    await stat(path.join(directory, 'manifest.json'));
  } catch {
    throw new Error(
      `${label}: ${path.relative(root, directory)}/ не собран — выполните ${buildCommand}`,
    );
  }
  validate(manifest);

  const files = await collect(directory);
  if (Object.keys(files).length === 0) {
    throw new Error(`${label}: ${path.relative(root, directory)}/ пуст`);
  }

  const archive = zipSync(files, { level: 9, mtime: FIXED_MTIME });
  const archivePath = path.join(releaseDir, archiveName);
  await writeFile(archivePath, archive);

  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`, 'utf8');

  console.log(`Архив: release/${archiveName}`);
  console.log(`  ${label}: ${Object.keys(files).length} файлов`);
  console.log(`  SHA-256: ${checksum}`);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const chromeManifest = await readManifest(path.join(root, 'dist'), 'Chrome');
const firefoxManifest = await readManifest(path.join(root, 'dist-firefox'), 'Firefox');

for (const [label, manifest] of [['Chrome', chromeManifest], ['Firefox', firefoxManifest]]) {
  if (manifest.version !== version) {
    throw new Error(
      `${label}-манифест: версия ${manifest.version} != package.json ${version}`,
    );
  }
}

await mkdir(releaseDir, { recursive: true });

await writeArchive({
  directory: path.join(root, 'dist'),
  archiveName: `web-performance-auditor-${version}.zip`,
  manifest: chromeManifest,
  validate: validateChrome,
  label: 'Chrome',
  buildCommand: 'npm run build',
});

await writeArchive({
  directory: path.join(root, 'dist-firefox'),
  archiveName: `web-performance-auditor-firefox-${version}.zip`,
  manifest: firefoxManifest,
  validate: validateFirefox,
  label: 'Firefox',
  buildCommand: 'npm run build:firefox',
});
