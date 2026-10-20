import { describe, expect, it } from 'vitest';
import { formatDuration, formatMetricValue } from './time';

describe('formatMetricValue', () => {
  it('formats millisecond values', () => {
    expect(formatMetricValue(850, 'ms')).toBe('850 мс');
    expect(formatMetricValue(2500, 'ms')).toBe('2.50 с');
  });

  it('formats score values', () => {
    expect(formatMetricValue(0.1234, 'score')).toBe('0.123');
  });

  it('returns a dash for missing values', () => {
    expect(formatMetricValue(null, 'ms')).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats short and long durations', () => {
    expect(formatDuration(750)).toBe('750 мс');
    expect(formatDuration(2500)).toBe('2.5 с');
  });
});
