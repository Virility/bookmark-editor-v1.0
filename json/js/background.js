const ext = getBrowserExt();
const menus = ext.menus || ext.contextMenus;

const SHOW_IN_LIBRARY = 'show-in-library';
const OBSIDIAN_LINK = 'obsidian-link';
const OBSIDIAN_FOLDER = 'obsidian-folder';
const OBSIDIAN_SEARCH_CHAIN = 'obsidian-search-chain';
const NEST_ENTRY = 'nest-in-folder';
const FIND_DOMAIN = 'find-domain-stats';
const SHOW_PAGE_IN_LIBRARY = 'show-page-in-library';
const OBSIDIAN_TAB = 'obsidian-tab';
const OBSIDIAN_TAB_CLOSE = 'obsidian-tab-close';
const OBSIDIAN_WINDOW = 'obsidian-window';
// The daily-note pair, shown only when the destination setting asks for a daily note (or both).
const OBSIDIAN_TAB_DAILY = 'obsidian-tab-daily';
const OBSIDIAN_TAB_DAILY_CLOSE = 'obsidian-tab-daily-close';
const UNDO_WEB_DELETE = 'undo-web-delete';
const UNDO_NEST = 'undo-nest';
// Copy menu for the browser's own tab menu. Firefox draws a submenu inside our submenu;
// Chrome only paints one level of submenus, so there the three items are added flat and
// stay reachable instead of disappearing.
const COPY_TAB_MENU = 'copy-tab';
const COPY_TAB_TITLE = 'copy-tab-title';
const COPY_TAB_URL = 'copy-tab-url';
const COPY_TAB_MARKDOWN = 'copy-tab-markdown';
const COPY_TAB_URL_ORIGINAL = 'copy-tab-url-original';
// Window copies: the same three shapes for every tab in the right-clicked tab's window.
const COPY_WINDOW_MENU = 'copy-window';
const COPY_WINDOW_TITLES = 'copy-window-titles';
const COPY_WINDOW_URLS = 'copy-window-urls';
const COPY_WINDOW_MARKDOWN = 'copy-window-markdown';
const BOOKMARK_WEB_LINK = 'bookmark-web-link';
const OBSIDIAN_WEB_LINK = 'obsidian-web-link';
const OBSIDIAN_WEB_LINK_DELETE = 'obsidian-web-link-delete';
const OBSIDIAN_WEB_PAGE = 'obsidian-web-page';
const OBSIDIAN_WEB_PAGE_DELETE = 'obsidian-web-page-delete';
const OBSIDIAN_WEB_SELECTION = 'obsidian-web-selection';
const OBSIDIAN_WEB_SELECTION_DELETE = 'obsidian-web-selection-delete';
const OBSIDIAN_WEB_SELECTION_UNDER = 'obsidian-web-selection-under';
const OBSIDIAN_WEB_LINK_UNDER_TEXT = 'obsidian-web-link-under-text';
const OBSIDIAN_WEB_REDDIT_TEXT = 'obsidian-web-reddit-text';
const OBSIDIAN_WEB_GOOGLE_SEARCH = 'obsidian-web-google-search';
const REDDIT_MENU_URLS = ['*://*.reddit.com/*', '*://reddit.com/*', '*://redd.it/*', '*://*.redd.it/*'];
const PAGE_MENU_CONTEXTS = ['page', 'video', 'audio', 'frame'];
// Parent submenu the extension's items are grouped under, and every context any of
// them uses (a child cannot appear where its parent is not shown).
const MENU_ROOT_ID = 'bookmark-library-root';
const MENU_ROOT_TITLE = 'Bookmark Library';
const MENU_ROOT_CONTEXTS = ['bookmark', 'tab', 'page', 'video', 'audio', 'frame', 'link', 'selection', 'browser_action'];
let tabMenuTargetId = null;
let domainMenuHref = '';
const menuShown = {
    selectionTitle: 'Send text to Obsidian',
    bookmarkLink: true,
    bookmarkFolder: true,
    bookmarkChain: false,
    bookmarkShow: true,
    bookmarkNest: true,
    webLinkDelete: false,
    webSelectionDelete: false,
    webPageDelete: false,
    findDomain: false,
    pageShow: false
};

function resetMenuShown() {
    menuShown.selectionTitle = 'Send text to Obsidian';
    menuShown.bookmarkLink = true;
    menuShown.bookmarkFolder = true;
    menuShown.bookmarkChain = false;
    menuShown.bookmarkShow = true;
    menuShown.bookmarkNest = true;
    menuShown.webLinkDelete = false;
    menuShown.webSelectionDelete = false;
    menuShown.webPageDelete = false;
    menuShown.findDomain = false;
    menuShown.pageShow = false;
}

function callBookmarks(method, ...args) {
    const api = ext.bookmarks;
    if (typeof browser !== 'undefined' && browser.bookmarks && typeof browser.bookmarks[method] === 'function') {
        return Promise.resolve(browser.bookmarks[method](...args));
    }
    return new Promise((resolve, reject) => {
        api[method](...args, result => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve(result);
        });
    });
}

function callTabs(method, ...args) {
    const api = ext.tabs;
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('Tabs API is not available.'));
    if (typeof browser !== 'undefined' && browser.tabs && typeof browser.tabs[method] === 'function') {
        return Promise.resolve(browser.tabs[method](...args));
    }
    return new Promise((resolve, reject) => {
        api[method](...args, result => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve(result);
        });
    });
}

function callMenus(method, ...args) {
    if (!menus || typeof menus[method] !== 'function') return Promise.resolve();
    try {
        const ret = menus[method](...args);
        if (ret && typeof ret.then === 'function') return ret;
    } catch (err) {
        /* Chrome callback form */
    }
    return new Promise((resolve, reject) => {
        try {
            menus[method](...args, result => {
                const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
                if (last) reject(new Error(last.message));
                else resolve(result);
            });
        } catch (err) {
            reject(err);
        }
    });
}

async function loadNode(id) {
    const nodes = await callBookmarks('get', id);
    return Array.isArray(nodes) ? nodes[0] : nodes;
}

async function listChildren(id) {
    try {
        const kids = await callBookmarks('getChildren', id);
        if (Array.isArray(kids)) return kids;
    } catch (err) {
        /* some roots only work via getSubTree */
    }
    const tree = await callBookmarks('getSubTree', id);
    const root = Array.isArray(tree) ? tree[0] : tree;
    return (root && root.children) || [];
}

async function buildFolderMarkdown(node, depth) {
    const lines = [mdFolderLine(node, depth)];
    const children = await listChildren(node.id);
    for (const child of children) {
        if (!child || child.type === 'separator') continue;
        if (isBookmarkFolderNode(child)) {
            lines.push(...await buildFolderMarkdown(child, depth + 1));
            continue;
        }
        if (nodeUri(child)) lines.push(mdLinkLine(child, depth + 1));
    }
    return lines;
}

let linkCache = { at: 0, links: null, keys: null, domains: null };
let nextMenuInstanceId = 1;
let lastMenuInstanceId = 0;
const canRefreshMenus = Boolean(menus && typeof menus.refresh === 'function' && menus.onShown);

const LINK_CACHE_REBUILD_MS = 1500;
let linkCacheGen = 0;
let linkCacheBuild = null;
let linkCacheTimer = 0;

function invalidateLinkCache() {
    linkCacheGen++;
    linkCache = { at: 0, links: null, keys: null, domains: null };
    clearTimeout(linkCacheTimer);
    linkCacheTimer = setTimeout(() => {
        linkCacheTimer = 0;
        allUrlLinks().catch(() => {});
    }, LINK_CACHE_REBUILD_MS);
}

function collectUrlNodes(node, out, path) {
    if (!node) return;
    const folders = path || [];
    const uri = nodeUri(node);
    if (uri) {
        const added = Number(node.dateAdded);
        const folderPath = folders.filter(part => part && part !== 'Root').join(' / ') || 'Root';
        out.push({
            id: String(node.id),
            title: node.title,
            uri,
            url: uri,
            urlKey: bookmarkUrlKey(uri),
            addedMs: Number.isFinite(added) ? added : null,
            folderPath
        });
    }
    const next = uri ? folders : folders.concat(displayFolderTitle(node));
    (node.children || []).forEach(child => collectUrlNodes(child, out, next));
}

function rebuildLinkKeySet(links) {
    const keys = new Set();
    (links || []).forEach(link => {
        const key = (link && (link.urlKey || bookmarkUrlKey(link.uri))) || '';
        if (key) keys.add(key);
    });
    return keys;
}

function hrefDomain(href) {
    try {
        const host = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
        return host ? parentDomainFromHost(host) : '';
    } catch (err) {
        return '';
    }
}

function rebuildLinkDomainSet(links) {
    const domains = new Set();
    (links || []).forEach(link => {
        const domain = hrefDomain(link && link.uri);
        if (domain) domains.add(domain);
    });
    return domains;
}

function domainBookmarkedButNotPage(href) {
    if (!href || !linkCache.domains || !linkCache.keys) return false;
    if (!/^https?:/i.test(href)) return false;
    const domain = hrefDomain(href);
    return Boolean(domain) && linkCache.domains.has(domain) && !hrefIsBookmarkedSync(href);
}

async function allUrlLinks() {
    if (linkCache.links && linkCache.keys && Date.now() - linkCache.at < 300000) return linkCache.links;
    if (linkCacheBuild && linkCacheBuild.gen === linkCacheGen) return linkCacheBuild.promise;
    const gen = linkCacheGen;
    const promise = (async () => {
        const tree = await callBookmarks('getTree');
        const links = [];
        (Array.isArray(tree) ? tree : [tree]).forEach(root => collectUrlNodes(root, links));
        if (gen === linkCacheGen) {
            linkCache = { at: Date.now(), links, keys: rebuildLinkKeySet(links), domains: rebuildLinkDomainSet(links) };
            refreshActiveBadges();
        }
        return links;
    })();
    linkCacheBuild = { gen, promise };
    promise.catch(() => {}).then(() => {
        if (linkCacheBuild && linkCacheBuild.promise === promise) linkCacheBuild = null;
    });
    return promise;
}

const badgeApi = ext.browserAction || ext.action;

function setTabBadge(tabId, bookmarked) {
    if (!badgeApi || tabId == null) return;
    try {
        const ret = badgeApi.setBadgeText({ tabId, text: bookmarked ? '★' : '' });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {}
}

async function updateTabBadge(tab) {
    if (!tab || tab.id == null) return;
    const href = sendablePageHref(tabTargetUrl(tab));
    if (!href) {
        setTabBadge(tab.id, false);
        return;
    }
    if (!linkCache.keys) {
        try { await allUrlLinks(); } catch (err) { return; }
    }
    setTabBadge(tab.id, Boolean(hrefIsBookmarkedSync(href)));
}

function refreshActiveBadges() {
    scheduleActionTitleUpdate();
    if (!badgeApi || !ext.tabs) return;
    callTabs('query', { active: true }).then(tabs => {
        (tabs || []).forEach(tab => updateTabBadge(tab).catch(() => {}));
    }).catch(() => {});
}

// The toolbar tooltip carries the counts the Open Tabs view leads with: how many tabs are
// open across normal windows, and how many of them the library already holds. The
// bookmarked check reuses linkCache — the very cache the ★ badge is built from — so this
// never rescans the bookmark tree per tab; when the cache is cold it waits for the one
// build allUrlLinks() already runs. Counting every window is not free, so tab and window
// events only queue this debounced refresh instead of querying once per event.
const ACTION_TITLE_DEBOUNCE_MS = 250;
let actionTitleTimer = 0;

function actionTitleApi() {
    return ext.browserAction && typeof ext.browserAction.setTitle === 'function' ? ext.browserAction : null;
}

function actionTitleText(tabCount, trackedCount) {
    return `Bookmark Library — ${formatCount(tabCount)} tab(s) open, ${formatCount(trackedCount)} tracked`;
}

async function normalWindowTabs() {
    try {
        const found = await callTabs('query', { windowType: 'normal' });
        if (Array.isArray(found)) return found;
    } catch (err) {
        /* some builds reject the windowType filter; fall back to every tab */
    }
    try {
        const found = await callTabs('query', {});
        if (Array.isArray(found)) return found;
    } catch (err) {
        return null;
    }
    return null;
}

async function updateActionTitle() {
    const api = actionTitleApi();
    if (!api || !ext.tabs) return '';
    const tabs = await normalWindowTabs();
    if (!tabs) return '';
    if (!linkCache.keys) {
        try {
            await allUrlLinks();
        } catch (err) {
            return '';
        }
    }
    const tracked = tabs.filter(tab => {
        const href = sendablePageHref(tabTargetUrl(tab));
        return Boolean(href) && Boolean(hrefIsBookmarkedSync(href));
    }).length;
    const title = actionTitleText(tabs.length, tracked);
    try {
        const ret = api.setTitle({ title });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {}
    return title;
}

function scheduleActionTitleUpdate() {
    if (!actionTitleApi()) return;
    if (actionTitleTimer) clearTimeout(actionTitleTimer);
    actionTitleTimer = setTimeout(() => {
        actionTitleTimer = 0;
        updateActionTitle().catch(() => {});
    }, ACTION_TITLE_DEBOUNCE_MS);
}

if (badgeApi && badgeApi.setBadgeBackgroundColor) {
    try {
        const ret = badgeApi.setBadgeBackgroundColor({ color: '#6b4fbb' });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {}
}

if (ext.tabs && ext.tabs.onActivated) {
    ext.tabs.onActivated.addListener(info => {
        scheduleActionTitleUpdate();
        callTabs('get', info.tabId).then(updateTabBadge).catch(() => {});
    });
}

if (ext.tabs && ext.tabs.onUpdated) {
    ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo && (changeInfo.url || changeInfo.status === 'complete')) {
            scheduleActionTitleUpdate();
            updateTabBadge(tab).catch(() => {});
        }
    });
}

