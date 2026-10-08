// Duplicate cleanup — URL groups, same-folder marks, empty folders, folder merges.
const DUPE_PAGE_SIZE = 20;
const dupeCleanup = {
    groups: [],
    page: 0,
    marked: new Set()
};
let dupeLocatedNode = null;
let dupeCountCache = { rev: -1, counts: null };

function refreshDupesOnDeleteEnabled() {
    if (typeof readEditorSettings !== 'function') return true;
    return readEditorSettings().refreshDupesOnDelete !== false;
}

function scannedDuplicateContains(node) {
    if (!node || !dupeCleanup.groups.length) return false;
    const match = item => item.node === node;
    if (dupeCleanup.groups.some(group => group.items.some(match))) return true;
    return (node.children || []).some(scannedDuplicateContains);
}

function duplicateUrlKey(uri) {
    try {
        const url = new URL(uri);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const search = url.search || '';
        return `${host}${path}${search}`;
    } catch (e) {
        return String(uri || '').trim().toLowerCase();
    }
}

function duplicateCopiesOf(node) {
    const uri = nodeUri(node);
    if (!uri || !bookmarkData) return 0;
    if (dupeCountCache.rev !== statsDataRev || !dupeCountCache.counts) {
        const counts = new Map();
        collectBookmarkLinks(bookmarkData).forEach(link => {
            const key = duplicateUrlKey(link.uri);
            if (key) counts.set(key, (counts.get(key) || 0) + 1);
        });
        dupeCountCache = { rev: statsDataRev, counts };
    }
    return dupeCountCache.counts.get(duplicateUrlKey(uri)) || 0;
}

function openDuplicatesPane() {
    switchTab('actions-view', document.querySelector('.tab-btn[data-view="actions-view"]'));
    switchChildTab('dupe-cleanup-actions', document.querySelector('.child-tab-btn[data-child="dupe-cleanup-actions"]'));
}

function showRemoveEmptyFolders() {
    openDuplicatesPane();
    const btn = document.getElementById('dupe-remove-empty');
    if (!btn) return;
    btn.scrollIntoView({ block: 'center' });
    btn.focus({ preventScroll: true });
    btn.classList.remove('action-flash');
    void btn.offsetWidth;
    btn.classList.add('action-flash');
}

// Folder-title button: list only the empty folders inside the folder on screen.
function showRemoveEmptyFoldersInFolder() {
    const root = isBookmarkFolderNode(currentFolder) ? currentFolder : null;
    if (!root) return alert('Open a folder first.');
    openDuplicatesPane();
    removeEmptyFoldersCleanup(root);
}

function showDuplicatesForNode(node) {
    const findIndex = () => dupeCleanup.groups.findIndex(group => group.items.some(item => item.node === node));
    let index = findIndex();
    if (index < 0) {
        scanDuplicateBookmarks();
        index = findIndex();
    }
    if (index < 0) return alert('This bookmark has no other copies.');
    dupeCleanup.page = Math.floor(index / DUPE_PAGE_SIZE);
    dupeLocatedNode = node;
    switchTab('actions-view', document.querySelector('.tab-btn[data-view="actions-view"]'));
    switchChildTab('dupe-cleanup-actions', document.querySelector('.child-tab-btn[data-child="dupe-cleanup-actions"]'));
    renderDupeCleanup();
    document.querySelector('#dupe-cleanup-results .dupe-row.dupe-located')?.closest('.dupe-group')?.scrollIntoView({ block: 'center' });
}

