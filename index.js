// Global Font — расширение SillyTavern.
// Применяет выбранный файл шрифта (ttf/otf/woff/woff2) ко всему интерфейсу.
// Файлы хранятся в IndexedDB браузера, настройки — в extension_settings.

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'global_font';
const STYLE_ID = 'global-font-override';
const FAMILY = 'GlobalUserFont';
const DB_NAME = 'global-font-ext';
const STORE = 'fonts';

const DEFAULTS = { enabled: true, current: '', sizeAdjust: 100, keepMono: true, urls: [] };

const MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const FORMAT = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };

// Иконки Font Awesome не трогаем, иначе они превратятся в квадратики.
const ICON_EXCLUDE = ':not([class^="fa-"]):not([class*=" fa-"]):not(.fa):not(.fas):not(.far):not(.fab):not(.fal):not(.fad)';
const MONO_EXCLUDE = ':not(code):not(pre):not(kbd):not(samp):not(pre *):not(code *)';
// Запасной список: если в шрифте нет нужных символов (кириллица, эмодзи), берутся отсюда.
const FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif, "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"';

const byId = (id) => document.getElementById(id);
const extOf = (name) => String(name).split('?')[0].split('#')[0].split('.').pop().toLowerCase();

function toast(type, msg) {
    if (typeof toastr !== 'undefined' && toastr[type]) {
        toastr[type](msg, 'Global Font');
    } else {
        console.log(`[GlobalFont] ${msg}`);
    }
}

/* ---------- настройки ---------- */

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = JSON.parse(JSON.stringify(DEFAULTS));
    }
    const s = extension_settings[MODULE];
    for (const key of Object.keys(DEFAULTS)) {
        if (!(key in s)) s[key] = JSON.parse(JSON.stringify(DEFAULTS[key]));
    }
    return s;
}

/* ---------- IndexedDB ---------- */

let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                dbPromise = null;
                reject(req.error);
            };
        });
    }
    return dbPromise;
}

async function dbRun(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

const dbKeys = () => dbRun('readonly', (store) => store.getAllKeys());
const dbGet = (name) => dbRun('readonly', (store) => store.get(name));
const dbPut = (record) => dbRun('readwrite', (store) => store.put(record));
const dbDelete = (name) => dbRun('readwrite', (store) => store.delete(name));

/* ---------- CSS ---------- */

function cssUrl(url) {
    return url.replace(/["'()\\\s]/g, (c) => encodeURIComponent(c));
}

function buildCss(src, format, s) {
    const fmt = format ? ` format("${format}")` : '';
    const sel = '*' + ICON_EXCLUDE + (s.keepMono ? MONO_EXCLUDE : '');
    const adjust = Number(s.sizeAdjust) || 100;
    return `@font-face{font-family:"${FAMILY}";src:url("${cssUrl(src)}")${fmt};font-display:swap;size-adjust:${adjust}%;}
${sel},${sel}::before,${sel}::after{font-family:"${FAMILY}",${FALLBACK} !important;}`;
}

let currentCss = '';
let resolved = null; // { key, src, revoke, format }
let applyToken = 0;

function syncFrame(frame) {
    try {
        const doc = frame.contentDocument;
        if (!doc || !doc.head) return;
        let el = doc.getElementById(STYLE_ID);
        if (!currentCss) {
            if (el) el.remove();
            return;
        }
        if (!el) {
            el = doc.createElement('style');
            el.id = STYLE_ID;
            doc.head.appendChild(el);
        }
        if (el.textContent !== currentCss) el.textContent = currentCss;
    } catch {
        // iframe с другого origin — пропускаем
    }
}

function setStyle(css) {
    currentCss = css;
    let el = byId(STYLE_ID);
    if (!css) {
        if (el) el.remove();
    } else {
        if (!el) {
            el = document.createElement('style');
            el.id = STYLE_ID;
        }
        el.textContent = css;
        document.head.appendChild(el); // всегда последним в <head>
    }
    document.querySelectorAll('iframe').forEach(syncFrame);
}

function watchFrames() {
    const hook = (frame) => {
        if (frame.dataset.gfHooked) return;
        frame.dataset.gfHooked = '1';
        frame.addEventListener('load', () => syncFrame(frame));
        syncFrame(frame);
    };
    new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'IFRAME') hook(node);
                else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(hook);
            }
        }
    }).observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll('iframe').forEach(hook);
}