// Tabs and whole windows appearing or closing change both counts; these are guarded like
// the badge listeners above and only queue the debounced tooltip refresh.
if (ext.tabs) {
    ['onCreated', 'onRemoved'].forEach(eventName => {
        const ev = ext.tabs[eventName];
        if (ev && ev.addListener) ev.addListener(() => scheduleActionTitleUpdate());
    });
}
if (ext.windows) {
    ['onCreated', 'onRemoved'].forEach(eventName => {
        const ev = ext.windows[eventName];
        if (ev && ev.addListener) ev.addListener(() => scheduleActionTitleUpdate());
    });
}

const TAB_OPENED_KEY = 'openedAt';

function tabSessionsApi() {
    return typeof browser !== 'undefined' && browser.sessions && typeof browser.sessions.setTabValue === 'function' ? browser.sessions : null;
}

async function stampTabOpened(tab, exact) {
    const sessions = tabSessionsApi();
    if (!sessions || !tab || tab.id == null || tab.id < 0) return;
    try {
        const have = await sessions.getTabValue(tab.id, TAB_OPENED_KEY);
        if (have && have.t) return;
        await sessions.setTabValue(tab.id, TAB_OPENED_KEY, { t: Date.now(), exact: Boolean(exact) });
    } catch (err) {}
}

if (ext.tabs && ext.tabs.onCreated && tabSessionsApi()) {
    ext.tabs.onCreated.addListener(tab => { stampTabOpened(tab, true); });
    // Session-restored tabs keep their stored value; this sweep only marks tabs that never had one.
    setTimeout(() => {
        callTabs('query', {}).then(tabs => (tabs || []).forEach(tab => stampTabOpened(tab, false))).catch(() => {});
    }, 5000);
}

function hrefIsBookmarkedSync(href) {
    if (!linkCache.keys) return null;
    const key = bookmarkUrlKey(href);
    if (!key) return false;
    return linkCache.keys.has(key);
}

function findSearchChainForId(links, id) {
    const key = String(id);
    return clusterSearchChains(links, SEARCH_CHAIN_GAP_MS).find(chain =>
        chain.links.some(link => String(link.id) === key)
    ) || null;
}

async function sendSearchChainAndDelete(id) {
    if (!id) return;
    const links = await allUrlLinks();
    const chain = findSearchChainForId(links, id);
    if (!chain) return;
    await backgroundSendMarkdown(searchChainMarkdown(chain));
    await removeBookmarksWithUndo(chain.links.map(link => link.id), 'Search chain');
}

async function sendBookmarkId(id, asFolder) {
    if (!id) return;
    const node = await loadNode(id);
    if (!node) return;
    const folder = asFolder || isBookmarkFolderNode(node);
    if (folder) {
        const lines = await buildFolderMarkdown(node, 0);
        if (!lines.length) return;
        await backgroundSendMarkdown(lines.join('\n'));
        return;
    }
    if (!nodeUri(node)) return;
    await backgroundSendMarkdown(mdLinkLine(node, 0));
}

function tabTargetUrl(tab) {
    if (!tab) return '';
    return tab.url || tab.pendingUrl || '';
}

async function resolveClickedTab(tab) {
    const id = tabMenuTargetId != null ? tabMenuTargetId : (tab && tab.id);
    if (id != null) {
        try {
            const fresh = await callTabs('get', id);
            if (tabTargetUrl(fresh)) return fresh;
        } catch (err) {
            /* fall through to the click event's tab */
        }
    }
    return tab;
}

async function highlightedTabsFor(tab) {
    const windowId = tab && tab.windowId;
    const query = { highlighted: true };
    if (windowId != null) query.windowId = windowId;
    else query.currentWindow = true;
    let tabs = [];
    try {
        const found = await callTabs('query', query);
        if (Array.isArray(found)) tabs = found;
    } catch (err) {
        tabs = [];
    }
    tabs = tabs.filter(item => tabTargetUrl(item));
    tabs.sort((a, b) => (a.index || 0) - (b.index || 0));
    const clicked = await resolveClickedTab(tab);
    if (clicked && tabTargetUrl(clicked) && !tabs.some(item => item.id === clicked.id)) {
        tabs.push(clicked);
        tabs.sort((a, b) => (a.index || 0) - (b.index || 0));
    }
    return tabs;
}

function hrefFromSelection(text) {
    const value = (text || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (/^www\./i.test(value)) return `https://${value}`;
    if (/^(?:youtube\.com|youtu\.be|m\.youtube\.com|reddit\.com|github\.com|x\.com|twitter\.com)\b/i.test(value)) {
        return `https://${value}`;
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\/[^\s]*$/i.test(value)) {
        return `https://${value}`;
    }
    return '';
}

function sendablePageHref(url) {
    const href = (url || '').trim();
    if (!href) return '';
    const lower = href.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('moz-extension:') || lower.startsWith('chrome-extension:') || lower.startsWith('about:')) return '';
    return href;
}

async function unfiledFolderId() {
    const tree = await callBookmarks('getTree');
    const root = Array.isArray(tree) ? tree[0] : tree;
    const kids = (root && root.children) || [];
    for (const child of kids) {
        if (!child || child.url) continue;
        if (child.id === 'unfiled_____' || String(child.id) === '2') return child.id;
        const title = String(child.title || '').toLowerCase();
        if (title === 'other bookmarks' || title === 'unsorted bookmarks') return child.id;
    }
    throw new Error('Other Bookmarks folder was not found.');
}

let bookmarkWebChain = Promise.resolve();

function callStorageSet(values) {
    const api = ext.storage && ext.storage.local;
    if (!api || typeof api.set !== 'function') return Promise.reject(new Error('Storage is not available.'));
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local && typeof browser.storage.local.set === 'function') {
        return Promise.resolve(browser.storage.local.set(values));
    }
    return new Promise((resolve, reject) => {
        api.set(values, () => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve();
        });
    });
}

function callStorageGet(keys) {
    const api = ext.storage && ext.storage.local;
    if (!api || typeof api.get !== 'function') return Promise.resolve({});
    if (typeof browser !== 'undefined' && browser.storage && browser.storage.local && typeof browser.storage.local.get === 'function') {
        return Promise.resolve(browser.storage.local.get(keys));
    }
    return new Promise(resolve => {
        api.get(keys, result => resolve(result || {}));
    });
}

function apiFolderMatches(node, kind) {
    if (!node || node.url) return false;
    const id = String(node.id || '');
    const title = String(node.title || '').toLowerCase();
    if (kind === 'toolbar') {
        return id === 'toolbar_____' || id === '1' || title === 'bookmarks toolbar' || title === 'bookmarks bar' || title === 'bookmark bar' || title === 'favorites bar';
    }
    if (kind === 'unfiled') {
        return id === 'unfiled_____' || id === '2' || title === 'other bookmarks' || title === 'unsorted bookmarks';
    }
    if (kind === 'mobile') {
        return id === 'mobile______' || title === 'mobile bookmarks';
    }
    return false;
}

function findApiFolderId(root, kind) {
    let found = '';
    function walk(node) {
        if (found || !node) return;
        if (apiFolderMatches(node, kind)) {
            found = node.id;
            return;
        }
        (node.children || []).forEach(walk);
    }
    walk(root);
    return found;
}

function notifyAutoMove(payload) {
    if (!ext.runtime || typeof ext.runtime.sendMessage !== 'function') return;
    try {
        const ret = ext.runtime.sendMessage({ type: 'auto-move-done', ...payload });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (e) {}
}

async function readAutoMoveSettings() {
    let stored = {};
    try {
        const box = await callStorageGet(AUTO_MOVE_STORAGE_KEY);
        stored = (box && box[AUTO_MOVE_STORAGE_KEY]) || {};
    } catch (e) {
        stored = {};
    }
    return autoMoveSettingsFrom(stored);
}

async function writeAutoMoveSettings(settings) {
    const next = autoMoveSettingsFrom(settings);
    try {
        await callStorageSet({ [AUTO_MOVE_STORAGE_KEY]: next });
    } catch (e) {}
    return next;
}

function callAlarmsClear(name) {
    const api = ext.alarms;
    if (!api || typeof api.clear !== 'function') return Promise.resolve();
    if (typeof browser !== 'undefined' && browser.alarms && typeof browser.alarms.clear === 'function') {
        return Promise.resolve(browser.alarms.clear(name)).then(() => {});
    }
    return new Promise(resolve => {
        api.clear(name, () => resolve());
    });
}

function callAlarmsCreate(name, info) {
    const api = ext.alarms;
    if (!api || typeof api.create !== 'function') return;
    try {
        api.create(name, info);
    } catch (e) {}
}

async function scheduleAutoMoveAlarm() {
    const settings = await readAutoMoveSettings();
    if (!autoMoveEnabled(settings)) {
        await callAlarmsClear(AUTO_MOVE_ALARM);
        return settings;
    }
    if (!settings.autoMoveLastAt) {
        settings.autoMoveLastAt = Date.now();
        await writeAutoMoveSettings(settings);
    }
    const intervalMin = Math.max(1, settings.autoMoveHours * 60);
    const due = settings.autoMoveLastAt + intervalMin * 60 * 1000;
    const remainingMin = (due - Date.now()) / 60000;
    const delayInMinutes = remainingMin <= 0 ? 0.25 : Math.max(0.25, remainingMin);
    await callAlarmsClear(AUTO_MOVE_ALARM);
    callAlarmsCreate(AUTO_MOVE_ALARM, { delayInMinutes, periodInMinutes: intervalMin });
    return settings;
}

let autoMoveChain = Promise.resolve();

async function runAutoMoveToOther() {
    const settings = await readAutoMoveSettings();
    if (!autoMoveEnabled(settings)) return { toolbar: 0, mobile: 0, hours: settings.autoMoveHours };
    const tree = await callBookmarks('getTree');
    const root = Array.isArray(tree) ? tree[0] : tree;
    const otherId = findApiFolderId(root, 'unfiled');
    if (!otherId) {
        await writeAutoMoveSettings({ ...settings, autoMoveLastAt: Date.now() });
        return { toolbar: 0, mobile: 0, hours: settings.autoMoveHours };
    }
    let toolbar = 0;
    let mobile = 0;
    if (settings.autoMoveToolbarLinks) {
        const toolbarId = findApiFolderId(root, 'toolbar');
        if (toolbarId && toolbarId !== otherId) {
            const kids = await callBookmarks('getChildren', toolbarId);
            for (const child of kids || []) {
                if (!child || !child.id || child.id === otherId) continue;
                if (child.url) {
                    await callBookmarks('move', child.id, { parentId: otherId });
                    toolbar += 1;
                }
            }
        }
    }
    if (settings.autoMoveMobile) {
        const mobileId = findApiFolderId(root, 'mobile');
        if (mobileId && mobileId !== otherId) {
            const kids = await callBookmarks('getChildren', mobileId);
            for (const child of kids || []) {
                if (!child || !child.id || child.id === otherId || child.type === 'separator') continue;
                await callBookmarks('move', child.id, { parentId: otherId });
                mobile += 1;
            }
        }
    }
    await writeAutoMoveSettings({ ...settings, autoMoveLastAt: Date.now() });
    if (toolbar || mobile) notifyAutoMove({ toolbar, mobile, hours: settings.autoMoveHours });
    return { toolbar, mobile, hours: settings.autoMoveHours };
}

if (ext.alarms && ext.alarms.onAlarm) {
    ext.alarms.onAlarm.addListener(alarm => {
        if (!alarm || alarm.name !== AUTO_MOVE_ALARM) return;
        autoMoveChain = autoMoveChain.then(() => runAutoMoveToOther()).catch(console.error);
    });
}

// --- Weekly library tidy -------------------------------------------------------
// Settings live in storage.local.tidySettings as { enabled, weekday (0 = Sunday),
// hour (local 0-23) }, disabled by default. The editor writes the same key and messages
// `tidy-settings`; the background stores it and reschedules the `tidy-library` alarm.
// protectedFolders (folder guids/ids whose subtrees the empty-folder pass must leave
// alone) is written by the editor and only read here. lastTidy holds the last summary.
const TIDY_LIBRARY_ALARM = 'tidy-library';
const TIDY_LIBRARY_SETTINGS_KEY = 'tidySettings';
const TIDY_LIBRARY_PROTECTED_KEY = 'protectedFolders';
const TIDY_LIBRARY_LAST_KEY = 'lastTidy';
const TIDY_LIBRARY_NOTIFICATION = 'tidy-library-done';
const TIDY_LIBRARY_DEFAULTS = { enabled: false, weekday: 0, hour: 3 };
const TIDY_LIBRARY_WEEK_MINUTES = 7 * 24 * 60;

function tidyLibrarySettingsFrom(raw) {
    const s = raw || {};
    const weekday = Number(s.weekday);
    const hour = Number(s.hour);
    return {
        enabled: s.enabled === true || s.enabled === 'true' || s.enabled === 1 || s.enabled === '1',
        weekday: Number.isFinite(weekday) ? Math.max(0, Math.min(6, Math.round(weekday))) : TIDY_LIBRARY_DEFAULTS.weekday,
        hour: Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.round(hour))) : TIDY_LIBRARY_DEFAULTS.hour
    };
}