function displayDuplicateUrl(uri) {
    return String(uri || '').replace(/^https?:\/\//i, '');
}

function dupeAge(item) {
    const ms = parseBookmarkDateMs(item.node.dateAdded ?? item.node.date_added);
    return ms == null ? Number.MAX_SAFE_INTEGER : ms;
}

function isProtectedCleanupFolder(node) {
    if (!node || node === bookmarkData) return true;
    return Boolean(SPECIAL_FOLDER_GUIDS[node.guid || '']);
}

function collectDuplicateBookmarkGroups() {
    const groups = new Map();
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const key = duplicateUrlKey(link.uri);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(link);
    });
    return [...groups.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([key, items]) => ({
            key,
            url: displayDuplicateUrl(items[0].uri),
            items: items.slice().sort((a, b) => dupeAge(a) - dupeAge(b))
        }))
        .sort((a, b) => b.items.length - a.items.length || a.url.localeCompare(b.url));
}

function duplicatesInFolder(folder) {
    const hits = [];
    dupeCleanup.groups.forEach(group => {
        group.items.forEach(item => {
            if (item.parent === folder) hits.push(item);
        });
    });
    return hits;
}

function sameFolderClusters() {
    const clusters = [];
    dupeCleanup.groups.forEach(group => {
        const byParent = new Map();
        group.items.forEach(item => {
            if (!byParent.has(item.parent)) byParent.set(item.parent, []);
            byParent.get(item.parent).push(item);
        });
        byParent.forEach(items => {
            if (items.length > 1) clusters.push(items.slice().sort((a, b) => dupeAge(a) - dupeAge(b)));
        });
    });
    return clusters;
}

function setDupeNote(text) {
    const note = document.getElementById('dupe-cleanup-note');
    if (note) note.textContent = text || '';
}

function showDupeFolder(folder) {
    if (!folder) return;
    if (typeof switchTabById === 'function') switchTabById('bookmarks-view');
    if (typeof expandFolderAncestors === 'function') expandFolderAncestors(folder);
    if (typeof openFolder === 'function') openFolder(folder);
}

function scanDuplicateBookmarks() {
    if (!bookmarkData) return alert('Library is not loaded.');
    dupeCleanup.groups = collectDuplicateBookmarkGroups();
    dupeCleanup.page = 0;
    dupeCleanup.marked = new Set();
    setDupeNote('');
    renderDupeCleanup();
    logAffected('SYSTEM', 'Duplicate bookmarks', `Find duplicate bookmarks finished. Grouped bookmarks that share host + path + query (www. stripped, trailing slash dropped). ${formatCount(dupeCleanup.groups.length)} group(s) have more than one copy. Mark extras (or Select newest in same folder), then Remove all selected to delete. This scan did not delete anything.`, { source: 'Duplicates', scan: true });
}

function refreshDuplicateBookmarksScan() {
    if (!bookmarkData) return;
    const page = dupeCleanup.page;
    dupeCleanup.groups = collectDuplicateBookmarkGroups();
    dupeCleanup.marked = new Set();
    dupeCleanup.page = page;
    renderDupeCleanup();
}

function maybeRefreshDuplicateBookmarksAfterDelete(nodes) {
    if (!refreshDupesOnDeleteEnabled() || !dupeCleanup.groups.length) return;
    const list = Array.isArray(nodes) ? nodes : [nodes];
    if (!list.some(scannedDuplicateContains)) return;
    refreshDuplicateBookmarksScan();
}

function pruneDuplicateCleanupNodes(nodes) {
    const gone = new Set(nodes || []);
    if (!gone.size || !dupeCleanup.groups.length) return;
    dupeCleanup.groups.forEach(group => {
        group.items = group.items.filter(item => !gone.has(item.node));
    });
    dupeCleanup.groups = dupeCleanup.groups.filter(group => group.items.length > 1);
    gone.forEach(node => dupeCleanup.marked.delete(node));
    renderDupeCleanup();
}

function markedDuplicateCount() {
    let n = 0;
    dupeCleanup.groups.forEach(group => {
        group.items.forEach(item => {
            if (dupeCleanup.marked.has(item.node)) n += 1;
        });
    });
    return n;
}

