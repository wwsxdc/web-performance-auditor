/**
 * Builds the distributable zip from dist/ with a reproducible archive:
 * sorted entries, fixed mtime, maximum compression. Writes the checksum next
 * to the archive. Usage: npm run package (builds first) or node scripts/package.mjs.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
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

const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const version = manifest.version;
const archiveName = `web-performance-auditor-${version}.zip`;

const files = await collect(dist);
if (Object.keys(files).length === 0) {
  throw new Error('dist/ пуст — сначала выполните npm run build');
}

const archive = zipSync(files, { level: 9, mtime: FIXED_MTIME });
await mkdir(releaseDir, { recursive: true });
const archivePath = path.join(releaseDir, archiveName);
await writeFile(archivePath, archive);

const checksum = createHash('sha256').update(archive).digest('hex');
await writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`, 'utf8');

console.log(`Архив: release/${archiveName}`);
console.log(`Файлов: ${Object.keys(files).length}`);
console.log(`SHA-256: ${checksum}`);
