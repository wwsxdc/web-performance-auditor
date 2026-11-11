/**
 * Firefox smoke test for the Web Performance Auditor extension.
 *
 * Selenium/geckodriver installs `dist-firefox/` as a temporary add-on and
 * opens the sidebar panel through a privileged Marionette chrome context. That
 * is the only reliable way to reach `moz-extension://<uuid>/...`: WebDriver
 * navigation to that scheme is rejected in both classic and BiDi sessions.
 *
 * Usage:
 *   npm run build:firefox
 *   npm run test:e2e:firefox             # headless is opt-in
 *   HEADLESS=1 npm run test:e2e:firefox  # CI
 *
 * WPA_FIREFOX_PATH, WPA_GECKODRIVER_PATH and WPA_GECKODRIVER_VERSION override
 * the detected binaries.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { download as downloadGeckodriver } from 'geckodriver';
import { startFixtureServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-firefox');
const headless = process.env.HEADLESS === '1';
const EXTENSION_ID = 'web-performance-auditor@wwsxdc.github.io';

const checks = [];
function check(name, condition, details) {
  checks.push({ name, pass: Boolean(condition), details });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${details ? ` — ${details}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findFirefox() {
  const candidates = [
    process.env.WPA_FIREFOX_PATH,
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    '/usr/bin/firefox',
    '/usr/lib/firefox/firefox',
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'Firefox не найден. Укажите WPA_FIREFOX_PATH или установите Firefox.',
    );
  }
  return found;
}

function readExtensionUuid(profile, extensionId) {
  const prefsPath = path.join(profile, 'prefs.js');
  if (!existsSync(prefsPath)) return undefined;
  try {
    const prefs = readFileSync(prefsPath, 'utf8');
    const match = prefs.match(/extensions\.webextensions\.uuids", "(\{.*?\})"/);
    if (!match) return undefined;
    const uuids = JSON.parse(match[1].replace(/\\"/g, '"'));
    return uuids[extensionId];
  } catch {
    // prefs.js may still be flushing; the caller retries.
    return undefined;
  }
}

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error(
      'dist-firefox/ не собран. Сначала выполните npm run build:firefox.',
    );
  }

  // Required for driver.setContext('chrome'): Marionette refuses privileged
  // contexts unless this is set before Firefox starts.
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';

  const fixture = await startFixtureServer();
  const geckodriverPath =
    process.env.WPA_GECKODRIVER_PATH ??
    (await downloadGeckodriver(process.env.WPA_GECKODRIVER_VERSION));
  const options = new firefox.Options()
    .setBinary(findFirefox())
    .setPreference('network.dns.localDomains', 'blocked.test')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('browser.startup.page', 0)
    .setPreference('app.update.enabled', false)
    .addArguments(
      ...(headless ? ['-headless'] : []),
      '-width=1280',
      '-height=900',
    );

  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(geckodriverPath))
    .build();

  try {
    await driver.manage().setTimeouts({ script: 30000, pageLoad: 30000 });

    const extension = await driver.installWebExtension(dist, { permanent: false });
    check('FIREFOX_INSTALL', extension.id === EXTENSION_ID, extension.id);

    const profile = (await driver.getCapabilities()).get('moz:profile');
    let uuid;
    for (let attempt = 0; attempt < 20 && !uuid; attempt++) {
      uuid = readExtensionUuid(profile, extension.id);
      if (!uuid) await sleep(250);
    }
    check('FIREFOX_UUID', typeof uuid === 'string', uuid ?? 'не найден');
    if (!uuid) throw new Error('Не удалось определить UUID расширения');

    await driver.get(`${fixture.origin}/?token=secret`);
    await sleep(800);
    const fixtureHandle = await driver.getWindowHandle();

    // Open the panel as a real moz-extension:// tab from chrome scope.
    await driver.setContext('chrome');
    const panelUrl = `moz-extension://${uuid}/src/sidepanel/index.html`;
    await driver.executeScript(
      (url) => {
        const win = Services.wm.getMostRecentWindow('navigator:browser');
        const tab = win.gBrowser.addTab(url, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          inBackground: false,
        });
        win.gBrowser.selectedTab = tab;
        return tab.linkedBrowser.currentURI.spec;
      },
      panelUrl,
    );
    await driver.setContext('content');

    const handles = await driver.getAllWindowHandles();
    const panelHandle = handles.find((handle) => handle !== fixtureHandle);
    if (!panelHandle) throw new Error('Вкладка панели не открылась');
    await driver.switchTo().window(panelHandle);
    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      return url.startsWith('moz-extension://') && url.endsWith('/src/sidepanel/index.html');
    }, 15000);
    await driver.wait(async () => {
      const state = await driver.executeScript('return document.readyState');
      const text = await driver.executeScript(
        'return (document.getElementById("root")?.textContent ?? "").trim().length',
      );
      return state === 'complete' && text > 0;
    }, 15000);
    const panelText = await driver.executeScript('return document.body.innerText');
    check(
      'FIREFOX_PANEL',
      panelText.includes('CORE WEB VITALS') && panelText.includes('Аудит'),
      'панель отрендерена с browser.* API',
    );

    const send = (type, payload = {}) =>
      driver.executeAsyncScript(
        (messageType, data) => {
          const done = arguments[arguments.length - 1];
          Promise.resolve(
            browser.runtime.sendMessage({
              ...data,
              type: messageType,
              requestId: crypto.randomUUID(),
            }),
          )
            .then((response) => done({ ok: true, response }))
            .catch((error) =>
              done({ ok: false, error: String(error?.message ?? error) }),
            );
        },
        type,
        payload,
      );

    const sendOk = async (type, payload) => {
      const result = await send(type, payload);
      if (!result?.ok) throw new Error(`${type}: ${result?.error ?? 'нет ответа'}`);
      return result.response;
    };
    const getState = async () => (await sendOk('GET_STATE'))?.state;

    const targetTabId = await driver.executeAsyncScript((origin) => {
      const done = arguments[arguments.length - 1];
      browser.tabs
        .query({})
        .then((tabs) => done(tabs.find((tab) => tab.url?.startsWith(origin))?.id))
        .catch((error) => done({ error: String(error) }));
    }, fixture.origin);
    check('FIREFOX_TARGET_TAB', typeof targetTabId === 'number', `tabId=${targetTabId}`);
    if (typeof targetTabId !== 'number') throw new Error('Целевая вкладка не найдена');

    const start = await sendOk('SESSION_START', { tabId: targetTabId });
    check(
      'FIREFOX_SESSION_START',
      start?.session?.status === 'active' && start?.accessible === true,
      `session=${start?.session?.id?.slice(0, 8)}`,
    );
    if (!start?.session?.id) throw new Error('Сессия не создана');

    const waitForState = async (predicate, label, timeout = 30000) => {
      const started = Date.now();
      let last;
      while (Date.now() - started < timeout) {
        last = await getState();
        if (predicate(last)) return last;
        await sleep(250);
      }
      throw new Error(`Таймаут ожидания: ${label}; state=${JSON.stringify(last)}`);
    };

    await driver.switchTo().window(fixtureHandle);
    await driver.findElement({ css: '#btn' }).click();
    await driver.switchTo().window(panelHandle);

    const state = await waitForState(
      (candidate) => {
        const names = new Set((candidate?.session?.metrics ?? []).map((metric) => metric.name));
        return ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'].every((name) => names.has(name));
      },
      'все метрики',
    );
    check(
      'FIREFOX_METRICS',
      state?.session?.metrics?.some(
        (metric) => metric.name === 'LCP' && metric.status === 'measured',
      ) &&
        state.session.metrics.some(
          (metric) => metric.name === 'INP' && metric.status === 'measured',
        ),
      `metrics=${state?.session?.metrics?.length ?? 0}`,
    );
    check(
      'FIREFOX_ATTRIBUTION',
      state?.session?.metrics?.some(
        (metric) => metric.name === 'LCP' && metric.attribution,
      ),
      'LCP attribution present',
    );

    const highlight = await sendOk('HIGHLIGHT_TARGET', {
      tabId: targetTabId,
      target: {
        targetId: 'firefox-lcp',
        selector: '#hero',
        color: 'green',
        label: 'LCP · Firefox',
        metricName: 'LCP',
      },
    });
    await driver.switchTo().window(fixtureHandle);
    await sleep(300);
    const overlay = await driver.executeScript(
      'return Boolean(document.getElementById("wpa-diagnostic-overlay-LCP")?.shadowRoot?.querySelector(".box"))',
    );
    check(
      'FIREFOX_OVERLAY',
      highlight?.available === true && overlay === true,
      `available=${highlight?.available}, host=${overlay}`,
    );
    await driver.switchTo().window(panelHandle);
    await sendOk('CLEAR_HIGHLIGHT', { tabId: targetTabId, metricName: 'LCP' });

    const baselineSessionId = state.session.id;
    // Activate the audited tab inside the panel before sending the start
    // message: the background reloads it immediately, and LCP is not produced
    // for a document that paints while hidden.
    const experimentStart = await driver.executeAsyncScript(
      (tabId, data) => {
        const done = arguments[arguments.length - 1];
        browser.tabs
          .update(tabId, { active: true })
          .then(() =>
            browser.runtime.sendMessage({
              ...data,
              type: 'EXPERIMENT_START',
              requestId: crypto.randomUUID(),
            }),
          )
          .then((response) => done({ ok: true, response }))
          .catch((error) =>
            done({ ok: false, error: String(error?.message ?? error) }),
          );
      },
      targetTabId,
      {
        tabId: targetTabId,
        baselineSessionId,
        preset: 'custom',
        domains: ['blocked.test'],
      },
    );
    if (!experimentStart?.ok) {
      throw new Error(`EXPERIMENT_START: ${experimentStart?.error ?? 'нет ответа'}`);
    }
    const experimentResponse = experimentStart.response;
    check(
      'FIREFOX_EXPERIMENT_START',
      experimentResponse?.experiment?.status === 'running' &&
        experimentResponse?.session?.status === 'active',
      `id=${experimentResponse?.experiment?.id?.slice(0, 8)}`,
    );
    if (!experimentResponse?.experiment?.id) throw new Error('Эксперимент не создан');
    await driver.switchTo().window(fixtureHandle);

    const blockedState = await driver.wait(async () => {
      try {
        const loaded = await driver.executeScript('return window.__blockedLoaded');
        const ready = await driver.executeScript('return document.readyState');
        return loaded === false && ready === 'complete'
          ? { loaded, ready }
          : false;
      } catch {
        return false;
      }
    }, 30000);
    check(
      'FIREFOX_EXPERIMENT_BLOCKED',
      blockedState?.loaded === false && blockedState?.ready === 'complete',
      `blockedLoaded=${blockedState?.loaded}, readyState=${blockedState?.ready}`,
    );

    const experimentSessionId = experimentResponse.session.id;
    const experimentState = await (async () => {
      await driver.switchTo().window(panelHandle);
      return waitForState(
        (candidate) =>
          candidate?.session?.id === experimentSessionId &&
          (candidate.session.metrics ?? []).some((metric) => metric.name === 'LCP'),
        'метрики эксперимента',
      );
    })();
    check(
      'FIREFOX_EXPERIMENT_METRICS',
      experimentState?.session?.id === experimentSessionId,
      `metrics=${experimentState?.session?.metrics?.length ?? 0}`,
    );

    const finish = await sendOk('EXPERIMENT_FINISH', {
      experimentId: experimentResponse.experiment.id,
    });
    check(
      'FIREFOX_EXPERIMENT_FINISH',
      ['completed', 'incomplete'].includes(finish?.experiment?.status) &&
        finish?.experiment?.cleanupStatus === 'completed',
      `status=${finish?.experiment?.status}`,
    );

    const markdown = await sendOk('EXPORT_MARKDOWN', {
      sessionId: experimentSessionId,
      experimentId: experimentResponse.experiment.id,
    });
    check(
      'FIREFOX_EXPORT_MARKDOWN',
      typeof markdown?.markdown === 'string' &&
        markdown.markdown.includes('## Эксперимент') &&
        !markdown.markdown.includes('token=secret'),
      `length=${markdown?.markdown?.length ?? 0}`,
    );

    const json = await sendOk('EXPORT_JSON', { sessionId: experimentSessionId });
    check(
      'FIREFOX_EXPORT_JSON',
      json?.report?.reportVersion === 1 &&
        Array.isArray(json.report.metrics) &&
        json.report.metrics.length > 0,
      `metrics=${json?.report?.metrics?.length ?? 0}`,
    );

    const aggregate = await sendOk('GET_P75_AGGREGATE');
    check(
      'FIREFOX_P75',
      Array.isArray(aggregate?.aggregate?.metrics) &&
        aggregate.aggregate.metrics.some(
          (metric) => metric.name === 'LCP' && metric.samples > 0,
        ),
      `sessions=${aggregate?.aggregate?.sessions ?? 0}`,
    );

    const finalStart = await sendOk('SESSION_START', { tabId: targetTabId });
    const stop = await sendOk('SESSION_STOP', {
      sessionId: finalStart?.session?.id,
    });
    const finalState = await getState();
    check(
      'FIREFOX_SESSION_STOP',
      finalStart?.session?.status === 'active' &&
        stop?.success === true &&
        finalState?.session?.status === 'completed',
      `status=${finalState?.session?.status ?? 'null'}`,
    );
  } finally {
    await driver.quit().catch(() => undefined);
    await fixture.close().catch(() => undefined);
  }

  const failed = checks.filter((entry) => !entry.pass);
  console.log('');
  if (failed.length > 0) {
    console.log(`FIREFOX E2E FAIL (${failed.length}/${checks.length})`);
    for (const entry of failed) console.log(` - ${entry.name}: ${entry.details ?? ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`FIREFOX E2E PASS (${checks.length} checks)`);
}

main().catch((error) => {
  console.error('FIREFOX E2E ERROR', error);
  process.exitCode = 1;
});
