// Open Tabs — every browser window with its tabs; save windows under Other Bookmarks / Opened Tabs.
const OPENED_TABS_FOLDER = 'Opened Tabs';
let openTabsWindows = [];
let openTabsQuery = '';
let openTabsWatching = false;
let openTabsTimer = 0;
let openTabsHostId = null;
// Window ids whose tab list is collapsed to its header; survives every re-render.
let openTabsCollapsed = new Set();
// Layout to put back when a filter is cleared, since filtering expands everything.
let openTabsCollapsedBeforeFilter = null;
// One line per tab instead of title / URL / times stacked.
let openTabsCondensed = false;
// Show each search chain as a subgroup of its window instead of a flat tab list.
let openTabsChainGroups = false;
// tabId -> its search chain for the render on screen; filled by openTabsIndexChains.
let openTabsChainIndex = new Map();
let openTabsMenuWired = false;

function openTabsExt() {
    const ext = typeof getBrowserExt === 'function' ? getBrowserExt() : null;
    return ext && ext.windows && ext.tabs ? ext : null;
}

function openTabsCall(area, method, ...args) {
    const ext = openTabsExt();
    const api = ext && ext[area];
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error(`${area} API is not available.`));
    if (typeof browser !== 'undefined' && browser[area] && typeof browser[area][method] === 'function') {
        return Promise.resolve(browser[area][method](...args));
    }
    return new Promise((resolve, reject) => {
        api[method](...args, result => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve(result);
        });
    });
}

function isOpenTabsViewActive() {
    return Boolean(document.getElementById('tabs-view')?.classList.contains('active'));
}

// The Open Tabs tab carries its total in parentheses, like the Bookmarks tab does.
function paintOpenTabsTabCount(count) {
    const btn = document.querySelector('.tab-btn[data-view="tabs-view"]');
    if (!btn) return;
    if (count == null) {
        btn.textContent = 'Open Tabs';
        return;
    }
    const label = typeof formatCount === 'function' ? formatCount(count) : String(count);
    btn.textContent = `Open Tabs (${label})`;
    // "N tabs, M tracked": how many open tabs are already in the library.
    try {
        btn.title = openTabsCountText();
    } catch (err) {
        btn.title = `${label} tab(s) open`;
    }
}

// Reads the windows without rendering, so the tab label stays current while this view is closed.
// The tabs view's Refresh: re-read the browser's windows and tabs, and pull the library again first.
// Which tabs are already bookmarked is decided from the library, so a stale tree makes the saved flags
// and the Show in library buttons wrong even though the tab list itself is fresh.
async function refreshOpenTabsWithLibrary() {
    try {
        if (typeof reloadLiveLibrary === 'function') await reloadLiveLibrary();
    } catch (err) { /* the JSON build has no live library to reload */ }
    return renderOpenTabs();
}

async function refreshOpenTabsCount() {
    if (!openTabsExt()) {
        paintOpenTabsTabCount(null);
        return;
    }
    try {
        const windows = await openTabsCall('windows', 'getAll', { populate: true, windowTypes: ['normal'] });
        paintOpenTabsTabCount((windows || []).reduce((sum, win) => sum + (win.tabs || []).length, 0));
    } catch (err) {
        // Leave the last known number in place.
    }
}

function watchOpenTabs() {
    const ext = openTabsExt();
    if (openTabsWatching || !ext) return;
    openTabsWatching = true;
    const refresh = () => {
        clearTimeout(openTabsTimer);
        openTabsTimer = setTimeout(() => {
            if (isOpenTabsViewActive()) renderOpenTabs();
            else refreshOpenTabsCount();
        }, 300);
    };
    ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached'].forEach(name => {
        if (ext.tabs[name]?.addListener) ext.tabs[name].addListener(refresh);
    });
    ['onCreated', 'onRemoved', 'onFocusChanged'].forEach(name => {
        if (ext.windows[name]?.addListener) ext.windows[name].addListener(refresh);
    });
}

function openTabsBookmarkIndex() {
    const index = new Map();
    if (!bookmarkData) return index;
    walkBookmarkTree(bookmarkData, node => {
        const uri = nodeUri(node);
        if (!uri) return;
        const key = bookmarkUrlKey(uri);
        if (key && !index.has(key)) index.set(key, node);
    });
    return index;
}

// Settings → Skip tabs that are already bookmarked when saving an Open Tabs window.
function openTabsSkipSavedEnabled() {
    if (typeof readEditorSettings !== 'function') return true;
    return readEditorSettings().skipBookmarkedOpenTabs !== false;
}

// Settings → Save each search chain into its own folder inside the window folder.
function openTabsChainFoldersEnabled() {
    if (typeof readEditorSettings !== 'function') return true;
    return readEditorSettings().openTabsChainFolders !== false;
}

// Folder name for a chain: the search query, flattened and kept path-readable.
function openTabsChainFolderName(query) {
    const name = String(query || '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim();
    return name ? name.slice(0, 80) : 'Search chain';
}

function openTabsIsSaved(index, tab) {
    if (!isBookmarkableTabUrl(tab.url)) return false;
    const key = bookmarkUrlKey(tab.url);
    return Boolean(key && index.has(key));
}

// --- Tab row context menu ---
// The tab this library page lives in: never offer to close it, and keep it out of bulk closes.
let openTabsLibraryTabId = null;
let openTabsMenuTarget = null;

function openTabsFindTab(tabId) {
    for (const win of openTabsWindows) {
        const tab = (win.tabs || []).find(item => item.id === tabId);
        if (tab) return { tab, win };
    }
    return null;
}

function openTabsIsLibraryTab(tab) {
    return tab && openTabsLibraryTabId != null && tab.id === openTabsLibraryTabId;
}

// Closable = not pinned and not the library page itself.
function openTabsClosable(tab) {
    return !tab.pinned && !openTabsIsLibraryTab(tab);
}

async function openTabsCurrentTabId() {
    try {
        const tab = await openTabsCall('tabs', 'getCurrent');
        return tab && tab.id != null ? tab.id : null;
    } catch (err) {
        return null;
    }
}

function openTabsTabIsMuted(tab) {
    return Boolean((tab.mutedInfo && tab.mutedInfo.muted) || tab.muted);
}

function openTabsMenuSetLabel(id, text) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = text;
        el.hidden = false;
    }
}

function wireOpenTabsMenu() {
    const body = document.getElementById('open-tabs-body');
    if (!body || openTabsMenuWired) return;
    openTabsMenuWired = true;
    body.addEventListener('contextmenu', event => {
        const row = event.target.closest('.open-tab');
        if (!row || !row.dataset.tabRow) return;
        showOpenTabsMenu(event, Number(row.dataset.tabRow));
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || typeof hidePopupMenus !== 'function') return;
        const ids = typeof POPUP_MENU_IDS !== 'undefined' ? POPUP_MENU_IDS : ['open-tabs-menu'];
        const open = ids.some(id => document.getElementById(id)?.style.display === 'block');
        if (open) hidePopupMenus();
    });
}

function showOpenTabsMenu(event, tabId) {
    const found = openTabsFindTab(tabId);
    if (!found) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof hidePopupMenus === 'function') hidePopupMenus();
    const menu = document.getElementById('open-tabs-menu');
    if (!menu) return;
    const { tab, win } = found;
    openTabsMenuTarget = { tabId: tab.id, windowId: win.id };
    const others = (win.tabs || []).filter(item => item.id !== tab.id && openTabsClosable(item)).length;
    const right = (win.tabs || []).filter(item => item.index > tab.index && openTabsClosable(item)).length;
    const owner = openTabsIsLibraryTab(tab);
    const bookmarkable = isBookmarkableTabUrl(tab.url);
    const saved = bookmarkable ? openTabsBookmarkIndex().get(bookmarkUrlKey(tab.url)) : null;
    const pinned = document.getElementById('open-tabs-menu-pin');
    if (pinned) pinned.textContent = tab.pinned ? 'Unpin tab' : 'Pin tab';
    const mute = document.getElementById('open-tabs-menu-mute');
    if (mute) mute.textContent = openTabsTabIsMuted(tab) ? 'Unmute tab' : 'Mute tab';
    const set = (id, show) => {
        const el = document.getElementById(id);
        if (el) el.hidden = !show;
    };
    const canBookmarkAgain = bookmarkable && (!saved || !openTabsSkipSavedEnabled());
    set('open-tabs-menu-bookmark', canBookmarkAgain);
    set('open-tabs-menu-bookmark-close', canBookmarkAgain);
    // Both ways, every time: setting only the "second copy" wording left it in place for the next,
    // unbookmarked tab. The plain wording is taken from the markup once and remembered.
    const bookmarkItem = document.getElementById('open-tabs-menu-bookmark');
    if (bookmarkItem) {
        if (!bookmarkItem.dataset.plainLabel) bookmarkItem.dataset.plainLabel = bookmarkItem.textContent;
        bookmarkItem.textContent = saved ? 'Bookmark a second copy of this tab' : bookmarkItem.dataset.plainLabel;
    }
    const bookmarkCloseItem = document.getElementById('open-tabs-menu-bookmark-close');
    if (bookmarkCloseItem) {
        if (!bookmarkCloseItem.dataset.plainLabel) bookmarkCloseItem.dataset.plainLabel = bookmarkCloseItem.textContent;
        bookmarkCloseItem.textContent = saved ? 'Bookmark a second copy and close this tab' : bookmarkCloseItem.dataset.plainLabel;
    }
    set('open-tabs-menu-reveal', Boolean(saved));
    // Single-tab Obsidian send: any tab with a page URL, bookmarked or not.
    const sendable = Boolean(openTabsSendableUrl(tab));
    set('open-tabs-menu-obsidian', sendable);
    set('open-tabs-menu-obsidian-close', sendable);
    // Search chain items: only for a tab that is part of a chain in this render.
    const chain = openTabsChainIndex.get(tab.id);
    set('open-tabs-menu-chain-send', Boolean(chain));
    set('open-tabs-menu-chain-send-close', Boolean(chain));
    set('open-tabs-menu-chain-bookmark', Boolean(chain));
    set('open-tabs-menu-chain-bookmark-close', Boolean(chain));
    // The original URL is offered only while stripping would actually change it.
    set('open-tabs-menu-copy-url-original', hasCleanableUrl(tab.url));
    if (chain) {
        const chainName = chain.query || 'search chain';
        const send = document.getElementById('open-tabs-menu-chain-send');
        if (send) send.textContent = `Send “${chainName}” chain to Obsidian`;
        const sendClose = document.getElementById('open-tabs-menu-chain-send-close');
        if (sendClose) sendClose.textContent = `Send “${chainName}” chain to Obsidian and close its ${formatCount(chain.count)} tab(s)`;
        const save = document.getElementById('open-tabs-menu-chain-bookmark');
        if (save) save.textContent = `Bookmark “${chainName}” chain (${formatCount(chain.count)} tab(s))`;
        const saveClose = document.getElementById('open-tabs-menu-chain-bookmark-close');
        if (saveClose) saveClose.textContent = `Bookmark “${chainName}” chain and close its ${formatCount(chain.count)} tab(s)`;
    }
    set('open-tabs-menu-save-sep', Boolean(saved) || (bookmarkable && !saved));
    set('open-tabs-menu-close', !owner);
    const othersItem = document.getElementById('open-tabs-menu-close-others');
    if (othersItem) {
        othersItem.hidden = !others;
        othersItem.textContent = `Close ${formatCount(others)} other tab(s)`;
    }
    const rightItem = document.getElementById('open-tabs-menu-close-right');
    if (rightItem) {
        rightItem.hidden = !right;
        rightItem.textContent = `Close ${formatCount(right)} tab(s) to the right`;
    }
    const openItem = document.getElementById('open-tabs-menu-open');
    if (openItem) openItem.hidden = Boolean(tab.active);
    if (typeof placePopupMenu === 'function') placePopupMenu(menu, event.clientX, event.clientY);
}

function openTabsMenuTab() {
    return openTabsMenuTarget ? openTabsFindTab(openTabsMenuTarget.tabId) : null;
}


// --- close duplicate tabs ---
// Same URL key the duplicate scan uses, so "the same page" means the same thing everywhere in
// the app. The first tab of each group stays; the rest go, with a confirm that names the count.
async function closeDuplicateOpenTabs() {
    const windows = openTabsWindows.filter(win => (win.tabs || []).length > 1);
    if (!windows.length) return alert('No open window has more than one tab.');
    const victims = [];
    windows.forEach(win => {
        const seen = new Set();
        win.tabs.forEach(tab => {
            const uri = String(tab.url || '');
            if (!uri || !openTabsSendableUrl(tab)) return;
            const key = typeof libraryUrlKey === 'function' ? libraryUrlKey(uri) : uri;
            if (seen.has(key)) victims.push({ tab, win });
            else seen.add(key);
        });
    });
    const closable = victims.filter(item => openTabsClosable(item.tab));
    if (!closable.length) return alert('No duplicate page tabs to close (pinned tabs and this library page stay).');
    const kept = victims.length - closable.length;
    if (!confirm(`Close ${formatCount(closable.length)} duplicate tab(s)? The first tab of each URL stays open${kept ? `, and ${formatCount(kept)} pinned or library duplicate(s) are kept` : ''}.`)) return;
    const ids = closable.map(item => item.tab.id);
    await openTabsCloseIds(ids, `${formatCount(ids.length)} duplicate tab(s)`);
    // Name what went, underneath the summary, so it is clear which copies were closed.
    const closedList = closable.map(item => `<div class="open-tabs-note-line">· ${escapeHtml(item.tab.title || item.tab.url || 'Untitled')} — ${escapeHtml(item.tab.url || '')}</div>`).join('');
    setOpenTabsNote(`Closed ${formatCount(ids.length)} duplicate tab(s); the first tab of each URL stayed open${kept ? `, and ${formatCount(kept)} pinned or library duplicate(s) were kept` : ''}.${closedList}`);
}

// --- the "N tabs, M tracked" note ---
function openTabsLibraryTrackedCount() {
    try {
        const index = openTabsBookmarkIndex();
        return openTabsWindows.reduce((sum, win) => sum + (win.tabs || []).filter(tab => {
            const uri = String(tab.url || '');
            return uri && index.has(bookmarkUrlKey(uri));
        }).length, 0);
    } catch (err) {
        return 0;
    }
}

function openTabsCountText() {
    const tabs = openTabsWindows.reduce((sum, win) => sum + (win.tabs || []).length, 0);
    const tracked = openTabsLibraryTrackedCount();
    return `${formatCount(tabs)} tab(s) open · ${formatCount(tracked)} already in the library`;
}


// --- containers and tab groups ---
// Firefox exposes cookieStoreId, Chrome exposes groupId. Both are best-effort: an unknown
// tab simply has no label.
function openTabsGroupLabel(tab) {
    if (!tab) return '';
    const container = String(tab.cookieStoreId || '');
    if (container && container !== 'firefox-default') {
        return `container ${container.replace(/^firefox-container-/, '')}`;
    }
    if (tab.groupId != null && tab.groupId >= 0 && openTabsTabGroupNames.size) {
        const name = openTabsTabGroupNames.get(tab.groupId);
        if (name) return `group ${name}`;
    }
    return '';
}

