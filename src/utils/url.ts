const BLOCKED_PROTOCOLS = ['chrome:', 'chrome-extension:', 'about:', 'edge:', 'devtools:'];
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

export function isAuditableUrl(url: string | undefined): { auditable: boolean; reason?: string } {
  if (!url) {
    return { auditable: false, reason: 'URL вкладки не определён' };
  }

  try {
    const parsed = new URL(url);

    for (const protocol of BLOCKED_PROTOCOLS) {
      if (url.startsWith(protocol)) {
        return {
          auditable: false,
          reason: `Системные страницы браузера (${protocol}) недоступны для аудита`,
        };
      }
    }

    if (BLOCKED_HOSTS.includes(parsed.hostname)) {
      return {
        auditable: false,
        reason: 'Chrome Web Store недоступен для аудита расширениями',
      };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { auditable: false, reason: `Протокол ${parsed.protocol} не поддерживается` };
    }

    return { auditable: true };
  } catch {
    return { auditable: false, reason: 'Некорректный URL' };
  }
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}
