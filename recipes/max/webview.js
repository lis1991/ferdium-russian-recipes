// webview.js — MAX Messenger для Ferdium
// Точечный режим:
// - max.ru/... -> web.max.ru/...
// - внешние ссылки открываются отдельно
// - внутренние web.max.ru ссылки не принуждаются к перезагрузке
module.exports = (Ferdium) => {
  const parseCount = (value) => {
    if (!value) return 0;
    return Ferdium.safeParseInt(String(value).replace(/\D/g, ''));
  };

  const getUnreadFromTitle = () => {
    const title = document.title || '';
    const match =
      title.match(/^\s*((\d+))/) ||
      title.match(/^\s*(\d+)\s*[•·-—]/) ||
      title.match(/(\d+)\s*непрочит/i);
    return match ? parseCount(match[1]) : 0;
  };

  const updateBadge = () => {
    const total = getUnreadFromTitle();
    Ferdium.setBadge(total > 0 ? total : 0, 0);
  };

  const updateDialogTitle = () => {
    const node =
      document.querySelector('[data-testid="chat-header-title"]') ||
      document.querySelector('.chat-header .title') ||
      document.querySelector('[class*="Header"] h2') ||
      document.querySelector('[class*="Title"]');

    Ferdium.setDialogTitle(node ? String(node.textContent || '').trim() : '');
  };

  const prepareUrlValue = (value) => {
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();

    // Подстраховка для ссылок вида max.ru/... или www.max.ru/... без протокола
    if (/^(www\.)?max\.ru\//i.test(trimmed)) {
      return `https://${trimmed}`;
    }

    return trimmed;
  };

  const resolveUrl = (value) => {
    const prepared = prepareUrlValue(value);
    if (!prepared) return null;

    try {
      return new URL(prepared, window.location.origin).toString();
    } catch {
      return null;
    }
  };

  const isMaxRuChannelUrl = (value) => {
    const abs = resolveUrl(value);
    if (!abs) return false;

    try {
      const url = new URL(abs);
      const host = url.hostname.toLowerCase();

      return (
        (host === 'max.ru' || host === 'www.max.ru') &&
        url.pathname !== '/'
      );
    } catch {
      return false;
    }
  };

  const toWebMaxUrl = (value) => {
    const abs = resolveUrl(value);
    if (!abs) return null;

    try {
      const url = new URL(abs);
      const host = url.hostname.toLowerCase();

      if (host === 'max.ru' || host === 'www.max.ru') {
        url.hostname = 'web.max.ru';
      }

      return url.toString();
    } catch {
      return null;
    }
  };

  const isInternalMaxUrl = (value) => {
    const abs = resolveUrl(value);
    if (!abs) return false;

    try {
      const host = new URL(abs).hostname.toLowerCase();

      return (
        host === 'max.ru' ||
        host.endsWith('.max.ru') ||
        host === 'oneme.ru' ||
        host.endsWith('.oneme.ru')
      );
    } catch {
      return false;
    }
  };

  const isImageLink = (value) => {
    const abs = resolveUrl(value);
    if (!abs) return false;

    try {
      const { pathname } = new URL(abs);
      return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?|apng)$/i.test(pathname);
    } catch {
      return false;
    }
  };

  const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|txt|rtf|odt|ods|odp|csv|zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|apk|deb|rpm|mp3|wav|ogg|flac|aac|m4a|wma|mp4|avi|mkv|mov|wmv|flv|webm|m4v|3gp|json|xml|ya?ml|ini|cfg|conf|log|sql|db|sqlite)$/i;

  const isLikelyDownload = (value, element = null) => {
    if (element && typeof element.hasAttribute === 'function' && element.hasAttribute('download')) {
      return true;
    }

    const abs = resolveUrl(value);
    if (!abs) return false;

    try {
      const url = new URL(abs);

      if (FILE_EXT_RE.test(url.pathname)) return true;

      if (/disposition=attachment/i.test(url.search)) return true;
      if (/filename=/i.test(url.search)) return true;
      if (/download=/i.test(url.search)) return true;

      return false;
    } catch {
      return false;
    }
  };

  const installLinkHandling = () => {
    if (window.__ferdiumMaxPointRedirectInstalled) return;
    window.__ferdiumMaxPointRedirectInstalled = true;

    const originalOpen = window.open;

    window.open = function patchedOpen(url, ...args) {
      if (!url) return originalOpen.call(window, url, ...args);

      const resolved = resolveUrl(url);
      if (!resolved) return originalOpen.call(window, url, ...args);

      if (isMaxRuChannelUrl(resolved)) {
        const webUrl = toWebMaxUrl(resolved);
        if (webUrl) window.location.replace(webUrl);
        return null;
      }

      if (isLikelyDownload(resolved, null)) {
        return originalOpen.call(window, url, ...args);
      }

      if (isInternalMaxUrl(resolved)) {
        return originalOpen.call(window, url, ...args);
      }

      if (typeof Ferdium.openNewWindow === 'function') {
        Ferdium.openNewWindow(resolved);
      } else {
        originalOpen.call(window, resolved, '_blank', 'noopener,noreferrer');
      }

      return null;
    };

    const handleLinkEvent = (event) => {
      if (event.type === 'auxclick' && event.button !== 1) return;

      const link = event.target?.closest?.('a[href]');
      if (!link) return;

      const href = link.href || link.getAttribute('href');
      const resolved = resolveUrl(href);
      if (!resolved) return;

      if (!/^https?:/i.test(resolved)) return;

      if (isImageLink(link.href || resolved)) return;

      // Главный редирект: max.ru/... -> web.max.ru/...
      if (isMaxRuChannelUrl(resolved)) {
        event.preventDefault();
        event.stopImmediatePropagation();

        const webUrl = toWebMaxUrl(resolved);
        if (webUrl) window.location.replace(webUrl);

        return;
      }

      // Файловые ссылки стараемся не отправлять во внешний браузер
      if (isLikelyDownload(resolved, link)) {
        event.preventDefault();
        event.stopPropagation();
        window.location.href = resolved;
        return;
      }

      // Внешние ссылки открываем отдельно
      if (!isInternalMaxUrl(resolved)) {
        event.preventDefault();
        event.stopPropagation();

        if (typeof Ferdium.openNewWindow === 'function') {
          Ferdium.openNewWindow(resolved);
        }

        return;
      }

      // Внутренние web.max.ru ссылки не трогаем,
      // чтобы не вызывать принудительную перезагрузку каналов/чатов.
    };

    document.addEventListener('click', handleLinkEvent, true);
    document.addEventListener('auxclick', handleLinkEvent, true);
  };

  installLinkHandling();

  Ferdium.loop(() => {
    try {
      updateBadge();
      updateDialogTitle();
    } catch (error) {
      console.error('[MAX webview]', error);
    }
  });

  Ferdium.injectCSS('service.css');
};