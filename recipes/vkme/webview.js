// webview.js для https://web.vk.me/ (VK Мессенджер)
const _path = require('path');

module.exports = (Ferdium, settings) => {
  const SERVICE_NAME = 'VK';
  let __lastUnreadTotal = 0;
  let __lastNotifyAt = 0;
  const NOTIFY_COOLDOWN_MS = 4000;

  const ensureNotificationPermission = () => {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    } catch {}
  };

  const maybeNotifyUnreadIncrease = (newTotal) => {
    try {
      if (!('Notification' in window)) return;
      if (newTotal > __lastUnreadTotal) {
        const now = Date.now();
        if (now - __lastNotifyAt >= NOTIFY_COOLDOWN_MS) {
          const delta = newTotal - __lastUnreadTotal;
          const isHidden = document.visibilityState !== 'visible';
          if (isHidden && Notification.permission === 'granted') {
            const body = delta === 1 ? 'Новое сообщение' : `Новых сообщений: ${delta}`;
            new Notification(SERVICE_NAME, { body, silent: true });
            __lastNotifyAt = now;
          }
        }
      }
      __lastUnreadTotal = newTotal;
    } catch {
      __lastUnreadTotal = newTotal;
    }
  };

  ensureNotificationPermission();

  const resolveUrl = (value) => {
    if (typeof value !== 'string' || !value) return null;
    try {
      return new URL(value, window.location.origin).toString();
    } catch {
      return null;
    }
  };

  const isAwayUrl = (u) => {
    const abs = resolveUrl(u);
    if (!abs) return false;
    try {
      const url = new URL(abs);
      return url.pathname.includes('away.php') || url.pathname.includes('/away/');
    } catch {
      return false;
    }
  };

  const isInternalVkUrl = (url) => {
    const abs = resolveUrl(url);
    if (!abs) return false;
    if (isAwayUrl(abs)) return false; // away.php считаем внешним
    try {
      const host = (new URL(abs).hostname || '').toLowerCase();
      return (
        host === 'web.vk.me' || host === 'vk.com' || host === 'vk.me' || host === 'vk.ru' ||
        host.endsWith('.vk.me') || host.endsWith('.vk.com') || host.endsWith('.vk.ru') ||
        host.endsWith('userapi.com') || host.endsWith('vkuseraudio.net') || 
        host.endsWith('vkuseraudio.com') || host.endsWith('vkuserphoto.ru') || 
        host.endsWith('vkuserphoto.com') || host === 'vk.cc'
      );
    } catch {
      return false;
    }
  };

  const isMediaUrl = (u) => {
    const abs = resolveUrl(u);
    if (!abs) return false;
    try {
      const p = (new URL(abs).pathname || '').toLowerCase();
      if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|m3u8)(\?|$)/i.test(p)) return true;
      if (p.includes('/impg/') || p.includes('/impf/') || p.includes('/video') || p.includes('/audio')) return true;
      return false;
    } catch {
      return false;
    }
  };

  const isLikelyDownload = (value, element = null) => {
    if (element && typeof element.hasAttribute === 'function' && element.hasAttribute('download')) return true;
    const abs = resolveUrl(value);
    if (!abs) return false;
    try {
      const url = new URL(abs);
      if (/\.(pdf|docx?|xlsx?|pptx?|txt|rtf|zip|rar|7z|tar|gz|exe|msi|apk|dmg|mp3|wav|ogg|flac|aac|m4a|mp4|avi|mkv|mov)$/i.test(url.pathname)) return true;
      if (/disposition=attachment|filename=|download=/i.test(url.search)) return true;
      return false;
    } catch {
      return false;
    }
  };

  const getMessages = () => {
    const nodes = document.querySelectorAll(
      "#filters__all > div > div > button > div.ConvoListItem__icons > div.UnreadCounter"
    );
    let total = 0;
    nodes.forEach((el) => {
      const raw = el.getAttribute("data-count") || el.getAttribute("data-unread") || el.textContent || "";
      const m = String(raw).match(/\d+/);
      total += m ? parseInt(m[0], 10) : 0;
    });
    maybeNotifyUnreadIncrease(total);
    Ferdium.setBadge(total, 0);
  };

  const getActiveDialogTitle = () => {
    const titleElement =
      document.querySelector('[data-testid="chat-title"]') ||
      document.querySelector('[data-testid="header-title"]') ||
      document.querySelector('header h1, header h2') ||
      document.querySelector('[class*="ChatHeader"] h1, [class*="Header"] h1');
    Ferdium.setDialogTitle(titleElement ? String(titleElement.textContent || '').trim() : '');
  };

  const patchLinkOpeners = () => {
    if (window.__ferdium_vk_patched) return;
    window.__ferdium_vk_patched = true;

    const originalOpen = window.open;
    window.open = function patchedOpen(url, ...args) {
      if (!url) return originalOpen.call(window, url, ...args);
      const resolved = resolveUrl(url);
      if (!resolved) return originalOpen.call(window, url, ...args);

      if (isInternalVkUrl(resolved)) {
        return originalOpen.call(window, resolved, ...args);
      }
      
      if (typeof Ferdium.openNewWindow === 'function') {
        Ferdium.openNewWindow(resolved);
      } else {
        return originalOpen.call(window, resolved, '_blank', 'noopener,noreferrer');
      }
      return null;
    };

    const handleLinkEvent = (event) => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      
      const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!a) return;
      
      const href = a.getAttribute('href') || a.href;
      if (!href) return;

      const url = resolveUrl(href);
      if (!url || !/^https?:/i.test(url)) return;

      if (isMediaUrl(url) || isLikelyDownload(url, a)) return;
      if (typeof Ferdium.isImage === 'function' && Ferdium.isImage(a)) return;

      if (isInternalVkUrl(url)) {
        // НЕ трогаем внутренние ссылки, чтобы не ломать SPA-навигацию VK
        // (иначе фото/видео будут вызывать полную перезагрузку страницы).
        return;
      } else {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (typeof Ferdium.openNewWindow === 'function') {
          Ferdium.openNewWindow(url);
        }
      }
    };
    
    document.addEventListener('click', handleLinkEvent, true);
    document.addEventListener('auxclick', handleLinkEvent, true);
  };

  patchLinkOpeners();
  Ferdium.loop(() => {
    getMessages();
    getActiveDialogTitle();
  });
  Ferdium.injectCSS(_path.join(__dirname, 'service.css'));
};