function renderDupeCleanup() {
    const box = document.getElementById('dupe-cleanup-results');
    if (!box) return;
    const groups = dupeCleanup.groups;
    if (!groups.length) {
        box.innerHTML = '<p>No duplicate bookmarks.</p>';
        return;
    }
    const pages = Math.max(1, Math.ceil(groups.length / DUPE_PAGE_SIZE));
    if (dupeCleanup.page >= pages) dupeCleanup.page = pages - 1;
    if (dupeCleanup.page < 0) dupeCleanup.page = 0;
    const start = dupeCleanup.page * DUPE_PAGE_SIZE;
    const slice = groups.slice(start, start + DUPE_PAGE_SIZE);
    const cards = slice.map((group, offset) => {
        const absolute = start + offset;
        const rows = group.items.map((item, itemIndex) => {
            const checked = dupeCleanup.marked.has(item.node) ? ' checked' : '';
            const folderDupes = duplicatesInFolder(item.parent);
            const folderMarked = folderDupes.length > 0 && folderDupes.every(entry => dupeCleanup.marked.has(entry.node));
            const folderLabel = item.folderPath || folderPathFor(item.node) || '—';
            return `<div class="dupe-row${item.node === dupeLocatedNode ? ' dupe-located' : ''}">
                <label class="dupe-check">
                    <input type="checkbox" data-dupe="toggle" data-group="${absolute}" data-item="${itemIndex}"${checked}>
                    <span class="dupe-title-line">
                        <span class="dupe-title">${escapeHtml(item.title || 'Untitled')}</span>
                        (<a class="dupe-link" href="${escapeHtml(item.uri)}" target="_blank" rel="noopener">${escapeHtml(displayDuplicateUrl(item.uri))}</a>)
                    </span>
                </label>
                <div class="dupe-folder-line">
                    <span class="dupe-folder-label">Folder:</span>
                    <button type="button" class="dupe-folder-path" data-dupe="open-folder" data-group="${absolute}" data-item="${itemIndex}" title="Show this folder in Bookmarks">${escapeHtml(folderLabel)}</button>
                    <span class="dupe-icons">
                        <button type="button" class="dupe-icon-btn" data-dupe="show" data-group="${absolute}" data-item="${itemIndex}" title="Show this bookmark in Bookmarks" aria-label="Show bookmark">👁</button>
                        <button type="button" class="dupe-icon-btn" data-dupe="nearby" data-group="${absolute}" data-item="${itemIndex}" title="Show bookmarks added around this one (Nearby Bookmarks)" aria-label="Nearby bookmarks">⏱</button>
                        <button type="button" class="dupe-icon-btn" data-dupe="domain" data-group="${absolute}" data-item="${itemIndex}" title="Show this site in Statistics → By domain" aria-label="Show in By domain">🌐</button>
                        <button type="button" class="dupe-icon-btn" data-dupe="folder" data-group="${absolute}" data-item="${itemIndex}" title="Mark or unmark every duplicate in this folder, across all groups" aria-label="${folderMarked ? 'Unmark folder' : 'Mark folder'}">${folderMarked ? '☑' : '☐'}</button>
                    </span>
                </div>
            </div>`;
        }).join('');
        return `<section class="dupe-group">
            <div class="dupe-url">
                <span>URL: ${escapeHtml(group.url)}</span>
                <button type="button" class="dupe-icon-btn dupe-trash" data-dupe="group" data-group="${absolute}" title="Mark every copy except the oldest" aria-label="Mark extras">🗑</button>
            </div>
            ${rows}
        </section>`;
    }).join('');
    const selected = markedDuplicateCount();
    box.innerHTML = `
        <p class="dupe-count">${formatCount(groups.length)} duplicate group${groups.length === 1 ? '' : 's'} found</p>
        ${cards || '<p>No groups on this page.</p>'}
        <div class="dupe-pager">
            <button type="button" class="ghost-btn" data-dupe="page" data-delta="-1"${dupeCleanup.page === 0 ? ' disabled' : ''}>Previous</button>
            <span>${dupeCleanup.page + 1} / ${pages}</span>
            <button type="button" class="ghost-btn" data-dupe="page" data-delta="1"${dupeCleanup.page >= pages - 1 ? ' disabled' : ''}>Next</button>
        </div>
        <div class="dupe-actions">
            <button type="button" class="ghost-btn" data-dupe="same-folder">Select in same folder</button>
            <button type="button" class="action-btn" data-dupe="remove"${selected ? '' : ' disabled'}>Remove all selected [${formatCount(selected)}]</button>
        </div>
    `;
    box.querySelectorAll('[data-dupe]').forEach(el => {
        el.addEventListener('click', event => {
            if (el.tagName === 'INPUT') return;
            event.preventDefault();
            handleDupeCleanupAction(el);
        });
        if (el.tagName === 'INPUT') {
            el.addEventListener('change', () => handleDupeCleanupAction(el));
        }
    });
}