async function readTidyLibrarySettings() {
    let stored = {};
    try {
        const box = await callStorageGet(TIDY_LIBRARY_SETTINGS_KEY);
        stored = (box && box[TIDY_LIBRARY_SETTINGS_KEY]) || {};
    } catch (e) {
        stored = {};
    }
    return tidyLibrarySettingsFrom(stored);
}

// The editor writes a list of folder guids/ids that must be left alone, subtrees included.
// Anything else — a missing key, the wrong type, blanks — reads as no protection at all.
async function readProtectedFolderKeys() {
    let stored = {};
    try {
        const box = await callStorageGet(TIDY_LIBRARY_PROTECTED_KEY);
        stored = box || {};
    } catch (e) {
        stored = {};
    }
    const raw = stored[TIDY_LIBRARY_PROTECTED_KEY];
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
    const keys = new Set();
    list.forEach(value => {
        const key = String(value == null ? '' : value).trim();
        if (key) keys.add(key);
    });
    return keys;
}

// The next occurrence of the configured local weekday/hour, today's slot included while it
// is still ahead of us.
function nextTidyAlarmTime(settings, from) {
    const now = from == null ? new Date() : new Date(from);
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), settings.hour, 0, 0, 0);
    let days = (settings.weekday - when.getDay() + 7) % 7;
    if (!days && when.getTime() <= now.getTime()) days = 7;
    when.setDate(when.getDate() + days);
    return when;
}

async function scheduleTidyAlarm() {
    const settings = await readTidyLibrarySettings();
    if (!settings.enabled) {
        await callAlarmsClear(TIDY_LIBRARY_ALARM);
        return settings;
    }
    const when = nextTidyAlarmTime(settings, Date.now());
    await callAlarmsClear(TIDY_LIBRARY_ALARM);
    callAlarmsCreate(TIDY_LIBRARY_ALARM, { when: when.getTime(), periodInMinutes: TIDY_LIBRARY_WEEK_MINUTES });
    return settings;
}

let tidyLibraryChain = Promise.resolve();

if (ext.alarms && ext.alarms.onAlarm) {
    ext.alarms.onAlarm.addListener(alarm => {
        if (!alarm || alarm.name !== TIDY_LIBRARY_ALARM) return;
        tidyLibraryChain = tidyLibraryChain.then(() => runLibraryTidy()).catch(console.error);
    });
}

const TIDY_SENDABLE_URL_RE = /^(?:https?|ftp|file):/i;
// The browser's own structural folders: never removed even when they look empty. The guids
// cover toolbar/menu/unfiled/mobile/tags/root, '0' is Chrome's places root and '1'-'3' are
// its Bookmarks bar / Other bookmarks / Mobile bookmarks; the places root's own id is
// added per run, and every direct child of it is protected anyway.
const TIDY_SPECIAL_FOLDER_IDS = new Set(Object.keys(SPECIAL_FOLDER_GUIDS).concat(['0', '1', '2', '3']));

function tidySendableUrl(node) {
    const href = sendablePageHref(nodeUri(node));
    return Boolean(href) && TIDY_SENDABLE_URL_RE.test(href);
}

// isBookmarkFolderNode plus the empty Chrome folders getTree hands back without children.
function tidyFolderNode(node) {
    if (!node || node.type === 'separator' || nodeUri(node)) return false;
    return isBookmarkFolderNode(node) || node.id != null;
}

// Separators are not children the way a folder or a link is, so a folder holding only a
// separator counts as empty exactly like the editor's holdsOnlyEmptyFolders treats it.
function tidyFolderChildren(node) {
    return (node.children || []).filter(child => child && child.type !== 'separator');
}

function tidyFolderProtected(node, state) {
    const id = String(node.id == null ? '' : node.id);
    if (!id) return true;
    if (TIDY_SPECIAL_FOLDER_IDS.has(id)) return true;
    if (id === state.rootId) return true;
    // Everything directly under the places root is a root-level folder.
    return state.rootChildKeys.has(id);
}

// Post-order, so a child is always offered for removal before the folder holding it.
// protectedFolders covers a folder and its whole subtree; a root-level/special folder is
// only skipped itself, which keeps an ordinary empty folder inside Bookmarks Toolbar
// removable.
function collectTidyEmptyFolders(node, blocked, state, out) {
    if (!tidyFolderNode(node)) return;
    const id = String(node.id == null ? '' : node.id);
    const inProtected = blocked || Boolean(id && state.protectedKeys.has(id));
    const skipSelf = inProtected || !id || tidyFolderProtected(node, state);
    const kids = tidyFolderChildren(node);
    kids.forEach(child => collectTidyEmptyFolders(child, inProtected, state, out));
    if (!skipSelf && !kids.length) out.push(id);
}

function tidyLibraryMessage(summary) {
    let message = `Stripped trackers from ${formatCount(summary.stripped)} bookmark(s) and removed ${formatCount(summary.removed)} empty folder(s).`;
    if (summary.failed) message += ` ${formatCount(summary.failed)} change(s) failed — see the background console.`;
    return message;
}

// Same guarded notification pattern the web-undo prompt uses, with its own id and an
// 8-second auto-clear.
function notifyLibraryTidyFinished(summary) {
    if (!ext.notifications || typeof ext.notifications.create !== 'function') return;
    const iconUrl = ext.runtime && typeof ext.runtime.getURL === 'function' ? ext.runtime.getURL('icons/icon-96.png') : undefined;
    try {
        const ret = ext.notifications.create(TIDY_LIBRARY_NOTIFICATION, {
            type: 'basic',
            iconUrl,
            title: 'Library tidy finished',
            message: tidyLibraryMessage(summary)
        });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {
        console.error(err);
    }
    setTimeout(() => {
        try {
            const gone = ext.notifications.clear(TIDY_LIBRARY_NOTIFICATION);
            if (gone && typeof gone.catch === 'function') gone.catch(() => {});
        } catch (err) {}
    }, 8000);
}

// One weekly pass over the live library, through the bookmarks API only: strip tracking
// parameters from sendable links, then remove empty folders that are neither structural
// nor protected. Failures are counted, never fatal; a thrown error is logged.
//
// The scheduled-job list (below) runs the same pass as its `tidy` and `tracker-strip`
// kinds, so this takes an optional options bag whose every field defaults to the weekly
// tidy's own behaviour:
//   strip: false         skip the tracking-parameter pass
//   emptyFolders: false  skip the empty-folder pass  → the strip-only job kind
//   record: false        leave lastTidy as it is (a strip-only run is not a tidy run)
//   quiet: true          raise no notification (the job raises its own)
async function runLibraryTidy(options) {
    const opts = options || {};
    let stripped = 0;
    let removed = 0;
    let failed = 0;
    try {
        const protectedKeys = await readProtectedFolderKeys();
        const tree = await callBookmarks('getTree');
        const root = Array.isArray(tree) ? tree[0] : tree;
        const rootId = String(root && root.id != null ? root.id : 'root________');
        const state = {
            rootId,
            rootChildKeys: new Set(((root && root.children) || [])
                .map(child => String(child && child.id != null ? child.id : ''))
                .filter(Boolean)),
            protectedKeys
        };
        // 1. Tracking parameters.
        if (opts.strip !== false) {
            const tracked = [];
            walkBookmarkTree(root, node => {
                if (!node || node.id == null || !tidySendableUrl(node)) return;
                const uri = nodeUri(node);
                const clean = stripTrackingParams(uri);
                if (clean && clean !== uri) tracked.push({ id: node.id, url: clean });
            });
            for (const item of tracked) {
                try {
                    await callBookmarks('update', item.id, { url: item.url });
                    stripped += 1;
                } catch (err) {
                    failed += 1;
                    console.error(err);
                }
            }
        }
        // 2. Empty folders.
        if (opts.emptyFolders !== false) {
            const empties = [];
            collectTidyEmptyFolders(root, false, state, empties);
            for (const id of empties) {
                try {
                    await callBookmarks('remove', id);
                    removed += 1;
                } catch (err) {
                    failed += 1;
                    console.error(err);
                }
            }
        }
    } catch (err) {
        // A failed read or walk is one failure too; the summary must not read as "nothing to do".
        failed += 1;
        console.error(err);
    }
    const summary = { at: Date.now(), stripped, removed, failed };
    if (opts.record !== false) {
        try {
            await callStorageSet({ [TIDY_LIBRARY_LAST_KEY]: summary });
        } catch (err) {
            console.error(err);
        }
    }
    if (opts.quiet !== true) notifyLibraryTidyFinished(summary);
    if (stripped || removed) {
        invalidateLinkCache();
        scheduleActionTitleUpdate();
    }
    return summary;
}

// --- Scheduled jobs ------------------------------------------------------------
// storage.local.scheduledJobs is the list the editor owns and the background schedules:
//   [{ id, kind, enabled, cadence: { type: 'hourly'|'daily'|'weekly', weekday, hour },
//      lastRunAt?, lastResult? }]
// Kinds: 'tidy' (the tracker strip plus the empty-folder pass, i.e. runLibraryTidy),
// 'tracker-strip' (strip only), 'duplicate-report' (count duplicate URLs and duplicate
// folder names, no writes) and 'dead-link-sweep' (HEAD a capped sample, report the
// failures, never touch the library). One alarm per enabled job, named `job-<id>`, and
// one notification per job, `job-done-<id>`, cleared after eight seconds.
//
// The weekly tidy keeps its own tidySettings / `tidy-library` alarm pair. Mapping the two:
// while scheduledJobs is missing (or not a list) the old pair still drives the tidy exactly
// as before and no `job-<id>` alarm exists; once a scheduledJobs list exists that list owns
// the tidy cadence and the old `tidy-library` alarm is cleared, so the same pass can never
// run twice.
const SCHEDULED_JOBS_KEY = 'scheduledJobs';
const SCHEDULED_JOB_ALARM_PREFIX = 'job-';
const SCHEDULED_JOB_NOTIFICATION_PREFIX = 'job-done-';
const SCHEDULED_JOB_KINDS = ['tidy', 'tracker-strip', 'duplicate-report', 'dead-link-sweep'];
const SCHEDULED_JOB_CADENCES = ['hourly', 'daily', 'weekly'];
// Same slot the weekly tidy defaults to, so a job with an unreadable cadence behaves like
// the one scheduled job this file had before the list existed.
const SCHEDULED_JOB_DEFAULTS = { type: 'weekly', weekday: 0, hour: 3 };
const SCHEDULED_JOB_NOTIFICATION_MS = 8000;
const SCHEDULED_JOB_HOUR_MINUTES = 60;
const SCHEDULED_JOB_DAY_MINUTES = 24 * 60;
const SCHEDULED_JOB_WEEK_MINUTES = 7 * 24 * 60;
// An id becomes an alarm name and a notification id, so it has to be a plain slug.
const SCHEDULED_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEAD_LINK_SWEEP_CAP = 25;
const DEAD_LINK_SWEEP_TIMEOUT_MS = 5000;
const DEAD_LINK_SWEEP_BATCH = 5;
const DEAD_LINK_SWEEP_URL_RE = /^https?:/i;

// Same shape as tidyLibrarySettingsFrom: an unknown cadence falls back to the tidy slot and
// weekday/hour are rounded and clamped; an hourly cadence keeps them but ignores them.
function scheduledJobCadenceFrom(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const wanted = String(c.type == null ? '' : c.type).toLowerCase();
    const type = SCHEDULED_JOB_CADENCES.indexOf(wanted) >= 0 ? wanted : SCHEDULED_JOB_DEFAULTS.type;
    const weekday = Number(c.weekday);
    const hour = Number(c.hour);
    return {
        type,
        weekday: Number.isFinite(weekday) ? Math.max(0, Math.min(6, Math.round(weekday))) : SCHEDULED_JOB_DEFAULTS.weekday,
        hour: Number.isFinite(hour) ? Math.max(0, Math.min(23, Math.round(hour))) : SCHEDULED_JOB_DEFAULTS.hour
    };
}

// One entry, or null when it cannot be scheduled: unknown kind, unusable id, duplicate id.
function scheduledJobFrom(raw, usedIds) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind == null ? '' : raw.kind).toLowerCase();
    if (SCHEDULED_JOB_KINDS.indexOf(kind) < 0) return null;
    const id = String(raw.id == null ? '' : raw.id).trim();
    if (!SCHEDULED_JOB_ID_RE.test(id) || usedIds.has(id)) return null;
    usedIds.add(id);
    const job = {
        id,
        kind,
        // Strictly boolean: 'true', 1 and a missing flag all read as off.
        enabled: raw.enabled === true,
        cadence: scheduledJobCadenceFrom(raw.cadence)
    };
    const lastRunAt = Number(raw.lastRunAt);
    if (Number.isFinite(lastRunAt) && lastRunAt > 0) job.lastRunAt = lastRunAt;
    if (raw.lastResult && typeof raw.lastResult === 'object') {
        const at = Number(raw.lastResult.at);
        job.lastResult = {
            at: Number.isFinite(at) ? at : 0,
            summary: String(raw.lastResult.summary == null ? '' : raw.lastResult.summary),
            failed: Number(raw.lastResult.failed) || 0
        };
    }
    return job;
}