const openTabsTabGroupNames = new Map();

async function openTabsLoadGroupNames() {
    try {
        if (typeof browser === 'undefined' || !browser.tabGroups || !browser.tabGroups.query) return;
        const groups = await browser.tabGroups.query({});
        groups.forEach(group => openTabsTabGroupNames.set(group.id, group.title || `group ${group.id}`));
    } catch (err) {}
}

function openTabsGroupedCounts() {
    const counts = new Map();
    openTabsWindows.forEach(win => (win.tabs || []).forEach(tab => {
        const label = openTabsGroupLabel(tab);
        if (!label) return;
        counts.set(label, (counts.get(label) || 0) + 1);
    }));
    return counts;
}

// --- stash a window: save its tabs into a Stashed folder and close them ---
function findOrCreateFolderNode(title, parent) {
    const base = parent || bookmarkData;
    if (!base) return null;
    let folder = (base.children || []).find(child => isBookmarkFolderNode(child) && String(child.title || '').toLowerCase() === title.toLowerCase());
    if (folder) return folder;
    const created = { typeCode: 2, title, children: [], dateAdded: Date.now(), _modified: true };
    if (!base.children) base.children = [];
    base.children.push(created);
    if (typeof liveCreateNode === 'function') liveCreateNode(base, created, base.children.length - 1);
    return created;
}

async function stashOpenTabsWindow(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return alert('That window is gone.');
    const tabs = (win.tabs || []).filter(tab => openTabsSendableUrl(tab));
    if (!tabs.length) return alert('No page tabs in that window to stash.');
    if (!confirm(`Stash ${formatCount(tabs.length)} tab(s) from Window ${win.number} into a Stashed folder and close them?`)) return;
    const other = typeof findSpecialFolder === 'function' ? findSpecialFolder('unfiled_____') : null;
    let stashed = null;
    markChanged();
    withUndo('Stash tabs', api => {
        const parent = other || bookmarkData;
        stashed = (parent.children || []).find(child => isBookmarkFolderNode(child) && String(child.title || '').toLowerCase() === 'stashed');
        if (!stashed) {
            stashed = { typeCode: 2, title: 'Stashed', children: [], dateAdded: Date.now(), _modified: true };
            api.create(parent, stashed);
        }
        const label = openTabsGroupLabel(tabs[0]);
        const group = { typeCode: 2, title: `Window ${win.number}${label ? ` (${label})` : ''}`, children: [], dateAdded: Date.now(), _modified: true };
        api.create(stashed, group);
        tabs.forEach(tab => {
            const node = { typeCode: 1, title: tab.title || tab.url, uri: tab.url, dateAdded: Math.round(Date.now() / 1000), _modified: true };
            api.create(group, node);
        });
        logAffected('ADDED', `Window ${win.number}`, `Stashed ${formatCount(tabs.length)} tab(s) into “Stashed” under Other Bookmarks.`, { source: 'Open Tabs', kind: 'stash' });
    });
    renderSidebar();
    resetMenuShown();
    const ids = tabs.filter(tab => openTabsClosable(tab)).map(tab => tab.id);
    if (ids.length) await openTabsCloseIds(ids, `${formatCount(ids.length)} stashed tab(s)`);
    setOpenTabsNote(`Stashed ${formatCount(tabs.length)} tab(s) into “Stashed”${ids.length ? ` and closed ${formatCount(ids.length)}` : ''}. Undo brings the tree change back.`);
}

// --- close duplicates across every window, not just one ---
async function closeDuplicateTabsEverywhere() {
    const victims = [];
    const seen = new Set();
    openTabsWindows.forEach(win => (win.tabs || []).forEach(tab => {
        const uri = openTabsSendableUrl(tab);
        if (!uri) return;
        const key = typeof libraryUrlKey === 'function' ? libraryUrlKey(uri) : uri;
        if (seen.has(key)) victims.push(tab);
        else seen.add(key);
    }));
    const closable = victims.filter(tab => openTabsClosable(tab));
    if (!closable.length) return alert('No duplicate page tabs to close across the open windows.');
    const kept = victims.length - closable.length;
    if (!confirm(`Close ${formatCount(closable.length)} duplicate tab(s) across all windows? The first of each URL stays open${kept ? `, and ${formatCount(kept)} pinned or library duplicate(s) are kept` : ''}.`)) return;
    await openTabsCloseIds(closable.map(tab => tab.id), `${formatCount(closable.length)} duplicate tab(s) across windows`);
    setOpenTabsNote(`Closed ${formatCount(closable.length)} duplicate tab(s) across windows.`);
}

// --- Copy (title / URL / markdown) ---
// Markdown goes through mdLinkLine so a copied line is exactly what the Obsidian sends write.
function openTabsCopyText(tab, format) {
    const url = String((tab && tab.url) || '');
    const title = String((tab && tab.title) || '').trim() || url;
    if (format === 'title') return title;
    if (format === 'url') return cleanCopyUrl(url);
    if (format === 'urlOriginal') return url;
    if (format === 'markdown') {
        const sendable = openTabsSendableUrl(tab);
        if (!sendable) return '';
        // Cleaned before the line is built, so a pasted link is the clean one even when
        // “clean sent URLs” is switched off for the Obsidian sends.
        const clean = cleanCopyUrl(sendable);
        return typeof mdLinkLine === 'function'
            ? mdLinkLine({ title: tab.title || sendable, uri: clean }, 0)
            : `- [${title}](${clean})`;
    }
    return '';
}

function openTabsCopyReport(text, what) {
    if (!text) {
        setOpenTabsNote(`Nothing to copy: ${what} has no web or file URL.`);
        return Promise.resolve(false);
    }
    return copyTextToClipboard(text).then(ok => {
        const lines = text.split('\n').length;
        const size = `${formatCount(text.length)} character(s)${lines > 1 ? `, ${formatCount(lines)} line(s)` : ''}`;
        setOpenTabsNote(ok
            ? `Copied ${what} (${size}). It is on the clipboard, ready to paste.`
            : `Could not reach the clipboard for ${what}. Select the text and copy it by hand.`);
        return ok;
    });
}

function openTabsMenuCopy(format) {
    const found = openTabsMenuTab();
    if (!found) return;
    const { tab } = found;
    const text = openTabsCopyText(tab, format);
    const label = format === 'title' ? 'the tab title'
        : format === 'url' ? 'the tab URL'
            : format === 'urlOriginal' ? 'the original tab URL (tracking parameters kept)'
                : 'the tab as markdown';
    return openTabsCopyReport(text, label);
}

function openTabsWindowCopy(windowId, format) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const tabs = win.tabs.filter(tab => openTabsSendableUrl(tab));
    if (!tabs.length) return openTabsCopyReport('', `Window ${win.number}`);
    let text = '';
    if (format === 'title') {
        text = tabs.map(tab => String(tab.title || '').trim() || openTabsSendableUrl(tab)).join('\n');
    } else if (format === 'url') {
        text = tabs.map(tab => cleanCopyUrl(String(tab.url || ''))).join('\n');
    } else if (format === 'urlOriginal') {
        text = tabs.map(tab => String(tab.url || '')).join('\n');
    } else {
        text = tabs.map(tab => openTabsCopyText(tab, 'markdown')).filter(Boolean).join('\n');
    }
    const label = `Window ${win.number}’s ${format === 'title' ? 'tab titles' : format === 'url' ? 'tab URLs' : format === 'urlOriginal' ? 'original tab URLs' : 'tabs as markdown'}`;
    return openTabsCopyReport(text, label);
}

function openTabsMenuOpen() {
    const found = openTabsMenuTab();
    if (found) focusOpenTab(found.tab.id, found.win.id);
}

function openTabsTabAction(method, args, failure) {
    const found = openTabsMenuTab();
    if (!found) return;
    return openTabsCall('tabs', method, ...args(found.tab))
        .catch(err => alert(failure ? `${failure}: ${err.message}` : err.message))
        .then(() => renderOpenTabs());
}

function openTabsMenuReload() {
    return openTabsTabAction('reload', tab => [tab.id], 'Could not reload the tab');
}

function openTabsMenuDuplicate() {
    const found = openTabsMenuTab();
    if (!found) return;
    const { tab, win } = found;
    return openTabsCall('tabs', 'create', { url: tab.url, windowId: win.id, index: tab.index + 1, active: false })
        .catch(err => alert(`Could not duplicate the tab: ${err.message}`))
        .then(() => renderOpenTabs());
}

function openTabsMenuTogglePin() {
    return openTabsTabAction('update', tab => [tab.id, { pinned: !tab.pinned }], 'Could not change the pin');
}

function openTabsMenuToggleMute() {
    return openTabsTabAction('update', tab => [tab.id, { muted: !openTabsTabIsMuted(tab) }], 'Could not change the mute');
}

async function openTabsCloseIds(ids, label) {
    const closed = [];
    const failed = [];
    for (const id of ids) {
        try {
            await openTabsCall('tabs', 'remove', id);
            closed.push(id);
        } catch (err) {
            failed.push(err.message);
        }
    }
    if (closed.length) {
        logAffected('SYSTEM', label, `Closed ${formatCount(closed.length)} tab(s) from Open Tabs.`, { source: 'Open Tabs' });
    }
    renderOpenTabs();
    if (failed.length) alert(`Closed ${formatCount(closed.length)} tab(s), but ${formatCount(failed.length)} failed:\n${failed.join('\n')}`);
}

function openTabsMenuClose() {
    const found = openTabsMenuTab();
    if (!found || openTabsIsLibraryTab(found.tab)) return;
    return openTabsCloseIds([found.tab.id], found.tab.title || found.tab.url || 'Tab');
}

function openTabsMenuCloseOthers(mode) {
    const found = openTabsMenuTab();
    if (!found) return;
    const { tab, win } = found;
    const targets = (win.tabs || []).filter(item => item.id !== tab.id && (mode === 'right' ? item.index > tab.index : true) && openTabsClosable(item));
    if (!targets.length) return;
    const kept = (win.tabs || []).filter(item => !targets.includes(item)).length;
    const what = mode === 'right' ? `${formatCount(targets.length)} tab(s) to the right of` : `${formatCount(targets.length)} other tab(s) in`;
    if (!confirm(`Close ${what} Window ${win.number}?\n\n${kept} tab(s) stay open (pinned tabs and the Bookmark Library page are always kept). This is not undoable.`)) return;
    return openTabsCloseIds(targets.map(item => item.id), `Window ${win.number}`);
}

function openTabsMenuCloseRight() {
    return openTabsMenuCloseOthers('right');
}

// Bookmark just this tab, straight into Other Bookmarks / Opened Tabs.
// One tab into Other Bookmarks / Opened Tabs. Shared by the row menu and the hover menu
// on a row that is not bookmarked yet; `close` shuts that tab afterwards.
async function bookmarkOpenTab(tabId, close) {
    const found = openTabsFindTab(tabId);
    if (!found) return;
    const { tab, win } = found;
    if (!isBookmarkableTabUrl(tab.url)) return alert('This tab has no web or file URL to bookmark.');
    if (!bookmarkData) return alert('Library is not loaded.');
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('No Other Bookmarks folder was found.');
    if (openTabsSkipSavedEnabled() && openTabsIsSaved(openTabsBookmarkIndex(), tab)) {
        return alert('This tab is already bookmarked.');
    }
    const stamp = openTabsStamp();
    const now = Date.now();
    const dateAdded = typeof liveCreateNode === 'function' ? now : now * 1000;
    let parent = (other.children || []).find(child => isBookmarkFolderNode(child) && String(child.title || '').trim().toLowerCase() === OPENED_TABS_FOLDER.toLowerCase());
    let node = null;
    withUndo('Bookmark tab', api => {
        if (!parent) {
            parent = { typeCode: 2, title: OPENED_TABS_FOLDER, children: [], dateAdded, _modified: true };
            api.create(other, parent);
        }
        node = { typeCode: 1, title: tab.title || tab.url, uri: tab.url, dateAdded, _modified: true };
        api.create(parent, node);
    });
    markChanged();
    renderSidebar();
    renderOpenTabs();
    logAffected('ADDED', node.title, `Bookmarked the open tab “${node.title}”.`, {
        source: 'Open Tabs',
        node,
        uri: tab.url,
        folderPath: `${displayFolderTitle(other)} / ${OPENED_TABS_FOLDER}`
    });
    const where = `Bookmarked “${escapeHtml(node.title)}” into Other Bookmarks / ${escapeHtml(OPENED_TABS_FOLDER)} (${escapeHtml(stamp)}).`;
    if (!close) {
        setOpenTabsNote(where);
        return;
    }
    if (!openTabsClosable(tab)) {
        setOpenTabsNote(`${where} Kept open: it is pinned or this library page.`);
        return;
    }
    await openTabsCloseIds([tab.id], tab.title || tab.url || 'Tab');
    setOpenTabsNote(`${where} Closed Window ${win.number}’s tab.`);
}

function openTabsMenuBookmark() {
    if (openTabsMenuTarget) bookmarkOpenTab(openTabsMenuTarget.tabId, false);
}

function openTabsMenuBookmarkClose() {
    if (openTabsMenuTarget) bookmarkOpenTab(openTabsMenuTarget.tabId, true);
}

function openTabsMenuReveal() {
    const found = openTabsMenuTab();
    if (!found || typeof openTabsBookmarkIndex !== 'function') return;
    const saved = isBookmarkableTabUrl(found.tab.url) ? openTabsBookmarkIndex().get(bookmarkUrlKey(found.tab.url)) : null;
    if (saved && typeof revealBookmarkById === 'function') revealBookmarkById(saved.id);
}

// --- Send a tab to Obsidian ---
// Same rule the browser-tab menu uses (background sendablePageHref): anything but
// javascript:, extension pages, and about: pages can be sent.
function openTabsSendableUrl(tab) {
    const url = String((tab && (tab.url || tab.pendingUrl)) || '').trim();
    if (!url) return '';
    const lower = url.toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('moz-extension:')
        || lower.startsWith('chrome-extension:') || lower.startsWith('about:')) return '';
    return url;
}

// One tab as a single `- [title](url)` line, exactly like the browser tab menu sends it.
async function sendOpenTabToObsidian(tabId, close) {
    const found = openTabsFindTab(tabId);
    if (!found) return;
    const { tab } = found;
    const url = openTabsSendableUrl(tab);
    if (!url) return alert('This tab has no page URL to send.');
    if (typeof mdLinkLine !== 'function' || typeof openObsidianAppend !== 'function') return;
    const label = tab.title || url;
    const willClose = Boolean(close) && openTabsClosable(tab);
    await sendMarkdownByDestination(mdLinkLine({ title: label, uri: url }, 0));
    logAffected('SYSTEM', label, `Sent the open tab “${label}” to Obsidian${willClose ? ' and closed it' : ''}.`, {
        source: 'Open Tabs'
    });
    const said = `Sent “${escapeHtml(label)}” to Obsidian.`;
    if (!close) {
        setOpenTabsNote(`${said} The tab stays open.`);
        return;
    }
    if (!willClose) {
        setOpenTabsNote(`${said} Kept open: it is pinned or this library page.`);
        return;
    }
    await openTabsCloseIds([tab.id], label);
    setOpenTabsNote(`${said} Closed the tab.`);
}