function dupeItem(el) {
    const group = dupeCleanup.groups[Number(el.dataset.group)];
    if (!group) return null;
    return { group, item: group.items[Number(el.dataset.item)] };
}

function handleDupeCleanupAction(el) {
    const action = el.dataset.dupe;
    if (action === 'page') {
        dupeCleanup.page += Number(el.dataset.delta) || 0;
        renderDupeCleanup();
        return;
    }
    if (action === 'toggle') {
        const found = dupeItem(el);
        if (!found?.item) return;
        if (el.checked) dupeCleanup.marked.add(found.item.node);
        else dupeCleanup.marked.delete(found.item.node);
        renderDupeCleanup();
        return;
    }
    if (action === 'folder') {
        const found = dupeItem(el);
        if (!found?.item) return;
        const hits = duplicatesInFolder(found.item.parent);
        const allMarked = hits.length > 0 && hits.every(entry => dupeCleanup.marked.has(entry.node));
        hits.forEach(entry => {
            if (allMarked) dupeCleanup.marked.delete(entry.node);
            else dupeCleanup.marked.add(entry.node);
        });
        renderDupeCleanup();
        return;
    }
    if (action === 'open-folder') {
        const found = dupeItem(el);
        if (found?.item) showDupeFolder(found.item.parent);
        return;
    }
    if (action === 'show') {
        const found = dupeItem(el);
        if (found?.item && typeof revealBookmark === 'function') revealBookmark(found.item);
        return;
    }
    if (action === 'nearby') {
        const found = dupeItem(el);
        if (found?.item) openNearbyBookmarks(found.item.node);
        return;
    }
    if (action === 'domain') {
        const found = dupeItem(el);
        if (found?.item) findUriInDomainStats(found.item.uri);
        return;
    }
    if (action === 'group') {
        const group = dupeCleanup.groups[Number(el.dataset.group)];
        if (!group) return;
        const extras = group.items.slice(1);
        const allMarked = extras.length > 0 && extras.every(entry => dupeCleanup.marked.has(entry.node));
        extras.forEach(entry => {
            if (allMarked) dupeCleanup.marked.delete(entry.node);
            else dupeCleanup.marked.add(entry.node);
        });
        if (!allMarked) dupeCleanup.marked.delete(group.items[0].node);
        renderDupeCleanup();
        return;
    }
    if (action === 'same-folder') {
        sameFolderClusters().forEach(items => items.forEach(item => dupeCleanup.marked.add(item.node)));
        renderDupeCleanup();
        return;
    }
    if (action === 'remove') {
        if (!markedDuplicateCount()) return;
        removeSelectedDuplicates();
    }
}

function markNewestSameFolderDupes() {
    if (!dupeCleanup.groups.length) return alert('Find duplicate bookmarks first.');
    sameFolderClusters().forEach(items => {
        items.slice(1).forEach(item => dupeCleanup.marked.add(item.node));
        dupeCleanup.marked.delete(items[0].node);
    });
    renderDupeCleanup();
    setDupeNote(`Selected the newest copy in each same-folder cluster. ${formatCount(dupeCleanup.marked.size)} bookmark(s) checked. The oldest copy stays unchecked. Use Remove all selected to delete them.`);
}

