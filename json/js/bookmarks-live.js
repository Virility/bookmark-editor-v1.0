// Live Firefox/Chrome bookmarks API — replaces JSON import/export.
const LIVE_SPECIAL_IDS = {
    'toolbar_____': 'toolbar_____',
    'unfiled_____': 'unfiled_____',
    'menu________': 'menu________',
    'mobile______': 'mobile______',
    'tags________': 'tags________',
    'root________': 'root________',
    '0': 'root________',
    '1': 'toolbar_____',
    '2': 'unfiled_____',
    '3': 'menu________'
};

let livePersistChain = Promise.resolve();
const liveIdWaiters = new WeakMap();

function getNativeBookmarks() {
    const native = getBrowserExt();
    return native && native.bookmarks ? native.bookmarks : null;
}

function isLiveBookmarks() {
    return Boolean(getNativeBookmarks());
}

function callBookmarks(method, ...args) {
    if (typeof browser !== 'undefined' && browser.bookmarks && typeof browser.bookmarks[method] === 'function') {
        return Promise.resolve(browser.bookmarks[method](...args));
    }
    const api = getNativeBookmarks();
    if (!api || typeof api[method] !== 'function') {
        return Promise.reject(new Error('Bookmarks API is not available. Load this folder as a Firefox or Chrome extension.'));
    }
    return new Promise((resolve, reject) => {
        try {
            api[method](...args, result => {
                const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
                if (last) reject(new Error(last.message));
                else resolve(result);
            });
        } catch (err) {
            reject(err);
        }
    });
}

// The write queue also keeps a small outbox so a failed write is visible and retryable
// instead of only a one-off alert.
const LIVE_OUTBOX_LIMIT = 40;
let liveOutbox = [];

function recordLiveWrite(entry) {
    liveOutbox.unshift(entry);
    liveOutbox = liveOutbox.slice(0, LIVE_OUTBOX_LIMIT);
    if (typeof renderLiveOutbox === 'function') renderLiveOutbox();
}

function enqueueLive(work, label) {
    const entry = {
        id: `write-${Date.now()}-${liveOutbox.length}`,
        label: String(label || 'Bookmark write'),
        at: Date.now(),
        status: 'pending',
        error: '',
        retry: null
    };
    recordLiveWrite(entry);
    livePersistChain = livePersistChain.then(async () => {
        const result = await work();
        entry.status = 'done';
        entry.at = Date.now();
        hasUnsavedChanges = false;
        if (typeof updateStatus === 'function') updateStatus();
        if (typeof renderLiveOutbox === 'function') renderLiveOutbox();
        return result;
    }).catch(err => {
        console.error(err);
        entry.status = 'failed';
        entry.error = err && err.message ? err.message : String(err);
        entry.retry = work;
        entry.at = Date.now();
        hasUnsavedChanges = true;
        if (typeof updateStatus === 'function') updateStatus();
        if (typeof renderLiveOutbox === 'function') renderLiveOutbox();
        alert(`Could not write to the live bookmark library: ${entry.error}`);
    });
    return livePersistChain;
}

function retryFailedLiveWrites() {
    const failed = liveOutbox.filter(entry => entry.status === 'failed' && typeof entry.retry === 'function');
    failed.forEach(entry => {
        entry.status = 'pending';
        entry.error = '';
        enqueueLive(entry.retry, `${entry.label} (retry)`);
    });
    return failed.length;
}

function clearFinishedLiveWrites() {
    liveOutbox = liveOutbox.filter(entry => entry.status === 'failed');
    if (typeof renderLiveOutbox === 'function') renderLiveOutbox();
    return liveOutbox.length;
}

function isUsableLiveId(id) {
    return id != null && id !== '' && String(id) !== 'undefined' && String(id) !== 'null';
}

function waitLiveId(node) {
    if (!node) return Promise.reject(new Error('Missing bookmark node'));
    if (isUsableLiveId(node.id)) return Promise.resolve(String(node.id));
    const pending = liveIdWaiters.get(node);
    if (pending) return pending;
    return Promise.reject(new Error(`No bookmark id for “${node.title || 'untitled'}”`));
}

