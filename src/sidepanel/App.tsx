import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Header } from './components/Header';
import { MetricsGrid } from './components/MetricsGrid';
import { ErrorView } from './components/ErrorView';
import { ExportButton } from './components/ExportButton';
import { SessionInfo } from './components/SessionInfo';
import { CompletenessStatus } from './components/CompletenessStatus';
import { MetricDetails } from './components/MetricDetails';
import { ExperimentsPanel } from './components/ExperimentsPanel';
import { MarkdownExportButton } from './components/MarkdownExportButton';
import { DataCleanup } from './components/DataCleanup';
import { EventsPanel } from './components/EventsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ImportReportCard } from './components/ImportReportCard';
import { SessionHistory } from './components/SessionHistory';
import {
  OverlayControls,
  type ActiveOverlayState,
  type OverlayCategory,
} from './components/OverlayControls';
import { useSession } from './hooks/useSession';
import { useExperiments } from './hooks/useExperiments';
import type { DomTargetSnapshot, MetricName } from '../types/metrics';
import { selectMetricForDisplay } from '../utils/select-metric';
import {
  firstTargetForMetric,
  isOverlayCategory,
  OVERLAY_CATEGORIES,
  type OverlayColor,
} from '../utils/metric-targets';
import { metricsForActiveSegment } from '../utils/metric-scope';

const SessionChart = lazy(async () => {
  const module = await import('./components/SessionChart');
  return { default: module.SessionChart };
});

type View = 'overview' | 'events' | 'experiments' | 'data';

const TABS: { value: View; label: string }[] = [
  { value: 'overview', label: 'Обзор' },
  { value: 'events', label: 'События' },
  { value: 'experiments', label: 'Эксперименты' },
  { value: 'data', label: 'Данные' },
];