function nestedOuterDupes() {
    const parentOf = new Map();
    walkBookmarkTree(bookmarkData, (node, parent) => {
        if (parent) parentOf.set(node, parent);
    });
    const isInside = (folder, ancestor) => {
        for (let node = parentOf.get(folder); node; node = parentOf.get(node)) {
            if (node === ancestor) return true;
        }
        return false;
    };
    const outer = [];
    dupeCleanup.groups.forEach(group => {
        group.items.forEach(item => {
            if (group.items.some(other => other !== item && isInside(other.parent, item.parent))) outer.push(item);
        });
    });
    return outer;
}

function markOuterNestedDupes() {
    if (!dupeCleanup.groups.length) return alert('Find duplicate bookmarks first.');
    const outer = nestedOuterDupes();
    outer.forEach(item => dupeCleanup.marked.add(item.node));
    renderDupeCleanup();
    setDupeNote(outer.length
        ? `Selected ${formatCount(outer.length)} outer copy(ies) whose URL is also saved in a subfolder of the same folder. The most deeply nested copy stays unchecked. Use Remove all selected to delete them.`
        : 'No duplicate has one copy in a folder and another inside one of its subfolders.');
}

function removeSelectedDuplicates() {
    const removals = [];
    dupeCleanup.groups.forEach(group => {
        group.items.forEach(item => {
            if (dupeCleanup.marked.has(item.node)) removals.push(item);
        });
    });
    if (!removals.length) return alert('No bookmarks are marked.');
    if (!confirm(`Remove ${formatCount(removals.length)} selected bookmark(s)?`)) return;
    const removed = withUndo('Remove selected duplicates', api => {
        removals.forEach(item => {
            api.remove(item.node, item.parent);
            logAffected('REMOVED', item.title, 'Removed duplicate bookmark.', {
                source: 'Duplicates',
                node: item.node,
                uri: item.uri,
                folderPath: item.folderPath
            });
        });
    });
    if (!removed) return;
    markChanged();
    renderSidebar();
    if (refreshDupesOnDeleteEnabled()) refreshDuplicateBookmarksScan();
    else pruneDuplicateCleanupNodes(removals.map(item => item.node));
    setDupeNote(`Removed ${formatCount(removals.length)} bookmark(s).`);
}

function collectEmptyCleanupFolders() {
    const empty = [];
    walkBookmarkTree(bookmarkData, (node, parent) => {
        if (!parent || !isBookmarkFolderNode(node) || isProtectedCleanupFolder(node)) return;
        if (!(node.children || []).length) empty.push({ node, parent });
    });
    return empty;
}

function emptyFolderPath(node) {
    const parentPath = folderPathFor(node);
    return parentPath ? `${parentPath} / ${displayFolderTitle(node)}` : displayFolderTitle(node);
}

function planEmptyFolderRemoval(root = bookmarkData) {
    const plan = [];
    walkBookmarkTree(root, (node, parent) => {
        if (!parent || !isBookmarkFolderNode(node) || isProtectedCleanupFolder(node)) return;
        if (holdsOnlyEmptyFolders(node)) plan.push({ node, parent, path: emptyFolderPath(node) });
    });
    return plan;
}

function emptyFolderListHtml(items, picking) {
    return `<ul class="empty-folder-list${picking ? ' picking' : ''}">${items.map((item, i) => picking
        ? `<li><label><input type="checkbox" data-empty-pick="${i}" checked></label><button type="button" class="dupe-folder-path" data-empty-open="${i}" title="Show this folder in Bookmarks">${escapeHtml(item.path)}</button></li>`
        : `<li>${escapeHtml(item.path)}</li>`).join('')}</ul>`;
}