/* ---------- применение шрифта ---------- */

async function resolveSource(s) {
    const key = s.current;
    if (!key) return null;
    if (resolved && resolved.key === key) return resolved;

    if (key.startsWith('idb:')) {
        const name = key.slice(4);
        const rec = await dbGet(name);
        if (!rec) return null;
        const blob = new Blob([rec.data], { type: rec.mime || 'font/ttf' });
        return { key, src: URL.createObjectURL(blob), revoke: true, format: FORMAT[extOf(name)] || '' };
    }
    if (key.startsWith('url:')) {
        const item = s.urls.find((u) => u.name === key.slice(4));
        if (!item) return null;
        return { key, src: item.url, revoke: false, format: FORMAT[extOf(item.url)] || '' };
    }
    return null;
}

function invalidate() {
    if (resolved && resolved.revoke) URL.revokeObjectURL(resolved.src);
    resolved = null;
}

async function applyFont() {
    const s = getSettings();
    const token = ++applyToken;
    let next = null;

    if (s.enabled && s.current) {
        try {
            next = await resolveSource(s);
        } catch (e) {
            console.error('[GlobalFont]', e);
            toast('error', 'Не удалось прочитать шрифт');
        }
    }

    if (token !== applyToken) {
        // пришёл более новый запрос — этот результат больше не нужен
        if (next && next !== resolved && next.revoke) URL.revokeObjectURL(next.src);
        return;
    }

    setStyle(next ? buildCss(next.src, next.format, s) : '');
    if (resolved && resolved !== next && resolved.revoke) URL.revokeObjectURL(resolved.src);
    resolved = next;
}

/* ---------- интерфейс ---------- */

const SETTINGS_HTML = `
<div class="gf-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🪐ШРИФТ</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label" for="gf_enabled">
                <input id="gf_enabled" type="checkbox">
                <span>Применять шрифт ко всему интерфейсу</span>
            </label>

            <div class="gf-row">
                <select id="gf_select" class="text_pole"></select>
            </div>

            <div class="gf-row">
                <label class="menu_button" for="gf_file">Добавить файл…</label>
                <input id="gf_file" type="file" multiple hidden>
                <div id="gf_delete" class="menu_button">Удалить выбранный</div>
            </div>

            <div class="gf-row">
                <input id="gf_url" type="text" class="text_pole" placeholder="/fonts/MyFont.ttf или https://…">
                <div id="gf_add_url" class="menu_button">Добавить по ссылке</div>
            </div>

            <div class="gf-row">
                <span>Размер букв шрифта: <b id="gf_size_val">100</b>%</span>
            </div>
            <input id="gf_size" type="range" min="50" max="150" step="1">

            <label class="checkbox_label" for="gf_mono">
                <input id="gf_mono" type="checkbox">
                <span>Не трогать моноширинный текст (код)</span>
            </label>

            <div class="gf-hint">
                Если в шрифте нет нужных символов (например, кириллицы), они берутся из запасного шрифта.
                Файлы хранятся в браузере этого устройства, поэтому открывайте SillyTavern всегда по одному и тому же адресу.
            </div>
        </div>
    </div>
</div>`;

async function refreshList() {
    const s = getSettings();
    const sel = byId('gf_select');
    if (!sel) return;

    let names = [];
    try {
        names = await dbKeys();
    } catch (e) {
        console.warn('[GlobalFont] IndexedDB недоступна', e);
    }
    names.sort();

    const addOption = (parent, value, label) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        parent.appendChild(opt);
    };

    sel.textContent = '';
    addOption(sel, '', '— стандартный шрифт —');

    if (names.length) {
        const group = document.createElement('optgroup');
        group.label = 'Файлы';
        names.forEach((n) => addOption(group, 'idb:' + n, n));
        sel.appendChild(group);
    }
    if (s.urls.length) {
        const group = document.createElement('optgroup');
        group.label = 'Ссылки';
        s.urls.forEach((u) => addOption(group, 'url:' + u.name, u.name));
        sel.appendChild(group);
    }

    sel.value = s.current;
    if (sel.value !== s.current) sel.value = '';
}