export default function App() {
  const {
    state,
    startSession,
    stopSession,
    highlightTarget,
    clearHighlight,
    refreshState,
    isLoading,
  } = useSession();
  const [view, setView] = useState<View>('overview');
  const [historyRevision, setHistoryRevision] = useState(0);
  const tabRefs = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});

  // WAI-ARIA tabs: the tab list is a single stop, arrows move selection.
  const focusTab = useCallback((value: View) => {
    setView(value);
    tabRefs.current[value]?.focus();
  }, []);

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, value: View) => {
      const index = TABS.findIndex((tab) => tab.value === value);
      let next: View | undefined;
      if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length].value;
      else if (event.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length].value;
      else if (event.key === 'Home') next = TABS[0].value;
      else if (event.key === 'End') next = TABS[TABS.length - 1].value;
      if (!next) return;
      event.preventDefault();
      focusTab(next);
    },
    [focusTab],
  );
  const [selectedName, setSelectedName] = useState<MetricName | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState<Record<OverlayCategory, boolean>>({
    LCP: true,
    CLS: true,
    INP: true,
  });
  const [activeOverlays, setActiveOverlays] = useState<
    Partial<Record<OverlayCategory, ActiveOverlayState>>
  >({});
  const autoTargetsRef = useRef<Partial<Record<OverlayCategory, string>>>({});
  const overlayEnabledRef = useRef(overlayEnabled);
  const overlayRequestRef = useRef<Partial<Record<OverlayCategory, number>>>({});
  const {
    experiments,
    activeExperiment,
    error: experimentError,
    start: startExperiment,
    finish: finishExperiment,
    cancel: cancelExperiment,
    refresh: refreshExperiments,
  } = useExperiments(state?.session?.id);

  const session = state?.session ?? null;
  const activeNavigationId = state?.activeNavigationId ?? null;
  const scopedMetrics = useMemo(
    () => (session ? metricsForActiveSegment(session, activeNavigationId) : []),
    [session, activeNavigationId],
  );

  const highlightableNames = useMemo(() => {
    const names = new Set<MetricName>();
    for (const category of OVERLAY_CATEGORIES) {
      if (firstTargetForMetric(selectMetricForDisplay(scopedMetrics, category))) {
        names.add(category);
      }
    }
    return names;
  }, [scopedMetrics]);

  const highlightedNames = useMemo(() => {
    const names = new Set<MetricName>();
    for (const category of OVERLAY_CATEGORIES) {
      if (activeOverlays[category]?.available !== false && activeOverlays[category]) {
        names.add(category);
      }
    }
    return names;
  }, [activeOverlays]);

  const showCategoryOverlay = useCallback(
    async (category: OverlayCategory, metric = selectMetricForDisplay(scopedMetrics, category)) => {
      const target = firstTargetForMetric(metric);
      if (!target) {
        if (!overlayEnabledRef.current[category]) return;
        setActiveOverlays((prev) => ({
          ...prev,
          [category]: { available: false, reason: 'Цель для этой метрики ещё не определена' },
        }));
        return;
      }

      const request = (overlayRequestRef.current[category] ?? 0) + 1;
      overlayRequestRef.current[category] = request;
      const response = await highlightTarget({
        targetId: target.target.targetId,
        selector: target.target.selector,
        color: target.color,
        label: target.label,
        metricName: category,
      });

      if (!overlayEnabledRef.current[category]) {
        void clearHighlight(category);
        return;
      }
      if (overlayRequestRef.current[category] !== request) return;

      setActiveOverlays((prev) => ({
        ...prev,
        [category]: {
          targetId: target.target.targetId,
          available: response?.available === true,
          reason: response?.reason,
        },
      }));
    },
    [clearHighlight, highlightTarget, scopedMetrics],
  );

  const hideOverlay = useCallback(
    (category: OverlayCategory) => {
      overlayEnabledRef.current = { ...overlayEnabledRef.current, [category]: false };
      overlayRequestRef.current[category] = (overlayRequestRef.current[category] ?? 0) + 1;
      setOverlayEnabled((prev) => ({ ...prev, [category]: false }));
      delete autoTargetsRef.current[category];
      setActiveOverlays((prev) => {
        if (!prev[category]) return prev;
        const next = { ...prev };
        delete next[category];
        return next;
      });
      void clearHighlight(category);
    },
    [clearHighlight],
  );

  useEffect(() => {
    autoTargetsRef.current = {};
    for (const category of OVERLAY_CATEGORIES) {
      overlayRequestRef.current[category] = (overlayRequestRef.current[category] ?? 0) + 1;
    }
    setActiveOverlays({});
  }, [session?.id, activeNavigationId]);

  useEffect(() => {
    if (!state?.overlayStatus?.targetId) return;
    const status = state.overlayStatus;
    setActiveOverlays((prev) => {
      const category = status.metricName && isOverlayCategory(status.metricName)
        ? status.metricName
        : OVERLAY_CATEGORIES.find(
            (name) => prev[name]?.targetId === status.targetId,
          );
      if (!category) return prev;
      const current = prev[category];
      if (!current) return prev;
      if (current.available === status.available && current.reason === status.reason) {
        return prev;
      }
      return { ...prev, [category]: { ...current, ...status } };
    });
  }, [state?.overlayStatus]);

  useEffect(() => {
    if (!session) return;
    for (const category of OVERLAY_CATEGORIES) {
      if (!overlayEnabled[category] || activeOverlays[category]) continue;
      const metric = selectMetricForDisplay(scopedMetrics, category);
      const target = firstTargetForMetric(metric);
      if (!target) continue;
      const targetKey = `${metric?.id ?? ''}:${target.target.selector ?? target.target.targetId ?? ''}`;
      if (autoTargetsRef.current[category] === targetKey) continue;
      autoTargetsRef.current[category] = targetKey;
      void showCategoryOverlay(category, metric);
    }
  }, [activeOverlays, overlayEnabled, scopedMetrics, session, showCategoryOverlay]);

  if (isLoading) {
    return (
      <main className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center" role="status">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-3"></div>
          <p className="text-gray-500 text-sm">Загрузка...</p>
        </div>
      </main>
    );
  }

  const collectorStatus = state?.collectorStatus ?? 'idle';

  const refreshHistory = () => setHistoryRevision((value) => value + 1);

  const handleCleared = async () => {
    setSelectedName(null);
    setActiveOverlays({});
    autoTargetsRef.current = {};
    await clearHighlight();
    await refreshExperiments();
    refreshHistory();
    await refreshState();
  };

  const handleImported = () => {
    refreshHistory();
    void refreshState();
  };

  const handleSessionSelected = () => {
    void refreshState();
  };

  const handleSessionDeleted = () => {
    refreshHistory();
    void refreshState();
  };

  if (collectorStatus === 'unsupported' || collectorStatus === 'permission-denied') {
    return (
      <main className="flex min-h-screen flex-col bg-gray-50 p-4">
        <Header
          url={state?.activeTabUrl}
          status={collectorStatus}
          sessionStartedAt={session?.startedAt}
          onStart={startSession}
          onStop={() => void stopSession()}
        />
        <ErrorView status={collectorStatus} message={state?.error}>
          <DataCleanup onCleared={handleCleared} />
        </ErrorView>
      </main>
    );
  }

  const selectedMetric = selectedName
    ? selectMetricForDisplay(scopedMetrics, selectedName)
    : undefined;

  const handleSelect = (name: MetricName) => {
    setSelectedName((current) => (current === name ? null : name));
  };

  const handleStop = async () => {
    setActiveOverlays({});
    autoTargetsRef.current = {};
    setSelectedName(null);
    await stopSession();
    await refreshExperiments();
  };

  const handleToggleOverlay = (category: OverlayCategory, enabled: boolean) => {
    if (!enabled) {
      hideOverlay(category);
      return;
    }
    overlayEnabledRef.current = { ...overlayEnabledRef.current, [category]: true };
    setOverlayEnabled((prev) => ({ ...prev, [category]: true }));
    delete autoTargetsRef.current[category];
  };

  const handleQuickHighlight = (name: MetricName) => {
    if (!isOverlayCategory(name)) return;
    const current = activeOverlays[name];
    if (current && current.available !== false) {
      hideOverlay(name);
      return;
    }
    setSelectedName(name);
    overlayEnabledRef.current = { ...overlayEnabledRef.current, [name]: true };
    setOverlayEnabled((prev) => ({ ...prev, [name]: true }));
    delete autoTargetsRef.current[name];
    overlayRequestRef.current[name] = (overlayRequestRef.current[name] ?? 0) + 1;
    void showCategoryOverlay(name);
  };

  const handleClearAllOverlays = () => {
    overlayEnabledRef.current = { LCP: false, CLS: false, INP: false };
    for (const category of OVERLAY_CATEGORIES) {
      overlayRequestRef.current[category] = (overlayRequestRef.current[category] ?? 0) + 1;
    }
    setOverlayEnabled({ LCP: false, CLS: false, INP: false });
    autoTargetsRef.current = {};
    setActiveOverlays({});
    void clearHighlight();
  };

  const handleHighlight = (
    target: DomTargetSnapshot,
    color: OverlayColor,
    label: string,
    metricName: MetricName,
  ) => {
    if (isOverlayCategory(metricName)) {
      overlayEnabledRef.current = { ...overlayEnabledRef.current, [metricName]: true };
      overlayRequestRef.current[metricName] = (overlayRequestRef.current[metricName] ?? 0) + 1;
      setOverlayEnabled((prev) => ({ ...prev, [metricName]: true }));
      autoTargetsRef.current[metricName] = `manual:${target.targetId ?? target.selector ?? ''}`;
      setActiveOverlays((prev) => ({
        ...prev,
        [metricName]: { targetId: target.targetId, available: true },
      }));
    }
    const request = isOverlayCategory(metricName)
      ? overlayRequestRef.current[metricName] ?? 0
      : 0;
    void highlightTarget({
      targetId: target.targetId,
      selector: target.selector,
      color,
      label,
      metricName,
    }).then((response) => {
      if (!isOverlayCategory(metricName)) return;
      if (!overlayEnabledRef.current[metricName]) {
        void clearHighlight(metricName);
        return;
      }
      if ((overlayRequestRef.current[metricName] ?? 0) !== request) return;
      if (response?.available !== false) return;
      setActiveOverlays((prev) => ({
        ...prev,
        [metricName]: {
          targetId: target.targetId,
          available: false,
          reason: response.reason,
        },
      }));
    });
  };

  const handleClearHighlight = (metricName?: MetricName) => {
    if (metricName && isOverlayCategory(metricName)) {
      hideOverlay(metricName);
      return;
    }
    void clearHighlight(metricName);
  };

  const overlayAvailable: Record<OverlayCategory, boolean> = {
    LCP: highlightableNames.has('LCP'),
    CLS: highlightableNames.has('CLS'),
    INP: highlightableNames.has('INP'),
  };

  const showOverview = view === 'overview';
  const showEvents = view === 'events';
  const showExperiments = view === 'experiments';
  const showData = view === 'data';

  return (
    <main className="min-h-screen bg-gray-50 p-4">
      <Header
        url={session?.url ?? state?.activeTabUrl}
        status={collectorStatus}
        sessionStartedAt={session?.startedAt}
        onStart={startSession}
        onStop={() => void handleStop()}
      />

      <nav
        role="tablist"
        aria-label="Разделы панели"
        className="mb-3 flex gap-1 rounded-lg border border-gray-200 bg-white p-1"
      >
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`wpa-tab-${tab.value}`}
            aria-selected={view === tab.value}
            aria-controls="wpa-tabpanel"
            tabIndex={view === tab.value ? 0 : -1}
            ref={(element) => {
              tabRefs.current[tab.value] = element;
            }}
            onClick={() => setView(tab.value)}
            onKeyDown={(event) => handleTabKeyDown(event, tab.value)}
            className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
              view === tab.value
                ? 'bg-blue-600 text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div
        role="tabpanel"
        id="wpa-tabpanel"
        aria-labelledby={`wpa-tab-${view}`}
      >
      {collectorStatus === 'error' && state?.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-700" role="alert">
          {state.error}
        </div>
      )}

      {showOverview && (
        <>
          <MetricsGrid
            metrics={scopedMetrics}
            collectorStatus={collectorStatus}
            selectedName={selectedName}
            highlightedNames={highlightedNames}
            highlightableNames={highlightableNames}
            onSelect={handleSelect}
            onQuickHighlight={handleQuickHighlight}
          />

          {!session && collectorStatus === 'idle' && (
            <p className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white p-3 text-xs text-gray-500">
              Нажмите «Аудит» вверху, чтобы начать измерение Core Web Vitals этой страницы.
            </p>
          )}

          {session && (
            <div className="bg-white rounded-lg p-3 shadow-sm mt-3">
              <CompletenessStatus session={session} compact />
            </div>
          )}

          {session && (
            <OverlayControls
              enabled={overlayEnabled}
              active={activeOverlays}
              available={overlayAvailable}
              onToggle={handleToggleOverlay}
              onClearAll={handleClearAllOverlays}
            />
          )}

          {session && (
            <Suspense
              fallback={
                <div className="bg-white rounded-xl border border-gray-200 p-3 mt-4 text-xs text-gray-500">
                  Загрузка графика...
                </div>
              }
            >
              <SessionChart session={session} />
            </Suspense>
          )}

          {selectedMetric && session && (
            <MetricDetails
              metric={selectedMetric}
              events={session.events}
              overlayStatus={
                isOverlayCategory(selectedMetric.name)
                  ? activeOverlays[selectedMetric.name] ?? null
                  : state?.overlayStatus
              }
              overlayEnabled={
                isOverlayCategory(selectedMetric.name)
                  ? overlayEnabled[selectedMetric.name]
                  : true
              }
              onHighlight={handleHighlight}
              onClearHighlight={handleClearHighlight}
            />
          )}
        </>
      )}

      {showEvents && (
        <EventsPanel events={session?.events ?? []} />
      )}

      {showExperiments && session && (
        <ExperimentsPanel
          session={session}
          experiments={experiments}
          activeExperiment={activeExperiment}
          error={experimentError}
          onStart={startExperiment}
          onFinish={finishExperiment}
          onCancel={cancelExperiment}
        />
      )}

      {showExperiments && !session && (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-xs text-gray-500">
          Начните аудит, чтобы запускать эксперименты.
        </p>
      )}

      {showData && session && (
        <div className="space-y-3">
          <SessionInfo session={session} />
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <h2 className="text-sm font-semibold text-gray-800">Экспорт</h2>
            <div className="mt-2 flex flex-wrap items-start gap-2">
              <ExportButton sessionId={session.id} />
              <MarkdownExportButton
                sessionId={session.id}
                experimentId={activeExperiment?.id}
              />
            </div>
          </div>
        </div>
      )}

      {showData && (
        <div className="space-y-3">
          <ImportReportCard onImported={handleImported} />
          <SessionHistory
            revision={historyRevision}
            activeSessionId={session?.id ?? null}
            hasActiveSession={session?.status === 'active'}
            onSelected={handleSessionSelected}
            onDeleted={handleSessionDeleted}
          />
          <SettingsPanel />
          <DiagnosticsPanel />
          <DataCleanup onCleared={handleCleared} />
        </div>
      )}
      </div>
    </main>
  );
}