function rememberLiveId(node, promise) {
    const tracked = Promise.resolve(promise).then(id => {
        const resolved = isUsableLiveId(id) ? String(id) : (isUsableLiveId(node.id) ? String(node.id) : '');
        if (!isUsableLiveId(resolved)) {
            throw new Error(`No bookmark id for “${node.title || 'untitled'}”`);
        }
        node.id = resolved;
        return resolved;
    });
    liveIdWaiters.set(node, tracked);
    return tracked;
}

function specialGuidFromApi(node) {
    if (!node) return '';
    if (LIVE_SPECIAL_IDS[node.id]) return LIVE_SPECIAL_IDS[node.id];
    const title = String(node.title || '').toLowerCase();
    if (title === 'bookmarks toolbar' || title === 'bookmarks bar' || title === 'bookmark bar' || title === 'favorites bar') return 'toolbar_____';
    if (title === 'other bookmarks' || title === 'unsorted bookmarks') return 'unfiled_____';
    if (title === 'bookmarks menu') return 'menu________';
    if (title === 'mobile bookmarks') return 'mobile______';
    return '';
}

function fromApiBookmarkNode(node) {
    if (!node || node.type === 'separator') return null;
    const guid = specialGuidFromApi(node);
    const isFolder = node.type === 'folder' || (!node.url && (node.children || node.type !== 'bookmark'));
    const out = {
        id: node.id,
        title: node.title || '',
        dateAdded: node.dateAdded,
        // Kept so exports (and the epoch-date repair) can see the real modification
        // times instead of falling back to the creation date.
        lastModified: node.lastModified,
        dateGroupModified: node.dateGroupModified,
        dateLastUsed: node.dateLastUsed
    };
    if (guid) out.guid = guid;
    if (isFolder) {
        out.typeCode = 2;
        out.children = (node.children || []).map(fromApiBookmarkNode).filter(Boolean);
    } else {
        out.typeCode = 1;
        out.uri = node.url || '';
    }
    return out;
}

function isPlacesRootNode(node) {
    if (!node) return false;
    const id = node.id != null ? String(node.id) : '';
    const guid = node.guid || '';
    if (typeof bookmarkData !== 'undefined' && node === bookmarkData) return true;
    return id === 'root________' || id === '0' || guid === 'root________';
}

function isPlacesRootChild(node) {
    if (!node || isPlacesRootNode(node)) return false;
    if (typeof findNodeParent !== 'function' || typeof bookmarkData === 'undefined') return false;
    return findNodeParent(node) === bookmarkData;
}

function liveUpdateNode(node) {
    if (!isLiveBookmarks() || !node || isPlacesRootNode(node)) return;
    enqueueLive(async () => {
        const id = await waitLiveId(node);
        const patch = { title: node.title || '' };
        if ((node.typeCode === 1 || node.uri) && (node.uri || node.url)) patch.url = node.uri || node.url;
        await callBookmarks('update', id, patch);
        hasUnsavedChanges = false;
        updateStatus();
    }, `Update “${node.title || 'untitled'}”`);
}

function liveRemoveNode(node) {
    if (!isLiveBookmarks() || !node || isPlacesRootNode(node) || isPlacesRootChild(node)) return;
    if (!isUsableLiveId(node.id) && !liveIdWaiters.get(node)) return;
    const folderHadChildren = Boolean(node.children && node.children.length);
    const isFolder = node.typeCode === 2 || node.type === 'folder' || Array.isArray(node.children);
    enqueueLive(async () => {
        const id = await waitLiveId(node);
        if (folderHadChildren) {
            await callBookmarks('removeTree', id);
            return;
        }
        if (isFolder) {
            let kids = [];
            try {
                const listed = await callBookmarks('getChildren', id);
                kids = Array.isArray(listed) ? listed : [];
            } catch (e) {
                kids = [];
            }
            for (const kid of kids) {
                if (kid && kid.type === 'separator' && kid.id) await callBookmarks('remove', kid.id);
            }
            const remaining = kids.filter(kid => kid && kid.type !== 'separator');
            if (remaining.length) {
                throw new Error(`Cannot remove “${node.title || 'untitled'}”: ${remaining.length} item(s) are still in that folder`);
            }
        }
        await callBookmarks('remove', id);
    }, `Remove “${node.title || 'untitled'}”`);
}

