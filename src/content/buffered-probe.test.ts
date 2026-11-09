import { describe, expect, it } from 'vitest';
import { createBufferedProbe } from './buffered-probe';

describe('createBufferedProbe', () => {
  it('reports not-applicable when no historical entries existed', () => {
    const probe = createBufferedProbe({ collectorStartedAt: 500, historicalEntries: [] });
    expect(probe.settle()).toBe('not-applicable');
  });

  it('reports not-applicable when entries are newer than the collector start', () => {
    const probe = createBufferedProbe({
      collectorStartedAt: 500,
      historicalEntries: [{ startTime: 600 }, { startTime: 700 }],
    });
    expect(probe.settle()).toBe('not-applicable');
  });

  it('confirms a delivered historical entry', () => {
    const probe = createBufferedProbe({
      collectorStartedAt: 500,
      historicalEntries: [{ startTime: 100 }],
    });
    probe.noteEntry(100);
    expect(probe.settle()).toBe('confirmed');
  });

  it('reports unavailable when history existed but only new entries arrived', () => {
    const probe = createBufferedProbe({
      collectorStartedAt: 500,
      historicalEntries: [{ startTime: 100 }],
    });
    probe.noteEntry(800);
    expect(probe.settle()).toBe('unavailable');
  });

  it('reports unavailable when history existed and nothing was delivered', () => {
    const probe = createBufferedProbe({
      collectorStartedAt: 500,
      historicalEntries: [{ startTime: 100 }],
    });
    expect(probe.settle()).toBe('unavailable');
  });

  it('ignores non-finite start times', () => {
    const probe = createBufferedProbe({
      collectorStartedAt: 500,
      historicalEntries: [{ startTime: Number.NaN }],
    });
    probe.noteEntry(Number.NaN);
    expect(probe.settle()).toBe('not-applicable');
  });
});
