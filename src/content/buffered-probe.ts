/**
 * Detects a silent `buffered: true` failure: the browser accepts the observer
 * but never replays entries that happened before the collector started.
 *
 * The check is deliberately conservative. It only reports `unavailable` when
 * `performance.getEntriesByType()` proves historical entries existed AND the
 * buffered observer delivered none of them. When the timeline cannot prove
 * that history existed (e.g. LCP in some Chrome builds), the probe returns
 * `not-applicable` and no limitation is recorded.
 */
export type BufferedProbeOutcome = 'confirmed' | 'not-applicable' | 'unavailable';

export interface BufferedProbe {
  /** Records an entry delivered by the buffered observer. */
  noteEntry(startTime: number): void;
  /** Decides the outcome after the observation window closes. */
  settle(): BufferedProbeOutcome;
}

export interface BufferedProbeOptions {
  /** `performance.now()` when the collector was initialized. */
  collectorStartedAt: number;
  /** Entry start times returned by `getEntriesByType()` before observing. */
  historicalEntries: ReadonlyArray<{ startTime: number }>;
}

/** LongTask/Interaction/LayoutShift history is delivered within one task. */
export const BUFFERED_PROBE_WINDOW_MS = 1000;
/** LCP may be painted later; give the replay observer more room. */
export const LCP_PROBE_WINDOW_MS = 5000;

export function createBufferedProbe({
  collectorStartedAt,
  historicalEntries,
}: BufferedProbeOptions): BufferedProbe {
  const hasHistoricalEntries = historicalEntries.some(
    (entry) => Number.isFinite(entry.startTime) && entry.startTime < collectorStartedAt,
  );
  let replayedHistoricalEntry = false;

  return {
    noteEntry(startTime: number): void {
      if (Number.isFinite(startTime) && startTime < collectorStartedAt) {
        replayedHistoricalEntry = true;
      }
    },
    settle(): BufferedProbeOutcome {
      if (!hasHistoricalEntries) return 'not-applicable';
      return replayedHistoricalEntry ? 'confirmed' : 'unavailable';
    },
  };
}