function liveMoveNode(node, toParent, index) {
    if (!isLiveBookmarks() || !node || !toParent) return;
    if (isPlacesRootNode(node) || isPlacesRootNode(toParent) || isPlacesRootChild(node)) return;
    enqueueLive(async () => {
        const id = await waitLiveId(node);
        const parentId = await waitLiveId(toParent);
        if (!isUsableLiveId(parentId)) {
            throw new Error(`No parent id for “${toParent.title || 'untitled'}”`);
        }
        const dest = { parentId };
        if (Number.isInteger(index) && index >= 0) dest.index = index;
        await callBookmarks('move', id, dest);
    }, `Move “${node.title || 'untitled'}”`);
}

function liveCreateSpec(parentId, node, index) {
    const spec = { parentId, title: node.title || '' };
    if (Number.isInteger(index) && index >= 0) spec.index = index;
    if (node.uri || node.typeCode === 1) spec.url = node.uri || 'https://example.invalid';
    return spec;
}

function liveCreateNode(parent, node, index) {
    if (!isLiveBookmarks() || !parent || !node || isPlacesRootNode(parent)) return;
    // Snapshot at schedule time. Later sync moves can fill node.children before this
    // job runs; recreating those would duplicate bookmarks and clobber live ids.
    const pendingChildren = Array.isArray(node.children) ? node.children.slice() : [];
    const job = enqueueLive(async () => {
        const parentId = await waitLiveId(parent);
        if (!isUsableLiveId(parentId)) {
            throw new Error(`No parent id for “${parent.title || 'untitled'}”`);
        }
        const created = await callBookmarks('create', liveCreateSpec(parentId, node, index));
        node.id = created.id;
        for (let i = 0; i < pendingChildren.length; i++) {
            await liveCreateNodeImmediate(node, pendingChildren[i], i);
        }
        return String(created.id);
    }, `Create “${node.title || 'untitled'}”`);
    rememberLiveId(node, job);
}

async function liveCreateNodeImmediate(parent, node, index) {
    const parentId = await waitLiveId(parent);
    if (!isUsableLiveId(parentId)) {
        throw new Error(`No parent id for “${parent.title || 'untitled'}”`);
    }
    const pendingChildren = Array.isArray(node.children) ? node.children.slice() : [];
    const created = await callBookmarks('create', liveCreateSpec(parentId, node, index));
    node.id = created.id;
    rememberLiveId(node, created.id);
    for (let i = 0; i < pendingChildren.length; i++) {
        await liveCreateNodeImmediate(node, pendingChildren[i], i);
    }
    return created.id;
}

async function loadLiveLibrary(options = {}) {
    if (!isLiveBookmarks()) {
        bookmarkData = null;
        updateStatus();
        const meta = document.getElementById('folder-meta');
        if (meta) {
            meta.textContent = 'Load this folder as an extension: Firefox about:debugging → This Firefox → Load Temporary Add-on → manifest.json.';
        }
        return;
    }
    const tree = await callBookmarks('getTree');
    const root = Array.isArray(tree) ? tree[0] : tree;
    bookmarkData = fromApiBookmarkNode(root) || { typeCode: 2, title: 'All bookmarks', children: [], guid: 'root________' };
    if (!bookmarkData.title) bookmarkData.title = 'All bookmarks';
    hasUnsavedChanges = false;
    statsDataRev++;
    statsModelCache = { key: '', model: null };
    updateStatus();
    renderSidebar();
    if (document.getElementById('stats-view')?.classList.contains('active')) renderStatistics();
    const counts = countTree(bookmarkData);
    if (!options.silent) {
        logAffected('SYSTEM', 'Live library', `Loaded bookmarks from this browser via the WebExtensions bookmark API. ${formatCount(counts.links)} link(s), ${formatCount(counts.folders)} folder(s). dateAdded cannot be written live. This replaced the editor tree from the current browser store.`, {
            source: 'Bookmark library',
            kind: 'load',
            reason: 'API getTree mapped through fromApiBookmarkNode; dirty flag cleared; statistics cache invalidated.'
        });
    }
    consumeLibraryReveal();
}

