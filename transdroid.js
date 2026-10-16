(function () {
    'use strict';

    // ===== ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ =====
    var DEF_URL = 'http://192.168.1.50:8080';
    var DEF_USER = '';
    var DEF_PASS = '';
    var DEF_BYPASS = true;
    var DEF_SAVEPATH = '';
    var DEF_CATEGORY = '';
    var DEF_RENAME = true;
    var DEF_CONFIRM = true;
    var DEF_AUTO_CAT_PATH = true; // автоматически добавлять категорию к пути
    // =================================

    var DEBUG = true;
    var ACTION_LOCK_MS = 1000;
    var CT_FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    function notify(text) {
        try {
            if (window.Lampa && Lampa.Noty) {
                Lampa.Noty.show(text);
                return;
            }
        } catch (e) {
            console.warn('[qBittorrent] notify error:', e);
        }

        console.log('[qBittorrent]', text);
    }

    function debugNotify(text) {
        if (DEBUG) notify(text);
    }

    function storeGet(key, def) {
        try {
            if (window.Lampa && Lampa.Storage) {
                var v = Lampa.Storage.get(key, def);
                if (v !== undefined && v !== null) return v;
            }
        } catch (e) {}

        return def;
    }

    function storeSet(key, val) {
        try {
            if (window.Lampa && Lampa.Storage) {
                Lampa.Storage.set(key, val);
                return;
            }
        } catch (e) {}
    }

    function isTrue(v, def) {
        if (v === true || v === 'true') return true;
        if (v === false || v === 'false') return false;
        return def;
    }

    function cfg() {
        return {
            url: storeGet('qbit_url', DEF_URL),
            user: storeGet('qbit_user', DEF_USER),
            pass: storeGet('qbit_pass', DEF_PASS),
            bypass: isTrue(storeGet('qbit_bypass', DEF_BYPASS), DEF_BYPASS),
            savepath: storeGet('qbit_savepath', DEF_SAVEPATH),
            category: storeGet('qbit_category', DEF_CATEGORY),
            rename: isTrue(storeGet('qbit_rename', DEF_RENAME), DEF_RENAME),
            confirm: isTrue(storeGet('qbit_confirm', DEF_CONFIRM), DEF_CONFIRM),
            auto_cat_path: isTrue(storeGet('qbit_auto_cat_path', DEF_AUTO_CAT_PATH), DEF_AUTO_CAT_PATH)
        };
    }

    function base() {
        return String(cfg().url || '').replace(/\/+$/, '');
    }

    // Корректно объединяет части пути, убирая лишние слэши.
    function joinPath(base, sub) {
        if (!base) return sub || '';
        if (!sub) return base;
        return String(base).replace(/\/+$/, '') + '/' + String(sub).replace(/^\/+/, '');
    }

    function buildAddBody(magnet, title) {
        var c = cfg();
        var body = 'urls=' + encodeURIComponent(magnet);

        var finalSavePath = c.savepath || '';
        var autoTMM = false;

        // Если включено автодобавление категории к пути и задана категория:
        if (c.auto_cat_path && c.category) {
            if (finalSavePath) {
                // Есть базовый путь -> добавляем категорию как подпапку
                finalSavePath = joinPath(finalSavePath, c.category);
            } else {
                // Нет базового пути -> включаем autoTMM, путь возьмёт сам qBittorrent
                // из настроек этой категории
                autoTMM = true;
            }
        }

        if (finalSavePath) body += '&savepath=' + encodeURIComponent(finalSavePath);
        if (c.category) body += '&category=' + encodeURIComponent(c.category);
        if (c.rename && title) body += '&rename=' + encodeURIComponent(title);

        // Флаги запуска: оба — для qB 4.x и 5.x
        body += '&paused=false&stopped=false';

        // autoTMM: true = путь управляется категориями в qBittorrent,
        // false = путь берётся из savepath
        body += '&autoTMM=' + (autoTMM ? 'true' : 'false');

        // contentLayout: Original / Subfolder / NoSubfolder.
        // Original — как в торренте. Оставляем как есть, qB решит сам.

        console.log('[qBittorrent] add body:', body);

        return body;
    }

    function magnetHash(magnet) {
        var m = /urn:btih:([a-zA-Z0-9]+)/.exec(magnet || '');
        return m ? m[1].toLowerCase() : '';
    }

    function nativeRequest(req, cb) {
        var sig = 0;

        function drain() {
            try { AndroidJS.getResp(); } catch (e) {}
        }

        function attempt() {
            if (!window.AndroidJS || typeof AndroidJS.httpReq !== 'function') {
                cb(null);
                return;
            }

            if (sig === 0) {
                try { AndroidJS.httpReq(JSON.stringify(req)); }
                catch (e) { sig++; attempt(); return; }
            } else if (sig === 1) {
                try {
                    AndroidJS.httpReq(
                        req.url,
                        JSON.stringify({ method: req.method, body: req.body || '', headers: req.headers || {} })
                    );
                } catch (e) { cb(null); return; }
            } else {
                cb(null);
                return;
            }

            var tries = 0;

            (function poll() {
                tries++;

                var r = null;

                try { r = AndroidJS.getResp(); } catch (e) {}

                if (typeof r === 'string' && r.length) {
                    cb(r);
                    return;
                }

                if (tries > 14) {
                    sig++;
                    attempt();
                    return;
                }

                setTimeout(poll, 150);
            })();
        }

        drain();
        attempt();
    }

    function blindAdd(magnet, title) {
        if (typeof fetch !== 'function') {
            notify('Не удалось отправить: нет транспорта');
            return;
        }

        fetch(base() + '/api/v2/torrents/add', {
            method: 'POST',
            mode: 'no-cors',
            headers: CT_FORM,
            body: buildAddBody(magnet, title)
        }).then(function () {
            notify('Отправлено в qBittorrent (без подтверждения)');
        }).catch(function (err) {
            console.error('[qBittorrent] blind add error:', err);
            notify('Ошибка отправки в qBittorrent');
        });
    }

    function confirmAdd(magnet, cb) {
        var hash = magnetHash(magnet);

        if (!hash) {
            cb(false);
            return;
        }

        nativeRequest({
            url: base() + '/api/v2/torrents/info?hashes=' + hash,
            method: 'GET'
        }, function (resp) {
            cb(typeof resp === 'string' && resp.toLowerCase().indexOf(hash) !== -1);
        });
    }

    function qbAdd(magnet, title) {
        if (!magnet || !/^magnet:\?/i.test(magnet)) {
            notify('Magnet-ссылка не найдена');
            return;
        }

        var c = cfg();

        debugNotify('Отправляю в qBittorrent...');

        var body = buildAddBody(magnet, title);

        function finishAdd(resp) {
            if (resp === null || resp === undefined) {
                blindAdd(magnet, title);
                return;
            }

            console.log('[qBittorrent] add response:', resp);

            if (/Forbidden|403/i.test(resp)) {
                notify('qBittorrent: 403. Включи обход аутентификации для подсети');
                return;
            }

            if (/Fails/i.test(resp)) {
                notify('qBittorrent: ошибка добавления');
                return;
            }

            if (c.confirm) {
                confirmAdd(magnet, function (ok) {
                    notify(ok ? 'Добавлено в qBittorrent ✔' : 'Отправлено в qBittorrent (без подтверждения)');
                });
            } else {
                notify('Отправлено в qBittorrent');
            }
        }

        if (!c.bypass && c.user) {
            nativeRequest({
                url: base() + '/api/v2/auth/login',
                method: 'POST',
                body: 'username=' + encodeURIComponent(c.user) + '&password=' + encodeURIComponent(c.pass),
                headers: CT_FORM
            }, function () {
                nativeRequest({
                    url: base() + '/api/v2/torrents/add',
                    method: 'POST',
                    body: body,
                    headers: CT_FORM
                }, finishAdd);
            });
        } else {
            nativeRequest({
                url: base() + '/api/v2/torrents/add',
                method: 'POST',
                body: body,
                headers: CT_FORM
            }, finishAdd);
        }
    }

    function bindPress(el, handler) {
        var last = 0;

        function wrap(ev) {
            var now = Date.now();

            if (now - last < ACTION_LOCK_MS) return;

            last = now;

            if (ev) {
                ev.preventDefault();
                ev.stopPropagation();

                if (ev.stopImmediatePropagation) {
                    ev.stopImmediatePropagation();
                }
            }

            handler(ev);
        }

        el.addEventListener('hover:enter', wrap);
        el.addEventListener('click', wrap);
    }

    // ================= РЕГИСТРАЦИЯ НАСТРОЕК =================

    function registerSettings() {
        try {
            if (!window.Lampa || !Lampa.SettingsApi) {
                console.error('[qBittorrent] Lampa.SettingsApi недоступен');
                return;
            }

            Lampa.SettingsApi.addComponent({
                component: 'qbit_direct',
                icon: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
                name: 'qBittorrent'
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_url', type: 'input', values: '', default: DEF_URL },
                field: { name: 'Адрес сервера', description: 'Адрес Web UI qBittorrent (например: http://192.168.1.50:8080)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_user', type: 'input', values: '', default: DEF_USER },
                field: { name: 'Логин', description: 'Логин (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_pass', type: 'input', values: '', default: DEF_PASS },
                field: { name: 'Пароль', description: 'Пароль (если не используется обход аутентификации)' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_bypass', type: 'trigger', default: DEF_BYPASS },
                field: { name: 'Обход аутентификации', description: 'Включён обход аутентификации для подсети' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_savepath', type: 'input', values: '', default: DEF_SAVEPATH },
                field: { name: 'Базовый путь сохранения', description: 'Базовый путь (например: /app/qBittorrent). Пусто = по умолчанию сервера' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_category', type: 'input', values: '', default: DEF_CATEGORY },
                field: { name: 'Категория', description: 'Категория для торрентов (например: video)' }
            });

            // Новая настройка: автоматическое добавление категории к пути
            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_auto_cat_path', type: 'trigger', default: DEF_AUTO_CAT_PATH },
                field: {
                    name: 'Автоматически добавлять категорию к пути',
                    description: 'Сохранять торренты в подпапку категории (например, /app/qBittorrent/video). Если путь не задан — включает автоуправление в qBittorrent.'
                }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_rename', type: 'trigger', default: DEF_RENAME },
                field: { name: 'Переименовывать', description: 'Переименовывать торрент в название раздачи' }
            });

            Lampa.SettingsApi.addParam({
                component: 'qbit_direct',
                param: { name: 'qbit_confirm', type: 'trigger', default: DEF_CONFIRM },
                field: { name: 'Проверять добавление', description: 'Проверять, что торрент добавился' }
            });

            console.log('[qBittorrent] Настройки зарегистрированы');
        } catch (e) {
            console.error('[qBittorrent] Ошибка регистрации настроек:', e);
        }
    }

    // ================= ПУНКТ В ГЛАВНОМ МЕНЮ =================

    function addMenuItem() {
        try {
            if (!window.Lampa || !Lampa.Menu || typeof Lampa.Menu.addButton !== 'function') {
                console.error('[qBittorrent] Lampa.Menu.addButton недоступен');
                return;
            }

            var icon = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';

            Lampa.Menu.addButton(icon, 'qBittorrent', function () {
                Lampa.Controller.toggle('settings');

                setTimeout(function () {
                    var item = document.querySelector('[data-component="qbit_direct"]');
                    if (item) {
                        item.click();
                    }
                }, 100);
            });

            console.log('[qBittorrent] Пункт меню добавлен');
        } catch (e) {
            console.error('[qBittorrent] Ошибка добавления пункта меню:', e);
        }
    }

    // ================= КНОПКА В КАРТОЧКЕ ТОРРЕНТА =================

    function initTorrentButton() {
        if (!window.Lampa || !Lampa.Listener) return;

        Lampa.Listener.follow('torrent', function (e) {
            if (!e || e.type !== 'render' || !e.item) return;

            var item = e.item.jquery ? e.item[0] : e.item;
            var data = e.element || {};

            if (!item || item.querySelector('.qbit-direct-btn')) return;

            var button = document.createElement('div');
            button.className = 'qbit-direct-btn selector';
            button.tabIndex = 0;
            button.textContent = '⬇ В qBittorrent';

            bindPress(button, function () {
                var magnet = data.MagnetUri || data.magnetUri || '';
                var title = data.Title || data.title || '';

                console.log('[qBittorrent] press, magnet:', magnet);

                qbAdd(magnet, title);
            });

            item.appendChild(button);
        });
    }

    // ================= ИНИЦИАЛИЗАЦИЯ =================

    function initializePlugin() {
        try {
            console.log('[qBittorrent] Инициализация плагина...');

            registerSettings();
            addMenuItem();
            initTorrentButton();

            if (!document.getElementById('qbit-direct-style')) {
                var style = document.createElement('style');
                style.id = 'qbit-direct-style';
                style.textContent =
                    '.qbit-direct-btn{' +
                    'display:inline-flex;align-items:center;' +
                    'justify-content:center;margin:8px;' +
                    'padding:10px 18px;background:#303638;' +
                    'color:white;border:2px solid #888;' +
                    'border-radius:6px;font-size:18px;' +
                    'position:relative;z-index:999;' +
                    '}' +
                    '.qbit-direct-btn.focus{' +
                    'border-color:white;background:#51595c;' +
                    '}';
                document.head.appendChild(style);
            }

            console.log('[qBittorrent] Плагин загружен');
            notify('qBittorrent: плагин загружен');
        } catch (error) {
            console.error('[qBittorrent] Ошибка инициализации:', error);
            notify('Ошибка инициализации qBittorrent');
        }
    }

    if (window.Lampa && Lampa.Listener) {
        initializePlugin();
    } else {
        document.addEventListener('appready', function () {
            initializePlugin();
        });
    }
})();