// Every sendable tab of one window, in tab order, like the browser menu's Send window.
async function sendOpenWindowToObsidian(windowId, close) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const tabs = win.tabs.filter(tab => openTabsSendableUrl(tab));
    if (!tabs.length) return alert('No tab in this window has a page URL to send.');
    if (typeof mdLinkLine !== 'function' || typeof openObsidianAppend !== 'function') return;
    const closable = close ? tabs.filter(tab => openTabsClosable(tab)) : [];
    const kept = close ? tabs.length - closable.length : 0;
    const keptNote = kept ? ` ${formatCount(kept)} pinned or library tab(s) stay open.` : '';
    const msg = close
        ? `Send Window ${win.number} (${formatCount(tabs.length)} tab(s)) to Obsidian and close those tabs?${keptNote}`
        : `Send Window ${win.number} (${formatCount(tabs.length)} tab(s)) to Obsidian? The tabs stay open.`;
    if (!confirm(msg)) return;
    const markdown = tabs.map(tab => {
        const url = openTabsSendableUrl(tab);
        return mdLinkLine({ title: tab.title || url, uri: url }, 0);
    }).join('\n');
    await sendMarkdownByDestination(markdown);
    logAffected('SYSTEM', `Window ${win.number}`, `Sent ${formatCount(tabs.length)} open tab(s) from Window ${win.number} to Obsidian${closable.length ? ` and closed ${formatCount(closable.length)} of them` : ''}.`, {
        source: 'Open Tabs'
    });
    if (!close) {
        setOpenTabsNote(`Sent ${formatCount(tabs.length)} tab(s) from Window ${win.number} to Obsidian. The tabs stay open.`);
        return;
    }
    if (!closable.length) {
        setOpenTabsNote(`Sent ${formatCount(tabs.length)} tab(s) from Window ${win.number} to Obsidian. Kept open: they are pinned or this library page.`);
        return;
    }
    await openTabsCloseIds(closable.map(tab => tab.id), `Window ${win.number}`);
    setOpenTabsNote(`Sent ${formatCount(tabs.length)} tab(s) from Window ${win.number} to Obsidian and closed ${formatCount(closable.length)}${kept ? `; kept ${formatCount(kept)} pinned or library tab(s)` : ''}.`);
}

function openTabsWindowObsidian(windowId, close) {
    return sendOpenWindowToObsidian(windowId, close);
}

function openTabsMenuObsidian() {
    if (openTabsMenuTarget) sendOpenTabToObsidian(openTabsMenuTarget.tabId, false);
}

function openTabsMenuObsidianClose() {
    if (openTabsMenuTarget) sendOpenTabToObsidian(openTabsMenuTarget.tabId, true);
}

// --- Send a tab search chain to Obsidian ---
// Same markdown as a bookmark Search chain: the search line, then what it opened one tab in.
function openTabsChainMarkdown(chain) {
    if (typeof searchChainMarkdown !== 'function') return '';
    return searchChainMarkdown({ links: chain.tabs.map(tab => ({ uri: tab.url, title: tab.title })) });
}

// The markdown for a group action. A search chain keeps its shape — the search line as the parent,
// then what it opened. "Other tabs" has no parent of its own, so it gets one: every tab nested under a
// single line, in the order the group is showing them, with nothing promoted to the top level.
function openTabsGroupMarkdown(scope) {
    if (scope.kind === 'chain') {
        return typeof openTabsChainMarkdown === 'function' ? openTabsChainMarkdown({ tabs: scope.tabs }) : '';
    }
    if (typeof mdLinkLine !== 'function') return '';
    const lines = scope.tabs
        .filter(tab => tab && tab.url)
        .map(tab => '  ' + mdLinkLine({ uri: tab.url, title: tab.title }, 0));
    if (!lines.length) return '';
    return ['- **' + scope.label + '**'].concat(lines).join('\n');
}

function openTabsChainTabs(entry) {
    const live = [];
    (entry.tabIds || []).forEach(id => {
        const found = openTabsFindTab(id);
        if (found) live.push(found.tab);
    });
    return live;
}

// One question, one place: something in this set is already bookmarked, so offer the remainder, the
// whole set including second copies, or nothing. The app's own dialog carries two positive answers;
// where it is unavailable the question degrades to confirm() with whichever answer makes sense.
// Callers act inside the callbacks and simply return afterwards.
function askAlreadySaved(options) {
    const settings = options || {};
    const scopeText = settings.scopeText || '';
    const total = Number(settings.total) || 0;
    const alreadyCount = Number(settings.alreadyCount) || 0;
    const remaining = Math.max(0, total - alreadyCount);
    const canSaveSome = remaining > 0 && typeof settings.onSave === 'function';
    const canSaveAll = typeof settings.onSaveAll === 'function';
    const note = alreadyCount >= total
        ? `Every tab${scopeText} is already bookmarked (${formatCount(total)} tab(s)).`
        : `${formatCount(alreadyCount)} of ${formatCount(total)} tab(s)${scopeText} are already bookmarked.`;

    if (typeof openPreviewDialog === 'function') {
        openPreviewDialog({
            title: settings.title || 'Bookmark these tabs again',
            note,
            rows: [],
            confirmLabel: canSaveSome
                ? `Bookmark the other ${formatCount(remaining)}`
                : `Bookmark second copies of all ${formatCount(total)}`,
            onConfirm: () => { void (canSaveSome ? settings.onSave() : (canSaveAll ? settings.onSaveAll() : null)); },
            secondaryLabel: canSaveSome && canSaveAll ? `Bookmark all ${formatCount(total)}, including copies` : '',
            onSecondary: canSaveSome && canSaveAll ? () => { void settings.onSaveAll(); } : null
        });
        return true;
    }
    // No dialog: confirm() can only ask one thing, so ask the one that is possible here.
    if (canSaveSome) {
        if (!confirm(`${note} Bookmark the other ${formatCount(remaining)}?`)) return true;
        void settings.onSave();
        return true;
    }
    if (canSaveAll && confirm(`${note} Bookmark second copies of all ${formatCount(total)}?`)) void settings.onSaveAll();
    return true;
}
// The tabs a group action covers: a search chain's own tabs, or — for the "Other tabs" group — the
// tabs of that window that are neither pinned nor part of a chain.
function openTabsGroupScope(tabId, idsCsv, label) {
    const entry = openTabsChainIndex.get(tabId);
    const scopeLabel = label || (entry ? (entry.query || 'Search chain') : 'Other tabs');
    // The ids the control was drawn with win: they come from the same render, so a filtered or stale
    // view cannot make the action disagree with what the group showed.
    const listed = String(idsCsv || '').split(',').map(value => Number(value)).filter(value => Number.isFinite(value));
    const wanted = listed.length ? listed : (entry ? openTabsChainTabs(entry).map(tab => tab.id) : null);
    if (wanted) {
        const tabs = wanted.map(id => { const hit = openTabsFindTab(id); return hit ? hit.tab : null; }).filter(Boolean);
        // A tab closed since the render simply drops out; only an empty result is a real failure.
        return tabs.length ? { kind: entry ? 'chain' : 'others', label: scopeLabel, tabs } : null;
    }
    const found = openTabsFindTab(tabId);
    if (!found || !found.win) return null;
    const winTabs = found.win.tabs || [];
    const inChain = new Set();
    winTabs.forEach(tab => { if (openTabsChainIndex.has(tab.id)) inChain.add(tab.id); });
    return { kind: 'others', label: scopeLabel, tabs: winTabs.filter(tab => !inChain.has(tab.id)) };
}

async function sendOpenTabsChainToObsidian(tabId, close, idsCsv, scopeLabel) {
    const scope = openTabsGroupScope(tabId, idsCsv, scopeLabel);
    if (!scope) return alert('That group has no tabs to act on right now.');
    const tabs = scope.tabs;
    const markdown = openTabsGroupMarkdown(scope);
    if (!markdown) return alert('Nothing to send: this group has no web links.');
    const label = scope.label;
    const msg = close
        ? `Send the “${label}” search chain (${formatCount(tabs.length)} tab(s)) to Obsidian and close those tabs?`
        : `Send the “${label}” search chain (${formatCount(tabs.length)} tab(s)) to Obsidian? The tabs stay open.`;
    if (!confirm(msg)) return;
    const ids = close ? tabs.filter(tab => openTabsClosable(tab)).map(tab => tab.id) : [];
    const kept = tabs.length - ids.length;
    await sendMarkdownByDestination(markdown);
    logAffected('SYSTEM', label, `Sent the open-tab search chain “${label}” (${formatCount(tabs.length)} tab(s)) to Obsidian${ids.length ? ` and closed ${formatCount(ids.length)} of its tabs` : ''}.`, {
        source: 'Open Tabs'
    });
    if (!close) {
        setOpenTabsNote(`Sent the search chain “${escapeHtml(label)}” (${formatCount(tabs.length)} tab(s)) to Obsidian. The tabs stay open.`);
        return;
    }
    if (!ids.length) {
        setOpenTabsNote(`Sent the search chain “${escapeHtml(label)}” to Obsidian. Nothing closed: its tabs are pinned or this library page.`);
        return;
    }
    await openTabsCloseIds(ids, label);
    setOpenTabsNote(`Sent the search chain “${escapeHtml(label)}” (${formatCount(ids.length)} tab(s)) to Obsidian and closed them${kept ? `; kept ${formatCount(kept)} pinned or library tab(s)` : ''}.`);
}

// Bookmark the tabs of one search chain — not the whole window — as a single undoable step.
async function bookmarkOpenTabsChain(tabId, close, idsCsv, scopeLabel) {
    const scope = openTabsGroupScope(tabId, idsCsv, scopeLabel);
    if (!scope) return alert('That group has no tabs to act on right now.');
    const tabs = scope.tabs.filter(tab => isBookmarkableTabUrl(tab.url));
    if (!tabs.length) return alert('This group has no web or file links to bookmark.');
    if (!bookmarkData) return alert('Library is not loaded.');
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('No Other Bookmarks folder was found.');
    const skipSaved = openTabsSkipSavedEnabled();
    const index = openTabsBookmarkIndex();
    const toSave = tabs.filter(tab => !(skipSaved && openTabsIsSaved(index, tab)));
    const label = scope.label;
    // The group goes into a folder named after it, inside the app's Opened tabs folder, so a chain's
    // links stay together in the library instead of landing loose among every other opened tab.
    const groupName = String(label || '').trim() || 'Group';
    const findChild = (folderEl, title) => (folderEl && folderEl.children || []).find(child => isBookmarkFolderNode(child)
        && String(child.title || '').trim().toLowerCase() === String(title).trim().toLowerCase());

    // Everything after the choice, so whichever list is picked is saved the same way: one undo step, the
    // same log entries, the same optional close.
    const saveChosen = async (list) => {
        const stamp = openTabsStamp();
        const now = Date.now();
        const dateAdded = typeof liveCreateNode === 'function' ? now : now * 1000;
        let opened = findChild(other, OPENED_TABS_FOLDER);
        let parent = findChild(opened, groupName);
        const created = [];
        withUndo('Bookmark group', api => {
            if (!opened) {
                opened = { typeCode: 2, title: OPENED_TABS_FOLDER, children: [], dateAdded, _modified: true };
                api.create(other, opened);
            }
            if (!parent) {
                parent = { typeCode: 2, title: groupName, children: [], dateAdded, _modified: true };
                api.create(opened, parent);
            }
            list.forEach(tab => {
                const node = { typeCode: 1, title: tab.title || tab.url, uri: tab.url, dateAdded, _modified: true };
                api.create(parent, node);
                created.push(node);
            });
        });
        const where = `${displayFolderTitle(other)} / ${OPENED_TABS_FOLDER} / ${groupName}`;
        created.forEach(node => logAffected('ADDED', node.title, `Bookmarked “${node.title}” from the “${groupName}” group.`, {
            source: 'Open Tabs',
            node,
            uri: node.uri,
            folderPath: where
        }));
        markChanged();
        renderSidebar();
        renderOpenTabs();
        const note = `Bookmarked ${formatCount(created.length)} tab(s) from the “${escapeHtml(groupName)}” group into ${escapeHtml(where)} (${escapeHtml(stamp)}).`;
        if (!close) { setOpenTabsNote(note); return; }
        const closable = list.filter(tab => openTabsClosable(tab));
        if (!closable.length) { setOpenTabsNote(`${note} Kept open: they are pinned or this library page.`); return; }
        await openTabsCloseIds(closable.map(tab => tab.id), `the “${groupName}” group`);
        setOpenTabsNote(`${note} Closed ${formatCount(closable.length)} of them.`);
    };

    if (!toSave.length) {
        // Nothing new to add, but the group can still be copied wholesale. That is the same choice the
        // dialog offers when only some are saved; confirm() cannot express it, so the dialog does.
        if (typeof openPreviewDialog === 'function') {
            openPreviewDialog({
                title: `Bookmark the “${label}” group`,
                note: `Every tab in “${label}” is already bookmarked (${formatCount(tabs.length)} tab(s)).`,
                rows: [],
                confirmLabel: `Bookmark second copies of all ${formatCount(tabs.length)}`,
                onConfirm: () => { void saveChosen(tabs); }
            });
            return;
        }
        if (!confirm(`Every tab in this group is already bookmarked. Bookmark second copies of all ${formatCount(tabs.length)}?`)) return;
        return saveChosen(tabs);
    }
    if (toSave.length === tabs.length) return saveChosen(toSave);
    askAlreadySaved({
        title: `Bookmark the “${label}” group`,
        scopeText: ` in “${label}”`,
        total: tabs.length,
        alreadyCount: tabs.length - toSave.length,
        onSave: () => saveChosen(toSave),
        onSaveAll: () => saveChosen(tabs)
    });
}

function openTabsMenuChainBookmark() {
    if (openTabsMenuTarget) bookmarkOpenTabsChain(openTabsMenuTarget.tabId, false);
}

function openTabsMenuChainBookmarkClose() {
    if (openTabsMenuTarget) bookmarkOpenTabsChain(openTabsMenuTarget.tabId, true);
}

function openTabsMenuChainSend() {
    if (openTabsMenuTarget) sendOpenTabsChainToObsidian(openTabsMenuTarget.tabId, false);
}

function openTabsMenuChainSendClose() {
    if (openTabsMenuTarget) sendOpenTabsChainToObsidian(openTabsMenuTarget.tabId, true);
}