function storageLocalGet(key) {
    const native = getBrowserExt();
    const api = native && native.storage && native.storage.local;
    if (!api || typeof api.get !== 'function') return Promise.resolve({});
    try {
        const ret = api.get(key);
        if (ret && typeof ret.then === 'function') return ret;
    } catch (err) { /* Chrome callback form */ }
    return new Promise(resolve => {
        api.get(key, result => resolve(result || {}));
    });
}

function consumeLibraryReveal() {
    const apply = id => {
        if (id && typeof revealBookmarkById === 'function') revealBookmarkById(id);
    };
    const params = new URLSearchParams(location.search);
    const fromQuery = params.get('reveal');
    if (fromQuery) apply(fromQuery);
    const domainQuery = params.get('domain');
    if (domainQuery) {
        params.delete('domain');
        const rest = params.toString();
        history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
        applyLibraryDomain(domainQuery);
    }
    storageLocalGet('libraryReveal').then(store => {
        const pending = store && store.libraryReveal;
        const native = getBrowserExt();
        if (native && native.storage && native.storage.local && native.storage.local.remove) {
            native.storage.local.remove('libraryReveal').catch(() => {});
        }
        if (pending && pending.id) apply(pending.id);
    }).catch(() => {});
}

function applyLibraryDomain(url) {
    if (url && typeof findUriInDomainStats === 'function') findUriInDomainStats(url);
}

function watchLibraryReveal() {
    const native = getBrowserExt();
    if (native && native.storage && native.storage.onChanged) {
        native.storage.onChanged.addListener((changes, area) => {
            if (area && area !== 'local') return;
            const next = changes.libraryReveal && changes.libraryReveal.newValue;
            if (!next || !next.id) return;
            if (typeof revealBookmarkById === 'function') revealBookmarkById(next.id);
        });
    }
    if (native && native.runtime && native.runtime.onMessage) {
        native.runtime.onMessage.addListener(msg => {
            if (msg && msg.type === 'library-domain' && msg.url) {
                applyLibraryDomain(msg.url);
                return;
            }
            if (!msg || msg.type !== 'library-reveal' || !msg.id) return;
            if (typeof revealBookmarkById === 'function') revealBookmarkById(msg.id);
        });
    }
}

function reloadLiveLibrary() {
    loadLiveLibrary().catch(err => alert(err.message));
}

function openLibraryTab() {
    const native = getBrowserExt();
    if (!native || !native.tabs || !native.runtime || typeof native.runtime.getURL !== 'function') return;
    native.tabs.create({ url: native.runtime.getURL('bookmark-editor-v1.0.html') });
}

function reloadAddon() {
    const native = getBrowserExt();
    if (native && native.runtime && typeof native.runtime.reload === 'function') native.runtime.reload();
    else location.reload();
}

function watchAutoMove() {
    const native = getBrowserExt();
    if (!native || !native.runtime || !native.runtime.onMessage) return;
    native.runtime.onMessage.addListener(msg => {
        if (!msg || msg.type !== 'auto-move-done') return;
        const toolbar = Number(msg.toolbar) || 0;
        const mobile = Number(msg.mobile) || 0;
        if (!toolbar && !mobile) return;
        const hours = Number(msg.hours) || AUTO_MOVE_HOURS_DEFAULT;
        const chain = typeof livePersistChain !== 'undefined' ? livePersistChain : Promise.resolve();
        Promise.resolve(chain).catch(() => {}).then(() => loadLiveLibrary({ silent: true })).then(() => {
            if (typeof logAutoMoveSummary === 'function') logAutoMoveSummary(toolbar, mobile, hours);
        }).catch(err => console.error(err));
    });
}

(function bootLiveLibrary() {
    watchLibraryReveal();
    watchAutoMove();
    const start = () => loadLiveLibrary().catch(err => alert(err.message));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
