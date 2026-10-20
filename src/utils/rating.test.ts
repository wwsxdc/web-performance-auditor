import { describe, expect, it } from 'vitest';
import { calculateRating } from './rating';

describe('calculateRating', () => {
  it('returns good for values at or below the good threshold', () => {
    expect(calculateRating('LCP', 2500)).toBe('good');
    expect(calculateRating('CLS', 0.1)).toBe('good');
    expect(calculateRating('INP', 200)).toBe('good');
  });

  it('returns needs-improvement between good and poor thresholds', () => {
    expect(calculateRating('LCP', 3000)).toBe('needs-improvement');
    expect(calculateRating('CLS', 0.2)).toBe('needs-improvement');
    expect(calculateRating('INP', 400)).toBe('needs-improvement');
  });

  it('returns poor above the poor threshold', () => {
    expect(calculateRating('LCP', 4001)).toBe('poor');
    expect(calculateRating('CLS', 0.26)).toBe('poor');
    expect(calculateRating('INP', 501)).toBe('poor');
  });

  it('returns unrated for missing values', () => {
    expect(calculateRating('LCP', null)).toBe('unrated');
  });
});
