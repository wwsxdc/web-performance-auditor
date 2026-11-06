import { describe, expect, it } from 'vitest';
import type { DiagnosticEvent } from '../../types/events';
import { detailEntries, formatDetailValue } from './EventsPanel';

describe('formatDetailValue', () => {
  it('rounds fractional values to four decimals', () => {
    expect(formatDetailValue('shift', 0.08875949999999999)).toBe('0.0888');
    expect(formatDetailValue('value', 1234.5)).toBe('1234.5');
  });

  it('keeps integers and rounds start times', () => {
    expect(formatDetailValue('value', 42)).toBe('42');
    expect(formatDetailValue('startTime', 1234.5679)).toBe('1235');
  });

  it('translates booleans and ratings', () => {
    expect(formatDetailValue('hadRecentInput', true)).toBe('да');
    expect(formatDetailValue('hadRecentInput', false)).toBe('нет');
    expect(formatDetailValue('rating', 'needs-improvement')).toBe('требует улучшения');
    expect(formatDetailValue('rating', 'unknown')).toBe('unknown');
  });
});

describe('detailEntries', () => {
  it('keeps source keys, uses Russian labels and drops empty values', () => {
    const event: DiagnosticEvent = {
      id: 'event-1',
      sessionId: 'session-1',
      navigationId: 'nav-1',
      type: 'spa-navigation',
      timestamp: 1,
      details: {
        url: 'https://example.com/',
        value: 0.5,
        empty: '',
        missing: null,
      },
    };

    expect(detailEntries(event)).toEqual([
      ['url', 'Адрес', 'https://example.com/'],
      ['value', 'Значение', '0.5'],
    ]);
  });
});
