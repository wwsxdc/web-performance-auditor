/**
 * Builds the 1280×800 screenshots for the Mozilla Add-ons listing from a real
 * Chrome build of the extension.
 *
 * Usage:
 *   npm run build
 *   node e2e/screenshots.mjs
 *
 * The script starts a local demo page, runs a real audit session (including an
 * experiment), captures the side panel at 420×800, and composes each frame with
 * the audited page inside a browser window mock.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionLaunchArgs, findChrome } from './chrome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outputDir = path.join(root, 'docs/amo/screenshots');
const tempDir = mkdtempSync(path.join(tmpdir(), 'wpa-shots-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('dist/ не собран. Сначала выполните npm run build.');
}

const demoHtml = await readFile(new URL('./demo.html', import.meta.url), 'utf8');
let port = 0;
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(demoHtml);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;
const origin = `http://demo.local:${port}`;

const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-shots-profile-'));
let browser;

try {
  const launchArgs = extensionLaunchArgs(dist).map((argument) =>
    argument.startsWith('--host-resolver-rules=')
      ? '--host-resolver-rules=MAP blocked.test 127.0.0.1, MAP demo.local 127.0.0.1'
      : argument,
  );
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    userDataDir,
    args: launchArgs,
  });

  const worker = await browser.waitForTarget(
    (target) =>
      target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 30000 },
  );
  const extensionId = new URL(worker.url()).host;

  const page = await browser.newPage();
  await page.setViewport({ width: 840, height: 752, deviceScaleFactor: 2 });
  await page.goto(origin, { waitUntil: 'load' });
  await sleep(1300);

  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 800, deviceScaleFactor: 2 });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await panel.waitForSelector('#root');
  await panel.waitForFunction(
    () => (document.getElementById('root')?.textContent ?? '').trim().length > 0,
    { timeout: 15000 },
  );

  const send = (type, payload = {}) =>
    panel.evaluate(
      async (messageType, data) =>
        chrome.runtime.sendMessage({
          ...data,
          type: messageType,
          requestId: crypto.randomUUID(),
        }),
      type,
      payload,
    );

  const getState = async () => (await send('GET_STATE'))?.state;

  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      last = await getState();
      if (predicate(last)) return last;
      await sleep(200);
    }
    throw new Error(`Таймаут: ${label}; state=${JSON.stringify(last)}`);
  };

  const tabId = await panel.evaluate(async (demoOrigin) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(demoOrigin))?.id;
  }, origin);
  if (typeof tabId !== 'number') throw new Error('Демо-вкладка не найдена');

  await send('SESSION_START', { tabId });

  await waitFor(
    (state) => {
      const names = new Set((state?.session?.metrics ?? []).map((metric) => metric.name));
      return ['LCP', 'CLS', 'FCP', 'TTFB'].every((name) => names.has(name));
    },
    'метрики загрузки',
  );

  await page.bringToFront();
  await page.click('#cta');
  await panel.bringToFront();
  await waitFor(
    (state) =>
      state?.session?.metrics?.some(
        (metric) => metric.name === 'INP' && metric.status === 'measured',
      ),
    'INP',
  );

  await page.bringToFront();
  await page.waitForFunction(
    () => Boolean(document.getElementById('wpa-diagnostic-overlay-LCP')),
    { timeout: 10000 },
  );
  await sleep(500);
  const pageShot = path.join(tempDir, 'page.png');
  await page.screenshot({ path: pageShot, type: 'png' });

  const capturePanel = async (name) => {
    await panel.bringToFront();
    await sleep(350);
    const target = path.join(tempDir, `${name}.png`);
    await panel.screenshot({ path: target, type: 'png' });
    return target;
  };

  const scrollTop = () =>
    panel.evaluate(() => {
      window.scrollTo(0, 0);
    });

  await scrollTop();
  const overview = await capturePanel('overview');

  await panel.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(
      (button) => button.querySelector('h3')?.textContent?.trim() === 'LCP',
    );
    card?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('Детали LCP'), {
    timeout: 10000,
  });
  await panel.evaluate(() => {
    const heading = [...document.querySelectorAll('h2, h3')].find((element) =>
      element.textContent?.includes('Детали LCP'),
    );
    heading?.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -18);
  });
  await sleep(350);
  const details = await capturePanel('details');

  await panel.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent?.trim() === 'События',
    );
    tab?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('События'), {
    timeout: 10000,
  });
  await scrollTop();
  const events = await capturePanel('events');

  await panel.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent?.trim() === 'Эксперименты',
    );
    tab?.click();
  });
  await panel.waitForFunction(
    () => document.body.innerText.includes('Запустить эксперимент'),
    { timeout: 10000 },
  );

  await panel.evaluate(() => {
    document.querySelector('input[type="checkbox"]')?.click();
  });

  // LCP/CLS are not produced for a document that paints while hidden, so the
  // audited tab must stay in front across the experimental reload.
  await page.bringToFront();
  const timeOriginBefore = await page.evaluate(() => performance.timeOrigin);
  await panel.evaluate(() => {
    const start = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Запустить эксперимент',
    );
    start?.click();
  });

  await page.waitForFunction(
    (previousOrigin) =>
      performance.timeOrigin !== previousOrigin && document.readyState === 'complete',
    { timeout: 30000 },
    timeOriginBefore,
  );
  await sleep(1200);
  await page.click('#cta');
  // Hiding the page flushes the pending INP entry, same as in real use when
  // the user returns to the sidebar.
  await panel.bringToFront();

  await panel.waitForFunction(
    () => document.body.innerText.includes('Завершить эксперимент'),
    { timeout: 40000 },
  );
  await waitFor(
    (state) =>
      state?.session?.metrics?.some(
        (metric) => metric.name === 'INP' && metric.status === 'measured',
      ),
    'INP эксперимента',
  );

  await panel.evaluate(() => {
    const finish = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Завершить эксперимент',
    );
    finish?.click();
  });
  await panel.waitForFunction(
    () => document.body.innerText.includes('Последний эксперимент'),
    { timeout: 30000 },
  );
  await scrollTop();
  const experiments = await capturePanel('experiments');

  await panel.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (element) => element.textContent?.trim() === 'Данные',
    );
    tab?.click();
  });
  await panel.waitForFunction(() => document.body.innerText.includes('Экспорт'), {
    timeout: 10000,
  });
  await scrollTop();
  const data = await capturePanel('data');

  const pageBase64 = (await readFile(pageShot)).toString('base64');
  const composer = await browser.newPage();
  await composer.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const compose = async (panelPath, outputName) => {
    const panelBase64 = (await readFile(panelPath)).toString('base64');
    await composer.setContent(
      `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <style>
          html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; background: #e9edf5; }
          .stage { display: flex; width: 1280px; height: 800px; }
          .browser { display: flex; flex-direction: column; width: 840px; height: 800px; background: #fff; }
          .chrome {
            display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 16px;
            background: #dfe5f0; border-bottom: 1px solid #c9d1e0; box-sizing: border-box;
          }
          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .red { background: #ef6b62; } .amber { background: #f4bd4f; } .green { background: #5fc26d; }
          .url {
            display: flex; align-items: center; flex: 1; height: 26px; margin-left: 12px;
            padding: 0 12px; border-radius: 8px; background: #fff;
            color: #5c6475; font: 12px/1 ui-sans-serif, system-ui, sans-serif;
          }
          .page { display: block; width: 840px; height: 752px; object-fit: cover; object-position: top left; }
          .panel {
            width: 420px; height: 800px; margin-left: 20px; overflow: hidden; background: #f9fafb;
            border-left: 1px solid #cfd6e4; box-shadow: -12px 0 30px rgb(27 31 42 / 8%);
          }
          .panel img { display: block; width: 420px; height: 800px; }
        </style>
      </head>
      <body>
        <div class="stage">
          <div class="browser">
            <div class="chrome">
              <span class="dot red"></span><span class="dot amber"></span><span class="dot green"></span>
              <div class="url">${origin}/</div>
            </div>
            <img class="page" src="data:image/png;base64,${pageBase64}" alt="" />
          </div>
          <div class="panel">
            <img src="data:image/png;base64,${panelBase64}" alt="" />
          </div>
        </div>
      </body>
      </html>`,
      { waitUntil: 'load' },
    );
    await composer.evaluate(async () => {
      await Promise.all(
        [...document.images].map((image) => image.decode().catch(() => undefined)),
      );
    });
    const output = path.join(outputDir, outputName);
    await composer.screenshot({ path: output, type: 'png' });
    console.log(`Скриншот: ${path.relative(root, output)}`);
  };

  await mkdir(outputDir, { recursive: true });
  await compose(overview, '01-overview.png');
  await compose(details, '02-metric-details.png');
  await compose(events, '03-events.png');
  await compose(experiments, '04-experiments.png');
  await compose(data, '05-data.png');

  console.log('Готово: 5 скриншотов 1280×800 в docs/amo/screenshots/.');
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
}