async function openTabsOpenedTimes(windows) {
    const times = new Map();
    const ext = openTabsExt();
    if (!ext || !ext.sessions || typeof ext.sessions.getTabValue !== 'function') return times;
    const tabs = windows.flatMap(win => win.tabs || []);
    await Promise.all(tabs.map(tab => openTabsCall('sessions', 'getTabValue', tab.id, 'openedAt')
        .then(value => { if (value && value.t) times.set(tab.id, value); })
        .catch(() => {})));
    return times;
}

function openTabsWhen(ms) {
    const date = new Date(ms);
    const now = new Date();
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) return time;
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

function openTabsAgo(ms) {
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

// One source for the Opened / Viewed lines, so the condensed view can reuse them as tooltip text.
function openTabTimeBits(tab, opened) {
    const bits = [];
    if (opened) {
        bits.push(opened.exact
            ? { text: `Opened ${openTabsWhen(opened.t)} · ${openTabsAgo(opened.t)}`, title: new Date(opened.t).toLocaleString() }
            : { text: `Open since ≤ ${openTabsWhen(opened.t)}`, title: 'Already open when the add-on first saw it, so the real open time is earlier.' });
    }
    if (tab.lastAccessed && !(tab.active && !opened)) {
        bits.push({ text: `Viewed ${tab.active ? 'now' : openTabsAgo(tab.lastAccessed)}`, title: new Date(tab.lastAccessed).toLocaleString() });
    }
    return bits;
}

function openTabTimesHtml(tab, opened) {
    const bits = openTabTimeBits(tab, opened);
    return bits.length
        ? `<span class="open-tab-times">${bits.map(bit => `<span title="${escapeHtml(bit.title)}">${escapeHtml(bit.text)}</span>`).join('')}</span>`
        : '';
}

function openTabTimesText(tab, opened) {
    return openTabTimeBits(tab, opened).map(bit => bit.text).join(' · ');
}

function isBookmarkableTabUrl(url) {
    return /^(https?|ftp|file):/i.test(String(url || ''));
}

// --- Collapse view ---
function isOpenTabsWindowCollapsed(windowId) {
    return openTabsCollapsed.has(windowId);
}

function setOpenTabsWindowCollapsed(windowId, collapsed) {
    if (collapsed) openTabsCollapsed.add(windowId);
    else openTabsCollapsed.delete(windowId);
}

function toggleOpenTabsWindow(windowId) {
    setOpenTabsWindowCollapsed(windowId, !isOpenTabsWindowCollapsed(windowId));
    renderOpenTabs();
}

function toggleAllOpenTabsWindows() {
    if (!openTabsWindows.length) {
        renderOpenTabs();
        return;
    }
    const anyExpanded = openTabsWindows.some(win => !isOpenTabsWindowCollapsed(win.id));
    openTabsWindows.forEach(win => setOpenTabsWindowCollapsed(win.id, anyExpanded));
    renderOpenTabs();
}

// Merge every other normal window into the one holding this page: each tab is moved across, then
// the emptied window goes. Private windows are skipped — a private tab cannot be moved into a
// normal window — and every move is counted so the note can be honest about failures.
function mergeOpenTabsWindows() {
    const target = openTabsHostId != null ? openTabsHostId : (openTabsWindows.find(win => win.focused) || {}).id;
    const others = openTabsWindows.filter(win => win.id !== target);
    const mergeable = others.filter(win => !win.incognito);
    const privateCount = others.length - mergeable.length;
    const tabCount = mergeable.reduce((sum, win) => sum + win.tabs.length, 0);
    if (!target || !mergeable.length) {
        setOpenTabsNote(privateCount
            ? 'Nothing to merge: the only other window is private.'
            : 'There is only one window to merge.');
        return;
    }
    confirmDialog({
        title: 'Merge windows',
        note: `Move ${formatCount(tabCount)} tab(s) from ${formatCount(mergeable.length)} other window(s) into this one, then close them. This cannot be undone from here.`,
        rows: mergeable.map(win => ({ title: `Window ${win.number}`, meta: `${formatCount(win.tabs.length)} tab(s)` })),
        confirmLabel: `Merge ${formatCount(mergeable.length)} window(s)`,
        onConfirm: async () => {
            let moved = 0;
            let failed = 0;
            for (const win of mergeable) {
                for (const tab of win.tabs) {
                    try {
                        await openTabsCall('tabs', 'move', tab.id, { windowId: target, index: -1 });
                        moved += 1;
                    } catch (err) {
                        failed += 1;
                    }
                }
                try {
                    await openTabsCall('windows', 'remove', win.id);
                } catch (err) {
                    // A window whose last tab moved away closes itself, which is not an error.
                }
            }
            setOpenTabsNote(`Merged ${formatCount(moved)} tab(s) into this window`
                + (failed ? `; ${formatCount(failed)} could not be moved.` : '.')
                + (privateCount ? ` Skipped ${formatCount(privateCount)} private window(s).` : ''));
            renderOpenTabs();
        }
    });
}

// Only worth offering with something to merge into.
// How many tabs the button would actually close — the same rule closeDuplicateOpenTabs applies, so
// the control is enabled exactly when it has something to do and says how much in its tooltip.
function openTabsDuplicateCounts() {
    let total = 0;
    let closable = 0;
    openTabsWindows.filter(win => (win.tabs || []).length > 1).forEach(win => {
        const seen = new Set();
        win.tabs.forEach(tab => {
            const uri = String(tab.url || '');
            if (!uri || !openTabsSendableUrl(tab)) return;
            const key = typeof libraryUrlKey === 'function' ? libraryUrlKey(uri) : uri;
            if (seen.has(key)) {
                total += 1;
                if (openTabsClosable(tab)) closable += 1;
            } else {
                seen.add(key);
            }
        });
    });
    return { total, closable };
}

function openTabsClosableDuplicateCount() {
    return openTabsDuplicateCounts().closable;
}

function updateOpenTabsCloseDupes() {
    const button = document.getElementById('open-tabs-close-dupes');
    if (!button) return 0;
    const counts = openTabsDuplicateCounts();
    button.disabled = counts.closable === 0;
    button.title = counts.closable
        ? `Close ${formatCount(counts.closable)} tab(s) whose URL is already open earlier in the same window`
        : (counts.total
            ? 'No duplicate page tabs to close: pinned tabs and this library page stay'
            : 'No tab is open twice in the same window');
    return counts.closable;
}

function updateOpenTabsMerge() {
    const button = document.getElementById('open-tabs-merge');
    if (!button) return;
    const others = openTabsWindows.filter(win => !win.incognito).length;
    button.disabled = openTabsWindows.length < 2 || others < 1;
    button.title = button.disabled
        ? 'Needs a second, non-private window to merge into this one'
        : 'Move every tab from every other window into this one, then close those windows';
}

function updateOpenTabsCollapseAll() {
    const btn = document.getElementById('open-tabs-collapse-all');
    if (!btn) return;
    const anyExpanded = openTabsWindows.some(win => !isOpenTabsWindowCollapsed(win.id));
    btn.textContent = anyExpanded ? 'Collapse all' : 'Expand all';
    btn.disabled = !openTabsWindows.length;
}

// --- Condensed view (entry rows) ---
function toggleOpenTabsCondensed() {
    openTabsCondensed = !openTabsCondensed;
    renderOpenTabs();
}

function updateOpenTabsCondensed() {
    const body = document.getElementById('open-tabs-body');
    if (body) body.classList.toggle('is-condensed', openTabsCondensed);
    const btn = document.getElementById('open-tabs-condensed');
    if (!btn) return;
    btn.textContent = openTabsCondensed ? 'Comfortable view' : 'Condensed view';
    btn.setAttribute('aria-pressed', openTabsCondensed ? 'true' : 'false');
    btn.disabled = !openTabsWindows.length;
}

// --- Search chain subgroups (display only) ---
function toggleOpenTabsChainGroups() {
    openTabsChainGroups = !openTabsChainGroups;
    renderOpenTabs();
}

function updateOpenTabsChainGroups() {
    const btn = document.getElementById('open-tabs-chain-groups');
    if (!btn) return;
    btn.textContent = openTabsChainGroups ? 'Ungroup chains' : 'Group chains';
    btn.setAttribute('aria-pressed', openTabsChainGroups ? 'true' : 'false');
    btn.disabled = !openTabsWindows.length;
}

// The filter as a predicate, so an action always works on what the box currently says
// (the render and the actions share this rule: title + ' ' + url contains the text).
function openTabsFilterMatch() {
    const text = openTabsQuery.trim();
    if (!text) return null;
    const needle = text.toLowerCase();
    return {
        text,
        match: tab => `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(needle)
    };
}

function openTabsStamp(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setOpenTabsNote(html) {
    const note = document.getElementById('open-tabs-note');
    if (!note) return;
    note.hidden = !html;
    note.innerHTML = html || '';
}

// --- selecting rows ---
// The rows are rebuilt on every render, so the selection lives here as a set of tab ids and is pruned
// to the tabs that still exist rather than being read back out of the DOM.
let openTabsSelected = new Set();
let openTabsSelectionAnchor = null;

function openTabsSelectedEntries() {
    const entries = [];
    openTabsWindows.forEach(win => (win.tabs || []).forEach(tab => {
        if (openTabsSelected.has(tab.id)) entries.push({ tab, win });
    }));
    return entries;
}

function openTabsSelectedWindowCount() {
    return new Set(openTabsSelectedEntries().map(entry => entry.win.id)).size;
}

function openTabsPruneSelection() {
    // A render can run before the tabs are fetched, and an empty list is not evidence that the selected
    // tabs are gone. Pruning on it would drop a selection that is still half-made.
    if (!openTabsWindows.length) return false;
    const live = new Set();
    openTabsWindows.forEach(win => (win.tabs || []).forEach(tab => live.add(tab.id)));
    let changed = false;
    [...openTabsSelected].forEach(id => { if (!live.has(id)) { openTabsSelected.delete(id); changed = true; } });
    if (openTabsSelectionAnchor !== null && !live.has(openTabsSelectionAnchor)) openTabsSelectionAnchor = null;
    return changed;
}

function openTabsToggleSelection(tabId, event) {
    const id = Number(tabId);
    const shift = Boolean(event && event.shiftKey);
    if (shift && openTabsSelectionAnchor !== null) {
        // Shift extends from the anchor, within the window the anchor lives in.
        const win = openTabsWindows.find(item => (item.tabs || []).some(tab => tab.id === openTabsSelectionAnchor));
        if (win) {
            const ids = (win.tabs || []).map(tab => tab.id);
            const from = ids.indexOf(openTabsSelectionAnchor);
            const to = ids.indexOf(id);
            if (from >= 0 && to >= 0) {
                const lo = Math.min(from, to), hi = Math.max(from, to);
                ids.slice(lo, hi + 1).forEach(each => openTabsSelected.add(each));
                renderOpenTabs();
                return;
            }
        }
    }
    if (openTabsSelected.has(id)) openTabsSelected.delete(id);
    else { openTabsSelected.add(id); openTabsSelectionAnchor = id; }
    renderOpenTabs();
}

function openTabsClearSelection() {
    openTabsSelected.clear();
    openTabsSelectionAnchor = null;
    renderOpenTabs();
}

function openTabsSelectionIds() {
    return openTabsSelectedEntries().map(entry => entry.tab.id);
}

function openTabRowHtml(tab, win, opts) {
    const { bookmarked, skipSaved, openedTimes, chainMarks = new Map(), filterContext } = opts;
    const contextChain = filterContext && filterContext.has(tab.id) ? (filterContext.get(tab.id) || '') : null;
    const canBookmark = isBookmarkableTabUrl(tab.url);
    const key = canBookmark ? bookmarkUrlKey(tab.url) : '';
    const saved = key ? bookmarked.get(key) : null;
    // The handler refuses a saved tab only while "skip bookmarked tabs" is on, so the row must
    // follow the same rule rather than hiding the control whenever a bookmark exists.
    const canBookmarkSaved = !saved || !skipSaved;
    const badges = [
        tab.active && win.focused ? '<span class="menu-badge open-tab-current">Current</span>' : '',
        tab.active && !win.focused ? '<span class="menu-badge open-tab-active-badge">Active</span>' : '',
        openTabsIsLibraryTab(tab) ? '<span class="menu-badge open-tab-library" title="This row is the Bookmark Library page itself. It is never closed from here.">Library</span>' : '',
        tab.pinned ? '<span class="menu-badge open-tab-pinned" title="Pinned tab. Pinned tabs sit first and neither sort moves them, so they stay where they are.">📌 Pinned</span>' : '',
        tab.audible ? '<span class="open-tab-flag" title="Playing audio">🔊</span>' : '',
        tab.discarded ? '<span class="open-tab-flag" title="Unloaded">💤</span>' : ''
    ].join('');
    // Condensed rows hide the times line, so keep them in the button tooltip.
    const times = openTabTimesText(tab, openedTimes.get(tab.id));
    const rowTitle = [
        contextChain === null ? '' : `Shown because the ${contextChain ? `“${contextChain}” ` : ''}search chain matched the filter, not this tab`,
        openTabsCondensed && times ? `Switch to this tab · ${times}` : 'Switch to this tab'
    ].filter(Boolean).join(' · ');
    // Every chain member is marked, so a chain is explicit even when its tabs are scattered.
    // How many tabs in this window share this row's URL. Cheap enough at real window sizes, and it
    // needs no shared pass over the tree.
    const dupeKey = bookmarkUrlKey(openTabsSendableUrl(tab) || tab.url || '');
    const dupeCount = dupeKey
        ? (win.tabs || []).filter(other => {
            const otherKey = bookmarkUrlKey(openTabsSendableUrl(other) || other.url || '');
            return Boolean(otherKey) && otherKey === dupeKey;
        }).length
        : 0;
    const dupeBadge = dupeCount > 1
        ? `<span class="open-tab-dupe" title="${formatCount(dupeCount)} tabs in Window ${win.number} have this same URL. Close the extras from the row menu.">${formatCount(dupeCount)}×</span>`
        : '';
    const mark = chainMarks.get(tab.id);
    const chainBadge = mark
        ? `<span class="open-tab-chain${mark.head ? '' : ' is-member'}" title="${escapeHtml(mark.head
            ? `Search chain: ${formatCount(mark.count)} tab(s) opened from “${mark.query || 'this search'}”. Right-click for Send to Obsidian.`
            : `Also part of the ${mark.query ? `“${mark.query}” ` : ''}search chain (${formatCount(mark.count)} tab(s))`)}">${mark.head ? '🔎' : '↳'} ${escapeHtml(mark.query || 'search chain')}</span>`
        : '';
    return `<li class="open-tab${openTabsSelected.has(tab.id) ? ' is-selected' : ''}${tab.active ? ' is-active' : ''}${tab.active && win.focused ? ' is-current' : ''}${mark && mark.start ? ' is-chain-start' : ''}${contextChain === null ? '' : ' is-filter-context'}" data-tab-row="${tab.id}" data-tab-win="${win.id}">
                <input type="checkbox" class="open-tab-select" data-tab-select="${tab.id}"${openTabsSelected.has(tab.id) ? ' checked' : ''} aria-label="Select this tab for bulk actions" title="Select for bulk actions (shift-click for a range)">
                <span class="open-tab-index">${tab.index + 1}</span>
                ${tab.favIconUrl && /^(https?|data):/i.test(tab.favIconUrl) ? `<img class="open-tab-icon" src="${escapeHtml(tab.favIconUrl)}" alt="">` : '<span class="open-tab-icon"></span>'}
                <button type="button" class="open-tab-main" data-tab-focus="${tab.id}" data-tab-window="${win.id}" title="${escapeHtml(rowTitle)}">
                    <span class="open-tab-title">${chainBadge}${escapeHtml(tab.title || tab.url || 'Untitled')}${dupeBadge}${badges}</span>
                    <span class="open-tab-url">${escapeHtml(tab.url || '')}</span>
                    ${openTabTimesHtml(tab, openedTimes.get(tab.id))}
                </button>
                ${saved ? `<button type="button" class="dupe-icon-btn" data-tab-reveal="${escapeHtml(String(saved.id ?? ''))}" title="Bookmarked: show in library" aria-label="Show in library">👁</button>` : ''}
                ${canBookmark
                    ? (saved && !canBookmarkSaved
                        ? '<span class="open-tab-flag" title="Already bookmarked. Skipping bookmarked tabs is on, so there is nothing to add.">✓</span>'
                        : `<span class="open-window-save open-tab-save-wrap">
                        <button type="button" class="dupe-icon-btn open-tab-save-trigger" data-tab-bookmark="${tab.id}" title="${saved ? 'Already bookmarked; a second copy goes into Other Bookmarks / ' + escapeHtml(OPENED_TABS_FOLDER) + '.' : 'Not bookmarked. Bookmark this tab into Other Bookmarks / ' + escapeHtml(OPENED_TABS_FOLDER) + '.'}" aria-label="Bookmark this tab">🔖</button>
                        <span class="open-window-menu" role="menu">
                            <button type="button" class="context-menu-item" role="menuitem" data-tab-bookmark="${tab.id}" data-tab-bookmark-mode="keep">${saved ? 'Bookmark a second copy' : 'Bookmark this tab'}</button>
                            <button type="button" class="context-menu-item" role="menuitem" data-tab-bookmark="${tab.id}" data-tab-bookmark-mode="close">${saved ? 'Bookmark a second copy and close it' : 'Bookmark this tab and close it'}</button>
                        </span>
                    </span>`)
                    : '<span class="open-tab-unsaved" title="No web or file URL (about:, extension pages), so this tab cannot be bookmarked or sent">—</span>'}
            </li>`;
}

