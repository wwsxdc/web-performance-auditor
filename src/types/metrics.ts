export type MetricName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

export type MetricStatus =
  | 'pending'
  | 'measured'
  | 'unsupported'
  | 'unavailable'
  | 'incomplete';

export type MetricRating = 'good' | 'needs-improvement' | 'poor' | 'unrated';

export type MetricSource = 'web-vitals' | 'performance-api' | 'derived';

export interface MetricRecord {
  id: string;
  sessionId: string;
  navigationId: string;

  name: MetricName;
  value: number | null;
  unit: 'ms' | 'score';

  status: MetricStatus;
  rating: MetricRating;

  observedAt: number;
  delta?: number;
  source: MetricSource;

  /** Stable id produced by web-vitals for this metric instance. */
  metricId?: string;
  navigationType?: string;

  attribution?: MetricAttribution;
}

export interface DomTargetSnapshot {
  targetId: string;
  selector?: string;
  tagName?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  capturedAt: number;
  available: boolean;
}

export interface MetricAttribution {
  /** Where the attribution values came from. */
  source?: MetricSource;
  /** Field paths enriched by the extension (selectors, rects, links). */
  derived?: string[];
  target?: DomTargetSnapshot;

  lcp?: {
    timeToFirstByte?: number;
    resourceLoadDelay?: number;
    resourceLoadDuration?: number;
    elementRenderDelay?: number;
    resourceUrl?: string;
    elementType?: string;
    contentType?: 'image' | 'text' | 'video' | 'element' | 'unknown';
  };

  cls?: {
    sources: DomTargetSnapshot[];
    shiftValue?: number;
    shiftTime?: number;
    loadState?: string;
  };

  inp?: {
    inputDelay?: number;
    processingDuration?: number;
    presentationDelay?: number;
    interactionType?: string;
    interactionId?: number;
    startTime?: number;
    duration?: number;
    nextPaintTime?: number;
    loadState?: string;
  };

  fcp?: {
    timeToFirstByte?: number;
    firstByteToFCP?: number;
    loadState?: string;
  };

  ttfb?: {
    waitingDuration?: number;
    cacheDuration?: number;
    dnsDuration?: number;
    connectionDuration?: number;
    requestDuration?: number;
  };

  longTaskIds?: string[];
}
