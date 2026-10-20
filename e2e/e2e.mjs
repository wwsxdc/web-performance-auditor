/**
 * End-to-end smoke test for the Web Performance Auditor extension.
 *
 * Usage:
 *   npm run build
 *   npm run test:e2e            # headed Chrome
 *   HEADLESS=1 npm run test:e2e # headless (where extensions are supported)
 *
 * WPA_CHROME_PATH overrides the detected Chrome executable.
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const headless = process.env.HEADLESS === '1';

function findChrome() {
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
  return found;
}

const checks = [];
function check(name, condition, details) {
  checks.push({ name, pass: Boolean(condition), details });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details ? ` — ${details}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error('dist/ не собран. Сначала выполните npm run build.');
  }

  const fixture = await startFixtureServer();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-e2e-'));
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless,
      userDataDir,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--host-resolver-rules=MAP blocked.test 127.0.0.1',
        '--window-size=1280,900',
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-setuid-sandbox']
          : []),
      ],
    });

    const swTarget = await browser.waitForTarget(
      (target) =>
        target.type() === 'service_worker' &&
        target.url().startsWith('chrome-extension://'),
      { timeout: 30000 },
    );
    const extensionId = new URL(swTarget.url()).host;

    const target = await browser.newPage();
    await target.setViewport({ width: 1000, height: 800 });
    await target.goto(`${fixture.origin}/?token=secret`, { waitUntil: 'load' });

    await sleep(800);
    check(
      'BASELINE_BLOCKED_SCRIPT',
      (await target.evaluate(() => window.__blockedLoaded)) === true,
      'blocked.test served before the experiment',
    );

    const panel = await browser.newPage();
    await panel.setViewport({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    await panel.waitForSelector('#root');

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

    const panelTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    const unsupportedStart = await send('SESSION_START', { tabId: panelTabId });
    check(
      'UNSUPPORTED_START',
      unsupportedStart?.accessible === false && typeof unsupportedStart?.error === 'string',
      JSON.stringify(unsupportedStart),
    );
    const unsupportedState = await getState();
    check(
      'UNSUPPORTED_STATUS',
      unsupportedState?.collectorStatus === 'unsupported' && unsupportedState?.session === null,
      `status=${unsupportedState?.collectorStatus}, session=${unsupportedState?.session?.id ?? 'null'}`,
    );
    await panel.waitForFunction(
      () => document.body.innerText.includes('Страница не поддерживается'),
      { timeout: 5000 },
    );
    const unsupportedPanel = await panel.evaluate(() => ({
      text: document.body.innerText,
      hasStart: Boolean(document.querySelector('button[aria-label="Начать аудит"]')),
    }));
    check(
      'UNSUPPORTED_RETRY_VISIBLE',
      unsupportedPanel.text.includes('Страница не поддерживается') && unsupportedPanel.hasStart,
      'header start control remains available',
    );

    const tabId = await panel.evaluate((origin) => {
      return chrome.tabs
        .query({})
        .then((tabs) => tabs.find((tab) => tab.url?.startsWith(origin))?.id);
    }, fixture.origin);
    check('TARGET_TAB', typeof tabId === 'number', `tabId=${tabId}`);
    if (typeof tabId !== 'number') throw new Error('Целевая вкладка не найдена');

    const start = await send('SESSION_START', { tabId });
    check(
      'SESSION_START',
      start?.session?.status === 'active' && start?.accessible === true,
      `session=${start?.session?.id?.slice(0, 8)}`,
    );
    const recoveredState = await getState();
    await panel.waitForFunction(
      () =>
        !document.body.innerText.includes('Страница не поддерживается') &&
        Boolean(document.querySelector('button[aria-label="Остановить наблюдение"]')),
      { timeout: 5000 },
    );
    const recoveredPanel = await panel.evaluate(() => ({
      text: document.body.innerText,
      hasStop: Boolean(document.querySelector('button[aria-label="Остановить наблюдение"]')),
    }));
    check(
      'UNSUPPORTED_RECOVERY',
      (recoveredState?.collectorStatus === 'initializing' ||
        recoveredState?.collectorStatus === 'collecting') &&
        recoveredState?.session?.id === start?.session?.id &&
        recoveredPanel.hasStop &&
        !recoveredPanel.text.includes('Страница не поддерживается'),
      `status=${recoveredState?.collectorStatus}`,
    );

    await target.bringToFront();
    await target.click('#btn');
    await panel.bringToFront();

    const waitFor = async (predicate, label, timeout = 20000) => {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeout) {
        last = await getState();
        if (predicate(last)) return last;
        await sleep(200);
      }
      throw new Error(`Таймаут ожидания: ${label}; state=${JSON.stringify(last)}`);
    };

    const state = await waitFor(
      (candidate) => {
        const names = new Set((candidate?.session?.metrics ?? []).map((metric) => metric.name));
        return ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'].every((name) => names.has(name));
      },
      'all metrics',
    );

    const names = [...new Set(state.session.metrics.map((metric) => metric.name))].sort();
    check(
      'METRIC_NAMES',
      names.join(',') === 'CLS,FCP,INP,LCP,TTFB',
      names.join(','),
    );
    check(
      'ATTRIBUTION',
      state.session.metrics.some((metric) => metric.name === 'LCP' && metric.attribution),
      'LCP attribution present',
    );
    check(
      'LONG_TASK_EVENT',
      state.session.events.some((event) => event.type === 'long-task'),
      `events=${state.session.events.length}`,
    );
    check(
      'INP_MEASURED',
      state.session.metrics.some((metric) => metric.name === 'INP' && metric.status === 'measured'),
      'INP measured after click',
    );

    await panel.click('button[aria-label^="Метрика INP"]');
    await panel.waitForFunction(() => document.body.innerText.includes('Детали INP'));
    const detailsText = await panel.evaluate(() => document.body.innerText);
    const detailsFlags = {
      time: detailsText.includes('Время измерения'),
      reliability: detailsText.includes('Статус достоверности'),
      // The section heading is rendered with text-transform: uppercase.
      events: detailsText.toLowerCase().includes('связанные события'),
      copy: detailsText.includes('Скопировать диагностику'),
    };
    check(
      'METRIC_DETAILS',
      Object.values(detailsFlags).every(Boolean),
      JSON.stringify(detailsFlags),
    );
    const overlayControls = await panel.evaluate(() => ({
      checkboxes: document.querySelectorAll('fieldset input[type="checkbox"]').length,
      hasClearAll: document.body.innerText.includes('Снять все оверлеи'),
    }));
    check(
      'OVERLAY_CONTROLS',
      overlayControls.checkboxes === 3 && overlayControls.hasClearAll,
      JSON.stringify(overlayControls),
    );

    const lcpHighlight = await send('HIGHLIGHT_TARGET', {
      tabId,
      target: {
        targetId: 'e2e-lcp',
        selector: '#hero',
        color: 'green',
        label: 'LCP · E2E',
        metricName: 'LCP',
      },
    });
    const inpHighlight = await send('HIGHLIGHT_TARGET', {
      tabId,
      target: {
        targetId: 'e2e-inp',
        selector: '#btn',
        color: 'yellow',
        label: 'INP · E2E',
        metricName: 'INP',
      },
    });
    const overlayState = await target.evaluate(() => {
      const lcpHost = document.getElementById('wpa-diagnostic-overlay-LCP');
      const inpHost = document.getElementById('wpa-diagnostic-overlay-INP');
      const lcpBox = lcpHost?.shadowRoot?.querySelector('.box');
      const inpBox = inpHost?.shadowRoot?.querySelector('.box');
      return {
        both: Boolean(lcpHost && inpHost),
        lcpVisible: lcpBox?.style.display === 'block',
        inpVisible: inpBox?.style.display === 'block',
        zIndex: lcpHost?.style.zIndex,
        pointerEvents: lcpHost?.style.pointerEvents,
      };
    });
    check(
      'OVERLAYS_MULTI',
      lcpHighlight?.available === true &&
        inpHighlight?.available === true &&
        overlayState.both &&
        overlayState.lcpVisible &&
        overlayState.inpVisible,
      JSON.stringify(overlayState),
    );
    check(
      'OVERLAY_ISOLATION',
      overlayState.zIndex === '2147483647' && overlayState.pointerEvents === 'none',
      'fixed host, pointer-events none',
    );

    await panel.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.includes('Снять все оверлеи'),
      );
      button?.click();
    });
    await sleep(300);
    const overlaysAfterClear = await target.evaluate(
      () => document.querySelectorAll('[id^="wpa-diagnostic-overlay"]').length,
    );
    check('OVERLAY_CLEAR_ALL', overlaysAfterClear === 0, `hosts=${overlaysAfterClear}`);

    const unauthorized = await send('HIGHLIGHT_TARGET', {
      tabId: tabId + 5000,
      target: { targetId: 'bad', selector: '#hero', color: 'green', metricName: 'LCP' },
    });
    check(
      'HIGHLIGHT_AUTHORIZATION',
      unauthorized?.success === false,
      unauthorized?.reason ?? 'no reason',
    );
    const badStop = await send('SESSION_STOP', { sessionId: 'not-the-active-session' });
    check('STOP_AUTHORIZATION', typeof badStop?.error === 'string', badStop?.error);

    await target.goto(`${fixture.origin}/second?token=secret`, { waitUntil: 'load' });
    const afterDoc = await waitFor(
      (candidate) => (candidate?.session?.navigations?.length ?? 0) >= 2,
      'document navigation segment',
    );
    check(
      'DOCUMENT_NAVIGATION',
      afterDoc.session.navigations.at(-1)?.kind === 'document',
      `segments=${afterDoc.session.navigations.length}`,
    );

    await target.bringToFront();
    await target.click('#btn');
    await target.evaluate(() => history.pushState({}, '', '/spa'));
    const afterSpa = await waitFor(
      (candidate) =>
        (candidate?.session?.navigations ?? []).some((navigation) => navigation.kind === 'spa'),
      'SPA navigation segment',
    );
    check(
      'SPA_NAVIGATION',
      afterSpa.session.navigations.some((navigation) => navigation.kind === 'spa'),
      `segments=${afterSpa.session.navigations.length}`,
    );
    check(
      'SPA_NAVIGATION_EVENT',
      afterSpa.session.events.some((event) => event.type === 'spa-navigation'),
      `events=${afterSpa.session.events.length}`,
    );

    const baselineSessionId = afterSpa.session.id;
    // Bring the audited tab to front BEFORE the experimental reload: LCP/CLS
    // are not produced for a document that paints while hidden.
    await target.bringToFront();
    const timeOriginBefore = await target.evaluate(() => performance.timeOrigin);
    const experimentStart = await send('EXPERIMENT_START', {
      tabId,
      baselineSessionId,
      preset: 'custom',
      domains: ['blocked.test'],
    });
    check(
      'EXPERIMENT_START',
      experimentStart?.experiment?.status === 'running' &&
        experimentStart?.session?.status === 'active',
      `id=${experimentStart?.experiment?.id?.slice(0, 8)}`,
    );

    await target.waitForFunction(
      (previousOrigin) =>
        performance.timeOrigin !== previousOrigin && document.readyState === 'complete',
      { timeout: 30000 },
      timeOriginBefore,
    );
    await sleep(1200);
    check(
      'BLOCKED_AFTER_RELOAD',
      (await target.evaluate(() => window.__blockedLoaded)) === false,
      'blocked.test is now blocked in the experiment tab',
    );

    const worker = await (await browser.waitForTarget(
      (candidate) =>
        candidate.type() === 'service_worker' &&
        candidate.url().startsWith('chrome-extension://'),
    )).worker();
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    check(
      'EXPERIMENT_DNR_RULES',
      rules.length === 1 && rules[0]?.id === 10000 && rules[0]?.condition?.tabIds?.[0] === tabId,
      JSON.stringify(rules.map((rule) => ({ id: rule.id, tabIds: rule.condition?.tabIds }))),
    );

    const experimentId = experimentStart.experiment.id;
    const experimentSessionId = experimentStart.session.id;
    const experimentState = await waitFor(
      (candidate) =>
        candidate?.session?.id === experimentSessionId &&
        (candidate.session.metrics ?? []).some((metric) => metric.name === 'LCP'),
      'experiment metrics',
    );
    check(
      'EXPERIMENT_METRICS',
      experimentState.session.id === experimentSessionId,
      `metrics=${experimentState.session.metrics.length}`,
    );
    const experimentNavigations = experimentState.session.navigations;
    check(
      'EXPERIMENT_SESSION_ISOLATED',
      experimentNavigations.length === 2 &&
        experimentNavigations.at(-1)?.kind === 'document' &&
        experimentState.session.metrics.every(
          (metric) => metric.observedAt >= experimentStart.session.startedAt,
        ),
      `navigations=${experimentNavigations.length}`,
    );

    const finish = await send('EXPERIMENT_FINISH', { experimentId });
    check(
      'EXPERIMENT_FINISH',
      ['completed', 'incomplete'].includes(finish?.experiment?.status) &&
        finish?.experiment?.cleanupVerified === true &&
        finish?.experiment?.cleanupStatus === 'completed',
      `status=${finish?.experiment?.status}`,
    );
    const rulesAfter = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    check('DNR_CLEANUP', rulesAfter.length === 0, `rules=${rulesAfter.length}`);

    const markdown = await send('EXPORT_MARKDOWN', {
      sessionId: experimentSessionId,
      experimentId,
    });
    check(
      'EXPORT_MARKDOWN',
      typeof markdown?.markdown === 'string' &&
        markdown.markdown.includes('## Эксперимент') &&
        markdown.markdown.includes('Очистка правил: completed') &&
        !markdown.markdown.includes('token=secret'),
      `length=${markdown?.markdown?.length ?? 0}`,
    );

    const json = await send('EXPORT_JSON', { sessionId: experimentSessionId });
    const report = json?.report;
    check(
      'EXPORT_JSON',
      report?.reportVersion === 1 &&
        Array.isArray(report?.attribution) &&
        Array.isArray(report?.metrics) &&
        report.metrics.length > 0 &&
        report.attribution.length > 0 &&
        !JSON.stringify(report).includes('token=secret') &&
        JSON.stringify(report).length > 100,
      `metrics=${report?.metrics?.length ?? 0}, attribution=${report?.attribution?.length ?? 0}`,
    );

    const historySession = await send('SESSION_START', { tabId });
    check(
      'HISTORY_SESSION_START',
      historySession?.session?.status === 'active' && historySession?.accessible === true,
      `session=${historySession?.session?.id?.slice(0, 8)}`,
    );
    const historyHighlight = await send('HIGHLIGHT_TARGET', {
      tabId,
      target: {
        targetId: 'e2e-history-lcp',
        selector: '#hero',
        color: 'green',
        label: 'LCP · history',
        metricName: 'LCP',
      },
    });
    await sleep(200);
    const overlaysBeforeHistoryClear = await target.evaluate(
      () => document.querySelectorAll('[id^="wpa-diagnostic-overlay"]').length,
    );
    check(
      'HISTORY_CLEAR_OVERLAY_SETUP',
      historyHighlight?.available === true && overlaysBeforeHistoryClear > 0,
      `hosts=${overlaysBeforeHistoryClear}`,
    );

    const cleared = await send('CLEAR_HISTORY');
    check(
      'CLEAR_HISTORY',
      cleared?.success === true && cleared?.rulesPurged === true,
      JSON.stringify(cleared),
    );
    const overlaysAfterHistoryClear = await target.evaluate(
      () => document.querySelectorAll('[id^="wpa-diagnostic-overlay"]').length,
    );
    check(
      'HISTORY_CLEAR_OVERLAYS',
      overlaysAfterHistoryClear === 0,
      `hosts=${overlaysAfterHistoryClear}`,
    );
    const afterClear = await getState();
    check(
      'AFTER_CLEAR',
      afterClear?.session === null && afterClear?.collectorStatus === 'idle',
      `session=${afterClear?.session?.id ?? 'null'}, status=${afterClear?.collectorStatus}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await fixture.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.pass);
  console.log('');
  if (failed.length > 0) {
    console.log(`E2E FAIL (${failed.length}/${checks.length})`);
    for (const entry of failed) console.log(` - ${entry.name}: ${entry.details ?? ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`E2E PASS (${checks.length} checks)`);
}

main().catch((error) => {
  console.error('E2E ERROR', error);
  process.exitCode = 1;
});
