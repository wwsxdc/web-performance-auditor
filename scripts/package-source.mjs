/**
 * Builds the source archive required by Mozilla Add-ons review.
 *
 * The published extension bundle is minified, so AMO needs the original
 * TypeScript sources plus a lockfile and build instructions. The archive is
 * reproducible (sorted entries, fixed mtime) and is written next to the
 * extension zips in `release/`.
 *
 * Usage: npm run package:source
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const FIXED_MTIME = new Date(2020, 0, 1, 0, 0, 0);

// Only files needed to rebuild the Firefox package are included. Internal
// plans, QA reports, generated bundles and build output stay out of the archive.
const INCLUDED = [
  /^src\//,
  /^public\/icons\//,
  /^scripts\//,
  /^e2e\//,
  /^docs\/firefox\.md$/,
  /^docs\/amo\/build-instructions\.md$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^SECURITY\.md$/,
  /^manifest\.json$/,
  /^manifest\.firefox\.json$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^vite\.config\.ts$/,
  /^tsconfig\.json$/,
  /^vitest\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^\.nvmrc$/,
  /^\.editorconfig$/,
];

const FORBIDDEN = [
  /^node_modules\//,
  /^dist(-firefox)?\//,
  /^release\//,
  /^public\/generated\//,
  /^\.git\//,
  /^\.opencode\//,
];

const REQUIRED = [
  'package.json',
  'package-lock.json',
  'manifest.firefox.json',
  'vite.config.ts',
  'src/content/page-script.ts',
  'src/content/index.ts',
  'scripts/build-firefox.mjs',
  'docs/amo/build-instructions.md',
];

function gitEntries() {
  // --others includes new source files before the first commit; ignored files
  // (internal plans, generated bundles, build output) are still excluded.
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean);
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

const selected = gitEntries()
  .filter((name) => INCLUDED.some((pattern) => pattern.test(name)))
  .filter((name) => !FORBIDDEN.some((pattern) => pattern.test(name)))
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

for (const name of REQUIRED) {
  if (!selected.includes(name)) {
    throw new Error(`Source-архив: обязательный файл отсутствует — ${name}`);
  }
}

for (const name of selected) {
  if (name.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Source-архив: небезопасный путь — ${name}`);
  }
}

if (selected.length < 40) {
  throw new Error(
    `Source-архив: подозрительно мало файлов (${selected.length}) — проверьте git-состояние`,
  );
}

const files = {};
for (const name of selected) {
  files[name] = [await readFile(path.join(root, ...name.split('/'))), { mtime: FIXED_MTIME, level: 9 }];
}

const archive = zipSync(files, { level: 9, mtime: FIXED_MTIME });
const archiveName = `web-performance-auditor-firefox-${version}-source.zip`;
const archivePath = path.join(releaseDir, archiveName);

await mkdir(releaseDir, { recursive: true });
await writeFile(archivePath, archive);

const checksum = createHash('sha256').update(archive).digest('hex');
await writeFile(`${archivePath}.sha256`, `${checksum}  ${archiveName}\n`, 'utf8');

console.log(`Source-архив: release/${archiveName}`);
console.log(`  файлов: ${selected.length}`);
console.log(`  SHA-256: ${checksum}`);