// A missing, empty or malformed list reads as the one disabled tidy job, so a bad payload
// can never schedule work the editor did not ask for. The caller decides legacy behaviour
// from whether the stored value was a list at all.
function scheduledJobsFrom(raw) {
    const usedIds = new Set();
    const jobs = (Array.isArray(raw) ? raw : []).map(entry => scheduledJobFrom(entry, usedIds)).filter(Boolean);
    if (jobs.length) return jobs;
    return [{ id: 'tidy', kind: 'tidy', enabled: false, cadence: scheduledJobCadenceFrom(TIDY_LIBRARY_DEFAULTS) }];
}

async function readScheduledJobs() {
    let raw;
    try {
        const box = await callStorageGet(SCHEDULED_JOBS_KEY);
        raw = box && box[SCHEDULED_JOBS_KEY];
    } catch (err) {
        raw = undefined;
    }
    return { legacy: !Array.isArray(raw), jobs: scheduledJobsFrom(raw) };
}

function scheduledJobAlarmName(id) {
    return `${SCHEDULED_JOB_ALARM_PREFIX}${id}`;
}

function scheduledJobNotificationId(id) {
    return `${SCHEDULED_JOB_NOTIFICATION_PREFIX}${id}`;
}

// Next fire time, always carried as `when` with the repeating period beside it so every
// cadence reads the same in the alarm list: the next whole hour, the next local `hour`
// slot today or tomorrow, or the next local weekday+hour slot (nextTidyAlarmTime).
function nextDailyAlarmTime(cadence, from) {
    const now = new Date(from);
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cadence.hour, 0, 0, 0);
    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
    return when.getTime();
}

function scheduledJobAlarmInfo(cadence, from) {
    const c = scheduledJobCadenceFrom(cadence);
    const now = from == null ? Date.now() : from;
    if (c.type === 'hourly') {
        const when = new Date(now);
        when.setMinutes(0, 0, 0);
        if (when.getTime() <= now) when.setHours(when.getHours() + 1);
        return { when: when.getTime(), periodInMinutes: SCHEDULED_JOB_HOUR_MINUTES };
    }
    if (c.type === 'daily') {
        return { when: nextDailyAlarmTime(c, now), periodInMinutes: SCHEDULED_JOB_DAY_MINUTES };
    }
    return { when: nextTidyAlarmTime(c, now).getTime(), periodInMinutes: SCHEDULED_JOB_WEEK_MINUTES };
}

// alarms.getAll, guarded like the rest: a build without it still works from the names this
// session created, it just cannot clear a stale alarm from an earlier session.
function callAlarmsGetAll() {
    const api = ext.alarms;
    if (!api || typeof api.getAll !== 'function') return Promise.resolve([]);
    if (typeof browser !== 'undefined' && browser.alarms && typeof browser.alarms.getAll === 'function') {
        return Promise.resolve(browser.alarms.getAll()).then(list => (Array.isArray(list) ? list : [])).catch(() => []);
    }
    return new Promise(resolve => {
        try {
            api.getAll(list => resolve(Array.isArray(list) ? list : []));
        } catch (err) {
            resolve([]);
        }
    });
}

let scheduledJobAlarmNames = new Set();

// Every `job-<id>` alarm is ours; anything this pass no longer wants is cleared, including
// a name left behind by an earlier session (alarms.getAll) or before a reload.
async function clearScheduledJobAlarms(wanted) {
    const names = new Set(scheduledJobAlarmNames);
    const existing = await callAlarmsGetAll();
    existing.forEach(alarm => {
        const name = alarm && alarm.name;
        if (typeof name === 'string' && name.indexOf(SCHEDULED_JOB_ALARM_PREFIX) === 0) names.add(name);
    });
    for (const name of names) {
        if (!wanted.has(name)) await callAlarmsClear(name);
    }
    scheduledJobAlarmNames = new Set(wanted);
}

// One alarm per enabled job; run on startup and after every `job-settings` message.
async function scheduleScheduledJobAlarms() {
    const state = await readScheduledJobs();
    const enabled = state.jobs.filter(job => job.enabled);
    const wanted = new Set(enabled.map(job => scheduledJobAlarmName(job.id)));
    await clearScheduledJobAlarms(wanted);
    if (state.legacy) {
        // No list at all: tidySettings and the `tidy-library` alarm still own the tidy, and
        // no `job-<id>` alarm exists to run the same pass a second time.
        await scheduleTidyAlarm();
        return state;
    }
    // The list owns the tidy cadence now, so the old alarm must not stay behind.
    await callAlarmsClear(TIDY_LIBRARY_ALARM);
    const from = Date.now();
    enabled.forEach(job => callAlarmsCreate(scheduledJobAlarmName(job.id), scheduledJobAlarmInfo(job.cadence, from)));
    return state;
}

let scheduledJobChain = Promise.resolve();

if (ext.alarms && ext.alarms.onAlarm) {
    ext.alarms.onAlarm.addListener(alarm => {
        const name = alarm && alarm.name;
        if (typeof name !== 'string' || name.indexOf(SCHEDULED_JOB_ALARM_PREFIX) !== 0) return;
        const id = name.slice(SCHEDULED_JOB_ALARM_PREFIX.length);
        // One job at a time; the catch keeps a rejected job from stopping the next one.
        scheduledJobChain = scheduledJobChain.then(() => runScheduledJobById(id)).catch(console.error);
    });
}

async function runScheduledJobById(id) {
    const state = await readScheduledJobs();
    const job = state.jobs.find(entry => entry.id === id);
    // An alarm for a job the editor disabled or removed in the meantime does nothing.
    if (!job || !job.enabled) return null;
    return runScheduledJob(job);
}

function scheduledJobTitle(kind) {
    if (kind === 'tidy') return 'Library tidy finished';
    if (kind === 'tracker-strip') return 'Tracker strip finished';
    if (kind === 'duplicate-report') return 'Duplicate report ready';
    if (kind === 'dead-link-sweep') return 'Dead link sweep finished';
    return 'Scheduled job finished';
}

// The work behind each kind. Everything returns { summary, failed } so the run wrapper can
// store one lastResult shape whatever the job did.
async function executeScheduledJob(job) {
    if (job.kind === 'tidy') {
        const result = await runLibraryTidy({ quiet: true });
        return { summary: tidyLibraryMessage(result), failed: result.failed };
    }
    if (job.kind === 'tracker-strip') {
        // Strip only: no empty-folder pass and no lastTidy stamp, that stays the tidy's.
        const result = await runLibraryTidy({ emptyFolders: false, record: false, quiet: true });
        let summary = `Stripped trackers from ${formatCount(result.stripped)} bookmark(s).`;
        if (result.failed) summary += ` ${formatCount(result.failed)} change(s) failed — see the background console.`;
        return { summary, failed: result.failed };
    }
    if (job.kind === 'duplicate-report') return runScheduledDuplicateReport();
    if (job.kind === 'dead-link-sweep') return runScheduledDeadLinkSweep();
    throw new Error(`Unknown scheduled job kind: ${job.kind}`);
}

// Counts duplicate URLs (bookmarkUrlKey over the tracking-stripped URL, so a page saved
// with different tracking parameters still counts once) and duplicate folder names.
// Read-only: nothing is written to the library. `duplicateUrlKey` lives in dupe-cleanup.js,
// which is a page script and is not loaded in the background, so this uses the key the rest
// of the background already shares.
async function runScheduledDuplicateReport() {
    const links = await allUrlLinks();
    const urlCounts = new Map();
    (links || []).forEach(link => {
        const cleaned = stripTrackingParams(String((link && link.uri) || ''));
        const key = cleaned ? bookmarkUrlKey(cleaned) : '';
        if (!key) return;
        urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
    });
    let urlGroups = 0;
    let urlExtras = 0;
    urlCounts.forEach(count => {
        if (count > 1) {
            urlGroups += 1;
            urlExtras += count - 1;
        }
    });
    const tree = await callBookmarks('getTree');
    const root = Array.isArray(tree) ? tree[0] : tree;
    const nameCounts = new Map();
    walkBookmarkTree(root, node => {
        if (!node || !isBookmarkFolderNode(node)) return;
        // The browser's own root folders are not user duplicates.
        if (node.guid && SPECIAL_FOLDER_GUIDS[node.guid]) return;
        const name = String(node.title || '').trim().toLowerCase();
        if (!name) return;
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });
    let folderNames = 0;
    let folderExtras = 0;
    nameCounts.forEach(count => {
        if (count > 1) {
            folderNames += 1;
            folderExtras += count - 1;
        }
    });
    return {
        summary: `Found ${formatCount(urlGroups)} duplicate URL group(s) (${formatCount(urlExtras)} extra bookmark(s)) and ${formatCount(folderNames)} duplicate folder name(s) (${formatCount(folderExtras)} extra folder(s)). No changes written.`,
        failed: 0
    };
}

