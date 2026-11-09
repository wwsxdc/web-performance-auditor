/**
 * Builds the Firefox package from the Chrome `dist/` build.
 *
 * CRXJS only emits a Chrome manifest and a service-worker entry. Firefox MV3
 * uses an event page (`background.scripts` + `type: "module"`) and
 * `sidebar_action` instead of `side_panel`, so this script copies the build and
 * swaps in `manifest.firefox.json`. Run `npm run build` first (or use
 * `npm run build:firefox`, which does both).
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const target = path.join(root, 'dist-firefox');

async function exists(relativePath) {
  try {
    await stat(path.join(target, ...relativePath.split('/')));
    return true;
  } catch {
    return false;
  }
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
    }
  }
}

function fail(message) {
  throw new Error(`Firefox-сборка: ${message}`);
}

const [chromeManifest, firefoxManifest] = await Promise.all([
  readFile(path.join(dist, 'manifest.json'), 'utf8').then(
    (text) => JSON.parse(text),
    () => fail('dist/manifest.json не найден — сначала выполните npm run build'),
  ),
  readFile(path.join(root, 'manifest.firefox.json'), 'utf8').then(JSON.parse),
]);

if (!chromeManifest.background?.service_worker || !chromeManifest.side_panel?.default_path) {
  fail('dist/manifest.json не похож на Chrome-сборку (нет service_worker или side_panel)');
}
if (firefoxManifest.manifest_version !== 3) {
  fail('manifest.firefox.json должен описывать Manifest V3');
}
if (firefoxManifest.version !== chromeManifest.version) {
  fail(
    `версия manifest.firefox.json (${firefoxManifest.version}) != dist/manifest.json (${chromeManifest.version})`,
  );
}

await rm(target, { recursive: true, force: true });
await copyTree(dist, target);

const scripts = firefoxManifest.background?.scripts;
if (!Array.isArray(scripts) || scripts.length === 0) {
  fail('background.scripts должен содержать хотя бы один скрипт');
}
if (firefoxManifest.background.type !== 'module') {
  fail('background.type должен быть "module" (CRXJS собирает ES-модули)');
}
for (const script of scripts) {
  if (!(await exists(script))) fail(`background.scripts: файл ${script} отсутствует`);
}

const panel = firefoxManifest.sidebar_action?.default_panel;
if (!panel || !(await exists(panel))) {
  fail(`sidebar_action.default_panel: файл ${panel ?? '(не задан)'} отсутствует`);
}

const permissions = firefoxManifest.permissions ?? [];
if (permissions.includes('sidePanel')) {
  fail('Firefox не поддерживает разрешение sidePanel — используйте sidebar_action');
}
if (!permissions.includes('scripting') || !permissions.includes('declarativeNetRequest')) {
  fail('permissions должны включать scripting и declarativeNetRequest');
}
if (firefoxManifest.side_panel || firefoxManifest.minimum_chrome_version) {
  fail('Chrome-only поля side_panel/minimum_chrome_version не должны попадать в Firefox-манифест');
}

const gecko = firefoxManifest.browser_specific_settings?.gecko;
if (!gecko?.id) fail('browser_specific_settings.gecko.id обязателен для подписи');
if (!gecko.strict_min_version) fail('browser_specific_settings.gecko.strict_min_version обязателен');

const iconPaths = new Set([
  ...Object.values(firefoxManifest.icons ?? {}),
  ...Object.values(firefoxManifest.sidebar_action?.default_icon ?? {}),
]);
for (const icon of iconPaths) {
  if (!(await exists(icon))) fail(`иконка ${icon} отсутствует`);
}

await writeFile(
  path.join(target, 'manifest.json'),
  `${JSON.stringify(firefoxManifest, null, 2)}\n`,
  'utf8',
);

console.log(`Firefox-сборка: dist-firefox/ (версия ${firefoxManifest.version})`);
console.log(`Background: ${scripts.join(', ')}`);
console.log(`Sidebar: ${panel}`);
