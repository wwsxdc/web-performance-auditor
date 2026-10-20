import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeRetentionDays } from './settings';

describe('normalizeRetentionDays', () => {
  it('clamps and rounds user input', () => {
    expect(normalizeRetentionDays(0)).toBe(1);
    expect(normalizeRetentionDays(999)).toBe(365);
    expect(normalizeRetentionDays(12.6)).toBe(13);
  });

  it('falls back for missing or non-numeric values', () => {
    expect(normalizeRetentionDays(undefined)).toBe(DEFAULT_SETTINGS.retentionDays);
    expect(normalizeRetentionDays(Number.NaN)).toBe(DEFAULT_SETTINGS.retentionDays);
    expect(normalizeRetentionDays('7')).toBe(DEFAULT_SETTINGS.retentionDays);
  });
});