// An even spread across the library rather than the same first N links every run, capped at
// DEAD_LINK_SWEEP_CAP. Only http(s): about:, file: and extension URLs cannot be HEADed.
function scheduledJobLinkSample(links, cap) {
    const pool = (links || []).filter(link => link && DEAD_LINK_SWEEP_URL_RE.test(String(link.uri || '')));
    if (pool.length <= cap) return pool;
    const step = Math.ceil(pool.length / cap);
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < cap; i += step) sample.push(pool[i]);
    return sample;
}

// One HEAD with a short timeout. A server that refuses HEAD (405/501) is not a dead link;
// a network error, an abort or a non-ok status is.
async function scheduledJobCheckLink(href) {
    if (typeof fetch !== 'function') return { href, dead: false, status: 0 };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), DEAD_LINK_SWEEP_TIMEOUT_MS) : 0;
    try {
        const response = await fetch(href, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller ? controller.signal : undefined
        });
        const status = Number(response && response.status) || 0;
        if (status === 405 || status === 501) return { href, dead: false, status };
        return { href, dead: !(response && response.ok), status };
    } catch (err) {
        return { href, dead: true, status: 0 };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function runScheduledDeadLinkSweep() {
    const links = await allUrlLinks();
    const sample = scheduledJobLinkSample(links, DEAD_LINK_SWEEP_CAP);
    const failures = [];
    for (let i = 0; i < sample.length; i += DEAD_LINK_SWEEP_BATCH) {
        const batch = sample.slice(i, i + DEAD_LINK_SWEEP_BATCH);
        const results = await Promise.all(batch.map(link => scheduledJobCheckLink(link.uri)));
        results.forEach(result => {
            if (result.dead) failures.push(result.href);
        });
    }
    let summary = `Checked ${formatCount(sample.length)} link(s) with HEAD (${Math.round(DEAD_LINK_SWEEP_TIMEOUT_MS / 1000)}s timeout); ${formatCount(failures.length)} did not respond.`;
    if (failures.length) summary += ` First: ${failures.slice(0, 3).join(', ')}.`;
    return { summary, failed: failures.length };
}

// Same guarded notification pattern the tidy uses, with a per-job id and an 8-second clear.
function notifyScheduledJob(job, lastResult) {
    if (!ext.notifications || typeof ext.notifications.create !== 'function') return;
    const id = scheduledJobNotificationId(job.id);
    const iconUrl = ext.runtime && typeof ext.runtime.getURL === 'function' ? ext.runtime.getURL('icons/icon-96.png') : undefined;
    try {
        const ret = ext.notifications.create(id, {
            type: 'basic',
            iconUrl,
            title: scheduledJobTitle(job.kind),
            message: lastResult.summary
        });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (err) {
        console.error(err);
    }
    setTimeout(() => {
        try {
            const gone = ext.notifications.clear(id);
            if (gone && typeof gone.catch === 'function') gone.catch(() => {});
        } catch (err) {}
    }, SCHEDULED_JOB_NOTIFICATION_MS);
}

// lastRunAt / lastResult are stamped back on the stored entry the alarm belongs to. A legacy
// (non-list) value is left alone: no alarm could have fired for it.
async function storeScheduledJobResult(id, at, lastResult) {
    try {
        const box = await callStorageGet(SCHEDULED_JOBS_KEY);
        const raw = box && box[SCHEDULED_JOBS_KEY];
        if (!Array.isArray(raw)) return false;
        let touched = false;
        const next = raw.map(entry => {
            if (!entry || String(entry.id == null ? '' : entry.id) !== id) return entry;
            touched = true;
            return { ...entry, lastRunAt: at, lastResult };
        });
        if (!touched) return false;
        await callStorageSet({ [SCHEDULED_JOBS_KEY]: next });
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

// One run: never throws, so a failing job still records a lastResult and a notification and
// the next job in the chain starts from a fulfilled promise.
async function runScheduledJob(job) {
    const at = Date.now();
    let summary = '';
    let failed = 0;
    try {
        const outcome = await executeScheduledJob(job);
        summary = outcome.summary;
        failed = outcome.failed;
    } catch (err) {
        failed = 1;
        summary = `${scheduledJobTitle(job.kind)} failed: ${String((err && err.message) || err)}`;
        console.error(err);
    }
    const lastResult = { at, summary, failed };
    await storeScheduledJobResult(job.id, at, lastResult);
    notifyScheduledJob(job, lastResult);
    return lastResult;
}

function callWindows(method, ...args) {
    const api = ext.windows;
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('Windows API is not available.'));
    if (typeof browser !== 'undefined' && browser.windows && typeof browser.windows[method] === 'function') {
        return Promise.resolve(browser.windows[method](...args));
    }
    return new Promise((resolve, reject) => {
        api[method](...args, result => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve(result);
        });
    });
}

async function existingBookmarksForHref(href) {
    const key = bookmarkUrlKey(href);
    if (!key) return [];
    const links = await allUrlLinks();
    return links.filter(link => (link.urlKey || bookmarkUrlKey(link.uri)) === key);
}

async function openBookmarkExistsDialog(matches) {
    const items = (matches || []).map(link => ({
        id: link && link.id != null ? String(link.id) : '',
        title: String((link && link.title) || '').trim() || (link && link.uri) || 'Untitled',
        folderPath: (link && link.folderPath) || 'Unknown folder',
        uri: (link && link.uri) || ''
    }));
    if (!items.length) return;
    await callStorageSet({ bookmarkExists: { items, t: Date.now() } });
    const url = ext.runtime.getURL('bookmark-exists.html');
    const height = Math.min(560, 240 + items.length * 84);
    try {
        await callWindows('create', { url, type: 'popup', width: 480, height, focused: true });
    } catch (err) {
        await callTabs('create', { url });
    }
}

const BOOKMARK_ROOT_IDS = new Set(['root________', '0']);

function canNestBookmarkNode(node) {
    if (!node || node.id == null || BOOKMARK_ROOT_IDS.has(String(node.id))) return false;
    return node.parentId != null && !BOOKMARK_ROOT_IDS.has(String(node.parentId));
}

async function openNestEntriesDialog(ids) {
    const nodes = [];
    for (const id of ids || []) {
        const got = await callBookmarks('get', id);
        const node = Array.isArray(got) ? got[0] : got;
        if (canNestBookmarkNode(node)) nodes.push(node);
    }
    if (!nodes.length) return;
    const items = nodes.map(node => ({
        id: String(node.id),
        title: node.type === 'separator' ? 'Separator' : (String(node.title || '').trim() || nodeUri(node) || 'Untitled')
    }));
    let siblings = [];
    try { siblings = await callBookmarks('getChildren', nodes[0].parentId) || []; } catch (err) { siblings = []; }
    const defaultName = nextNewFolderName(siblings.filter(node => node.type === 'folder' || (!node.type && !node.url)).map(node => node.title));
    await callStorageSet({ nestEntries: { items, defaultName, t: Date.now() } });
    const url = ext.runtime.getURL('nest-entries.html');
    try {
        await callWindows('create', { url, type: 'popup', width: 420, height: 300, focused: true });
    } catch (err) {
        await callTabs('create', { url });
    }
}

async function nestBookmarkEntries(ids, title) {
    const name = String(title || '').trim();
    if (!name) throw new Error('Folder name cannot be empty.');
    const nodes = [];
    for (const id of ids || []) {
        const got = await callBookmarks('get', String(id));
        const node = Array.isArray(got) ? got[0] : got;
        if (canNestBookmarkNode(node)) nodes.push(node);
    }
    if (!nodes.length) throw new Error('Those entries can’t be nested.');
    const parentId = nodes[0].parentId;
    const siblings = nodes.filter(node => node.parentId === parentId).sort((a, b) => a.index - b.index);
    const others = nodes.filter(node => node.parentId !== parentId);
    // Where each entry was, so the whole nest can be put back.
    const placements = nodes.map(node => ({ id: node.id, parentId: node.parentId, index: node.index }));
    const folder = await callBookmarks('create', { parentId, index: siblings[0].index, title: name });
    const ordered = siblings.concat(others);
    for (let i = 0; i < ordered.length; i++) {
        await callBookmarks('move', ordered[i].id, { parentId: folder.id, index: i });
    }
    setPendingNestUndo(folder.id, name, placements);
    invalidateLinkCache();
    return folder;
}

function setPendingNestUndo(folderId, label, placements) {
    clearTimeout(pendingNestUndoTimer);
    pendingNestUndo = { folderId, label, placements };
    updateMenu(UNDO_NEST, { visible: true, title: `Undo nest: ${shortMenuLabel(label)}` }).catch(() => {});
    pendingNestUndoTimer = setTimeout(clearPendingNestUndo, WEB_UNDO_MS);
}

function clearPendingNestUndo() {
    clearTimeout(pendingNestUndoTimer);
    pendingNestUndo = null;
    updateMenu(UNDO_NEST, { visible: false }).catch(() => {});
}

// Moves every nested entry back where it came from, then removes the folder it was made in.
// The folder is only removable once its children are out, so a failed move leaves it alone.
async function undoNest() {
    const pending = pendingNestUndo;
    if (!pending) return;
    clearPendingNestUndo();
    const ordered = pending.placements.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const entry of ordered) {
        try {
            await callBookmarks('move', entry.id, { parentId: entry.parentId, index: entry.index });
        } catch (err) {
            console.error(err);
        }
    }
    try {
        await callBookmarks('remove', pending.folderId);
    } catch (err) {
        console.error(err);
    }
    resetMenuShown();
    invalidateLinkCache();
}

async function bookmarkWebHrefNow(url, title) {
    const href = sendablePageHref(urlForObsidian(url));
    if (!href) return;
    const existing = await existingBookmarksForHref(href);
    if (existing.length) {
        await openBookmarkExistsDialog(existing);
        return;
    }
    const parentId = await unfiledFolderId();
    await callBookmarks('create', {
        parentId,
        title: titleForObsidian(title, href),
        url: href
    });
    invalidateLinkCache();
}

function bookmarkWebHref(url, title) {
    const job = bookmarkWebChain.then(() => bookmarkWebHrefNow(url, title));
    bookmarkWebChain = job.catch(err => {
        console.error(err);
    });
    return job;
}

async function sendWebHref(url, title) {
    const href = sendablePageHref(urlForObsidian(url)) || url;
    if (!href) return;
    const matches = await existingBookmarksForHref(href);
    const bookmarkTitle = matches[0] && matches[0].title;
    const label = (isYouTubeWatchObsidianUrl(href) && bookmarkTitle) ? bookmarkTitle : ((title || '').trim() || bookmarkTitle || href);
    await backgroundSendMarkdown(mdLinkLine({ title: label, uri: href }, 0));
}

async function sendWebHrefAndDelete(url, title) {
    const href = sendablePageHref(urlForObsidian(url)) || url;
    if (!href) return;
    const matches = await existingBookmarksForHref(href);
    const bookmarkTitle = matches[0] && matches[0].title;
    const label = (isYouTubeWatchObsidianUrl(href) && bookmarkTitle) ? bookmarkTitle : ((title || '').trim() || bookmarkTitle || href);
    await backgroundSendMarkdown(mdLinkLine({ title: label, uri: href }, 0));
    await removeBookmarksWithUndo(matches.map(match => match && match.id), label);
}

const WEB_UNDO_MS = 5 * 60 * 1000;
// The editor's own row-menu nest is one withUndo step; this is its counterpart for the nest
// done from the browser's own bookmark menu, which works straight against the bookmarks API.
let pendingNestUndo = null;
let pendingNestUndoTimer = 0;
const WEB_UNDO_NOTIFICATION = 'web-undo';
let pendingWebUndo = null;
let pendingWebUndoTimer = 0;

async function removeBookmarksWithUndo(ids, label) {
    const items = [];
    for (const id of ids || []) {
        if (!id) continue;
        try {
            const nodes = await callBookmarks('get', id);
            const node = Array.isArray(nodes) ? nodes[0] : nodes;
            if (!node || !node.url) continue;
            await callBookmarks('remove', id);
            items.push({ parentId: node.parentId, index: node.index, title: node.title, url: node.url });
        } catch (err) {
            console.error(err);
        }
    }
    invalidateLinkCache();
    if (items.length) setPendingWebUndo(items, label);
}

function shortMenuLabel(text, max = 40) {
    const value = String(text || '').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function setPendingWebUndo(items, label) {
    clearTimeout(pendingWebUndoTimer);
    pendingWebUndo = { items, label };
    const count = items.length === 1 ? '1 bookmark' : `${items.length} bookmarks`;
    updateMenu(UNDO_WEB_DELETE, { visible: true, title: `Undo delete: ${shortMenuLabel(label)}` }).catch(() => {});
    if (ext.notifications && ext.notifications.create) {
        try {
            const ret = ext.notifications.create(WEB_UNDO_NOTIFICATION, {
                type: 'basic',
                iconUrl: ext.runtime.getURL('icons/icon-96.png'),
                title: `Deleted ${count}`,
                message: `${shortMenuLabel(label, 80)}\nClick to undo (5 min).`
            });
            if (ret && typeof ret.catch === 'function') ret.catch(() => {});
        } catch (err) {}
    }
    pendingWebUndoTimer = setTimeout(clearPendingWebUndo, WEB_UNDO_MS);
}

function clearPendingWebUndo() {
    clearTimeout(pendingWebUndoTimer);
    pendingWebUndo = null;
    updateMenu(UNDO_WEB_DELETE, { visible: false }).catch(() => {});
    if (ext.notifications && ext.notifications.clear) {
        try {
            const ret = ext.notifications.clear(WEB_UNDO_NOTIFICATION);
            if (ret && typeof ret.catch === 'function') ret.catch(() => {});
        } catch (err) {}
    }
}

async function undoWebDelete() {
    const pending = pendingWebUndo;
    if (!pending) return;
    clearPendingWebUndo();
    const items = pending.items.slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    for (const item of items) {
        try {
            await callBookmarks('create', { parentId: item.parentId, index: item.index, title: item.title, url: item.url });
        } catch (err) {
            try {
                await callBookmarks('create', { parentId: item.parentId, title: item.title, url: item.url });
            } catch (inner) {
                console.error(inner);
            }
        }
    }
    invalidateLinkCache();
}

if (ext.notifications && ext.notifications.onClicked) {
    ext.notifications.onClicked.addListener(id => {
        if (id === WEB_UNDO_NOTIFICATION) undoWebDelete().catch(console.error);
    });
}

function parseSelectionLine(line) {
    let rest = String(line || '');
    let depth = 0;
    let changed = true;
    while (changed) {
        changed = false;
        if (rest.charAt(0) === '\t') {
            depth += 1;
            rest = rest.slice(1);
            changed = true;
            continue;
        }
        const quote = rest.match(/^ {0,3}>( ?)?/);
        if (quote) {
            depth += 1;
            rest = rest.slice(quote[0].length);
            changed = true;
        }
    }
    return { depth, text: rest };
}

function parseSelectionLines(text) {
    const raw = String(text || '').replace(/^\s+|\s+$/g, '');
    if (!raw) return [];
    return raw.split(/\r?\n/).map(parseSelectionLine);
}

function selectionListMarkdown(lines, extraDepth) {
    const add = extraDepth || 0;
    return lines.map(line => `${mdIndent(line.depth + add)}- ${line.text}`).join('\n');
}


async function sendWebSelection(text) {
    const lines = parseSelectionLines(text);
    if (!lines.length) return;
    if (lines.length === 1) {
        const asUrl = hrefFromSelection(lines[0].text);
        if (asUrl) {
            await sendWebHref(asUrl, lines[0].text);
            return;
        }
    }
    const markdown = selectionListMarkdown(lines);
    if (!markdown) return;
    await backgroundSendMarkdown(markdown);
}

function selectionGoogleSearchMarkdown(text) {
    const lines = parseSelectionLines(text);
    const out = [];
    lines.forEach(line => {
        const query = String(line.text || '').replace(/^\s+|\s+$/g, '');
        if (!query) return;
        const href = googleSearchUrlForQuery(query);
        if (!href) return;
        out.push(mdLinkLine({ title: query, uri: href }, line.depth));
    });
    return out.join('\n');
}

async function sendWebGoogleSearch(text) {
    const markdown = selectionGoogleSearchMarkdown(text);
    if (!markdown) return;
    await backgroundSendMarkdown(markdown);
}

function selectionUnderPageMarkdown(text, pageUrl, pageTitle) {
    const lines = parseSelectionLines(text);
    if (!lines.length) return '';
    const href = sendablePageHref(urlForObsidian(pageUrl));
    const nested = selectionListMarkdown(lines, href ? 1 : 0);
    if (!href) return nested;
    const head = mdLinkLine({ title: (pageTitle || '').trim() || href, uri: href }, 0);
    return `${head}\n${nested}`;
}

async function sendWebSelectionUnderPage(text, pageUrl, pageTitle) {
    const markdown = selectionUnderPageMarkdown(text, pageUrl, pageTitle);
    if (!markdown) return;
    await backgroundSendMarkdown(markdown);
}

function linkUnderSelectionMarkdown(text, pageUrl, pageTitle) {
    const lines = parseSelectionLines(text);
    if (!lines.length) return '';
    const href = sendablePageHref(urlForObsidian(pageUrl));
    const head = selectionListMarkdown(lines);
    if (!href) return head;
    const lastDepth = lines[lines.length - 1].depth;
    const link = mdLinkLine({ title: (pageTitle || '').trim() || href, uri: href }, lastDepth + 1);
    return `${head}\n${link}`;
}

async function sendWebLinkUnderSelection(text, pageUrl, pageTitle) {
    const markdown = linkUnderSelectionMarkdown(text, pageUrl, pageTitle);
    if (!markdown) return;
    await backgroundSendMarkdown(markdown);
}

// Copies every highlighted tab (the tab itself when nothing else is selected) in one of the
// three formats the Open Tabs view offers. URLs are tracking-stripped with the shared
// stripTrackingParams rule (General repairs → Tracking-parameter stripper), and markdown
// goes through the same mdLinkLine the Obsidian sends use. The clipboard is the only
// feedback a background script can give; a failure says so out loud instead of staying quiet.
async function copyBrowserTabs(tab, format) {
    const targets = await highlightedTabsFor(tab);
    const list = targets.length ? targets : [await resolveClickedTab(tab)].filter(Boolean);
    const lines = list.map(item => {
        const url = tabTargetUrl(item);
        const title = String((item && item.title) || '').trim() || url;
        if (format === 'title') return title;
        // The clean link always wins: the tracking rule plus the same Google/YouTube
        // canonicalisation the sends use. Copy URL (original) keeps the untouched one.
        if (format === 'url') return cleanCopyUrl(url);
        if (format === 'urlOriginal') return url;
        // Markdown is for a note, so an about:/extension tab contributes nothing.
        if (!sendablePageHref(url)) return '';
        return mdLinkLine({ title, uri: cleanCopyUrl(url) }, 0);
    }).filter(line => line !== '');
    if (!lines.length) return;
    return copyTextWithFeedback(lines.join('\n'), format, list.length);
}

// Success is silent — the clipboard is the feedback — but a failure speaks up, because a
// copy that quietly did nothing is worse than a notification.
async function copyTextWithFeedback(text, label, count) {
    if (!text) return false;
    const ok = await copyTextToClipboard(text);
    if (ok) return true;
    console.error(`Could not copy ${label} for ${count} tab(s).`);
    if (ext.notifications && ext.notifications.create) {
        try {
            const ret = ext.notifications.create('copy-tab-failed', {
                type: 'basic',
                iconUrl: ext.runtime.getURL('icons/icon-96.png'),
                title: 'Could not copy to the clipboard',
                message: 'Select the tab and copy it by hand instead.'
            });
            if (ret && typeof ret.catch === 'function') ret.catch(() => {});
            setTimeout(() => {
                try {
                    const gone = ext.notifications.clear('copy-tab-failed');
                    if (gone && typeof gone.catch === 'function') gone.catch(() => {});
                } catch (err) {}
            }, 5000);
        } catch (err) {}
    }
    return false;
}

// Every tab of the right-clicked tab's window, in tab order, in one of the same three shapes.
async function copyBrowserWindow(tab, format) {
    const windowId = tab && tab.windowId;
    let found = [];
    try {
        found = await callTabs('query', windowId != null ? { windowId } : { currentWindow: true });
    } catch (err) {
        found = [];
    }
    const list = (Array.isArray(found) ? found : [])
        // Same rule as the window send: page tabs only, no about:/extension pages.
        .filter(item => sendablePageHref(tabTargetUrl(item)))
        .sort((a, b) => (a.index || 0) - (b.index || 0));
    const lines = list.map(item => {
        const url = tabTargetUrl(item);
        const title = String((item && item.title) || '').trim() || url;
        if (format === 'title') return title;
        if (format === 'url') return cleanCopyUrl(url);
        return mdLinkLine({ title, uri: cleanCopyUrl(url) }, 0);
    }).filter(line => line !== '');
    if (!lines.length) return;
    return copyTextWithFeedback(lines.join('\n'), `window ${format}`, list.length);
}

async function sendBrowserTab(tab, closeAfter, daily = false) {
    const targets = await highlightedTabsFor(tab);
    if (!targets.length) return;
    const markdown = targets.map(item => {
        const url = tabTargetUrl(item);
        return mdLinkLine({ title: (item && item.title) || url, uri: url }, 0);
    }).join('\n');
    await backgroundSendMarkdown(markdown, daily);
    if (!closeAfter) return;
    const ids = targets.map(item => item.id).filter(id => id != null);
    if (!ids.length) return;
    try {
        await callTabs('remove', ids);
    } catch (err) {
        for (const id of ids) {
            try { await callTabs('remove', id); } catch (inner) { console.error(inner); }
        }
    }
}

async function sendBrowserWindow(tab) {
    const query = tab && tab.windowId != null ? { windowId: tab.windowId } : { currentWindow: true };
    let tabs = [];
    try {
        const found = await callTabs('query', query);
        if (Array.isArray(found)) tabs = found;
    } catch (err) {
        console.error(err);
    }
    const targets = tabs
        .filter(item => sendablePageHref(tabTargetUrl(item)))
        .sort((a, b) => (a.index || 0) - (b.index || 0));
    if (!targets.length) return;
    const markdown = targets.map(item => {
        const url = urlForObsidian(tabTargetUrl(item));
        return mdLinkLine({ title: (item && item.title) || url, uri: url }, 0);
    }).join('\n');
    await backgroundSendMarkdown(markdown);
}

function openEditor() {
    ext.tabs.create({ url: ext.runtime.getURL('bookmark-editor-v1.0.html') });
}

function editorPageUrl(query) {
    const base = ext.runtime.getURL('bookmark-editor-v1.0.html');
    return query ? `${base}?${query}` : base;
}

function isEditorTabUrl(url) {
    const base = ext.runtime.getURL('bookmark-editor-v1.0.html');
    const href = String(url || '').split('#')[0];
    return href === base || href.startsWith(`${base}?`);
}

function sendRuntimeMessage(message) {
    if (!ext.runtime || typeof ext.runtime.sendMessage !== 'function') return Promise.resolve();
    try {
        const ret = ext.runtime.sendMessage(message);
        if (ret && typeof ret.then === 'function') return ret.catch(() => {});
    } catch (err) { /* Chrome callback form */ }
    return new Promise(resolve => {
        try {
            ext.runtime.sendMessage(message, () => {
                if (typeof chrome !== 'undefined' && chrome.runtime) void chrome.runtime.lastError;
                resolve();
            });
        } catch (err) {
            resolve();
        }
    });
}

async function showPageInLibrary(url) {
    const href = sendablePageHref(urlForObsidian(url)) || url;
    if (!href) return;
    const matches = await existingBookmarksForHref(href);
    if (matches[0] && matches[0].id) await openLibraryAtBookmark(matches[0].id);
}

async function openLibraryAtDomain(url) {
    const href = menuHrefFromInfo(url);
    if (!href) return;
    let tabs = [];
    try {
        const found = await callTabs('query', {});
        if (Array.isArray(found)) tabs = found;
    } catch (err) {
        tabs = [];
    }
    const match = tabs.find(item => isEditorTabUrl(item.url));
    if (match && match.id != null) {
        await sendRuntimeMessage({ type: 'library-domain', url: href });
        await callTabs('update', match.id, { active: true });
        if (match.windowId != null) {
            try { await callWindows('update', match.windowId, { focused: true }); } catch (err) { /* ignore */ }
        }
        return;
    }
    await callTabs('create', { url: editorPageUrl(`domain=${encodeURIComponent(href)}`) });
}

async function openLibraryAtBookmark(id) {
    const key = String(id || '');
    if (!key) return;
    await callStorageSet({ libraryReveal: { id: key, t: Date.now() } });
    let tabs = [];
    try {
        const found = await callTabs('query', {});
        if (Array.isArray(found)) tabs = found;
    } catch (err) {
        tabs = [];
    }
    const match = tabs.find(tab => isEditorTabUrl(tab.url));
    if (match && match.id != null) {
        await sendRuntimeMessage({ type: 'library-reveal', id: key });
        await callTabs('update', match.id, { active: true });
        if (match.windowId != null) {
            try { await callWindows('update', match.windowId, { focused: true }); } catch (err) { /* ignore */ }
        }
        return;
    }
    await callTabs('create', { url: editorPageUrl(`reveal=${encodeURIComponent(key)}`) });
}

function registerObsidianMenus() {
    // A one-line handshake so the extension console shows which background build is running.
    console.log('[bookmark editor] Obsidian tab menu build goal147 — registering, destination storage may still be empty');
    if (!menus) return;
    resetMenuShown();
    const common = { contexts: ['bookmark'] };
    // Firefox draws an item's own `icons` only for items inside a submenu — which these are,
    // since the extension creates many and Firefox groups them under its name. The group's
    // parent entry takes the manifest `icons`. Chrome has no `icons` on menu items at all,
    // and there the icon is never drawn, so only Firefox gets the property.
    const menuIcons = typeof browser !== 'undefined'
        ? { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
        : null;
    // One explicit parent submenu. Firefox labels the group the extension's items land in
    // with the manifest name and draws the manifest `icons` on it; creating it ourselves
    // keeps that label and icon stable and guarantees the items really are inside a
    // submenu, which is the only place Firefox draws per-item icons.
    // MDN: `icons` can only be set on items inside a submenu and on menu commands — the
    // top-level entry always takes the extension's manifest `icons`. Passing it here is a
    // no-op in current Firefox and honoured by some builds, so the manifest is what must
    // carry the parent icon; the comment stays so nobody looks for the icon in this spec.
    let menuRoot = '';
    const menuRootSpec = { id: MENU_ROOT_ID, title: MENU_ROOT_TITLE, contexts: MENU_ROOT_CONTEXTS };
    try {
        menus.create(menuIcons ? { ...menuRootSpec, icons: menuIcons } : menuRootSpec);
        menuRoot = MENU_ROOT_ID;
    } catch (err) {
        console.error(err);
        if (menuIcons) {
            // Keep the submenu even where an icon on it is not taken; without the parent the
            // items fall back to the top level, which is what this extension used before.
            try {
                menus.create(menuRootSpec);
                menuRoot = MENU_ROOT_ID;
            } catch (inner) {
                console.error(inner);
                menuRoot = '';
            }
        }
    }
    const add = spec => {
        // An explicit parentId (a nested Copy submenu) wins; everything else hangs off the root.
        const parent = spec.parentId || menuRoot;
        const placed = parent ? { ...spec, parentId: parent } : spec;
        try {
            menus.create(menuIcons ? { ...placed, icons: menuIcons } : placed);
        } catch (err) {
            if (!menuIcons) {
                console.error(err);
                return;
            }
            // Never lose the item itself over an icon the browser will not take.
            try {
                menus.create(placed);
            } catch (inner) {
                console.error(inner);
            }
        }
    };
    add({ ...common, id: SHOW_IN_LIBRARY, title: 'Show in Library', visible: true });
    add({ ...common, id: OBSIDIAN_LINK, title: 'Send to Obsidian', visible: true });
    add({ ...common, id: OBSIDIAN_FOLDER, title: 'Send folder to Obsidian', visible: true });
    add({
        ...common,
        id: OBSIDIAN_SEARCH_CHAIN,
        title: 'Send Search chain to Obsidian and delete',
        visible: false
    });
    add({ ...common, id: NEST_ENTRY, title: 'Nest in new folder…', visible: true });
    add({ ...common, id: UNDO_NEST, title: 'Undo nest', visible: false });
    add({ id: OBSIDIAN_TAB, title: 'Send to Obsidian', contexts: ['tab'] });
    add({ id: OBSIDIAN_TAB_CLOSE, title: 'Send to Obsidian and close tab', contexts: ['tab'] });
    add({ id: OBSIDIAN_WINDOW, title: 'Send window to Obsidian', contexts: ['tab'] });
    // Correct by construction: if the destination is not known yet, offer them; the first storage
    // read hides them again in cursor mode, and a refused menus.update no longer loses them.
    const dailyVisible = lastObsidianMenuDestination ? obsidianWantsDailySend() : true;
    add({ id: OBSIDIAN_TAB_DAILY, title: 'Send to Obsidian (Daily note)', contexts: ['tab'], visible: dailyVisible });
    add({ id: OBSIDIAN_TAB_DAILY_CLOSE, title: 'Send to Obsidian (Daily note) and close tab', contexts: ['tab'], visible: dailyVisible });
    // Highlighted tabs, exactly like the tab send above, so a multi-select copies as a list.
    const nestedCopy = typeof browser !== 'undefined' && Boolean(menuRoot);
    let copyParent = '';
    if (nestedCopy) {
        // This one is an item inside a submenu, so Firefox does draw its icon; the retry
        // keeps the submenu even where the property is refused.
        const copySpec = { id: COPY_TAB_MENU, parentId: menuRoot, title: 'Copy', contexts: ['tab'] };
        try {
            menus.create(menuIcons ? { ...copySpec, icons: menuIcons } : copySpec);
            copyParent = COPY_TAB_MENU;
        } catch (err) {
            if (menuIcons) {
                try {
                    menus.create(copySpec);
                    copyParent = COPY_TAB_MENU;
                } catch (inner) {
                    console.error(inner);
                    copyParent = '';
                }
            } else {
                console.error(err);
                copyParent = '';
            }
        }
    }
    const addCopy = spec => add({ ...spec, contexts: ['tab'], ...(copyParent ? { parentId: copyParent } : {}) });
    addCopy({ id: COPY_TAB_TITLE, title: 'Copy title' });
    addCopy({ id: COPY_TAB_URL, title: 'Copy URL' });
    addCopy({ id: COPY_TAB_MARKDOWN, title: 'Copy as Markdown' });
    // Shown from onShown only while the right-clicked tab URL really carries trackers.
    addCopy({ id: COPY_TAB_URL_ORIGINAL, title: 'Copy URL (original)', visible: !canRefreshMenus });
    let windowCopyParent = '';
    if (nestedCopy) {
        const windowSpec = { id: COPY_WINDOW_MENU, parentId: menuRoot, title: 'Copy window', contexts: ['tab'] };
        try {
            menus.create(menuIcons ? { ...windowSpec, icons: menuIcons } : windowSpec);
            windowCopyParent = COPY_WINDOW_MENU;
        } catch (err) {
            console.error(err);
            windowCopyParent = '';
        }
    }
    const addWindowCopy = spec => add({ ...spec, contexts: ['tab'], ...(windowCopyParent ? { parentId: windowCopyParent } : {}) });
    addWindowCopy({ id: COPY_WINDOW_TITLES, title: 'Copy window titles' });
    addWindowCopy({ id: COPY_WINDOW_URLS, title: 'Copy window URLs' });
    addWindowCopy({ id: COPY_WINDOW_MARKDOWN, title: 'Copy window as Markdown' });
    add({
        id: SHOW_PAGE_IN_LIBRARY,
        title: 'Show in Library',
        contexts: ['tab'].concat(PAGE_MENU_CONTEXTS),
        visible: !canRefreshMenus
    });
    add({
        id: FIND_DOMAIN,
        title: 'Find domain in By domain',
        contexts: ['tab'].concat(PAGE_MENU_CONTEXTS),
        visible: !canRefreshMenus
    });
    add({ id: BOOKMARK_WEB_LINK, title: 'Bookmark link', contexts: ['link'] });
    add({ id: OBSIDIAN_WEB_LINK, title: 'Send link to Obsidian', contexts: ['link'] });
    add({
        id: OBSIDIAN_WEB_LINK_DELETE,
        title: 'Send link to Obsidian and delete bookmark',
        contexts: ['link'],
        visible: !canRefreshMenus
    });
    add({ id: OBSIDIAN_WEB_PAGE, title: 'Send page to Obsidian', contexts: PAGE_MENU_CONTEXTS });
    add({
        id: OBSIDIAN_WEB_PAGE_DELETE,
        title: 'Send page to Obsidian and delete bookmark',
        contexts: PAGE_MENU_CONTEXTS,
        visible: !canRefreshMenus
    });
    add({ id: OBSIDIAN_WEB_SELECTION, title: 'Send text to Obsidian', contexts: ['selection'] });
    add({
        id: OBSIDIAN_WEB_SELECTION_DELETE,
        title: 'Send link to Obsidian and delete bookmark',
        contexts: ['selection'],
        visible: !canRefreshMenus
    });
    add({ id: OBSIDIAN_WEB_GOOGLE_SEARCH, title: 'Send as Google search to Obsidian', contexts: ['selection'] });
    add({
        id: OBSIDIAN_WEB_REDDIT_TEXT,
        title: 'Send Reddit text to Obsidian',
        contexts: ['selection'],
        documentUrlPatterns: REDDIT_MENU_URLS
    });
    add({ id: OBSIDIAN_WEB_SELECTION_UNDER, title: 'Send text under page link', contexts: ['selection'] });
    add({ id: OBSIDIAN_WEB_LINK_UNDER_TEXT, title: 'Send page link under text', contexts: ['selection'] });
    add({ id: 'open-library-tab', title: 'Open in tab', contexts: ['browser_action'] });
    add({
        id: UNDO_WEB_DELETE,
        title: 'Undo delete',
        contexts: ['page', 'link', 'selection', 'tab', 'bookmark', 'browser_action'],
        visible: Boolean(pendingWebUndo)
    });
    // The items exist now, so this is the first moment the destination can be applied. The startup
    // call and its retries remain as a safety net for a late rebuild.
    applyObsidianMenuDestination();
}

function onInstalledOrStartup() {
    if (!menus) return;
    const reset = () => {
        const cleared = menus.removeAll ? callMenus('removeAll') : Promise.resolve();
        Promise.resolve(cleared).catch(() => {}).then(registerObsidianMenus);
    };
    reset();
    allUrlLinks().catch(() => {});
}

if (ext.runtime && ext.runtime.onInstalled) ext.runtime.onInstalled.addListener(onInstalledOrStartup);
if (ext.runtime && ext.runtime.onStartup) ext.runtime.onStartup.addListener(onInstalledOrStartup);
onInstalledOrStartup();

function updateMenu(id, patch) {
    return callMenus('update', id, patch);
}

// Set when anything the shown menu displays actually changes. Firefox rebuilds the
// extension's submenu on every menus.refresh(), and that rebuild is what drops the
// manifest icon from the submenu's own entry, so refreshing only on a real change is
// what keeps that icon on screen.
let menuStateDirty = false;

function updateMenuIf(id, patch, key, value) {
    if (menuShown[key] === value) return null;
    menuShown[key] = value;
    menuStateDirty = true;
    return updateMenu(id, patch);
}

function setDeleteMenuVisible(id, key, visible) {
    // Always push the update: a skipped update after a failed one leaves the item stuck hidden.
    if (menuShown[key] !== visible) menuStateDirty = true;
    menuShown[key] = visible;
    return Promise.resolve(updateMenu(id, { visible })).catch(() => {});
}

async function refreshMenus(jobs, instanceId, changed = true) {
    // Nothing on screen differs from the last build: skip the rebuild entirely.
    if (!changed) return;
    const pending = (jobs || []).filter(Boolean);
    if (!pending.length) return;
    await Promise.all(pending).catch(() => {});
    if (instanceId != null && instanceId !== lastMenuInstanceId) return;
    if (menus && menus.refresh) {
        try {
            await menus.refresh();
        } catch (err) {}
    }
}

function menuHrefFromInfo(raw) {
    if (!raw) return '';
    return sendablePageHref(urlForObsidian(raw)) || sendablePageHref(raw) || raw;
}

if (menus && menus.onShown) {
    menus.onShown.addListener(async (info, tab) => {
        const menuInstanceId = nextMenuInstanceId++;
        lastMenuInstanceId = menuInstanceId;
        menuStateDirty = false;
        const contexts = Array.isArray(info && info.contexts) ? info.contexts : [];
        if (contexts.indexOf('tab') !== -1 && tab && tab.id != null) {
            tabMenuTargetId = tab.id;
        }

        const jobs = [];
        const selLink = contexts.indexOf('selection') !== -1 ? hrefFromSelection(info.selectionText) : '';
        if (contexts.indexOf('selection') !== -1) {
            const title = selLink ? 'Send link to Obsidian' : 'Send text to Obsidian';
            jobs.push(updateMenuIf(OBSIDIAN_WEB_SELECTION, { title }, 'selectionTitle', title));
        }

        const hasLink = contexts.indexOf('link') !== -1 && Boolean(info && info.linkUrl);
        const isPageContext = contexts.some(c => PAGE_MENU_CONTEXTS.indexOf(c) !== -1) && !hasLink;
        const linkHref = hasLink ? menuHrefFromInfo(info.linkUrl) : '';
        const selHref = (!hasLink && selLink) ? menuHrefFromInfo(selLink) : '';
        const pageHref = isPageContext
            ? menuHrefFromInfo((info && (info.frameUrl || info.pageUrl)) || tabTargetUrl(tab))
            : '';

        const isTabContext = contexts.indexOf('tab') !== -1;
        // The untouched URL sits beside the clean one only while cleaning would change it.
        const wantOriginal = isTabContext && hasCleanableUrl(tabTargetUrl(tab));
        jobs.push(updateMenuIf(COPY_TAB_URL_ORIGINAL, { visible: wantOriginal }, 'copyOriginal', wantOriginal));
        const domainHref = isTabContext ? menuHrefFromInfo(tabTargetUrl(tab)) : pageHref;
        domainMenuHref = domainHref;
        const applyDeleteVisibility = (linkMatch, selMatch, pageMatch) => {
            jobs.push(setDeleteMenuVisible(FIND_DOMAIN, 'findDomain', domainBookmarkedButNotPage(domainHref)));
            const pageBookmarked = Boolean(domainHref) && Boolean(hrefIsBookmarkedSync(domainHref));
            jobs.push(setDeleteMenuVisible(SHOW_PAGE_IN_LIBRARY, 'pageShow', pageBookmarked));
            if (hasLink && linkHref) {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_LINK_DELETE, 'webLinkDelete', Boolean(linkMatch)));
            } else {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_LINK_DELETE, 'webLinkDelete', false));
            }
            if (!hasLink && selHref) {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_SELECTION_DELETE, 'webSelectionDelete', Boolean(selMatch)));
            } else {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_SELECTION_DELETE, 'webSelectionDelete', false));
            }
            if (isPageContext && pageHref) {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_PAGE_DELETE, 'webPageDelete', Boolean(pageMatch)));
            } else {
                jobs.push(setDeleteMenuVisible(OBSIDIAN_WEB_PAGE_DELETE, 'webPageDelete', false));
            }
        };

        if (linkCache.keys) {
            applyDeleteVisibility(
                linkHref ? hrefIsBookmarkedSync(linkHref) : false,
                selHref ? hrefIsBookmarkedSync(selHref) : false,
                pageHref ? hrefIsBookmarkedSync(pageHref) : false
            );
        } else {
            try {
                await allUrlLinks();
            } catch (err) {
                console.error(err);
            }
            if (menuInstanceId !== lastMenuInstanceId) return;
            applyDeleteVisibility(
                linkHref ? hrefIsBookmarkedSync(linkHref) : false,
                selHref ? hrefIsBookmarkedSync(selHref) : false,
                pageHref ? hrefIsBookmarkedSync(pageHref) : false
            );
        }

        if (info && info.bookmarkId) {
            try {
                const nodes = await callBookmarks('get', info.bookmarkId);
                if (menuInstanceId !== lastMenuInstanceId) return;
                const node = Array.isArray(nodes) ? nodes[0] : nodes;
                const folder = isBookmarkFolderNode(node);
                const separator = Boolean(node && node.type === 'separator');
                let inChain = false;
                if (!folder && node && nodeUri(node)) {
                    const links = await allUrlLinks();
                    if (menuInstanceId !== lastMenuInstanceId) return;
                    inChain = Boolean(findSearchChainForId(links, info.bookmarkId));
                }
                const nestable = canNestBookmarkNode(node);
                jobs.push(
                    updateMenuIf(NEST_ENTRY, { visible: nestable }, 'bookmarkNest', nestable),
                    updateMenuIf(SHOW_IN_LIBRARY, { visible: !separator }, 'bookmarkShow', !separator),
                    updateMenuIf(OBSIDIAN_LINK, { visible: !folder }, 'bookmarkLink', !folder),
                    updateMenuIf(OBSIDIAN_FOLDER, { visible: folder }, 'bookmarkFolder', folder),
                    updateMenuIf(OBSIDIAN_SEARCH_CHAIN, { visible: !folder && inChain }, 'bookmarkChain', !folder && inChain)
                );
            } catch (err) {
                console.error(err);
            }
        }

        if (menuInstanceId !== lastMenuInstanceId) return;
        return refreshMenus(jobs, menuInstanceId, menuStateDirty);
    });
}

