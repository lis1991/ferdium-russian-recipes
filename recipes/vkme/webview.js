// VK Messenger / Ferdium: один файл для изолированного и основного контекстов.
(() => {
    'use strict';

    function installPageHook() {
        const CHANNEL = 'ferdium-vkme-notifications-v2';
        const send = (type, payload = {}) => window.postMessage({
            channel: CHANNEL,
            type,
            ...payload
        }, window.location.origin, );
        if (window.__ferdiumVkNotifications) {
            send('ready');
            return;
        }
        const stats = {
            ready: true,
            messages: 0,
            delivered: 0,
            muted: 0,
            unknown: 0,
            outgoing: 0,
            visible: 0,
            errors: 0
        };
        window.__ferdiumVkNotifications = stats;
        const originalFetch = window.fetch.bind(window);
        const conversations = new Map();
        const names = new Map();
        const seen = new Set();
        const revisions = new Map();
        const inFlight = new Map();
        let credentials = null;
        let queue = Promise.resolve();
        let lastWarning = 0;

        const peerKey = value => {
            const n = Number(value);
            return Number.isSafeInteger(n) && n !== 0 ? String(n) : null;
        };
        const warning = () => {
            stats.errors++;
            if (Date.now() - lastWarning < 30000) return;
            lastWarning = Date.now();
            console.warn('[VK recipe] Не удалось проверить настройки уведомлений. ' +
                'Уведомление пропущено; токены и текст сообщений не журналируются.');
        };
        const toUrl = value => {
            try {
                return new URL(String(value), window.location.origin);
            } catch {
                return null;
            }
        };
        const relevant = url => url && url.hostname === 'api.vk.me' &&
            (/^\/method\//.test(url.pathname) || /^\/ruim\d+/.test(url.pathname));

        async function requestMeta(input, init) {
            const url = toUrl(typeof input === 'string' || input instanceof URL ?
                input : input.url);
            if (!relevant(url)) return null;
            let body = init && init.body;
            if (body == null && typeof Request !== 'undefined' && input instanceof Request) {
                try {
                    body = await input.clone().text();
                } catch {
                    body = '';
                }
            }
            let params;
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                params = new URLSearchParams();
                body.forEach((value, key) => {
                    if (typeof value === 'string') params.set(key, value);
                });
            } else if (typeof body === 'string' || body instanceof URLSearchParams) {
                params = new URLSearchParams(body);
            } else {
                params = new URLSearchParams();
            }
            const token = params.get('access_token') || url.searchParams.get('access_token');
            if (url.pathname.startsWith('/method/') && token) {
                if (credentials && credentials.token !== token) {
                    conversations.clear();
                    names.clear();
                }
                credentials = {
                    token,
                    version: url.searchParams.get('v') || params.get('v'),
                    lang: params.get('lang') || 'ru'
                };
            }
            return {
                url,
                params,
                started: Date.now()
            };
        }

        function saveConversation(value, started) {
            if (!value || !value.peer || !value.push_settings) return;
            const key = peerKey(value.peer.id);
            if (!key) return;
            const current = conversations.get(key);
            // Ответ старого запроса не должен отменять более свежее событие 114.
            if (current && current.changedAt > started) return;
            const push = value.push_settings;
            if (!Object.prototype.hasOwnProperty.call(push, 'disabled_forever') &&
                !Object.prototype.hasOwnProperty.call(push, 'disabled_until')) return;
            conversations.set(key, {
                disabledForever: push.disabled_forever === true || push.disabled_forever === 1,
                disabledUntil: Number(push.disabled_until || 0),
                noSound: push.no_sound === true || push.no_sound === 1,
                title: String((value.chat_settings || {}).title || (current || {}).title || ''),
                updatedAt: Date.now(),
                changedAt: (current || {}).changedAt || 0,
            });
        }

        function harvest(value, started, depth = 0) {
            if (!value || typeof value !== 'object' || depth > 12) return;
            if (Array.isArray(value)) {
                value.forEach(item => harvest(item, started, depth + 1));
                return;
            }
            saveConversation(value, started);
            if (value.id != null && typeof value.first_name === 'string') {
                names.set(String(value.id), [value.first_name, value.last_name].filter(Boolean).join(' '));
            } else if (value.id != null && typeof value.name === 'string' &&
                typeof value.screen_name === 'string') {
                names.set(String(-Math.abs(Number(value.id))), value.name);
            }
            Object.values(value).forEach(item => harvest(item, started, depth + 1));
        }

        function applySilence(key, until, sound) {
            if (!key || !Number.isFinite(until)) return;
            const current = conversations.get(key) || {};
            revisions.set(key, (revisions.get(key) || 0) + 1);
            conversations.set(key, {
                ...current,
                disabledForever: until === -1,
                disabledUntil: until,
                noSound: sound === 0 || sound === '0',
                updatedAt: Date.now(),
                changedAt: Date.now(),
            });
        }

        async function api(method, params) {
            // Используется только текущий токен самого сайта; на диск он не записывается.
            for (let i = 0; !credentials && i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            const auth = credentials;
            if (!auth || !auth.version) throw new Error('No current API credentials');
            const body = new URLSearchParams({...params,
                access_token: auth.token,
                lang: auth.lang
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
                const response = await originalFetch(
                    `https://api.vk.me/method/${method}?v=${encodeURIComponent(auth.version)}`, {
                        method: 'POST',
                        credentials: 'include',
                        signal: controller.signal,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body
                    },
                );
                if (!response.ok) throw new Error('API HTTP error');
                const data = await response.json();
                if (data.error || !data.response) throw new Error('API rejected request');
                return data;
            } finally {
                clearTimeout(timer);
            }
        }

        async function getConversation(key) {
            const cached = conversations.get(key);
            if (cached && Date.now() - cached.updatedAt < 10000) return cached;
            if (!inFlight.has(key)) {
                const revision = revisions.get(key) || 0;
                const started = Date.now();
                const task = api('messages.getConversationsById', {
                    peer_ids: key,
                    extended: '1',
                    fields: 'first_name,last_name',
                    group_id: '0',
                }).then(data => {
                    if ((revisions.get(key) || 0) === revision) harvest(data.response, started);
                    return conversations.get(key) || null;
                }).finally(() => inFlight.delete(key));
                inFlight.set(key, task);
            }
            return inFlight.get(key);
        }

        const muted = state => state.disabledForever ||
            state.disabledUntil === -1 ||
            state.disabledUntil > Date.now() / 1000;
        const decodeText = value => {
            const el = document.createElement('textarea');
            el.innerHTML = String(value || '');
            return el.value;
        };

        function attachmentText(attachments) {
            const keys = Object.keys(attachments || {});
            const type = String((attachments || {}).attach1_type || '');
            const labels = {
                photo: 'Фотография',
                video: 'Видео',
                audio: 'Аудиозапись',
                audio_message: 'Голосовое сообщение',
                doc: 'Документ',
                sticker: 'Стикер',
                link: 'Ссылка',
                wall: 'Запись',
                poll: 'Опрос'
            };
            if (labels[type]) return labels[type];
            if (keys.some(key => /^attach\d+/.test(key))) return 'Вложение';
            if ((attachments || {}).fwd && attachments.fwd !== '0_0') return 'Пересланное сообщение';
            return 'Новое сообщение без текста';
        }

        async function notifyMessage(event) {
            const key = peerKey(event[4]);
            if (!key || !Number.isSafeInteger(Number(event[1]))) return;
            const flags = Number(event[2]);
            if (!Number.isFinite(flags)) return;
            if (flags & 2) {
                stats.outgoing++;
                return;
            }
            const id = `${key}:${event[1]}`;
            if (seen.has(id)) return;
            seen.add(id);
            if (seen.size > 2000) seen.delete(seen.values().next().value);
            stats.messages++;
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                stats.visible++;
                return;
            }
            let state;
            try {
                state = await getConversation(key);
            } catch {
                stats.unknown++;
                warning();
                return;
            }
            if (!state) {
                stats.unknown++;
                warning();
                return;
            }
            // Состояние могло измениться, пока выполнялся запрос.
            state = conversations.get(key) || state;
            if (muted(state)) {
                stats.muted++;
                return;
            }
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                stats.visible++;
                return;
            }
            const extra = event[7] || {};
            const sender = names.get(String(extra.from || key));
            const title = state.title || names.get(key) || 'VK';
            const text = decodeText(event[6]).trim() || attachmentText(event[8]);
            send('notify', {
                peer: key,
                title: title.slice(0, 256),
                body: (state.title && sender ? `${sender}: ${text}` : text).slice(0, 4000),
                tag: `vkme:${id}`
            });
            stats.delivered++;
        }

        function observe(data, meta) {
            if (!meta || !data || typeof data !== 'object') return;
            if (meta.url.pathname.startsWith('/method/')) {
                if (data.response) harvest(data.response, meta.started);
                if (meta.url.pathname === '/method/account.setSilenceMode' &&
                    data.response === 1 && meta.params.has('time')) {
                    applySilence(peerKey(meta.params.get('peer_id')),
                        Number(meta.params.get('time')), meta.params.get('sound'));
                }
            }
            if (!Array.isArray(data.updates)) return;
            for (const event of data.updates) {
                if (!Array.isArray(event)) continue;
                if (event[0] === 114 && event[1]) {
                    const value = event[1];
                    applySilence(peerKey(value.peer_id), Number(value.disabled_until), value.sound);
                }
            }
            for (const event of data.updates) {
                if (Array.isArray(event) && event[0] === 10004) {
                    queue = queue.then(() => notifyMessage(event)).catch(warning);
                }
            }
        }

        window.fetch = function patchedFetch(input, init) {
            const metadata = requestMeta(input, init).catch(() => null);
            return originalFetch(input, init).then(response => {
                metadata.then(meta => {
                    if (!meta) return;
                    response.clone().json().then(data => observe(data, meta)).catch(() => {});
                }).catch(() => {});
                return response;
            });
        };
        if (typeof XMLHttpRequest !== 'undefined') {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            const requestUrls = new WeakMap();
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                requestUrls.set(this, url);
                return originalOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function(body) {
                const metadata = requestMeta(String(requestUrls.get(this) || ''), {
                        body
                    })
                    .catch(() => null);
                this.addEventListener('load', () => {
                    metadata.then(meta => {
                        if (!meta || this.status < 200 || this.status >= 300) return;
                        try {
                            const data = this.responseType === 'json' ? this.response :
                                JSON.parse(this.responseText);
                            observe(data, meta);
                        } catch {}
                    }).catch(() => {});
                }, {
                    once: true
                });
                return originalSend.call(this, body);
            };
        }
        window.addEventListener('message', event => {
            const data = event.data;
            if (event.source !== window || event.origin !== location.origin ||
                !data || data.channel !== CHANNEL || data.type !== 'open') return;
            const key = peerKey(data.peer);
            if (key) location.assign(`/convo/${encodeURIComponent(key)}`);
        });
        console.info('[VK recipe] Перехват fetch/XHR установлен.');
        send('ready');
    }

    if (typeof module === 'object' && module.exports && typeof require === 'function') {
        const _path = require('path');

        module.exports = (Ferdium, settings) => {
            const CHANNEL = 'ferdium-vkme-notifications-v2';
            let hookReady = false;
            let permissionRequested = false;
            const ensureNotificationPermission = () => {
                try {
                    if (typeof Notification === 'undefined' || Notification.permission !== 'default' ||
                        permissionRequested) return;
                    permissionRequested = true;
                    Promise.resolve(Notification.requestPermission()).catch(() => {});
                } catch {}
            };
            window.addEventListener('message', event => {
                const data = event.data;
                if (event.source !== window || event.origin !== location.origin ||
                    !data || data.channel !== CHANNEL) return;
                if (data.type === 'ready') {
                    hookReady = true;
                    console.info('[VK recipe] Обработчик уведомлений готов.');
                    return;
                }
                if (data.type !== 'notify' || typeof data.title !== 'string' ||
                    typeof data.body !== 'string' || !/^-?\d+$/.test(String(data.peer))) return;
                if (document.visibilityState === 'visible' && document.hasFocus()) return;
                try {
                    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
                        ensureNotificationPermission();
                        return;
                    }
                    const notification = new Notification(data.title, {
                        body: data.body,
                        tag: String(data.tag || ''),
                        silent: true,
                    });
                    notification.onclick = () => {
                        window.focus();
                        window.postMessage({
                            channel: CHANNEL,
                            type: 'open',
                            peer: data.peer
                        }, location.origin);
                        notification.close();
                    };
                } catch (error) {
                    console.warn('[VK recipe] Не удалось создать системное уведомление.', error.name);
                }
            });
            ensureNotificationPermission();
            if (typeof Ferdium.injectJSUnsafe !== 'function') {
                console.error('[VK recipe] Эта версия Ferdium не поддерживает injectJSUnsafe.');
            } else {
                try {
                    const result = Ferdium.injectJSUnsafe(_path.join(__dirname, 'webview.js'));
                    if (result && typeof result.catch === 'function') {
                        result.catch(() => console.error('[VK recipe] Ошибка внедрения обработчика.'));
                    }
                } catch {
                    console.error('[VK recipe] Ошибка внедрения обработчика.');
                }
                setTimeout(() => {
                    if (!hookReady) console.warn('[VK recipe] Нет подтверждения от обработчика страницы.');
                }, 10000);
            }

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
                    '#filters__all > div > div > button > div.ConvoListItem__icons > div.UnreadCounter'
                );

                let total = 0;

                nodes.forEach(el => {
                    // Не учитываем чаты с отключёнными уведомлениями.
                    if (el.classList.contains('UnreadCounter--muted')) {
                        return;
                    }

                    const raw =
                        el.getAttribute('data-count') ||
                        el.getAttribute('data-unread') ||
                        el.textContent ||
                        '';

                    const match = String(raw).match(/\d+/);

                    if (match) {
                        total += Number.parseInt(match[0], 10);
                    }
                });

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
            if (require('fs').existsSync(_path.join(__dirname, 'service.css'))) {
                Ferdium.injectCSS(_path.join(__dirname, 'service.css'));
            }
        };
    } else {
        installPageHook();
    }
})();