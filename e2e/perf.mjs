/**
 * Collector overhead benchmark (P1.2 / NFR 4.1).
 *
 * Loads the same fixture page in fresh Chrome profiles, with and without the
 * extension, and compares cumulative CDP performance counters over a fixed
 * window. Run:
 *
 *   npm run build
 *   npm run bench:collector
 *
 * WPA_PERF_RUNS overrides the number of iterations per scenario (default 5).
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseLaunchArgs, extensionLaunchArgs, findChrome } from './chrome.mjs';
import { startFixtureServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const headless = process.env.HEADLESS !== '0';
const runs = Number(process.env.WPA_PERF_RUNS ?? 5);
const settleMs = 2500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BUDGET = {
  // Task time may not grow by more than 5% of the baseline, with an absolute
  // floor because localhost load times are only a few dozen milliseconds.
  taskDurationPercent: 5,
  taskDurationFloorMs: 25,
  heapBytes: 1.5 * 1024 * 1024,
};

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function launch(useExtension) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'wpa-perf-'));
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless,
    userDataDir,
    args: useExtension ? extensionLaunchArgs(dist) : baseLaunchArgs(),
  });
  return { browser, userDataDir };
}

async function measure(browser, origin, run) {
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Performance.enable');
  // Count long tasks from the very first document, including buffered ones.
  await page.evaluateOnNewDocument(() => {
    window.__wpaLongTasks = 0;
    try {
      new PerformanceObserver((list) => {
        window.__wpaLongTasks += list.getEntries().length;
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Tasks API is unavailable; the counter stays at zero.
    }
  });
  await page.goto(`${origin}/?token=secret&run=${run}`, { waitUntil: 'load' });
  await sleep(settleMs);

  const { metrics } = await client.send('Performance.getMetrics');
  const values = Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
  const timings = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      longTasks: window.__wpaLongTasks ?? 0,
    };
  });

  await page.close();
  return {
    taskDurationMs: (values.TaskDuration ?? 0) * 1000,
    scriptDurationMs: (values.ScriptDuration ?? 0) * 1000,
    layoutCount: values.LayoutCount ?? 0,
    heapBytes: values.JSHeapUsedSize ?? 0,
    domContentLoaded: timings.domContentLoaded,
    loadEventEnd: timings.loadEventEnd,
    longTasks: timings.longTasks,
  };
}

async function collect(useExtension, origin) {
  const { browser, userDataDir } = await launch(useExtension);
  const samples = [];
  try {
    for (let run = 0; run < runs; run++) {
      samples.push(await measure(browser, origin, run));
    }
  } finally {
    await browser.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }

  return {
    taskDurationMs: median(samples.map((sample) => sample.taskDurationMs)),
    scriptDurationMs: median(samples.map((sample) => sample.scriptDurationMs)),
    layoutCount: median(samples.map((sample) => sample.layoutCount)),
    heapBytes: median(samples.map((sample) => sample.heapBytes)),
    domContentLoaded: median(
      samples.map((sample) => sample.domContentLoaded).filter((value) => value !== null),
    ),
    loadEventEnd: median(
      samples.map((sample) => sample.loadEventEnd).filter((value) => value !== null),
    ),
    longTasks: median(samples.map((sample) => sample.longTasks)),
  };
}

function percentOverhead(withExtension, baseline) {
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  return ((withExtension - baseline) / baseline) * 100;
}

function formatMs(value) {
  return `${value.toFixed(1)} мс`;
}

function formatPercent(value) {
  return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

async function main() {
  const fixture = await startFixtureServer();
  try {
    console.log(`Сценарий: fixture-страница, ${runs} прогонов, окно ${settleMs} мс.`);
    const baseline = await collect(false, fixture.origin);
    const withExtension = await collect(true, fixture.origin);

    const taskDelta = withExtension.taskDurationMs - baseline.taskDurationMs;
    const taskPercent = percentOverhead(withExtension.taskDurationMs, baseline.taskDurationMs);
    const heapDelta = withExtension.heapBytes - baseline.heapBytes;
    const taskBudget = Math.max(
      (baseline.taskDurationMs * BUDGET.taskDurationPercent) / 100,
      BUDGET.taskDurationFloorMs,
    );

    const rows = [
      ['TaskDuration', formatMs(baseline.taskDurationMs), formatMs(withExtension.taskDurationMs), formatMs(taskDelta)],
      ['ScriptDuration', formatMs(baseline.scriptDurationMs), formatMs(withExtension.scriptDurationMs), formatMs(withExtension.scriptDurationMs - baseline.scriptDurationMs)],
      ['LayoutCount', baseline.layoutCount.toFixed(0), withExtension.layoutCount.toFixed(0), (withExtension.layoutCount - baseline.layoutCount).toFixed(0)],
      ['LongTask', baseline.longTasks.toFixed(0), withExtension.longTasks.toFixed(0), (withExtension.longTasks - baseline.longTasks).toFixed(0)],
      ['JSHeapUsedSize', `${(baseline.heapBytes / 1024 / 1024).toFixed(2)} МБ`, `${(withExtension.heapBytes / 1024 / 1024).toFixed(2)} МБ`, `${(heapDelta / 1024).toFixed(0)} КБ`],
      ['loadEventEnd', formatMs(baseline.loadEventEnd), formatMs(withExtension.loadEventEnd), formatMs(withExtension.loadEventEnd - baseline.loadEventEnd)],
    ];

    console.log('');
    console.log('| Показатель | Без расширения | С расширением | Разница |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const row of rows) console.log(`| ${row.join(' | ')} |`);
    console.log('');
    console.log(
      `Overhead TaskDuration: ${formatPercent(taskPercent)} (бюджет ≤ ${BUDGET.taskDurationPercent}% или ≤ ${formatMs(taskBudget)})`,
    );
    console.log(
      `Overhead JSHeapUsedSize: ${(heapDelta / 1024 / 1024).toFixed(2)} МБ (бюджет ≤ ${(BUDGET.heapBytes / 1024 / 1024).toFixed(1)} МБ)`,
    );

    const taskWithinBudget = taskDelta <= taskBudget;
    const heapWithinBudget = heapDelta <= BUDGET.heapBytes;
    if (!taskWithinBudget || !heapWithinBudget) {
      console.log('');
      console.log('PERF FAIL: бюджет накладных расходов коллектора превышен.');
      process.exitCode = 1;
      return;
    }
    console.log('');
    console.log('PERF PASS: накладные расходы коллектора в бюджете.');
  } finally {
    await fixture.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('PERF ERROR', error);
  process.exitCode = 1;
});