if (menus && menus.onHidden) {
    menus.onHidden.addListener(() => {
        lastMenuInstanceId = 0;
    });
}

// Which send the native tab menu offers follows the destination setting, which the app mirrors into
// extension storage. Both = all four items; daily = only the daily pair; cursor = only the cursor pair.
let lastObsidianMenuDestination = '';
let lastObsidianInsert = 'after';
let lastObsidianFallback = 'notice';

// What the background's own sends should do, given it cannot read the page's settings.
function obsidianWantsDailySend() {
    return lastObsidianMenuDestination === 'daily' || lastObsidianMenuDestination === 'both';
}

// The background's sends go through the shared appender, told which destination to use. Before the
// first storage read it appends, which is what these sends did before the cursor mode existed.
function backgroundSendMarkdown(markdown) {
    const daily = lastObsidianMenuDestination ? obsidianWantsDailySend() : true;
    try {
        capturePrefs.obsidianInsert = lastObsidianInsert;
        capturePrefs.obsidianFallback = lastObsidianFallback;
    } catch (err) { /* the shared prefs object may not be ready */ }
    return openObsidianAppend(markdown, daily);
}
function applyObsidianMenuDestination() {
    try {
        const store = (typeof browser !== 'undefined' ? browser : chrome).storage.local;
        const apply = (res) => {
            const data = res || {};
            const dest = String(data.obsidianDestination || 'cursor').toLowerCase();
            const both = dest === 'both';
            const daily = dest === 'daily';
            lastObsidianMenuDestination = daily || both ? dest : 'cursor';
            lastObsidianInsert = String(data.obsidianInsert || '').toLowerCase() === 'under' ? 'under' : 'after';
            lastObsidianFallback = String(data.obsidianFallback || '').toLowerCase() === 'daily' ? 'daily' : 'notice';
            try {
                if (typeof capturePrefs === 'object' && capturePrefs) {
                    capturePrefs.obsidianInsert = lastObsidianInsert;
                    capturePrefs.obsidianFallback = lastObsidianFallback;
                }
            } catch (err) { /* shared prefs unavailable */ }
            const show = (id, visible) => {
                // Firefox returns a promise here; a bare try/catch would let the rejection escape.
                try {
                    const result = menus.update(id, { visible });
                    if (result && typeof result.catch === 'function') result.catch(() => {});
                } catch (err) { /* older API */ }
            };
            show(OBSIDIAN_TAB, !daily);
            show(OBSIDIAN_TAB_CLOSE, !daily);
            show(OBSIDIAN_TAB_DAILY, daily || both);
            show(OBSIDIAN_TAB_DAILY_CLOSE, daily || both);
            console.log('[bookmark editor] Obsidian menu build goal153 — destination:', dest, '| insert:', lastObsidianInsert, '| fallback:', lastObsidianFallback, '| daily items visible:', daily || both);
        };
        try {
            const maybe = store.get(['obsidianDestination', 'obsidianInsert', 'obsidianFallback']);
            if (maybe && typeof maybe.then === 'function') maybe.then(apply).catch(() => apply({}));
            else store.get(['obsidianDestination', 'obsidianInsert', 'obsidianFallback'], (res) => apply(res || {}));
        } catch (err) { apply({}); }
    } catch (err) { /* no storage: keep the created state */ }
}

