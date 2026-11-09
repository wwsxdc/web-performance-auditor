import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function findChrome() {
  const testingCandidates = [];
  const cacheRoot = path.join(homedir(), '.cache', 'puppeteer', 'chrome');
  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      testingCandidates.push(path.join(cacheRoot, entry, 'chrome-win64', 'chrome.exe'));
      testingCandidates.push(path.join(cacheRoot, entry, 'chrome-linux64', 'chrome'));
    }
  }

  // Branded Chrome ignores --load-extension; prefer Chrome for Testing.
  const candidates = [
    process.env.WPA_CHROME_PATH,
    ...testingCandidates,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Chrome не найден. Укажите WPA_CHROME_PATH или установите Chrome for Testing.',
    );
  }
  if (!testingCandidates.includes(found) && found !== process.env.WPA_CHROME_PATH) {
    console.warn(
      `[WPA] Chrome for Testing не найден, используется ${found}. ` +
        'Брендовый Chrome 137+ игнорирует --load-extension: если тест упадёт ' +
        'с таймаутом service worker, установите Chrome for Testing.',
    );
  }
  return found;
}

// GitHub-hosted Linux runners disable unprivileged user namespaces, so Chrome
// aborts with "No usable sandbox!" unless the sandbox is turned off. Keep the
// flags in one place: benchmarks launch a baseline browser without extensions.
export function baseLaunchArgs() {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox']
      : []),
  ];
}

export function extensionLaunchArgs(dist) {
  return [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    ...baseLaunchArgs(),
    '--host-resolver-rules=MAP blocked.test 127.0.0.1',
    '--window-size=1280,900',
  ];
}
