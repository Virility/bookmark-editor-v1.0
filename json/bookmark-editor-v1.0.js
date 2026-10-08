// Bookmark Editor v1.0 — UI state, library view, undo. Shared helpers live in js/bookmark-lib.js.
let bookmarkData = null;
let currentFolder = null;
let lastFolderHits = [];
let pendingSearchMove = null;
let hasUnsavedChanges = false;
let rightClickedItem = null;
let rightClickedFolder = null;
let locationContextUri = '';
const folderTreeItems = new WeakMap();
// folderTreeItems is a WeakMap (get/set/has only). Anything that has to iterate the rendered
// tree walks this list instead; renderSidebar() empties it and buildTree() refills it.
const treeItemList = [];
const treeItemNodes = new WeakMap();
let treeSelection = [];
let treeSelectionAnchor = null;
let librarySelection = [];
let libraryAnchor = null;
let libraryDragNodes = [];
let librarySort = { key: '', dir: 1 };
// How many result rows the table draws before it stops, and the identity of the search those rows
// belong to: a new folder, query, scope or sort starts a fresh page, "Show more" grows the current
// one. See renderFolderContents.
const RESULT_ROW_PAGE = 300;
let resultRowLimit = RESULT_ROW_PAGE;
let resultRowKey = '';
let hoverTipNode = null;
let folderSubredditsExpanded = false;

// --- View & Tab Switching ---
function switchTab(viewId, btnElement) {
    const pane = document.getElementById(viewId);
    if (!pane) return;
    document.querySelectorAll('.view-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    pane.classList.add('active');
    if (btnElement) btnElement.classList.add('active');
    if (viewId === 'stats-view') {
        if (typeof renderStatistics === 'function') renderStatistics();
    } else if (viewId === 'tabs-view') {
        if (typeof renderOpenTabs === 'function') renderOpenTabs();
        if (typeof closeStatsPanel === 'function') closeStatsPanel();
    } else if (viewId === 'docs-view') {
        if (typeof renderDocumentation === 'function') renderDocumentation();
        if (typeof closeStatsPanel === 'function') closeStatsPanel();
    } else if (typeof closeStatsPanel === 'function') {
        closeStatsPanel();
    }
    if (viewId === 'bookmarks-view' && typeof applySidebarWidth === 'function') {
        applySidebarWidth(currentSidebarWidth(), false);
    }
}

function switchTabById(viewId) {
    const btn = document.querySelector(`.tab-btn[data-view="${viewId}"]`);
    if (btn) switchTab(viewId, btn);
}

function switchChildTab(paneId, btnElement) {
    const pane = document.getElementById(paneId);
    if (!pane) return;
    document.querySelectorAll('.child-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.child-tab-btn').forEach(el => el.classList.remove('active'));
    pane.classList.add('active');
    if (btnElement) btnElement.classList.add('active');
}

const SCRIPT_EXAMPLES = {
    count: `let count = 0;
api.walk(node => { if (node.uri) count++; });
return count + ' link(s)';`,
    folder: `const folder = api.selectedFolder();
if (!folder) return 'No folder is open.';
const lines = [];
(folder.children || []).forEach(node => {
    lines.push((node.uri ? '🔖 ' : '📁 ') + (node.title || 'Untitled'));
});
return folder.title + '\\n' + (lines.join('\\n') || '(empty)');`,
    missing: `const missing = [];
api.walk(node => {
    if (node.children || node.uri) return;
    missing.push(node.title || '(untitled)');
});
api.log('SCRIPT', 'Bookmarks missing a URL', missing.length + ' bookmark(s).');
return missing.join('\\n') || 'Every bookmark has a URL.';`
};

function loadScriptExample(key) {
    const source = SCRIPT_EXAMPLES[key];
    const area = document.getElementById('bookmark-script');
    if (!source || !area) return;
    area.value = source;
    area.focus();
}

function runBookmarkScript() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const source = document.getElementById('bookmark-script').value.trim();
    const output = document.getElementById('script-output');
    if (!source) return alert('Paste a script first.');

    const api = {
        walk(callback, node = bookmarkData, parent = null) {
            callback(node, parent);
            if (node.children) node.children.forEach(child => api.walk(callback, child, node));
        },
        log: logAffected,
        markChanged,
        selectedFolder: () => currentFolder,
        youtubeId: extractYouTubeID,
        canonicalYouTubeUrl
    };
    try {
        const result = new Function('bookmarks', 'api', `'use strict';\n${source}`)(bookmarkData, api);
        markChanged();
        renderSidebar();
        output.className = 'script-output success';
        output.textContent = result === undefined ? 'Script completed. Changes are marked as unsaved.' : `Completed: ${String(result)}`;
        logAffected('SCRIPT', 'Custom bookmark script', 'A pasted JavaScript action was run against the loaded tree.', {
            source: 'Script Lab',
            reason: `${source.split('\n').length} line(s), ${source.length} characters`
        });
    } catch (error) {
        output.className = 'script-output error';
        output.textContent = `Error: ${error.message}`;
    }
}

// --- Affected Logging ---
const AFFECTED_LOG_KEY = 'bookmark-editor-affected-log';
const AFFECTED_LOG_WEEK = 7 * 24 * 60 * 60 * 1000;
let affectedLog = [];
let affectedLogSaveTimer = null;

function pruneAffectedLog() {
    const cutoff = Date.now() - AFFECTED_LOG_WEEK;
    const next = affectedLog.filter(entry => entry && entry.at >= cutoff);
    const changed = next.length !== affectedLog.length;
    affectedLog = next;
    return changed;
}

function saveAffectedLog() {
    pruneAffectedLog();
    const write = () => localStorage.setItem(AFFECTED_LOG_KEY, JSON.stringify(affectedLog));
    try {
        write();
    } catch (err) {
        affectedLog = affectedLog.slice(0, Math.ceil(affectedLog.length / 2));
        try { write(); } catch (again) { /* storage is full */ }
    }
}

function scheduleAffectedLogSave() {
    clearTimeout(affectedLogSaveTimer);
    affectedLogSaveTimer = setTimeout(saveAffectedLog, 400);
}

function affectedLogMetaText() {
    const n = affectedLog.length;
    return `${n} event${n === 1 ? '' : 's'} kept for 7 days. Newest first.`;
}


// --- Trash, notes, per-folder sort memory, settings files, JSON merge ---
const TRASH_STORAGE_KEY = 'bookmark-editor-trash';
const TRASH_LIMIT = 50;
const NOTES_STORAGE_KEY = 'bookmark-editor-notes';
const SORT_MEMORY_KEY = 'bookmark-editor-sort-memory';
const PROTECTED_FOLDERS_KEY = 'bookmark-editor-protected-folders';
const STORAGE_SCHEMA_KEY = 'bookmark-editor-schema';

function readJsonStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
    } catch (err) {
        return fallback;
    }
}

function writeJsonStorage(key, value, quiet = false) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        if (!quiet) console.error(err);
        return false;
    }
}

// Everything the editor reads out of this browser at startup. Called from init(); each loader
// is defensive, so a missing key, a broken value or an absent extension API cannot stop the
// others from running.
function loadEditorStores() {
    const loaders = [
        loadProtectedFolders,
        loadTidySettings,
        loadStoredNotes,
        migrateStorage,
        paintStorageUsage,
        loadSearchHistory,
        watchSystemTheme,
        loadUrlRules,
        loadColumnWidths,
        loadSmartFolders,
        loadScheduledJobs,
        listenForLibraryChanges,
        checkLibraryChangedSinceLoad,
        stampLibraryLoad
    ];
    loaders.forEach(load => {
        try {
            load();
        } catch (err) {
            console.error(err);
        }
    });
}

function diffBookmarkTrees(here, there) {
    const mine = flattenBookmarkIndex(here);
    const theirs = flattenBookmarkIndex(there);
    const added = [];
    const removed = [];
    const changed = [];
    theirs.forEach((links, uri) => {
        if (!mine.has(uri)) added.push(links[0]);
    });
    mine.forEach((links, uri) => {
        if (!theirs.has(uri)) removed.push(links[0]);
        else if ((links[0].title || '') !== (theirs.get(uri)[0].title || '')) {
            changed.push({ ...links[0], otherTitle: theirs.get(uri)[0].title });
        }
    });
    return { added, removed, changed };
}

// --- trash: deletions survive a reload ---
let trashEntries = [];
let trashDraft = null;

function loadTrash() {
    const stored = readJsonStorage(TRASH_STORAGE_KEY, []);
    trashEntries = Array.isArray(stored) ? stored.filter(entry => entry && Array.isArray(entry.items)) : [];
}

function saveTrash() {
    trashEntries = trashEntries.slice(0, TRASH_LIMIT);
    writeJsonStorage(TRASH_STORAGE_KEY, trashEntries, true);
}

function folderPathLabel(node) {
    if (!node) return '';
    const parentPath = folderPathFor(node);
    const own = displayFolderTitle(node);
    return parentPath ? `${parentPath} / ${own}` : own;
}

function recordTrashRemoval(node, parent, index) {
    if (!node || !parent) return;
    let copy = null;
    try { copy = JSON.parse(JSON.stringify(node)); } catch (err) { copy = null; }
    if (!copy) return;
    if (!trashDraft) trashDraft = [];
    trashDraft.push({
        node: copy,
        parentPath: folderPathLabel(parent),
        parentGuid: String(parent.guid || ''),
        index: Number.isInteger(index) ? index : -1
    });
}

function flushTrashDraft(label) {
    const draft = trashDraft;
    trashDraft = null;
    if (!draft || !draft.length) return;
    trashEntries.unshift({ id: `trash-${Date.now()}-${trashEntries.length}`, at: Date.now(), label: label || 'Delete', items: draft });
    saveTrash();
}

function openTrashDialog() {
    renderTrashDialog();
    const dialog = document.getElementById('trash-dialog');
    if (dialog) dialog.hidden = false;
}

function closeTrashDialog() {
    const dialog = document.getElementById('trash-dialog');
    if (dialog) dialog.hidden = true;
}

function renderTrashDialog() {
    const list = document.getElementById('trash-list');
    const note = document.getElementById('trash-note');
    const undoEmpty = document.getElementById('trash-undo-clear');
    if (undoEmpty) undoEmpty.hidden = !(lastClearedTrash && lastClearedTrash.length);
    const restoreAll = document.getElementById('trash-restore-all');
    if (restoreAll) restoreAll.disabled = !trashEntries.length;
    if (!list) return;
    const total = trashEntries.reduce((sum, entry) => sum + entry.items.length, 0);
    if (note) {
        note.textContent = trashEntries.length
            ? `${formatCount(trashEntries.length)} deletion step(s), ${formatCount(total)} entr(y/ies), kept in this browser until you empty the trash.`
            : 'Nothing has been deleted yet. Deletions are kept here across reloads until you empty the trash.';
    }
    list.innerHTML = trashEntries.length
        ? trashEntries.map(entry => `<div class="trash-row">
            <div class="trash-row-main">
                <div class="trash-row-title">${escapeHtml(entry.label)} — ${formatCount(entry.items.length)} entr(y/ies)</div>
                <div class="trash-row-meta">${escapeHtml(new Date(entry.at).toLocaleString())}${entry.items[0] ? ` · ${escapeHtml(entry.items[0].parentPath || 'unknown folder')}` : ''}</div>
            </div>
            <button type="button" class="action-btn" data-trash-restore="${escapeHtml(entry.id)}">Restore</button>
        </div>`).join('')
        : '<p class="dupe-empty">The trash is empty.</p>';
    list.querySelectorAll('[data-trash-restore]').forEach(btn => {
        btn.onclick = () => restoreTrashEntry(btn.dataset.trashRestore);
    });
}

function findNodeByGuid(guid) {
    const key = String(guid || '');
    if (!key || !bookmarkData) return null;
    let found = null;
    walkBookmarkTree(bookmarkData, node => {
        if (!found && String(node.guid || '') === key) found = node;
    });
    return found;
}

function restoreTrashEntry(id) {
    const entry = trashEntries.find(item => item.id === id);
    if (!entry) return;
    const other = findSpecialFolder('unfiled_____');
    const restored = [];
    withUndo('Restore from trash', api => {
        entry.items.forEach(item => {
            let parent = null;
            if (typeof resolveFolderPath === 'function') parent = resolveFolderPath(item.parentPath);
            if (!parent) parent = findNodeByGuid(item.parentGuid);
            if (!parent || !isBookmarkFolderNode(parent)) parent = other || bookmarkData;
            if (!parent) return;
            api.create(parent, item.node, item.index >= 0 ? item.index : undefined);
            restored.push(item.node);
            logAffected('ADDED', libraryNodeName(item.node) || 'Restored entry', `Restored from the trash (“${entry.label}”).`, {
                source: 'Trash',
                node: item.node,
                uri: nodeUri(item.node),
                folderPath: item.parentPath
            });
        });
    });
    trashEntries = trashEntries.filter(item => item.id !== id);
    saveTrash();
    markChanged();
    renderSidebar();
    renderTrashDialog();
    if (!restored.length) return alert('Nothing could be restored: the folders those entries lived in are gone.');
    if (currentFolder) renderFolderContents(currentFolder);
}

function clearTrash() {
    if (!trashEntries.length) return alert('The trash is already empty.');
    if (!confirm(`Empty the trash (${formatCount(trashEntries.length)} deletion step(s))? Those deletions stay undone.`)) return;
    lastClearedTrash = trashEntries.slice();
    trashEntries = [];
    saveTrash();
    renderTrashDialog();
    logAffected('SYSTEM', 'Trash', `Emptied ${formatCount(lastClearedTrash.length)} deletion step(s) from the trash. They can be put back until this tab is closed.`, { source: 'Trash', kind: 'delete' });
}

// --- bookmark notes (kept by the app; Firefox's API cannot store descriptions) ---
let storedNotes = {};

function loadStoredNotes() {
    const parsed = readJsonStorage(NOTES_STORAGE_KEY, {});
    storedNotes = parsed && typeof parsed === 'object' ? parsed : {};
}

function noteKeyFor(node) {
    const uri = nodeUri(node);
    return uri ? bookmarkUrlKey(uri) : '';
}

function noteFor(node) {
    const key = noteKeyFor(node);
    return key && storedNotes[key] ? storedNotes[key].description || '' : '';
}

function saveNote(node, text) {
    const key = noteKeyFor(node);
    if (!key) return false;
    const value = String(text || '').trim();
    if (value) storedNotes[key] = { description: value, at: Date.now() };
    else delete storedNotes[key];
    const ok = writeJsonStorage(NOTES_STORAGE_KEY, storedNotes);
    if (!ok) alert('The note could not be saved: this browser’s storage is full.');
    return ok;
}

function applyNoteToNode(node) {
    if (!node) return;
    const note = noteFor(node);
    if (note) node.description = note;
}

function applyStoredNotes(root) {
    if (!root) return;
    walkBookmarkTree(root, node => applyNoteToNode(node));
}

// --- per-folder sort memory ---
let sortMemory = {};

function loadSortMemory() {
    const parsed = readJsonStorage(SORT_MEMORY_KEY, {});
    sortMemory = parsed && typeof parsed === 'object' ? parsed : {};
}

function saveSortMemory() {
    writeJsonStorage(SORT_MEMORY_KEY, sortMemory, true);
}

function rememberLibrarySort() {
    if (!currentFolder) return;
    const key = folderPathLabel(currentFolder);
    if (!key) return;
    if (!librarySort.key) delete sortMemory[key];
    else sortMemory[key] = { key: librarySort.key, dir: librarySort.dir };
    saveSortMemory();
    updateLibrarySortReset();
}

function applyRememberedLibrarySort(folderNode) {
    const remembered = folderNode ? sortMemory[folderPathLabel(folderNode)] : null;
    librarySort = remembered ? { key: remembered.key, dir: remembered.dir } : { key: '', dir: 1 };
    updateLibrarySortReset();
}

function updateLibrarySortReset() {
    const btn = document.getElementById('sort-reset');
    if (!btn) return;
    btn.hidden = !librarySort.key;
    const sortLabels = { name: 'Name', location: 'Location', added: 'Added' };
    btn.textContent = librarySort.key
        ? `Reset sort (${sortLabels[librarySort.key] || librarySort.key} ${librarySort.dir > 0 ? '↑' : '↓'})`
        : 'Reset sort';
}

function resetLibrarySort() {
    librarySort = { key: '', dir: 1 };
    rememberLibrarySort();
    updateLibrarySortHeaders();
    if (currentFolder) renderFolderContents(currentFolder);
}

// --- settings as a file ---
function exportEditorSettings() {
    const settings = readEditorSettings();
    const name = 'bookmark-editor-settings.json';
    downloadTextFile(name, JSON.stringify(settings, null, 2), 'application/json');
    logAffected('SYSTEM', name, `Exported ${formatCount(Object.keys(settings).length)} editor setting(s) as JSON: ${Object.keys(settings).join(', ')}. The file is a copy; nothing changed.`, { source: 'Settings', kind: 'export', reason: 'Browser download started.' });
}

function pickSettingsImport() {
    document.getElementById('settings-upload')?.click();
}

function importEditorSettings(event) {
    const input = event && event.target;
    const file = input && input.files ? input.files[0] : null;
    if (input) input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        let parsed = null;
        try { parsed = JSON.parse(e.target.result); } catch (err) { return alert(`Could not parse that JSON: ${err.message}`); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return alert('That file does not hold a settings object.');
        const known = Object.keys(EDITOR_SETTING_DEFAULTS);
        const applied = known.filter(key => Object.prototype.hasOwnProperty.call(parsed, key));
        if (!applied.length) return alert(`No known setting in “${file.name}”. Known settings: ${known.join(', ')}.`);
        if (!confirm(`Import ${formatCount(applied.length)} setting(s) from “${file.name}”? Current values are replaced.`)) return;
        const current = readEditorSettings();
        const next = { ...current };
        applied.forEach(key => { next[key] = parsed[key]; });
        applyEditorSettings(next);
        try { localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(next)); } catch (err) {}
        logAffected('SYSTEM', file.name, `Imported ${formatCount(applied.length)} setting(s) from “${file.name}”: ${applied.join(', ')}. Settings are stored in this browser.`, { source: 'Settings', kind: 'import' });
        alert(`Applied ${applied.length} setting(s).${known.length !== applied.length ? ` ${known.length - applied.length} known setting(s) were not in the file and kept their values.` : ''}`);
    };
    reader.readAsText(file);
}

// --- JSON merge (import replaces; this adds what is missing) ---
function pickJsonMerge() {
    document.getElementById('merge-upload')?.click();
}

function stripMergedIds(node) {
    if (!node || typeof node !== 'object') return;
    delete node.id;
    (node.children || []).forEach(stripMergedIds);
}

function mergeSubtreeStats(node) {
    const stats = { links: 0, folders: 0, keys: [] };
    const walk = current => {
        (current.children || []).forEach(child => {
            if (isBookmarkFolderNode(child)) {
                stats.folders += 1;
                walk(child);
                return;
            }
            const uri = nodeUri(child);
            if (!uri) return;
            stats.links += 1;
            stats.keys.push(bookmarkUrlKey(uri));
        });
    };
    walk(node);
    return stats;
}

function planJsonMerge(current, incoming, policy = 'skip') {
    const updates = [];
    const existing = existingLinksByKey(current);
    const seen = new Set();
    // Same key the duplicate scan uses, so a URL saved with different tracking parameters
    // still counts as already present.
    flattenBookmarkIndex(current).forEach((links, uri) => seen.add(libraryUrlKey(uri)));
    // New top-level folders land in Other Bookmarks: folders directly under the library root
    // are the browser's own and the editor refuses to nest or delete them.
    const rootFallback = findSpecialFolder('unfiled_____');
    const creates = [];
    let links = 0;
    let folders = 0;
    let skipped = 0;
    const walk = (currentParent, children) => {
        (children || []).forEach(child => {
            if (!child) return;
            if (isBookmarkFolderNode(child)) {
                const title = String(child.title || '').trim().toLowerCase();
                const match = (currentParent.children || []).find(node => isBookmarkFolderNode(node) && String(node.title || '').trim().toLowerCase() === title);
                if (match) {
                    walk(match, child.children);
                    return;
                }
                const copy = JSON.parse(JSON.stringify(child));
                stripMergedIds(copy);
                copy._modified = true;
                const target = currentParent === bookmarkData && rootFallback && rootFallback !== currentParent ? rootFallback : currentParent;
                creates.push({ parent: target, node: copy });
                const stats = mergeSubtreeStats(copy);
                folders += 1 + stats.folders;
                links += stats.links;
                stats.keys.forEach(key => seen.add(key));
                return;
            }
            const uri = nodeUri(child);
            if (!uri) return;
            const key = libraryUrlKey(uri);
            // A URL repeated inside the same file is always skipped; a URL that already
            // exists in the library goes through the chosen merge policy instead.
            if (seen.has(key) && !existing.has(key)) {
                skipped += 1;
                return;
            }
            const already = existing.get(key) || [];
            if (already.length && policy !== 'keep-both') {
                already.forEach(node => {
                    if ((node.title || '') === (child.title || '')) return;
                    const wins = policy === 'overwrite'
                        || (policy === 'prefer-newer' && nodeTimestamp(child) > nodeTimestamp(node));
                    if (wins) updates.push({ node, title: child.title || '', from: node.title || '' });
                });
                skipped += 1;
                seen.add(key);
                return;
            }
            seen.add(key);
            const copy = JSON.parse(JSON.stringify(child));
            stripMergedIds(copy);
            copy._modified = true;
            const target = currentParent === bookmarkData && rootFallback && rootFallback !== currentParent ? rootFallback : currentParent;
            creates.push({ parent: target, node: copy });
            links += 1;
        });
    };
    const top = incoming && Array.isArray(incoming.children) ? incoming.children : (Array.isArray(incoming) ? incoming : []);
    walk(current, top);
    return { creates, links, folders, skipped, updates, policy };
}

function mergeBookmarkFile(event) {
    const input = event && event.target;
    const file = input && input.files ? input.files[0] : null;
    if (input) input.value = '';
    if (!file) return;
    if (!bookmarkData) return alert('Load a library first.');
    const reader = new FileReader();
    reader.onload = e => {
        let incoming = null;
        try { incoming = JSON.parse(e.target.result); } catch (err) { return alert(`Could not parse that JSON: ${err.message}`); }
        const plan = planJsonMerge(bookmarkData, incoming, mergePolicy());
        if (!plan.creates.length && !plan.updates.length) {
            return alert(`Nothing to merge: every URL in “${file.name}” is already in the library (${formatCount(plan.skipped)} skipped).`);
        }
        const policyText = { skip: 'already here, so they are skipped', 'prefer-newer': 'already here; newer titles win', overwrite: 'already here; their titles are overwritten', 'keep-both': 'added again as extra copies' }[plan.policy] || 'skipped';
        if (!confirm(`Merge ${formatCount(plan.links)} bookmark(s) and ${formatCount(plan.folders)} folder(s) from “${file.name}”? ${formatCount(plan.updates.length)} title update(s). ${formatCount(plan.skipped)} URL(s) are ${policyText}.`)) return;
        withUndo('Merge JSON', api => {
            plan.creates.forEach(item => api.create(item.parent, item.node));
            plan.updates.forEach(update => api.set(update.node, 'title', update.title));
            logAffected('ADDED', file.name, `Merged ${formatCount(plan.links)} bookmark(s) and ${formatCount(plan.folders)} folder(s) from “${file.name}” (JSON) using the “${plan.policy}” policy: ${formatCount(plan.updates.length)} title(s) renamed, ${formatCount(plan.skipped)} URL(s) already present. Nothing was moved or deleted.`, { source: 'Merge JSON', kind: 'import' });
        });
        markChanged();
        statsDataRev++;
        renderSidebar();
        if (currentFolder) renderFolderContents(currentFolder);
        if (typeof rebuildStatistics === 'function') rebuildStatistics();
    };
    reader.readAsText(file);
}

// --- folder JSON export ---
function exportFolderAsJson(node) {
    if (!node || !isBookmarkFolderNode(node)) return alert('Pick a folder to export.');
    const title = displayFolderTitle(node) || node.title || 'Folder';
    const filename = `${netscapeBookmarkFileName(title).replace(/\.html$/, '')}.json`;
    applyStoredNotes(node);
    const copy = JSON.parse(JSON.stringify(node));
    downloadTextFile(filename, JSON.stringify(copy, null, 2), 'application/json');
    const counts = countTree(node);
    logAffected('SYSTEM', filename, `Exported “${title}” as JSON (${formatCount(counts.links)} link(s), ${formatCount(counts.folders)} folder(s)). The file is a copy; nothing changed.`, { source: 'Export', kind: 'export', reason: 'Browser download started from the folder menu.' });
}

function exportFolderChipAsJson() {
    const menu = document.getElementById('folder-chip-menu');
    if (menu) menu.style.display = 'none';
    const folder = typeof resolveFolderPath === 'function' ? resolveFolderPath(folderChipPath) : null;
    if (!folder) return alert('Could not find that folder in the library.');
    return exportFolderAsJson(folder);
}

// --- open a folder's bookmarks as tabs (the reverse of saving a session) ---
const OPEN_ALL_CAP = 25;

function openableBrowserUrl(uri) {
    return /^(https?|ftp|file):/i.test(String(uri || '').trim());
}

function folderLinksInOrder(node) {
    const links = [];
    const walk = current => {
        (current.children || []).forEach(child => {
            if (isBookmarkFolderNode(child)) walk(child);
            else if (nodeUri(child)) links.push(child);
        });
    };
    walk(node);
    return links;
}

function openFolderInTabs(node) {
    if (!node || !isBookmarkFolderNode(node)) return alert('Pick a folder to open.');
    const title = displayFolderTitle(node) || node.title || 'Folder';
    const uris = folderLinksInOrder(node).map(nodeUri).filter(openableBrowserUrl);
    if (!uris.length) return alert(`“${title}” holds no bookmarks with a page URL to open.`);
    const capped = uris.slice(0, OPEN_ALL_CAP);
    const extra = uris.length > capped.length ? ` Only the first ${formatCount(capped.length)} will open (the cap is ${formatCount(OPEN_ALL_CAP)}).` : '';
    if (!confirm(`Open ${formatCount(capped.length)} bookmark(s) from “${title}” in new tabs?${extra}`)) return;
    capped.forEach(uri => window.open(uri, '_blank', 'noopener'));
    logAffected('SYSTEM', title, `Opened ${formatCount(capped.length)} bookmark(s) from “${title}” in new tabs${extra ? ' (capped)' : ''}. Tabs were opened; no bookmark changed.`, { source: 'Bookmarks list', kind: 'open', reason: 'window.open per bookmark.' });
}

function affectedLogFilters() {
    return {
        type: (document.getElementById('affected-filter-type')?.value || '').toLowerCase(),
        source: (document.getElementById('affected-filter-source')?.value || '').toLowerCase(),
        text: (document.getElementById('affected-filter-text')?.value || '').trim().toLowerCase()
    };
}

function filteredAffectedLog() {
    const filters = affectedLogFilters();
    return affectedLog.filter(entry => {
        if (filters.type && String(entry.type || '').toLowerCase() !== filters.type) return false;
        if (filters.source && String(entry.source || '').toLowerCase() !== filters.source) return false;
        if (filters.text) {
            const haystack = [entry.title, entry.folder, entry.url, entry.details, entry.source, entry.kind].map(value => String(value || '')).join(' ').toLowerCase();
            if (!haystack.includes(filters.text)) return false;
        }
        return true;
    });
}

function refreshAffectedLogFilters() {
    const typeSel = document.getElementById('affected-filter-type');
    const sourceSel = document.getElementById('affected-filter-source');
    if (typeSel) {
        const current = typeSel.value;
        const types = [...new Set(affectedLog.map(entry => entry.type).filter(Boolean))].sort();
        typeSel.innerHTML = '<option value="">All types</option>' + types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
        typeSel.value = types.includes(current) ? current : '';
    }
    if (sourceSel) {
        const current = sourceSel.value;
        const sources = [...new Set(affectedLog.map(entry => entry.source).filter(Boolean))].sort();
        sourceSel.innerHTML = '<option value="">All sources</option>' + sources.map(source => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join('');
        sourceSel.value = sources.includes(current) ? current : '';
    }
}


// --- protected folders: scans and the scheduled tidy skip them ---
let protectedFolders = [];

function loadProtectedFolders() {
    const stored = readJsonStorage(PROTECTED_FOLDERS_KEY, []);
    protectedFolders = Array.isArray(stored) ? stored.filter(Boolean).map(String) : [];
}

function mirrorProtectedFoldersToBackground() {
    try {
        if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
            const writing = browser.storage.local.set({ protectedFolders });
            if (writing && typeof writing.catch === 'function') writing.catch(() => {});
        }
    } catch (err) {}
}

function saveProtectedFolders() {
    writeJsonStorage(PROTECTED_FOLDERS_KEY, protectedFolders);
    mirrorProtectedFoldersToBackground();
}

function folderProtectionKey(node) {
    const guid = String((node && node.guid) || '');
    return guid || folderPathLabel(node);
}

// One node, on demand (a menu opening, a delete preview): an entry names a folder by guid, or by
// its path when it has none, so this costs one walk of the tree. The bulk pass below never calls it.
function isFolderProtected(node) {
    if (!node || !protectedFolders.length) return false;
    const guid = String((node && node.guid) || '');
    if (guid && protectedFolders.includes(guid)) return true;
    return protectedFolders.includes(folderPathLabel(node));
}

// Protecting a folder protects everything inside it. Asking that per node used to walk up the
// tree — and finding a parent walks the whole tree — which made the everywhere search quadratic
// (ten seconds on 5,000 bookmarks). One pass collects the protected subtrees instead, cached
// against the tree revision and the protection list itself. That pass must never ask for a node's
// path: `folderPathLabel` walks the whole tree, so calling it per node (which is what
// `isFolderProtected` does for a single node) put the quadratic straight back — 5.8 s for 10,000
// bookmarks on the first everywhere search after any edit. The path is carried down the walk
// instead, and nothing at all is walked while the protection list is empty.
let protectedNodeCache = { rev: -1, tree: null, keys: '', nodes: new Set() };

function protectedNodeSet() {
    const keys = protectedFolders.join('\u0000');
    if (protectedNodeCache.rev === statsDataRev && protectedNodeCache.tree === bookmarkData && protectedNodeCache.keys === keys) {
        return protectedNodeCache.nodes;
    }
    const nodes = new Set();
    if (bookmarkData && protectedFolders.length) {
        const wanted = new Set(protectedFolders.filter(Boolean));
        // The path is carried down the walk, exactly as displayFolderPath normalises it: the root's
        // own title only survives when hideRootFolder is off.
        const rootTitle = typeof capturePrefs !== 'undefined' && capturePrefs && capturePrefs.hideRootFolder === false ? displayFolderTitle(bookmarkData, 'Root') : '';
        const walk = (node, trail) => {
            (node.children || []).forEach(child => {
                const path = trail ? `${trail} / ${displayFolderTitle(child)}` : displayFolderTitle(child);
                const guid = String(child.guid || '');
                if ((guid && wanted.has(guid)) || wanted.has(path)) {
                    walkBookmarkTree(child, n => nodes.add(n));
                    return;
                }
                walk(child, path);
            });
        };
        walk(bookmarkData, rootTitle);
    }
    protectedNodeCache = { rev: statsDataRev, tree: bookmarkData, keys, nodes };
    return nodes;
}

function isNodeUnderProtection(node) {
    if (!node) return false;
    return protectedNodeSet().has(node);
}

function toggleFolderProtection(node) {
    if (!node || !isBookmarkFolderNode(node)) return alert('Pick a folder to protect.');
    const key = folderProtectionKey(node);
    const label = folderPathLabel(node);
    const index = protectedFolders.indexOf(key);
    if (index >= 0) {
        protectedFolders.splice(index, 1);
        logAffected('SYSTEM', label, 'Protection removed: scans and the weekly tidy may touch this folder again.', { source: 'Protections', node });
    } else {
        protectedFolders.push(key);
        logAffected('SYSTEM', label, `Protected from scans: the weekly tidy and bulk cleanups skip this folder (${key}).`, { source: 'Protections', node, folderPath: label });
    }
    saveProtectedFolders();
    updateProtectLabels();
    alert(index >= 0 ? `“${label}” is no longer protected.` : `“${label}” is protected from scans and the weekly tidy.`);
}

function toggleTreeFolderProtection() {
    return toggleFolderProtection(rightClickedFolder);
}

function updateProtectLabels() {
    const row = document.getElementById('context-protect');
    if (row) row.textContent = isFolderProtected(rightClickedItem && rightClickedItem.item) ? 'Remove scan protection' : 'Protect from scans';
    const tree = document.getElementById('folder-tree-protect');
    if (tree) tree.textContent = isFolderProtected(rightClickedFolder) ? 'Remove scan protection' : 'Protect from scans';
}

// --- a preview before a destructive change ---
let previewAction = null;
// The dialog's optional second choice, for when one confirm cannot express both answers.
let previewSecondaryAction = null;

function openPreviewDialog({ title, note, rows, confirmLabel, onConfirm, secondaryLabel, onSecondary }) {
    const dialog = document.getElementById('preview-dialog');
    if (!dialog) {
        if (confirm(`${title}\n\n${note}`)) onConfirm();
        return;
    }
    const heading = document.getElementById('preview-heading');
    if (heading) heading.textContent = title;
    const noteEl = document.getElementById('preview-note');
    if (noteEl) noteEl.textContent = note;
    const list = document.getElementById('preview-list');
    if (list) {
        list.innerHTML = (rows || []).slice(0, 200).map(row => `<div class="trash-row"><div class="trash-row-main">
            <div class="trash-row-title">${escapeHtml(row.title || 'Untitled')}</div>
            <div class="trash-row-meta">${escapeHtml(row.meta || '')}</div>
        </div></div>`).join('') || '<p class="dupe-empty">Nothing to list.</p>';
    }
    const button = document.getElementById('preview-confirm');
    if (button) button.textContent = confirmLabel || 'Apply';
    previewAction = onConfirm;
    // The second choice is optional: without a label the button stays out of the way entirely.
    const secondary = document.getElementById('preview-secondary');
    if (secondary) {
        previewSecondaryAction = typeof onSecondary === 'function' ? onSecondary : null;
        secondary.hidden = !previewSecondaryAction;
        secondary.textContent = previewSecondaryAction ? (secondaryLabel || 'Or this') : '';
    }
    dialog.hidden = false;
}

function closePreviewDialog() {
    const dialog = document.getElementById('preview-dialog');
    if (dialog) dialog.hidden = true;
    previewAction = null;
    previewSecondaryAction = null;
}

function confirmPreviewDialog() {
    const action = previewAction;
    closePreviewDialog();
    if (typeof action === 'function') action();
}

function confirmPreviewSecondary() {
    const action = previewSecondaryAction;
    closePreviewDialog();
    if (typeof action === 'function') action();
}

function destructivePreviewRows(nodes) {
    return (nodes || []).map(node => {
        const counts = countTree(node);
        const kind = isBookmarkFolderNode(node) ? 'folder' : 'bookmark';
        const inside = isBookmarkFolderNode(node)
            ? ` · ${formatCount(counts.links)} bookmark(s) and ${formatCount(counts.folders)} folder(s) inside`
            : '';
        const protectedNote = isNodeUnderProtection(node) ? ' · PROTECTED (will be skipped)' : '';
        return {
            title: libraryNodeName(node) || 'Untitled',
            meta: `${kind} · ${folderPathFor(node) || 'top level'}${inside}${protectedNote}`
        };
    });
}

// --- full-library search index (search everywhere) ---
// Keyed on the revision AND the tree object: a reload replaces bookmarkData, and a cache
// keyed on the revision alone would keep serving hits from the previous tree (detached
// nodes, wrong results, and rows whose parent is no longer in the library).
let librarySearchCache = { rev: -1, tree: null, entries: [] };

function librarySearchIndex() {
    const rev = statsDataRev;
    if (librarySearchCache.rev === rev && librarySearchCache.tree === bookmarkData && librarySearchCache.entries.length) return librarySearchCache.entries;
    const entries = [];
    if (bookmarkData) {
        walkBookmarkTree(bookmarkData, (node, parent, path) => {
            const uri = nodeUri(node);
            // Folders are indexed too: with the scope set to everywhere, a folder name is a
            // legitimate result (this is what makes "Ableton" findable from any folder).
            if (!uri && !isBookmarkFolderNode(node)) return;
            entries.push({
                node,
                parent,
                path: displayFolderPath((path || []).join(' / ')),
                haystack: `${node.title || ''} ${uri} ${(path || []).join(' ')}`.toLowerCase()
            });
        });
    }
    librarySearchCache = { rev, tree: bookmarkData, entries };
    return entries;
}

function searchEverywhereHits(query) {
    const raw = String(query || '').trim();
    if (!raw) return [];
    const parsed = parseLibraryQuery(raw);
    // The index is a cheap prefilter for the plain words only. Matching is the parser's job, so
    // an operator-only query like `domain:about` is not hunted for as literal text — which is
    // what used to make it come back empty from the everywhere scope while it worked in a folder.
    const words = String(parsed.text || '').split(/\s+/).filter(Boolean);
    const context = typeof libraryQueryMatchContext === 'function' ? libraryQueryMatchContext() : {};
    const entries = librarySearchIndex().filter(entry => entry.parent && !isNodeUnderProtection(entry.node));
    const candidates = words.length ? entries.filter(entry => words.every(word => entry.haystack.includes(word))) : entries;
    return candidates
        .filter(entry => libraryQueryMatches(entry.node, parsed, context, entry.path ? entry.path.split(' / ') : []))
        .map(entry => ({ node: entry.node, parent: entry.parent, folderPath: entry.path, relPath: [] }));
}

// --- tidy settings (live; the background owns the alarm) ---
function tidySettingsForm() {
    return {
        enabled: Boolean(document.getElementById('setting-tidy-enabled')?.checked),
        weekday: Number(document.getElementById('setting-tidy-weekday')?.value || 0),
        hour: Number(document.getElementById('setting-tidy-hour')?.value || 3)
    };
}

function paintTidySettings(settings) {
    const enabled = document.getElementById('setting-tidy-enabled');
    if (enabled) enabled.checked = Boolean(settings && settings.enabled);
    const weekday = document.getElementById('setting-tidy-weekday');
    if (weekday) weekday.value = String(settings && Number.isFinite(settings.weekday) ? settings.weekday : 0);
    const hour = document.getElementById('setting-tidy-hour');
    if (hour) hour.value = String(settings && Number.isFinite(settings.hour) ? settings.hour : 3);
}

function applyTidySettings() {
    const tidy = tidySettingsForm();
    try {
        if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.sendMessage) {
            const note = document.getElementById('tidy-last-run');
            if (note) note.textContent = 'The weekly tidy runs in the live add-on only.';
            return;
        }
        const sending = browser.runtime.sendMessage({ type: 'tidy-settings', tidy });
        if (sending && typeof sending.then === 'function') sending.catch(() => {});
        // When the job list owns the schedule, mirror this into its tidy job too.
        if (Array.isArray(scheduledJobsCache)) {
            const job = scheduledJobsCache.find(item => item && item.kind === 'tidy');
            if (job) {
                job.enabled = tidy.enabled;
                job.cadence = { type: 'weekly', weekday: tidy.weekday, hour: tidy.hour };
                try { browser.storage.local.set({ [EDITOR_SCHEDULED_JOBS_KEY]: scheduledJobsCache }); } catch (err) {}
                editorSendRuntimeMessage({ type: 'job-settings', jobs: scheduledJobsCache });
                renderScheduledJobs();
            }
        }
        const note = document.getElementById('tidy-last-run');
        if (note) {
            note.textContent = tidy.enabled
                ? `The tidy runs ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tidy.weekday]} at ${String(tidy.hour).padStart(2, '0')}:00 local time.`
                : 'The weekly tidy is off.';
        }
        logAffected('SYSTEM', 'Weekly tidy', `Weekly tidy ${tidy.enabled ? 'enabled' : 'disabled'}${tidy.enabled ? ` for ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tidy.weekday]} at ${String(tidy.hour).padStart(2, '0')}:00` : ''}. The background alarm was rescheduled.`, { source: 'Settings', kind: 'setting' });
    } catch (err) {
        console.error(err);
    }
}

function loadTidySettings() {
    try {
        if (typeof browser === 'undefined' || !browser.storage || !browser.storage.local) return;
        const reading = browser.storage.local.get(['tidySettings', 'lastTidy']);
        if (!reading || typeof reading.then !== 'function') return;
        reading.then(result => {
            paintTidySettings(result && result.tidySettings);
            const note = document.getElementById('tidy-last-run');
            const last = result && result.lastTidy;
            if (note && last && last.at) {
                note.textContent = `Last tidy ${new Date(last.at).toLocaleString()}: stripped trackers from ${formatCount(last.stripped || 0)} bookmark(s), removed ${formatCount(last.removed || 0)} empty folder(s)${last.failed ? `, ${formatCount(last.failed)} change(s) failed` : ''}.`;
            }
        }).catch(() => {});
    } catch (err) {}
}

// --- command palette ---
let paletteCommands = [];
let paletteActive = 0;

function paletteCommandList() {
    const commands = [];
    const tab = (label, view) => commands.push({ label, hint: 'View', run: () => switchTabById(view) });
    tab('Open Tabs', 'tabs-view');
    tab('Bookmarks', 'bookmarks-view');
    tab('Statistics', 'stats-view');
    tab('Actions', 'actions-view');
    tab('Affected Log', 'affected-view');
    tab('Settings', 'settings-view');
    tab('Documentation', 'docs-view');
    const action = (label, run) => commands.push({ label, hint: 'Action', run });
    action('Export all bookmarks as HTML', () => exportLibraryAsHtml());
    action('Export bookmarks to JSON', () => exportBookmarks());
    action('Merge bookmarks from JSON', () => pickJsonMerge());
    action('Import bookmarks from HTML', () => pickHtmlImport());
    action('Export stats CSV', () => exportStatsCsv());
    action('Scan for bookmarks never opened', () => { switchTabById('actions-view'); scanUnusedBookmarks(); });
    action('Send the library health report to Obsidian', () => sendReportToObsidian('health'));
    action('Recently deleted', () => openTrashDialog());
    action('Show the undo history', () => toggleUndoHistory());
    action('Scan library health', () => { switchTabById('actions-view'); scanLibraryHealth(); });
    action('Find and replace', () => { switchTabById('actions-view'); document.getElementById('repairs-find')?.focus(); });
    action('Same title and domain', () => { switchTabById('actions-view'); scanSameTitleDomain(); });
    action('Title cleanup', () => { switchTabById('actions-view'); scanTitleCleanup(); });
    action('Broken links by domain', () => { switchTabById('actions-view'); scanDeadDomains(); });
    ['folder-size:stats-folder-size:Folder sizes', 'domains:domains:By domain and its health'].forEach(entry => {
        const [label, arg] = entry.split(':');
        action(label.replace(/-/g, ' ').replace(/^./, ch => ch.toUpperCase()), () => {
            if (typeof openStatisticsChildTab === 'function') openStatisticsChildTab(arg);
            else switchTabById('stats-view');
        });
    });
    action('Remove empty folders', () => { switchTabById('actions-view'); showRemoveEmptyFolders?.(); });
    if (bookmarkData) {
        walkBookmarkTree(bookmarkData, (node, parent, path) => {
            const trail = displayFolderPath((path || []).join(' / '));
            if (isBookmarkFolderNode(node)) {
                commands.push({ label: `Folder: ${displayFolderTitle(node)}`, hint: trail || 'top level', run: () => { switchTabById('bookmarks-view'); openFolder(node); } });
                return;
            }
            const uri = nodeUri(node);
            if (!uri) return;
            commands.push({
                label: `Bookmark: ${node.title || uri}`,
                hint: trail || uri,
                run: () => {
                    switchTabById('bookmarks-view');
                    if (parent) openFolder(parent);
                    if (typeof revealBookmarkById === 'function' && node.id != null) revealBookmarkById(node.id);
                    else window.open(uri, '_blank', 'noopener');
                }
            });
        });
    }
    return commands;
}

function renderCommandPalette() {
    const input = document.getElementById('command-palette-input');
    const results = document.getElementById('command-palette-results');
    if (!input || !results) return;
    const needle = input.value.trim().toLowerCase();
    const all = paletteCommands.length ? paletteCommands : (paletteCommands = paletteCommandList());
    const matches = (needle ? all.filter(command => `${command.label} ${command.hint}`.toLowerCase().includes(needle)) : all).slice(0, 60);
    paletteActive = Math.min(Math.max(0, paletteActive), Math.max(0, matches.length - 1));
    results.innerHTML = matches.length
        ? matches.map((command, index) => `<div class="command-row${index === paletteActive ? ' is-active' : ''}" data-command="${index}" role="option"><b>${escapeHtml(command.label)}</b><span>${escapeHtml(command.hint || '')}</span></div>`).join('')
        : '<div class="command-row is-active">No command matches.</div>';
    results.querySelectorAll('[data-command]').forEach(row => {
        row.onclick = () => runPaletteCommand(matches[Number(row.dataset.command)]);
    });
    results.dataset.matches = JSON.stringify(matches.map((command, index) => index));
    paletteMatchCache = matches;
}

let paletteMatchCache = [];

function runPaletteCommand(command) {
    if (!command) return;
    toggleCommandPalette(false);
    try {
        command.run();
    } catch (err) {
        console.error(err);
        alert(`That command failed: ${err.message}`);
    }
}

function toggleCommandPalette(force) {
    const overlay = document.getElementById('command-palette');
    if (!overlay) return;
    const show = typeof force === 'boolean' ? force : overlay.hidden;
    overlay.hidden = !show;
    if (!show) return;
    paletteCommands = paletteCommandList();
    paletteActive = 0;
    const input = document.getElementById('command-palette-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    renderCommandPalette();
}

// --- keyboard: shortcuts, palette keys, and menu navigation ---
function moveLibrarySelection(delta) {
    const rows = [...document.querySelectorAll('#bookmarks-body tr')];
    if (!rows.length) return;
    const nodes = rows.map(row => row._libraryNode).filter(Boolean);
    let index = nodes.indexOf(libraryAnchor);
    if (index < 0) index = delta > 0 ? -1 : nodes.length;
    index = Math.min(nodes.length - 1, Math.max(0, index + delta));
    if (!nodes[index]) return;
    selectLibraryNodes([nodes[index]], nodes[index]);
    rows[index].scrollIntoView({ block: 'nearest' });
}

function openMenuKeyboardTarget() {
    const focused = document.querySelector('.context-menu .context-menu-item.is-active');
    if (focused) return focused.click();
    return undefined;
}

document.addEventListener('keydown', event => {
    const tag = (event.target && event.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(event.target && event.target.isContentEditable);
    const mod = event.metaKey || event.ctrlKey;
    const overlay = document.getElementById('command-palette');
    if (overlay && !overlay.hidden) {
        if (event.key === 'Escape') { event.preventDefault(); return toggleCommandPalette(false); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            paletteActive += event.key === 'ArrowDown' ? 1 : -1;
            paletteActive = Math.min(Math.max(0, paletteActive), Math.max(0, paletteMatchCache.length - 1));
            return renderCommandPalette();
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            return runPaletteCommand(paletteMatchCache[paletteActive]);
        }
        return;
    }
    if (event.key === 'Escape' && searchOperatorPanelVisible()) {
        event.preventDefault();
        return closeSearchOperatorsPanel();
    }
    if (event.key === 'Escape' && openDialogs().length && !(overlay && !overlay.hidden)) {
        event.preventDefault();
        return closeTopDialog();
    }
    if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); return toggleCommandPalette(); }
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); return event.shiftKey ? redoLastChange() : undoLastChange(); }
    if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); return exportBookmarks(); }
    if (event.key === 'Enter' && event.target && event.target.id === 'bookmark-search') {
        commitSearchToHistory();
        return;
    }
    if (typing) return;
    const openMenus = [...document.querySelectorAll('.context-menu')].filter(menu => menu.style.display && menu.style.display !== 'none' && !menu.hidden);
    if (openMenus.length) {
        const items = [...openMenus[0].querySelectorAll('.context-menu-item')].filter(item => !item.hidden && !item.closest('[hidden]'));
        if (!items.length) return;
        const current = items.findIndex(item => item.classList.contains('is-active'));
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            items.forEach(item => item.classList.remove('is-active'));
            const next = event.key === 'ArrowDown'
                ? (current < 0 ? 0 : (current + 1) % items.length)
                : (current <= 0 ? items.length - 1 : current - 1);
            items[next].classList.add('is-active');
            return;
        }
        if (event.key === 'Enter') { event.preventDefault(); return openMenuKeyboardTarget(); }
        if (event.key === 'Escape') { event.preventDefault(); return hidePopupMenus(); }
        return;
    }
    if (event.key === '/' && !event.altKey) {
        const box = document.getElementById('bookmark-search');
        if (box) { event.preventDefault(); switchTabById('bookmarks-view'); box.focus(); box.select(); }
        return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        const treeInput = document.getElementById('tree-filter');
        if (document.activeElement === treeInput) return;
        return reorderLibrarySelection(event.key === 'ArrowUp' ? -1 : 1);
    }
    if (!document.getElementById('bookmarks-view')?.classList.contains('active')) return;
    if (event.key === 'j' || event.key === 'k') { event.preventDefault(); return moveLibrarySelection(event.key === 'j' ? 1 : -1); }
    if (!libraryAnchor) return;
    if (event.key === 'Enter') { event.preventDefault(); return openLibraryNode(libraryAnchor); }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        return previewDeleteLibraryNodes(librarySelection.includes(libraryAnchor) ? librarySelection : [libraryAnchor]);
    }
});


// --- notes: reach the exports, follow a URL edit, and report orphans ---
function moveStoredNote(oldUri, newUri) {
    const from = oldUri ? bookmarkUrlKey(oldUri) : '';
    const to = newUri ? bookmarkUrlKey(newUri) : '';
    if (!from || !to || from === to) return;
    const entry = storedNotes[from];
    if (!entry) return;
    delete storedNotes[from];
    // Never clobber a note that already lives under the new URL.
    if (!storedNotes[to]) storedNotes[to] = entry;
    writeJsonStorage(NOTES_STORAGE_KEY, storedNotes);
}

function collectOrphanNotes() {
    const live = new Set();
    if (bookmarkData) {
        walkBookmarkTree(bookmarkData, node => {
            const key = noteKeyFor(node);
            if (key) live.add(key);
        });
    }
    return Object.keys(storedNotes)
        .filter(key => !live.has(key))
        .map(key => ({ key, note: (storedNotes[key] && storedNotes[key].description) || '', at: (storedNotes[key] && storedNotes[key].at) || 0 }))
        .sort((a, b) => b.at - a.at);
}

function scanOrphanNotes() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const orphans = collectOrphanNotes();
    const box = document.getElementById('repairs-orphannotes-results');
    if (box) {
        box.innerHTML = orphans.length
            ? `<p>${formatCount(orphans.length)} note(s) no longer match a bookmark. They are kept in this browser only, so they are safe to delete.</p>
                <table class="excel-table"><thead><tr><th>URL</th><th>Note</th><th>Saved</th><th></th></tr></thead><tbody>
                ${orphans.slice(0, 100).map(item => `<tr>
                    <td><span class="log-url">${escapeHtml(item.key)}</span></td>
                    <td>${escapeHtml(item.note.slice(0, 120))}</td>
                    <td class="row-date">${item.at ? escapeHtml(new Date(item.at).toLocaleDateString()) : '—'}</td>
                    <td><button type="button" class="ghost-btn" data-orphan-note="${escapeHtml(item.key)}">Delete</button></td>
                </tr>`).join('')}
                </tbody></table>`
            : '<p>Every stored note still matches a bookmark.</p>';
        box.querySelectorAll('[data-orphan-note]').forEach(btn => {
            btn.onclick = () => deleteOrphanNote(btn.dataset.orphanNote);
        });
    }
    logAffected('SYSTEM', 'Bookmark notes', `Checked ${formatCount(Object.keys(storedNotes).length)} stored note(s); ${formatCount(orphans.length)} no longer match a bookmark. Nothing was deleted.`, { source: 'Notes', scan: true });
}

function deleteOrphanNote(key) {
    if (!Object.prototype.hasOwnProperty.call(storedNotes, key)) return;
    delete storedNotes[key];
    writeJsonStorage(NOTES_STORAGE_KEY, storedNotes);
    logAffected('SYSTEM', key, 'Deleted a stored note whose bookmark no longer exists.', { source: 'Notes', kind: 'delete', url: key });
    scanOrphanNotes();
}

function deleteAllOrphanNotes() {
    const orphans = collectOrphanNotes();
    if (!orphans.length) return alert('No orphaned notes to delete.');
    if (!confirm(`Delete ${formatCount(orphans.length)} note(s) that no longer match a bookmark?`)) return;
    orphans.forEach(item => { delete storedNotes[item.key]; });
    writeJsonStorage(NOTES_STORAGE_KEY, storedNotes);
    logAffected('SYSTEM', 'Bookmark notes', `Deleted ${formatCount(orphans.length)} orphaned note(s). Notes on live bookmarks were kept.`, { source: 'Notes', kind: 'delete' });
    scanOrphanNotes();
}

// --- storage schema, migrations and usage ---
const CURRENT_STORAGE_SCHEMA = 1;
// Built from the real constants so the meter can never drift from the writers.
// (A literal list here already drifted once: the log key is
// 'bookmark-editor-affected-log', not 'bookmark-editor-log'.)
function totalStorageKeys() {
    return [
        [EDITOR_SETTINGS_KEY, 'Settings'],
        [AFFECTED_LOG_KEY, 'Affected log'],
        [TRASH_STORAGE_KEY, 'Trash'],
        [NOTES_STORAGE_KEY, 'Bookmark notes'],
        [SORT_MEMORY_KEY, 'Per-folder sort memory'],
        [PROTECTED_FOLDERS_KEY, 'Protected folders'],
        ['bookmark-editor-url-rules', 'URL rules'],
        ['bookmark-editor-search-history', 'Search history'],
        [STORAGE_SCHEMA_KEY, 'Storage schema']
    ];
}

function migrateStorage() {
    // Named snapshots and the last-known-good copy were repealed: each stored a whole tree as JSON,
    // which rarely fits a browser's few megabytes. Drop both keys once, before the schema check
    // returns early, so the space they were holding is given back.
    try {
        localStorage.removeItem('bookmark-editor-snapshots');
        localStorage.removeItem('bookmark-editor-last-good');
    } catch (err) {}
    const stored = Number(readJsonStorage(STORAGE_SCHEMA_KEY, 0)) || 0;
    if (stored === CURRENT_STORAGE_SCHEMA) return stored;
    const from = stored;
    // Each step upgrades one version. v0 -> v1 is the baseline: earlier builds wrote
    // unversioned keys, and every reader already tolerates a missing key, so the only
    // work is stamping the version.
    if (from < 1) writeJsonStorage(STORAGE_SCHEMA_KEY, 1);
    const now = Number(readJsonStorage(STORAGE_SCHEMA_KEY, 0)) || 0;
    if (now !== CURRENT_STORAGE_SCHEMA) writeJsonStorage(STORAGE_SCHEMA_KEY, CURRENT_STORAGE_SCHEMA);
    if (from !== CURRENT_STORAGE_SCHEMA) {
        logAffected('SYSTEM', 'Storage schema', `Storage schema upgraded from v${from} to v${CURRENT_STORAGE_SCHEMA}. Stored settings, notes, trash, sort memory and protections were kept.`, { source: 'Settings', kind: 'migration' });
    }
    return CURRENT_STORAGE_SCHEMA;
}

function storageUsageRows() {
    const rows = [];
    let total = 0;
    totalStorageKeys().forEach(([key, label]) => {
        const raw = localStorage.getItem(key);
        if (raw == null) return;
        const bytes = raw.length;
        total += bytes;
        let count = '';
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) count = `${formatCount(parsed.length)} entr(y/ies)`;
            else if (parsed && typeof parsed === 'object') count = `${formatCount(Object.keys(parsed).length)} key(s)`;
            else count = String(parsed);
        } catch (err) {
            count = 'unreadable';
        }
        rows.push({ key, label, bytes, count });
    });
    return { rows, total };
}

function paintStorageUsage() {
    const box = document.getElementById('storage-usage');
    if (!box) return;
    const { rows, total } = storageUsageRows();
    const kb = value => `${(value / 1024).toFixed(value > 10240 ? 0 : 1)} KB`;
    box.innerHTML = rows.length
        ? `<table class="excel-table"><thead><tr><th>Stored data</th><th>Size</th><th>Contents</th><th></th></tr></thead><tbody>
            ${rows.map(row => `<tr>
                <td>${escapeHtml(row.label)}</td>
                <td class="stats-num">${escapeHtml(kb(row.bytes))}</td>
                <td>${escapeHtml(row.count)}</td>
                <td><button type="button" class="ghost-btn" data-storage-prune="${escapeHtml(row.key)}">Clear</button></td>
            </tr>`).join('')}
            <tr><td><strong>Total in this browser</strong></td><td class="stats-num"><strong>${escapeHtml(kb(total))}</strong></td><td colspan="2"></td></tr>
            </tbody></table>`
        : '<p>Nothing stored yet.</p>';
    box.querySelectorAll('[data-storage-prune]').forEach(btn => {
        btn.onclick = () => pruneStorageKey(btn.dataset.storagePrune);
    });
    try {
        if (navigator.storage && navigator.storage.estimate) {
            navigator.storage.estimate().then(estimate => {
                const note = document.getElementById('storage-estimate');
                if (note && estimate && estimate.usage != null) {
                    note.textContent = `This origin uses ${kb(estimate.usage)} of ${estimate.quota ? kb(estimate.quota) : 'an unknown quota'}.`;
                }
            }).catch(() => {});
        }
    } catch (err) {}
}

function pruneStorageKey(key) {
    const label = (totalStorageKeys().find(pair => pair[0] === key) || [key, key])[1];
    if (key === AFFECTED_LOG_KEY || key === EDITOR_SETTINGS_KEY || key === STORAGE_SCHEMA_KEY) {
        return alert(`${label} is managed from its own tab, so it is not cleared from here.`);
    }
    if (!confirm(`Clear ${label}? That stored data is deleted from this browser and cannot be undone.`)) return;
    try { localStorage.removeItem(key); } catch (err) {}
    if (key === NOTES_STORAGE_KEY) loadStoredNotes();
    if (key === TRASH_STORAGE_KEY) { trashEntries = []; renderTrashDialog(); }
    if (key === SORT_MEMORY_KEY) loadSortMemory();
    if (key === PROTECTED_FOLDERS_KEY) { protectedFolders = []; saveProtectedFolders(); }
    logAffected('SYSTEM', label, `Cleared stored ${label.toLowerCase()} from this browser (${formatCount(1)} key). Bookmarks were not touched.`, { source: 'Settings', kind: 'prune' });
    paintStorageUsage();
}



// --- search operators, regex, history, and the tree filter ---
const SEARCH_HISTORY_KEY = 'bookmark-editor-search-history';
const RECENT_FOLDERS_KEY = 'bookmark-editor-recent-folders';
const SEARCH_HISTORY_LIMIT = 30;
const RECENT_FOLDERS_LIMIT = 12;

let searchHistory = [];
let recentFolders = [];

function loadSearchHistory() {
    const stored = readJsonStorage(SEARCH_HISTORY_KEY, []);
    searchHistory = Array.isArray(stored) ? stored.filter(entry => entry && entry.query).slice(0, SEARCH_HISTORY_LIMIT) : [];
    const folders = readJsonStorage(RECENT_FOLDERS_KEY, []);
    recentFolders = Array.isArray(folders) ? folders.filter(Boolean).slice(0, RECENT_FOLDERS_LIMIT) : [];
}

function rememberSearch(query, everywhere, recursive) {
    const text = String(query || '').trim();
    if (!text) return;
    // The history is append-only: nothing in the app clears it, and it is written straight to
    // storage, so a search stays available across reloads.
    searchHistory = [{
        query: text,
        everywhere: Boolean(everywhere),
        recursive: recursive === undefined ? true : Boolean(recursive),
        at: Date.now()
    }].concat(searchHistory.filter(entry => entry.query !== text)).slice(0, SEARCH_HISTORY_LIMIT);
    writeJsonStorage(SEARCH_HISTORY_KEY, searchHistory, true);
}

function rememberFolderVisit(folderNode) {
    if (!folderNode || !isBookmarkFolderNode(folderNode)) return;
    const label = folderPathLabel(folderNode);
    if (!label) return;
    recentFolders = [label].concat(recentFolders.filter(item => item !== label)).slice(0, RECENT_FOLDERS_LIMIT);
    writeJsonStorage(RECENT_FOLDERS_KEY, recentFolders, true);
}

// Operators: domain: folder: title: url: added:>DATE added:<DATE has:note|dupe is:folder|bookmark|tracked|dupe|untitled
// and -term to exclude. Values may be quoted. An unmatched operator word is treated as text.
// This walks every link to build the tracked/duplicate sets, and is asked for once per search.
// Cached on the same revision signal the library search index uses, so a mutation invalidates it.
let matchContextCache = { rev: -1, tree: null, value: null };

function libraryQueryMatchContext() {
    if (matchContextCache.rev === statsDataRev && matchContextCache.tree === bookmarkData && matchContextCache.value) {
        return matchContextCache.value;
    }
    const context = buildLibraryQueryMatchContext();
    matchContextCache = { rev: statsDataRev, tree: bookmarkData, value: context };
    return context;
}

// The same sets, recomputed from the tree with no cache: what the exhaustive option asks for.
function buildLibraryQueryMatchContext() {
    const tracked = new Set();
    const dupes = new Set();
    const seen = new Map();
    if (bookmarkData) {
        collectBookmarkLinks(bookmarkData).forEach(link => {
            const uri = nodeUri(link);
            if (!uri) return;
            if (typeof stripTrackingParams === 'function' && stripTrackingParams(uri) !== uri) tracked.add(link);
            const key = typeof duplicateUrlKey === 'function' ? duplicateUrlKey(uri) : uri;
            if (seen.has(key)) {
                dupes.add(link);
                dupes.add(seen.get(key));
            } else {
                seen.set(key, link);
            }
        });
    }
    return { tracked, dupes };
}

// --- search query structure: tokens, boolean tree, leaf classification ---

// A query is tokenised once: quoted phrases stay whole, and parentheses are split off the words
// they touch so `(a OR b)` and `title:x)` both parse. A leading dash negates whatever follows,
// including a parenthesised group.
function searchQueryTokens(source) {
    const out = [];
    // `folder:"Bookmarks Toolbar"` is one token, not `folder:"Bookmarks` plus `"Toolbar"`: a
    // quoted value belongs to the operator in front of it, so a name with a space survives.
    const re = /-?[a-z]+:"[^"]*"|"[^"]*"|\(|\)|\S+/gi;
    let match;
    let pendingNegate = false;
    while ((match = re.exec(String(source || '')))) {
        let text = match[0];
        if (text === '(' || text === ')') { out.push({ type: text, negate: pendingNegate }); pendingNegate = false; continue; }
        let negate = pendingNegate;
        pendingNegate = false;
        // A dash on its own negates whatever comes next — `-(a OR b)` and `- title:x` both work.
        if (text === '-') { pendingNegate = true; continue; }
        if (text.length > 1 && text.startsWith('-')) { negate = true; text = text.slice(1); }
        let lead = '';
        let tail = '';
        while (text.startsWith('(')) { lead += '('; text = text.slice(1); }
        while (text.endsWith(')')) { tail += ')'; text = text.slice(0, -1); }
        for (const ch of lead) out.push({ type: ch, negate });
        // `-(a OR b)` negates the group; the first word inside it is not negated on its own.
        if (text) out.push({ type: 'term', text, negate: lead ? false : negate });
        for (const ch of tail) out.push({ type: ch });
    }
    return out;
}

// OR binds loosest, then AND, then a leading dash. `AND` and `OR` are recognised only as bare
// words, so `title:OR` is still a title search.
function searchQueryTree(tokens) {
    let index = 0;
    const peek = () => tokens[index];
    const isOr = token => Boolean(token) && token.type === 'term' && !token.negate && /^(or|\|)$/i.test(token.text);
    const isAnd = token => Boolean(token) && token.type === 'term' && !token.negate && /^and$/i.test(token.text);
    const parseOr = () => {
        const kids = [parseAnd()];
        while (isOr(peek())) { index += 1; kids.push(parseAnd()); }
        const kept = kids.filter(Boolean);
        return kept.length === 1 ? kept[0] : { op: 'or', kids: kept };
    };
    const parseAnd = () => {
        const kids = [];
        let explicit = false;
        while (peek() && peek().type !== ')' && !isOr(peek())) {
            if (isAnd(peek())) { index += 1; explicit = true; continue; }
            const kid = parseUnary();
            if (kid) {
                // `title:a title:b` has always meant either, but `title:a AND title:b` is a
                // deliberate requirement, so the fold has to leave these alone.
                if (explicit) kid.explicitAnd = true;
                kids.push(kid);
                explicit = false;
            } else if (peek() && peek().type !== ')' && !isOr(peek())) index += 1;
        }
        const kept = kids.filter(Boolean);
        return kept.length === 1 ? kept[0] : { op: 'and', kids: kept };
    };
    const parseUnary = () => {
        const token = peek();
        if (!token) return null;
        if (token.type === '(') {
            index += 1;
            const inner = parseOr();
            if (peek() && peek().type === ')') index += 1;
            return token.negate ? { op: 'not', kids: [inner] } : inner;
        }
        if (token.type === ')') { index += 1; return null; }
        index += 1;
        if (token.leaf) {
            const leaf = Object.assign({}, token.leaf);
            if (token.negate) leaf.negate = true;
            return leaf;
        }
        return null;
    };
    const tree = parseOr();
    return tree || null;
}

// `title:a title:b` and `domain:a, b` have always meant "either of these", so leaves of the same
// family inside one AND group fold into an OR. Everything else still has to match together.
function foldSearchFamilyAlternatives(node) {
    if (!node || node.op !== 'and') return node;
    const byFamily = new Map();
    const out = [];
    node.kids.forEach(kid => {
        const family = kid && kid.op === 'leaf' && kid.kind === 'family' && !kid.negate && !kid.explicitAnd ? kid.family : '';
        if (!family) { out.push(kid); return; }
        if (byFamily.has(family)) byFamily.get(family).kids.push(kid);
        else { const or = { op: 'or', kids: [kid] }; byFamily.set(family, or); out.push(or); }
    });
    return { op: 'and', kids: out.map(kid => (kid.op === 'or' && kid.kids.length === 1 ? kid.kids[0] : kid)) };
}

// One token becomes one leaf, and the flat arrays the panel and the plain-English line read are
// filled at the same time — so the tree and the old shape can never disagree.
function classifySearchToken(token, negated, on, parsed) {
    const body = negated ? token.replace(/^-+/, '') : token;
    const operator = body.match(/^([a-z]+):(.*)$/i);
    const key = operator ? operator[1].toLowerCase() : '';
    const rawValue = (operator ? operator[2] : body).replace(/^"|"$/g, '').trim();
    if (!rawValue) return null;
    const familyOn = key && on(key);
    if (familyOn && ['domain', 'folder', 'title', 'url', 'tag', 'type', 'has', 'is'].includes(key)) {
        const values = rawValue.split(',').map(part => part.trim()).filter(Boolean);
        // The flat arrays stay lowercased for the panel and the plain-English line; the leaf
        // keeps what was typed, so the case-sensitive setting has something to compare.
        values.forEach(part => parsed[key].push(part.toLowerCase()));
        parsed.operators += 1;
        return { op: 'leaf', kind: 'family', family: key, value: values.slice() };
    }
    if (familyOn && key === 'added') {
        const op = rawValue.startsWith('>') ? '>' : rawValue.startsWith('<') ? '<' : '=';
        const dateText = rawValue.replace(/^[<>]=?/, '');
        const ms = Date.parse(dateText.length === 4 ? `${dateText}-01-01` : dateText.length === 7 ? `${dateText}-01` : dateText);
        if (Number.isFinite(ms)) {
            parsed.added.push({ op, ms });
            parsed.operators += 1;
            return { op: 'leaf', kind: 'added', added: { op, ms }, value: rawValue };
        }
        return null;
    }
    const literal = (operator || negated) && !familyOn ? token.toLowerCase() : rawValue.toLowerCase();
    if (negated && on('exclude')) rawValue.split(',').map(part => part.trim().replace(/^-+/, '')).filter(Boolean).forEach(part => parsed.not.push(part.toLowerCase()));
    else parsed.terms.push(literal);
    return { op: 'leaf', kind: 'text', value: rawValue };
}

const SEARCH_TYPE_KINDS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'],
    video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'],
    doc: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages'],
    sheet: ['xls', 'xlsx', 'csv', 'ods', 'numbers'],
    slide: ['ppt', 'pptx', 'odp', 'key'],
    archive: ['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'dmg', 'pkg', 'iso'],
    code: ['js', 'ts', 'jsx', 'tsx', 'json', 'html', 'css', 'py', 'rb', 'go', 'rs', 'sh', 'yml', 'yaml', 'xml', 'sql']
};

function searchUriExtension(uri) {
    const text = String(uri || '').split(/[?#]/)[0];
    const match = text.match(/\.([A-Za-z0-9]{1,6})$/);
    return match ? match[1].toLowerCase() : '';
}

// Wildcards, whole words and case sensitivity all land here. `post*` is a prefix, `*sql` a
// suffix, `*post*` anywhere, `?` one character; with no wildcard it stays a plain substring,
// with word boundaries added when the whole-words setting is on.
function searchTextMatches(haystack, needle, parsed) {
    const rawHay = String(haystack || '');
    const rawNeedle = String(needle || '');
    if (!rawNeedle) return true;
    const caseSensitive = Boolean(parsed && parsed.caseSensitive);
    const hay = caseSensitive ? rawHay : rawHay.toLowerCase();
    const want = caseSensitive ? rawNeedle : rawNeedle.toLowerCase();
    if (/[*?]/.test(want)) {
        const pattern = want.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        try { return new RegExp(`^${pattern}$`, caseSensitive ? '' : 'i').test(hay); } catch (err) { return false; }
    }
    if (parsed && parsed.wholeWords) {
        const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try { return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, caseSensitive ? '' : 'i').test(hay); } catch (err) { return false; }
    }
    return hay.includes(want);
}

// One leaf against one node. The family checks are the ones the search has always made; the text
// families gained wildcards, whole words and case sensitivity through searchTextMatches.
function libraryQueryLeafMatches(node, leaf, context, relPath, parsed) {
    if (!node || !leaf) return false;
    const title = String(node.title || '');
    const uri = String(nodeUri(node));
    const folder = (relPath || []).join(' / ');
    const tags = String(node.tags || '');
    const isFolder = isBookmarkFolderNode(node);
    if (leaf.kind === 'text') return searchTextMatches(`${title} ${uri} ${folder} ${tags}`, leaf.value, parsed);
    if (leaf.kind === 'added') {
        const ms = typeof parseBookmarkDateMs === 'function' ? parseBookmarkDateMs(node.dateAdded) : 0;
        if (!ms) return false;
        const range = leaf.added;
        return range.op === '>' ? ms > range.ms : range.op === '<' ? ms < range.ms : Math.abs(ms - range.ms) < 86400000;
    }
    const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
    return values.some(value => {
        if (leaf.family === 'domain') {
            const key = domainSearchKey(uri);
            const pageKey = typeof domainSearchPageKey === 'function' ? domainSearchPageKey(uri) : '';
            const host = key && !key.includes(':') ? key : '';
            const reversed = host.split('.').reverse().join('.');
            const bare = bareHost(host);
            const needle = String(value).toLowerCase();
            const cmpKey = parsed && parsed.caseSensitive ? key : key;
            return Boolean(key) && (cmpKey === needle || host.endsWith(`.${needle}`) || bare === needle
                || reversed === needle || reversed.startsWith(`${needle}.`)
                || key.startsWith(`${needle}:`)
                || (String(needle).includes(':') && pageKey && (pageKey === needle || pageKey.startsWith(needle)))
                || searchTextMatches(uri, needle, Object.assign({}, parsed, { wholeWords: false })));
        }
        if (leaf.family === 'folder') return searchTextMatches(folder, value, parsed) || (searchTextMatches(title, value, parsed) && isFolder);
        if (leaf.family === 'title') return searchTextMatches(title, value, parsed);
        if (leaf.family === 'url') return searchTextMatches(uri, value, parsed);
        if (leaf.family === 'tag') return searchTextMatches(tags, value, Object.assign({}, parsed, { wholeWords: true }));
        if (leaf.family === 'type') {
            const extension = searchUriExtension(uri);
            const kind = SEARCH_TYPE_KINDS[value];
            if (kind) return kind.includes(extension);
            if (value === 'web' || value === 'page') return /^https?:/i.test(uri) && !extension;
            if (value === 'file') return /^file:/i.test(uri);
            if (value === 'folder') return isFolder;
            return extension === value || extension === value.replace(/^\./, '');
        }
        if (leaf.family === 'has') {
            if (value === 'note') return Boolean(noteFor(node));
            if (value === 'dupe') return context.dupes.has(node);
            if (value === 'tracked') return context.tracked.has(node);
            if (value === 'folder') return isFolder;
            if (value === 'date') return Boolean(typeof parseBookmarkDateMs === 'function' ? parseBookmarkDateMs(node.dateAdded) : 0);
            return false;
        }
        if (leaf.family === 'is') {
            if (value === 'folder') return isFolder;
            if (value === 'bookmark') return !isFolder && Boolean(uri);
            if (value === 'untitled') return !title;
            if (value === 'tracked') return context.tracked.has(node);
            if (value === 'dupe') return context.dupes.has(node);
            if (value === 'noted') return Boolean(noteFor(node));
            return false;
        }
        return false;
    });
}

function libraryQueryExpressionMatches(node, expr, context, relPath, parsed) {
    if (!expr) return true;
    if (expr.op === 'and') return expr.kids.every(kid => libraryQueryExpressionMatches(node, kid, context, relPath, parsed));
    if (expr.op === 'or') return expr.kids.some(kid => libraryQueryExpressionMatches(node, kid, context, relPath, parsed));
    if (expr.op === 'not') return !libraryQueryExpressionMatches(node, expr.kids[0], context, relPath, parsed);
    const hit = libraryQueryLeafMatches(node, expr, context, relPath, parsed);
    return expr.negate ? !hit : hit;
}

function libraryQueryMatches(node, parsed, context, relPath) {
    if (!node) return false;
    if (parsed && parsed.regex) {
        const hay = [String(node.title || ''), String(nodeUri(node)), (relPath || []).join(' / ')].join(' ');
        try { return parsed.regex.test(hay); } catch (err) { return false; }
    }
    if (!parsed) return true;
    if (!parsed.expr) return libraryQueryFlatMatches(node, parsed, context, relPath);
    return libraryQueryExpressionMatches(node, parsed.expr, context || {}, relPath, parsed);
}

function searchLibraryScoped(folder, rawQuery, recursive, everywhere) {
    const parsed = parseLibraryQuery(rawQuery);
    const context = libraryQueryMatchContext();
    const hits = [];
    const root = everywhere ? bookmarkData : folder;
    // Searching inside a folder counts that folder as part of every hit's path, so
    // folder:Cats matches what is in Cats rather than only its subfolders.
    const basePath = everywhere || !folder ? [] : folderPathLabel(folder).split(' / ').filter(Boolean);
    const walk = (node, relPath) => {
        (node.children || []).forEach(child => {
            if (libraryQueryMatches(child, parsed, context, relPath)) hits.push({ node: child, parent: node, relPath });
            if ((everywhere || recursive) && isBookmarkFolderNode(child)) walk(child, relPath.concat(displayFolderTitle(child)));
        });
    };
    if (root) walk(root, basePath);
    return { hits, parsed };
}

// The optional slow twin of searchLibraryScoped / searchEverywhereHits: same candidates, same query
// rules, but the folder path of every node is re-derived by walking the library (findNodeParent per
// ancestor — the quadratic part) and the tracked/duplicate sets are rebuilt instead of read from a
// cache. Nothing here trusts the index, so it is the way to confirm that a fast search did not miss
// something; when the caches are right the two agree hit for hit, which is what the harness checks.
function searchLibraryExhaustive(folder, rawQuery, recursive, everywhere) {
    const parsed = parseLibraryQuery(rawQuery);
    const context = buildLibraryQueryMatchContext();
    const operators = hasSearchOperators(rawQuery);
    const needle = String(rawQuery || '').trim().toLowerCase();
    const hits = [];
    const root = everywhere ? bookmarkData : folder;
    const basePath = everywhere || !folder ? [] : folderPathLabel(folder).split(' / ').filter(Boolean);
    const parentTrail = node => {
        const trail = [];
        const stop = everywhere ? bookmarkData : folder;
        for (let parent = findNodeParent(node); parent && parent !== stop; parent = findNodeParent(parent)) {
            trail.unshift(displayFolderTitle(parent));
        }
        return trail;
    };
    const walk = node => {
        (node.children || []).forEach(child => {
            const relPath = basePath.concat(parentTrail(child));
            const matches = !needle || (operators
                ? libraryQueryMatches(child, parsed, context, relPath)
                : nodeSearchText(child).includes(needle));
            if (matches) hits.push({ node: child, parent: node, relPath });
            if ((everywhere || (needle && recursive)) && isBookmarkFolderNode(child)) walk(child);
        });
    };
    if (root) walk(root);
    return { hits, parsed };
}


function searchHistoryListHtml() {
    const rows = searchHistory.map(entry => `<div class="history-row"><button type="button" class="history-apply" data-call="applySearchHistoryEntry" data-arg="${escapeHtml(entry.query)}" title="Reapply this search"><span class="history-query">${escapeHtml(entry.query)}</span>${entry.everywhere ? '<span class="search-history-tag">everywhere</span>' : ''}</button><button type="button" class="history-remove" data-call="removeSearchHistoryEntry" data-arg="${escapeHtml(entry.query)}" title="Remove this search from the history" aria-label="Remove this search from the history">×</button></div>`);
    const empty = !rows.length;
    return `<div class="history-head">Recent searches <span class="operator-panel-hint">${empty ? 'nothing remembered yet' : 'click one to reapply it'}</span></div>
        ${empty ? '' : `<div class="history-list">${rows.join('')}</div>
        <div class="history-foot">
            <span class="history-foot-note">Kept until you clear it</span>
            <button type="button" class="history-clear" data-call="clearSearchHistory" title="Forget every remembered search">Clear history</button>
        </div>`}`;
}

// One × per remembered search: forget that entry only.
function removeSearchHistoryEntry(query) {
    const text = String(query || '');
    // A deferred commit would put the query straight back, so cancel it when the entry being
    // removed is the one sitting in the search box.
    const input = document.getElementById('bookmark-search');
    if (input && String(input.value || '').trim() === text) cancelPendingSearch();
    const before = searchHistory.length;
    searchHistory = searchHistory.filter(entry => entry.query !== text);
    if (searchHistory.length === before) return;
    writeJsonStorage(SEARCH_HISTORY_KEY, searchHistory, true);
    renderSearchHistory();
}

function renderSearchHistory() {
    const slot = document.getElementById('search-history-list');
    if (!slot) return;
    slot.innerHTML = searchHistoryListHtml();
    // The list is re-rendered on its own (a new search, a removal), which replaces its buttons:
    // they have to be wired again or the × and the rows stop responding.
    if (typeof wireDataCallScope === 'function') wireDataCallScope(slot);
}

function applySearchHistoryEntry(query) {
    const text = String(query || '');
    const entry = searchHistory.find(item => item.query === text) || { query: text };
    const input = document.getElementById('bookmark-search');
    if (input) input.value = entry.query;
    // Restore the flags the search was made with, so the scope comes back too.
    const everywhere = document.getElementById('bookmark-search-everywhere');
    if (everywhere && entry.everywhere !== undefined) everywhere.checked = Boolean(entry.everywhere);
    const recursiveBox = document.getElementById('bookmark-search-recursive');
    if (recursiveBox && entry.recursive !== undefined) recursiveBox.checked = Boolean(entry.recursive);
    // Reapplying shows it as filters again, not just as text in the box.
    if (searchSyntaxEnabled()) toggleSearchOperatorsPanel(true);
    rememberSearch(entry.query, Boolean(entry.everywhere), entry.recursive);   // bump to the top
    filterFolderContents();
    if (typeof syncSearchOperatorForm === 'function') syncSearchOperatorForm();
    renderSearchHistory();
    updateSearchOperatorPlain();
    updateSearchClearButton();
    if (input) input.focus();
}

function clearSearchHistory() {
    searchHistory = [];
    recentFolders = [];
    writeJsonStorage(SEARCH_HISTORY_KEY, [], true);
    writeJsonStorage(RECENT_FOLDERS_KEY, [], true);
    renderSearchHistory();
}

// --- tree filter ---
// Which folders were open when the tree filter started, so clearing it puts the tree back
// exactly as the user had it instead of leaving every matched branch expanded.
let treeExpandSnapshot = null;

function treeFilterSnapshotExpansion() {
    if (treeExpandSnapshot) return;
    treeExpandSnapshot = new Map();
    treeItemList.forEach(entry => treeExpandSnapshot.set(entry.nodeDiv, entry.nodeDiv.classList.contains('expanded')));
}

function treeFilterRestoreExpansion() {
    if (!treeExpandSnapshot) return;
    treeExpandSnapshot.forEach((wasExpanded, nodeDiv) => nodeDiv.classList.toggle('expanded', wasExpanded));
    treeExpandSnapshot = null;
}

function applyTreeFilter() {
    const input = document.getElementById('tree-filter');
    const term = String((input && input.value) || '').trim().toLowerCase();
    const clear = document.getElementById('tree-filter-clear');
    if (clear) clear.hidden = !term;
    // folderTreeItems is a WeakMap: it supports get/set/has only, so iterating it needs the
    // plain list that renderSidebar() rebuilds alongside it.
    if (!treeItemList.length) return;
    if (!term) {
        treeFilterRestoreExpansion();
        treeItemList.forEach(entry => {
            entry.itemDiv.classList.remove('tree-filtered', 'tree-filter-match');
            entry.itemDiv.hidden = false;
        });
        return;
    }
    // A folder survives when it matches or holds a match; matches get highlighted and their
    // ancestors are expanded so the match is visible.
    const keeps = new Set();
    treeItemList.forEach(entry => {
        const text = `${libraryNodeName(entry.node)} ${nodeUri(entry.node)}`.toLowerCase();
        if (!text.includes(term)) return;
        keeps.add(entry.node);
        entry.itemDiv.classList.add('tree-filter-match');
        let parent = findNodeParent(entry.node);
        while (parent) {
            keeps.add(parent);
            parent = findNodeParent(parent);
        }
    });
    treeItemList.forEach(entry => {
        const kept = keeps.has(entry.node);
        entry.itemDiv.hidden = !kept;
        entry.itemDiv.classList.toggle('tree-filtered', !kept);
        if (kept && !entry.itemDiv.classList.contains('tree-filter-match')) entry.itemDiv.classList.remove('tree-filter-match');
    });
    // Open every kept folder, not just the first match's chain: a collapsed ancestor hides its
    // whole subtree (`.tree-children { display:none }`), so a match two levels down stays
    // invisible however the rows themselves are flagged. Matches are folders too, so opening
    // them reveals their own matching descendants.
    treeFilterSnapshotExpansion();
    treeItemList.forEach(entry => {
        if (!keeps.has(entry.node) || !entry.nodeDiv) return;
        if (!entry.nodeDiv.classList.contains('expanded')) entry.nodeDiv.classList.add('expanded');
    });
    const firstMatch = treeItemList.find(entry => entry.itemDiv.classList.contains('tree-filter-match'));
    if (firstMatch) firstMatch.itemDiv.scrollIntoView({ block: 'nearest' });
}

function clearTreeFilter() {
    const input = document.getElementById('tree-filter');
    if (input) input.value = '';
    applyTreeFilter();
}

// --- keyboard reorder within the parent folder ---
function reorderLibrarySelection(delta) {
    const nodes = (librarySelection.includes(libraryAnchor) ? librarySelection : [libraryAnchor]).filter(Boolean);
    if (!nodes.length) return false;
    let moved = 0;
    withUndo('Reorder bookmarks', api => {
        nodes.forEach(node => {
            const parent = findNodeParent(node);
            if (!parent || isRootDirectFolder(node)) return;
            const index = parent.children.indexOf(node);
            const target = index + delta;
            if (index < 0 || target < 0 || target >= parent.children.length) return;
            api.move(node, parent, parent, target);
            moved += 1;
            logAffected('MODIFIED', libraryNodeName(node), `Reordered ${delta < 0 ? 'up' : 'down'} inside ${displayFolderTitle(parent)}.`, {
                source: 'Bookmarks list',
                node,
                uri: nodeUri(node)
            });
        });
    });
    if (!moved) return false;
    markChanged();
    refreshLibraryAfterStructureChange(currentFolder);
    return true;
}


// --- merge policies: skip (default), prefer-newer, overwrite, keep-both ---
function mergePolicy() {
    const value = String(readEditorSettings().mergePolicy || 'skip');
    return ['skip', 'prefer-newer', 'overwrite', 'keep-both'].includes(value) ? value : 'skip';
}

function existingLinksByKey(root) {
    const map = new Map();
    if (!root) return map;
    collectBookmarkLinks(root).forEach(link => {
        const uri = nodeUri(link);
        if (!uri) return;
        const key = libraryUrlKey(uri);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(link);
    });
    return map;
}

function nodeTimestamp(node) {
    if (!node) return 0;
    return parseBookmarkDateMs(node.lastModified) || parseBookmarkDateMs(node.dateAdded) || 0;
}

// --- validate library ---
function collectLibraryProblems() {
    const problems = { untitled: [], badUrl: [], folderNames: [], dateAnomalies: [], total: 0 };
    const siblingMap = new Map();
    if (!bookmarkData) return problems;
    walkBookmarkTree(bookmarkData, (node, parent) => {
        if (isBookmarkFolderNode(node)) {
            if (parent) {
                const key = `${parent.title || ''}::${String(node.title || '').trim().toLowerCase()}`;
                if (!siblingMap.has(key)) siblingMap.set(key, []);
                siblingMap.get(key).push({ node, parent });
            }
            // A folder claiming to be modified before its own newest child was added.
            const newestChild = (node.children || []).reduce((max, child) => Math.max(max, nodeTimestamp(child)), 0);
            const groupModified = parseBookmarkDateMs(node.dateGroupModified);
            if (newestChild && groupModified && groupModified + 86400000 < newestChild) {
                problems.dateAnomalies.push({ node, parent, reason: 'folder modified before its newest child' });
            }
            return;
        }
        const uri = nodeUri(node);
        if (!uri) problems.badUrl.push({ node, parent, reason: 'no URL' });
        else if (!openableBrowserUrl(uri)) problems.badUrl.push({ node, parent, reason: `not a page URL (${uri.split(':')[0]}:)` });
        if (!String(node.title || '').trim()) problems.untitled.push({ node, parent });
    });
    siblingMap.forEach(group => {
        if (group.length > 1) group.slice(1).forEach(item => problems.folderNames.push({ ...item, reason: `${group.length} sibling folders share this name` }));
    });
    problems.total = problems.untitled.length + problems.badUrl.length + problems.folderNames.length + problems.dateAnomalies.length;
    return problems;
}

function titleFromUri(uri) {
    try {
        const url = new URL(uri);
        const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
        return last ? `${url.hostname.replace(/^www\./, '')} — ${last.replace(/[-_]+/g, ' ').slice(0, 60)}` : url.hostname.replace(/^www\./, '');
    } catch (err) {
        return 'Untitled';
    }
}

let libraryProblems = null;

function scanLibraryProblems() {
    if (!bookmarkData) return alert('Library is not loaded.');
    libraryProblems = collectLibraryProblems();
    const rows = [];
    libraryProblems.untitled.forEach(item => rows.push({
        item,
        action: 'title',
        cells: [bulkPickBox('libproblems', item.node), 'Untitled', `<span class="log-url">${escapeHtml(nodeUri(item.node) || '—')}</span>`, escapeHtml(folderPathFor(item.node) || 'top level'), `set the title to “${escapeHtml(titleFromUri(nodeUri(item.node)))}”`]
    }));
    libraryProblems.badUrl.forEach(item => rows.push({
        item,
        action: 'delete',
        cells: [bulkPickBox('libproblems', item.node), escapeHtml(libraryNodeName(item.node)), `<span class="log-url">${escapeHtml(nodeUri(item.node) || '—')}</span>`, escapeHtml(folderPathFor(item.node) || 'top level'), `delete (${escapeHtml(item.reason)})`]
    }));
    libraryProblems.folderNames.forEach(item => rows.push({
        item,
        action: 'rename',
        cells: [bulkPickBox('libproblems', item.node), escapeHtml(libraryNodeName(item.node)), 'folder', escapeHtml(folderPathFor(item.node) || 'top level'), escapeHtml(item.reason)]
    }));
    libraryProblems.dateAnomalies.forEach(item => rows.push({
        item,
        action: 'none',
        cells: ['—', escapeHtml(libraryNodeName(item.node)), 'folder', escapeHtml(folderPathFor(item.node) || 'top level'), escapeHtml(item.reason)]
    }));
    startBulkPick('libproblems');
    renderRepairPreview(
        'repairs-problems-results',
        'The library looks structurally clean: no untitled bookmarks, no non-page URLs, no sibling folders sharing a name, no impossible folder dates.',
        `${formatCount(libraryProblems.total)} finding(s): ${formatCount(libraryProblems.untitled.length)} untitled, ${formatCount(libraryProblems.badUrl.length)} non-page URL(s), ${formatCount(libraryProblems.folderNames.length)} duplicate folder name(s), ${formatCount(libraryProblems.dateAnomalies.length)} date anomaly(ies).`,
        [{ pick: 'libproblems' }, 'Name', 'URL', 'Folder', 'What the fix would do'],
        rows
    );
    setBulkPlan('libproblems', { count: libraryProblems.untitled.length + libraryProblems.badUrl.length + libraryProblems.folderNames.length, label: 'Fix library problems', apply: applyLibraryProblemFixes });
    logAffected('SYSTEM', 'Validate library', `Found ${formatCount(libraryProblems.total)} structural finding(s): ${formatCount(libraryProblems.untitled.length)} untitled bookmark(s), ${formatCount(libraryProblems.badUrl.length)} bookmark(s) with no page URL, ${formatCount(libraryProblems.folderNames.length)} duplicate sibling folder name(s), ${formatCount(libraryProblems.dateAnomalies.length)} folder date anomaly(ies). Scan did not change anything.`, { source: 'Validate library', scan: true });
}

function applyLibraryProblemFixes() {
    if (!libraryProblems) return;
    let titles = 0;
    let removed = 0;
    let renamed = 0;
    const deleteThese = [];
    withUndo('Fix library problems', api => {
        libraryProblems.untitled.forEach(item => {
            if (!bulkPicked('libproblems', item.node)) return;
            const title = titleFromUri(nodeUri(item.node));
            api.set(item.node, 'title', title);
            logAffected('REPAIR', title, 'Gave an untitled bookmark a title built from its URL.', { source: 'Validate library', node: item.node, newTitle: title, uri: nodeUri(item.node) });
            titles += 1;
        });
        libraryProblems.badUrl.forEach(item => {
            if (!bulkPicked('libproblems', item.node)) return;
            deleteThese.push(item.node);
        });
        libraryProblems.folderNames.forEach(item => {
            if (!bulkPicked('libproblems', item.node)) return;
            const base = String(item.node.title || 'Folder').replace(/\s*\(\d+\)$/, '');
            let index = 2;
            const siblings = (item.parent && item.parent.children) || [];
            while (siblings.some(sibling => sibling !== item.node && String(sibling.title || '') === `${base} (${index})`)) index += 1;
            const nextTitle = `${base} (${index})`;
            api.set(item.node, 'title', nextTitle);
            logAffected('REPAIR', nextTitle, `Renamed a sibling folder that shared its name (was “${base}”).`, { source: 'Validate library', node: item.node, newTitle: nextTitle });
            renamed += 1;
        });
        deleteThese.forEach(node => {
            const parent = findNodeParent(node);
            if (!parent) return;
            api.remove(node, parent);
            logAffected('REMOVED', libraryNodeName(node), 'Deleted a bookmark that does not hold a page URL.', { source: 'Validate library', node, uri: nodeUri(node) });
            removed += 1;
        });
    });
    markChanged();
    renderSidebar();
    scanLibraryProblems();
    notifyDone(`Fixed ${formatCount(titles + renamed + removed)} finding(s): ${formatCount(titles)} title(s), ${formatCount(renamed)} folder name(s), ${formatCount(removed)} deleted. One Undo reverses it.`);
}

// --- trash: restore everything, and undo an emptied trash ---
let lastClearedTrash = null;

function restoreAllTrash() {
    if (!trashEntries.length) return alert('The trash is empty.');
    const total = trashEntries.reduce((sum, entry) => sum + entry.items.length, 0);
    if (!confirm(`Restore ${formatCount(total)} entr(y/ies) from ${formatCount(trashEntries.length)} deletion step(s)?`)) return;
    const ids = trashEntries.map(entry => entry.id);
    ids.forEach(id => restoreTrashEntry(id, true));
    renderTrashDialog();
    notifyDone(`Restored ${formatCount(total)} entr(y/ies). Each step is reversible with Undo.`);
}

function undoClearTrash() {
    if (!lastClearedTrash || !lastClearedTrash.length) return alert('Nothing was emptied this session.');
    trashEntries = lastClearedTrash.slice();
    lastClearedTrash = null;
    saveTrash();
    renderTrashDialog();
    logAffected('SYSTEM', 'Trash', `Put ${formatCount(trashEntries.length)} emptied deletion step(s) back into the trash.`, { source: 'Trash', kind: 'restore' });
}


// --- toasts: quiet, stackable feedback that does not block the page ---
const TOAST_LIMIT = 4;
const TOAST_DEFAULT_MS = 6000;

function toastContainer() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toast-stack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    return stack;
}

function showToast(message, options = {}) {
    const text = String(message == null ? '' : message);
    if (!text) return null;
    const stack = toastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${options.kind || 'info'}`;
    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    toast.appendChild(body);
    toast.appendChild(close);
    const dismiss = () => toast.remove();
    close.onclick = dismiss;
    toast.onclick = dismiss;
    stack.appendChild(toast);
    while (stack.children.length > TOAST_LIMIT) stack.removeChild(stack.firstChild);
    const ttl = Number.isFinite(options.timeout) ? options.timeout : TOAST_DEFAULT_MS;
    if (ttl > 0) setTimeout(dismiss, ttl);
    return toast;
}

function notifyDone(message) { return showToast(message, { kind: 'done' }); }
function notifyWarn(message) { return showToast(message, { kind: 'warn', timeout: 9000 }); }

// --- one inline confirmation dialog behind the destructive actions ---
function confirmDialog({ title, note, rows, confirmLabel, onConfirm, secondaryLabel, onSecondary }) {
    openPreviewDialog({ title, note, rows: rows || [], confirmLabel: confirmLabel || 'Apply', onConfirm, secondaryLabel, onSecondary });
}

// --- auto theme and density ---
function prefersDarkScheme() {
    try {
        return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (err) {
        return false;
    }
}

function resolvedTheme(setting) {
    if (setting === 'auto') return prefersDarkScheme() ? 'dark' : 'light';
    return setting === 'dark' ? 'dark' : 'light';
}

function watchSystemTheme() {
    try {
        if (!window.matchMedia) return;
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => {
            if (String(readEditorSettings().theme || 'light') === 'auto') applyEditorSettings(readEditorSettings());
        };
        if (query.addEventListener) query.addEventListener('change', handler);
        else if (query.addListener) query.addListener(handler);
    } catch (err) {}
}

// --- column chooser ---
const COLUMN_PRESETS = {
    all: [],
    'name-location': ['added', 'tags'],
    'name-added': ['location', 'tags'],
    'name-only': ['location', 'added', 'tags']
};

function applyColumnChooser(preset) {
    const table = document.getElementById('bookmarks-table');
    if (!table) return;
    const hidden = COLUMN_PRESETS[preset] || COLUMN_PRESETS.all;
    ['location', 'added', 'tags'].forEach(column => {
        table.classList.toggle(`hide-col-${column}`, hidden.includes(column));
    });
}

// --- bulk edit with tokens ---
function templateScopeRoots() {
    const scope = document.getElementById('repairs-bulkedit-scope')?.value || 'folder';
    if (scope === 'selection') return librarySelection.length ? librarySelection.slice() : [];
    if (scope === 'library') return bookmarkData ? [bookmarkData] : [];
    return currentFolder ? [currentFolder] : [];
}

function bulkTemplateValue(token, node, index, folderPath) {
    const uri = nodeUri(node);
    let domain = '';
    try { domain = new URL(uri).hostname.replace(/^www\./, ''); } catch (err) { domain = ''; }
    const ms = typeof parseBookmarkDateMs === 'function' ? parseBookmarkDateMs(node.dateAdded) : 0;
    switch (String(token || '').toLowerCase()) {
        case 'title': return String(node.title || '');
        case 'url': return uri;
        case 'domain': return domain;
        case 'folder': return folderPath || '';
        case 'date': return ms ? new Date(ms).toISOString().slice(0, 10) : '';
        case 'n': return String(index + 1);
        case 'nn': return String(index + 1).padStart(2, '0');
        default: return null;
    }
}

function applyTitleTemplate(template, node, index, folderPath) {
    return String(template || '').replace(/\{([a-z]+)\}/gi, (whole, token) => {
        const value = bulkTemplateValue(token, node, index, folderPath);
        return value == null ? whole : value;
    });
}

function collectBulkTemplateHits() {
    const template = document.getElementById('repairs-bulkedit-template')?.value || '';
    if (!template.trim()) return [];
    const roots = templateScopeRoots();
    if (!roots.length) return [];
    const seen = new Set();
    const hits = [];
    let index = 0;
    const walk = node => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (!isBookmarkFolderNode(node)) {
            const folderPath = folderPathFor(node);
            const next = applyTitleTemplate(template, node, index, folderPath).trim();
            index += 1;
            if (next && next !== node.title) hits.push({ node, before: node.title || '', next, folderPath });
        }
        (node.children || []).forEach(walk);
    };
    roots.forEach(walk);
    return hits;
}

let bulkTemplateHits = [];

function scanBulkEditTemplate() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const template = document.getElementById('repairs-bulkedit-template')?.value || '';
    if (!template.trim()) return alert('Type a title template first, for example {title} — {domain} or Cats {n}.');
    bulkTemplateHits = collectBulkTemplateHits();
    startBulkPick('bulkedit');
    renderRepairPreview(
        'repairs-bulkedit-results',
        'Every title already matches that template.',
        `${formatCount(bulkTemplateHits.length)} title(s) would change. Tokens: {title} {url} {domain} {folder} {date} {n} {nn}.`,
        [{ pick: 'bulkedit' }, 'Title now', 'Title after', 'Folder'],
        bulkTemplateHits.map(hit => [bulkPickBox('bulkedit', hit.node), escapeHtml(hit.before || 'Untitled'), escapeHtml(hit.next), escapeHtml(hit.folderPath || 'top level')])
    );
    setBulkPlan('bulkedit', { count: bulkTemplateHits.length, label: 'Bulk edit titles', apply: applyBulkEditTemplate });
    logAffected('SYSTEM', 'Bulk edit scan', `Scanned ${formatCount(bulkTemplateHits.length)} title(s) against the template “${escapeHtml(template)}”. Scan did not change anything.`, { source: 'General repairs', scan: true });
}

function applyBulkEditTemplate() {
    const hits = bulkTemplateHits.filter(hit => bulkPicked('bulkedit', hit.node));
    if (!hits.length) return;
    withUndo('Bulk edit titles', api => {
        hits.forEach(hit => {
            api.set(hit.node, 'title', hit.next);
            logAffected('REPAIR', hit.next, `Renamed from “${hit.before}” by the bulk title template.`, {
                source: 'Bulk edit titles',
                node: hit.node,
                oldTitle: hit.before,
                newTitle: hit.next,
                uri: nodeUri(hit.node),
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    renderFolderContents(currentFolder);
    scanBulkEditTemplate();
    notifyDone(`Renamed ${formatCount(hits.length)} bookmark(s). One Undo reverses the whole run.`);
}

// --- accessibility helpers ---
function openDialogs() {
    return [...document.querySelectorAll('.edit-dialog, .command-palette')].filter(dialog => !dialog.hidden);
}

function closeTopDialog() {
    const dialogs = openDialogs();
    if (!dialogs.length) return false;
    const dialog = dialogs[dialogs.length - 1];
    if (dialog.id === 'trash-dialog') closeTrashDialog();
    else if (dialog.id === 'preview-dialog') closePreviewDialog();
    else if (dialog.id === 'command-palette') toggleCommandPalette(false);
    else if (dialog.id === 'edit-item-dialog') closeEditItemDialog();
    else dialog.hidden = true;
    return true;
}

function announceStatus(message) {
    const live = document.getElementById('status-live');
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = String(message || ''); }, 30);
}


// --- URL cleaning rules: the lib owns the engine, this owns the stored list and its UI ---
const URL_RULES_KEY = 'bookmark-editor-url-rules';

function loadUrlRules() {
    const stored = readJsonStorage(URL_RULES_KEY, null);
    if (!stored) return getActiveUrlRules();
    try {
        const rules = Array.isArray(stored) ? stored : urlRulesFromJson(JSON.stringify(stored));
        setActiveUrlRules(rules);
    } catch (err) {
        setActiveUrlRules(null);
        console.error(err);
        notifyWarn(`Stored URL rules could not be read (${err.message}). The built-in rules are active.`);
    }
    return getActiveUrlRules();
}

function persistUrlRules(rules) {
    const active = setActiveUrlRules(rules);
    try {
        localStorage.setItem(URL_RULES_KEY, JSON.stringify(active));
    } catch (err) {
        alert(`The rules could not be saved: ${err.message}`);
    }
    renderActiveUrlRules();
    return active;
}

function activeUrlRulesJson() {
    const box = document.getElementById('url-rules-json');
    if (box) box.value = urlRulesToJson();
}

function renderActiveUrlRules() {
    const box = document.getElementById('url-rules-active');
    if (!box) return;
    const rules = getActiveUrlRules();
    box.innerHTML = rules.length
        ? `<ol class="rules-list">${rules.map(rule => `<li class="${rule.enabled === false ? 'is-off' : ''}">${escapeHtml(describeUrlRule(rule))}</li>`).join('')}</ol>`
        : '<p>No rules: URLs are left exactly as saved.</p>';
}

function saveUrlRulesFromEditor() {
    const box = document.getElementById('url-rules-json');
    const note = document.getElementById('url-rules-note');
    if (!box) return;
    let rules = null;
    try {
        rules = urlRulesFromJson(box.value);
    } catch (err) {
        if (note) note.textContent = err.message;
        return alert(`Those rules were not saved: ${err.message}`);
    }
    persistUrlRules(rules);
    if (note) note.textContent = `Saved ${formatCount(getActiveUrlRules().length)} rule(s). Copies, sends and the tidy use them from now on.`;
    markChanged();
    logAffected('SYSTEM', 'URL rules', `Saved ${formatCount(getActiveUrlRules().length)} URL cleaning rule(s): ${getActiveUrlRules().map(rule => describeUrlRule(rule)).join('; ')}.`, { source: 'Settings', kind: 'setting' });
    if (currentFolder) renderFolderContents(currentFolder);
}

function resetUrlRulesFromEditor() {
    if (!confirm('Reset the URL cleaning rules to the built-ins? Your custom rules are discarded.')) return;
    persistUrlRules(resetUrlRules());
    activeUrlRulesJson();
    logAffected('SYSTEM', 'URL rules', 'Reset the URL cleaning rules to the built-ins.', { source: 'Settings', kind: 'setting' });
    notifyDone('URL rules reset to the built-ins.');
}

function exportUrlRules() {
    downloadTextFile('bookmark-editor-url-rules.json', urlRulesToJson(), 'application/json');
    logAffected('SYSTEM', 'bookmark-editor-url-rules.json', `Exported ${formatCount(getActiveUrlRules().length)} URL cleaning rule(s) as JSON.`, { source: 'Settings', kind: 'export' });
    notifyDone('URL rules exported.');
}

function importUrlRules(event) {
    const input = event && event.target;
    const file = input && input.files ? input.files[0] : null;
    if (input) input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        const box = document.getElementById('url-rules-json');
        if (box) box.value = String(e.target.result || '');
        saveUrlRulesFromEditor();
    };
    reader.readAsText(file);
}

function pickUrlRulesImport() {
    document.getElementById('url-rules-upload')?.click();
}

function testUrlRulesFromEditor() {
    const input = document.getElementById('url-rules-test');
    const box = document.getElementById('url-rules-test-result');
    if (!input || !box) return;
    const uri = input.value.trim();
    if (!uri) return alert('Paste a URL to test first.');
    const result = testUrlRules(uri);
    const steps = result.steps.length
        ? `<ol class="rules-list">${result.steps.map(step => `<li>${escapeHtml(step.name)}: <span class="log-url">${escapeHtml(step.before)}</span> → <span class="log-url">${escapeHtml(step.after)}</span></li>`).join('')}</ol>`
        : '<p>No rule changes this URL.</p>';
    box.innerHTML = `<p><strong>Stripped:</strong> <span class="log-url">${escapeHtml(result.stripped || '(unchanged)')}</span><br>
        <strong>Copied/cleaned:</strong> <span class="log-url">${escapeHtml(result.canonical || '(unchanged)')}</span></p>${steps}`;
}


// --- scheduled jobs (live add-on: the background owns the alarms) ---
const EDITOR_SCHEDULED_JOBS_KEY = 'scheduledJobs';
const EDITOR_SCHEDULED_JOB_KINDS = ['tidy', 'tracker-strip', 'duplicate-report', 'dead-link-sweep'];
const SCHEDULED_JOB_LABELS = {
    tidy: 'Library tidy (strip trackers and remove empty folders)',
    'tracker-strip': 'Strip tracking parameters only',
    'duplicate-report': 'Duplicate report (no changes)',
    'dead-link-sweep': 'Dead-link sweep (HEAD checks, no changes)'
};
const EDITOR_LIBRARY_CHANGE_KEY = 'lastLibraryChange';
const LIBRARY_LOAD_STAMP_KEY = 'bookmark-editor-last-load';

let scheduledJobsCache = null;
let scheduledJobsMigrated = false;

function hasExtensionStorage() {
    try {
        return typeof browser !== 'undefined' && Boolean(browser.storage && browser.storage.local);
    } catch (err) {
        return false;
    }
}

function liveStorageGet(keys) {
    try {
        if (!hasExtensionStorage()) return Promise.resolve({});
        const result = browser.storage.local.get(keys);
        return result && typeof result.then === 'function' ? result : Promise.resolve(result || {});
    } catch (err) {
        return Promise.resolve({});
    }
}

function editorSendRuntimeMessage(message) {
    try {
        if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.sendMessage) return Promise.resolve(null);
        const result = browser.runtime.sendMessage(message);
        return result && typeof result.then === 'function' ? result : Promise.resolve(result);
    } catch (err) {
        return Promise.resolve(null);
    }
}

function jobFromTidySettings(tidy) {
    return {
        id: 'tidy',
        kind: 'tidy',
        enabled: Boolean(tidy && tidy.enabled),
        cadence: { type: 'weekly', weekday: Number(tidy && tidy.weekday) || 0, hour: Number.isFinite(Number(tidy && tidy.hour)) ? Number(tidy.hour) : 3 }
    };
}

async function loadScheduledJobs() {
    const box = document.getElementById('scheduled-jobs');
    const note = document.getElementById('scheduled-jobs-note');
    if (!box) return;
    if (!hasExtensionStorage()) {
        box.innerHTML = '<p>The scheduled jobs run in the live add-on only: the background owns the alarms.</p>';
        if (note) note.textContent = '';
        return;
    }
    const result = await liveStorageGet([EDITOR_SCHEDULED_JOBS_KEY, 'tidySettings']);
    const stored = Array.isArray(result[EDITOR_SCHEDULED_JOBS_KEY]) ? result[EDITOR_SCHEDULED_JOBS_KEY] : null;
    scheduledJobsMigrated = !stored;
    // Reading a legacy install shows the tidy as a job without writing the list, so the old
    // alarm keeps running until the user saves this form.
    scheduledJobsCache = stored ? stored.slice() : [jobFromTidySettings(result.tidySettings)];
    renderScheduledJobs();
}

function jobFor(kind) {
    return (scheduledJobsCache || []).find(job => job && job.kind === kind) || null;
}

function renderScheduledJobs() {
    const box = document.getElementById('scheduled-jobs');
    const note = document.getElementById('scheduled-jobs-note');
    if (!box) return;
    const jobs = scheduledJobsCache || [];
    box.innerHTML = `<table class="excel-table"><thead><tr><th>Job</th><th>On</th><th>Cadence</th><th>Weekday</th><th>Hour</th><th>Last run</th></tr></thead><tbody>
        ${EDITOR_SCHEDULED_JOB_KINDS.map(kind => {
            const job = jobFor(kind) || { enabled: false, cadence: { type: 'weekly', weekday: 0, hour: 3 } };
            const cadence = job.cadence || { type: 'weekly' };
            const last = job.lastResult || (kind === 'tidy' ? null : null);
            const lastText = last && last.at ? `${escapeHtml(last.summary || 'ran')} · ${escapeHtml(new Date(last.at).toLocaleString())}` : (job.lastRunAt ? escapeHtml(new Date(job.lastRunAt).toLocaleString()) : 'never');
            return `<tr>
                <td>${escapeHtml(SCHEDULED_JOB_LABELS[kind])}</td>
                <td><input type="checkbox" id="job-${kind}-enabled" ${job.enabled ? 'checked' : ''} aria-label="Enable ${escapeHtml(SCHEDULED_JOB_LABELS[kind])}"></td>
                <td><select id="job-${kind}-cadence" aria-label="Cadence for ${escapeHtml(SCHEDULED_JOB_LABELS[kind])}">
                    ${['hourly', 'daily', 'weekly'].map(type => `<option value="${type}"${cadence.type === type ? ' selected' : ''}>${type}</option>`).join('')}
                </select></td>
                <td><select id="job-${kind}-weekday" aria-label="Weekday for ${escapeHtml(SCHEDULED_JOB_LABELS[kind])}">
                    ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => `<option value="${index}"${Number(cadence.weekday) === index ? ' selected' : ''}>${day}</option>`).join('')}
                </select></td>
                <td><input type="number" min="0" max="23" id="job-${kind}-hour" value="${Number.isFinite(Number(cadence.hour)) ? Number(cadence.hour) : 3}" aria-label="Hour for ${escapeHtml(SCHEDULED_JOB_LABELS[kind])}"></td>
                <td class="job-last">${lastText}</td>
            </tr>`;
        }).join('')}
        </tbody></table>`;
    if (note) {
        note.textContent = scheduledJobsMigrated
            ? 'Your weekly tidy is shown as a job. Saving this form hands the schedule to the job list (the old tidy alarm is retired, and the tidy setting above follows this list).'
            : 'Saved in this browser and owned by the add-on background.';
    }
}

async function saveScheduledJobsFromForm() {
    if (!hasExtensionStorage()) return alert('Scheduled jobs are a live add-on feature.');
    const jobs = (scheduledJobsCache || []).slice();
    const tidyJob = jobFor('tidy') || jobFromTidySettings({});
    EDITOR_SCHEDULED_JOB_KINDS.forEach(kind => {
        const enabled = document.getElementById(`job-${kind}-enabled`);
        const cadence = document.getElementById(`job-${kind}-cadence`);
        const weekday = document.getElementById(`job-${kind}-weekday`);
        const hour = document.getElementById(`job-${kind}-hour`);
        if (!enabled) return;
        let entry = jobs.find(job => job && job.kind === kind);
        if (!entry) {
            entry = { id: kind, kind, enabled: false, cadence: { type: 'weekly', weekday: 0, hour: 3 } };
            jobs.push(entry);
        }
        entry.enabled = Boolean(enabled.checked);
        entry.cadence = {
            type: (cadence && cadence.value) || 'weekly',
            weekday: weekday ? Number(weekday.value) : 0,
            hour: hour ? Math.min(23, Math.max(0, Number(hour.value) || 0)) : 3
        };
    });
    try {
        await browser.storage.local.set({ [EDITOR_SCHEDULED_JOBS_KEY]: jobs });
    } catch (err) {
        console.error(err);
    }
    await editorSendRuntimeMessage({ type: 'job-settings', jobs });
    scheduledJobsCache = jobs;
    scheduledJobsMigrated = false;
    // Keep the legacy tidy controls in step so the two screens cannot disagree.
    const tidy = jobs.find(job => job && job.kind === 'tidy');
    if (tidy) {
        try { await browser.storage.local.set({ tidySettings: { enabled: Boolean(tidy.enabled), weekday: Number(tidy.cadence.weekday) || 0, hour: Number(tidy.cadence.hour) || 3 } }); } catch (err) {}
        paintTidySettings({ enabled: tidy.enabled, weekday: tidy.cadence.weekday, hour: tidy.cadence.hour });
    }
    renderScheduledJobs();
    notifyDone(`Saved ${formatCount(jobs.filter(job => job.enabled).length)} enabled job(s). The add-on background rescheduled them.`);
    logAffected('SYSTEM', 'Scheduled jobs', `Saved ${formatCount(jobs.length)} scheduled job(s); ${formatCount(jobs.filter(job => job.enabled).length)} enabled. The background owns the alarms.`, { source: 'Settings', kind: 'setting' });
}

async function rescheduleScheduledJobs() {
    if (!hasExtensionStorage()) return alert('Scheduled jobs are a live add-on feature.');
    await editorSendRuntimeMessage({ type: 'job-settings' });
    notifyDone('Asked the background to reschedule from what is stored.');
    await loadScheduledJobs();
}

// --- library changed elsewhere ---
let libraryChangedSeen = null;

function showLibraryChangedBanner(info) {
    const banner = document.getElementById('library-changed-banner');
    const text = document.getElementById('library-changed-text');
    if (!banner) return;
    libraryChangedSeen = info || {};
    const when = info && info.at ? new Date(info.at).toLocaleTimeString() : 'just now';
    const what = { created: 'a bookmark was added', removed: 'a bookmark was removed', changed: 'a bookmark changed', moved: 'a bookmark moved' }[info && info.kind] || 'the library changed';
    if (text) text.textContent = `The library changed in another window (${when}: ${what}). This view may be out of date.`;
    banner.hidden = false;
    announceStatus('Library changed elsewhere');
}

function dismissLibraryChanged() {
    const banner = document.getElementById('library-changed-banner');
    if (banner) banner.hidden = true;
}

function reloadFromLibraryBanner() {
    dismissLibraryChanged();
    return reloadLiveLibrary();
}

function listenForLibraryChanges() {
    try {
        if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.onMessage) return;
        browser.runtime.onMessage.addListener(message => {
            if (!message || message.type !== 'library-changed') return;
            // Our own writes also bump the stamp, so only warn while we are looking at a
            // library we did not just reload ourselves.
            if (message.at && libraryLoadStampAt && message.at <= libraryLoadStampAt) return;
            showLibraryChangedBanner(message);
        });
    } catch (err) {}
}

let libraryLoadStampAt = 0;

function stampLibraryLoad() {
    libraryLoadStampAt = Date.now();
    writeJsonStorage(LIBRARY_LOAD_STAMP_KEY, libraryLoadStampAt, true);
}

async function checkLibraryChangedSinceLoad() {
    if (!hasExtensionStorage()) return;
    const stored = await liveStorageGet([EDITOR_LIBRARY_CHANGE_KEY, LIBRARY_LOAD_STAMP_KEY]);
    const change = stored[EDITOR_LIBRARY_CHANGE_KEY];
    const stamp = Number(stored[LIBRARY_LOAD_STAMP_KEY]) || 0;
    if (change && change.at && stamp && change.at > stamp) showLibraryChangedBanner(change);
}


// --- live write outbox: what the add-on has queued, and what failed ---
function retryLiveWrites() {
    if (typeof retryFailedLiveWrites !== 'function') return alert('Nothing to retry: this build writes to the session tree only.');
    const count = retryFailedLiveWrites();
    notifyDone(count ? `Retrying ${formatCount(count)} failed write(s).` : 'No failed writes to retry.');
    renderLiveOutbox();
}

function clearLiveOutbox() {
    if (typeof clearFinishedLiveWrites !== 'function') return;
    clearFinishedLiveWrites();
    renderLiveOutbox();
}

function renderLiveOutbox() {
    const box = document.getElementById('live-outbox');
    if (!box) return;
    const queue = typeof liveOutbox === 'undefined' ? [] : liveOutbox;
    if (!queue.length) {
        box.innerHTML = '<p>No live writes queued yet. Failed writes stay here with their error so they can be retried.</p>';
        return;
    }
    const failed = queue.filter(entry => entry.status === 'failed').length;
    const pending = queue.filter(entry => entry.status === 'pending').length;
    box.innerHTML = `<p>${formatCount(pending)} pending, ${formatCount(failed)} failed, ${formatCount(queue.length)} remembered.</p>
        <table class="excel-table"><thead><tr><th>Write</th><th>Status</th><th>When</th><th>Error</th></tr></thead><tbody>
        ${queue.slice(0, 20).map(entry => `<tr>
            <td>${escapeHtml(entry.label)}</td>
            <td class="job-last">${escapeHtml(entry.status)}</td>
            <td class="row-date">${escapeHtml(new Date(entry.at).toLocaleTimeString())}</td>
            <td class="job-last">${escapeHtml(entry.error || '')}</td>
        </tr>`).join('')}
        </tbody></table>`;
}


// --- per-folder column widths (drag a header edge; remembered per folder) ---
const COLUMN_WIDTHS_KEY = 'bookmark-editor-column-widths';
const COLUMN_MIN_PX = 60;

let columnWidthsMemory = {};

function loadColumnWidths() {
    const stored = readJsonStorage(COLUMN_WIDTHS_KEY, {});
    columnWidthsMemory = stored && typeof stored === 'object' ? stored : {};
}

function saveColumnWidths() {
    writeJsonStorage(COLUMN_WIDTHS_KEY, columnWidthsMemory, true);
}

function columnWidthsFor(folderNode) {
    if (!folderNode) return null;
    return columnWidthsMemory[folderPathLabel(folderNode)] || null;
}

function applyColumnWidths(folderNode) {
    const table = document.getElementById('bookmarks-table');
    if (!table) return;
    const headers = [...table.querySelectorAll('thead th')];
    const widths = columnWidthsFor(folderNode);
    const reset = document.getElementById('column-reset');
    if (reset) reset.hidden = !widths;
    if (!widths) {
        headers.forEach(th => { th.style.width = ''; });
        return;
    }
    const keys = ['name', 'location', 'added', 'tags'];
    headers.forEach((th, index) => {
        const key = keys[index];
        th.style.width = key && widths[key] ? `${widths[key]}px` : '';
    });
}

function bindColumnResize() {
    const table = document.getElementById('bookmarks-table');
    if (!table || table.dataset.resizeBound === '1') return;
    table.dataset.resizeBound = '1';
    const headers = [...table.querySelectorAll('thead th')];
    headers.forEach((th, index) => {
        th.classList.add('resizable-col');
        th.addEventListener('mousedown', event => {
            const rect = th.getBoundingClientRect();
            if (rect.right - event.clientX > 8) return;
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = rect.width;
            const key = ['name', 'location', 'added', 'tags'][index];
            const move = moveEvent => {
                const width = Math.max(COLUMN_MIN_PX, Math.round(startWidth + (moveEvent.clientX - startX)));
                th.style.width = `${width}px`;
                const folder = currentFolder;
                const label = folderPathLabel(folder);
                if (label && key) {
                    columnWidthsMemory[label] = { ...(columnWidthsMemory[label] || {}), [key]: width };
                }
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                document.body.classList.remove('resizing-columns');
                if (currentFolder) applyColumnWidths(currentFolder);
                saveColumnWidths();
            };
            document.body.classList.add('resizing-columns');
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    });
}

function resetColumnWidths() {
    if (!currentFolder) return;
    const label = folderPathLabel(currentFolder);
    delete columnWidthsMemory[label];
    saveColumnWidths();
    applyColumnWidths(currentFolder);
    notifyDone(`Column widths for “${label || 'this folder'}” reset.`);
}


// --- self-tests, in the app ---
let lastSelfTestRun = null;

function runSelfTestsFromCard() {
    const box = document.getElementById('repairs-selftest-results');
    if (typeof runSelfTests !== 'function') {
        if (box) box.innerHTML = '<p>The self-test module (js/self-tests.js) is not loaded.</p>';
        return null;
    }
    const run = runSelfTests();
    lastSelfTestRun = run;
    if (box) box.innerHTML = selfTestsSummaryHtml(run);
    if (run.failed) notifyWarn(`${formatCount(run.failed)} self-test check(s) failed.`);
    else notifyDone(`All ${formatCount(run.passed)} self-test check(s) passed in ${formatCount(run.ms)} ms.`);
    return run;
}

function copySelfTestReport() {
    const run = lastSelfTestRun || runSelfTestsFromCard();
    if (!run) return;
    copyTextToClipboard(selfTestsMarkdown(run));
    notifyDone('Self-test report copied.');
}

function openSelfTestPage() {
    try {
        const url = (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL)
            ? browser.runtime.getURL('self-test.html')
            : 'self-test.html';
        window.open(url, '_blank', 'noopener');
        logAffected('SYSTEM', 'Self-tests', 'Opened the standalone self-test page.', { source: 'Self-tests', kind: 'open' });
    } catch (err) {
        alert(`Could not open the self-test page: ${err.message}`);
    }
}


// --- saved searches: "smart folders" in the sidebar ---
const SMART_FOLDERS_KEY = 'bookmark-editor-smart-folders';
let smartFolders = [];

function loadSmartFolders() {
    const stored = readJsonStorage(SMART_FOLDERS_KEY, []);
    smartFolders = Array.isArray(stored) ? stored.filter(entry => entry && entry.query).slice(0, 30) : [];
}

function saveSmartFolders() {
    writeJsonStorage(SMART_FOLDERS_KEY, smartFolders, true);
}


function openSmartFolder(id) {
    const entry = smartFolders.find(item => item.id === id);
    if (!entry) return;
    const input = document.getElementById('bookmark-search');
    const everywhere = document.getElementById('bookmark-search-everywhere');
    const recursive = document.getElementById('bookmark-search-recursive');
    if (input) input.value = entry.query;
    if (everywhere) everywhere.checked = Boolean(entry.everywhere);
    if (recursive) recursive.checked = entry.recursive !== false;
    switchTabById('bookmarks-view');
    filterFolderContents();
    rememberSearch(entry.query, entry.everywhere);
}

function deleteSmartFolder(id) {
    const entry = smartFolders.find(item => item.id === id);
    if (!entry) return;
    if (!confirm(`Delete the smart folder “${entry.name}”? The search itself is not affected.`)) return;
    smartFolders = smartFolders.filter(item => item.id !== id);
    saveSmartFolders();
    renderSidebar();
    logAffected('SYSTEM', entry.name, 'Deleted a smart folder. No bookmarks changed.', { source: 'Smart folders', kind: 'delete' });
}

function smartFoldersSidebarHtml() {
    if (!smartFolders.length) return '';
    return `<div class="smart-folders"><div class="smart-folders-head">Saved searches</div>
        ${smartFolders.map(entry => `<div class="smart-folder-row" data-smart-folder="${escapeHtml(entry.id)}" title="${escapeHtml(entry.query)}${entry.everywhere ? ' (whole library)' : ''}">
            <span class="smart-folder-name">${escapeHtml(entry.name)}</span>
            <button type="button" class="smart-folder-remove" data-smart-remove="${escapeHtml(entry.id)}" aria-label="Delete the smart folder ${escapeHtml(entry.name)}">×</button>
        </div>`).join('')}</div>`;
}

function bindSmartFolderRows(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-smart-folder]').forEach(row => {
        row.onclick = event => {
            if (event.target.closest('[data-smart-remove]')) return;
            openSmartFolder(row.dataset.smartFolder);
        };
    });
    scope.querySelectorAll('[data-smart-remove]').forEach(button => {
        button.onclick = event => {
            event.stopPropagation();
            deleteSmartFolder(button.dataset.smartRemove);
        };
    });
}

// --- never-opened bookmarks ---
const UNUSED_THRESHOLD_DEFAULT = 12;
const UNUSED_THRESHOLD_CAP = 3000;
let unusedHits = [];

function unusedThresholdMonths() {
    const value = Number(document.getElementById('repairs-unused-months')?.value || UNUSED_THRESHOLD_DEFAULT);
    return Number.isFinite(value) && value > 0 ? value : UNUSED_THRESHOLD_DEFAULT;
}

function collectUnusedHits(months) {
    const cutoff = Date.now() - months * 30.44 * 86400000;
    const hits = [];
    if (!bookmarkData) return hits;
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const uri = nodeUri(link);
        if (!uri) return;
        const used = typeof parseBookmarkDateMs === 'function' ? parseBookmarkDateMs(link.dateLastUsed) : 0;
        if (used && used > cutoff) return;
        hits.push({ node: link, used, folderPath: folderPathFor(link) });
    });
    // Oldest (or never) first, so the worst offenders are at the top.
    return hits.sort((a, b) => (a.used || 0) - (b.used || 0)).slice(0, UNUSED_THRESHOLD_CAP);
}

function scanUnusedBookmarks() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const months = unusedThresholdMonths();
    unusedHits = collectUnusedHits(months);
    const withDates = unusedHits.filter(hit => hit.used).length;
    startBulkPick('unused');
    renderRepairPreview(
        'repairs-unused-results',
        `Every bookmark has been opened in the last ${formatCount(months)} month(s), as far as the browser records it.`,
        `${formatCount(unusedHits.length)} bookmark(s) with no recorded use in ${formatCount(months)} month(s): ${formatCount(unusedHits.length - withDates)} never recorded as opened, ${formatCount(withDates)} older than the cut-off. Firefox only reports a last-used date for some bookmarks.`,
        [{ pick: 'unused' }, 'Title', 'Last opened', 'Folder', 'URL'],
        unusedHits.map(hit => [
            bulkPickBox('unused', hit.node),
            escapeHtml(libraryNodeName(hit.node)),
            hit.used ? escapeHtml(new Date(hit.used).toLocaleDateString()) : 'never recorded',
            escapeHtml(hit.folderPath || 'top level'),
            `<span class="log-url">${escapeHtml(nodeUri(hit.node))}</span>`
        ])
    );
    setBulkPlan('unused', { count: unusedHits.length, label: `Delete ${formatCount(months)}-month-old bookmarks`, apply: applyUnusedDeletion });
    logAffected('SYSTEM', 'Never opened', `Found ${formatCount(unusedHits.length)} bookmark(s) with no recorded use in ${formatCount(months)} month(s) (${formatCount(unusedHits.length - withDates)} never recorded). Scan did not change anything.`, { source: 'General repairs', scan: true });
}

function applyUnusedDeletion() {
    const victims = unusedHits.filter(hit => bulkPicked('unused', hit.node)).map(hit => hit.node);
    if (!victims.length) return;
    if (typeof previewDeleteLibraryNodes === 'function') {
        // The shared preview owns the confirmation and honours protected folders.
        previewDeleteLibraryNodes(victims);
        return;
    }
    withUndo('Delete never-opened bookmarks', api => {
        victims.forEach(node => {
            const parent = findNodeParent(node);
            if (parent) api.remove(node, parent);
        });
    });
    markChanged();
    renderSidebar();
    scanUnusedBookmarks();
}

// --- send a report to Obsidian ---
function reportMarkdownTable(headers, rows) {
    const line = cells => `| ${cells.join(' | ')} |`;
    return [line(headers), line(headers.map(() => '---'))].concat(rows.map(line)).join('\n');
}

function reportMarkdown(kind) {
    const title = new Date().toLocaleString();
    if (kind === 'folders' && typeof buildFolderSizeRanking === 'function') {
        const model = buildFolderSizeRanking();
        return `## Folder sizes\n\n${reportMarkdownTable(['#', 'Folder', 'Links', 'Folders', 'Empty'], model.rows.slice(0, 50).map(row => [row.rank, row.path, row.links, row.folders, row.emptyFolders]))}\n`;
    }
    if (kind === 'domains' && typeof buildDomainHealthTable === 'function') {
        const model = buildDomainHealthTable();
        return `## Domain health\n\n${reportMarkdownTable(['Domain', 'Links', 'Tracked', 'Duplicates', 'Broken', 'Never used'], model.rows.slice(0, 100).map(row => [row.rdnn, row.total, row.tracked, row.duplicates, row.broken, row.neverUsed]))}\n`;
    }
    if (kind === 'health') {
        const rows = typeof libraryHealthRows === 'function' ? libraryHealthRows() : [];
        const problems = typeof collectLibraryProblems === 'function' ? collectLibraryProblems() : null;
        return `## Library health (${title})\n\n${reportMarkdownTable(['Scan', 'Findings'], rows.map(row => [row.label, row.count]))}\n${problems ? `\nStructural: ${problems.untitled.length} untitled, ${problems.badUrl.length} non-page URL(s), ${problems.folderNames.length} duplicate folder name(s), ${problems.dateAnomalies.length} date anomaly(ies).\n` : ''}`;
    }
    if (kind === 'folder' && currentFolder) {
        const report = typeof folderReportModel === 'function' ? folderReportModel(currentFolder) : null;
        if (report && typeof folderReportText === 'function') return `## Folder report\n\n${folderReportText(report)}\n`;
    }
    return '';
}

function sendReportToObsidian(kind) {
    const markdown = reportMarkdown(kind);
    if (!markdown) return alert('That report has nothing to send yet (or its builder is unavailable).');
    if (typeof sendMarkdownToObsidian !== 'function') return alert('The Obsidian sender is unavailable in this build.');
    sendMarkdownToObsidian(markdown, '');
    logAffected('SYSTEM', `${kind} report`, `Sent a ${kind} report (${formatCount(markdown.length)} characters of markdown) to Obsidian. No bookmarks changed.`, { source: 'Reports', kind: 'send' });
    notifyDone('Report sent to Obsidian.');
}


// --- search syntax: optional, per-family configurable, and clickable ---
const SEARCH_FAMILIES = [
    { key: 'domain', label: 'domain:', hint: 'domain:example.com — host or any subdomain', input: 'text', placeholder: 'example.com' },
    { key: 'folder', label: 'folder:', hint: 'folder:Cats — folder path', input: 'text', placeholder: 'Cats' },
    { key: 'tag', label: 'tag:', hint: 'tag:recipe — a tag on the bookmark', input: 'text', placeholder: 'recipe' },
    { key: 'type', label: 'type:', hint: 'type:pdf, type:image, type:web — an extension, or image / video / audio / doc / sheet / slide / archive / code / web / file', input: 'text', placeholder: 'pdf' },
    { key: 'title', label: 'title:', hint: 'title:postgres — words in the title', input: 'text', placeholder: 'postgres' },
    { key: 'url', label: 'url:', hint: 'url:docs — words in the URL', input: 'text', placeholder: 'docs' },
    { key: 'added', label: 'added:', hint: 'added:>2024-01 — added after or before a date', input: 'date' },
    { key: 'has', label: 'has:', hint: 'has:note, has:dupe, has:tracked, has:folder, has:date', input: 'choice', choices: ['note', 'dupe', 'tracked', 'folder', 'date'] },
    { key: 'is', label: 'is:', hint: 'is:tracked, is:dupe, is:untitled, is:folder, is:bookmark, is:noted', input: 'choice', choices: ['tracked', 'dupe', 'untitled', 'folder', 'bookmark', 'noted'] },
    { key: 'exclude', label: '-word', hint: 'plain words that must not appear', input: 'text', placeholder: 'spam draft' },
    { key: 'regex', label: '/pattern/', hint: 'a regular expression tested against each field', input: 'text', placeholder: '^how to .*\\d+$' }
];
const SEARCH_FAMILY_KEYS = SEARCH_FAMILIES.map(family => family.key);
const SEARCH_FAMILY_LABELS = SEARCH_FAMILIES.reduce((map, family) => { map[family.key] = family.label; return map; }, {});

function searchSyntaxEnabled() {
    const value = readEditorSettings().searchOperators;
    return value === undefined ? true : value !== false && value !== 'false' && value !== 0 && value !== '0';
}

function searchWholeWordsEnabled() {
    return readEditorSettings().searchWholeWords === true || readEditorSettings().searchWholeWords === 'true';
}

function searchCaseSensitiveEnabled() {
    return readEditorSettings().searchCaseSensitive === true || readEditorSettings().searchCaseSensitive === 'true';
}

// The optional slow path: re-derive everything from the live tree instead of trusting the cached
// index, the cached match context and the parent Map the picker's walk fills. Quadratic on purpose
// (findNodeParent walks the library per node), off by default, and the meta line names it.
function searchExhaustiveEnabled() {
    return readEditorSettings().exhaustiveSearch === true || readEditorSettings().exhaustiveSearch === 'true';
}

function enabledSearchFamilies() {
    const raw = readEditorSettings().searchSyntaxFamilies;
    if (raw === undefined) return new Set(SEARCH_FAMILY_KEYS);
    const list = String(raw || '').split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
    // An empty string means "no families": the master switch is the way to turn syntax back on.
    return new Set(list.filter(key => SEARCH_FAMILY_KEYS.includes(key)));
}

function searchFamilyEnabled(key, families) {
    if (!searchSyntaxEnabled()) return false;
    return (families || enabledSearchFamilies()).has(String(key).toLowerCase());
}

function parseLibraryQuery(raw, options = {}) {
    const parsed = { text: '', terms: [], not: [], domain: [], folder: [], title: [], url: [], tag: [], type: [], has: [], is: [], added: [], regex: null, invalidRegex: '', literal: false, operators: 0, expr: null, wholeWords: false, caseSensitive: false };
    const source = String(raw || '').trim();
    if (!source) return parsed;
    const syntax = options.syntax === undefined ? searchSyntaxEnabled() : Boolean(options.syntax);
    const families = options.families || enabledSearchFamilies();
    const on = key => syntax && families.has(key);
    parsed.wholeWords = options.wholeWords === undefined ? searchWholeWordsEnabled() : Boolean(options.wholeWords);
    parsed.caseSensitive = options.caseSensitive === undefined ? searchCaseSensitiveEnabled() : Boolean(options.caseSensitive);
    if (!syntax) {
        // Optional means optional: with the switch off the whole query is one literal phrase.
        parsed.literal = true;
        parsed.text = source.toLowerCase();
        parsed.terms = [source.toLowerCase()];
        return parsed;
    }
    const regexForm = on('regex') ? source.match(/^\/(.+)\/([a-z]*)$/) : null;
    if (regexForm) {
        try {
            parsed.regex = new RegExp(regexForm[1], regexForm[2].includes('i') ? 'i' : '');
            return parsed;
        } catch (err) {
            parsed.invalidRegex = err.message;
        }
    }
    // One pass: every token is classified (which fills the flat arrays the panel, the
    // plain-English line and the everywhere prefilter read) and the classified stream is then
    // shaped into the boolean tree, so the two can never disagree.
    const classified = [];
    searchQueryTokens(source).forEach(item => {
        if (item.type === '(' || item.type === ')') { classified.push({ type: item.type, negate: Boolean(item.negate) }); return; }
        if (/^(or|\|)$/i.test(item.text) && !item.negate) { classified.push({ type: 'term', text: 'OR' }); return; }
        if (/^and$/i.test(item.text) && !item.negate) { classified.push({ type: 'term', text: 'AND' }); return; }
        const leaf = classifySearchToken(item.text, Boolean(item.negate), on, parsed);
        if (leaf) classified.push({ type: 'term', leaf, negate: Boolean(item.negate) });
    });
    const tree = searchQueryTree(classified);
    parsed.expr = tree && tree.op === 'and' ? foldSearchFamilyAlternatives(tree) : tree;
    parsed.text = parsed.terms.join(' ');
    return parsed;
}

// The compatibility path: a hand-built or older parsed object still searches the way it always
// did, by turning its flat arrays into the same leaves the tree uses.
function libraryQueryFlatMatches(node, parsed, context, relPath) {
    if (!parsed) return true;
    const kids = [];
    const family = (name) => {
        const values = (parsed[name] || []).filter(Boolean);
        if (values.length) kids.push({ op: 'leaf', kind: 'family', family: name, value: values });
    };
    ['domain', 'folder', 'title', 'url', 'tag', 'type', 'has', 'is'].forEach(family);
    (parsed.added || []).forEach(range => kids.push({ op: 'leaf', kind: 'added', added: range, value: '' }));
    (parsed.terms || []).forEach(term => kids.push({ op: 'leaf', kind: 'text', value: term }));
    (parsed.not || []).forEach(term => kids.push({ op: 'not', kids: [{ op: 'leaf', kind: 'text', value: term }] }));
    return libraryQueryExpressionMatches(node, { op: 'and', kids }, context || {}, relPath, parsed);
}

function hasSearchOperators(raw) {
    if (!searchSyntaxEnabled()) return false;
    const text = String(raw || '');
    const families = enabledSearchFamilies();
    if (families.has('regex') && /^\/.+\/[a-z]*$/.test(text.trim())) return true;
    if (families.has('exclude') && /(^|\s)-/.test(text)) return true;
    return (text.match(/(^|\s)([a-z]+):/gi) || []).some(match => families.has(match.trim().replace(':', '').toLowerCase()));
}

// Strip the operator tokens we are about to rebuild from the panel, keeping the rest verbatim.
function searchQueryWithoutOperators(raw) {
    const families = enabledSearchFamilies();
    const keys = ['domain', 'folder', 'title', 'url', 'has', 'is', 'added'].filter(key => families.has(key));
    if (!keys.length && !families.has('exclude')) return String(raw || '').trim();
    const pattern = new RegExp(
        '(^|\\s)(-?' + (keys.length ? `(?:${keys.join('|')}):(?:"[^"]*"|\\S+)` : '(?!)') + '|' + (families.has('exclude') ? '-\\S+' : '(?!)') + ')',
        'gi'
    );
    return String(raw || '').replace(pattern, ' ').replace(/\s+/g, ' ').trim();
}

function searchOperatorPanelVisible() {
    const panel = document.getElementById('search-operators');
    return Boolean(panel && !panel.hidden);
}

function toggleSearchOperatorsPanel(force) {
    const panel = document.getElementById('search-operators');
    if (!panel) return;
    if (!searchSyntaxEnabled()) {
        notifyWarn('Search syntax is off, so the filter panel is off too. Turn it on in Settings → Search syntax.');
        return;
    }
    const show = typeof force === 'boolean' ? force : panel.hidden;
    if (!show) {
        closeSearchOperatorsPanel();
        return;
    }
    // Opening is what applies the default (and only opening: the × re-shows the panel it is
    // already in, and that must be able to leave the folder box empty).
    const wasHidden = panel.hidden;
    panel.hidden = false;
    renderSearchOperatorPanel();
    syncSearchOperatorForm();
    updateSearchOperatorPlain();
    if (wasHidden) followTreeFolderInFilters();
}

// The folder and domain boxes are comboboxes: a text box with a list merged under it.
//   folder — every folder in the library, indented by depth. Clicking a folder that has
//            subfolders opens or closes it instead of selecting it; the Use button that
//            appears on hover (or Enter on a highlighted row) is what takes the folder.
//   domain — the domains that really exist in the library, in reverse domain order
//            (`com.example`), with how many links each has. Picking one inserts that text, and
//            the domain: filter accepts the reversed form as well as the usual one.
let comboActive = -1;
let comboOpenInput = null;
const comboExpanded = new Set();
// The treeview and the folder box share one idea of "where you are": the folder the tree has
// selected is the box's default (comboTreeFolder), the label this code last wrote into it is
// remembered (comboDefaultFolder) so a value the user typed or picked is never overwritten.
let comboTreeFolder = null;
let comboDefaultFolder = '';
// How many rows the folder list draws before it stops: a whole-library outline can be thousands of
// rows long, and this renders on every keystroke. Main folders are never counted against it.
const COMBO_ROW_CAP = 200;
let comboDismissBound = false;

function comboOf(input) {
    return input && typeof input.closest === 'function' ? input.closest('.operator-combo') : null;
}

function comboListEl(input) {
    const combo = comboOf(input);
    return combo ? combo.querySelector('[data-combo-list]') : null;
}

function comboKind(input) {
    return input && input.dataset ? String(input.dataset.comboSource || '') : '';
}

function folderPickLabel(node) {
    const title = displayFolderTitle(node) || (node && node.title) || '';
    const view = typeof subredditFolderView === 'function' ? subredditFolderView(title) : null;
    return { label: String((view && view.label) || title), markHtml: (view && view.markHtml) || '' };
}

function comboChildFolders(node) {
    const parent = node || bookmarkData;
    return ((parent && parent.children) || []).filter(isBookmarkFolderNode);
}

// node → its folder parent, filled by the single walk in comboFolderEntries(). The outline needs an
// entry's whole ancestor chain, and asking findNodeParent for it walks the entire library once per
// entry: with 1,000 folders in a 20,000-bookmark library that was 409 ms for every picker render,
// and it is quadratic, so a 100,000-bookmark library made the folder box unusable.
const comboFolderParents = new Map();

// The library's own roots: the top-level rows the tree shows (Bookmarks Toolbar, Bookmarks Menu,
// Other Bookmarks, Mobile Bookmarks). Read from the root's children rather than findNodeParent, so
// it stays cheap enough to ask per row.
function comboMainFolders() {
    return comboChildFolders(bookmarkData);
}

// Every folder below one, at any depth — what a click on a main folder unfolds.
function comboBranchFolders(node) {
    const out = [];
    const walk = current => {
        comboChildFolders(current).forEach(child => {
            out.push(child);
            walk(child);
        });
    };
    walk(node);
    return out;
}

function comboFolderEntries() {
    const out = [];
    comboFolderParents.clear();
    const walk = (node, depth, path) => {
        comboChildFolders(node).forEach(child => {
            const label = folderPickLabel(child).label;
            const next = path ? `${path} / ${label}` : label;
            out.push({ node: child, parent: node, depth, path: next, label, kids: comboChildFolders(child).length });
            comboFolderParents.set(child, node);
            walk(child, depth + 1, next);
        });
    };
    if (bookmarkData) walk(bookmarkData, 0, '');
    return out;
}

// The folder ancestors of one entry. Normally from comboFolderParents, which the last
// comboFolderEntries() walk filled — no tree walking. With the exhaustive option on, the chain is
// re-derived by walking the library instead (the old quadratic way), which is the point of it: the
// two must agree row for row.
function comboFolderAncestors(node) {
    const out = [];
    if (searchExhaustiveEnabled()) {
        for (let parent = findNodeParent(node); parent && parent !== bookmarkData; parent = findNodeParent(parent)) {
            out.push(parent);
        }
        return out;
    }
    for (let parent = comboFolderParents.get(node); parent && parent !== bookmarkData; parent = comboFolderParents.get(parent)) {
        out.push(parent);
    }
    return out;
}

function comboFolderVisible(entries, term) {
    if (!term) {
        // The children of whatever is open, so the list reads as an indented outline.
        return entries.filter(entry => comboFolderAncestors(entry.node).every(parent => comboExpanded.has(parent)));
    }
    // A search shows the matches and the path down to them.
    const keep = new Set();
    entries.forEach(entry => {
        if (!entry.label.toLowerCase().includes(term) && !entry.path.toLowerCase().includes(term)) return;
        keep.add(entry.node);
        comboFolderAncestors(entry.node).forEach(parent => keep.add(parent));
    });
    return entries.filter(entry => keep.has(entry.node));
}

// --- the folder box defaults to the folder the treeview has selected ---
// A label, not a path: `folder:` matches any hit whose path contains the value, so the folder's
// own name finds its whole subtree (and the tree row reads the same in both places).
function comboTreeFolderLabel() {
    if (!comboTreeFolder || comboTreeFolder === bookmarkData) return '';
    return folderPickLabel(comboTreeFolder).label || '';
}

function comboTreeFolderRowIndex() {
    if (!comboTreeFolder || comboTreeFolder === bookmarkData) return -1;
    return comboRows.findIndex(row => row && row.node === comboTreeFolder);
}

// Opening the list walks down to the tree folder: its ancestors, and the folder itself the way
// the tree shows an open folder, are unfolded, so the list is already at that branch.
function expandComboToTreeFolder() {
    if (!comboTreeFolder || comboTreeFolder === bookmarkData) return;
    comboExpanded.add(comboTreeFolder);
    for (let parent = findNodeParent(comboTreeFolder); parent && parent !== bookmarkData; parent = findNodeParent(parent)) {
        comboExpanded.add(parent);
    }
}

function scrollComboToTreeFolder(input) {
    const list = comboListEl(input);
    const index = comboTreeFolderRowIndex();
    if (!list || index < 0 || typeof list.querySelectorAll !== 'function') return;
    const row = [...list.querySelectorAll('.combo-row')][index];
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
}

// The folder filter's default is the folder the tree has open, and it stands by in the panel's own
// box: no query is rebuilt and no list is drawn, because opening the Filters panel — which a click
// in the search box does — must never search the whole open folder. On a large library that search
// *is* the freeze. The default joins the query at the first deliberate move inside the panel, where
// liveEditSearchFromForm() rebuilds it from the free text plus these boxes.
// Only an empty box or the value this default wrote follows the tree; anything else is the user's
// own choice. The comparison is lowercased because syncSearchOperatorForm writes parsed values back
// lowercased.
function followTreeFolderInFilters() {
    if (!searchOperatorPanelVisible()) return false;
    if (!searchSyntaxEnabled() || !searchFamilyEnabled('folder')) return false;
    const panel = document.getElementById('search-operators');
    const field = panel ? panel.querySelector('[data-operator-input="folder"]') : null;
    if (!field || field === document.activeElement) return false;
    const label = comboTreeFolderLabel();
    const current = String(field.value || '').trim().toLowerCase();
    if (current && current !== comboDefaultFolder) return false;
    if (current === label.toLowerCase()) return false;
    // A default that a panel move already folded into the query is taken back out here: the tree
    // folder scopes the search on its own, and re-running it on every tree click is the same freeze.
    withdrawSearchFolderToken(comboDefaultFolder);
    comboDefaultFolder = label.toLowerCase();
    field.value = label;
    // The × belongs on screen for a filter that is standing by, and Apply lights up for it, but no
    // row is drawn and nothing is searched until one of them is used.
    updateSearchClearButton();
    updateSearchApplyButton();
    return true;
}

// Remove one `folder:` token from the search box, and only when its value is exactly this one — a
// folder the user typed themselves is never touched.
function withdrawSearchFolderToken(value) {
    const want = String(value || '').trim().toLowerCase();
    const input = document.getElementById('bookmark-search');
    if (!want || !input || !String(input.value || '').trim()) return;
    const next = String(input.value).replace(/(^|\s)(-?folder:)(?:"([^"]*)"|(\S+))/gi,
        (match, lead, key, quoted, bare) => String(quoted === undefined ? bare : quoted).toLowerCase() === want ? lead : match);
    if (next === input.value) return;
    input.value = next.replace(/\s+/g, ' ').trim();
    syncSearchOperatorForm();
    updateSearchOperatorPlain();
    updateSearchClearButton();
}

// A host that is an address rather than a name: reversing it would be nonsense, so the domain
// list shows it exactly as it is (`192.168.1.10`, `::1`).
// What a URL contributes to a domain search. A page with no host — about:config,
// chrome://settings, a file: URL, an extension page — is keyed by its scheme and first path
// segment instead, so `domain:about` finds every about: link and `domain:about:config` finds
// one. Reversing such a key would be nonsense, which is why isIpAddressHost (any colon) keeps
// them out of the reverse-domain path.
function domainSearchKey(uri) {
    const text = String(uri || '').trim();
    if (!text) return '';
    let url = null;
    try {
        url = new URL(text);
    } catch (err) {
        return '';
    }
    const scheme = String(url.protocol || '').replace(/:$/, '').toLowerCase();
    const host = String(url.hostname || '').toLowerCase();
    const segment = String(url.pathname || '').replace(/^\/+/, '').split('/')[0].replace(/\/+$/, '').toLowerCase();
    // Every about: page shares one suggestion, `about`, rather than filling the list with
    // about:config, about:preferences and the rest. A specific page can still be typed
    // (`domain:about:config`), which domainSearchPageKey answers.
    if (scheme === 'about') return 'about';
    // Other internal schemes (chrome:, moz-extension:, resource:) are keyed by the scheme
    // alone: their "host" is a page name or a UUID and reads as nonsense in a domain list.
    if (scheme && scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp' && scheme !== 'file') return scheme;
    // file: and web URLs keep their host (file: has none, so it is just the scheme).
    return host || scheme;
}

function isIpAddressHost(host) {
    const bare = String(host || '').replace(/^\[|\]$/g, '');
    if (!bare) return false;
    if (bare.includes(':')) return true;
    const parts = bare.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// The page behind an about: URL, for a filter that names one (`domain:about:config`).
function domainSearchPageKey(uri) {
    const text = String(uri || '').trim();
    if (!/^about:/i.test(text)) return '';
    const rest = text.replace(/^about:/i, '').split(/[#?]/)[0].replace(/\/+$/, '').toLowerCase();
    return rest ? `about:${rest}` : 'about';
}

function bareHost(host) {
    return String(host || '').replace(/^\[|\]$/g, '');
}

function comboDomainEntries() {
    const counts = new Map();
    const walk = (node) => {
        const key = domainSearchKey(nodeUri(node));
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
        (node.children || []).forEach(walk);
    };
    if (bookmarkData) walk(bookmarkData);
    return [...counts.entries()]
        .map(([host, count]) => ({
            host,
            count,
            // addresses stay as they are; names are shown in reverse domain order
            display: isIpAddressHost(host) ? bareHost(host) : host.split('.').reverse().join('.')
        }))
        .sort((a, b) => a.display.localeCompare(b.display));
}

let comboRows = [];   // what the last render put on screen, indexed by data-combo-row

function comboRowKey(kind, value) {
    return `${kind}:${value}`;
}

function renderCombo(input) {
    const list = comboListEl(input);
    if (!input || !list) return;
    const kind = comboKind(input);
    const term = String(input.value || '').trim().toLowerCase();
    const rows = [];
    if (kind === 'domain') {
        const matches = comboDomainEntries().filter(entry => !term || entry.display.toLowerCase().includes(term) || entry.host.toLowerCase().includes(term)).slice(0, 120);
        matches.forEach((entry, index) => {
            rows.push({ pick: entry.display, html: `<div class="combo-row${index === comboActive ? ' is-active' : ''}" data-combo-row="${index}"><button type="button" class="combo-pick" data-combo-pick="${escapeHtml(entry.display)}" title="Filter to ${escapeHtml(entry.host)}"><span class="combo-name">${escapeHtml(entry.display)}</span><span class="combo-meta">${formatCount(entry.count)}</span></button></div>` });
        });
        if (!rows.length) rows.push({ html: '<div class="combo-empty">No domains in the library match that.</div>' });
    } else {
        const treeFolder = comboTreeFolder && comboTreeFolder !== bookmarkData ? comboTreeFolder : null;
        // The library's own roots, read once: a per-row parent lookup would walk the tree for
        // every row (and this renders on every keystroke).
        const mains = new Set(comboMainFolders());
        // A box holding exactly the folder the tree wrote is "where you are", not a search: the list
        // stays the outline, opened at that folder, so the other main folders are still listed.
        const typed = String(input.value || '').trim().toLowerCase();
        const folderTerm = typed && typed === comboTreeFolderLabel().toLowerCase() ? '' : typed;
        const visible = comboFolderVisible(comboFolderEntries(), folderTerm);
        // The cap stops a huge library from stalling the render, but a main folder is never the row
        // that falls off the end: expanding one branch must not hide the other roots.
        const shown = [];
        let room = COMBO_ROW_CAP;
        visible.forEach(entry => {
            if (mains.has(entry.node)) { shown.push(entry); return; }
            if (room <= 0) return;
            room -= 1;
            shown.push(entry);
        });
        shown.forEach((entry, index) => {
            const mark = folderPickLabel(entry.node).markHtml;
            // The folder the tree has open is flagged, so the list answers "where am I?" at a glance.
            const isCurrent = Boolean(treeFolder) && entry.node === treeFolder;
            const here = isCurrent ? '<span class="combo-current-mark" title="The folder the treeview has selected">here</span>' : '';
            // A main folder opens every folder below it in one click, and says so.
            const whole = Boolean(entry.kids) && mains.has(entry.node);
            const expanded = comboExpanded.has(entry.node);
            const wholeTitle = `Show or hide every folder inside ${escapeHtml(entry.label)}`;
            const caretTitle = whole ? wholeTitle : `${expanded ? 'Close' : 'Open'} this folder`;
            const caretLabel = whole ? wholeTitle : `${expanded ? 'Close' : 'Open'} ${escapeHtml(entry.label)}`;
            const caret = entry.kids ? `<button type="button" class="combo-caret" data-combo-toggle="${index}" aria-label="${caretLabel}" title="${caretTitle}">${expanded ? '▾' : '▸'}</button>` : '<span class="combo-caret is-empty" aria-hidden="true">•</span>';
            const pickTitle = whole ? wholeTitle : entry.kids ? `Open ${escapeHtml(entry.label)}` : `Use ${escapeHtml(entry.label)}`;
            rows.push({ node: entry.node, pick: entry.label, current: isCurrent, html: `<div class="combo-row${index === comboActive ? ' is-active' : ''}${isCurrent ? ' is-current' : ''}" data-combo-row="${index}" style="padding-left:${6 + entry.depth * 14}px">${caret}<button type="button" class="combo-pick" data-combo-pick="${escapeHtml(entry.label)}"${entry.kids ? ` data-combo-folder="${index}"` : ''} title="${pickTitle}">${mark}<span class="combo-name">${escapeHtml(entry.label)}</span>${here}</button><button type="button" class="combo-use" data-combo-use="${escapeHtml(entry.label)}" title="Use this folder" aria-label="Use ${escapeHtml(entry.label)}">Use</button></div>` });
        });
        if (!rows.length) rows.push({ html: folderTerm ? '<div class="combo-empty">No folder matches that.</div>' : '<div class="combo-empty">No folders here.</div>' });
    }
    comboRows = rows;
    list.innerHTML = rows.map(row => row.html).join('');
    const all = [...list.querySelectorAll('.combo-row')];
    all.forEach((row, index) => row.classList.toggle('is-active', index === comboActive));
}

function openCombo(input) {
    const list = comboListEl(input);
    if (!list) return;
    if (comboOpenInput && comboOpenInput !== input) closeCombo(comboOpenInput);
    comboOpenInput = input;
    comboActive = -1;
    // The folder list opens where the tree is, not at the library root.
    const folderList = comboKind(input) === 'folder';
    if (folderList) expandComboToTreeFolder();
    renderCombo(input);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (folderList) scrollComboToTreeFolder(input);
}

function closeCombo(input) {
    const list = comboListEl(input);
    if (list) list.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
    if (comboOpenInput === input) comboOpenInput = null;
}

function toggleCombo(input) {
    const list = comboListEl(input);
    if (!list) return;
    if (list.hidden) openCombo(input);
    else closeCombo(input);
}

function pickComboValue(input, value) {
    if (!input) return;
    cancelPendingSearch();
    input.value = String(value || '');
    closeCombo(input);
    liveEditSearchFromForm();
    input.focus();
}

function toggleComboFolder(input, index) {
    const row = comboRows[Number(index)];
    if (!row || !row.node) return;
    // A main folder — the library's own Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks,
    // Mobile Bookmarks — opens every folder inside it in one click, because unfolding that branch
    // one caret at a time is what the outline would otherwise ask for. Deeper folders keep the
    // one-level toggle. Clicking a main folder that already shows its whole branch folds it away.
    if (comboMainFolders().includes(row.node)) {
        const branch = comboBranchFolders(row.node);
        const open = !(comboExpanded.has(row.node) && branch.every(child => comboExpanded.has(child)));
        if (open) comboExpanded.add(row.node);
        else comboExpanded.delete(row.node);
        branch.forEach(child => { if (open) comboExpanded.add(child); else comboExpanded.delete(child); });
        renderCombo(input);
        return;
    }
    if (comboExpanded.has(row.node)) comboExpanded.delete(row.node);
    else comboExpanded.add(row.node);
    renderCombo(input);
}

function comboRowFor(input, index) {
    return comboRows[Number(index)] || null;
}

function bindCombo(panel) {
    if (!panel) return;
    panel.querySelectorAll('.operator-combo').forEach(combo => {
        const input = combo.querySelector('[data-combo-source]');
        const list = combo.querySelector('[data-combo-list]');
        const toggle = combo.querySelector('.operator-combo-toggle');
        if (!input || !list) return;
        if (input.dataset.comboBound !== '1') {
            input.dataset.comboBound = '1';
            input.addEventListener('focus', () => openCombo(input));
            input.addEventListener('click', () => openCombo(input));
            input.addEventListener('input', () => { if (!list.hidden) renderCombo(input); });
            input.addEventListener('keydown', event => {
                const rows = [...list.querySelectorAll('.combo-row')];
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (list.hidden) { openCombo(input); return; }
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    comboActive = Math.min(Math.max(comboActive + step, 0), Math.max(rows.length - 1, 0));
                    renderCombo(input);
                    return;
                }
                if (event.key === 'ArrowRight' || event.key === ' ') {
                    const row = comboRowFor(input, comboActive);
                    if (row && row.node && comboChildFolders(row.node).length) {
                        event.preventDefault();
                        toggleComboFolder(input, comboActive);
                    }
                    return;
                }
                if (event.key === 'ArrowLeft') {
                    const row = comboRowFor(input, comboActive);
                    if (row && row.node) {
                        event.preventDefault();
                        if (comboExpanded.has(row.node)) { comboExpanded.delete(row.node); renderCombo(input); }
                    }
                    return;
                }
                if (event.key === 'Enter') {
                    // Only swallow Enter when a row is highlighted; otherwise it saves the search.
                    const row = comboRowFor(input, comboActive);
                    if (!list.hidden && row && row.pick) {
                        event.preventDefault();
                        pickComboValue(input, row.pick);
                    }
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeCombo(input);
                }
            });
        }
        if (toggle && toggle.dataset.comboToggleBound !== '1') {
            toggle.dataset.comboToggleBound = '1';
            toggle.addEventListener('click', event => { event.preventDefault(); toggleCombo(input); });
        }
        if (list.dataset.comboListBound !== '1') {
            list.dataset.comboListBound = '1';
            list.addEventListener('click', event => {
                // Stop here: opening a folder re-renders this list, which detaches the clicked
                // element, and the document-level dismissal would then take the click for one
                // outside the panel and close the whole filter box.
                event.stopPropagation();
                const target = event.target;
                if (!target || typeof target.closest !== 'function') return;
                const use = target.closest('[data-combo-use]');
                if (use) { pickComboValue(input, use.dataset.comboUse); return; }
                const caret = target.closest('[data-combo-toggle]');
                const toggleIdx = caret ? caret.dataset.comboToggle : (target.closest('[data-combo-folder]') ? target.closest('[data-combo-folder]').dataset.comboFolder : null);
                if (toggleIdx !== null && toggleIdx !== undefined) { toggleComboFolder(input, toggleIdx); return; }
                const pick = target.closest('[data-combo-pick]');
                if (pick) pickComboValue(input, pick.dataset.comboPick);
            });
        }
    });
    if (!comboDismissBound) {
        comboDismissBound = true;
        document.addEventListener('click', event => {
            const target = event.target;
            if (target && typeof target.closest === 'function' && target.closest('.operator-combo')) return;
            if (comboOpenInput) closeCombo(comboOpenInput);
        });
    }
}

function searchOperatorFamilyField(family) {
    if (family.input === 'choice') {
        return `<span class="operator-choices">${family.choices.map(choice => `<label class="operator-choice"><input type="checkbox" data-operator-choice="${family.key}:${choice}"> ${escapeHtml(choice)}</label>`).join('')}</span>`;
    }
    if (family.key === 'added') {
        return `<span class="operator-choices">
            <label class="operator-choice">after <input type="month" data-operator-input="added-after"></label>
            <label class="operator-choice">before <input type="month" data-operator-input="added-before"></label>
        </span>`;
    }
    if (family.key === 'folder' || family.key === 'domain') {
        const what = family.key === 'folder' ? "the library's folders" : 'the domains in the library, in reverse domain order';
        return `<span class="operator-combo">
            <input type="text" data-operator-input="${family.key}" data-combo-source="${family.key}" placeholder="${escapeHtml(family.placeholder || '')}" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="false" aria-label="${escapeHtml(family.hint)}">
            <button type="button" class="operator-combo-toggle" tabindex="-1" aria-label="Show ${what}" title="Show ${what}">▾</button>
            <span class="operator-combo-list" data-combo-list role="listbox" hidden></span>
        </span>`;
    }
    return `<input type="text" data-operator-input="${family.key}" placeholder="${escapeHtml(family.placeholder || '')}" spellcheck="false" aria-label="${escapeHtml(family.hint)}">`;
}

// The operator reference lives inside the filter panel, *below* the filter rows: what each
// family does, read from the same SEARCH_FAMILIES table the rows are built from.
function searchOperatorHelpHtml() {
    const families = enabledSearchFamilies();
    const rows = SEARCH_FAMILIES.filter(family => families.has(family.key)).map(family =>
        `<li><code>${escapeHtml(family.label)}</code> ${escapeHtml(family.hint)}</li>`);
    return `<details class="operator-help" open>
        <summary>What the operators do (${families.size} of ${SEARCH_FAMILIES.length} families on)</summary>
        <ul class="operator-help-list">${rows.join('')}</ul>
        <p class="operator-help-note">A box can hold several values, separated by commas (<code>domain:a.com, b.com</code>), and an operator may simply be repeated instead. Anything without an operator is matched as plain text. A leading <code>-</code> excludes (<code>-word</code>), and a pattern wrapped in slashes is a regular expression (<code>/^how to .*\d+$/i</code>). Families are switched on and off in Settings → Search syntax.</p>
        <p class="operator-help-note"><strong>Advanced use cases</strong></p>
        <ul class="operator-help-list">
            <li><code>title:postgres OR title:mysql</code> — either; <code>|</code> works too. OR binds loosest, then AND, then a leading dash.</li>
            <li><code>(title:postgres OR tag:recipe) type:web</code> — group with parentheses; write <code>AND</code> out when you mean both.</li>
            <li><code>-(title:postgres OR title:tutorial)</code> — a leading dash excludes a whole group.</li>
            <li><code>title:post*</code>, <code>title:*tutorial</code>, <code>title:*post*</code>, <code>title:Di?gram</code> — wildcards: prefix, suffix, anywhere, one character. A wildcard anchors to the whole value.</li>
            <li><code>title:a title:b</code> — two values of one family side by side mean <em>either</em>; write <code>AND</code> to require both.</li>
            <li>Whole words and case sensitivity are toggles in Settings → Search syntax.</li>
        </ul>
    </details>`;
}

// The filter boxes are grouped under headings, one per section, so a long panel reads as parts
// rather than nine anonymous rows. Any family not named here still gets a section of its own.
const SEARCH_FILTER_SECTIONS = [
    { title: 'Where it is', keys: ['domain', 'folder'] },
    { title: 'What it says', keys: ['title', 'url'] },
    { title: 'When it was added', keys: ['added'] },
    { title: 'What it has', keys: ['has'] },
    { title: 'What it is', keys: ['is'] },
    { title: 'Words and patterns', keys: ['exclude', 'regex'] }
];

// Sections are functional, not just labels: the heading folds its group away, and a small × on
// the heading clears only that group's boxes — hovering the heading brings it out, so nothing
// is added to the panel at rest.
const searchFilterCollapsed = new Set();

function findSearchFilterSection(panel, title) {
    const sections = panel ? [...panel.querySelectorAll('.operator-section')] : [];
    return sections.find(section => section.dataset.operatorSection === String(title || '')) || null;
}

function toggleSearchFilterSection(title) {
    const panel = document.getElementById('search-operators');
    const section = findSearchFilterSection(panel, title);
    if (!section) return;
    const body = section.querySelector('.operator-section-body');
    const collapsed = section.classList.toggle('is-collapsed');
    if (body) body.hidden = collapsed;
    if (collapsed) searchFilterCollapsed.add(String(title || ''));
    else searchFilterCollapsed.delete(String(title || ''));
    const toggle = section.querySelector('.operator-section-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function clearSearchFilterSection(title) {
    const panel = document.getElementById('search-operators');
    const section = findSearchFilterSection(panel, title);
    if (!section) return;
    section.querySelectorAll('[data-operator-input]').forEach(field => { field.value = ''; });
    section.querySelectorAll('[data-operator-choice]').forEach(box => { box.checked = false; });
    // Rewrites the query from the boxes and re-runs the search, like any other panel edit.
    liveEditSearchFromForm();
}

function searchOperatorSectionsHtml(active) {
    const seen = new Set();
    const sections = SEARCH_FILTER_SECTIONS.map(section => ({ ...section, families: [] }));
    active.forEach(family => {
        let section = sections.find(candidate => candidate.keys.includes(family.key));
        if (!section) {
            section = { title: 'Other', keys: [], families: [] };
            sections.push(section);
        }
        seen.add(family.key);
        section.families.push(family);
    });
    return sections.filter(section => section.families.length).map(section => {
        const collapsed = searchFilterCollapsed.has(section.title);
        return `<div class="operator-section${collapsed ? ' is-collapsed' : ''}" data-operator-section="${escapeHtml(section.title)}">
        <div class="operator-section-head">
            <button type="button" class="operator-section-toggle" data-call="toggleSearchFilterSection" data-arg="${escapeHtml(section.title)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="Show or hide this group"><span class="operator-section-caret" aria-hidden="true">▾</span>${escapeHtml(section.title)}</button>
            <button type="button" class="operator-section-clear" data-call="clearSearchFilterSection" data-arg="${escapeHtml(section.title)}" title="Clear every box in this group" aria-label="Clear the ${escapeHtml(section.title)} filters">×</button>
        </div>
        <div class="operator-section-body"${collapsed ? ' hidden' : ''}>
        ${section.families.map(family => `<div class="operator-row">
            <span class="operator-label" title="${escapeHtml(family.hint)}">${escapeHtml(family.label)}</span>
            ${searchOperatorFamilyField(family)}
        </div>`).join('')}
        </div>
    </div>`;
    }).join('');
}

function renderSearchOperatorPanel() {
    const panel = document.getElementById('search-operators');
    if (!panel) return;
    const families = enabledSearchFamilies();
    const active = families.size ? SEARCH_FAMILIES.filter(family => families.has(family.key)) : [];
    panel.innerHTML = `<div class="operator-panel-head"><span class="operator-panel-title">Search filters</span><button type="button" class="ghost-btn operator-apply" id="search-operators-apply" data-call="applySearchOperatorForm" disabled title="Every filter above is already in the search">Apply filters</button><span class="operator-panel-hint">edits apply as you type — Apply folds in what is still waiting, like the folder the tree has open — clear with the × on the search box</span></div>
        <div class="operator-match-row"><span class="operator-match-label">Matching</span><label class="operator-choice" title="Whole words: “Tron” finds Tron, but not Electronics. Wildcards still work inside a word (post*), and tags are always matched whole."><input type="checkbox" id="search-whole-words" data-call="toggleWholeWordsSearch"${searchWholeWordsEnabled() ? ' checked' : ''}> Whole words</label></div>
        <div id="search-history-list" class="history-slot"></div>
        ${active.length ? searchOperatorSectionsHtml(active) : '<p class="operator-panel-empty">Every filter family is switched off in Settings. Plain words still search titles, URLs and paths.</p>'}
        <div id="search-operator-plain" class="operator-plain-box"></div>
        ${searchOperatorHelpHtml()}
        <div class="operator-panel-actions">
            <button type="button" class="ghost-btn" data-call="openSearchSyntaxSettings">Syntax settings</button>
        </div>`;
    renderSearchHistory();
    bindCombo(panel);
    wireDataCallScope(panel);
    bindSearchOperatorDismissal();
    bindSearchOperatorLiveEdit(panel);
    updateSearchOperatorPlain();
    updateSearchApplyButton();
}

// The panel is live, so Apply is not the only way in — it is the deliberate gesture for whatever is
// standing by in the boxes without being in the query yet (chiefly the folder the tree has open,
// which must never search on its own). It stays quiet while there is nothing to apply.
function normalizeSearchQueryText(text) {
    return String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
}

function updateSearchApplyButton() {
    const button = document.getElementById('search-operators-apply');
    if (!button) return;
    const input = document.getElementById('bookmark-search');
    const waiting = normalizeSearchQueryText(searchQueryFromOperatorForm()) !== normalizeSearchQueryText(input ? input.value : '');
    button.disabled = !waiting;
    button.classList.toggle('is-waiting', waiting);
    button.title = waiting
        ? 'Search with the filters above — the folder the tree has open is waiting to be applied'
        : 'Every filter above is already in the search';
}

// --- cross-editable search: the filter boxes write back to the search box ---
// Building the query lives here so Apply and the live path cannot drift apart.
function searchQueryFromOperatorForm() {
    const input = document.getElementById('bookmark-search');
    const free = searchQueryWithoutOperators(input ? input.value : '');
    const operators = readSearchOperatorForm();
    return [free, operators].filter(Boolean).join(' ').trim();
}

// Called on every keystroke and checkbox change inside the panel. It rewrites the search box
// and re-runs the search exactly as typing in the box does; the field being edited is left
// alone by syncSearchOperatorForm (see the activeElement guard), so focus and caret survive.
function liveEditSearchFromForm() {
    const input = document.getElementById('bookmark-search');
    if (!input) return;
    const next = searchQueryFromOperatorForm();
    if (next === String(input.value || '').trim()) { updateSearchOperatorPlain(); updateSearchClearButton(); updateSearchApplyButton(); return; }
    input.value = next;
    filterFolderContents();
}

function bindSearchOperatorLiveEdit(panel) {
    panel.querySelectorAll('[data-operator-input], [data-operator-choice]').forEach(field => {
        if (field.dataset.liveEditBound === '1') return;
        field.dataset.liveEditBound = '1';
        const done = () => liveEditSearchFromForm();
        if (field.type === 'checkbox') {
            field.addEventListener('change', done);
            return;
        }
        // Writing in a filter box waits for a pause; a change (date picker, blur) is immediate.
        field.addEventListener('input', () => scheduleSearchUpdate(() => liveEditSearchFromForm()));
        field.addEventListener('change', done);
    });
}

function syncSearchOperatorForm() {
    const panel = document.getElementById('search-operators');
    if (!panel) return;
    const input = document.getElementById('bookmark-search');
    const parsed = parseLibraryQuery(input ? input.value : '');
    const active = document.activeElement;
    const setValue = (selector, value, keepStanding) => {
        const field = panel.querySelector(selector);
        if (!field || field === active) return;   // never overwrite the field being edited
        const next = value || '';
        // The folder box may hold the tree's standing default, which is deliberately not in the
        // query yet: reading the query back must not wipe it (Apply puts it in the query).
        if (keepStanding && !next && String(field.value || '').trim().toLowerCase() === comboDefaultFolder) return;
        // The parser lowercases what it reads back, so a field already holding the same value keeps
        // its own casing: a folder the tree (or a pick) filled in as "Bookmarks Toolbar" stays so.
        field.value = String(field.value || '').trim().toLowerCase() === next.toLowerCase() ? (field.value || next) : next;
    };
    // Every value, so a repeated operator survives an edit in the panel.
    setValue('[data-operator-input="domain"]', parsed.domain.join(', '));
    setValue('[data-operator-input="folder"]', parsed.folder.join(', '), true);
    setValue('[data-operator-input="title"]', parsed.title.join(', '));
    setValue('[data-operator-input="url"]', parsed.url.join(', '));
    setValue('[data-operator-input="regex"]', parsed.regex ? parsed.regex.source : '');
    setValue('[data-operator-input="exclude"]', parsed.not.join(', '));
    const addedAfter = parsed.added.find(range => range.op === '>');
    const addedBefore = parsed.added.find(range => range.op === '<');
    const month = ms => (ms ? new Date(ms).toISOString().slice(0, 7) : '');
    const afterField = panel.querySelector('[data-operator-input="added-after"]');
    if (afterField && afterField !== active) afterField.value = addedAfter ? month(addedAfter.ms) : '';
    const beforeField = panel.querySelector('[data-operator-input="added-before"]');
    if (beforeField && beforeField !== active) beforeField.value = addedBefore ? month(addedBefore.ms) : '';
    panel.querySelectorAll('[data-operator-choice]').forEach(box => {
        if (box === active) return;
        const [key, choice] = box.dataset.operatorChoice.split(':');
        box.checked = (parsed[key] || []).includes(choice);
    });
    updateSearchOperatorPlain();
    updateSearchApplyButton();
}

function readSearchOperatorForm() {
    const panel = document.getElementById('search-operators');
    if (!panel) return '';
    const tokens = [];
    const valueOf = key => {
        const field = panel.querySelector(`[data-operator-input="${key}"]`);
        return field ? String(field.value || '').trim() : '';
    };
    // Several values per box, separated by commas; a value with a space is quoted so the
    // parser hands it back whole.
    const emitValue = (key, token) => {
        const text = String(token || '').trim();
        if (!text) return;
        tokens.push(/\s/.test(text) ? `${key}:"${text}"` : `${key}:${text}`);
    };
    ['domain', 'folder', 'title', 'url'].forEach(key => {
        valueOf(key).split(',').map(part => part.trim()).filter(Boolean).forEach(part => emitValue(key, part));
    });
    ['has', 'is'].forEach(key => {
        panel.querySelectorAll(`[data-operator-choice^="${key}:"]`).forEach(box => {
            if (box.checked) tokens.push(`${key}:${box.dataset.operatorChoice.split(':')[1]}`);
        });
    });
    const after = valueOf('added-after');
    if (after) tokens.push(`added:>${after}`);
    const before = valueOf('added-before');
    if (before) tokens.push(`added:<${before}`);
    // `-word` accepts a list too, comma or space separated.
    const exclude = valueOf('exclude').split(/[,\s]+/).map(word => word.trim()).filter(Boolean).map(word => `-${word}`);
    tokens.push(...exclude);
    const pattern = valueOf('regex');
    if (pattern) tokens.push(`/${pattern.replace(/^\/|\/$/g, '')}/i`);
    return tokens.join(' ');
}

function applySearchOperatorForm() {
    const input = document.getElementById('bookmark-search');
    if (!input) return;
    // A keystroke inside the debounce window has not reached the panel yet: read it back first, or
    // rebuilding the query would drop the operator that was just typed.
    cancelPendingSearch();
    syncSearchOperatorForm();
    input.value = searchQueryFromOperatorForm();
    filterFolderContents();
    commitSearchToHistory();
    renderSearchOperatorPanel();
    syncSearchOperatorForm();
}

// The × on the search box: clears the query, the filter panel and the everywhere scope, then
// re-runs the search. It hides itself while there is nothing to clear.
function searchHasFilters() {
    const input = document.getElementById('bookmark-search');
    if (input && String(input.value || '').trim()) return true;
    const everywhere = document.getElementById('bookmark-search-everywhere');
    if (everywhere && everywhere.checked) return true;
    const panel = document.getElementById('search-operators');
    if (panel) {
        if ([...panel.querySelectorAll('[data-operator-input]')].some(field => String(field.value || '').trim())) return true;
        if ([...panel.querySelectorAll('[data-operator-choice]')].some(box => box.checked)) return true;
    }
    return false;
}

function updateSearchClearButton() {
    const button = document.getElementById('search-clear');
    if (button) button.hidden = !searchHasFilters();
}

function clearSearchFilters() {
    const input = document.getElementById('bookmark-search');
    cancelPendingSearch();
    const panel = document.getElementById('search-operators');
    const wasOpen = Boolean(panel && !panel.hidden);
    if (input) input.value = '';
    const everywhere = document.getElementById('bookmark-search-everywhere');
    if (everywhere) everywhere.checked = false;
    // Empties the panel's boxes, re-renders it and re-runs the search.
    clearSearchOperatorForm();
    updateSearchClearButton();
    // Clearing is not a dismissal: if the panel was open it stays open, and the click that got
    // here can never close it as a side effect.
    if (wasOpen && panel) toggleSearchOperatorsPanel(true);
    if (input) input.focus();
}

function clearSearchOperatorForm() {
    const panel = document.getElementById('search-operators');
    if (panel) {
        panel.querySelectorAll('[data-operator-input]').forEach(field => { field.value = ''; });
        panel.querySelectorAll('[data-operator-choice]').forEach(box => { box.checked = false; });
    }
    const input = document.getElementById('bookmark-search');
    if (input) input.value = searchQueryWithoutOperators(input.value);
    filterFolderContents();
    renderSearchOperatorPanel();
}

function openSearchSyntaxSettings() {
    switchTabById('settings-view');
    const box = document.getElementById('setting-search-operators');
    if (box) box.focus();
}


// The Settings form for the syntax switch and its families.
function paintSearchSyntaxSettings() {
    const master = document.getElementById('setting-search-operators');
    if (master) master.checked = searchSyntaxEnabled();
    const families = enabledSearchFamilies();
    SEARCH_FAMILIES.forEach(family => {
        const box = document.getElementById(`setting-search-family-${family.key}`);
        if (box) box.checked = families.has(family.key);
    });
    const wholeWords = document.getElementById('setting-search-whole-words');
    if (wholeWords) wholeWords.checked = searchWholeWordsEnabled();
    const caseSensitive = document.getElementById('setting-search-case');
    if (caseSensitive) caseSensitive.checked = searchCaseSensitiveEnabled();
    const exhaustiveBox = document.getElementById('setting-search-exhaustive');
    if (exhaustiveBox) exhaustiveBox.checked = searchExhaustiveEnabled();
    const exhaustiveNote = document.getElementById('search-exhaustive-note');
    if (exhaustiveNote) {
        exhaustiveNote.textContent = searchExhaustiveEnabled()
            ? 'Exhaustive search is on: every folder path and every derived set is recomputed from the live tree, trusting no cache and no index. It is quadratic, so a search over a large library takes seconds — the meta line marks it.'
            : 'Exhaustive search is off: searches use the cached library index, which is fast. Turn it on to confirm a result the fast path may have missed.';
    }
    const modes = [
        searchWholeWordsEnabled() ? 'whole words only' : '',
        searchCaseSensitiveEnabled() ? 'case sensitive' : ''
    ].filter(Boolean).join(', ');
    const note = document.getElementById('search-syntax-note');
    if (note) {
        note.textContent = searchSyntaxEnabled()
            ? `Operators are on, using ${families.size} of ${SEARCH_FAMILIES.length} families${modes ? `; matching ${modes}` : ''}. Unticked families are searched for as literal text.`
            : 'Operators are off: the search box always looks for the exact text you type, including dashes, colons and slashes.';
    }
    bindSearchBoxPanelOpen();
    bindSearchBoxHistory();
    renderSearchOperatorPanel();
}

function applySearchSyntaxSettings() {
    const master = document.getElementById('setting-search-operators');
    const families = SEARCH_FAMILIES
        .filter(family => {
            const box = document.getElementById(`setting-search-family-${family.key}`);
            return box ? box.checked : enabledSearchFamilies().has(family.key);
        })
        .map(family => family.key);
    const wholeWords = document.getElementById('setting-search-whole-words');
    const caseSensitive = document.getElementById('setting-search-case');
    const exhaustiveBox = document.getElementById('setting-search-exhaustive');
    saveEditorSettings({
        searchOperators: master ? Boolean(master.checked) : searchSyntaxEnabled(),
        searchSyntaxFamilies: families.join(','),
        searchWholeWords: wholeWords ? Boolean(wholeWords.checked) : searchWholeWordsEnabled(),
        searchCaseSensitive: caseSensitive ? Boolean(caseSensitive.checked) : searchCaseSensitiveEnabled(),
        exhaustiveSearch: exhaustiveBox ? Boolean(exhaustiveBox.checked) : searchExhaustiveEnabled()
    });
    paintSearchSyntaxSettings();
    if (currentFolder) renderFolderContents(currentFolder);
    notifyDone(searchSyntaxEnabled() ? `Search operators on (${families.length} families).` : 'Search operators off: searches are literal text.');
    logAffected('SYSTEM', 'Search syntax', searchSyntaxEnabled()
        ? `Search operators enabled with ${families.length} families: ${families.join(', ')}.`
        : 'Search operators disabled: every search is literal text.', { source: 'Settings', kind: 'setting' });
}


// The Filters panel's own match option. It is the same setting the Settings page owns, so the two
// can never disagree: the panel box writes the Settings box and then runs the settings path, which
// saves, repaints both (the panel is rebuilt from the saved value) and re-renders the listing with
// the new matching. Unlike the panel's text fields it does not wait for Apply — a match mode changes
// how the query you already typed matches, so it takes effect on the click.
function toggleWholeWordsSearch(node) {
    const box = node && node.checked !== undefined ? node : document.getElementById('search-whole-words');
    const on = Boolean(box && box.checked);
    const setting = document.getElementById('setting-search-whole-words');
    if (setting) setting.checked = on;
    applySearchSyntaxSettings();
}

// A generic version of ui-bind's wiring for panels built with innerHTML after load:
// the Filters panel replaces its own contents, so its buttons would otherwise never fire.
function wireDataCallScope(scope) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    let wired = 0;
    scope.querySelectorAll('[data-call]').forEach(el => {
        const name = el.getAttribute('data-call');
        if (!name || el.dataset.wiredCall === name) return;
        el.dataset.wiredCall = name;
        const eventName = el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox' || el.type === 'number'
            ? 'change'
            : (el.tagName === 'INPUT' ? 'input' : 'click');
        el.addEventListener(eventName, event => {
            if (el.tagName === 'A') event.preventDefault();
            const fn = window[name];
            if (typeof fn !== 'function') return;
            if (el.hasAttribute('data-arg')) fn(el.getAttribute('data-arg'));
            else if (el.getAttribute('data-apply')) fn(el.getAttribute('data-apply'));
            else fn(event);
        });
        wired += 1;
    });
    return wired;
}

function closeSearchOperatorsPanel() {
    const panel = document.getElementById('search-operators');
    if (panel) panel.hidden = true;
    if (comboOpenInput) closeCombo(comboOpenInput);
}

let searchOperatorDismissBound = false;

function bindSearchOperatorDismissal() {
    if (searchOperatorDismissBound) return;
    searchOperatorDismissBound = true;
    document.addEventListener('click', event => {
        const panel = document.getElementById('search-operators');
        const button = document.getElementById('search-operators-toggle');
        if (!panel || panel.hidden) return;
        const target = event.target;
        // A click on the panel, or on the search box that opens it, is not a dismissal.
        // Without the search-box exemption the panel opened on focus and closed again on the
        // very same click, because that click bubbles up to this document listener.
        if (target && typeof target.closest === 'function') {
            if (target.closest('#search-operators') || target.closest('#bookmark-search') || target.closest('#search-clear') || target.closest('#search-field') || target.closest('#library-tool-search')) return;
        }
        // A click that re-rendered part of the panel leaves its target detached, and a detached
        // node has no ancestors to match: it cannot be "outside", so it must not dismiss.
        if (target && target.isConnected === false) return;
        if (target && typeof panel.contains === 'function' && panel.contains(target)) return;
        closeSearchOperatorsPanel();
    });
}


// --- clicking into the bookmark search opens the clickable filters ---
let searchBoxPanelBound = false;

function bindSearchBoxPanelOpen() {
    if (searchBoxPanelBound) return;
    const input = document.getElementById('bookmark-search');
    if (!input) return;
    searchBoxPanelBound = true;
    const open = () => {
        if (!searchSyntaxEnabled()) return;
        toggleSearchOperatorsPanel(true);
    };
    input.addEventListener('focus', open);
    input.addEventListener('click', open);
}

// History is kept forever (it is only ever appended to, and it survives reloads), so a search
// only has to be *committed* to be remembered: Enter, leaving the box, or Apply in the panel.
function commitSearchToHistory(options = {}) {
    const input = document.getElementById('bookmark-search');
    if (!input) return;
    flushPendingSearch();
    const query = String(input.value || '').trim();
    if (!query) return;
    const before = searchHistory[0] && searchHistory[0].query;
    const everywhere = Boolean(document.getElementById('bookmark-search-everywhere')?.checked);
    const recursive = Boolean(document.getElementById('bookmark-search-recursive')?.checked);
    rememberSearch(query, everywhere, recursive);
    renderSearchHistory();
    // Enter is an explicit "keep this" — say so, rather than saving silently.
    if (searchHistoryTimer) {
        clearTimeout(searchHistoryTimer);
        searchHistoryTimer = 0;
    }
    if (options.announce) {
        showToast(before === query ? `Already in the search history: “${query}”` : `Saved “${query}” to the search history (Recent).`, { timeout: 2600 });
    }
}

// Standard input-debounce timings: 300 ms is the usual pause for search-as-you-type (a word is
// searched once, not once per letter, and a fast typist never triggers a search mid-word), and a
// further second of quiet is the usual "this is the search I wanted" idle before it is recorded.
// Clicks, ticks, picks and clears stay immediate — only writing is deferred.
const SEARCH_TYPING_DELAY = 300;
const SEARCH_HISTORY_DELAY = 1000;
let searchTypingTimer = 0;
let searchHistoryTimer = 0;

function scheduleSearchUpdate(work) {
    if (searchTypingTimer) clearTimeout(searchTypingTimer);
    if (searchHistoryTimer) clearTimeout(searchHistoryTimer);
    searchTypingTimer = setTimeout(() => {
        searchTypingTimer = 0;
        if (typeof work === 'function') work();
        else filterFolderContents();
        searchHistoryTimer = setTimeout(() => {
            searchHistoryTimer = 0;
            commitSearchToHistory();
        }, SEARCH_HISTORY_DELAY);
    }, SEARCH_TYPING_DELAY);
}

function flushPendingSearch() {
    if (!searchTypingTimer) return;
    clearTimeout(searchTypingTimer);
    searchTypingTimer = 0;
    filterFolderContents();
}

function cancelPendingSearch() {
    if (searchTypingTimer) {
        clearTimeout(searchTypingTimer);
        searchTypingTimer = 0;
    }
    if (searchHistoryTimer) {
        clearTimeout(searchHistoryTimer);
        searchHistoryTimer = 0;
    }
}

function bindSearchBoxHistory() {
    const input = document.getElementById('bookmark-search');
    if (!input || input.dataset.historyBound === '1') return;
    input.dataset.historyBound = '1';
    input.addEventListener('blur', commitSearchToHistory);
    input.addEventListener('change', commitSearchToHistory);
    // Writing is deferred; Enter and leaving the box flush it (see commitSearchToHistory).
    input.addEventListener('input', scheduleSearchUpdate);
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commitSearchToHistory({ announce: true });
    });
}

function clearRepairResults() {
    const box = document.getElementById('repairs-results');
    if (box) box.innerHTML = '<p>Compare a JSON file (Import and Backup → Compare), or run one of the reports on the Statistics tab.</p>';
}

function renderAffectedLog() {
    const tbody = document.getElementById('affected-log-body');
    if (!tbody) return;
    pruneAffectedLog();
    refreshAffectedLogFilters();
    const rows = filteredAffectedLog();
    tbody.innerHTML = rows.map((entry, index) => affectedLogRowHtml(entry, rows.length - index)).join('');
    const meta = document.getElementById('affected-log-meta');
    if (meta) {
        const filtered = rows.length !== affectedLog.length;
        meta.textContent = filtered
            ? `${formatCount(rows.length)} of ${formatCount(affectedLog.length)} event(s) shown. Events are kept for 7 days. Newest first.`
            : affectedLogMetaText();
    }
}

function affectedLogCsv() {
    const columns = ['at', 'type', 'title', 'folder', 'url', 'details', 'source', 'kind'];
    const quote = value => {
        const text = String(value == null ? '' : value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.join(',')];
    filteredAffectedLog().forEach(entry => {
        lines.push(columns.map(column => quote(column === 'at' ? new Date(entry.at).toISOString() : entry[column])).join(','));
    });
    return lines.join('\n');
}

function exportAffectedLogCsv() {
    const rows = filteredAffectedLog();
    if (!rows.length) return alert('No affected log events to export with these filters.');
    downloadTextFile('affected-log.csv', affectedLogCsv(), 'text/csv');
    logAffected('SYSTEM', 'affected-log.csv', `Exported ${formatCount(rows.length)} affected log event(s) as CSV. The log itself is unchanged.`, { source: 'Affected Log', kind: 'export' });
}

function exportAffectedLogJson() {
    const rows = filteredAffectedLog();
    if (!rows.length) return alert('No affected log events to export with these filters.');
    downloadTextFile('affected-log.json', JSON.stringify(rows, null, 2), 'application/json');
    logAffected('SYSTEM', 'affected-log.json', `Exported ${formatCount(rows.length)} affected log event(s) as JSON. The log itself is unchanged.`, { source: 'Affected Log', kind: 'export' });
}

function affectedLogRowHtml(entry, number) {
    const color = { REMOVED: '#d32f2f', ADDED: '#388e3c', MODIFIED: '#f57c00', SCRIPT: '#5b4fd6', SYSTEM: '#445268', REPAIR: '#0f766e' }[entry.type] || '#000';
    const when = new Date(entry.at);
    const timeStr = when.toLocaleString(undefined, { hour12: false }) + '.' + when.getMilliseconds().toString().padStart(3, '0');
    return `<tr>
        <td class="row-num">${number}</td>
        <td>${escapeHtml(timeStr)}</td>
        <td class="log-type" style="color:${color};font-weight:bold;">${escapeHtml(entry.type)}</td>
        <td>${escapeHtml(entry.title || 'Unknown')}</td>
        <td>${escapeHtml(entry.folder || '—')}</td>
        <td class="log-url">${escapeHtml(entry.url || '—')}</td>
        <td class="log-details">${escapeHtml(entry.details || '')}</td>
    </tr>`;
}

function loadAffectedLog() {
    try {
        const parsed = JSON.parse(localStorage.getItem(AFFECTED_LOG_KEY) || '[]');
        affectedLog = Array.isArray(parsed) ? parsed.filter(entry => entry && entry.at) : [];
    } catch (err) {
        affectedLog = [];
    }
    const pruned = pruneAffectedLog();
    renderAffectedLog();
    if (pruned) saveAffectedLog();
}

function clearAffectedLog() {
    if (!affectedLog.length) return;
    if (!confirm(`Clear ${affectedLog.length} affected log event(s)? This cannot be undone.`)) return;
    affectedLog = [];
    saveAffectedLog();
    renderAffectedLog();
}

function libraryNowLine() {
    if (!bookmarkData || typeof countTree !== 'function') return '';
    const counts = countTree(bookmarkData);
    const n = typeof formatCount === 'function' ? formatCount : String;
    return `Library in this editor: ${n(counts.links)} link(s), ${n(counts.folders)} folder(s).`;
}

function systemLogKindLine(title, details, extra) {
    const kind = extra.kind || '';
    const text = `${title || ''} ${details || ''} ${extra.source || extra.reason || ''}`;
    if (kind === 'scan' || extra.scan === true || /\bscan\b/i.test(text) || /^\s*Would /i.test(details || '')) {
        return 'Kind: scan (read-only). No bookmark was added, edited, moved, or deleted. Review the Actions results; Apply on that card commits the plan (undoable).';
    }
    if (kind === 'undo' || title === 'Undo') {
        return 'Kind: undo. Inverted the last undoable unit in this session (that unit’s adds, removes, moves, and edits).';
    }
    if (kind === 'import' || /Imported bookmark JSON/i.test(details || '')) {
        return 'Kind: import. Replaced the session tree from a JSON file. Did not write Firefox or Chrome bookmarks.';
    }
    if (kind === 'export' || /Downloaded bookmarks_exported\.json/i.test(details || '') || /Exported tree/i.test(details || '')) {
        return 'Kind: export. Downloaded the current tree as JSON and cleared _modified flags.';
    }
    if (kind === 'compare' || extra.source === 'Compare JSON' || /Compared the loaded library/i.test(details || '')) {
        return 'Kind: compare. Counted URL and title differences vs another JSON file. Did not add or delete bookmarks.';
    }
    if (kind === 'load' || /Loaded bookmarks from this browser/i.test(details || '')) {
        return 'Kind: load. Filled the editor from this browser’s bookmark API. dateAdded cannot be written live.';
    }
    if (kind === 'auto-move' || extra.source === 'Auto-move') {
        return 'Kind: auto-move. Moved items from Bookmarks Toolbar and/or Mobile Bookmarks into Other Bookmarks on the interval in Settings. Toolbar folders stay. The Mobile Bookmarks folder stays.';
    }
    return 'Kind: SYSTEM status. This is not a per-bookmark REMOVED, ADDED, or MODIFIED row.';
}

function logAffected(actionType, title, details, extra = {}) {
    const now = new Date();
    const url = extra.uri || extra.newUri || extra.oldUri || '';
    const folder = extra.folderPath || folderPathFor(extra.parent || extra.node) || '—';
    const lines = [];
    if (String(actionType).toUpperCase() === 'SYSTEM') {
        lines.push(systemLogKindLine(title, details, extra));
        const lib = libraryNowLine();
        if (lib) lines.push(lib);
    }
    if (details) lines.push(String(details));
    if (extra.source) lines.push(`Source: ${extra.source}`);
    if (extra.reason) lines.push(`Reason: ${extra.reason}`);
    if (extra.oldTitle != null && extra.newTitle != null && extra.oldTitle !== extra.newTitle) {
        lines.push(`Title: ${extra.oldTitle} → ${extra.newTitle}`);
    }
    if (extra.oldUri != null && extra.newUri != null && extra.oldUri !== extra.newUri) {
        lines.push(`URL: ${extra.oldUri} → ${extra.newUri}`);
    } else if (url && !extra.newUri && !extra.oldUri) {
        lines.push(`URL: ${url}`);
    }
    if (extra.oldDateAdded != null || extra.newDateAdded != null) {
        lines.push(`dateAdded: ${formatBookmarkDate(extra.oldDateAdded)} → ${formatBookmarkDate(extra.newDateAdded)}`);
    } else if (extra.dateAdded != null) {
        lines.push(`dateAdded: ${formatBookmarkDate(extra.dateAdded)}`);
    }
    if (extra.guid) lines.push(`guid: ${extra.guid}`);
    if (extra.id != null) lines.push(`id: ${extra.id}`);
    lines.push(`Logged at ${now.toISOString()}`);
    const entry = {
        at: now.getTime(),
        type: actionType,
        title: title || 'Unknown',
        folder,
        url,
        details: lines.join('\n')
    };
    const pruned = pruneAffectedLog();
    affectedLog.unshift(entry);
    const tbody = document.getElementById('affected-log-body');
    if (pruned || !tbody) renderAffectedLog();
    else {
        tbody.insertAdjacentHTML('afterbegin', affectedLogRowHtml(entry, affectedLog.length));
        const meta = document.getElementById('affected-log-meta');
        if (meta) meta.textContent = affectedLogMetaText();
    }
    scheduleAffectedLogSave();
}

let undoStack = [];
const bulkPlans = Object.create(null);
// The snapshot state used to sit between these two: `let namedSnapshots = []` was the line above
// statsDataRev, so removing the feature took the revision counter with it. It is the statistics
// caches' invalidation key and belongs exactly here, next to the undo/redo stacks.
let statsDataRev = 0;
let statsModelCache = { key: '', model: null };
let returningSort = { key: 'last', dir: -1 };
let sessionSort = { key: 'started', dir: -1 };
let panelAddedSort = -1;
let redoStack = [];

function updateUndoButton() {
    const btn = document.getElementById('undo-last');
    if (btn) {
        btn.disabled = !undoStack.length;
        btn.textContent = undoStack.length ? `Undo (${formatCount(undoStack.length)})` : 'Undo';
    }
    const redo = document.getElementById('redo-last');
    if (redo) {
        redo.disabled = !redoStack.length;
        redo.textContent = redoStack.length ? `Redo (${formatCount(redoStack.length)})` : 'Redo';
    }
    renderUndoHistory();
}

function pushUndo(label, inverse, redo) {
    undoStack.push({ label, inverse, redo: redo || null });
    redoStack = [];
    updateUndoButton();
}

function undoLastChange() {
    const step = undoStack.pop();
    if (!step) {
        updateUndoButton();
        return alert('Nothing to undo.');
    }
    const open = currentFolder;
    const openParent = findNodeParent(open);
    step.inverse();
    if (step.redo) redoStack.push(step);
    if (open && bookmarkData && !isNodeInSubtree(bookmarkData, open)) {
        currentFolder = (openParent && isNodeInSubtree(bookmarkData, openParent)) ? openParent : bookmarkData;
    }
    markChanged();
    renderSidebar();
    if (currentFolder) renderFolderContents(currentFolder);
    updateUndoButton();
    logAffected('SYSTEM', 'Undo', `Undo inverted the last undoable unit: “${step.label}”. Adds, removes, moves, and field edits from that unit were reversed. ${undoStack.length} undo step(s) remain, ${redoStack.length} redo step(s) available.`, { source: 'Undo', kind: 'undo' });
}

function redoLastChange() {
    const step = redoStack.pop();
    if (!step || !step.redo) {
        updateUndoButton();
        return alert('Nothing to redo.');
    }
    step.redo();
    undoStack.push(step);
    const open = currentFolder;
    if (open && bookmarkData && !isNodeInSubtree(bookmarkData, open)) currentFolder = bookmarkData;
    markChanged();
    renderSidebar();
    if (currentFolder) renderFolderContents(currentFolder);
    updateUndoButton();
    logAffected('SYSTEM', 'Redo', `Redo replayed the unit “${step.label}”. ${redoStack.length} redo step(s) remain, ${undoStack.length} undo step(s) available.`, { source: 'Redo', kind: 'redo' });
}

function undoHistoryMenu() {
    let menu = document.getElementById('undo-history-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'undo-history-menu';
        menu.className = 'context-menu undo-history-menu';
        menu.hidden = true;
        document.body.appendChild(menu);
    }
    return menu;
}

function fillUndoHistory() {
    const menu = undoHistoryMenu();
    const rows = [];
    redoStack.slice().reverse().forEach(step => {
        rows.push(`<div class="context-menu-item" data-history-redo="${escapeHtml(step.label)}"><span class="undo-history-row">Redo: ${escapeHtml(step.label)}</span></div>`);
    });
    undoStack.slice().reverse().forEach((step, index) => {
        rows.push(`<div class="context-menu-item" data-history-undo="1"><span class="undo-history-row">Undo: ${escapeHtml(step.label)}<span>${index === 0 ? 'next' : `${index} newer step(s) above`}</span></span></div>`);
    });
    menu.innerHTML = rows.length ? rows.join('') : '<div class="context-menu-item is-idle">Nothing to undo or redo yet.</div>';
    menu.querySelectorAll('[data-history-undo]').forEach(el => {
        el.onclick = () => { undoLastChange(); fillUndoHistory(); };
    });
    menu.querySelectorAll('[data-history-redo]').forEach(el => {
        el.onclick = () => { redoLastChange(); fillUndoHistory(); };
    });
}

function renderUndoHistory() {
    const menu = document.getElementById('undo-history-menu');
    if (menu && !menu.hidden) fillUndoHistory();
}

function toggleUndoHistory() {
    const btn = document.getElementById('undo-history');
    const menu = undoHistoryMenu();
    if (!menu.hidden) {
        menu.hidden = true;
        if (btn) btn.classList.remove('is-open');
        return;
    }
    fillUndoHistory();
    if (btn && typeof placePopupMenu === 'function') {
        const rect = btn.getBoundingClientRect();
        placePopupMenu(menu, rect.right - 260, rect.bottom + 4);
        btn.classList.add('is-open');
    }
    menu.hidden = false;
}

const bulkPicks = Object.create(null);
let bulkPickKeep = false;

function startBulkPick(id) {
    const old = bulkPicks[id];
    bulkPicks[id] = { items: [], index: new Map(), skip: bulkPickKeep && old ? old.skip : new Set() };
}

function bulkPickBox(id, key, weight = 1) {
    const pick = bulkPicks[id];
    if (!pick || key == null) return '';
    let i = pick.index.get(key);
    if (i == null) {
        i = pick.items.length;
        pick.items.push({ key, weight });
        pick.index.set(key, i);
    } else {
        pick.items[i].weight = weight;
    }
    return `<input type="checkbox" class="bulk-pick" data-bulk-pick="${id}" data-bulk-index="${i}"${pick.skip.has(key) ? '' : ' checked'} title="Uncheck to skip this row on Apply">`;
}

function bulkPickAllBox(id) {
    const pick = bulkPicks[id];
    if (!pick) return '';
    const skipped = pick.items.filter(item => pick.skip.has(item.key)).length;
    return `<input type="checkbox" class="bulk-pick-all" data-bulk-all="${id}"${skipped ? '' : ' checked'} title="Check or uncheck every row">`;
}

function bulkHeaderCell(header) {
    return header && header.pick ? `<th class="bulk-pick-col">${bulkPickAllBox(header.pick)}</th>` : `<th>${escapeHtml(header)}</th>`;
}

function bulkPicked(id, key) {
    const pick = bulkPicks[id];
    return !pick || !pick.skip.has(key);
}

function bulkPickedCount(id) {
    const pick = bulkPicks[id];
    return pick ? pick.items.reduce((sum, item) => sum + (pick.skip.has(item.key) ? 0 : item.weight), 0) : 0;
}

function syncBulkPickBoxes(id) {
    const pick = bulkPicks[id];
    if (!pick) return;
    document.querySelectorAll(`input[data-bulk-pick="${id}"]`).forEach(box => {
        const item = pick.items[Number(box.dataset.bulkIndex)];
        if (item) box.checked = !pick.skip.has(item.key);
    });
    const skipped = pick.items.filter(item => pick.skip.has(item.key)).length;
    document.querySelectorAll(`input[data-bulk-all="${id}"]`).forEach(box => {
        box.checked = !skipped;
        box.indeterminate = skipped > 0 && skipped < pick.items.length;
    });
    const plan = bulkPlans[id];
    if (plan) setBulkPlan(id, { count: plan.total, label: plan.label, apply: plan.apply });
}

document.addEventListener('change', event => {
    const box = event.target;
    if (!box?.matches?.('input[data-bulk-pick], input[data-bulk-all]')) return;
    const id = box.dataset.bulkPick || box.dataset.bulkAll;
    const pick = bulkPicks[id];
    if (!pick) return;
    const items = box.dataset.bulkAll ? pick.items : [pick.items[Number(box.dataset.bulkIndex)]].filter(Boolean);
    items.forEach(item => {
        if (box.checked) pick.skip.delete(item.key);
        else pick.skip.add(item.key);
    });
    syncBulkPickBoxes(id);
});

function setBulkPlan(id, { count, label, apply }) {
    const picked = bulkPicks[id] ? Math.min(count, bulkPickedCount(id)) : count;
    bulkPlans[id] = { count: picked, total: count, label, apply };
    count = picked;
    document.querySelectorAll(`[data-apply="${id}"]`).forEach(btn => {
        const base = btn.dataset.applyLabel || 'Apply';
        btn.disabled = !count;
        btn.textContent = count ? `${base} (${count})` : base;
    });
}

function clearBulkPlan(id) {
    delete bulkPlans[id];
    document.querySelectorAll(`[data-apply="${id}"]`).forEach(btn => {
        btn.disabled = true;
        btn.textContent = btn.dataset.applyLabel || 'Apply';
    });
}

function applyBulk(id) {
    if (!bookmarkData) return alert('Library is not loaded.');
    const plan = bulkPlans[id];
    if (!plan) return alert('Scan first. Apply is a second step and shows a count.');
    if (!plan.count) return alert(plan.total ? 'Every row is unchecked. Check at least one row to apply.' : 'Scan found nothing to apply.');
    if (!confirm(`Apply ${plan.label || id} to ${formatCount(plan.count)} item(s)?`)) return;
    // A pre-apply snapshot used to be taken here. Named snapshots are gone; Undo, the Trash and a
    // JSON export (Import and Backup → Export bookmarks as JSON) are what cover this now.
    bulkPickKeep = true;
    try {
        plan.apply();
    } finally {
        bulkPickKeep = false;
    }
    clearBulkPlan(id);
}

function withUndo(label, work) {
    const inverses = [];
    const forwards = [];
    const api = {
        set(node, field, value) {
            const old = node[field];
            inverses.push(() => { node[field] = old; });
            forwards.push(() => { node[field] = value; });
            node[field] = value;
            node._modified = true;
        },
        remove(node, parent) {
            if (!parent?.children) return;
            const index = parent.children.indexOf(node);
            if (index < 0) return;
            recordTrashRemoval(node, parent, index);
            parent.children.splice(index, 1);
            parent._modified = true;
            inverses.push(() => {
                parent.children.splice(index, 0, node);
            });
            forwards.push(() => {
                const i = parent.children.indexOf(node);
                if (i >= 0) parent.children.splice(i, 1);
            });
        },
        move(node, fromParent, toParent, toIndex) {
            const fromIndex = fromParent?.children ? fromParent.children.indexOf(node) : -1;
            if (!moveBookmarkChild(node, fromParent, toParent, toIndex)) return;
            const actualToIndex = toParent.children.indexOf(node);
            inverses.push(() => moveBookmarkChild(node, toParent, fromParent, fromIndex));
            forwards.push(() => moveBookmarkChild(node, fromParent, toParent, toIndex));
        },
        create(parent, node, index) {
            if (!parent) return;
            if (!parent.children) parent.children = [];
            const insertAt = Number.isInteger(index) && index >= 0 ? Math.min(index, parent.children.length) : parent.children.length;
            parent.children.splice(insertAt, 0, node);
            parent._modified = true;
            inverses.push(() => {
                const i = parent.children.indexOf(node);
                if (i >= 0) parent.children.splice(i, 1);
            });
            forwards.push(() => {
                parent.children.splice(insertAt, 0, node);
            });
        }
    };
    // A destructive unit used to stash a read-only copy here. It was a full JSON clone in
    // localStorage, capped at 3000 links, so on a real library it never wrote anything: the copy
    // is gone and Undo, the Trash and a JSON export cover a bad batch instead.
    work(api);
    if (inverses.length) {
        pushUndo(label, () => {
            for (let i = inverses.length - 1; i >= 0; i--) inverses[i]();
        }, () => {
            for (let i = 0; i < forwards.length; i++) forwards[i]();
        });
    }
    flushTrashDraft(label);
    return inverses.length;
}

function folderPathFor(node) {
    if (!bookmarkData || !node) return '';
    const trail = [];
    function find(current, path) {
        if (current === node) {
            trail.push(...path, displayFolderTitle(current));
            return true;
        }
        if (!current?.children) return false;
        return current.children.some(child => find(child, [...path, displayFolderTitle(current)]));
    }
    find(bookmarkData, []);
    return displayFolderPath(trail.slice(0, -1).join(' / '));
}

function moveBookmarkChild(node, fromParent, toParent, toIndex) {
    if (!fromParent?.children || !toParent) return false;
    const fromIndex = fromParent.children.indexOf(node);
    if (fromIndex < 0) return false;
    if (fromParent === toParent) {
        if (!Number.isInteger(toIndex) || toIndex < 0) return false;
        fromParent.children.splice(fromIndex, 1);
        const insertAt = Math.min(toIndex, fromParent.children.length);
        if (insertAt === fromIndex) {
            fromParent.children.splice(fromIndex, 0, node);
            return false;
        }
        fromParent.children.splice(insertAt, 0, node);
        node._modified = true;
        fromParent._modified = true;
        return true;
    }
    fromParent.children.splice(fromIndex, 1);
    if (!toParent.children) toParent.children = [];
    if (Number.isInteger(toIndex) && toIndex >= 0) {
        toParent.children.splice(Math.min(toIndex, toParent.children.length), 0, node);
    } else {
        toParent.children.push(node);
    }
    node._modified = true;
    fromParent._modified = true;
    toParent._modified = true;
    return true;
}

// --- Core library (live bookmarks API) ---
function pickJsonImport() {
    document.getElementById('file-upload')?.click();
}

function pickJsonCompare() {
    document.getElementById('compare-upload')?.click();
}

function importBookmarks(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            bookmarkData = JSON.parse(e.target.result);
            hasUnsavedChanges = false;
            statsDataRev++;
            statsModelCache = { key: '', model: null };
            updateStatus();
            renderSidebar();
            if (document.getElementById('stats-view')?.classList.contains('active')) renderStatistics();
            const counts = countTree(bookmarkData);
            logAffected('SYSTEM', file.name, `Imported bookmark JSON “${file.name}” (${(file.size / 1024).toFixed(1)} KB). Replaced the session tree. ${counts.links} link(s), ${counts.folders} folder(s). Session edits start from this snapshot. Did not write Firefox or Chrome bookmarks; Export downloads a new JSON file.`, {
                source: 'Import and Backup',
                kind: 'import',
                reason: 'JSON parse succeeded; dirty flag cleared; statistics cache invalidated.'
            });
        } catch (err) {
            alert('Invalid JSON file.');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function exportBookmarks() {
    if (!bookmarkData) return alert('No bookmarks loaded.');
    applyStoredNotes(bookmarkData);
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(bookmarkData, null, 2));
    const dlAnchorElem = document.createElement('a');
    dlAnchorElem.setAttribute('href', dataStr);
    dlAnchorElem.setAttribute('download', 'bookmarks_exported.json');
    dlAnchorElem.click();
    clearModifiedFlags(bookmarkData);
    hasUnsavedChanges = false;
    updateStatus();
    if (currentFolder) renderFolderContents(currentFolder);
    logAffected('SYSTEM', 'bookmarks_exported.json', `Downloaded bookmarks_exported.json from the current tree (${countTree(bookmarkData).links} link(s)). Cleared _modified flags so the editor is clean until the next edit. This file is a copy; the in-memory tree stayed loaded.`, {
        source: 'Import and Backup',
        kind: 'export',
        reason: 'Browser download started; dirty flag cleared.'
    });
}

// --- Netscape HTML import ---
// The file's own entries go inside one new folder under Other Bookmarks, so an import can
// never restructure what is already there. Live writes go through the same api.create the
// other bulk creates use, so this is one undoable step in both builds.
function pickHtmlImport() {
    document.getElementById('html-import-input')?.click();
}

function importNetscapeHtml(event) {
    const input = event && event.target;
    const file = input && input.files ? input.files[0] : null;
    if (input) input.value = '';
    if (!file) return;
    if (!bookmarkData) return alert('No bookmarks loaded.');
    const reader = new FileReader();
    reader.onload = e => {
        let parsed = null;
        try {
            parsed = parseNetscapeBookmarks(String((e && e.target && e.target.result) || ''));
        } catch (err) {
            console.error(err);
        }
        if (!parsed) return alert(`“${file.name}” could not be read as a Netscape bookmark file.`);
        // Counts the file's own entries: the parsed wrapper is not itself imported as a folder.
        const countEntries = list => (list || []).reduce((acc, node) => {
            if (node.children) {
                const inner = countEntries(node.children);
                acc.folders += 1 + inner.folders;
                acc.links += inner.links;
            } else {
                acc.links += 1;
            }
            return acc;
        }, { links: 0, folders: 0 });
        const counts = countEntries(parsed.entries);
        if (!counts.links && !counts.folders) return alert(`No bookmarks or folders were found in “${file.name}”.`);
        const other = findSpecialFolder('unfiled_____');
        if (!other) return alert('No Other Bookmarks folder was found.');
        const base = parsed.title || String(file.name).replace(/\.html?$/i, '') || 'Imported bookmarks';
        const folderName = nextNewFolderName((other.children || []).filter(isBookmarkFolderNode).map(node => node.title), base);
        if (!confirm(`Import ${formatCount(counts.links)} bookmark(s) and ${formatCount(counts.folders)} folder(s) from “${file.name}” into Other Bookmarks / ${folderName}?`)) return;
        const now = typeof liveCreateNode === 'function' ? Date.now() : Date.now() * 1000;
        const folder = {
            typeCode: 2,
            title: folderName,
            children: parsed.entries,
            dateAdded: now,
            _modified: true
        };
        withUndo('Import HTML bookmarks', api => {
            api.create(other, folder);
            logAffected('ADDED', folderName, `Imported ${formatCount(counts.links)} bookmark(s) and ${formatCount(counts.folders)} folder(s) from “${file.name}” (Netscape bookmark file).`, {
                source: 'Import',
                node: folder,
                folderPath: folderPathFor(other) || displayFolderTitle(other)
            });
        });
        markChanged();
        renderSidebar();
        if (typeof expandFolderAncestors === 'function') expandFolderAncestors(folder);
        openFolder(folder);
    };
    reader.onerror = () => alert(`“${file.name}” could not be read.`);
    reader.readAsText(file);
}

// The whole library in Firefox's own whole-library shape: <TITLE>Bookmarks</TITLE> with the
// root's folders directly in the top list and no wrapper entry, saved as Bookmarks.html.
function exportLibraryAsHtml() {
    if (!bookmarkData) return alert('No bookmarks loaded.');
    applyStoredNotes(bookmarkData);
    const html = netscapeBookmarkHtml(bookmarkData, { title: 'Bookmarks', wrap: false });
    const filename = netscapeBookmarkFileName('Bookmarks');
    downloadTextFile(filename, html, 'text/html');
    const counts = countTree(bookmarkData);
    logAffected('SYSTEM', filename, `Exported the whole library as a Netscape bookmark file (${formatCount(counts.links)} link(s), ${formatCount(counts.folders)} folder(s)). The file is a copy; it changes nothing and leaves unsaved changes alone.`, {
        source: 'Export',
        kind: 'export',
        reason: 'Browser download started from the library menu.'
    });
}

// Exports one folder as a Netscape bookmark file — the format every browser imports.
// "tree" is the sidebar folder menu, anything else the list row menu.
// A menu can hold a folder reference from before an edit. Exporting that stale object
// would write the folder without whatever has since moved into it, so look the folder up
// again in the current tree by id, then by guid.
function resolveExportFolder(folder) {
    if (!folder || !bookmarkData || folder === bookmarkData) return folder;
    if (folder.id != null && typeof findBookmarkNodeById === 'function') {
        const byId = findBookmarkNodeById(bookmarkData, folder.id);
        if (byId) return byId;
    }
    const guid = String(folder.guid || '');
    if (!guid) return folder;
    let found = null;
    walkBookmarkTree(bookmarkData, node => {
        if (!found && isBookmarkFolderNode(node) && String(node.guid || '') === guid) found = node;
    });
    return found || folder;
}

function exportFolderNodeAsHtml(folder) {
    if (!folder || !isBookmarkFolderNode(folder)) return alert('Pick a folder to export.');
    // The library root keeps Firefox's own shape and title; a real folder is exported as
    // one entry, so importing the file recreates that folder with everything inside it.
    const libraryRoot = folder === bookmarkData || String(folder.guid || '') === 'root________';
    const title = libraryRoot ? 'Bookmarks' : (displayFolderTitle(folder) || folder.title || 'Bookmarks');
    applyStoredNotes(folder);
    const html = netscapeBookmarkHtml(folder, { title, wrap: !libraryRoot });
    const filename = netscapeBookmarkFileName(title);
    downloadTextFile(filename, html, 'text/html');
    const counts = countTree(folder);
    logAffected('SYSTEM', filename, `Exported “${title}” as a Netscape bookmark file (${counts.links} link(s), ${counts.folders} folder(s)). The file is a copy: importing it into a browser recreates the folder from its <H3> entry. Nothing in the library changed.`, {
        source: 'Export',
        kind: 'export',
        reason: 'Browser download started from the folder context menu.'
    });
}

// The folder-menu entry point: which menu was used decides the folder, then exportFolderNodeAsHtml writes it.
function exportFolderAsHtml(which) {
    const picked = which === 'tree'
        ? rightClickedFolder
        : which === 'current'
            ? currentFolder
            : (rightClickedItem && rightClickedItem.item);
    if (!picked || !isBookmarkFolderNode(picked)) return alert('Right-click a folder to export it.');
    return exportFolderNodeAsHtml(resolveExportFolder(picked));
}

// --- Hacker News Actions ---
function collectHackerNewsHits() {
    const hits = [];
    walkBookmarkTree(bookmarkData, node => {
        const uri = nodeUri(node);
        if (!uri || !uri.includes('hcker.news/?comments=')) return;
        try {
            const id = new URL(uri).searchParams.get('comments');
            if (id) {
                hits.push({
                    node,
                    nextUri: `https://news.ycombinator.com/item?id=${id}`,
                    nextTitle: node.title ? node.title.replace(' – Comments – hcker.news', ' | Hacker News') : node.title
                });
            }
        } catch (e) {}
    });
    return hits;
}

function renderHackerNewsTable(hits) {
    const box = document.getElementById('hn-results');
    if (!box) return;
    if (!hits.length) {
        box.innerHTML = '<p>No <code>hcker.news/?comments=</code> links found.</p>';
        return;
    }
    box.innerHTML = `
        <p>${hits.length} hcker.news link${hits.length === 1 ? '' : 's'} will convert:</p>
        <table class="excel-table">
            <thead><tr>${bulkHeaderCell({ pick: 'hn' })}<th>#</th><th>Title now</th><th>URL now</th><th>Title after</th><th>URL after</th></tr></thead>
            <tbody>
                ${hits.map((hit, i) => `<tr>
                    <td>${bulkPickBox('hn', hit.node)}</td>
                    <td class="row-num">${i + 1}</td>
                    <td>${escapeHtml(hit.node.title || 'Untitled')}</td>
                    <td class="log-url">${escapeHtml(nodeUri(hit.node))}</td>
                    <td>${escapeHtml(hit.nextTitle || hit.node.title || 'Untitled')}</td>
                    <td class="log-url">${escapeHtml(hit.nextUri)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
    `;
}

function scanHackerNewsLinks() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectHackerNewsHits();
    startBulkPick('hn');
    renderHackerNewsTable(hits);
    setBulkPlan('hn', { count: hits.length, label: 'Hacker News conversion', apply: applyHackerNewsLinks });
    logAffected('SYSTEM', 'Hacker News scan', `Scanned for hcker.news/?comments= bookmarks. Found ${hits.length} link(s) that would convert to https://news.ycombinator.com/item?id=… with titles ending “ | Hacker News” instead of “ – Comments – hcker.news”. Nothing was rewritten yet. Apply Hacker News conversion to change those URLs and titles.`, { source: 'Hacker News conversion', scan: true });
}

function applyHackerNewsLinks() {
    const hits = collectHackerNewsHits().filter(hit => bulkPicked('hn', hit.node));
    withUndo('Hacker News conversion', api => {
        hits.forEach(hit => {
            const oldUri = hit.node.uri;
            const oldTitle = hit.node.title;
            api.set(hit.node, 'uri', hit.nextUri);
            if (hit.nextTitle !== hit.node.title) api.set(hit.node, 'title', hit.nextTitle);
            logAffected('MODIFIED', hit.node.title, 'Converted hcker.news comments URL to news.ycombinator.com.', {
                source: 'Hacker News conversion',
                node: hit.node,
                oldUri,
                newUri: hit.nextUri,
                uri: hit.nextUri,
                oldTitle,
                newTitle: hit.node.title
            });
        });
    });
    markChanged();
    const box = document.getElementById('hn-results');
    if (box) box.innerHTML = `<p>Converted ${hits.length} HN link(s).</p>`;
    alert(`Successfully converted ${hits.length} HN link(s).`);
}

function convertHackerNewsLinks() {
    scanHackerNewsLinks();
    applyBulk('hn');
}

// Same folders planEmptyFolderRemoval would offer, so a button never shows over an empty list.
function folderHasRemovableEmptyFolders(node) {
    if (!node || !bookmarkData) return false;
    return subtreeStat('removableEmpty', node, () => {
        let found = false;
        walkBookmarkTree(node, (child, parent) => {
            if (found || !parent) return;
            if (isBookmarkFolderNode(child) && !isProtectedCleanupFolder(child) && holdsOnlyEmptyFolders(child)) found = true;
        });
        return found;
    });
}

function toolbarHasEmptySubfolder() {
    return bookmarkData ? folderHasRemovableEmptyFolders(findSpecialFolder('toolbar_____')) : false;
}

function updateRemoveEmptyTab() {
    const tab = document.getElementById('tab-remove-empty');
    if (tab) tab.hidden = !toolbarHasEmptySubfolder();
}

// The folder-title button only covers the folder on screen, unlike the library-wide tab.
function updateFolderEmptyButton(folderNode) {
    const btn = document.getElementById('folder-remove-empty');
    if (!btn) return;
    const target = folderNode || currentFolder || bookmarkData;
    const show = Boolean(target) && isBookmarkFolderNode(target) && folderHasRemovableEmptyFolders(target);
    btn.hidden = !show;
    if (show) btn.title = `Remove the empty folders inside ${displayFolderTitle(target)} only`;
}

// --- UI Rendering ---
function renderSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = smartFoldersSidebarHtml();
    bindSmartFolderRows(sidebar);
    treeItemList.length = 0;
    const treeFilterActive = Boolean((document.getElementById('tree-filter') || {}).value);
    updateRemoveEmptyTab();
    updateFolderEmptyButton(currentFolder);
    if (!bookmarkData) {
        updateOtherCollectButton(null);
        return;
    }

    function buildTree(node, container, nestCollapsed = false) {
        if (node.typeCode === 2 || node.children) {
            const nodeDiv = document.createElement('div');
            const collapseKids = folderMatchesSpecial(node, 'toolbar_____') || folderMatchesSpecial(node, 'unfiled_____');
            nodeDiv.className = nestCollapsed ? 'tree-node' : 'tree-node expanded';

            const itemDiv = document.createElement('div');
            itemDiv.className = 'tree-item';
            const view = subredditFolderView(displayFolderTitle(node));
            itemDiv.innerHTML = `<span class="arrow">▶</span><span class="tree-label">📁 ${escapeHtml(view.label)}${view.markHtml}${emptyFolderBadgeHtml(node)}</span>`;
            itemDiv.title = view.full;
            bindNodeHoverTip(itemDiv, node);
            folderTreeItems.set(node, { itemDiv, nodeDiv });
            treeItemList.push({ node, itemDiv, nodeDiv });
            treeItemNodes.set(itemDiv, node);
            if (treeSelection.length > 1 && treeSelection.includes(node)) itemDiv.classList.add('tree-picked');
            
            itemDiv.onmousedown = (e) => {
                if (e.shiftKey) e.preventDefault();
            };
            itemDiv.onclick = (e) => {
                e.stopPropagation();
                if (e.target.className === 'arrow') {
                    nodeDiv.classList.toggle('expanded');
                    return;
                }
                if (e.shiftKey || e.metaKey || e.ctrlKey) {
                    pickTreeFolder(node, e.shiftKey ? 'range' : 'toggle');
                    return;
                }
                setTreeSelection([node]);
                openFolder(node);
            };
            itemDiv.draggable = true;
            itemDiv.ondragstart = (e) => {
                if (e.target.className === 'arrow') {
                    e.preventDefault();
                    return;
                }
                const picked = treeSelection.length > 1 && treeSelection.includes(node)
                    ? treeSelection.filter(item => !isRootDirectFolder(item))
                    : [node];
                libraryDragNodes = picked.filter(item => !picked.some(other => other !== item && isNodeInSubtree(other, item)));
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', 'bookmarks');
            };
            itemDiv.ondragend = () => {
                libraryDragNodes = [];
                clearLibraryDropMarks();
            };
            bindLibraryDropTarget(itemDiv, node);
            itemDiv.oncontextmenu = (e) => {
                e.preventDefault();
                e.stopPropagation();
                showFolderTreeMenu(e, node);
            };

            nodeDiv.appendChild(itemDiv);

            if (node.children && node.children.length > 0) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                node.children.forEach(child => buildTree(child, childrenContainer, nestCollapsed || collapseKids));
                nodeDiv.appendChild(childrenContainer);
            }
            container.appendChild(nodeDiv);
        }
    }
    if (typeof capturePrefs !== 'undefined' && capturePrefs.hideRootFolder !== false && bookmarkData.children && bookmarkData.children.length) {
        bookmarkData.children.forEach(child => buildTree(child, sidebar, false));
    } else {
        buildTree(bookmarkData, sidebar);
    }
    treeSelection = treeSelection.filter(node => folderTreeItems.has(node) && isNodeInSubtree(bookmarkData, node));
    const stayEntry = currentFolder && folderTreeItems.get(currentFolder);
    const stay = currentFolder && isNodeInSubtree(bookmarkData, currentFolder) && (stayEntry || currentFolder === bookmarkData);
    if (stay && stayEntry) {
        stayEntry.nodeDiv.classList.add('expanded');
        stayEntry.itemDiv.classList.add('selected');
    } else if (stay) {
        openFolder(bookmarkData);
    } else {
        const startup = typeof capturePrefs !== 'undefined' ? capturePrefs.startupFolder : 'toolbar';
        const toolbar = startup === 'root' ? null : findSpecialFolder('toolbar_____');
        if (toolbar) openFolder(toolbar);
        else {
            const firstItem = sidebar.querySelector('.tree-item');
            if (firstItem) firstItem.click();
        }
    }
    updateOtherCollectButton(currentFolder);
    applyTreeFilter();
    // A rebuilt tree has no badge element yet: put the one on the selected row back.
    paintFolderShownBadge();
}

function setTreeSelection(nodes, anchor = nodes[nodes.length - 1] || null) {
    treeSelection = nodes.slice();
    treeSelectionAnchor = anchor;
    document.querySelectorAll('.tree-item.tree-picked').forEach(el => el.classList.remove('tree-picked'));
    if (treeSelection.length < 2) return;
    treeSelection.forEach(node => folderTreeItems.get(node)?.itemDiv.classList.add('tree-picked'));
}

function visibleTreeFolders() {
    return [...document.querySelectorAll('#sidebar .tree-item')]
        .filter(el => el.offsetParent !== null)
        .map(el => treeItemNodes.get(el))
        .filter(Boolean);
}

function pickTreeFolder(node, mode) {
    const base = treeSelection.length ? treeSelection : (currentFolder && folderTreeItems.has(currentFolder) ? [currentFolder] : []);
    if (mode === 'range') {
        const order = visibleTreeFolders();
        const anchor = treeSelectionAnchor && order.includes(treeSelectionAnchor) ? treeSelectionAnchor : (base[0] || node);
        const from = order.indexOf(anchor);
        const to = order.indexOf(node);
        if (from < 0 || to < 0) return setTreeSelection([node]);
        const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setTreeSelection(range, anchor);
        return;
    }
    const next = base.includes(node) ? base.filter(item => item !== node) : base.concat(node);
    setTreeSelection(next, node);
}

function folderDepth(node) {
    let depth = 0;
    for (let parent = findNodeParent(node); parent; parent = findNodeParent(parent)) depth += 1;
    return depth;
}

function mergeTreeFolders() {
    const target = rightClickedFolder;
    if (!target || target === bookmarkData || !treeSelection.includes(target)) return;
    const sources = treeSelection.filter(node => node !== target
        && node !== bookmarkData
        && !isRootDirectFolder(node)
        && !isNodeInSubtree(node, target)
        && isBookmarkFolderNode(node));
    if (!sources.length) return alert('None of the other selected folders can be merged into this one (root folders and folders that contain it are skipped).');
    const skipped = treeSelection.length - 1 - sources.length;
    const moved = sources.reduce((sum, node) => sum + (node.children || []).length, 0);
    const names = sources.map(node => `“${displayFolderTitle(node)}”`).slice(0, 5).join(', ') + (sources.length > 5 ? ', …' : '');
    if (!confirm(`Merge ${formatCount(sources.length)} folder(s) (${names}) into “${displayFolderTitle(target)}”? Their ${formatCount(moved)} entr${moved === 1 ? 'y moves' : 'ies move'} in and the emptied folders are removed.${skipped > 0 ? ` ${formatCount(skipped)} selected folder(s) can’t be merged and are skipped.` : ''}`)) return;
    const treeOrder = visibleTreeFolders();
    const position = node => {
        const index = treeOrder.indexOf(node);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    sources.sort((a, b) => folderDepth(b) - folderDepth(a) || position(a) - position(b));
    withUndo('Merge folders', api => {
        sources.forEach(folder => {
            const parent = findNodeParent(folder);
            [...(folder.children || [])].forEach(child => api.move(child, folder, target));
            if (parent) api.remove(folder, parent);
            logAffected('MODIFIED', displayFolderTitle(target), `Merged “${displayFolderTitle(folder)}” into “${displayFolderTitle(target)}”.`, {
                source: 'Folder tree',
                node: target
            });
        });
    });
    markChanged();
    setTreeSelection([target]);
    renderSidebar();
    if (typeof expandFolderAncestors === 'function') expandFolderAncestors(target);
    openFolder(target);
    if (typeof refreshDuplicateBookmarksScan === 'function' && dupeCleanup.groups.length && refreshDupesOnDeleteEnabled()) refreshDuplicateBookmarksScan();
}

function openFolder(folderNode) {
    const treeEntry = folderTreeItems.get(folderNode);
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('selected'));
    if (treeEntry) {
        treeEntry.nodeDiv.classList.add('expanded');
        treeEntry.itemDiv.classList.add('selected');
        treeEntry.itemDiv.scrollIntoView({ block: 'nearest' });
    }
    if (currentFolder !== folderNode) folderSubredditsExpanded = false;
    // The folder box follows the tree's selection while the Filters panel is on screen. That follow
    // only writes the box (and takes back a token it wrote earlier): it never searches, so the
    // listing is always drawn here, from whatever the search box now says — usually nothing.
    const treeFolderChanged = comboTreeFolder !== folderNode;
    comboTreeFolder = folderNode || null;
    currentFolder = folderNode;
    applyRememberedLibrarySort(folderNode);
    rememberFolderVisit(folderNode);
    if (treeFolderChanged) followTreeFolderInFilters();
    renderFolderContents(folderNode);
}

function nodeSearchText(node) {
    return `${node.title || ''} ${nodeUri(node)} ${node.tags || ''}`.toLowerCase();
}

function countFolderDescendants(folder) {
    return subtreeStat('descendants', folder, () => {
        let n = 0;
        walkBookmarkTree(folder, (node, parent) => {
            if (parent) n++;
        });
        return n;
    });
}

// Subtree facts — how much is under a folder, what its menu stats are, whether it holds only empty
// folders — change only when the library does, and that is what statsDataRev counts. Every render
// used to recompute them, each walk covering the whole subtree: the meta line, the "Remove empty
// folders" button, the recursive scope count and the everywhere count. On a 100,000-bookmark
// library that is hundreds of thousands of node visits per keystroke for answers that cannot have
// changed. One entry per node per revision, dropped wholesale when the revision moves.
let subtreeStatRev = -1;
const subtreeStatCaches = new Map();

function subtreeStat(name, node, compute) {
    if (subtreeStatRev !== statsDataRev) {
        subtreeStatRev = statsDataRev;
        subtreeStatCaches.clear();
    }
    let cache = subtreeStatCaches.get(name);
    if (!cache) {
        cache = new WeakMap();
        subtreeStatCaches.set(name, cache);
    }
    if (node && cache.has(node)) return cache.get(node);
    const value = compute();
    if (node) cache.set(node, value);
    return value;
}

function collectFolderHits(folder, { query = '', recursive = false, all = false } = {}) {
    const hits = [];
    // Every query goes through the parser, not just one with operators in it. A plain word used to be
    // matched with `nodeSearchText(child).includes(query)`, which quietly ignored the whole-words and
    // case-sensitivity settings, wildcards, and the folder path — so "kit" matched "Kitten" with
    // Whole words on, and a word in an ancestor folder name matched everywhere but not in a folder.
    if (!all && query) {
        return searchLibraryScoped(folder, query, recursive, false).hits;
    }
    const walk = (node, relPath) => {
        (node.children || []).forEach(child => {
            const matches = all || !query || nodeSearchText(child).includes(query);
            if (matches) hits.push({ node: child, parent: node, relPath });
            if ((all || (query && recursive)) && isBookmarkFolderNode(child)) {
                walk(child, relPath.concat(displayFolderTitle(child)));
            }
        });
    };
    walk(folder, []);
    return hits;
}

function collectFolderListing(folder, query, recursive) {
    return collectFolderHits(folder, { query, recursive });
}

function collectAllFolderHits(folder) {
    return collectFolderHits(folder, { all: true });
}

function libraryNodeName(node) {
    if (!node) return '';
    return isBookmarkFolderNode(node) ? displayFolderTitle(node, 'Untitled') : (node.title || 'Untitled');
}

function libraryAddedLabel(node) {
    const ms = parseBookmarkDateMs(node && node.dateAdded);
    return ms ? new Date(ms).toLocaleString() : '';
}

function sortLibraryHits(hits) {
    if (!librarySort.key) return hits;
    const dir = librarySort.dir || 1;
    const byName = (a, b) => libraryNodeName(a.node).localeCompare(libraryNodeName(b.node), undefined, { sensitivity: 'base' });
    return hits.slice().sort((a, b) => {
        if (librarySort.key === 'name') {
            return libraryNodeName(a.node).localeCompare(libraryNodeName(b.node), undefined, { sensitivity: 'base' }) * dir;
        }
        if (librarySort.key === 'location') {
            // Folders have no URL, so they sort under their own name among the rest.
            const au = nodeUri(a.node) || libraryNodeName(a.node);
            const bu = nodeUri(b.node) || libraryNodeName(b.node);
            return au.localeCompare(bu, undefined, { sensitivity: 'base' }) * dir || byName(a, b);
        }
        const am = parseBookmarkDateMs(a.node.dateAdded) || 0;
        const bm = parseBookmarkDateMs(b.node.dateAdded) || 0;
        return (am - bm) * dir || libraryNodeName(a.node).localeCompare(libraryNodeName(b.node), undefined, { sensitivity: 'base' });
    });
}

function updateLibrarySortHeaders() {
    const headers = [
        ['bookmark-sort-name', 'Name'],
        ['bookmark-sort-location', 'Location'],
        ['bookmark-sort-added', 'Added']
    ];
    headers.forEach(([id, label]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = `${label}${librarySort.key === id.replace('bookmark-sort-', '') ? (librarySort.dir > 0 ? ' ↑' : ' ↓') : ''}`;
        el.classList.toggle('sorted', librarySort.key === id.replace('bookmark-sort-', ''));
    });
}

function toggleLibrarySort(key, firstDir) {
    if (librarySort.key === key) librarySort.dir *= -1;
    else librarySort = { key, dir: firstDir };
    rememberLibrarySort();
    if (currentFolder) renderFolderContents(currentFolder);
}

function renderFolderParent(folderNode) {
    const btn = document.getElementById('folder-up');
    if (!btn) return;
    const parent = folderNode && folderNode !== bookmarkData ? findNodeParent(folderNode) : null;
    // The root is not a folder you navigate to: a top-level folder has no "up", so the chip is
    // hidden rather than offering a step into the library root.
    const usable = parent && parent !== bookmarkData;
    btn.hidden = !usable;
    if (!usable) {
        btn.onclick = null;
        btn.textContent = '';
        btn.title = '';
        return;
    }
    const view = subredditFolderView(displayFolderTitle(parent, parent === bookmarkData ? 'Your bookmarks' : 'Up'));
    btn.textContent = `↑ ${view.label}`;
    btn.classList.toggle('subreddit-folder-title', Boolean(view.spec));
    btn.title = view.spec ? view.full : '';
    btn.onclick = () => openFolder(parent);
}

function paintLibrarySelection() {
    document.querySelectorAll('#bookmarks-body tr').forEach(row => {
        const on = librarySelection.includes(row._libraryNode);
        row.classList.toggle('selected', on);
        if (on && row._libraryNode === highlightBookmark) row.classList.add('library-highlight');
    });
}

function selectLibraryNodes(nodes, anchor) {
    librarySelection = nodes.filter(Boolean);
    libraryAnchor = anchor || librarySelection[librarySelection.length - 1] || null;
    paintLibrarySelection();
}

function openLibraryNode(node) {
    if (!node) return;
    if (isBookmarkFolderNode(node)) openFolder(node);
    else if (nodeUri(node)) window.open(nodeUri(node), '_blank', 'noopener');
}

// The Bookmarks row menu's Copy submenu. URLs are always the clean ones: the tracking
// rule General repairs uses, then the same Google/YouTube canonicalisation the Obsidian
// sends apply. Copy URL (Original) keeps the stored URL untouched.
function copyLibraryEntries(node, action) {
    // Like Delete, Move to Other Bookmarks, and Nest: the whole selection when the clicked
    // row is part of it, otherwise just that row. Folders contribute a name to Copy Title
    // and nothing to the URL shapes, which have no URL of their own to give.
    const picked = librarySelection.includes(node) && librarySelection.length > 1
        ? librarySelection.slice()
        : [node];
    const lines = [];
    picked.forEach(item => {
        if (!item) return;
        const uri = nodeUri(item);
        if (!uri) {
            const name = String(item.title || '').trim();
            if (action === 'copyTitle' && name) lines.push(name);
            return;
        }
        const title = String(item.title || '').trim() || uri;
        const clean = typeof cleanCopyUrl === 'function' ? cleanCopyUrl(uri) : uri;
        lines.push(action === 'copyTitle'
            ? title
            : action === 'copyUrl'
                ? clean
                : action === 'copyUrlOriginal'
                    ? uri
                    : mdLinkLine({ title, uri: clean }, 0));
    });
    if (!lines.length) return;
    return copyTextToClipboard(lines.join('\n'));
}

function refreshLibraryAfterStructureChange(prefer) {
    // Any library reload changes which tabs are already saved, so the Open Tabs view (its Show in
    // library buttons and its saved flags) is re-rendered from the fresh tree.
    if (typeof renderOpenTabs === 'function') { try { void renderOpenTabs(); } catch (err) { /* the view may not be built yet */ } }
    const next = prefer && isNodeInSubtree(bookmarkData, prefer) ? prefer : bookmarkData;
    renderSidebar();
    if (next) openFolder(next);
}

function isRootDirectFolder(node) {
    if (!node || !bookmarkData) return false;
    if (node === bookmarkData) return true;
    return findNodeParent(node) === bookmarkData && isBookmarkFolderNode(node);
}

function holdsOnlyEmptyFolders(node) {
    if (!isBookmarkFolderNode(node)) return false;
    return subtreeStat('emptyOnly', node, () => (node.children || []).every(holdsOnlyEmptyFolders));
}

function deleteLibraryNodes(nodes, options = {}) {
    const unique = [];
    (nodes || []).forEach(node => {
        if (node && !unique.includes(node) && !isRootDirectFolder(node)) unique.push(node);
    });
    if (!unique.length) return alert('Folders directly under the library root stay.');
    // Protected folders (and anything inside them) are skipped by every bulk delete.
    const protectedOnes = unique.filter(node => isNodeUnderProtection(node));
    const deletable = unique.filter(node => !isNodeUnderProtection(node));
    if (!deletable.length) return alert(`Every entry here is protected from scans (${formatCount(protectedOnes.length)}). Remove the protection first.`);
    const label = deletable.length === 1
        ? `"${libraryNodeName(deletable[0])}"`
        : `${formatCount(deletable.length)} items`;
    const allEmptyFolders = deletable.every(holdsOnlyEmptyFolders);
    if (!options.confirmed && !allEmptyFolders && !confirm(`Delete ${label}?`)) return;
    const stay = currentFolder && !deletable.includes(currentFolder) ? currentFolder : findNodeParent(currentFolder);
    const removed = withUndo('Delete bookmarks', api => {
        deletable.forEach(node => {
            const parent = findNodeParent(node);
            if (!parent) return;
            logAffected('REMOVED', libraryNodeName(node), 'Deleted from the bookmarks list.', {
                source: 'Bookmarks list',
                node,
                uri: nodeUri(node),
                dateAdded: node.dateAdded,
                folderPath: folderPathFor(node)
            });
            api.remove(node, parent);
        });
    });
    if (!removed) return;
    librarySelection = librarySelection.filter(node => !deletable.includes(node));
    if (deletable.includes(libraryAnchor)) libraryAnchor = librarySelection[0] || null;
    markChanged();
    refreshLibraryAfterStructureChange(stay);
    if (typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') maybeRefreshDuplicateBookmarksAfterDelete(deletable);
    refreshRepairScansAfterDelete();
}

// Cards whose results are already on screen are re-scanned after a delete, so a delete made
// through the shared preview dialog does not leave a stale table behind.
function refreshRepairScansAfterDelete() {
    const cards = [
        ['repairs-deaddomain-results', 'scanDeadDomains'],
        ['repairs-sametitle-results', 'scanSameTitleDomain'],
        ['repairs-title-results', 'scanTitleCleanup'],
        ['repairs-problems-results', 'scanLibraryProblems']
    ];
    cards.forEach(([boxId, fn]) => {
        const box = document.getElementById(boxId);
        if (!box || !box.querySelector('table')) return;
        const fnRef = window[fn];
        if (typeof fnRef === 'function') fnRef();
    });
}

// The preview shows exactly what a delete would remove, and protected folders are skipped.
function previewDeleteLibraryNodes(nodes) {
    const unique = [];
    (nodes || []).forEach(node => {
        if (node && !unique.includes(node) && !isRootDirectFolder(node)) unique.push(node);
    });
    if (!unique.length) return alert('Folders directly under the library root stay.');
    const rows = destructivePreviewRows(unique);
    const protectedCount = unique.filter(isNodeUnderProtection).length;
    const deletable = unique.filter(node => !isNodeUnderProtection(node));
    const counts = deletable.reduce((acc, node) => {
        const tree = countTree(node);
        acc.links += tree.links;
        acc.folders += tree.folders;
        return acc;
    }, { links: 0, folders: 0 });
    if (!deletable.length) return alert(`Every entry here is protected from scans (${formatCount(protectedCount)}). Remove the protection first.`);
    openPreviewDialog({
        title: `Delete ${deletable.length === 1 ? `“${libraryNodeName(deletable[0])}”` : `${formatCount(deletable.length)} entries`}?`,
        note: `${formatCount(counts.links)} bookmark(s) and ${formatCount(counts.folders)} folder(s) will go, as one undo step.${protectedCount ? ` ${formatCount(protectedCount)} protected entries are skipped.` : ''}`,
        rows,
        confirmLabel: 'Delete',
        onConfirm: () => deleteLibraryNodes(unique, { confirmed: true })
    });
}

function moveLibraryNodes(nodes, destFolder, options = {}) {
    if (!destFolder || !isBookmarkFolderNode(destFolder)) return;
    // A bulk move shows the same preview a bulk delete does; a drag of one row stays immediate.
    const movingCount = (nodes || []).filter(Boolean).length;
    if (!options.confirmed && movingCount > 1) {
        const rows = destructivePreviewRows((nodes || []).filter(Boolean).map(node => ({ ...node, title: libraryNodeName(node) })));
        return confirmDialog({
            title: `Move ${formatCount(movingCount)} entries into “${displayFolderTitle(destFolder)}”?`,
            note: `${formatCount(movingCount)} entries change parent. Undo reverses the whole move.`,
            rows,
            confirmLabel: 'Move',
            onConfirm: () => moveLibraryNodes(nodes, destFolder, { confirmed: true })
        });
    }
    const moving = (nodes || []).filter(node => node && node !== destFolder && !isNodeInSubtree(node, destFolder));
    if (!moving.length) return;
    withUndo('Move bookmarks', api => {
        moving.forEach(node => {
            const parent = findNodeParent(node);
            if (!parent || parent === destFolder) return;
            api.move(node, parent, destFolder);
            logAffected('MODIFIED', libraryNodeName(node), `Moved into ${displayFolderTitle(destFolder)}.`, {
                source: 'Bookmarks list',
                node,
                uri: nodeUri(node),
                dateAdded: node.dateAdded
            });
        });
    });
    markChanged();
    refreshLibraryAfterStructureChange(currentFolder);
}

function nodesInsideFolder(folder) {
    const inside = new Set();
    if (folder) walkBookmarkTree(folder, node => inside.add(node));
    return inside;
}

function moveSelectionToOtherBookmarks() {
    if (!rightClickedItem?.item) return;
    const clicked = rightClickedItem.item;
    const selected = librarySelection.includes(clicked) ? librarySelection.slice() : [clicked];
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('Could not find Other Bookmarks.');
    const inOther = nodesInsideFolder(other);
    const candidates = selected.filter(node => {
        if (!node || node === bookmarkData || inOther.has(node)) return false;
        if (isNodeInSubtree(node, other)) return false;
        return Boolean(findNodeParent(node));
    });
    const moving = candidates.filter(node => !candidates.some(otherNode => otherNode !== node && isNodeInSubtree(otherNode, node)));
    if (!moving.length) return alert('Those items are already in Other Bookmarks.');
    const label = moving.length === 1 ? `"${libraryNodeName(moving[0])}"` : `${formatCount(moving.length)} items`;
    if (!confirm(`Move ${label} to Other Bookmarks?`)) return;
    moveLibraryNodes(moving, other);
}

function nestSelectionInNewFolder() {
    if (!rightClickedItem?.item) return;
    const clicked = rightClickedItem.item;
    const parent = findNodeParent(clicked);
    if (!parent || parent === bookmarkData) return alert('Entries directly under the library root can’t be nested.');
    const selected = librarySelection.includes(clicked) ? librarySelection.slice() : [clicked];
    const candidates = selected.filter(node => node && node !== bookmarkData && !isRootDirectFolder(node) && !isNodeInSubtree(node, parent) && findNodeParent(node));
    const nesting = candidates.filter(node => !candidates.some(other => other !== node && isNodeInSubtree(other, node)));
    if (!nesting.length) return alert('Folders directly under the library root can’t be nested.');
    const siblingIndex = node => parent.children.indexOf(node);
    nesting.sort((a, b) => {
        const ai = siblingIndex(a);
        const bi = siblingIndex(b);
        if (ai >= 0 && bi >= 0) return ai - bi;
        return (ai >= 0 ? -1 : 0) - (bi >= 0 ? -1 : 0);
    });
    const label = nesting.length === 1 ? `"${libraryNodeName(nesting[0])}"` : `${formatCount(nesting.length)} entries`;
    const defaultName = nextNewFolderName(parent.children.filter(isBookmarkFolderNode).map(node => node.title));
    const folderName = (prompt(`Nest ${label} in a new folder named:`, defaultName) || '').trim();
    if (!folderName) return;
    const indices = nesting.map(siblingIndex).filter(i => i >= 0);
    const insertAt = indices.length ? Math.min(...indices) : parent.children.length;
    const folder = {
        typeCode: 2,
        title: folderName,
        children: [],
        dateAdded: typeof liveCreateNode === 'function' ? Date.now() : Date.now() * 1000,
        _modified: true
    };
    withUndo('Nest in new folder', api => {
        api.create(parent, folder, insertAt);
        logAffected('ADDED', folderName, `New folder created to nest ${label}.`, {
            source: 'Bookmarks list',
            node: folder,
            folderPath: folderPathFor(parent) || displayFolderTitle(parent)
        });
        nesting.forEach(node => {
            const from = findNodeParent(node);
            if (!from) return;
            api.move(node, from, folder);
            logAffected('MODIFIED', libraryNodeName(node), `Nested into ${folderName}.`, {
                source: 'Bookmarks list',
                node,
                uri: nodeUri(node),
                folderPath: folderPathFor(folder) || folderName
            });
        });
    });
    markChanged();
    renderSidebar();
    if (typeof expandFolderAncestors === 'function') expandFolderAncestors(folder);
    openFolder(folder);
    selectLibraryNodes(nesting.filter(node => findNodeParent(node) === folder), nesting[0]);
}

function clearLibraryDropMarks() {
    document.querySelectorAll('.drop-target, .drop-before, .drop-after').forEach(el => {
        el.classList.remove('drop-target', 'drop-before', 'drop-after');
    });
    hideNodeHoverTip();
}

function hideNodeHoverTip() {
    const tip = document.getElementById('folder-hover-tip');
    hoverTipNode = null;
    if (!tip) return;
    tip.hidden = true;
    tip.classList.remove('is-open');
}

function fillNodeHoverTip(node) {
    const tip = document.getElementById('folder-hover-tip');
    if (!tip || !node) return null;
    const isFolder = isBookmarkFolderNode(node);
    if (!isFolder && !nodeUri(node)) return null;
    if (hoverTipNode === node) return tip;
    hoverTipNode = node;
    const empty = isFolder && !(node.children || []).length;
    tip.classList.add('has-stats');
    tip.innerHTML = `<div class="context-menu-stats${empty ? ' is-empty' : ''}">${isFolder ? folderStatsInnerHtml(node) : linkInfoInnerHtml(node)}</div>`;
    return tip;
}

function placeNodeHoverTip(clientX, clientY) {
    const tip = document.getElementById('folder-hover-tip');
    if (!tip || !tip.classList.contains('is-open')) return;
    const pad = 8;
    const ox = 14;
    const oy = 18;
    tip.style.width = 'auto';
    let left = clientX + ox;
    let top = clientY + oy;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    if (left + w > window.innerWidth - pad) left = clientX - w - ox;
    if (top + h > window.innerHeight - pad) top = clientY - h - oy;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
}

function showNodeHoverTip(folder, event) {
    if (!event || libraryDragNodes.length) return;
    const tip = fillNodeHoverTip(folder);
    if (!tip) return;
    tip.hidden = false;
    tip.classList.add('is-open');
    placeNodeHoverTip(event.clientX, event.clientY);
}

function bindNodeHoverTip(el, folder) {
    if (!el || !folder) return;
    el.onmouseenter = (event) => showNodeHoverTip(folder, event);
    el.onmousemove = (event) => {
        if (hoverTipNode === folder) placeNodeHoverTip(event.clientX, event.clientY);
        else showNodeHoverTip(folder, event);
    };
    el.onmouseleave = hideNodeHoverTip;
}

function libraryDropPlace(event, destNode) {
    if (!destNode || !libraryDragNodes.length || libraryDragNodes.includes(destNode)) return null;
    if (libraryDragNodes.some(node => node !== destNode && isNodeInSubtree(node, destNode))) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const canInto = isBookmarkFolderNode(destNode);
    if (canInto && ratio >= 0.3 && ratio <= 0.7) return { kind: 'into', dest: destNode };
    return { kind: ratio < 0.5 ? 'before' : 'after', dest: destNode };
}

function paintLibraryDrop(el, place) {
    el.classList.toggle('drop-target', place?.kind === 'into');
    el.classList.toggle('drop-before', place?.kind === 'before');
    el.classList.toggle('drop-after', place?.kind === 'after');
}

function bindLibraryDropTarget(el, destNode) {
    el.ondragover = (event) => {
        if (!libraryDragNodes.length) return;
        const place = libraryDropPlace(event, destNode);
        if (!place) {
            el.classList.remove('drop-target', 'drop-before', 'drop-after');
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        paintLibraryDrop(el, place);
    };
    el.ondragleave = (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        el.classList.remove('drop-target', 'drop-before', 'drop-after');
    };
    el.ondrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        el.classList.remove('drop-target', 'drop-before', 'drop-after');
        applyLibraryDrop(libraryDragNodes, destNode, event);
    };
}

function applyLibraryDrop(nodes, destNode, event) {
    const place = libraryDropPlace(event, destNode);
    if (!place) return;
    if (place.kind === 'into') moveLibraryNodes(nodes, destNode);
    else reorderLibraryNodes(nodes, destNode, place.kind);
}

function reorderLibraryNodes(nodes, destNode, where) {
    const destParent = findNodeParent(destNode);
    if (!destParent || (where !== 'before' && where !== 'after')) return;
    const moving = [];
    (nodes || []).forEach(node => {
        if (!node || node === destNode || moving.includes(node)) return;
        if (node === destParent || isNodeInSubtree(node, destParent)) return;
        moving.push(node);
    });
    if (!moving.length) return;
    let destIndex = destParent.children.indexOf(destNode);
    if (destIndex < 0) return;
    if (where === 'after') destIndex += 1;
    librarySort = { key: '', dir: 1 };
    withUndo('Reorder bookmarks', api => {
        moving.forEach(node => {
            const fromParent = findNodeParent(node);
            if (!fromParent) return;
            const fromIndex = fromParent.children.indexOf(node);
            if (fromIndex < 0) return;
            let toIndex = destIndex;
            if (fromParent === destParent && fromIndex < destIndex) toIndex = destIndex - 1;
            if (fromParent === destParent && toIndex === fromIndex) {
                destIndex = fromIndex + 1;
                return;
            }
            api.move(node, fromParent, destParent, toIndex);
            destIndex = destParent.children.indexOf(node) + 1;
            const same = fromParent === destParent;
            logAffected('MODIFIED', libraryNodeName(node), same
                ? `Reordered in ${displayFolderTitle(destParent)}.`
                : `Moved into ${displayFolderTitle(destParent)}.`, {
                source: 'Bookmarks list',
                node,
                uri: nodeUri(node),
                dateAdded: node.dateAdded
            });
        });
    });
    markChanged();
    refreshLibraryAfterStructureChange(currentFolder);
}

function toggleFolderSubreddits() {
    folderSubredditsExpanded = !folderSubredditsExpanded;
    paintFolderSubredditToggle();
}

function paintFolderSubredditToggle(hasSpec) {
    const heading = document.querySelector('#bookmarks-view .folder-heading');
    const toggle = document.getElementById('folder-subreddit-toggle');
    const spec = hasSpec == null ? Boolean(toggle && !toggle.hidden) : Boolean(hasSpec);
    const open = spec && folderSubredditsExpanded;
    if (heading) heading.classList.toggle('subreddit-expanded', open);
    if (!toggle) return;
    toggle.hidden = !spec;
    if (!spec) {
        toggle.setAttribute('aria-expanded', 'false');
        toggle.title = 'Show subreddit chips';
        toggle.onclick = null;
        return;
    }
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.title = open ? 'Hide subreddit chips' : 'Show subreddit chips';
    toggle.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFolderSubreddits();
    };
}

function renderFolderContents(folderNode) {
    const tbody = document.getElementById('bookmarks-body');
    tbody.innerHTML = '';
    if (!folderNode) {
        updateOtherCollectButton(null);
        return;
    }

    const query = (document.getElementById('bookmark-search')?.value || '').trim().toLowerCase();
    const recursiveBox = document.getElementById('bookmark-search-recursive');
    // Both boxes are read before anything uses them: a const referenced above its own
    // declaration is a temporal-dead-zone ReferenceError on every render.
    const everywhereBox = document.getElementById('bookmark-search-everywhere');
    const recursive = Boolean(query) && Boolean(recursiveBox?.checked);
    const searchInput = document.getElementById('bookmark-search');
    if (searchInput) {
        searchInput.placeholder = everywhereBox?.checked
            ? 'Search everywhere (Toolbar, Menu, Other, Mobile)'
            : recursiveBox?.checked
                ? 'Search this folder and subfolders'
                : 'Search this folder';
    }
    // The checkbox alone decides the scope: ticking it with an empty box lists the whole
    // library (every root: Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks, Mobile
    // Bookmarks), and typing anything searches all of them.
    const everywhere = Boolean(everywhereBox && everywhereBox.checked);
    const exhaustive = searchExhaustiveEnabled();
    const hits = everywhere
        ? (query
            ? (exhaustive
                ? searchLibraryExhaustive(bookmarkData, query, true, true).hits
                : hasSearchOperators(query) ? searchLibraryScoped(bookmarkData, query, true, true).hits : searchEverywhereHits(query))
            : collectAllFolderHits(bookmarkData))
        : (exhaustive && query
            ? searchLibraryExhaustive(folderNode, query, recursive, false).hits
            : collectFolderListing(folderNode, query, recursive));
    lastFolderHits = hits;
    const shown = sortLibraryHits(hits);
    // One <tr> per hit is the whole cost of a search, and a broad query over a 100,000-bookmark
    // library matches tens of thousands: building them all is seconds of layout and hundreds of
    // megabytes of DOM. The table therefore draws a page at a time and offers the rest, while
    // lastFolderHits keeps every hit so select-all, the row actions and the exports are unaffected.
    const rowKey = [folderNode === bookmarkData ? 'root' : (folderNode.guid || displayFolderTitle(folderNode) || ''), query, recursive ? 'r' : '', everywhere ? 'e' : '', librarySort.key, librarySort.dir].join('\u0000');
    if (rowKey !== resultRowKey) { resultRowKey = rowKey; resultRowLimit = RESULT_ROW_PAGE; }
    if (libraryRevealPending && highlightBookmark) {
        // The bookmark being revealed has to be on screen, however far down the sort it sits.
        const at = shown.findIndex(hit => hit.node === highlightBookmark);
        if (at >= resultRowLimit) resultRowLimit = at + 1;
    }
    const pageLimit = Math.max(Math.min(resultRowLimit, shown.length), 0);
    const page = shown.slice(0, pageLimit);
    updateSearchActionButtons();
    const scopeCount = everywhere
        ? subtreeStat('treeCount', bookmarkData, () => countTree(bookmarkData).links)
        : query && recursive
        ? countFolderDescendants(folderNode)
        : (folderNode.children || []).length;
    // For the badge on the selected tree row: the rows this listing drew, the rows it has to draw,
    // and how to name that scope. After scopeCount, like everything else that reads it.
    lastListingShown = page.length;
    lastListingToLoad = hits.length;
    lastListingScope = everywhere ? 'everywhere' : (recursive ? 'in this folder and subfolders' : 'in this folder');
    lastListingFiltered = Boolean(query);
    const titleEl = document.getElementById('folder-title');
    const subsEl = document.getElementById('folder-subreddits');
    const view = subredditFolderView(displayFolderTitle(folderNode, 'Your bookmarks'));
    if (titleEl) {
        titleEl.textContent = view.label;
        titleEl.classList.remove('subreddit-folder-title');
        bindNodeHoverTip(titleEl, folderNode);
        paintFolderSubredditToggle(Boolean(view.spec));
    }
    updateFolderEmptyButton(folderNode);
    if (subsEl) {
        const counts = view.spec ? countSubredditLinksInFolder(folderNode, view.spec.subs) : null;
        subsEl.innerHTML = view.spec
            ? view.spec.subs.map(sub => {
                const count = formatCount(counts.get(sub.toLowerCase()) || 0);
                return `<a class="subreddit-btn" href="https://www.reddit.com/r/${encodeURIComponent(sub)}" target="_blank" rel="noopener noreferrer">${escapeHtml(`/r/${sub} - ${count}`)}</a>`;
            }).join('')
            : '';
    }
    renderFolderParent(folderNode);
    updateOtherCollectButton(folderNode);
    updateLibrarySortHeaders();
    applyColumnWidths(folderNode);
    bindColumnResize();
    const metaEl = document.getElementById('folder-meta');
    if (metaEl) {
        metaEl.innerHTML = folderMetaInnerHtml(folderNode, { query, hitCount: hits.length, shownCount: page.length, scopeCount, recursive, everywhere, exhaustive });
        // It is rewritten on every render, so its button needs wiring each time.
        if (typeof wireDataCallScope === 'function') wireDataCallScope(metaEl);
    }

    // The order of the whole result list, for shift-click ranges. Built when a range is actually
    // asked for: doing it per render would allocate one entry per hit on every keystroke.
    const renderedOrder = () => sortLibraryHits(lastFolderHits).map(hit => hit.node);
    let rowFailures = 0;
    page.forEach(hit => {
      try {
        const child = hit.node;
        const parent = hit.parent || folderNode;
        const tr = document.createElement('tr');
        tr._libraryNode = child;
        if (child._modified) tr.classList.add('changed');
        tr.setAttribute('aria-selected', librarySelection.includes(child) ? 'true' : 'false');
        if (librarySelection.includes(child) || child === highlightBookmark) tr.classList.add('selected');
        if (child === highlightBookmark) tr.classList.add('library-highlight');

        const isFolder = isBookmarkFolderNode(child);
        const icon = isFolder ? '📁' : '🔖';
        const uri = nodeUri(child);
        const name = libraryNodeName(child);
        const pathHtml = hit.relPath?.length
            ? `<div class="row-path">${escapeHtml(hit.relPath.join(' / '))}</div>`
            : '';
        const location = uri
            ? `<a href="${escapeHtml(uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(uri)}</a>`
            : '';

        tr.innerHTML = `
            <td>${icon} ${name === 'Untitled' && !isFolder ? '<em>Untitled</em>' : escapeHtml(name)}${isFolder ? emptyFolderBadgeHtml(child) : ''}${pathHtml}${!isFolder && child.description ? `<div class="row-note" title="${escapeHtml(child.description)}">${escapeHtml(child.description)}</div>` : ''}</td>
            <td>${location}</td>
            <td class="row-date">${escapeHtml(libraryAddedLabel(child))}</td>
            <td>${escapeHtml(child.tags || '')}</td>
        `;

        tr.oncontextmenu = (e) => {
            const link = e.target.closest && e.target.closest('a');
            if (link && link.closest('td') === tr.children[1]) {
                e.preventDefault();
                e.stopPropagation();
                showLocationContextMenu(e, uri);
                return;
            }
            e.preventDefault();
            if (!librarySelection.includes(child)) selectLibraryNodes([child], child);
            showContextMenu(e, parent, child, parent.children.indexOf(child));
        };

        tr.onclick = (event) => {
            if (event.target.closest('a')) return;
            if (event.shiftKey && libraryAnchor) {
                const order = renderedOrder();
                const start = order.indexOf(libraryAnchor);
                const end = order.indexOf(child);
                if (start >= 0 && end >= 0) {
                    const [from, to] = start < end ? [start, end] : [end, start];
                    selectLibraryNodes(order.slice(from, to + 1), child);
                    return;
                }
            }
            if (event.metaKey || event.ctrlKey) {
                const next = librarySelection.includes(child)
                    ? librarySelection.filter(node => node !== child)
                    : librarySelection.concat(child);
                selectLibraryNodes(next, child);
                return;
            }
            selectLibraryNodes([child], child);
        };
        tr.onauxclick = (event) => {
            if (event.button !== 1 || !uri || event.target.closest('a')) return;
            event.preventDefault();
            window.open(uri, '_blank', 'noopener');
        };
        tr.draggable = true;
        tr.ondragstart = (event) => {
            if (!librarySelection.includes(child)) selectLibraryNodes([child], child);
            libraryDragNodes = librarySelection.slice();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', 'bookmarks');
        };
        tr.ondragend = () => {
            libraryDragNodes = [];
            clearLibraryDropMarks();
        };
        applyNoteToNode(child);
        bindLibraryDropTarget(tr, child);
        if (isFolder) {
            bindNodeHoverTip(tr, child, tr.querySelector('td'));
            tr.ondblclick = () => openFolder(child);
        } else if (uri) {
            bindNodeHoverTip(tr, child);
            tr.ondblclick = () => window.open(uri, '_blank', 'noopener');
        }
        tbody.appendChild(tr);
      } catch (err) {
        // A single unrenderable result (a stale hit, a malformed node) degrades to a warning
        // instead of blanking the page.
        rowFailures += 1;
        console.error('Could not render a search result row', err, hit && hit.node);
      }
    });
    if (rowFailures) {
        showToast(`${formatCount(rowFailures)} result row(s) could not be drawn; see the console. The rest of the list is shown.`, { kind: 'warn' });
        logAffected('SYSTEM', 'Bookmarks list', `${formatCount(rowFailures)} result row(s) failed to render while searching. The remaining ${formatCount(shown.length - rowFailures)} row(s) rendered normally.`, { source: 'Bookmarks list', kind: 'error' });
    }
    // The rest of the hits are one click away, and the whole set is one more: the row count only
    // grows when the reader asks it to.
    if (shown.length > page.length) {
        const tr = document.createElement('tr');
        tr.className = 'result-more-row';
        tr.innerHTML = `<td colspan="4"><span class="result-more-actions">`
            + `<button type="button" class="result-more" data-call="showMoreResultRows" title="Draw the next ${formatCount(RESULT_ROW_PAGE)} rows">Show ${formatCount(Math.min(RESULT_ROW_PAGE, shown.length - page.length))} more of ${formatCount(shown.length)}</button>`
            + `<button type="button" class="result-more is-all" data-call="showAllResultRows" title="Draw every remaining row at once (${formatCount(shown.length - page.length)} more) — slower on a big result list">Show all ${formatCount(shown.length)}</button>`
            + `</span></td>`;
        tbody.appendChild(tr);
        if (typeof wireDataCallScope === 'function') wireDataCallScope(tr);
    }
    paintFolderShownBadge();
    const highlighted = libraryRevealPending ? tbody.querySelector('tr.library-highlight') : null;
    if (highlighted) {
        libraryRevealPending = false;
        highlighted.scrollIntoView({ block: 'center' });
        highlighted.classList.add('library-reveal');
    }
}

// Draw the next page of results. The search itself is not re-run — the rows are already in
// lastFolderHits, this only grows how much of it the table draws.
function showMoreResultRows() {
    resultRowLimit += RESULT_ROW_PAGE;
    if (currentFolder) renderFolderContents(currentFolder);
}

// Draw every remaining hit at once, for a reader who wants the whole list rather than pages: the
// limit goes past the end, so Math.min(limit, shown.length) draws all of it.
function showAllResultRows() {
    resultRowLimit = Number.MAX_SAFE_INTEGER;
    if (currentFolder) renderFolderContents(currentFolder);
}

// The hint's button: widen the scope to the whole library and search again.
function searchEverywhereFromHint() {    const everywhere = document.getElementById('bookmark-search-everywhere');
    if (everywhere) everywhere.checked = true;
    filterFolderContents();
    const input = document.getElementById('bookmark-search');
    if (input) input.focus();
}

function filterFolderContents() {
    updateSearchClearButton();
    if (currentFolder) renderFolderContents(currentFolder);
    // Keep the Filters panel in step with the box as it is typed, so the boxes fill themselves
    // for anything that can be read back out of the query.
    if (typeof searchSyntaxEnabled === 'function' && searchSyntaxEnabled()) {
        try {
            syncSearchOperatorForm();
        } catch (err) {
            console.error(err);
        }
    }
}

function switchLibraryTool(tab) {
    const which = tab === 'actions' ? 'actions' : 'search';
    document.querySelectorAll('[data-library-tool]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-library-tool') === which);
    });
    const search = document.getElementById('library-tool-search');
    const actions = document.getElementById('library-tool-actions');
    if (search) search.hidden = which !== 'search';
    if (actions) actions.hidden = which !== 'actions';
    updateSearchActionButtons();
}

function updateSearchActionButtons() {
    const query = (document.getElementById('bookmark-search')?.value || '').trim();
    // The URL count is one nodeUri() per hit, which on a 100,000-hit list is real work on every
    // render — and it only feeds the title of buttons inside the Actions tool. Skip it while that
    // tool is closed; `ready` and the disabled state need no scan.
    const actionsVisible = !document.getElementById('library-tool-actions')?.hidden;
    const n = actionsVisible ? lastFolderHits.filter(hit => hit.node && nodeUri(hit.node)).length : 0;
    const ready = Boolean(query && lastFolderHits.length);
    ['search-send-obsidian', 'search-send-obsidian-delete', 'search-move-into-folder'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = !ready;
        if (!actionsVisible) return;
        btn.title = query
            ? (n ? `${lastFolderHits.length} result(s), ${n} bookmark(s) with URLs` : 'No URL bookmarks in these results')
            : 'Search this folder first';
    });
}

function searchHitsMarkdown(hits, query, withHeading) {
    const lines = [];
    if (withHeading) lines.push(`- Search results · ${mdSafe(query)}`);
    const depth = withHeading ? 1 : 0;
    hits.forEach(hit => {
        const node = hit.node;
        if (!node) return;
        if (isBookmarkFolderNode(node)) {
            lines.push(mdFolderLine(node, depth, '    '));
            return;
        }
        if (!nodeUri(node)) return;
        lines.push(mdLinkLine(node, depth, '    '));
    });
    return lines.join('\n');
}

function sendLibraryBookmarksToObsidian(mode, dailyNote) {
    if (!rightClickedItem?.item) return;
    const clicked = rightClickedItem.item;
    const selected = librarySelection.includes(clicked) ? librarySelection : [clicked];
    const links = selected.filter(node => node && nodeUri(node));
    if (!links.length) return alert('That item has no link to send.');
    const remove = mode === 'delete';
    const label = links.length === 1
        ? `“${libraryNodeName(links[0])}”`
        : `${formatCount(links.length)} bookmarks`;
    const msg = remove
        ? `Send ${label} to Obsidian and delete ${formatCount(links.length)} bookmark(s)?`
        : `Send ${label} to Obsidian? Bookmarks stay in the library.`;
    if (!confirm(msg)) return;
    sendMarkdownByDestination(links.map(node => mdLinkLine(node, 0)).join('\n'), () => {
        if (!remove) return;
        const removed = withUndo('Send bookmark to Obsidian and delete', api => {
            links.forEach(node => {
                const parent = findNodeParent(node);
                if (!parent) return;
                api.remove(node, parent);
                logAffected('REMOVED', libraryNodeName(node), 'Sent bookmark to Obsidian and deleted.', {
                    source: 'Bookmarks context menu',
                    node,
                    uri: nodeUri(node)
                });
            });
        });
        librarySelection = librarySelection.filter(node => !links.includes(node));
        if (links.includes(libraryAnchor)) libraryAnchor = librarySelection[0] || null;
        markChanged();
        renderSidebar();
        if (currentFolder) renderFolderContents(currentFolder);
        if (removed && typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') maybeRefreshDuplicateBookmarksAfterDelete(links);
    }, dailyNote, dailyNote);
}

function obsidianDestination() {
    // The select is the source of truth while the page is open; the saved setting is the fallback.
    const el = document.getElementById('setting-obsidian-destination');
    const raw = String((el && el.value) || readEditorSettings().obsidianDestination || 'cursor').toLowerCase();
    return raw === 'daily' || raw === 'both' ? raw : 'cursor';
}

// The single route every send takes. An explicit menu choice (true/false) wins; otherwise the setting
// decides. "both" only affects which items the condensed menu shows.
function sendMarkdownByDestination(markdown, after, dailyNote) {
    if (dailyNote === true) return sendMarkdownToObsidian(markdown, after, true);
    if (dailyNote === false) return sendMarkdownToObsidian(markdown, after, false);
    const destination = obsidianDestination();
    // "both" is a menu choice, not a double send: it leaves both items in the menu and each send
    // goes to exactly one destination.
    if (destination === 'daily') return sendMarkdownToObsidian(markdown, after, true);
    return sendMarkdownToObsidian(markdown, after, false);
}

function sendMarkdownToObsidian(markdown, after, dailyNote = false) {
    return openObsidianAppend(markdown, dailyNote).then(after).catch(err => {
        alert(err && err.message ? err.message : String(err));
    });
}

function sendFolderSearchToObsidian(mode, dailyNote) {
    const query = (document.getElementById('bookmark-search')?.value || '').trim();
    const hits = lastFolderHits.slice();
    if (!query) return alert('Search this folder first.');
    if (!hits.length) return alert('No search results to send.');
    const links = hits.filter(hit => hit.node && hit.parent && nodeUri(hit.node));
    const remove = mode === 'delete';
    const msg = remove
        ? `Send ${formatCount(hits.length)} search result(s) to Obsidian and delete ${formatCount(links.length)} bookmark(s)? Matching folders are not deleted.`
        : `Send ${formatCount(hits.length)} search result(s) to Obsidian? Bookmarks stay in the library.`;
    if (!confirm(msg)) return;
    sendMarkdownByDestination(searchHitsMarkdown(hits, query, true), () => {
        if (!remove || !links.length) return;
        const removed = withUndo('Send search results to Obsidian and delete', api => {
            links.forEach(hit => {
                api.remove(hit.node, hit.parent);
                logAffected('REMOVED', hit.node.title || nodeUri(hit.node), 'Sent search results to Obsidian and deleted.', {
                    source: 'Folder search',
                    node: hit.node,
                    uri: nodeUri(hit.node)
                });
            });
        });
        markChanged();
        renderSidebar();
        if (currentFolder) renderFolderContents(currentFolder);
        if (removed && typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') {
            maybeRefreshDuplicateBookmarksAfterDelete(links.map(hit => hit.node));
        }
    }, dailyNote);
}

function searchMoveFolderDefaultName(query) {
    const cleaned = String(query || '')
        .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.slice(0, 120) || 'Search results';
}

function searchHitsToMove(hits) {
    return (hits || []).filter(hit => hit.node && hit.parent && nodeUri(hit.node));
}

function openMoveSearchFolderDialog() {
    const query = (document.getElementById('bookmark-search')?.value || '').trim();
    const hits = lastFolderHits.slice();
    if (!query) return alert('Search this folder first.');
    if (!hits.length) return alert('No search results to move.');
    const links = searchHitsToMove(hits);
    if (!links.length) return alert('No URL bookmarks in these results.');
    const parent = currentFolder;
    if (!parent || !isBookmarkFolderNode(parent)) return alert('Open a folder first.');
    const dialog = document.getElementById('move-search-folder-dialog');
    const input = document.getElementById('move-search-folder-name');
    if (!dialog || !input) return;
    pendingSearchMove = { parent, links, query };
    input.value = searchMoveFolderDefaultName(query);
    dialog.hidden = false;
    input.focus();
    input.select();
}

function closeMoveSearchFolderDialog() {
    const dialog = document.getElementById('move-search-folder-dialog');
    if (dialog) dialog.hidden = true;
    pendingSearchMove = null;
}

function submitMoveSearchFolderDialog(event) {
    if (event && event.preventDefault) event.preventDefault();
    const pending = pendingSearchMove;
    const input = document.getElementById('move-search-folder-name');
    const folderName = (input?.value || '').trim();
    if (!pending) return closeMoveSearchFolderDialog();
    if (!folderName) return alert('Folder name cannot be empty.');
    const { parent, links } = pending;
    closeMoveSearchFolderDialog();
    if (!parent || !isBookmarkFolderNode(parent)) return;
    const folder = {
        typeCode: 2,
        title: folderName,
        children: [],
        dateAdded: typeof liveCreateNode === 'function' ? Date.now() : Date.now() * 1000,
        _modified: true
    };
    withUndo('Move search bookmarks into a folder', api => {
        api.create(parent, folder);
        logAffected('ADDED', folderName, 'New folder created from search results.', {
            source: 'Folder search',
            node: folder,
            folderPath: folderPathFor(parent) || displayFolderTitle(parent)
        });
        links.forEach(hit => {
            const fromParent = hit.parent;
            if (!fromParent || fromParent === folder) return;
            if (!fromParent.children || fromParent.children.indexOf(hit.node) < 0) return;
            api.move(hit.node, fromParent, folder);
            logAffected('MODIFIED', hit.node.title || nodeUri(hit.node), `Moved into ${folderName}.`, {
                source: 'Folder search',
                node: hit.node,
                uri: nodeUri(hit.node),
                folderPath: folderPathFor(folder) || folderName
            });
        });
    });
    markChanged();
    renderSidebar();
    openFolder(folder);
}

function hidePopupMenus() {
    POPUP_MENU_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
}

// The library row menu is grouped, and which items are on it depends on what was right-clicked: a
// bookmark has Open and Copy, a folder has Export as HTML, a folder inside Other Bookmarks has no
// Move to Other Bookmarks, a multi-selection has no per-item stats. So the captions and the rules
// between them are tidied after every show: a caption whose group is empty goes, a rule needs a
// clickable item on both sides, and two rules never sit together. Without this a hidden group left
// its caption behind, and the menu showed a rule with nothing between it and the next one.
// What tidyContextMenu switched off last time. The menu element is reused for every right-click, so
// those flags have to be cleared before the next one decides what is on it — otherwise a caption
// hidden for one row (a folder has no Copy) stayed hidden for the next row that did have one.
let contextMenuTidyHidden = [];

function resetContextMenuTidy() {
    contextMenuTidyHidden.forEach(el => { el.hidden = false; });
    contextMenuTidyHidden = [];
}

function tidyContextMenu(menu) {
    if (!menu || !menu.children) return;
    const kids = [...menu.children];
    const isItem = el => el.classList && (el.classList.contains('context-menu-item') || el.classList.contains('context-menu-stats'));
    const isCaption = el => el.classList && el.classList.contains('menu-group');
    const isRule = el => el.classList && el.classList.contains('context-menu-separator');
    const shown = el => !el.hidden && el.style.display !== 'none';
    const hasItem = (from, to) => kids.slice(from, to).some(el => isItem(el) && shown(el));
    const hide = el => { el.hidden = true; contextMenuTidyHidden.push(el); };
    kids.forEach((el, i) => {
        if (isItem(el)) return;
        // Only ever add hiding: a rule or caption the menu's own logic switched off (the subreddit
        // rule goes with the subreddit item) must stay off, or tidying would put it back on screen.
        if (el.hidden) return;
        if (isCaption(el)) {
            // Up to the next caption or rule that is actually on screen — a hidden one (the
            // subreddit rule for a bookmark) marks nothing and must not cut the group short: that
            // made "Open and find" vanish from a bookmark's menu even though its items were there.
            let end = kids.length;
            for (let j = i + 1; j < kids.length; j++) {
                const next = kids[j];
                if (!shown(next)) continue;
                if (isCaption(next) || isRule(next)) { end = j; break; }
            }
            if (!hasItem(i + 1, end)) hide(el);
            return;
        }
        if (isRule(el) && !(hasItem(0, i) && hasItem(i + 1, kids.length))) hide(el);
    });
    let seenRule = false;
    kids.forEach(el => {
        if (!shown(el)) return;
        if (isCaption(el) || isItem(el)) { seenRule = false; return; }
        if (isRule(el)) {
            if (seenRule) hide(el);
            seenRule = true;
        }
    });
}

function emptyFolderBadgeHtml(folder) {
    if (!folder || folder === bookmarkData || !holdsOnlyEmptyFolders(folder)) return '';
    const tip = (folder.children || []).length ? 'This folder holds only empty folders' : 'This folder has no bookmarks or subfolders';
    return `<span class="menu-badge empty-badge" title="${tip}">Empty</span>`;
}

// What the results table is showing right now, set by every renderFolderContents: the rows it drew,
// the rows there are to load, and how to name that scope.
let lastListingShown = 0;
let lastListingToLoad = 0;
let lastListingScope = '';
let lastListingFiltered = false;

// The selected folder's row says how much of the listing is on screen against how much there is to
// load: "300 / 441" while a wide search is paged, "2 / 2" when everything the listing has is drawn.
// The second number is the entries this listing would draw — the hits, the same figure the pager's
// own "Show N more of M" uses — not every bookmark inside the folder's subfolders, which the listing
// was never going to draw. It is always on the row (an indicator nobody can find is no indicator).
// null means "nothing to say".
function folderShownBadgeParts(folder) {
    if (!folder || folder === bookmarkData || folder !== currentFolder) return null;
    const shown = lastListingShown;
    const toLoad = lastListingToLoad;
    const label = displayFolderTitle(folder, 'this folder');
    const notDrawn = Math.max(toLoad - shown, 0);
    const title = `Showing ${formatCount(shown)} of ${formatCount(toLoad)} row${toLoad === 1 ? '' : 's'} ${lastListingScope}`
        + `${lastListingFiltered ? ' — the search and the filters decide which rows those are' : ''}`
        + `${notDrawn ? `; Show more under the list draws ${formatCount(notDrawn)} more` : ''}.`;
    return { text: `${formatCount(shown)} / ${formatCount(toLoad)}`, title };
}

// A search re-draws the list, not the tree: the badge is repainted on the selected row alone. It is
// a sibling of the label, never inside it — `.tree-label` truncates with an ellipsis, which would
// clip the badge off a narrow sidebar exactly when the folder name is long enough to need it — and
// only ever one row carries it, so the row that was selected before loses it.
let lastShownBadgeRow = null;

function paintFolderShownBadge() {
    const entry = currentFolder ? folderTreeItems.get(currentFolder) : null;
    const row = entry ? entry.itemDiv : null;
    if (lastShownBadgeRow && lastShownBadgeRow !== row) {
        const stale = lastShownBadgeRow.querySelector('.tree-shown-badge');
        if (stale) stale.remove();
    }
    lastShownBadgeRow = row || null;
    if (!row) return;
    const parts = folderShownBadgeParts(currentFolder);
    const existing = row.querySelector('.tree-shown-badge');
    if (!parts) {
        if (existing) existing.remove();
        return;
    }
    const badge = existing || document.createElement('span');
    badge.className = 'menu-badge tree-shown-badge';
    badge.title = parts.title;
    badge.textContent = parts.text;
    if (!existing) row.appendChild(badge);
}

function folderMenuStats(folder) {
    return subtreeStat('menuStats', folder, () => {
        const stats = { links: 0, folders: 0, directLinks: 0, directFolders: 0, emptyFolders: 0 };
        (folder.children || []).forEach(child => {
            if (isBookmarkFolderNode(child)) stats.directFolders += 1;
            else if (nodeUri(child)) stats.directLinks += 1;
        });
        walkBookmarkTree(folder, node => {
            if (node === folder) return;
            if (isBookmarkFolderNode(node)) {
                stats.folders += 1;
                if (!(node.children || []).length) stats.emptyFolders += 1;
            } else if (nodeUri(node)) {
                stats.links += 1;
            }
        });
        return stats;
    });
}

function emptySubfoldersOf(folder) {
    const empty = [];
    walkBookmarkTree(folder, node => {
        if (node !== folder && isBookmarkFolderNode(node) && !(node.children || []).length) empty.push(node);
    });
    return empty;
}

// --- Information views: the folder head line, the menu panel, the hover tip ---
// The tree mixes seconds (Firefox dateAdded) and milliseconds, so read both.
function formatInfoDate(value) {
    if (!value) return '';
    const ms = typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(value);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function infoRowHtml(label, value, note) {
    return `<div class="menu-stat-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><span class="menu-stat-total">${escapeHtml(note || '')}</span></div>`;
}

// A path gets the whole right-hand side rather than the narrow number column.
// The hover tip names the folder an entry sits in, not its whole path from the root: the
// path row was long enough to cover the tip and repeated what the Location column already
// shows with room to read it.
// The folder a node lives in, as the whole trail rather than only its parent's name, with every hop
// named the way the tree names it: a subreddit folder is its short label, not its raw title with all
// the subreddits in it ("Programming", not "Programming - r/programming r/webdev").
function folderParentNameFor(node) {
    if (typeof findNodeParent !== 'function') return '';
    let parent = findNodeParent(node);
    if (!parent) return '';
    const hops = [];
    while (parent && parent !== bookmarkData) {
        hops.unshift(folderPickLabel(parent).label || displayFolderTitle(parent) || parent.title || '');
        parent = findNodeParent(parent);
    }
    // A root folder's parent is the library itself, which is not a place you navigate to.
    return hops.length ? hops.join(' / ') : 'Bookmarks';
}

function infoPathRowHtml(label, path) {
    if (!path) return '';
    return `<div class="menu-stat-row is-path"><span>${escapeHtml(label)}</span><b title="${escapeHtml(path)}">${escapeHtml(path)}</b></div>`;
}

function infoDateRowHtml(node, addedLabel = 'Added') {
    const added = formatInfoDate(node && node.dateAdded);
    const modified = formatInfoDate(node && (node.lastModified || node.dateGroupModified));
    if (added) return infoRowHtml(addedLabel, added, modified && modified !== added ? `modified ${modified}` : '');
    if (modified) return infoRowHtml('Modified', modified, '');
    return '';
}

// One bookmark's own facts: its domain, the folder it lives in, its dates, and the two
// things the menu can already act on (copies of the same URL, a search chain).
function linkInfoInnerHtml(node) {
    const uri = nodeUri(node);
    const title = String((node && node.title) || '').trim() || uri;
    let domain = '';
    try { domain = new URL(uri).hostname.replace(/^www\./, ''); } catch (err) { domain = ''; }
    let copies = 1;
    try { if (typeof duplicateCopiesOf === 'function') copies = duplicateCopiesOf(node) || 1; } catch (err) { copies = 1; }
    let chain = null;
    try { if (typeof searchChainForNode === 'function') chain = searchChainForNode(node); } catch (err) { chain = null; }
    return `<div class="menu-stat-head">${escapeHtml(title)}</div>
        ${infoPathRowHtml('Domain', domain)}
        ${infoPathRowHtml('In', folderParentNameFor(node))}
        ${infoDateRowHtml(node)}
        ${copies > 1 ? infoRowHtml('Same URL', `${formatCount(copies)} copies`, 'shown under Duplicates') : ''}
        ${chain ? infoRowHtml('Search chain', chain.query || 'yes', 'shown under Search chains') : ''}`;
}

function folderStatsInnerHtml(folder, withActions = false) {
    const s = folderMenuStats(folder);
    return `<div class="menu-stat-head">${escapeHtml(folderPickLabel(folder).label || displayFolderTitle(folder))}</div>
        ${infoRowHtml('Bookmarks', `${formatCount(s.directLinks)} here`, `${formatCount(s.links)} with subfolders`)}
        ${infoRowHtml('Folders', `${formatCount(s.directFolders)} here`, `${formatCount(s.folders)} with subfolders`)}
        ${s.emptyFolders ? `<div class="menu-stat-row${withActions ? ' has-action' : ''}"><span>Empty folders</span><b>${formatCount(s.emptyFolders)}</b>${withActions ? `<button type="button" class="menu-stat-action" data-delete-empty title="Delete the ${formatCount(s.emptyFolders)} empty subfolder(s); Undo restores them">Delete</button>` : '<span></span>'}</div>` : ''}
        ${infoPathRowHtml('In', folderParentNameFor(folder))}
        ${infoDateRowHtml(folder)}`;
}

// The line under the folder title: where the folder sits, what it holds (here vs with
// subfolders), which of its folders are empty, and when it was added or last changed.
function folderMetaInnerHtml(folder, options = {}) {
    const query = String(options.query || '');
    const plural = (count, word) => `<b>${formatCount(count)}</b> ${word}${Number(count) === 1 ? '' : 's'}`;
    // The table draws a page of a long result list; say so rather than look like it lost rows.
    const paged = Number(options.shownCount || 0) && Number(options.shownCount) < Number(options.hitCount || 0)
        ? ` <span class="meta-hint">showing the first ${formatCount(options.shownCount)}</span>`
        : '';
    // A slow search should say why it is slow.
    const mode = options.exhaustive ? ' <span class="meta-chip is-warn" title="Exhaustive search: every path and every derived set recomputed from the live tree, no cache or index used">exhaustive, uncached</span>' : '';
    if (options.everywhere) {
        const what = query
            ? `${formatCount(options.hitCount || 0)} of ${plural(options.scopeCount || 0, 'item')} matching “${escapeHtml(query)}”`
            : `${plural(options.hitCount || 0, 'item')}`;
        return `<span class="meta-chip is-lead">${what} <b>everywhere</b> — Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks and Mobile Bookmarks</span>${paged}${mode}`;
    }
    if (query) {
        const scope = options.recursive ? ' in this folder and subfolders' : ' in this folder';
        const chip = `<span class="meta-chip is-lead">${formatCount(options.hitCount || 0)} of ${plural(options.scopeCount || 0, 'item')} matching “${escapeHtml(query)}”${scope}</span>`;
        // Nothing here, but the library may well hold it: offer the wider scope rather than
        // leave an empty list looking like a broken filter.
        if (!Number(options.hitCount || 0)) {
            return `${chip} <span class="meta-hint">nothing in this scope — <button type="button" class="meta-hint-action" data-call="searchEverywhereFromHint" title="Search all four bookmark roots instead of just this folder">search everywhere</button></span>`;
        }
        return `${chip}${paged}${mode}`;
    }
    if (!folder) return '';
    const s = folderMenuStats(folder);
    const chips = [];
    chips.push(`<span class="meta-chip">${plural(s.directLinks, 'bookmark')} here</span>`);
    if (s.links !== s.directLinks) chips.push(`<span class="meta-chip">${plural(s.links, 'bookmark')} with subfolders</span>`);
    chips.push(`<span class="meta-chip">${plural(s.directFolders, 'folder')} here</span>`);
    if (s.folders !== s.directFolders) chips.push(`<span class="meta-chip">${plural(s.folders, 'folder')} with subfolders</span>`);
    if (s.emptyFolders) chips.push(`<span class="meta-chip is-warn">${plural(s.emptyFolders, 'empty folder')}</span>`);
    const added = formatInfoDate(folder.dateAdded);
    const modified = formatInfoDate(folder.lastModified || folder.dateGroupModified);
    if (added) chips.push(`<span class="meta-chip">added <b>${escapeHtml(added)}</b></span>`);
    if (modified && modified !== added) chips.push(`<span class="meta-chip">modified <b>${escapeHtml(modified)}</b></span>`);
    // folderPathFor already hides the library root when the settings say so, so an empty
    // path means either the root itself or a folder sitting directly under it.
    const path = folderPathFor(folder);
    const pathChip = path
        ? `<span class="meta-path" title="This folder sits in ${escapeHtml(path)}">in ${escapeHtml(path)}</span>`
        : (folder === bookmarkData
            ? '<span class="meta-path">the whole library</span>'
            : '<span class="meta-path">at the top level</span>');
    return `${pathChip}<span class="meta-chips">${chips.join('')}</span>`;
}

function setFolderMenuStats(panel, sep, folder) {
    if (!panel) return;
    // Fills in for a folder (what it holds) and for a bookmark (where it lives, its dates).
    const isFolder = Boolean(folder) && isBookmarkFolderNode(folder);
    const isLink = Boolean(folder) && !isFolder && Boolean(nodeUri(folder));
    const show = isFolder || isLink;
    panel.hidden = !show;
    if (sep) sep.hidden = !show;
    panel.classList.toggle('is-empty', isFolder && !(folder.children || []).length);
    if (!show) return;
    panel.innerHTML = isFolder ? folderStatsInnerHtml(folder, true) : linkInfoInnerHtml(folder);
    panel.onclick = event => {
        if (!event.target.closest('[data-delete-empty]')) return;
        hidePopupMenus();
        deleteLibraryNodes(emptySubfoldersOf(folder));
    };
}

function isInsideRedditLinks(folder) {
    for (let parent = findNodeParent(folder); parent; parent = findNodeParent(parent)) {
        if (displayFolderTitle(parent).trim().toLowerCase() === 'reddit links') return true;
    }
    return false;
}

function folderSubredditName(folder) {
    if (!folder || !isBookmarkFolderNode(folder) || !isInsideRedditLinks(folder)) return '';
    const name = displayFolderTitle(folder).trim().replace(/^\/?r\//i, '');
    if (!/^[A-Za-z0-9_]+$/.test(name)) return '';
    const key = name.toLowerCase();
    let found = false;
    walkBookmarkTree(folder, node => {
        if (!found && nodeUri(node) && redditSubredditFromUri(nodeUri(node)).toLowerCase() === key) found = true;
    });
    return found ? name : '';
}

function setOpenSubredditItem(item, sep, folder) {
    if (!item) return;
    const name = folder ? folderSubredditName(folder) : '';
    item.hidden = !name;
    if (sep) sep.hidden = !name;
    item.dataset.subreddit = name;
    if (name) item.textContent = `Open r/${name} on Reddit`;
}

function openFolderSubreddit(source) {
    const item = document.getElementById(source === 'tree' ? 'folder-tree-open-subreddit' : 'context-open-subreddit');
    const name = item?.dataset.subreddit;
    if (name) window.open(`https://www.reddit.com/r/${encodeURIComponent(name)}/`, '_blank', 'noopener');
}

function showFolderTreeMenu(event, folder) {
    rightClickedFolder = folder;
    hidePopupMenus();
    const menu = document.getElementById('folder-tree-menu');
    if (!menu) return;
    const extras = [
        ['folder-tree-move-mobile', folderMatchesSpecial(folder, 'mobile______')],
        ['folder-tree-move-toolbar-links', folderMatchesSpecial(folder, 'toolbar_____')]
    ];
    extras.forEach(([itemId, show]) => {
        const item = document.getElementById(itemId);
        if (item) item.hidden = !show;
    });
    if (!treeSelection.includes(folder)) setTreeSelection([]);
    const merge = document.getElementById('folder-tree-merge');
    const mergeSep = document.getElementById('folder-tree-merge-sep');
    const canMerge = treeSelection.length > 1 && folder !== bookmarkData;
    if (merge) {
        merge.hidden = !canMerge;
        merge.textContent = `Merge ${formatCount(treeSelection.length)} folders into “${displayFolderTitle(folder)}”`;
    }
    if (mergeSep) mergeSep.hidden = !canMerge;
    const canDelete = !isRootDirectFolder(folder);
    const del = document.getElementById('folder-tree-delete');
    const delSep = document.getElementById('folder-tree-delete-sep');
    if (del) del.hidden = !canDelete;
    setFolderMenuStats(document.getElementById('folder-tree-stats'), document.getElementById('folder-tree-stats-sep'), folder);
    setOpenSubredditItem(document.getElementById('folder-tree-open-subreddit'), document.getElementById('folder-tree-open-subreddit-sep'), folder);
    if (delSep) delSep.hidden = !canDelete;
    updateProtectLabels();
    placePopupMenu(menu, event.clientX, event.clientY);
}

function deleteTreeFolder() {
    const folder = rightClickedFolder;
    if (!folder || !isBookmarkFolderNode(folder)) return;
    if (isRootDirectFolder(folder)) return alert('Folders directly under the library root stay.');
    previewDeleteLibraryNodes([folder]);
}

function defaultNewFolderName(parent) {
    return nextNewFolderName((parent?.children || []).filter(isBookmarkFolderNode).map(node => node.title));
}

function addFolderInClickedFolder() {
    const parent = rightClickedFolder;
    if (!parent || !isBookmarkFolderNode(parent)) return;
    const folderName = prompt('New Folder Name:', defaultNewFolderName(parent));
    if (!folderName) return;
    if (!parent.children) parent.children = [];
    const folder = {
        typeCode: 2,
        title: folderName,
        children: [],
        dateAdded: typeof liveCreateNode === 'function' ? Date.now() : Date.now() * 1000,
        _modified: true
    };
    parent.children.push(folder);
    if (typeof liveCreateNode === 'function') liveCreateNode(parent, folder);
    markChanged();
    logAffected('ADDED', folderName, 'New directory created manually.', {
        source: 'Folder tree',
        node: folder,
        folderPath: folderPathFor(parent) || displayFolderTitle(parent)
    });
    refreshLibraryAfterStructureChange(parent);
}

function showLibraryBackgroundMenu(event) {
    if (!currentFolder || !isBookmarkFolderNode(currentFolder)) return;
    if (event.target.closest('tr, a, button, input, textarea, select, label, .page-head')) return;
    event.preventDefault();
    hidePopupMenus();
    const menu = document.getElementById('library-background-menu');
    if (!menu) return;
    placePopupMenu(menu, event.clientX, event.clientY);
}

function addChildInCurrentFolder(kind) {
    const parent = currentFolder;
    if (!parent || !isBookmarkFolderNode(parent)) return;
    if (!parent.children) parent.children = [];
    const dateAdded = typeof liveCreateNode === 'function' ? Date.now() : Date.now() * 1000;
    let node = null;
    if (kind === 'folder') {
        const folderName = prompt('New Folder Name:', defaultNewFolderName(parent));
        if (!folderName) return;
        node = { typeCode: 2, title: folderName, children: [], dateAdded, _modified: true };
    } else {
        const bmTitle = prompt('Bookmark Title:');
        if (!bmTitle) return;
        const bmUrl = prompt('Bookmark URL:', 'https://');
        node = { typeCode: 1, title: bmTitle, uri: bmUrl, dateAdded, _modified: true };
    }
    parent.children.push(node);
    if (typeof liveCreateNode === 'function') liveCreateNode(parent, node);
    markChanged();
    logAffected('ADDED', node.title, kind === 'folder' ? 'New directory created manually.' : 'New bookmark created manually.', {
        source: 'Bookmarks list',
        node,
        uri: node.uri,
        dateAdded: node.dateAdded,
        folderPath: folderPathFor(parent) || displayFolderTitle(parent)
    });
    if (kind === 'folder') refreshLibraryAfterStructureChange(parent);
}

function moveMobileBookmarksToOther() {
    const mobile = rightClickedFolder;
    if (!folderMatchesSpecial(mobile, 'mobile______')) return;
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('Could not find Other Bookmarks.');
    if (other === mobile) return alert('Mobile Bookmarks and Other Bookmarks are the same folder.');
    if (isNodeInSubtree(mobile, other)) return alert('Other Bookmarks is inside Mobile Bookmarks, so items were not moved.');
    const kids = (mobile.children || []).slice();
    if (!kids.length) return alert('Mobile Bookmarks is empty.');
    if (!confirm(`Move ${formatCount(kids.length)} item(s) from Mobile Bookmarks into Other Bookmarks? The Mobile Bookmarks folder stays.`)) return;
    withUndo('Move Mobile Bookmarks into Other Bookmarks', api => {
        kids.forEach(child => {
            api.move(child, mobile, other);
            logAffected('MODIFIED', child.title || displayFolderTitle(child), 'Moved from Mobile Bookmarks into Other Bookmarks.', {
                source: 'Folder tree',
                node: child,
                uri: nodeUri(child),
                folderPath: displayFolderTitle(other)
            });
        });
    });
    markChanged();
    renderSidebar();
    if (currentFolder === mobile || isNodeInSubtree(mobile, currentFolder)) currentFolder = other;
    if (currentFolder) renderFolderContents(currentFolder);
}

function moveToolbarLinksToOther() {
    const toolbar = rightClickedFolder;
    if (!folderMatchesSpecial(toolbar, 'toolbar_____')) return;
    const other = findSpecialFolder('unfiled_____');
    if (!other) return alert('Could not find Other Bookmarks.');
    if (other === toolbar) return alert('Bookmarks Toolbar and Other Bookmarks are the same folder.');
    if (isNodeInSubtree(toolbar, other)) return alert('Other Bookmarks is inside Bookmarks Toolbar, so links were not moved.');
    const links = (toolbar.children || []).filter(child => !isBookmarkFolderNode(child) && nodeUri(child));
    if (!links.length) return alert('There are no links sitting on Bookmarks Toolbar. Folders on the toolbar stay.');
    if (!confirm(`Move ${formatCount(links.length)} link(s) from Bookmarks Toolbar into Other Bookmarks? Folders on the toolbar stay.`)) return;
    withUndo('Move Bookmarks Toolbar links into Other Bookmarks', api => {
        links.forEach(child => {
            api.move(child, toolbar, other);
            logAffected('MODIFIED', child.title || nodeUri(child), 'Moved from Bookmarks Toolbar into Other Bookmarks.', {
                source: 'Folder tree',
                node: child,
                uri: nodeUri(child),
                folderPath: displayFolderTitle(other)
            });
        });
    });
    markChanged();
    renderSidebar();
    if (currentFolder) renderFolderContents(currentFolder);
}

let autoMoveTimer = null;

function logAutoMoveSummary(toolbarCount, mobileCount, hours, extra = {}) {
    const n = typeof formatCount === 'function' ? formatCount : String;
    const kindLabel = extra.manual ? 'Move into Other Bookmarks' : 'Auto-move into Other Bookmarks';
    const source = extra.manual ? 'Other Bookmarks' : 'Auto-move';
    logAffected('SYSTEM', kindLabel, `Moved ${n(toolbarCount)} Bookmarks Toolbar link(s) and ${n(mobileCount)} Mobile Bookmarks item(s) into Other Bookmarks. Folders on the toolbar stay. The Mobile Bookmarks folder stays. Next pass is in ${n(hours)} hour(s).`, {
        source,
        kind: 'auto-move'
    });
}

function collectAutoMovePlan(options = {}) {
    const settings = typeof autoMoveSettingsFrom === 'function' ? autoMoveSettingsFrom(readEditorSettings()) : readEditorSettings();
    const wantToolbar = options.manual ? true : settings.autoMoveToolbarLinks;
    const wantMobile = options.manual ? true : settings.autoMoveMobile;
    const other = findSpecialFolder('unfiled_____');
    const toolbar = findSpecialFolder('toolbar_____');
    const mobile = findSpecialFolder('mobile______');
    const links = [];
    const kids = [];
    if (wantToolbar && toolbar && other && other !== toolbar && !isNodeInSubtree(toolbar, other)) {
        (toolbar.children || []).forEach(child => {
            if (!isBookmarkFolderNode(child) && nodeUri(child)) links.push(child);
        });
    }
    if (wantMobile && mobile && other && other !== mobile && !isNodeInSubtree(mobile, other)) {
        (mobile.children || []).forEach(child => kids.push(child));
    }
    return { settings, other, toolbar, mobile, links, kids };
}

function updateOtherCollectButton(folderNode) {
    const status = document.getElementById('status-collect-moves');
    const row = document.getElementById('folder-collect-row');
    const loaded = Boolean(bookmarkData);
    const onOther = Boolean(folderNode && folderMatchesSpecial(folderNode, 'unfiled_____'));
    const plan = loaded ? collectAutoMovePlan({ manual: true }) : { links: [], kids: [] };
    const n = typeof formatCount === 'function' ? formatCount : String;
    const waiting = plan.links.length + plan.kids.length;
    const statusLabel = waiting
        ? `Move ${n(waiting)} bookmark${waiting === 1 ? '' : 's'} here`
        : 'Move bookmarks here';
    if (row) row.hidden = !onOther;
    if (status) {
        status.textContent = statusLabel;
        status.disabled = !onOther || !waiting;
        status.classList.toggle('has-moves', onOther && waiting > 0);
        status.removeAttribute('title');
    }
    const tip = document.getElementById('status-collect-tip');
    if (tip) {
        tip.replaceChildren();
        const addRow = (label, count) => {
            const line = document.createElement('div');
            line.className = 'status-collect-tip-row';
            const name = document.createElement('span');
            name.textContent = label;
            const val = document.createElement('strong');
            val.textContent = n(count);
            line.append(name, val);
            tip.appendChild(line);
        };
        addRow('Bookmarks Toolbar', plan.links.length);
        addRow('Mobile Bookmarks', plan.kids.length);
    }
}

function applyAutoMoveToOther(options = {}) {
    if (!bookmarkData) return { toolbar: 0, mobile: 0 };
    const plan = collectAutoMovePlan(options);
    if (!plan.other || (!plan.links.length && !plan.kids.length)) {
        if (!options.manual) saveEditorSettings({ autoMoveLastAt: Date.now() });
        return { toolbar: 0, mobile: 0 };
    }
    const { settings, other, toolbar, mobile, links, kids } = plan;
    const undoLabel = options.manual ? 'Move toolbar and Mobile into Other Bookmarks' : 'Auto-move into Other Bookmarks';
    const source = options.manual ? 'Other Bookmarks' : 'Auto-move';
    withUndo(undoLabel, api => {
        links.forEach(child => {
            api.move(child, toolbar, other);
            logAffected('MODIFIED', child.title || nodeUri(child), 'Moved from Bookmarks Toolbar into Other Bookmarks.', {
                source,
                node: child,
                uri: nodeUri(child),
                folderPath: displayFolderTitle(other)
            });
        });
        kids.forEach(child => {
            api.move(child, mobile, other);
            logAffected('MODIFIED', child.title || displayFolderTitle(child), 'Moved from Mobile Bookmarks into Other Bookmarks.', {
                source,
                node: child,
                uri: nodeUri(child),
                folderPath: displayFolderTitle(other)
            });
        });
    });
    markChanged();
    renderSidebar();
    if (mobile && (currentFolder === mobile || isNodeInSubtree(mobile, currentFolder))) currentFolder = other;
    if (options.manual && other) {
        if (typeof switchTabById === 'function') switchTabById('bookmarks-view');
        openFolder(other);
    } else if (currentFolder) renderFolderContents(currentFolder);
    logAutoMoveSummary(links.length, kids.length, settings.autoMoveHours, options);
    saveEditorSettings({ autoMoveLastAt: Date.now() });
    return { toolbar: links.length, mobile: kids.length };
}

function runManualMoveToOther() {
    if (!bookmarkData) return alert('Library is not loaded.');
    if (!folderMatchesSpecial(currentFolder, 'unfiled_____')) return;
    const plan = collectAutoMovePlan({ manual: true });
    if (!plan.other) return alert('Could not find Other Bookmarks.');
    if (!plan.links.length && !plan.kids.length) {
        return alert('Nothing to move. Direct links on Bookmarks Toolbar and items in Mobile Bookmarks would come here. Folders on the toolbar stay.');
    }
    const n = typeof formatCount === 'function' ? formatCount : String;
    if (!confirm(`Move ${n(plan.links.length)} Bookmarks Toolbar link(s) and ${n(plan.kids.length)} Mobile Bookmarks item(s) into Other Bookmarks? Folders on the toolbar stay. The Mobile Bookmarks folder stays.`)) return;
    applyAutoMoveToOther({ manual: true });
}

function syncCaptureSettingsToBackground(settings) {
    if (typeof isLiveBookmarks !== 'function' || !isLiveBookmarks()) return;
    const native = getBrowserExt();
    if (!native || !native.storage || !native.storage.local || typeof native.storage.local.set !== 'function') return;
    const payload = typeof capturePrefsFrom === 'function' ? capturePrefsFrom(settings) : settings;
    const ret = native.storage.local.set({ [CAPTURE_STORAGE_KEY]: payload });
    if (ret && typeof ret.catch === 'function') ret.catch(() => {});
}

function syncAutoMoveSettingsToBackground(settings) {
    if (typeof isLiveBookmarks !== 'function' || !isLiveBookmarks()) return;
    const native = getBrowserExt();
    if (!native) return;
    const payload = typeof autoMoveSettingsFrom === 'function' ? autoMoveSettingsFrom(settings) : settings;
    if (native.storage && native.storage.local && typeof native.storage.local.set === 'function') {
        const ret = native.storage.local.set({ [AUTO_MOVE_STORAGE_KEY]: payload });
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    }
    if (native.runtime && typeof native.runtime.sendMessage === 'function') {
        try {
            const sent = native.runtime.sendMessage({ type: 'auto-move-settings', editorAutoMove: payload });
            if (sent && typeof sent.catch === 'function') sent.catch(() => {});
        } catch (e) {}
    }
}

function scheduleAutoMoveFromSettings(settings) {
    const next = typeof autoMoveSettingsFrom === 'function' ? autoMoveSettingsFrom(settings || readEditorSettings()) : (settings || readEditorSettings());
    if (autoMoveTimer) {
        clearTimeout(autoMoveTimer);
        autoMoveTimer = null;
    }
    if (typeof isLiveBookmarks === 'function' && isLiveBookmarks()) {
        syncAutoMoveSettingsToBackground(next);
        return;
    }
    if (!autoMoveEnabled(next)) return;
    const interval = next.autoMoveHours * 60 * 60 * 1000;
    let last = Number(next.autoMoveLastAt) || 0;
    if (!last) {
        last = Date.now();
        saveEditorSettings({ autoMoveLastAt: last });
    }
    const wait = Math.max(1000, last + interval - Date.now());
    autoMoveTimer = setTimeout(() => {
        applyAutoMoveToOther();
        scheduleAutoMoveFromSettings();
    }, wait);
}

function moveLinksUnderneathFolder(folder) {
    if (!folder || !isBookmarkFolderNode(folder)) return;
    const children = folder.children || [];
    let lastFolder = -1;
    for (let i = 0; i < children.length; i++) {
        if (isBookmarkFolderNode(children[i])) lastFolder = i;
    }
    const links = [];
    for (let i = 0; i < lastFolder; i++) {
        const child = children[i];
        if (!isBookmarkFolderNode(child) && nodeUri(child)) links.push(child);
    }
    const name = displayFolderTitle(folder);
    if (!links.length) return alert(`No links need to move in “${name}”. Links in this folder already sit underneath the folders.`);
    if (!confirm(`Move ${formatCount(links.length)} link(s) in “${name}” underneath the folders in this folder? Links inside those folders stay put.`)) return;
    withUndo('Move links underneath folders', api => {
        links.forEach(node => {
            api.move(node, folder, folder, folder.children.length);
            logAffected('MODIFIED', node.title || nodeUri(node), `Moved underneath the folders in “${name}”.`, {
                source: 'Folder menu',
                node,
                uri: nodeUri(node),
                folderPath: displayFolderTitle(folder)
            });
        });
    });
    markChanged();
    renderSidebar();
    openFolder(folder);
}

function moveLinksUnderneathFolders() {
    moveLinksUnderneathFolder(rightClickedFolder);
}

function selectedFolderMarkdown(folder, hits) {
    const lines = [mdFolderLine(folder, 0)];
    hits.forEach(hit => {
        const node = hit.node;
        if (!node) return;
        const depth = (hit.relPath || []).length + 1;
        if (isBookmarkFolderNode(node)) {
            lines.push(mdFolderLine(node, depth));
            return;
        }
        if (!nodeUri(node)) return;
        lines.push(mdLinkLine(node, depth));
    });
    return lines.join('\n');
}

function findNodeParent(target, root = bookmarkData) {
    if (!target || !root?.children) return null;
    if (root.children.includes(target)) return root;
    for (const child of root.children) {
        const found = findNodeParent(target, child);
        if (found) return found;
    }
    return null;
}

function isNodeInSubtree(root, node) {
    if (!root || !node) return false;
    if (root === node) return true;
    return (root.children || []).some(child => isNodeInSubtree(child, node));
}

function sendFolderToObsidian(folder, mode, source, dailyNote) {
    if (!folder) return;
    if (folder === bookmarkData) return alert('Cannot send-and-delete the library root.');
    const hits = collectAllFolderHits(folder);
    const remove = mode === 'delete';
    if (!hits.length && !remove) return alert('This folder has no items to send.');
    const name = displayFolderTitle(folder);
    const parent = remove ? findNodeParent(folder) : null;
    if (remove && !parent) return alert('Could not find this folder’s parent, so it was not deleted.');
    const msg = remove
        ? `Send folder “${name}” to Obsidian and delete that folder and everything in it?`
        : `Send folder “${name}” to Obsidian? Bookmarks stay in the library.`;
    if (!confirm(msg)) return;
    sendMarkdownByDestination(selectedFolderMarkdown(folder, hits), () => {
        if (!remove) return;
        const removed = withUndo('Send folder to Obsidian and delete', api => {
            api.remove(folder, parent);
            logAffected('REMOVED', name, 'Sent folder to Obsidian and deleted.', {
                source: source || 'Folder tree',
                node: folder
            });
        });
        markChanged();
        renderSidebar();
        if (isNodeInSubtree(folder, currentFolder)) currentFolder = parent;
        if (currentFolder) renderFolderContents(currentFolder);
        if (removed && typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') maybeRefreshDuplicateBookmarksAfterDelete(folder);
    }, dailyNote, dailyNote);
}

function sendSidebarFolderToObsidian(mode, dailyNote) {
    sendFolderToObsidian(rightClickedFolder, mode, 'Folder tree', dailyNote);
}

// The folder tree menu calls these by name, so each destination gets its own entry point.
function sendSidebarFolderToObsidianDaily() {
    sendSidebarFolderToObsidian('keep', true);
}

function sendSidebarFolderToObsidianDailyDelete() {
    sendSidebarFolderToObsidian('delete', true);
}

function sendLibraryFolderToObsidian(mode, dailyNote) {
    const folder = rightClickedItem?.item;
    if (!isBookmarkFolderNode(folder)) return;
    sendFolderToObsidian(folder, mode, 'Bookmarks context menu', dailyNote);
}

function showLocationContextMenu(event, uri) {
    locationContextUri = uri || '';
    hidePopupMenus();
    const item = document.getElementById('location-find-domain');
    const sub = redditSubredditFromUri(uri);
    if (item) item.textContent = sub ? `Find r/${sub} in service preview` : 'Find in By domain';
    placePopupMenu(document.getElementById('location-context-menu'), event.clientX, event.clientY);
}

function findLocationInDomainStats() {
    findUriInDomainStats(locationContextUri);
}

function findUriInDomainStats(uri) {
    if (!bookmarkData) return alert('Load a library first.');
    let host = '';
    try { host = new URL(uri).hostname; } catch (e) { host = ''; }
    if (!host || typeof parentDomainFromHost !== 'function' || typeof toRdnn !== 'function') {
        return alert('That location has no domain to look up.');
    }
    const parent = parentDomainFromHost(host);
    const rdnn = toRdnn(parent);
    const search = document.getElementById('stats-search');
    if (search && search.value) search.value = '';
    switchTab('stats-view', document.querySelector('.tab-btn[data-view="stats-view"]'));
    if (typeof switchStatsTab === 'function') switchStatsTab('domains');
    const row = document.querySelector(`#stats-body tr.stats-row[data-rdnn="${CSS.escape(rdnn)}"]`);
    document.querySelectorAll('.stats-row.stats-located').forEach(el => el.classList.remove('stats-located'));
    if (!row) return alert(`By domain has no row for ${parent}.`);
    row.classList.add('stats-located');
    row.scrollIntoView({ block: 'center' });
    const sub = redditSubredditFromUri(uri);
    if (!sub || typeof openStatsPanel !== 'function') return;
    const bucketKey = `Reddit|Subreddit|${sub.toLowerCase()}`;
    const domain = lastStatsModel?.domains?.find(item => item.rdnn === rdnn);
    if (domain?.services?.some(service => `${service.service}|${service.kind}|${service.key}` === bucketKey)) {
        openStatsPanel({ rdnn, bucketKey });
        if (typeof revealPanelLink === 'function') revealPanelLink(uri);
    }
}

const NEARBY_PAGE_SIZE = 100;
let nearbyLinks = [];
let nearbyAnchorIndex = -1;
let nearbyOffset = 0;
let nearbyHomeOffset = 0;

function nearbyDeltaLabel(ms) {
    const abs = Math.abs(ms);
    const sign = ms < 0 ? '−' : ms > 0 ? '+' : '';
    if (abs < 1000) return `${sign}${abs} ms`;
    if (abs < 60000) return `${sign}${Math.round(abs / 1000)} s`;
    if (abs < 3600000) return `${sign}${Math.round(abs / 60000)} min`;
    const hours = abs / 3600000;
    return `${sign}${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} h`;
}

function nearbyPageBounds() {
    const start = Math.max(0, nearbyOffset);
    const end = Math.min(nearbyLinks.length, nearbyOffset + NEARBY_PAGE_SIZE);
    return { start, end };
}

function openNearbyBookmarks(item) {
    if (!item || !nodeUri(item)) return;
    const links = collectBookmarkLinks(bookmarkData).filter(link => link.addedMs != null);
    links.sort((a, b) => a.addedMs - b.addedMs || String(a.uri).localeCompare(String(b.uri)));
    const at = links.findIndex(link => link.node === item);
    const box = document.getElementById('nearby-results');
    switchTab('actions-view', document.querySelector('.tab-btn[data-view="actions-view"]'));
    switchChildTab('nearby-actions', document.querySelector('.child-tab-btn[data-child="nearby-actions"]'));
    if (at < 0) {
        nearbyLinks = [];
        nearbyAnchorIndex = -1;
        if (box) box.innerHTML = '<p>That bookmark has no usable dateAdded, so nothing sits beside it in time.</p>';
        return;
    }
    nearbyLinks = links;
    nearbyAnchorIndex = at;
    nearbyHomeOffset = Math.min(Math.max(0, at - Math.floor(NEARBY_PAGE_SIZE / 2)), Math.max(0, links.length - NEARBY_PAGE_SIZE));
    nearbyOffset = nearbyHomeOffset;
    renderNearbyBookmarks('anchor');
}

function pageNearbyBookmarks(delta) {
    const next = nearbyOffset + delta * NEARBY_PAGE_SIZE;
    if (next + NEARBY_PAGE_SIZE <= 0 || next >= nearbyLinks.length) return;
    nearbyOffset = next;
    renderNearbyBookmarks('top');
}

function showNearbySelectedPage() {
    nearbyOffset = nearbyHomeOffset;
    renderNearbyBookmarks('anchor');
}

function nearbyPagerHtml() {
    const total = nearbyLinks.length;
    const { start, end } = nearbyPageBounds();
    return `<div class="panel-pager">
            <button type="button" class="ghost-btn" data-nearby-page="-1"${nearbyOffset <= 0 ? ' disabled' : ''}>Previous</button>
            <span>${formatCount(start + 1)}–${formatCount(end)} of ${formatCount(total)}</span>
            <button type="button" class="ghost-btn" data-nearby-page="1"${end >= total ? ' disabled' : ''}>Next</button>
        </div>`;
}

function renderNearbyBookmarks(scrollTo) {
    const box = document.getElementById('nearby-results');
    if (!box) return;
    if (!nearbyLinks.length || nearbyAnchorIndex < 0) {
        box.innerHTML = '<p>Right-click a bookmark and choose Nearby bookmarks.</p>';
        return;
    }
    const anchor = nearbyLinks[nearbyAnchorIndex];
    const { start, end } = nearbyPageBounds();
    const rows = nearbyLinks.slice(start, end).map((link, i) => {
        const index = start + i;
        const isAnchor = index === nearbyAnchorIndex;
        const when = new Date(link.addedMs).toLocaleString();
        return `<tr class="${isAnchor ? 'nearby-anchor' : ''}">
            <td>${escapeHtml(nearbyDeltaLabel(link.addedMs - anchor.addedMs))}</td>
            <td>${escapeHtml(when)}</td>
            <td class="title">${typeof titleLinkHtml === 'function' ? titleLinkHtml(link) : escapeHtml(link.title || 'Untitled')}</td>
            <td>${typeof folderChipsHtml === 'function' ? folderChipsHtml(link.folderPath) : escapeHtml(link.folderPath || '')}</td>
            <td><div class="trail-actions"><button type="button" class="ghost-btn chain-send-btn" data-call="showNearbyBookmark" data-arg="${index}">Show in library</button><button type="button" class="ghost-btn chain-send-btn" data-nearby-domain="${index}">By domain</button></div></td>
        </tr>`;
    }).join('');
    const before = nearbyAnchorIndex;
    const after = nearbyLinks.length - nearbyAnchorIndex - 1;
    box.innerHTML = `<p>${formatCount(before)} before · selected · ${formatCount(after)} after. <button type="button" class="nearby-anchor-link" title="Go to the page with this bookmark">${escapeHtml(anchor.title || 'Untitled')}</button></p>
        ${nearbyPagerHtml()}
        <table class="excel-table nearby-table"><thead><tr><th>From selected</th><th>Added</th><th>Link</th><th>Folder</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        ${nearbyPagerHtml()}`;
    box.querySelectorAll('[data-call="showNearbyBookmark"]').forEach(btn => {
        btn.onclick = () => showNearbyBookmark(btn.getAttribute('data-arg'));
    });
    box.querySelectorAll('[data-nearby-domain]').forEach(btn => {
        btn.onclick = () => {
            const link = nearbyLinks[Number(btn.getAttribute('data-nearby-domain'))];
            if (link) findUriInDomainStats(link.uri);
        };
    });
    const anchorLink = box.querySelector('.nearby-anchor-link');
    if (anchorLink) anchorLink.onclick = showNearbySelectedPage;
    box.querySelectorAll('[data-nearby-page]').forEach(btn => {
        btn.onclick = () => pageNearbyBookmarks(Number(btn.getAttribute('data-nearby-page')));
    });
    if (typeof bindFolderChips === 'function') bindFolderChips(box);
    const anchorRow = scrollTo === 'anchor' ? box.querySelector('tr.nearby-anchor') : null;
    if (anchorRow) anchorRow.scrollIntoView({ block: 'center' });
    else if (scrollTo === 'top') box.scrollIntoView({ block: 'start' });
}

function showNearbyBookmark(index) {
    const link = nearbyLinks[Number(index)];
    if (!link || typeof revealBookmark !== 'function') return;
    revealBookmark({ node: link.node, parent: link.parent });
}

function showContextMenu(event, parentFolder, item, index) {
    rightClickedItem = { parentFolder, item, index };
    hidePopupMenus();
    // Before this click's own visibility rules run: the previous tidy's hiding must be undone first.
    resetContextMenuTidy();
    const uri = nodeUri(item);
    ['context-open', 'context-copy', 'context-send-obsidian', 'context-send-obsidian-delete', 'context-nearby', 'context-find-domain'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = !uri;
    });
    // Offer the untouched URL beside the clean one only while cleaning would change it.
    const copyOriginal = document.getElementById('context-copy-url-original');
    if (copyOriginal) copyOriginal.hidden = !(uri && typeof hasCleanableUrl === 'function' && hasCleanableUrl(uri));
    const crossLinks = {
        'context-search-chain': () => typeof searchChainForNode === 'function' && Boolean(searchChainForNode(item)),
        'context-dupes': () => typeof duplicateCopiesOf === 'function' && duplicateCopiesOf(item) > 1,
        'context-check-link': () => /^https?:\/\//i.test(uri) && typeof isLiveBookmarks === 'function' && isLiveBookmarks()
    };
    Object.entries(crossLinks).forEach(([id, test]) => {
        const el = document.getElementById(id);
        if (!el) return;
        let show = false;
        try { show = Boolean(uri) && test(); } catch (e) { show = false; }
        el.hidden = !show;
    });
    const folderItem = isBookmarkFolderNode(item);
    ['context-send-folder-obsidian', 'context-send-folder-obsidian-delete', 'context-export-html', 'context-export-json', 'context-open-all', 'context-protect'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = !folderItem;
    });
    // The row's own items are settled now, so the condensed send menu can reveal or hide the
    // destination pair for whichever menu belongs to this row (a folder never shows bookmark sends).
    applyCondensedSendMenu();
    updateProtectLabels();
    const openAll = document.getElementById('context-open-all');
    if (openAll && folderItem) {
        const openable = folderLinksInOrder(item).map(nodeUri).filter(openableBrowserUrl).length;
        openAll.hidden = !openable;
        openAll.textContent = openable ? `Open all ${formatCount(openable)} in tabs...` : 'Open all bookmarks in tabs...';
    }
    // Create/Update/Delete sit closest to the pointer. The groups under them keep a
    // separator only while they have something to show.
    const sendSep = document.getElementById('context-send-sep');
    if (sendSep) sendSep.hidden = !uri && !folderItem;
    const editSep = document.getElementById('context-edit-sep');
    if (editSep) editSep.hidden = !uri && !folderItem;
    const moveOther = document.getElementById('context-move-other');
    if (moveOther) {
        const inOther = nodesInsideFolder(findSpecialFolder('unfiled_____'));
        const picked = librarySelection.includes(item) ? librarySelection : [item];
        moveOther.hidden = inOther.size > 0 && picked.every(node => inOther.has(node));
    }
    const multi = librarySelection.includes(item) && librarySelection.length > 1;
    setFolderMenuStats(document.getElementById('context-folder-stats'), document.getElementById('context-folder-stats-sep'), multi ? null : item);
    setOpenSubredditItem(document.getElementById('context-open-subreddit'), document.getElementById('context-open-subreddit-sep'), multi ? null : item);
    // The read group's own separator: the URL items, or the folder's subreddit entry.
    const subredditItem = document.getElementById('context-open-subreddit');
    const readSep = document.getElementById('context-read-sep');
    if (readSep) readSep.hidden = !uri && (!subredditItem || subredditItem.hidden);
    const moveLinks = document.getElementById('context-move-links-below');
    if (moveLinks) moveLinks.hidden = !folderItem;
    const menu = document.getElementById('context-menu');
    tidyContextMenu(menu);
    placePopupMenu(menu, event.clientX, event.clientY);
}

document.addEventListener('click', hidePopupMenus);
// Any press closes an open menu, in the capture phase and on mousedown rather than click.
// Several handlers (a tree row, a list row) stop propagation, and a re-render can swallow
// the click entirely, either of which used to leave a menu on screen — right-clicking the
// list background and then clicking a folder in the tree kept the menu up. A press that
// starts inside a menu is left alone so the item still receives its click.
document.addEventListener('mousedown', event => {
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('.context-menu')) return;
    hidePopupMenus();
}, true);
document.querySelectorAll('.context-menu-stats').forEach(el => el.addEventListener('click', event => event.stopPropagation()));

function openEditItemDialog() {
    if (!rightClickedItem) return;
    const item = rightClickedItem.item;
    const dialog = document.getElementById('edit-item-dialog');
    const titleInput = document.getElementById('edit-item-title');
    const linkField = document.getElementById('edit-item-link-field');
    const linkInput = document.getElementById('edit-item-link');
    const heading = document.getElementById('edit-item-heading');
    if (!dialog || !titleInput || !linkField || !linkInput) return;
    const isLink = isBookmarkLinkNode(item);
    if (heading) heading.textContent = isLink ? 'Edit bookmark' : 'Edit folder';
    titleInput.value = item.title || '';
    linkField.hidden = !isLink;
    linkInput.value = isLink ? (nodeUri(item) || '') : '';
    const noteField = document.getElementById('edit-item-description');
    if (noteField) {
        noteField.value = noteFor(item);
        noteField.disabled = !isLink;
    }
    dialog.hidden = false;
    titleInput.focus();
    titleInput.select();
}

function closeEditItemDialog() {
    const dialog = document.getElementById('edit-item-dialog');
    if (dialog) dialog.hidden = true;
}

function refreshFolderTitleSurfaces(node) {
    const entry = folderTreeItems.get(node);
    if (entry) {
        const view = subredditFolderView(displayFolderTitle(node));
        const label = entry.itemDiv.querySelector('.tree-label');
        if (label) label.innerHTML = `📁 ${escapeHtml(view.label)}${view.markHtml}${emptyFolderBadgeHtml(node)}`;
        entry.itemDiv.title = view.full;
    }
    if (currentFolder) renderFolderContents(currentFolder);
    if (document.getElementById('stats-view')?.classList.contains('active') && typeof renderStatistics === 'function') renderStatistics();
}

function saveEditItemDialog(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (!rightClickedItem) return closeEditItemDialog();
    const item = rightClickedItem.item;
    const titleInput = document.getElementById('edit-item-title');
    const linkField = document.getElementById('edit-item-link-field');
    const linkInput = document.getElementById('edit-item-link');
    const newTitle = titleInput ? titleInput.value : item.title;
    const oldTitle = item.title;
    const oldUri = nodeUri(item);
    let newUri = oldUri;
    if (linkField && !linkField.hidden) {
        const edited = (linkInput.value || '').trim();
        if (!edited) return alert('Link cannot be empty.');
        newUri = edited;
        item.uri = edited;
        if (Object.prototype.hasOwnProperty.call(item, 'url')) item.url = edited;
    }
    const noteField = document.getElementById('edit-item-description');
    const newNote = noteField ? String(noteField.value || '').trim() : '';
    const oldNote = noteFor(item);
    if (newNote !== oldNote) {
        saveNote(item, newNote);
        if (newNote) item.description = newNote;
        else delete item.description;
        markChanged();
    }
    if (newUri !== oldUri) moveStoredNote(oldUri, newUri);
    if (newTitle === oldTitle && newUri === oldUri) return closeEditItemDialog();
    item.title = newTitle;
    item._modified = true;
    if (typeof liveUpdateNode === 'function') liveUpdateNode(item);
    markChanged();
    logAffected('MODIFIED', newTitle, 'Manual context-menu edit.', {
        source: 'Bookmarks context menu',
        node: item,
        oldTitle,
        newTitle,
        oldUri,
        newUri,
        uri: item.uri,
        dateAdded: item.dateAdded
    });
    closeEditItemDialog();
    if (isBookmarkFolderNode(item)) refreshFolderTitleSurfaces(item);
}

function handleContextAction(action) {
    if (!rightClickedItem) return;
    const { parentFolder, item, index } = rightClickedItem;

    switch(action) {
        case 'revealInFolder': {
            // The row already knows the folder it came from, so this is the "Show in Library" reveal
            // without a lookup: clear the search (or the entry would stay filtered out of the folder
            // it lives in), expand the ancestors, open that folder, and land with the entry selected
            // and scrolled to. It works from a search result, a recursive listing or the plain one.
            if (typeof revealBookmark === 'function') revealBookmark({ node: item, parent: parentFolder });
            if (typeof selectLibraryNodes === 'function') selectLibraryNodes([item], item);
            break;
        }
        case 'edit':
            openEditItemDialog();
            break;
        case 'open':
            openLibraryNode(item);
            break;
        case 'copyTitle':
        case 'copyUrl':
        case 'copyUrlOriginal':
        case 'copyMarkdown':
            copyLibraryEntries(item, action);
            break;
        case 'nearby':
            openNearbyBookmarks(item);
            break;
        case 'findDomain':
            findUriInDomainStats(nodeUri(item));
            break;
        case 'searchChain':
            showSearchChainForNode(item);
            break;
        case 'dupes':
            showDuplicatesForNode(item);
            break;
        case 'checkLink':
            checkSingleLink(item);
            break;
        case 'sendObsidianDaily':
            sendLibraryBookmarksToObsidian('keep', true);
            break;
        case 'sendObsidianDailyDelete':
            sendLibraryBookmarksToObsidian('delete', true);
            break;
        case 'sendObsidian':
            sendLibraryBookmarksToObsidian('keep');
            break;
        case 'sendObsidianDelete':
            sendLibraryBookmarksToObsidian('delete');
            break;
        case 'sendFolderObsidianDaily':
            sendLibraryFolderToObsidian('keep', true);
            break;
        case 'sendFolderObsidianDailyDelete':
            sendLibraryFolderToObsidian('delete', true);
            break;
        case 'sendFolderObsidian':
            sendLibraryFolderToObsidian('keep');
            break;
        case 'sendFolderObsidianDelete':
            sendLibraryFolderToObsidian('delete');
            break;
        case 'exportHtml':
            exportFolderAsHtml('row');
            break;
        case 'exportJson':
            exportFolderAsJson(item);
            break;
        case 'openAll':
            openFolderInTabs(item);
            break;
        case 'delete':
            previewDeleteLibraryNodes(librarySelection.includes(item) ? librarySelection : [item]);
            break;
        case 'toggleProtect':
            toggleFolderProtection(item);
            break;
        case 'newFolder':
            const folderName = prompt('New Folder Name:', defaultNewFolderName(parentFolder));
            if (folderName) {
                const folder = { typeCode: 2, title: folderName, children: [], dateAdded: Date.now() * 1000, _modified: true };
                parentFolder.children.push(folder);
                markChanged();
                renderSidebar();
                logAffected('ADDED', folderName, 'New directory created manually.', {
                    source: 'Bookmarks context menu',
                    node: folder,
                    folderPath: folderPathFor(parentFolder) || parentFolder.title
                });
            }
            break;
        case 'moveLinksBelow':
            moveLinksUnderneathFolder(item);
            break;
        case 'newBookmark':
            const bmTitle = prompt("Bookmark Title:");
            if (bmTitle) {
                const bmUrl = prompt("Bookmark URL:", "https://");
                const bm = { typeCode: 1, title: bmTitle, uri: bmUrl, dateAdded: Date.now() * 1000, _modified: true };
                parentFolder.children.push(bm);
                markChanged();
                logAffected('ADDED', bmTitle, 'New bookmark created manually.', {
                    source: 'Bookmarks context menu',
                    node: bm,
                    uri: bmUrl,
                    dateAdded: bm.dateAdded
                });
            }
            break;
    }
}

function markChanged() {
    hasUnsavedChanges = true;
    statsDataRev++;
    updateStatus();
    if (currentFolder) renderFolderContents(currentFolder);
}

function paintBookmarksTabCount() {
    const btn = document.querySelector('.tab-btn[data-view="bookmarks-view"]');
    if (!btn) return;
    if (!bookmarkData || typeof countTree !== 'function') {
        btn.textContent = 'Bookmarks';
        return;
    }
    const n = countTree(bookmarkData).links;
    const label = typeof formatCount === 'function' ? formatCount(n) : String(n);
    btn.textContent = `Bookmarks (${label})`;
}

let bookmarksTabCountFrame = 0;

function scheduleBookmarksTabCount() {
    if (bookmarksTabCountFrame) return;
    bookmarksTabCountFrame = requestAnimationFrame(() => {
        bookmarksTabCountFrame = 0;
        paintBookmarksTabCount();
    });
}

function updateStatus() {
    scheduleBookmarksTabCount();
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!bookmarkData) {
        dot.className = 'status-dot';
        text.textContent = 'Ready (No file loaded)';
    } else if (hasUnsavedChanges) {
        dot.className = 'status-dot unsaved';
        text.textContent = 'Unsaved changes';
    } else {
        dot.className = 'status-dot';
        text.textContent = 'Ready';
    }
}

function clearModifiedFlags(node) {
    delete node._modified;
    if (node.children) node.children.forEach(clearModifiedFlags);
}

function flattenBookmarkIndex(root) {
    const map = new Map();
    collectBookmarkLinks(root).forEach(link => {
        const key = link.uri;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(link);
    });
    return map;
}

function compareBookmarkFile(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file || !bookmarkData) return alert('Load a library first, then choose a second JSON.');
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const other = JSON.parse(e.target.result);
            const { added, removed, changed } = diffBookmarkTrees(bookmarkData, other);
            if (typeof switchTabById === 'function') switchTabById('actions-view');
            const box = document.getElementById('repairs-results') || document.getElementById('stats-meta');
            const html = `<p>Diff vs ${escapeHtml(file.name)}: ${formatCount(added.length)} only in that file, ${formatCount(removed.length)} only in current, ${formatCount(changed.length)} title change(s).</p>`;
            if (document.getElementById('repairs-results')) document.getElementById('repairs-results').innerHTML = html;
            else alert(`Added ${added.length}, removed ${removed.length}, title changes ${changed.length}`);
            logAffected('SYSTEM', file.name, `Compared the loaded library to “${file.name}”. ${formatCount(added.length)} URL(s) exist only in that file, ${formatCount(removed.length)} URL(s) exist only in the current library, ${formatCount(changed.length)} URL(s) have a different title. No bookmarks were added or deleted. If any URLs are only in the current library, a panel lists them.`, { source: 'Compare JSON', kind: 'compare' });
            if (removed.length) openLinkTablePanel({ links: removed, title: 'Only in current library', meta: file.name });
        } catch (err) {
            alert(`Could not parse that JSON: ${err.message}`);
        }
    };
    reader.readAsText(file);
}

const EDITOR_SETTINGS_KEY = 'bookmark-editor-settings';
const SIDEBAR_WIDTH_MIN = 140;
const SIDEBAR_WIDTH_DEFAULT = 350;
const SIDEBAR_WIDTH_LEGACY_DEFAULT = 270;
const SIDEBAR_CONTENT_MIN = 180;
const EDITOR_SETTING_DEFAULTS = { theme: 'light', statsSort: 'count', burstGap: '120000', burstMin: '3', sidebarWidth: SIDEBAR_WIDTH_DEFAULT, refreshDupesOnDelete: true, skipBookmarkedOpenTabs: true, openTabsChainFolders: true, autoMoveToolbarLinks: true, autoMoveMobile: true, autoMoveHours: AUTO_MOVE_HOURS_DEFAULT, youtubeTitleSuffix: true, googleTitleSuffix: true, cleanSentUrls: true, stripRedditChrome: true, obsidianNotePath: '', obsidianInsert: 'after', obsidianDestination: 'cursor', obsidianFallback: 'notice', startupFolder: 'toolbar', hideRootFolder: true, mergePolicy: 'skip', density: 'comfortable', columns: 'all', searchOperators: true, searchSyntaxFamilies: SEARCH_FAMILY_KEYS.join(','), searchWholeWords: false, searchCaseSensitive: false, exhaustiveSearch: false };
const EDITOR_SETTING_FIELDS = {
    theme: ['setting-theme'],
    statsSort: ['stats-sort', 'setting-stats-sort'],
    burstGap: ['stats-burst-gap', 'setting-burst-gap'],
    burstMin: ['stats-burst-min', 'setting-burst-min'],
    sidebarWidth: ['setting-sidebar-width'],
    refreshDupesOnDelete: ['setting-refresh-dupes'],
    skipBookmarkedOpenTabs: ['setting-open-tabs-skip-saved'],
    openTabsChainFolders: ['setting-open-tabs-chain-folders'],
    autoMoveToolbarLinks: ['setting-auto-move-toolbar'],
    autoMoveMobile: ['setting-auto-move-mobile'],
    autoMoveHours: ['setting-auto-move-hours'],
    youtubeTitleSuffix: ['setting-youtube-suffix'],
    googleTitleSuffix: ['setting-google-suffix'],
    cleanSentUrls: ['setting-clean-urls'],
    stripRedditChrome: ['setting-reddit-chrome'],
    obsidianNotePath: ['setting-obsidian-note'],
    obsidianInsert: ['setting-obsidian-insert'],
    obsidianDestination: ['setting-obsidian-destination'],
    obsidianFallback: ['setting-obsidian-fallback'],
    startupFolder: ['setting-startup-folder'],
    hideRootFolder: ['setting-hide-root'],
    mergePolicy: ['setting-merge-policy'],
    density: ['setting-density'],
    columns: ['setting-columns']
};

function readEditorSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || '{}') || {}; } catch (e) {}
    let legacyTheme = '';
    try { legacyTheme = localStorage.getItem('bookmark-editor-theme') || ''; } catch (e) {}
    const settings = { ...EDITOR_SETTING_DEFAULTS, ...saved };
    if (legacyTheme === 'dark' || legacyTheme === 'light') settings.theme = legacyTheme;
    const width = Number(settings.sidebarWidth);
    if (!Number.isFinite(width) || width === SIDEBAR_WIDTH_LEGACY_DEFAULT) settings.sidebarWidth = SIDEBAR_WIDTH_DEFAULT;
    else settings.sidebarWidth = Math.round(width);
    const auto = typeof autoMoveSettingsFrom === 'function' ? autoMoveSettingsFrom(settings) : settings;
    settings.autoMoveToolbarLinks = auto.autoMoveToolbarLinks;
    settings.autoMoveMobile = auto.autoMoveMobile;
    settings.autoMoveHours = auto.autoMoveHours;
    settings.autoMoveLastAt = auto.autoMoveLastAt;
    const capture = typeof capturePrefsFrom === 'function' ? capturePrefsFrom(settings) : null;
    if (capture) {
        Object.assign(settings, capture);
        applyCapturePrefs(capture);
    }
    return settings;
}

// Plain-English translation of the filters, shown above the operator legend and kept in step
// with the query as it is typed. It reads the same parser the search itself uses, so it can
// never describe something the search would not do.
const SEARCH_HAS_WORDS = {
    note: 'has a note', dupe: 'is part of a duplicate group', tracked: 'has tracking parameters in its URL',
    folder: 'is a folder', date: 'has an added date'
};
const SEARCH_IS_WORDS = {
    tracked: 'is tracked', dupe: 'is part of a duplicate group', untitled: 'has no title',
    folder: 'is a folder', bookmark: 'is a bookmark', noted: 'has a note'
};
const SEARCH_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function searchAddedPhrase(entry) {
    const date = new Date(entry.ms);
    if (!Number.isFinite(date.getTime())) return '';
    const month = SEARCH_MONTHS[date.getUTCMonth()];
    const when = `${month} ${date.getUTCFullYear()}`;
    return entry.op === '>' ? `it was added after ${when}` : entry.op === '<' ? `it was added before ${when}` : `it was added in ${when}`;
}

function searchScopePhrase() {
    const everywhere = Boolean(document.getElementById('bookmark-search-everywhere')?.checked);
    if (everywhere) return 'everywhere (Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks and Mobile Bookmarks)';
    const recursive = Boolean(document.getElementById('bookmark-search-recursive')?.checked);
    return recursive ? 'in this folder and its subfolders' : 'in this folder only';
}

function searchPlainEnglish() {
    const input = document.getElementById('bookmark-search');
    const query = String((input && input.value) || '').trim();
    const scope = searchScopePhrase();
    if (!query) return { scope, sentence: '', empty: true };
    const parsed = parseLibraryQuery(query);
    if (parsed.literal) return { scope, sentence: 'the exact text you type', empty: false };
    if (parsed.regex) return { scope, sentence: `matching the regular expression <code>${escapeHtml(String(parsed.regex))}</code>`, empty: false };
    if (parsed.invalidRegex) return { scope, sentence: '', empty: false, invalid: parsed.invalidRegex };
    const list = (values, make) => values.map(value => make(escapeHtml(value)));
    const quoted = (values, make) => list(values, make).join(' or ');
    const clauses = [];
    if (parsed.domain.length) clauses.push(`the domain is ${quoted(parsed.domain, v => `<code>${v}</code>`)}`);
    if (parsed.folder.length) clauses.push(`the folder matches ${quoted(parsed.folder, v => `<code>${v}</code>`)}`);
    if (parsed.title.length) clauses.push(`the title contains ${quoted(parsed.title, v => `<code>${v}</code>`)}`);
    if (parsed.url.length) clauses.push(`the URL contains ${quoted(parsed.url, v => `<code>${v}</code>`)}`);
    parsed.added.forEach(entry => { const phrase = searchAddedPhrase(entry); if (phrase) clauses.push(phrase); });
    if (parsed.has.length) clauses.push(`it ${quoted(parsed.has, v => SEARCH_HAS_WORDS[v] || `has ${v}`)}`);
    if (parsed.is.length) clauses.push(`it ${quoted(parsed.is, v => SEARCH_IS_WORDS[v] || `is ${v}`)}`);
    if (parsed.terms.length) clauses.push(`the words ${list(parsed.terms, v => `<b>${v}</b>`).join(' and ')} appear too`);
    const positives = clauses.length ? clauses.join(' and ') : '';
    const negative = parsed.not.length ? `but the words ${list(parsed.not, v => `<b>${v}</b>`).join(' and ')} never appear` : '';
    const sentence = [positives, negative].filter(Boolean).join(', ');
    return { scope, sentence, empty: !sentence, operators: parsed.operators };
}

function searchPlainEnglishHtml() {
    const plain = searchPlainEnglish();
    if (plain.invalid) {
        return `<p class="operator-plain is-bad">That pattern is not a valid regular expression${plain.invalid ? ` (${escapeHtml(plain.invalid)})` : ''}, so nothing is being filtered by it.</p>`;
    }
    if (!plain.sentence) {
        return `<p class="operator-plain"><b>In plain English:</b> searching <b>${escapeHtml(plain.scope)}</b>${plain.empty ? ', with no filters set — everything you type is matched as plain text.' : '.'}</p>`;
    }
    return `<p class="operator-plain"><b>In plain English:</b> searching <b>${escapeHtml(plain.scope)}</b>, for bookmarks where ${plain.sentence}.</p>`;
}

// Only this element is rewritten while typing, so the filter boxes keep their cursor.
function updateSearchOperatorPlain() {
    const box = document.getElementById('search-operator-plain');
    if (box) box.innerHTML = searchPlainEnglishHtml();
}

function saveEditorSettings(patch) {
    const next = { ...readEditorSettings(), ...patch };
    const auto = typeof autoMoveSettingsFrom === 'function' ? autoMoveSettingsFrom(next) : next;
    next.autoMoveToolbarLinks = auto.autoMoveToolbarLinks;
    next.autoMoveMobile = auto.autoMoveMobile;
    next.autoMoveHours = auto.autoMoveHours;
    next.autoMoveLastAt = auto.autoMoveLastAt;
    if (autoMoveEnabled(next) && !next.autoMoveLastAt) next.autoMoveLastAt = Date.now();
    const capture = typeof capturePrefsFrom === 'function' ? capturePrefsFrom(next) : null;
    if (capture) {
        Object.assign(next, capture);
        applyCapturePrefs(capture);
    }
    try {
        localStorage.setItem(EDITOR_SETTINGS_KEY, JSON.stringify(next));
        if (patch.theme) localStorage.setItem('bookmark-editor-theme', patch.theme);
    } catch (e) {}
    if (typeof isLiveBookmarks === 'function' && isLiveBookmarks()) {
        syncAutoMoveSettingsToBackground(next);
        syncCaptureSettingsToBackground(next);
    }
    return next;
}

function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el || value == null) return;
    if (el.type === 'checkbox') {
        el.checked = value !== false && value !== 'false' && value !== 0 && value !== '0';
        return;
    }
    if (el.tagName === 'SELECT') {
        if ([...el.options].some(option => option.value === String(value))) el.value = String(value);
        return;
    }
    el.value = String(value);
}

function currentSidebarWidth() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        const width = sidebar.getBoundingClientRect().width;
        if (width > 0) return Math.round(width);
    }
    const pane = document.getElementById('bookmarks-view');
    const css = pane ? parseFloat(pane.style.getPropertyValue('--sidebar-width')) : NaN;
    return Number.isFinite(css) ? css : SIDEBAR_WIDTH_DEFAULT;
}

function clampSidebarWidth(px) {
    const pane = document.getElementById('bookmarks-view');
    const splitter = document.getElementById('library-splitter');
    const splitW = splitter && splitter.offsetWidth ? splitter.offsetWidth : 6;
    const paneW = pane && pane.clientWidth ? pane.clientWidth : 900;
    const max = Math.max(SIDEBAR_WIDTH_MIN, paneW - splitW - SIDEBAR_CONTENT_MIN);
    const n = Number(px);
    const raw = Number.isFinite(n) ? n : SIDEBAR_WIDTH_DEFAULT;
    return Math.max(SIDEBAR_WIDTH_MIN, Math.min(max, Math.round(raw)));
}

function applySidebarWidth(px, persist) {
    const width = clampSidebarWidth(px);
    const pane = document.getElementById('bookmarks-view');
    if (pane) pane.style.setProperty('--sidebar-width', width + 'px');
    const splitter = document.getElementById('library-splitter');
    if (splitter) {
        splitter.setAttribute('aria-valuenow', String(width));
        splitter.setAttribute('aria-valuemin', String(SIDEBAR_WIDTH_MIN));
        splitter.setAttribute('aria-valuemax', String(clampSidebarWidth(1e9)));
    }
    const field = document.getElementById('setting-sidebar-width');
    if (field) field.value = String(width);
    if (persist) saveEditorSettings({ sidebarWidth: width });
    return width;
}

function bindLibrarySplitter() {
    const splitter = document.getElementById('library-splitter');
    if (!splitter) return;
    let dragging = false;
    let startX = 0;
    let startW = 0;
    const stopDrag = () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('sidebar-resizing');
        applySidebarWidth(currentSidebarWidth(), true);
    };
    splitter.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true;
        startX = event.clientX;
        startW = currentSidebarWidth();
        splitter.classList.add('dragging');
        document.body.classList.add('sidebar-resizing');
        try { splitter.setPointerCapture(event.pointerId); } catch (e) {}
        event.preventDefault();
    });
    splitter.addEventListener('pointermove', event => {
        if (!dragging) return;
        applySidebarWidth(startW + (event.clientX - startX), false);
    });
    splitter.addEventListener('pointerup', stopDrag);
    splitter.addEventListener('pointercancel', stopDrag);
    splitter.addEventListener('dblclick', () => applySidebarWidth(SIDEBAR_WIDTH_DEFAULT, true));
    splitter.addEventListener('keydown', event => {
        const step = event.shiftKey ? 40 : 16;
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            applySidebarWidth(currentSidebarWidth() - step, true);
        } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            applySidebarWidth(currentSidebarWidth() + step, true);
        } else if (event.key === 'Home') {
            event.preventDefault();
            applySidebarWidth(SIDEBAR_WIDTH_MIN, true);
        } else if (event.key === 'End') {
            event.preventDefault();
            applySidebarWidth(1e9, true);
        }
    });
    window.addEventListener('resize', () => {
        const now = currentSidebarWidth();
        const next = clampSidebarWidth(now);
        applySidebarWidth(next, next !== now);
    });
}

function applyEditorSettings(settings) {
    const theme = resolvedTheme(settings.theme);
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
        btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
        btn.title = settings.theme === 'auto' ? 'Following the system theme' : `Theme: ${theme}`;
    }
    setSelectValue('setting-theme', settings.theme === 'auto' ? 'auto' : theme);
    document.documentElement.setAttribute('data-density', settings.density === 'compact' ? 'compact' : 'comfortable');
    applyColumnChooser(settings.columns || 'all');
    Object.entries(EDITOR_SETTING_FIELDS).forEach(([key, ids]) => {
        if (key === 'theme') return;
        ids.forEach(id => setSelectValue(id, settings[key]));
    });
    // The background script cannot read these settings, so the destination is mirrored into extension
    // storage for the native tab context menu. The JSON build has no extension, hence the guard.
    try {
        const ext = typeof getBrowserExt === 'function' ? getBrowserExt() : null;
        if (ext && ext.storage && ext.storage.local && typeof ext.storage.local.set === 'function') {
            // The background script cannot read these, so it gets all three: which destination the
            // menu and the background sends use, whether a send nests under the line, and what to do
            // when no editor is open.
            const destination = settings.obsidianDestination === 'daily' || settings.obsidianDestination === 'both' ? settings.obsidianDestination : 'cursor';
            ext.storage.local.set({
                obsidianDestination: destination,
                obsidianInsert: settings.obsidianInsert === 'under' ? 'under' : 'after',
                obsidianFallback: settings.obsidianFallback === 'daily' ? 'daily' : 'notice'
            });
        }
    } catch (err) { /* no extension */ }

    applySidebarWidth(settings.sidebarWidth, false);
    applyCondensedSendMenu();
}

// Condensed send menu (opt-in via <body data-send-menu="condensed">): one item, with the
// destination taken from the settings and Alt/Shift-click for the delete variant. The extra items stay
// in the DOM but are hidden, so this only changes the menu a page asks for.
// The condensed menu is the default. A page can opt out with <body data-send-menu="full">, which
// shows the individual items instead of folding them into one with a modifier.
function condensedSendMenuEnabled() {
    return typeof document === 'undefined' || !document.body || document.body.dataset.sendMenu !== 'full';
}

function applyCondensedSendMenu() {
    if (!condensedSendMenuEnabled()) return;
    const destination = obsidianDestination();
    const toDaily = destination === 'daily';
    const showBoth = destination === 'both';
    const menus = [
        { main: 'context-send-obsidian', extras: ['context-send-obsidian-delete', 'context-send-obsidian-daily', 'context-send-obsidian-daily-delete'] },
        { main: 'context-send-folder-obsidian', extras: ['context-send-folder-obsidian-delete', 'context-send-folder-obsidian-daily', 'context-send-folder-obsidian-daily-delete'] }
    ];
    menus.forEach(menu => {
        // extras[0] is the plain delete item (Alt-click covers it); extras[1] and extras[2] are the
        // (Daily note) pair, which stays visible only when both destinations are wanted.
        const main = document.getElementById(menu.main);
        if (!main) return;
        // Only the menu that belongs to this row may show its daily pair: a folder row must never
        // offer the bookmark sends, and the other way round.
        const menuOwnsRow = !main.hidden;
        menu.extras.forEach((id, index) => {
            const el = document.getElementById(id);
            if (el) el.hidden = index === 0 ? true : !(showBoth && menuOwnsRow);
        });
        const baseLabel = main.textContent.replace(/\s*\(Daily note\).*$/, '').trim();
        // The single item says which destination it uses, so "daily" is never a surprise.
        main.textContent = toDaily ? `${baseLabel} (Daily note)` : baseLabel;
        main.title = showBoth
            ? 'Send to Obsidian. Alt-click (or Shift-click) to delete the bookmarks afterwards.'
            : `Send to Obsidian${toDaily ? ' (the daily note)' : ' at the cursor'}. Alt-click (or Shift-click) to delete the bookmarks afterwards.`;
        if (main.dataset.condensedWired) return;
        main.dataset.condensedWired = '1';
        // Capture phase, so the generic wiring does not also fire for this click. The destination is
        // resolved per click, so a settings change needs no reload.
        main.addEventListener('click', event => {
            const remove = Boolean(event.altKey || event.shiftKey || event.metaKey);
            const dailyNow = obsidianDestination() === 'daily';
            const isBookmark = menu.main === 'context-send-obsidian';
            const pair = isBookmark
                ? (dailyNow ? ['sendObsidianDaily', 'sendObsidianDailyDelete'] : ['sendObsidian', 'sendObsidianDelete'])
                : (dailyNow ? ['sendFolderObsidianDaily', 'sendFolderObsidianDailyDelete'] : ['sendFolderObsidian', 'sendFolderObsidianDelete']);
            event.preventDefault();
            event.stopPropagation();
            handleContextAction(pair[remove ? 1 : 0]);
            if (typeof hideContextMenu === 'function') hideContextMenu();
        }, true);
    });
}

// The menu items are static markup, so wiring once the document is ready is enough.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyCondensedSendMenu);
else applyCondensedSendMenu();

function applyEditorSetting(key) {
    const source = document.getElementById((EDITOR_SETTING_FIELDS[key] || []).slice(-1)[0]);
    if (!source) return;
    const value = key === 'sidebarWidth'
        ? clampSidebarWidth(source.value)
        : key === 'autoMoveHours'
            ? clampAutoMoveHours(source.value)
            : (source.type === 'checkbox' ? source.checked : source.value);
    const settings = saveEditorSettings({ [key]: value });
    applyEditorSettings(settings);
    scheduleAutoMoveFromSettings(settings);
    if (key === 'hideRootFolder' && bookmarkData) renderSidebar();
    const statsOpen = document.getElementById('stats-view')?.classList.contains('active');
    if (!statsOpen) return;
    if (key === 'statsSort' && typeof paintStatistics === 'function') paintStatistics();
    if ((key === 'burstGap' || key === 'burstMin') && typeof rebuildStatistics === 'function') rebuildStatistics();
}

function toggleDarkTheme() {
    const order = ['light', 'dark', 'auto'];
    const current = String(readEditorSettings().theme || 'light');
    const next = order[(Math.max(0, order.indexOf(current)) + 1) % order.length];
    applyEditorSettingValue('theme', next);
}

// Set a setting programmatically (the theme button cycles) and persist it the same way
// applyEditorSetting does when a control changes.
function applyEditorSettingValue(key, value) {
    const settings = saveEditorSettings({ [key]: value });
    applyEditorSettings(settings);
    scheduleAutoMoveFromSettings(settings);
    logAffected('SYSTEM', 'Settings', `Setting “${key}” set to ${JSON.stringify(value)}.`, { source: 'Settings', kind: 'setting' });
}

function bindStatsSettingPersistence() {
    [
        ['stats-sort', 'statsSort'],
        ['stats-burst-gap', 'burstGap'],
        ['stats-burst-min', 'burstMin']
    ].forEach(([id, key]) => {
        document.getElementById(id)?.addEventListener('change', () => {
            const el = document.getElementById(id);
            if (!el) return;
            applyEditorSettings(saveEditorSettings({ [key]: el.value }));
        });
    });
}

(function restoreTheme() {
    const init = () => {
        const settings = readEditorSettings();
        applyEditorSettings(settings);
        try {
            const saved = JSON.parse(localStorage.getItem(EDITOR_SETTINGS_KEY) || '{}') || {};
            if (Number(saved.sidebarWidth) === SIDEBAR_WIDTH_LEGACY_DEFAULT) saveEditorSettings({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
        } catch (e) {}
        bindLibrarySplitter();
        bindStatsSettingPersistence();
        const form = document.querySelector('.settings-form');
        if (form) form.addEventListener('submit', event => event.preventDefault());
        loadEditorStores();
        paintSearchSyntaxSettings();
        scheduleAutoMoveFromSettings(settings);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();

(function bindEditItemDialog() {
    const form = document.getElementById('edit-item-form');
    if (!form) return;
    form.addEventListener('submit', saveEditItemDialog);
    form.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeEditItemDialog();
        }
    });
})();

(function bindMoveSearchFolderDialog() {
    const form = document.getElementById('move-search-folder-form');
    if (!form) return;
    form.addEventListener('submit', submitMoveSearchFolderDialog);
    form.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeMoveSearchFolderDialog();
        }
    });
})();

(function bindLibraryListKeys() {
    const name = document.getElementById('bookmark-sort-name');
    const location = document.getElementById('bookmark-sort-location');
    const added = document.getElementById('bookmark-sort-added');
    if (name) name.addEventListener('click', () => toggleLibrarySort('name', 1));
    if (location) location.addEventListener('click', () => toggleLibrarySort('location', 1));
    if (added) added.addEventListener('click', () => toggleLibrarySort('added', -1));
    const content = document.getElementById('content');
    if (content) content.addEventListener('contextmenu', showLibraryBackgroundMenu);
    document.addEventListener('keydown', event => {
        const panel = document.getElementById('stats-panel');
        if (panel && !panel.hidden) return;
        if (document.querySelector('.edit-dialog:not([hidden])')) return;
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!document.getElementById('bookmarks-view')?.classList.contains('active')) return;
        const rows = [...document.querySelectorAll('#bookmarks-body tr')];
        if (!rows.length) return;
        const nodes = rows.map(row => row._libraryNode).filter(Boolean);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            let index = nodes.indexOf(libraryAnchor);
            if (index < 0) index = event.key === 'ArrowDown' ? -1 : nodes.length;
            index = event.key === 'ArrowDown'
                ? Math.min(nodes.length - 1, index + 1)
                : Math.max(0, index - 1);
            selectLibraryNodes([nodes[index]], nodes[index]);
            rows[index]?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
            event.preventDefault();
            openLibraryNode(libraryAnchor);
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && librarySelection.length) {
            event.preventDefault();
            deleteLibraryNodes(librarySelection);
        }
    });
})();

loadAffectedLog();
window.addEventListener('pagehide', () => {
    clearTimeout(affectedLogSaveTimer);
    saveAffectedLog();
});