function save() {
    saveSettingsDebounced();
}

async function onFiles(event) {
    const s = getSettings();
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    let last = null;

    for (const file of files) {
        try {
            const data = await file.arrayBuffer();
            const test = new FontFace('gf-test', data.slice(0));
            await test.load(); // проверяем, что это действительно шрифт
            await dbPut({ name: file.name, data, mime: MIME[extOf(file.name)] || 'font/ttf' });
            last = file.name;
        } catch (e) {
            console.error('[GlobalFont]', e);
            toast('error', `«${file.name}» не удалось прочитать как шрифт`);
        }
    }

    if (last) {
        s.current = 'idb:' + last;
        invalidate();
        save();
        await refreshList();
        await applyFont();
        toast('success', `Шрифт «${last}» применён`);
    }
}

async function onAddUrl() {
    const s = getSettings();
    const input = byId('gf_url');
    const url = input.value.trim();
    if (!url) return;

    try {
        const test = new FontFace('gf-test', `url("${cssUrl(url)}")`);
        await test.load();
    } catch (e) {
        console.error('[GlobalFont]', e);
        toast('error', 'Не удалось загрузить шрифт по ссылке (проверьте адрес и CORS)');
        return;
    }

    let name = url.split('?')[0].split('/').pop() || url;
    try {
        name = decodeURIComponent(name);
    } catch {
        // оставляем как есть
    }

    s.urls = s.urls.filter((u) => u.name !== name);
    s.urls.push({ name, url });
    s.current = 'url:' + name;
    input.value = '';
    invalidate();
    save();
    await refreshList();
    await applyFont();
}

async function onDelete() {
    const s = getSettings();
    const key = s.current;
    if (!key) {
        toast('info', 'Сначала выберите шрифт в списке');
        return;
    }
    const name = key.slice(4);
    if (!confirm(`Удалить «${name}»?`)) return;

    try {
        if (key.startsWith('idb:')) {
            await dbDelete(name);
        } else if (key.startsWith('url:')) {
            s.urls = s.urls.filter((u) => u.name !== name);
        }
    } catch (e) {
        console.error('[GlobalFont]', e);
        toast('error', 'Не удалось удалить шрифт');
        return;
    }

    s.current = '';
    save();
    await refreshList();
    await applyFont();
}

function bindUi() {
    const s = getSettings();

    byId('gf_enabled').checked = s.enabled;
    byId('gf_mono').checked = s.keepMono;
    byId('gf_size').value = s.sizeAdjust;
    byId('gf_size_val').textContent = s.sizeAdjust;

    byId('gf_enabled').addEventListener('change', (e) => {
        s.enabled = e.target.checked;
        save();
        applyFont();
    });
    byId('gf_mono').addEventListener('change', (e) => {
        s.keepMono = e.target.checked;
        save();
        applyFont();
    });
    byId('gf_size').addEventListener('input', (e) => {
        s.sizeAdjust = Number(e.target.value);
        byId('gf_size_val').textContent = s.sizeAdjust;
        save();
        applyFont();
    });
    byId('gf_select').addEventListener('change', (e) => {
        s.current = e.target.value;
        save();
        applyFont();
    });
    byId('gf_file').addEventListener('change', onFiles);
    byId('gf_add_url').addEventListener('click', onAddUrl);
    byId('gf_delete').addEventListener('click', onDelete);
}

jQuery(async () => {
    getSettings();
    const applying = applyFont(); // как можно раньше, чтобы не мигал стандартный шрифт

    const host = byId('extensions_settings2') || byId('extensions_settings');
    if (host) {
        host.insertAdjacentHTML('beforeend', SETTINGS_HTML);
        bindUi();
        await refreshList();
    } else {
        console.warn('[GlobalFont] не найден контейнер настроек расширений');
    }

    await applying;
    watchFrames();
});
