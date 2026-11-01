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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function keyboardWalk(page) {
  await page.evaluate(() => document.activeElement?.blur());
  const trail = [];
  for (let index = 0; index < 12; index++) {
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
  const ok = focused.length >= 6 && focused.every((entry) => entry.visible && entry.focusRing);
  recordCheck(
    'keyboard: focus-visible по Tab',
    ok,
    `элементов=${focused.length}, с кольцом=${focused.filter((entry) => entry.focusRing).length}`,
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

    // Keyboard-only path: Tab must reach visible controls with a focus ring and
    // the tab list must switch views with Enter.
    await clickTab(panel, 'Обзор');
    await panel.bringToFront();
    await keyboardWalk(panel);
    let switched = false;
    for (let index = 0; index < 20 && !switched; index++) {
      await panel.keyboard.press('Tab');
      const label = await panel.evaluate(() =>
        document.activeElement?.textContent?.trim(),
      );
      if (label === 'События') {
        await panel.keyboard.press('Enter');
        switched = true;
      }
    }
    await sleep(200);
    const selectedTab = await panel.evaluate(
      () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
    );
    recordCheck('keyboard: переключение вкладки Enter', selectedTab === 'События', `выбрано=${selectedTab}`);

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