function openTabGroupHtml(chain, count, others) {
    const label = others ? 'Other tabs' : ((chain && chain.query) || 'Search chain');
    const mark = others ? '' : '<span class="open-tab-group-mark" aria-hidden="true">🔎</span>';
    const tip = others
        ? `${formatCount(count)} tab(s) that are not part of a search chain`
        : `Search chain: ${formatCount(chain ? chain.tabs.length : count)} tab(s) opened from “${label}”`;
    // The same two choices the Obsidian control offers, but saving the chain's tabs into the library.
    const save = `<span class="open-window-save open-chain-save">
                    <button type="button" class="ghost-btn" data-chain-bookmark="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-bookmark-mode="keep" title="Bookmark only this group's tabs into Other Bookmarks / Opened tabs — nothing else in the window">Bookmark ▾</button>
                    <span class="open-window-menu" role="menu">
                        <button type="button" class="context-menu-item" role="menuitem" data-chain-bookmark="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-bookmark-mode="keep">Bookmark this group's tabs</button>
                        <button type="button" class="context-menu-item" role="menuitem" data-chain-bookmark="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-bookmark-mode="close">Bookmark this group's tabs and close them</button>
                    </span>
                </span>`;
    const send = `<span class="open-window-save open-chain-send">
                    <button type="button" class="ghost-btn" data-chain-obsidian="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-mode="keep" title="Append this search chain to today’s Obsidian note: the search line first, then what it opened, one tab in">Obsidian ▾</button>
                    <span class="open-window-menu" role="menu">
                        <button type="button" class="context-menu-item" role="menuitem" data-chain-obsidian="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-mode="keep">Send to Obsidian</button>
                        <button type="button" class="context-menu-item" role="menuitem" data-chain-obsidian="${chain.tabs[0].id}" data-group-tabs="${chain.tabs.map(t => t.id).join(',')}" data-chain-mode="close">Send to Obsidian and close them</button>
                    </span>
                </span>`;
    return `<li class="open-tab-group${others ? ' is-others' : ''}" title="${escapeHtml(tip)}">${mark}<span class="open-tab-group-title">${escapeHtml(label)}</span><span class="open-tab-group-count">${formatCount(count)} tab(s)</span>${save}${send}</li>`;
}

// Grouped view: each search chain becomes a subgroup of the window, in opened order,
// with everything else collected in a trailing "Other tabs" group. Display only — the
// real tab order (and the row numbers) are untouched.
// Every member of a chain gets a mark; `start` is the first row of a chain that is
// contiguous in the order on screen.
function openTabsChainMarks(tabs, chains) {
    const marks = new Map();
    const visible = new Set(tabs);
    (chains || []).forEach(chain => {
        const indexes = chain.tabs.map(tab => tabs.indexOf(tab));
        const contiguous = indexes.every(index => index >= 0)
            && indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1);
        chain.tabs.forEach((tab, i) => {
            // The search tab is always the head of the chain; the rest are continuations.
            if (visible.has(tab)) marks.set(tab.id, { query: chain.query, count: chain.tabs.length, head: i === 0, start: contiguous && i === 0 });
        });
    });
    return marks;
}

// Chains of a window, recorded so the row menu and the Obsidian actions can find them.
function openTabsIndexChains(win, chains) {
    chains.forEach(chain => {
        const tabIds = chain.tabs.map(tab => tab.id);
        chain.tabs.forEach((tab, i) => {
            openTabsChainIndex.set(tab.id, { windowId: win.id, query: chain.query, count: chain.tabs.length, tabIds, isStart: i === 0 });
        });
    });
}

function openTabsGroupRowsHtml(win, tabs, opts, chains) {
    if (!chains.length) return '';
    const grouped = new Set();
    const visible = new Set(tabs);
    const parts = [];
    chains.forEach(chain => {
        // chain.tabs is in opened order (search tab first) — the order these tabs are saved in.
        const members = chain.tabs.filter(tab => visible.has(tab));
        if (!members.length) return;
        members.forEach(tab => grouped.add(tab));
        parts.push(openTabGroupHtml(chain, members.length, false));
        parts.push(...members.map(tab => openTabRowHtml(tab, win, opts)));
    });
    if (!parts.length) return '';
    const others = tabs.filter(tab => !grouped.has(tab));
    if (others.length) {
        parts.push(openTabGroupHtml({ query: 'Other tabs', tabs: others }, others.length, true));
        parts.push(...others.map(tab => openTabRowHtml(tab, win, opts)));
    }
    return parts.join('');
}

function openTabsRowsHtml(win, tabs, opts, chains) {
    openTabsIndexChains(win, chains);
    if (openTabsChainGroups) {
        const grouped = openTabsGroupRowsHtml(win, tabs, opts, chains);
        if (grouped) return grouped;
    }
    return tabs.map(tab => openTabRowHtml(tab, win, { ...opts, chainMarks: openTabsChainMarks(tabs, chains) })).join('');
}

// A row's menu opens downward, and the list scrolls, so a menu on a row near the bottom of the
// visible area used to be cut off. Measure the row against its scroller on the way in and flip
// the menu above the button when there is not room below. The rows are re-created on every
// render, so this is called from the render pass; the dataset flag keeps it to one binding each.
function bindOpenTabMenuFlip(scope) {
    const holders = (scope || document).querySelectorAll('.open-window-save, .open-tab-save-wrap');
    holders.forEach(holder => {
        if (holder.dataset.menuFlipBound === '1') return;
        holder.dataset.menuFlipBound = '1';
        const consider = () => {
            const scroller = typeof holder.closest === 'function' ? holder.closest('.open-tabs-body') : null;
            const bounds = scroller && typeof scroller.getBoundingClientRect === 'function'
                ? scroller.getBoundingClientRect()
                : { top: 0, bottom: (typeof window !== 'undefined' && window.innerHeight) || 1000 };
            const row = typeof holder.getBoundingClientRect === 'function' ? holder.getBoundingClientRect() : null;
            if (!row) return;
            // 150px is more than a two- or three-item menu needs.
            const roomBelow = row.bottom + 150 <= bounds.bottom;
            const roomAbove = row.top - 150 >= bounds.top;
            // A tab row's menu opens upward by default, so it only flips when upward will not fit;
            // the window and chain menus open downward and flip the other way.
            const rowMenu = typeof holder.classList.contains === 'function' && holder.classList.contains('open-tab-save-wrap');
            const flip = rowMenu ? (!roomAbove && roomBelow) : (!roomBelow && roomAbove);
            holder.classList.toggle('is-flipped', flip);
        };
        holder.addEventListener('mouseenter', consider);
        holder.addEventListener('focusin', consider);
    });
    return holders.length;
}

// The bulk-action bar, drawn above the windows whenever something is selected.
function openTabsRenderSelectionBar(body) {
    if (!body) return;
    let bar = body.querySelector('.open-tabs-selection-bar');
    if (!openTabsSelected.size) {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'open-tabs-selection-bar';
        body.insertBefore(bar, body.firstChild);
    }
    const windows = openTabsSelectedWindowCount();
    // Only windows holding a tab that is not selected can receive the selection; anywhere else the
    // move would be a no-op, and offering it would just be noise.
    const targets = openTabsWindows.filter(win => (win.tabs || []).some(tab => !openTabsSelected.has(tab.id)));
    const windowItems = targets.map(win => `<button type="button" class="context-menu-item" role="menuitem" data-selection-action="move-to" data-selection-window="${win.id}">Window ${win.number} · ${formatCount((win.tabs || []).length)} tab(s)</button>`).join('');
    bar.innerHTML = `<span class="open-tabs-selection-count">${formatCount(openTabsSelected.size)} selected${windows > 1 ? ` · ${formatCount(windows)} windows` : ''}</span>
        <span class="open-window-save open-tabs-selection-menu">
            <button type="button" class="ghost-btn" data-selection-menu="obsidian">Obsidian ▾</button>
            <span class="open-window-menu" role="menu">
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="obsidian">Send to Obsidian</button>
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="obsidian-close">Send to Obsidian and close them</button>
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="copy">Copy as Markdown</button>
            </span>
        </span>
        <span class="open-window-save open-tabs-selection-menu">
            <button type="button" class="ghost-btn" data-selection-menu="bookmark">Bookmark ▾</button>
            <span class="open-window-menu" role="menu">
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="bookmark">Bookmark these tabs</button>
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="bookmark-close">Bookmark these tabs and close them</button>
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="close-only">Close without bookmarking</button>
            </span>
        </span>
        <span class="open-window-save open-tabs-selection-menu">
            <button type="button" class="ghost-btn" data-selection-menu="move">Move to window ▾</button>
            <span class="open-window-menu" role="menu">
                <button type="button" class="context-menu-item" role="menuitem" data-selection-action="move-new">Move to a new window</button>
                ${windowItems}
            </span>
        </span>
        <button type="button" class="ghost-btn" data-selection-action="clear">Clear selection</button>`;
    bar.querySelectorAll('[data-selection-action]').forEach(btn => {
        btn.addEventListener('click', () => openTabsSelectionAction(btn.dataset.selectionAction, btn.dataset.selectionWindow));
    });
}

async function openTabsSelectionAction(action, value) {
    const entries = openTabsSelectedEntries();
    if (!entries.length) return openTabsClearSelection();
    const ids = openTabsSelectionIds();
    if (action === 'clear') return openTabsClearSelection();
    if (action === 'close-only') {
        const closable = entries.filter(entry => openTabsClosable(entry.tab));
        if (!closable.length) return alert('None of the selected tabs can be closed (pinned tabs and this library page stay).');
        await openTabsCloseIds(closable.map(entry => entry.tab.id), `${formatCount(closable.length)} selected tab(s)`);
        openTabsSelected.clear();
        setOpenTabsNote(`Closed ${formatCount(closable.length)} selected tab(s) without bookmarking them.`);
        renderOpenTabs();
        return;
    }
    if (action === 'close') {
        const closable = entries.filter(entry => openTabsClosable(entry.tab));
        if (!closable.length) return alert('None of the selected tabs can be closed (pinned tabs and this library page stay).');
        const kept = entries.length - closable.length;
        if (!confirm(`Close ${formatCount(closable.length)} selected tab(s)?${kept ? `\\n\\n${formatCount(kept)} are pinned or this library page and stay open.` : ''}`)) return;
        await openTabsCloseIds(closable.map(entry => entry.tab.id), `${formatCount(closable.length)} selected tab(s)`);
        const list = closable.map(entry => `<div class="open-tabs-note-line">· ${escapeHtml(entry.tab.title || entry.tab.url || 'Untitled')}</div>`).join('');
        openTabsSelected.clear();
        setOpenTabsNote(`Closed ${formatCount(closable.length)} selected tab(s).${list}`);
        renderOpenTabs();
        return;
    }
    if (action === 'copy') {
        // The same text the send produces, without sending it: one parent line, then the tabs.
        const scope = { kind: 'others', label: 'Selected tabs', tabs: entries.map(entry => entry.tab) };
        const markdown = openTabsGroupMarkdown(scope);
        if (!markdown) return alert('None of the selected tabs have a web or file URL to copy.');
        return openTabsCopyReport(markdown, `${formatCount(entries.length)} selected tab(s)`);
    }
    if (action === 'move-to') {
        const ext = openTabsExt();
        const target = Number(value);
        if (!ext || !ext.tabs || !Number.isFinite(target)) return alert('Moving tabs needs the browser add-on.');
        try {
            await ext.tabs.move(ids, { windowId: target, index: -1 });
            openTabsSelected.clear();
            setOpenTabsNote(`Moved ${formatCount(ids.length)} selected tab(s) into another window.`);
            renderOpenTabs();
        } catch (err) {
            alert(`Could not move the selected tabs: ${err && err.message ? err.message : err}`);
        }
        return;
    }
    if (action === 'move-new') {
        const ext = openTabsExt();
        if (!ext || !ext.windows || !ext.tabs) return alert('Moving tabs needs the browser add-on.');
        try {
            // windows.create takes one tab; the rest follow it into the new window.
            const created = await ext.windows.create({ tabId: ids[0] });
            if (ids.length > 1 && created && created.id !== undefined && created.id !== null) {
                await ext.tabs.move(ids.slice(1), { windowId: created.id, index: -1 });
            }
            openTabsSelected.clear();
            setOpenTabsNote(`Moved ${formatCount(ids.length)} selected tab(s) into a new window.`);
            renderOpenTabs();
        } catch (err) {
            alert(`Could not move the selected tabs: ${err && err.message ? err.message : err}`);
        }
        return;
    }
    // Bookmark and Obsidian reuse the group actions, which already take an explicit list of ids and a
    // "close afterwards" flag, so keep and close differ only by that argument.
    if (action === 'bookmark') return bookmarkOpenTabsChain(ids[0], false, ids.join(','), 'Selected tabs');
    if (action === 'bookmark-close') return bookmarkOpenTabsChain(ids[0], true, ids.join(','), 'Selected tabs');
    if (action === 'obsidian') return sendOpenTabsChainToObsidian(ids[0], false, ids.join(','), 'Selected tabs');
    if (action === 'obsidian-close') return sendOpenTabsChainToObsidian(ids[0], true, ids.join(','), 'Selected tabs');
}