// --- restored listener surface: context menus, runtime messages, toolbar icon ---
if (menus && menus.onClicked) {
    menus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === OBSIDIAN_TAB || info.menuItemId === OBSIDIAN_TAB_CLOSE) {
            sendBrowserTab(tab, info.menuItemId === OBSIDIAN_TAB_CLOSE).catch(console.error);
            return;
        }
        if (info.menuItemId === BOOKMARK_WEB_LINK) {
            bookmarkWebHref(info.linkUrl, info.linkText).catch(console.error);
            return;
        }
        if (info.menuItemId === OBSIDIAN_WEB_LINK) {
            sendWebHref(info.linkUrl, info.linkText).catch(console.error);
            return;
        }
        if (info.menuItemId === OBSIDIAN_WEB_PAGE) {
            sendWebHref(info.pageUrl || tabTargetUrl(tab), tab && tab.title).catch(console.error);
            return;
        }
        if (info.menuItemId === OBSIDIAN_WEB_SELECTION) {
            sendWebSelection(info.selectionText).catch(console.error);
            return;
        }
        if (info.menuItemId === OBSIDIAN_WEB_SELECTION_UNDER) {
            sendWebSelectionUnderPage(
                info.selectionText,
                info.pageUrl || tabTargetUrl(tab),
                tab && tab.title
            ).catch(console.error);
            return;
        }
        if (info.menuItemId === OBSIDIAN_WEB_LINK_UNDER_TEXT) {
            sendWebLinkUnderSelection(
                info.selectionText,
                info.pageUrl || tabTargetUrl(tab),
                tab && tab.title
            ).catch(console.error);
            return;
        }
        if (info.menuItemId === 'open-library-tab') {
            openEditor();
            return;
        }
        const id = info.bookmarkId;
        if (!id) return;
        if (info.menuItemId === OBSIDIAN_LINK) sendBookmarkId(id, false).catch(console.error);
        if (info.menuItemId === OBSIDIAN_FOLDER) sendBookmarkId(id, true).catch(console.error);
        if (info.menuItemId === OBSIDIAN_SEARCH_CHAIN) sendSearchChainAndDelete(id).catch(console.error);
    });
}