function removeEmptyFoldersCleanup(root) {
    if (!bookmarkData) return alert('Library is not loaded.');
    // The Duplicates button passes its click event, so anything that is not a folder means the whole library.
    const scope = isBookmarkFolderNode(root) ? root : bookmarkData;
    const scopeName = scope === bookmarkData ? '' : displayFolderTitle(scope);
    const plan = planEmptyFolderRemoval(scope);
    const note = document.getElementById('dupe-cleanup-note');
    if (!plan.length || !note) {
        setDupeNote(scopeName ? `No empty folders inside ${scopeName}.` : 'No empty folders.');
        return;
    }
    plan.forEach(item => { item.checked = true; });
    note.innerHTML = `<span>${formatCount(plan.length)} empty folder(s)${scopeName ? ` inside ${escapeHtml(scopeName)}` : ''} can be removed, including parents that only hold empty folders. Uncheck any to keep:</span>
        ${emptyFolderListHtml(plan, true)}
        <span class="empty-folder-actions"><button type="button" class="action-btn" data-empty-confirm></button><button type="button" class="ghost-btn" data-empty-cancel>Cancel</button></span>`;
    const confirmBtn = note.querySelector('[data-empty-confirm]');
    const sync = () => {
        note.querySelectorAll('[data-empty-pick]').forEach(box => { box.checked = plan[Number(box.dataset.emptyPick)].checked; });
        const count = plan.filter(item => item.checked).length;
        confirmBtn.disabled = !count;
        confirmBtn.textContent = `Remove ${formatCount(count)} folder(s)`;
    };
    note.querySelectorAll('[data-empty-pick]').forEach(box => {
        box.onchange = () => {
            const item = plan[Number(box.dataset.emptyPick)];
            item.checked = box.checked;
            plan.forEach(other => {
                if (other === item) return;
                if (box.checked && isNodeInSubtree(item.node, other.node)) other.checked = true;
                if (!box.checked && isNodeInSubtree(other.node, item.node)) other.checked = false;
            });
            sync();
        };
    });
    note.querySelectorAll('[data-empty-open]').forEach(btn => {
        btn.onclick = () => showDupeFolder(plan[Number(btn.dataset.emptyOpen)]?.node);
    });
    note.querySelector('[data-empty-cancel]').onclick = () => setDupeNote('');
    confirmBtn.onclick = () => applyEmptyFolderRemoval(plan);
    sync();
}

function applyEmptyFolderRemoval(plan) {
    const picked = plan.filter(item => item.checked
        && isNodeInSubtree(bookmarkData, item.node)
        && holdsOnlyEmptyFolders(item.node)
        && !plan.some(other => !other.checked && isNodeInSubtree(item.node, other.node)));
    const tops = picked.filter(item => !picked.some(other => other !== item && isNodeInSubtree(other.node, item.node)));
    if (!tops.length) return;
    const removed = [];
    withUndo('Remove empty folders', api => {
        tops.forEach(item => {
            const parent = findNodeParent(item.node);
            if (!parent) return;
            picked.filter(other => isNodeInSubtree(item.node, other.node)).forEach(other => {
                removed.push({ path: other.path });
                logAffected('REMOVED', displayFolderTitle(other.node), 'Removed empty folder.', {
                    source: 'Duplicates',
                    node: other.node
                });
            });
            api.remove(item.node, parent);
        });
    });
    markChanged();
    renderSidebar();
    if (dupeCleanup.groups.length && refreshDupesOnDeleteEnabled()) refreshDuplicateBookmarksScan();
    const note = document.getElementById('dupe-cleanup-note');
    if (!note) return;
    removed.sort((a, b) => a.path.localeCompare(b.path));
    const kept = plan.length - removed.length;
    note.innerHTML = `<span>Removed ${formatCount(removed.length)} empty folder(s).${kept > 0 ? ` Kept ${formatCount(kept)}.` : ''}</span>${removed.length ? emptyFolderListHtml(removed, false) : ''}`;
}