async function renderOpenTabs() {
    const body = document.getElementById('open-tabs-body');
    const meta = document.getElementById('open-tabs-meta');
    if (!body) return;
    if (!openTabsExt()) {
        if (meta) meta.textContent = 'Needs the browser add-on.';
        body.innerHTML = '<p class="stats-empty">Open Tabs reads browser windows and tabs, which only the Firefox / Chrome add-on can do. This JSON copy cannot see them.</p>';
        updateOpenTabsCollapseAll();
    updateOpenTabsMerge();
    updateOpenTabsCloseDupes();
        updateOpenTabsCondensed();
        updateOpenTabsChainGroups();
        return;
    }
    watchOpenTabs();
    let windows = [];
    try {
        windows = await openTabsCall('windows', 'getAll', { populate: true, windowTypes: ['normal'] });
        openTabsHostId = await openTabsHostWindowId();
    } catch (err) {
        body.innerHTML = `<p class="stats-empty">Could not read windows: ${escapeHtml(err.message)}</p>`;
        return;
    }
    // Window numbers follow the oldest tab in each window, so Window 1 is the window that has
    // been open longest rather than whichever order the browser happened to list them in. Tabs
    // without a recorded opened time sort after the ones that have one, keeping their relative
    // order (Array.prototype.sort is stable), and the tabs inside a window stay in tab order.
    const prepared = (windows || []).map(win => ({ ...win, tabs: (win.tabs || []).slice().sort((a, b) => a.index - b.index) }));
    const openedForNumbering = await openTabsOpenedTimes(prepared);
    const oldestTabMs = win => (win.tabs || []).reduce((oldest, tab) => {
        const stamp = openedForNumbering.get(tab.id);
        const ms = stamp && stamp.t ? stamp.t : Infinity;
        return Math.min(oldest, ms);
    }, Infinity);
    prepared.sort((a, b) => oldestTabMs(a) - oldestTabMs(b));
    openTabsWindows = prepared.map((win, i) => ({ ...win, number: i + 1 }));
    openTabsLibraryTabId = await openTabsCurrentTabId();
    wireOpenTabsMenu();
    const tabCount = openTabsWindows.reduce((sum, win) => sum + win.tabs.length, 0);
    paintOpenTabsTabCount(openTabsWindows.length ? tabCount : 0);
    if (meta) meta.textContent = `${formatCount(openTabsWindows.length)} window(s), ${formatCount(tabCount)} tab(s). The active tab of each window is highlighted; the focused window’s active tab is marked Current. Collapse a window to its header, or Collapse all.`;
    const q = openTabsQuery.trim().toLowerCase();
    const bookmarked = openTabsBookmarkIndex();
    const skipSaved = openTabsSkipSavedEnabled();
    const openedTimes = openedForNumbering;   // fetched once, for the numbering above
    updateOpenTabsCollapseAll();
    updateOpenTabsMerge();
    updateOpenTabsCloseDupes();
    updateOpenTabsCondensed();
    updateOpenTabsChainGroups();
    openTabsChainIndex = new Map();
    body.innerHTML = openTabsWindows.map(win => {
        const chains = openTabsChains(win, openedTimes);
        const matches = q ? win.tabs.filter(tab => `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(q)) : win.tabs;
        // A filter match drags its whole search chain in, so the session stays readable even
        // when the other tabs of that chain do not contain the filter text themselves.
        const filterContext = new Map();
        let tabs = matches;
        if (q && matches.length) {
            const matched = new Set(matches.map(tab => tab.id));
            chains.forEach(chain => {
                if (!chain.tabs.some(tab => matched.has(tab.id))) return;
                chain.tabs.forEach(tab => {
                    if (!matched.has(tab.id)) filterContext.set(tab.id, chain.query);
                });
            });
            if (filterContext.size) tabs = win.tabs.filter(tab => matched.has(tab.id) || filterContext.has(tab.id));
        }
        const active = win.tabs.find(tab => tab.active);
        const pinnedCount = win.tabs.filter(tab => tab.pinned).length;
        // With a filter on, saving acts on what the filter shows, not the whole window.
        // `matches` is the same set the window summary counts as "K match".
        const filterMatch = Boolean(q);
        const scoped = filterMatch ? matches : win.tabs;
        const bookmarkable = scoped.filter(tab => isBookmarkableTabUrl(tab.url));
        const saveable = skipSaved ? bookmarkable.filter(tab => !openTabsIsSaved(bookmarked, tab)).length : bookmarkable.length;
        const sendableCount = win.tabs.filter(tab => openTabsSendableUrl(tab)).length;
        const sortChoices = openTabsSortChoices(win, openedTimes);
        const looseCount = openTabsLooseTabs(win).length;
        const copyableCount = sendableCount;
        const cleanableCount = win.tabs.filter(tab => openTabsSendableUrl(tab) && hasCleanableUrl(tab.url)).length;
        const alreadySaved = bookmarkable.length - saveable;
        // Every tab with a URL here is already in the library and the default setting skips
        // those, so saving would add nothing — but the window can still be *closed* from this
        // menu, which is the useful action once everything is saved. Keep it reachable.
        const nothingToAdd = saveable === 0 && alreadySaved > 0;
        const scopeText = filterMatch ? ` matching “${openTabsQuery.trim()}”` : '';
        const saveTitle = nothingToAdd
            ? `All ${formatCount(alreadySaved)} tab(s) here with a web or file URL are already bookmarked, so saving would skip them. The menu can still close them.`
            : saveable
            ? `Bookmark ${formatCount(saveable)} tab(s)${scopeText} into Other Bookmarks / ${OPENED_TABS_FOLDER} / Window ${win.number} · date${alreadySaved ? ` (${formatCount(alreadySaved)} already bookmarked are skipped)` : ''}`
            : (alreadySaved ? `Every tab${scopeText} with a web or file URL is already bookmarked. Settings → Skip tabs that are already bookmarked can save them again.` : '');
                const saveLabel = 'Bookmark ▾';
        const saveMode = filterMatch ? ' data-window-save-mode="filtered-close"' : '';
                        const closeAndSaveLabel = filterMatch ? 'Bookmark only the matching tabs and close them' : "Bookmark this window's tabs and close them";
        const closeOnlyLabel = 'Close without bookmarking';
        const closeMode = filterMatch ? ' data-window-save-close-mode="filtered"' : '';
        const onlyLabel = filterMatch ? 'Bookmark only the matching tabs' : "Bookmark this window's tabs";
        const rowOpts = { bookmarked, skipSaved, openedTimes, filterContext };
        const rows = openTabsRowsHtml(win, tabs, rowOpts, chains);
        const collapsed = isOpenTabsWindowCollapsed(win.id);
        return `<section class="open-window${win.focused ? ' is-focused' : ''}${collapsed ? ' is-collapsed' : ''}">
            <header class="open-window-head" data-window-head="${win.id}">
                <button type="button" class="open-window-toggle" data-window-toggle="${win.id}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="open-tabs-list-${win.id}" title="${collapsed ? 'Expand' : 'Collapse'} this window’s tabs"><span class="open-window-chev" aria-hidden="true">▾</span></button>
                <h2>Window ${win.number}</h2>
                ${win.focused ? '<span class="menu-badge open-window-focused">Focused</span>' : ''}
                ${win.incognito ? '<span class="menu-badge open-window-private">Private</span>' : ''}
                ${win.id === openTabsHostId ? '<span class="menu-badge open-window-library" title="This window holds the Bookmark Library page. Bookmark all windows skips it.">Library</span>' : ''}
                <span class="stats-host">${formatCount(win.tabs.length)} tab(s)${pinnedCount ? ` · ${formatCount(pinnedCount)} pinned` : ''}${q ? ` · ${formatCount(matches.length)} match${filterContext.size ? ` (+${formatCount(filterContext.size)} chain)` : ''}` : ''}${active ? ` · active: ${escapeHtml(active.title || active.url || '')}` : ''}</span>
                <span class="open-window-actions">
                    <button type="button" class="ghost-btn" data-window-focus="${win.id}">Focus</button>
                    ${copyableCount ? `<span class="open-window-save">
                        <button type="button" class="ghost-btn" data-window-copy-menu="${win.id}" title="Copy this window’s page tabs: titles, clean URLs, or markdown lines — the clean URL the Obsidian send would write. ${sendableCount ? `${formatCount(sendableCount)} tab(s) have a URL.` : ''}">Copy ▾</button>
                        <span class="open-window-menu" role="menu">
                            <button type="button" class="context-menu-item" role="menuitem" data-window-copy="title" data-window-copy-window="${win.id}" title="One tab title per line.">Copy Titles</button>
                            <button type="button" class="context-menu-item" role="menuitem" data-window-copy="url" data-window-copy-window="${win.id}" title="One tab URL per line, cleaned: tracking parameters stripped and Google/YouTube links shortened.">Copy URLs</button>
                            ${cleanableCount ? `<button type="button" class="context-menu-item" role="menuitem" data-window-copy="urlOriginal" data-window-copy-window="${win.id}" title="One tab URL per line, exactly as the browser has them. Shown because ${formatCount(cleanableCount)} tab(s) here have a URL the clean copy would shorten.">Copy URLs (Original)</button>` : ''}
                            <button type="button" class="context-menu-item" role="menuitem" data-window-copy="markdown" data-window-copy-window="${win.id}" title="One “- [title](url)” line per tab, with the clean URL.">Copy as Markdown</button>
                        </span>
                    </span>` : ''}
                    ${looseCount > 1 ? `<span class="open-window-save">
                        <button type="button" class="ghost-btn" data-window-sort-menu="${win.id}" title="Sort this window’s tabs by domain, opened date, viewed time, or search chains. Pinned tabs always stay first, and no sort is undoable. A dimmed sort is already in that order (or has nothing to work with); picking it just says so.">Sort ▾</button>
                        <span class="open-window-menu" role="menu">
                            ${sortChoices.map(choice => `<button type="button" class="context-menu-item${choice.ready ? '' : ' is-idle'}" role="menuitem" data-window-sort-mode="${choice.id}" data-window-sort-window="${win.id}" title="${escapeHtml(choice.hint)}">${escapeHtml(choice.label)}</button>`).join('')}
                        </span>
                    </span>` : ''}
                    ${sendableCount ? `<span class="open-window-save">
                        <button type="button" class="ghost-btn" data-window-obsidian="${win.id}" data-window-obsidian-mode="keep" title="Append this window’s ${formatCount(sendableCount)} tab(s) to today’s Obsidian note as - [title](url) lines">Obsidian ▾</button>
                        <span class="open-window-menu" role="menu">
                            <button type="button" class="context-menu-item" role="menuitem" data-window-obsidian="${win.id}" data-window-obsidian-mode="keep">Send to Obsidian</button>
                            <button type="button" class="context-menu-item" role="menuitem" data-window-obsidian="${win.id}" data-window-obsidian-mode="close">Send to Obsidian and close them</button>
                        </span>
                    </span>` : ''}
                    <span class="open-window-save">
                        <button type="button" class="action-btn" data-window-save="${win.id}"${saveMode} ${bookmarkable.length ? '' : 'disabled'} title="${escapeHtml(saveTitle)}">${escapeHtml(saveLabel)}</button>
                        ${saveable || nothingToAdd ? `<span class="open-window-menu" role="menu">
                            ${saveable ? `<button type="button" class="context-menu-item" role="menuitem" data-window-save="${win.id}">${escapeHtml(onlyLabel)}</button>` : ''}
                            <button type="button" class="context-menu-item" role="menuitem" data-window-save-close="${win.id}"${closeMode}>${escapeHtml(closeAndSaveLabel)}</button>
                            <button type="button" class="context-menu-item" role="menuitem" data-window-close-only="${win.id}"${closeMode}>${escapeHtml(closeOnlyLabel)}</button>
                        </span>` : ''}
                    </span>
                </span>
            </header>
            <ol class="open-tab-list" id="open-tabs-list-${win.id}">${rows || '<li class="stats-host">No tabs match the filter.</li>'}</ol>
        </section>`;
    }).join('') || '<p class="stats-empty">No browser windows.</p>';
    bindOpenTabMenuFlip(body);
    // The selection set is the source of truth, so a re-render mid-pick (a collapse, a refresh, a
    // filter change) redraws the same ticks instead of losing them.
    body.querySelectorAll('[data-tab-select]').forEach(box => {
        const id = Number(box.dataset.tabSelect);
        box.checked = openTabsSelected.has(id);
        box.addEventListener('click', event => {
            event.stopPropagation();
            openTabsToggleSelection(id, event);
        });
    });
    openTabsPruneSelection();
    openTabsRenderSelectionBar(body);
    body.querySelectorAll('[data-tab-focus]').forEach(btn => {
        btn.onclick = () => focusOpenTab(Number(btn.dataset.tabFocus), Number(btn.dataset.tabWindow));
    });
    body.querySelectorAll('[data-window-focus]').forEach(btn => {
        btn.onclick = () => openTabsCall('windows', 'update', Number(btn.dataset.windowFocus), { focused: true }).catch(err => alert(err.message));
    });
    body.querySelectorAll('[data-window-sort-mode]').forEach(btn => {
        btn.onclick = () => openTabsWindowSort(Number(btn.dataset.windowSortWindow), btn.dataset.windowSortMode);
    });
    body.querySelectorAll('.context-menu-item[data-chain-bookmark]').forEach(btn => {
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            bookmarkOpenTabsChain(btn.dataset.chainBookmark, btn.dataset.chainBookmarkMode === 'close', btn.dataset.groupTabs);
        });
    });
    body.querySelectorAll('.context-menu-item[data-chain-obsidian]').forEach(btn => {
        btn.onclick = () => sendOpenTabsChainToObsidian(Number(btn.dataset.chainObsidian), btn.dataset.chainMode === 'close', btn.dataset.groupTabs);
    });
    body.querySelectorAll('.context-menu-item[data-window-obsidian]').forEach(btn => {
        btn.onclick = () => openTabsWindowObsidian(Number(btn.dataset.windowObsidian), btn.dataset.windowObsidianMode === 'close');
    });
    body.querySelectorAll('[data-tab-bookmark]').forEach(btn => {
        btn.onclick = () => bookmarkOpenTab(Number(btn.dataset.tabBookmark), btn.dataset.tabBookmarkMode === 'close');
    });
    body.querySelectorAll('[data-window-copy]').forEach(btn => {
        const windowId = Number(btn.dataset.windowCopyWindow);
        btn.onclick = () => openTabsWindowCopy(windowId, btn.dataset.windowCopy);
    });
    const filterScope = openTabsFilterMatch();
    const saveScope = filterScope ? { match: filterScope.match, scopeText: filterScope.text } : {};
    body.querySelectorAll('.context-menu-item[data-window-save]').forEach(btn => {
        const windowId = Number(btn.dataset.windowSave);
        btn.onclick = () => btn.dataset.windowSaveMode === 'filtered-close'
            ? bookmarkAndCloseFiltered(windowId)
            : bookmarkOpenWindows([windowId], saveScope);
    });
    body.querySelectorAll('.context-menu-item[data-window-close-only]').forEach(btn => {
        btn.onclick = () => closeOpenWindowTabs(Number(btn.dataset.windowCloseOnly));
    });
    body.querySelectorAll('.context-menu-item[data-window-save-close]').forEach(btn => {
        const windowId = Number(btn.dataset.windowSaveClose);
        btn.onclick = () => btn.dataset.windowSaveCloseMode === 'filtered'
            ? bookmarkAndCloseFiltered(windowId)
            : bookmarkAndCloseWindow(windowId);
    });
    body.querySelectorAll('[data-tab-reveal]').forEach(btn => {
        btn.onclick = () => {
            if (btn.dataset.tabReveal && typeof revealBookmarkById === 'function') revealBookmarkById(btn.dataset.tabReveal);
        };
    });
    body.querySelectorAll('[data-window-toggle]').forEach(btn => {
        btn.onclick = () => toggleOpenTabsWindow(Number(btn.dataset.windowToggle));
    });
    body.querySelectorAll('[data-window-head]').forEach(head => {
        head.addEventListener('click', event => {
            if (event.target.closest('button, .open-window-menu')) return;
            toggleOpenTabsWindow(Number(head.dataset.windowHead));
        });
    });
}

function filterOpenTabs(event) {
    openTabsQuery = event?.target?.value || '';
    // Filtering reveals every match; the collapse layout comes back when the box is cleared.
    if (openTabsQuery.trim()) {
        if (!openTabsCollapsedBeforeFilter) {
            openTabsCollapsedBeforeFilter = new Set(openTabsCollapsed);
            openTabsCollapsed.clear();
        }
    } else if (openTabsCollapsedBeforeFilter) {
        openTabsCollapsed = openTabsCollapsedBeforeFilter;
        openTabsCollapsedBeforeFilter = null;
    }
    renderOpenTabs();
}

function focusOpenTab(tabId, windowId) {
    openTabsCall('tabs', 'update', tabId, { active: true })
        .then(() => openTabsCall('windows', 'update', windowId, { focused: true }))
        .catch(err => alert(err.message));
}

function tabDomainKey(url) {
    try {
        const parsed = new URL(url);
        if (!/^(https?|ftp):$/.test(parsed.protocol)) return '';
        return parsed.hostname.toLowerCase().replace(/^www\./, '');
    } catch (err) {
        return '';
    }
}

// Unpinned tabs in window order; the domain sort never moves pinned tabs.
function openTabsLooseTabs(win) {
    return (win.tabs || []).filter(tab => !tab.pinned);
}

// Unpinned tabs in the order Sort by domain would leave them: domains A→Z, original
// order kept inside a domain, tabs without a web domain last.
function openTabsSortedByDomain(win) {
    return openTabsLooseTabs(win)
        .map((tab, order) => ({ tab, order, domain: tabDomainKey(tab.url) }))
        .sort((a, b) => (a.domain ? 0 : 1) - (b.domain ? 0 : 1) || a.domain.localeCompare(b.domain) || a.order - b.order)
        .map(item => item.tab);
}

// The Sort by domain button is only useful while the window is out of domain order.
function openTabsNeedsDomainSort(win) {
    const loose = openTabsLooseTabs(win);
    if (loose.length < 2) return false;
    const sorted = openTabsSortedByDomain(win);
    return !sorted.every((tab, i) => tab === loose[i]);
}

// --- Search chains (opened-tab timing) ---
function openTabOpenedAt(times, tab) {
    const opened = times && times.get(tab.id);
    return opened && Number.isFinite(opened.t) ? opened : null;
}

function isSearchTab(tab) {
    if (typeof extractSearchQuery !== 'function') return false;
    return Boolean(extractSearchQuery({ url: tab.url, title: tab.title }));
}

// Tabs ordered by when they opened. Only exact stamps order anything: the add-on's
// "already open" stamp is one shared moment for every tab it found, so it would break
// chains apart. Tabs without a usable stamp keep their order at the end.
function openTabsSortedByOpened(times, win) {
    const dated = [];
    const rest = [];
    openTabsLooseTabs(win).forEach((tab, order) => {
        const opened = openTabOpenedAt(times, tab);
        if (opened && opened.exact) dated.push({ tab, order, t: opened.t });
        else rest.push(tab);
    });
    dated.sort((a, b) => a.t - b.t || a.order - b.order);
    return dated.map(item => item.tab).concat(rest);
}

// Same rule as Statistics clusterSearchChains, on tabs: a search tab plus what it opened
// within SEARCH_CHAIN_GAP_MS of each other, and at least one non-search tab to show for it.
// Only exact stamps count; the add-on's "already open" stamps all share one moment.
function openTabsChains(win, times) {
    const dated = openTabsLooseTabs(win)
        .map((tab, order) => ({ tab, order, opened: openTabOpenedAt(times, tab) }))
        .filter(item => item.opened && item.opened.exact)
        .sort((a, b) => a.opened.t - b.opened.t || a.order - b.order);
    const chains = [];
    for (let i = 0; i < dated.length; i++) {
        if (!isSearchTab(dated[i].tab)) continue;
        const cluster = [dated[i]];
        for (let j = i + 1; j < dated.length; j++) {
            if (dated[j].opened.t - cluster[cluster.length - 1].opened.t > SEARCH_CHAIN_GAP_MS) break;
            cluster.push(dated[j]);
        }
        if (!cluster.some(item => !isSearchTab(item.tab))) continue;
        chains.push({
            tabs: cluster.map(item => item.tab),
            query: extractSearchQuery({ url: cluster[0].tab.url, title: cluster[0].tab.title }) || ''
        });
        i += cluster.length - 1;
    }
    return chains;
}

function openTabsNeedsOpenedSort(win, times) {
    const loose = openTabsLooseTabs(win);
    if (loose.filter(tab => {
        const opened = openTabOpenedAt(times, tab);
        return opened && opened.exact;
    }).length < 2) return false;
    const sorted = openTabsSortedByOpened(times, win);
    return !sorted.every((tab, i) => tab === loose[i]);
}

// Search chains first, each chain in opened order, then the rest by opened time.
function openTabsSortedByChains(times, win) {
    const inChain = new Set();
    const head = [];
    openTabsChains(win, times).forEach(chain => {
        chain.tabs.forEach(tab => {
            inChain.add(tab);
            head.push(tab);
        });
    });
    const dated = [];
    const rest = [];
    openTabsLooseTabs(win).forEach((tab, order) => {
        if (inChain.has(tab)) return;
        const opened = openTabOpenedAt(times, tab);
        if (opened && opened.exact) dated.push({ tab, order, t: opened.t });
        else rest.push(tab);
    });
    dated.sort((a, b) => a.t - b.t || a.order - b.order);
    return head.concat(dated.map(item => item.tab), rest);
}

function openTabsNeedsChainSort(win, times) {
    if (!openTabsChains(win, times).length) return false;
    const loose = openTabsLooseTabs(win);
    const sorted = openTabsSortedByChains(times, win);
    return !sorted.every((tab, i) => tab === loose[i]);
}

// Least recently viewed first; tabs with no viewed time keep their order at the end.
function openTabsSortedByViewed(win) {
    const dated = [];
    const rest = [];
    openTabsLooseTabs(win).forEach((tab, order) => {
        if (Number.isFinite(tab.lastAccessed)) dated.push({ tab, order, t: tab.lastAccessed });
        else rest.push(tab);
    });
    dated.sort((a, b) => a.t - b.t || a.order - b.order);
    return dated.map(item => item.tab).concat(rest);
}

function openTabsNeedsViewedSort(win) {
    const loose = openTabsLooseTabs(win);
    if (loose.filter(tab => Number.isFinite(tab.lastAccessed)).length < 2) return false;
    const sorted = openTabsSortedByViewed(win);
    return !sorted.every((tab, i) => tab === loose[i]);
}

// Move everything after the pinned block, or say the window is already in that order.
async function applyWindowTabOrder(win, sorted, label) {
    const loose = openTabsLooseTabs(win);
    if (sorted.every((tab, i) => tab === loose[i])) {
        setOpenTabsNote(`Window ${win.number} is already in ${label} order.`);
        return false;
    }
    const pinned = win.tabs.filter(tab => tab.pinned).length;
    try {
        await openTabsCall('tabs', 'move', sorted.map(tab => tab.id), { windowId: win.id, index: pinned });
    } catch (err) {
        alert(`Could not move tabs: ${err.message}`);
        return false;
    }
    return true;
}

function openTabsSortNote(win, sorted, lead, tail = '') {
    const pinned = win.tabs.filter(tab => tab.pinned).length;
    const bits = [];
    if (pinned) bits.push(`${formatCount(pinned)} pinned tab(s) stayed first`);
    if (tail) bits.push(tail);
    return `Sorted ${formatCount(sorted.length)} tab(s) in Window ${win.number} ${lead}${bits.length ? `; ${bits.join('; ')}` : ''}.`;
}

function openTabsUndatedCount(win, times, kind) {
    return openTabsLooseTabs(win).filter(tab => {
        if (kind === 'viewed') return !Number.isFinite(tab.lastAccessed);
        const opened = openTabOpenedAt(times, tab);
        return !(opened && opened.exact);
    }).length;
}

async function organizeWindowTabsByOpened(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const times = await openTabsOpenedTimes([win]);
    if (openTabsUndatedCount(win, times, 'opened') >= openTabsLooseTabs(win).length - 1) {
        setOpenTabsNote(`Window ${win.number} has no tabs with a known open time to sort by.`);
        return;
    }
    const sorted = openTabsSortedByOpened(times, win);
    if (!await applyWindowTabOrder(win, sorted, 'opened')) return;
    const undated = openTabsUndatedCount(win, times, 'opened');
    setOpenTabsNote(openTabsSortNote(win, sorted, 'by when they opened',
        undated ? `${formatCount(undated)} without a known open time kept their order at the end` : ''));
    renderOpenTabs();
}

async function organizeWindowTabsByChain(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const times = await openTabsOpenedTimes([win]);
    const chains = openTabsChains(win, times);
    if (!chains.length) {
        setOpenTabsNote(`No search chain (a search tab plus what it opened within 2 minutes) was found in Window ${win.number}.`);
        return;
    }
    const sorted = openTabsSortedByChains(times, win);
    if (!await applyWindowTabOrder(win, sorted, 'search-chain')) return;
    const undated = openTabsUndatedCount(win, times, 'opened');
    setOpenTabsNote(openTabsSortNote(win, sorted, `with ${formatCount(chains.length)} search chain(s) at the front`,
        undated ? `${formatCount(undated)} without a known open time kept their order at the end` : ''));
    renderOpenTabs();
}

async function organizeWindowTabsByViewed(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    if (openTabsUndatedCount(win, null, 'viewed') >= openTabsLooseTabs(win).length - 1) {
        setOpenTabsNote(`Window ${win.number} has no tabs with a viewed time to sort by.`);
        return;
    }
    const sorted = openTabsSortedByViewed(win);
    if (!await applyWindowTabOrder(win, sorted, 'viewed')) return;
    const undated = openTabsUndatedCount(win, null, 'viewed');
    setOpenTabsNote(openTabsSortNote(win, sorted, 'by when they were last viewed, least recent first',
        undated ? `${formatCount(undated)} without a viewed time kept their order at the end` : ''));
    renderOpenTabs();
}

// All four sorts, always. One that would change nothing stays listed but idle, and its
// tooltip says why, so the menu never looks like it lost an option.
function openTabsSortChoices(win, times) {
    const loose = openTabsLooseTabs(win);
    const exact = loose.filter(tab => {
        const opened = openTabOpenedAt(times, tab);
        return opened && opened.exact;
    }).length;
    const viewed = loose.filter(tab => Number.isFinite(tab.lastAccessed)).length;
    const chains = openTabsChains(win, times).length;
    const idle = (ready, because) => (ready ? '' : because);
    const domain = openTabsNeedsDomainSort(win);
    const opened = openTabsNeedsOpenedSort(win, times);
    const seen = openTabsNeedsViewedSort(win);
    const chained = openTabsNeedsChainSort(win, times);
    return [
        {
            id: 'domain',
            label: 'Sort by Domain',
            ready: domain,
            hint: `Group tabs by site, A\u2192Z; pinned tabs stay first. No undo (tabs, not bookmarks).${idle(domain, ' Already in domain order.')}`
        },
        {
            id: 'opened',
            label: 'Sort by Date Opened',
            ready: opened,
            hint: `Oldest opened first; tabs with no known open time keep their order at the end. No undo.${idle(opened, exact < 2 ? ' No tab here has a known open time.' : ' Already in opened order.')}`
        },
        {
            id: 'viewed',
            label: 'Sort by Viewed',
            ready: seen,
            hint: `Least recently viewed first; tabs with no viewed time keep their order at the end. No undo.${idle(seen, viewed < 2 ? ' No tab here has a viewed time.' : ' Already in viewed order.')}`
        },
        {
            id: 'chain',
            label: 'Sort into Search Chains',
            ready: chained,
            hint: `Each search chain (a search tab and what it opened within 2 minutes) together at the front. No undo.${idle(chained, chains ? ' Already in search-chain order.' : ' No search chain in this window.')}`
        }
    ];
}

function openTabsWindowSort(windowId, mode) {
    if (mode === 'domain') return organizeWindowTabsByDomain(windowId);
    if (mode === 'opened') return organizeWindowTabsByOpened(windowId);
    if (mode === 'viewed') return organizeWindowTabsByViewed(windowId);
    if (mode === 'chain') return organizeWindowTabsByChain(windowId);
}

async function organizeWindowTabsByDomain(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const pinned = win.tabs.filter(tab => tab.pinned).length;
    const loose = openTabsLooseTabs(win);
    const sorted = openTabsSortedByDomain(win);
    if (sorted.every((tab, i) => tab === loose[i])) {
        setOpenTabsNote(`Window ${win.number} is already grouped by domain.`);
        return;
    }
    try {
        await openTabsCall('tabs', 'move', sorted.map(tab => tab.id), { windowId, index: pinned });
    } catch (err) {
        alert(`Could not move tabs: ${err.message}`);
        return;
    }
    const domains = new Set(sorted.map(tab => tabDomainKey(tab.url) || '(other)'));
    setOpenTabsNote(`Sorted ${formatCount(sorted.length)} tab(s) in Window ${win.number} into ${formatCount(domains.size)} domain group(s), A→Z${pinned ? `; ${formatCount(pinned)} pinned tab(s) stayed first` : ''}.`);
    renderOpenTabs();
}

async function bookmarkAllOpenWindows(mode) {
    if (!openTabsExt()) return alert('Open Tabs needs the browser add-on.');
    if (!openTabsWindows.length) await renderOpenTabs();
    const hostId = await openTabsHostWindowId();
    const ids = openTabsWindows.map(win => win.id).filter(id => id !== hostId);
    if (!ids.length) {
        // Nothing but the library's own window: its tabs are the only ones there are, so act on them
        // rather than refusing. Its own tab stays protected by the closable check.
        setOpenTabsNote('Only the Bookmark Library window is open, so its tabs are being used.');
        if (mode === 'close') return bookmarkAndCloseWindows([hostId], hostId);
        return bookmarkOpenWindows([hostId]);
    }
    if (mode === 'close') bookmarkAndCloseWindows(ids, hostId);
    else bookmarkOpenWindows(ids);
}

// Now async: the chain folders need the sessions stamps, which are read on demand.
async function bookmarkOpenWindows(windowIds, options = {}) {
    if (!bookmarkData) return alert('Library is not loaded.');
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('No Other Bookmarks folder was found.');
    const wins = openTabsWindows.filter(win => windowIds.includes(win.id));
    // `options.match` narrows the save to the tabs the filter is showing.
    const match = typeof options.match === 'function' ? options.match : null;
    const scopeText = options.scopeText ? ` matching “${options.scopeText}”` : '';
    const skipSaved = openTabsSkipSavedEnabled();
    // The skip setting is a default, not a verdict: the dialog can ask for these tabs again.
    const includeSaved = options.includeSaved === true;
    const bookmarked = skipSaved && !includeSaved ? openTabsBookmarkIndex() : null;
    let duplicates = 0;
    const plans = wins.map(win => {
        const bookmarkable = win.tabs.filter(tab => isBookmarkableTabUrl(tab.url) && (!match || match(tab)));
        const tabs = includeSaved ? bookmarkable : (skipSaved ? bookmarkable.filter(tab => !openTabsIsSaved(bookmarked, tab)) : bookmarkable);
        duplicates += bookmarkable.length - tabs.length;
        return { win, tabs, label: openTabsGroupLabel(win.tabs[0]) };
    }).filter(plan => plan.tabs.length);
    if (!plans.length) {
        setOpenTabsNote('');
        const count = duplicates || wins.reduce((sum, win) => sum + win.tabs.length, 0);
        const note = duplicates
            ? `Every tab with a web or file URL${scopeText} is already bookmarked (${formatCount(count)} tab(s)).`
            : `No tab${scopeText} has a web or file URL to bookmark.`;
        // The same choice the group action offers, rather than sending the reader to a setting.
        if (duplicates) {
            askAlreadySaved({
                title: 'Bookmark these tabs again',
                scopeText,
                total: duplicates,
                alreadyCount: duplicates,
                onSaveAll: () => bookmarkOpenWindows(windowIds, Object.assign({}, options, { includeSaved: true }))
            });
            return [];
        }
        alert(duplicates ? `${note} Turn off “Skip tabs that are already bookmarked” in Settings to save them again.` : note);
        return [];
    }
    const skipped = wins.reduce((sum, win) => sum + win.tabs.length, 0) - plans.reduce((sum, plan) => sum + plan.tabs.length, 0) - duplicates;
    const chainFolders = openTabsChainFoldersEnabled();
    const times = chainFolders ? await openTabsOpenedTimes(plans.map(plan => plan.win)) : new Map();
    const stamp = openTabsStamp();
    const now = Date.now();
    const dateAdded = typeof liveCreateNode === 'function' ? now : now * 1000;
    let parent = (other.children || []).find(child => isBookmarkFolderNode(child) && String(child.title || '').trim().toLowerCase() === OPENED_TABS_FOLDER.toLowerCase());
    const saved = [];
    withUndo('Bookmark open windows', api => {
        if (!parent) {
            parent = { typeCode: 2, title: OPENED_TABS_FOLDER, children: [], dateAdded, _modified: true };
            api.create(other, parent);
        }
        plans.forEach(plan => {
            const titles = (parent.children || []).filter(isBookmarkFolderNode).map(child => child.title);
            const folder = { typeCode: 2, title: nextNewFolderName(titles, `Window ${plan.win.number}${plan.label ? ` (${plan.label})` : ''} · ${stamp}`), children: [], dateAdded, _modified: true };
            api.create(parent, folder);
            // Each search chain gets its own folder inside the window folder; the rest stay here.
            const chains = [];
            const grouped = new Set();
            if (chainFolders) {
                openTabsChains(plan.win, times).forEach(chain => {
                    const members = plan.tabs.filter(tab => chain.tabs.includes(tab));
                    if (!members.length) return;
                    members.forEach(tab => grouped.add(tab));
                    const chainTitles = (folder.children || []).filter(isBookmarkFolderNode).map(child => child.title);
                    const chainFolder = { typeCode: 2, title: nextNewFolderName(chainTitles, openTabsChainFolderName(chain.query)), children: [], dateAdded, _modified: true };
                    api.create(folder, chainFolder);
                    members.forEach(tab => {
                        api.create(chainFolder, { typeCode: 1, title: tab.title || tab.url, uri: tab.url, dateAdded, _modified: true });
                    });
                    chains.push({ folder: chainFolder, count: members.length, query: chain.query });
                    logAffected('ADDED', chainFolder.title, `Bookmarked search chain “${chain.query || chainFolder.title}” (${formatCount(members.length)} tab(s)) from Window ${plan.win.number}.`, {
                        source: 'Open Tabs',
                        node: chainFolder,
                        folderPath: `${displayFolderTitle(other)} / ${OPENED_TABS_FOLDER} / ${folder.title}`
                    });
                });
            }
            const loose = plan.tabs.filter(tab => !grouped.has(tab));
            loose.forEach(tab => {
                api.create(folder, { typeCode: 1, title: tab.title || tab.url, uri: tab.url, dateAdded, _modified: true });
            });
            saved.push({ folder, count: plan.tabs.length, chains, loose: loose.length });
            logAffected('ADDED', folder.title, `Bookmarked ${formatCount(plan.tabs.length)} open tab(s) from Window ${plan.win.number}.`, {
                source: 'Open Tabs',
                node: folder,
                folderPath: `${displayFolderTitle(other)} / ${OPENED_TABS_FOLDER}`
            });
        });
    });
    markChanged();
    renderSidebar();
    renderOpenTabs();
    const total = saved.reduce((sum, item) => sum + item.count, 0);
    const skippedBits = [];
    if (skipped) skippedBits.push(`${formatCount(skipped)} tab(s) without a web or file URL (about:, extension pages)`);
    if (duplicates) skippedBits.push(`${formatCount(duplicates)} tab(s) already bookmarked`);
    const savedList = saved.map(item => {
        const inner = [
            ...item.chains.map(chain => `<li>${escapeHtml(chain.folder.title)} · ${formatCount(chain.count)} tab(s)</li>`),
            ...(item.chains.length && item.loose ? [`<li>${formatCount(item.loose)} tab(s) outside a chain</li>`] : [])
        ].join('');
        return `<li>${escapeHtml(item.folder.title)} · ${formatCount(item.count)} tab(s)</li>${inner ? `<ul class="empty-folder-list">${inner}</ul>` : ''}`;
    }).join('');
    setOpenTabsNote(`Saved ${formatCount(total)} tab(s)${scopeText} into ${formatCount(saved.length)} folder(s) under Other Bookmarks / ${escapeHtml(OPENED_TABS_FOLDER)}${skippedBits.length ? `. Skipped ${skippedBits.join(' and ')}` : ''}:
        <ul class="empty-folder-list">${savedList}</ul>`);
    return saved;
}

async function openTabsHostWindowId() {
    try {
        const host = await openTabsCall('windows', 'getCurrent');
        return host && host.id != null ? host.id : null;
    } catch (err) {
        return null;
    }
}

// The window close confirmation as an app dialog: the same warnings, in a themed card with a proper
// confirm button. The dialog has no cancel callback, so the promise settles when it closes.
function askBookmarkAndClose(names, warnings) {
    if (typeof openPreviewDialog !== 'function') {
        return Promise.resolve(confirm(`Bookmark and close ${names}?\n\n${warnings.join('\n')}`));
    }
    return new Promise(resolve => {
        let settled = false;
        let watch = 0;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearInterval(watch);
            resolve(value);
        };
        openPreviewDialog({
            title: `Bookmark and close ${names}`,
            note: 'Every tab with a web or file URL is bookmarked first, and then the tabs close.',
            rows: warnings.map(text => ({ title: text, meta: '' })),
            confirmLabel: 'Bookmark and close',
            onConfirm: () => finish(true)
        });
        // The dialog closes on Cancel or a backdrop click, and neither reports back, so settle on that.
        watch = setInterval(() => {
            const dialog = document.getElementById('preview-dialog');
            if (!dialog || dialog.hidden) finish(false);
        }, 150);
    });
}
// Close a window's page tabs without putting anything in the library.
async function closeOpenWindowTabs(windowId) {
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const closable = (win.tabs || []).filter(tab => openTabsClosable(tab));
    if (!closable.length) return alert('Nothing to close in this window: its tabs are pinned or this library page.');
    if (!confirm(`Close ${formatCount(closable.length)} tab(s) in Window ${win.number} without bookmarking them?`)) return;
    await openTabsCloseIds(closable.map(tab => tab.id), `Window ${win.number}`);
    setOpenTabsNote(`Closed ${formatCount(closable.length)} tab(s) in Window ${win.number} without bookmarking them.`);
    renderOpenTabs();
}

async function bookmarkAndCloseWindows(windowIds, hostId) {
    const wins = openTabsWindows.filter(win => windowIds.includes(win.id));
    if (!wins.length) return;
    const skipped = wins.reduce((sum, win) => sum + win.tabs.filter(tab => !isBookmarkableTabUrl(tab.url)).length, 0);
    const alreadySaved = openTabsSkipSavedEnabled()
        ? (() => {
            const index = openTabsBookmarkIndex();
            return wins.reduce((sum, win) => sum + win.tabs.filter(tab => openTabsIsSaved(index, tab)).length, 0);
        })()
        : 0;
    const names = wins.map(win => `Window ${win.number}`).join(', ');
    const warnings = [];
    if (skipped) warnings.push(`${formatCount(skipped)} tab(s) without a web or file URL (about:, extension pages) will close without a bookmark.`);
    if (alreadySaved) warnings.push(`${formatCount(alreadySaved)} tab(s) are already bookmarked and will not be saved again.`);
    if (wins.some(win => win.id === hostId)) warnings.push('This window holds the Bookmark Library page, so the library closes too.');
    if (warnings.length && !(await askBookmarkAndClose(names, warnings))) return;
    const saved = await bookmarkOpenWindows(wins.map(win => win.id));
    if (!saved || !saved.length) return;
    if (typeof livePersistChain !== 'undefined') await livePersistChain;
    if (hasUnsavedChanges && typeof isLiveBookmarks === 'function' && isLiveBookmarks()) {
        alert(`${names} ${wins.length === 1 ? 'was' : 'were'} left open: the bookmarks could not all be written.`);
        return;
    }
    const closed = [];
    const failed = [];
    for (const win of wins.filter(item => item.id !== hostId).concat(wins.filter(item => item.id === hostId))) {
        try {
            await openTabsCall('windows', 'remove', win.id);
            closed.push(win);
        } catch (err) {
            failed.push(`Window ${win.number}: ${err.message}`);
        }
    }
    if (closed.length) {
        logAffected('SYSTEM', closed.map(win => `Window ${win.number}`).join(', '), `Closed ${formatCount(closed.length)} window(s) after bookmarking their tabs.`, { source: 'Open Tabs' });
    }
    const note = document.getElementById('open-tabs-note');
    if (note && !note.hidden && closed.length) note.insertAdjacentHTML('beforeend', `<p>Closed ${escapeHtml(closed.map(win => `Window ${win.number}`).join(', '))}.</p>`);
    if (failed.length) alert(`Saved the tabs, but could not close:\n${failed.join('\n')}`);
    renderOpenTabs();
}

async function bookmarkAndCloseWindow(windowId) {
    bookmarkAndCloseWindows([windowId], await openTabsHostWindowId());
}

// Filtered variant: saves the tabs the filter shows and closes those tabs, never the window,
// so tabs the filter is hiding are left alone. Pinned tabs and this library page stay open.
async function bookmarkAndCloseFiltered(windowId) {
    const filter = openTabsFilterMatch();
    if (!filter) return bookmarkAndCloseWindow(windowId);
    const win = openTabsWindows.find(item => item.id === windowId);
    if (!win) return;
    const matched = win.tabs.filter(filter.match);
    const saveable = matched.filter(tab => isBookmarkableTabUrl(tab.url));
    const closable = matched.filter(tab => openTabsClosable(tab));
    if (!matched.length) return alert(`No tab in Window ${win.number} matches “${filter.text}”.`);
    const kept = matched.length - closable.length;
    const unsaveable = closable.filter(tab => !isBookmarkableTabUrl(tab.url)).length;
    const warnings = [];
    if (unsaveable) warnings.push(`${formatCount(unsaveable)} of them have no web or file URL (about:, extension pages) and will close without a bookmark.`);
    if (kept) warnings.push(`${formatCount(kept)} matching tab(s) are pinned or this library page and stay open.`);
    if (!confirm(`Bookmark and close ${formatCount(closable.length)} tab(s) matching “${filter.text}” in Window ${win.number}?\n\n${formatCount(saveable.length)} tab(s) will be bookmarked into Other Bookmarks / ${OPENED_TABS_FOLDER}${warnings.length ? `\n${warnings.join('\n')}` : ''}`)) return;
    const saved = await bookmarkOpenWindows([windowId], { match: filter.match, scopeText: filter.text });
    if (!saved || !saved.length) return;
    if (typeof livePersistChain !== 'undefined') await livePersistChain;
    if (hasUnsavedChanges && typeof isLiveBookmarks === 'function' && isLiveBookmarks()) {
        alert('The matching tabs were left open: the bookmarks could not all be written.');
        return;
    }
    if (!closable.length) return;
    await openTabsCloseIds(closable.map(tab => tab.id), `“${filter.text}” in Window ${win.number}`);
    setOpenTabsNote(`Bookmarked and closed ${formatCount(closable.length)} tab(s) matching “${escapeHtml(filter.text)}” in Window ${win.number}${kept ? `; ${formatCount(kept)} pinned or library tab(s) stayed open` : ''}. Tabs the filter was hiding were left alone.`);
}

// Boot once the page exists: the tab label shows its total before the view is ever opened.
(function bootOpenTabsTabCount() {
    if (typeof document === 'undefined') return;
    const boot = () => {
        watchOpenTabs();
        refreshOpenTabsCount();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