async function restoreObsidianReturnTab(tabId) {
    if (tabId == null) return;
    try {
        await callTabs('get', tabId);
        await callTabs('update', tabId, { active: true });
    } catch (err) { /* tab was closed (send-and-close) or is gone */ }
}

if (ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg) return;
        if (msg.type === 'open-library-at') {
            openLibraryAtBookmark(msg.id).then(() => {
                if (typeof sendResponse === 'function') sendResponse({ ok: true });
            }).catch(err => {
                console.error(err);
                if (typeof sendResponse === 'function') sendResponse({ ok: false });
            });
            return true;
        }
        if (msg.type === 'obsidian-handoff-done') {
            Promise.resolve(typeof restoreObsidianReturnTab === 'function' ? restoreObsidianReturnTab(msg.returnTabId) : null).then(() => {
                if (typeof sendResponse === 'function') sendResponse({ ok: true });
            }).catch(() => {
                if (typeof sendResponse === 'function') sendResponse({ ok: false });
            });
            return true;
        }
    });
}

if (ext.bookmarks) {
    ['onCreated', 'onRemoved', 'onChanged', 'onMoved'].forEach(eventName => {
        const ev = ext.bookmarks[eventName];
        if (ev && ev.addListener) ev.addListener(invalidateLinkCache);
    });
}

if (ext.browserAction && ext.browserAction.onClicked) {
    ext.browserAction.onClicked.addListener(openEditor);
} else if (ext.action && ext.action.onClicked) {
    ext.action.onClicked.addListener(openEditor);
}
