/**
 * Accessibility gate (P1.6): runs axe-core against the side panel views and
 * the popup surface, failing on serious/critical findings.
 *
 * Usage:
 *   npm run build
 *   npm run a11y            # headed Chrome
 *   HEADLESS=1 npm run a11y # headless
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionLaunchArgs, findChrome } from './chrome.mjs';
import { startFixtureServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const axePath = path.join(root, 'node_modules', 'axe-core', 'axe.min.js');
const headless = process.env.HEADLESS === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];

async function audit(page, name) {
  // Executed through CDP so the MV3 extension CSP (script-src 'self') does not
  // block the injected audit bundle.
  await page.evaluate(readFileSync(axePath, 'utf8'));
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      nodes: violation.nodes.map((node) => node.target.map(String).join(' ')),
    }));
  });

  const blocking = violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  results.push({ name, blocking });
  console.log(
    `${blocking.length === 0 ? 'PASS' : 'FAIL'} AXE ${name} — violations=${violations.length}, serious/critical=${blocking.length}`,
  );
  for (const violation of blocking) {
    console.log(
      `  - ${violation.id} (${violation.impact}): ${violation.description} [${violation.nodes.slice(0, 3).join(' | ')}]`,
    );
  }
  if (process.env.A11Y_REPORT_ALL === '1') {
    for (const violation of violations) {
      console.log(
        `  · ${violation.id} (${violation.impact}): ${violation.nodes.slice(0, 3).join(' | ')}`,
      );
    }
  }
}

function recordCheck(name, pass, details) {
  results.push({ name, blocking: pass ? [] : [{ id: 'keyboard', detail: details }] });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${details}`);
}

async function keyboardWalk(page, name) {
  await page.evaluate(() => document.activeElement?.blur());
  const expected = await page.evaluate(() => {
    const selector =
      'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(selector)].filter(
      (element) => element.getClientRects().length > 0,
    ).length;
  });
  const limit = Math.min(Math.max(expected + 2, 4), 24);
  const trail = [];
  for (let index = 0; index < limit; index++) {
    await page.keyboard.press('Tab');
    trail.push(
      await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement) || element === document.body) {
          return { label: 'BODY', visible: false, focusRing: false };
        }
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          label: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0,
          focusRing:
            (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
            style.boxShadow !== 'none',
        };
      }),
    );
  }

  const focused = trail.filter((entry) => entry.label !== 'BODY');
  const ringed = focused.filter((entry) => entry.visible && entry.focusRing);
  const reached = Math.min(expected, 24);
  const ok = reached === 0 ? focused.length === 0 : focused.length >= reached && ringed.length === focused.length;
  recordCheck(
    `keyboard: ${name}`,
    ok,
    `фокусируемых=${expected}, пройдено=${focused.length}, с кольцом=${ringed.length}`,
  );
}

async function clickTab(page, label) {
  await page.evaluate((tabLabel) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (candidate) => candidate.textContent?.trim() === tabLabel,
    );
    tab?.click();
  }, label);
  await sleep(150);
}

async function main() {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error('dist/ не собран. Сначала выполните npm run build.');
  }

  const fixture = await startFixtureServer();
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-a11y-'));
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless,
      userDataDir,
      args: extensionLaunchArgs(dist),
    });

    const swTarget = await browser.waitForTarget(
      (target) =>
        target.type() === 'service_worker' &&
        target.url().startsWith('chrome-extension://'),
      { timeout: 30000 },
    );
    const extensionId = new URL(swTarget.url()).host;

    const target = await browser.newPage();
    await target.goto(`${fixture.origin}/?token=secret`, { waitUntil: 'load' });

    const panel = await browser.newPage();
    await panel.setViewport({ width: 420, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    await panel.waitForSelector('#root');
    await sleep(300);

    await audit(panel, 'side panel: пустое состояние (обзор)');
    for (const label of ['События', 'Эксперименты', 'Данные']) {
      await clickTab(panel, label);
      await audit(panel, `side panel: пустая вкладка «${label}»`);
    }

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

    const panelTabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    await send('SESSION_START', { tabId: panelTabId });
    await sleep(300);
    await clickTab(panel, 'Обзор');
    await audit(panel, 'side panel: ошибка неподдерживаемой страницы');

    const tabId = await panel.evaluate(
      (origin) =>
        chrome.tabs
          .query({})
          .then((tabs) => tabs.find((tab) => tab.url?.startsWith(origin))?.id),
      fixture.origin,
    );
    if (typeof tabId !== 'number') throw new Error('Целевая вкладка не найдена');

    await send('SESSION_START', { tabId });
    await sleep(1500);
    await clickTab(panel, 'Обзор');
    await audit(panel, 'side panel: сессия (обзор)');
    for (const label of ['События', 'Эксперименты', 'Данные']) {
      await clickTab(panel, label);
      await audit(panel, `side panel: сессия «${label}»`);
    }

    // v0.2.0: the import preview and the imported history row are separate
    // accessible states; the preview exposes a file input, lists and a submit
    // button that are not present in the empty state.
    const exportState = await send('GET_STATE');
    const exported = await send('EXPORT_JSON', {
      sessionId: exportState?.state?.session?.id,
    });
    if (exported?.report) {
      const reportPath = path.join(userDataDir, 'a11y-report.json');
      writeFileSync(reportPath, JSON.stringify(exported.report, null, 2));

      await clickTab(panel, 'Данные');
      const fileInput = await panel.$('#wpa-import-file');
      if (fileInput) {
        await fileInput.uploadFile(reportPath);
        await panel
          .waitForFunction(() => document.body.innerText.includes('Импортировать'), {
            timeout: 10000,
          })
          .catch(() => undefined);
        await audit(panel, 'side panel: предпросмотр импорта');

        await panel.evaluate(() => {
          [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Импортировать')
            ?.click();
        });
        await panel
          .waitForFunction(() => document.body.innerText.includes('Импортировано:'), {
            timeout: 10000,
          })
          .catch(() => undefined);
        await clickTab(panel, 'Обзор');
        await clickTab(panel, 'Данные');
        await sleep(400);
        await audit(panel, 'side panel: импортированная сессия в истории');
      }
    }

    // Keyboard-only path: Tab must reach every visible control in each view with
    // a focus ring, and the tab list must switch views with Enter.
    for (const label of ['Обзор', 'События', 'Эксперименты', 'Данные']) {
      await clickTab(panel, label);
      await panel.bringToFront();
      await keyboardWalk(panel, `фокус во вкладке «${label}»`);
    }
    await clickTab(panel, 'Обзор');
    await panel.bringToFront();
    await panel.evaluate(() => {
      document.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    });
    await panel.keyboard.press('ArrowRight');
    await sleep(200);
    const afterRight = await panel.evaluate(
      () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
    );
    await panel.keyboard.press('ArrowLeft');
    await sleep(200);
    const afterLeft = await panel.evaluate(
      () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
    );
    recordCheck(
      'keyboard: стрелки переключают вкладки',
      afterRight === 'События' && afterLeft === 'Обзор',
      `→${afterRight}, ←${afterLeft}`,
    );

    await send('SESSION_STOP', {
      sessionId: (await send('GET_STATE'))?.state?.session?.id,
    }).catch(() => undefined);

    const popup = await browser.newPage();
    await popup.setViewport({ width: 360, height: 320 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, {
      waitUntil: 'domcontentloaded',
    });
    await popup.waitForSelector('#root');
    await sleep(300);
    await audit(popup, 'popup');
  } finally {
    await browser?.close().catch(() => undefined);
    await fixture.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((entry) => entry.blocking.length > 0);
  console.log('');
  if (failed.length > 0) {
    console.log(`A11Y FAIL (${failed.length}/${results.length} состояний)`);
    process.exitCode = 1;
    return;
  }
  console.log(`A11Y PASS (${results.length} состояний)`);
}

main().catch((error) => {
  console.error('A11Y ERROR', error);
  process.exitCode = 1;
});
