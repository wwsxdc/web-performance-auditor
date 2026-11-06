import { describe, expect, it } from 'vitest';
import { pluralizeRu } from './plural';

const POINTS: [string, string, string] = ['точка', 'точки', 'точек'];

describe('pluralizeRu', () => {
  it('uses the singular form for 1 and 21', () => {
    expect(pluralizeRu(1, POINTS)).toBe('точка');
    expect(pluralizeRu(21, POINTS)).toBe('точка');
    expect(pluralizeRu(101, POINTS)).toBe('точка');
  });

  it('uses the few form for 2–4', () => {
    expect(pluralizeRu(2, POINTS)).toBe('точки');
    expect(pluralizeRu(4, POINTS)).toBe('точки');
    expect(pluralizeRu(24, POINTS)).toBe('точки');
  });

  it('uses the many form for 0, 5–20 and 11–14', () => {
    expect(pluralizeRu(0, POINTS)).toBe('точек');
    expect(pluralizeRu(5, POINTS)).toBe('точек');
    expect(pluralizeRu(11, POINTS)).toBe('точек');
    expect(pluralizeRu(12, POINTS)).toBe('точек');
    expect(pluralizeRu(14, POINTS)).toBe('точек');
    expect(pluralizeRu(25, POINTS)).toBe('точек');
    expect(pluralizeRu(111, POINTS)).toBe('точек');
    expect(pluralizeRu(112, POINTS)).toBe('точек');
  });
});