function folderMergeListHtml(items, picking) {
    return `<ul class="empty-folder-list${picking ? ' picking' : ''}">${items.map((item, i) => {
        const text = `${item.path} → ${displayFolderTitle(item.keep)} (${formatCount(item.count)} item${item.count === 1 ? '' : 's'})`;
        return picking
            ? `<li><label><input type="checkbox" data-merge-pick="${i}" checked></label><button type="button" class="dupe-folder-path" data-merge-open="${i}" title="Show this folder in Bookmarks">${escapeHtml(text)}</button></li>`
            : `<li>${escapeHtml(text)}</li>`;
    }).join('')}</ul>`;
}

function mergeDuplicateFoldersCleanup() {
    if (!bookmarkData) return alert('Library is not loaded.');
    if (typeof collectDuplicateFolderMerges !== 'function') return alert('Folder merge is not available.');
    const merges = collectDuplicateFolderMerges();
    const note = document.getElementById('dupe-cleanup-note');
    if (!merges.length || !note) {
        setDupeNote('No duplicate sibling folders.');
        return;
    }
    merges.forEach(item => {
        item.checked = true;
        item.path = emptyFolderPath(item.folder);
    });
    note.innerHTML = `<span>${formatCount(merges.length)} duplicate sibling folder(s) can merge into the older folder with the same name. Uncheck any to keep:</span>
        ${folderMergeListHtml(merges, true)}
        <span class="empty-folder-actions"><button type="button" class="action-btn" data-merge-confirm></button><button type="button" class="ghost-btn" data-merge-cancel>Cancel</button></span>`;
    const confirmBtn = note.querySelector('[data-merge-confirm]');
    const sync = () => {
        const count = merges.filter(item => item.checked).length;
        confirmBtn.disabled = !count;
        confirmBtn.textContent = `Merge ${formatCount(count)} folder(s)`;
    };
    note.querySelectorAll('[data-merge-pick]').forEach(box => {
        box.onchange = () => {
            merges[Number(box.dataset.mergePick)].checked = box.checked;
            sync();
        };
    });
    note.querySelectorAll('[data-merge-open]').forEach(btn => {
        btn.onclick = () => showDupeFolder(merges[Number(btn.dataset.mergeOpen)]?.folder);
    });
    note.querySelector('[data-merge-cancel]').onclick = () => setDupeNote('');
    confirmBtn.onclick = () => applyDuplicateFolderCleanup(merges);
    sync();
}

function applyDuplicateFolderCleanup(merges) {
    const picked = merges.filter(item => item.checked
        && isNodeInSubtree(bookmarkData, item.folder)
        && isNodeInSubtree(bookmarkData, item.keep)
        && findNodeParent(item.folder) === item.parent);
    if (!picked.length) return;
    withUndo('Merge duplicate folders', api => {
        picked.forEach(item => {
            [...(item.folder.children || [])].forEach(child => api.move(child, item.folder, item.keep));
            api.remove(item.folder, item.parent);
            logAffected('MODIFIED', displayFolderTitle(item.keep), `Merged “${displayFolderTitle(item.folder)}” into “${displayFolderTitle(item.keep)}”.`, {
                source: 'Duplicates',
                node: item.keep
            });
        });
    });
    markChanged();
    renderSidebar();
    if (dupeCleanup.groups.length && refreshDupesOnDeleteEnabled()) refreshDuplicateBookmarksScan();
    const note = document.getElementById('dupe-cleanup-note');
    if (!note) return;
    const kept = merges.length - picked.length;
    note.innerHTML = `<span>Merged ${formatCount(picked.length)} duplicate folder(s).${kept > 0 ? ` Kept ${formatCount(kept)}.` : ''}</span>${folderMergeListHtml(picked, false)}`;
}
