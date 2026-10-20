import { describe, expect, it } from 'vitest';
import { isAuditableUrl, sanitizeUrl } from './url';

describe('isAuditableUrl', () => {
  it('accepts http and https pages', () => {
    expect(isAuditableUrl('https://example.com/page').auditable).toBe(true);
    expect(isAuditableUrl('http://localhost:3000/').auditable).toBe(true);
  });

  it('rejects browser system pages', () => {
    expect(isAuditableUrl('chrome://extensions').auditable).toBe(false);
    expect(isAuditableUrl('about:blank').auditable).toBe(false);
    expect(isAuditableUrl('devtools://devtools/bundled/inspector.html').auditable).toBe(false);
  });

  it('rejects the Chrome Web Store', () => {
    expect(isAuditableUrl('https://chromewebstore.google.com/detail/abc').auditable).toBe(false);
    expect(isAuditableUrl('https://chrome.google.com/webstore').auditable).toBe(false);
  });

  it('rejects missing and invalid URLs', () => {
    expect(isAuditableUrl(undefined).auditable).toBe(false);
    expect(isAuditableUrl('not a url').auditable).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  it('removes query string and hash', () => {
    expect(sanitizeUrl('https://example.com/path?secret=1#fragment')).toBe(
      'https://example.com/path',
    );
  });

  it('returns the original value for invalid URLs', () => {
    expect(sanitizeUrl('not a url')).toBe('not a url');
  });
});
