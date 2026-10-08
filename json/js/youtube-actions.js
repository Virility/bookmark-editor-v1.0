// YouTube Actions — normalize, duplicates, titles. Globals used by HTML onclick.
// --- Shared Extracting/Scanning ---
function extractYouTubeID(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        const segments = u.pathname.split('/').filter(Boolean);
        // Shorts are intentionally left untouched by all YouTube tools.
        if (segments.some(segment => segment.toLowerCase() === 'shorts')) return null;
        if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com') {
            if (u.pathname === '/watch') return u.searchParams.get('v');
            if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2];
        }
        if (host === 'youtu.be') {
            return u.pathname.substring(1).split('?')[0];
        }
    } catch (e) {}
    return null;
}

function getYouTubeMap() {
    const ytMap = new Map();
    walkBookmarkTree(bookmarkData, (node, parent) => {
        const uri = nodeUri(node);
        if (!uri) return;
        const ytId = extractYouTubeID(uri);
        if (!ytId) return;
        if (!ytMap.has(ytId)) ytMap.set(ytId, []);
        ytMap.get(ytId).push({ node, parent });
    });
    return ytMap;
}

function canonicalYouTubeUrl(id) {
    return `https://www.youtube.com/watch?v=${id}`;
}

function getOldestYouTubeEntry(entries) {
    return [...entries].sort((a, b) => {
        const aDate = Number(a.node.dateAdded) || Number.MAX_SAFE_INTEGER;
        const bDate = Number(b.node.dateAdded) || Number.MAX_SAFE_INTEGER;
        return aDate - bDate;
    })[0];
}

function comparableYouTubeTitle(title) {
    return (title || '').trim().replace(/\s*-\s*YouTube\s*$/i, '').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function collectYouTubeNormalizePlan() {
    const ytMap = getYouTubeMap();
    const normalize = [];
    const remove = [];
    for (const [id, entries] of ytMap) {
        const keep = getOldestYouTubeEntry(entries);
        const standardUrl = canonicalYouTubeUrl(id);
        if (keep.node.uri !== standardUrl) normalize.push({ keep, id, standardUrl });
        entries.filter(entry => entry !== keep).forEach(entry => remove.push({ entry, id, keep }));
    }
    return { normalize, remove, count: normalize.length + remove.length };
}

const YT_PREVIEW_LIMIT = 250;

function renderYtChangeTable(box, summary, headers, rows) {
    if (!box) return;
    if (!rows.length) {
        box.innerHTML = `<p>${summary}</p>`;
        return;
    }
    const shown = rows.slice(0, YT_PREVIEW_LIMIT);
    const more = rows.length > shown.length
        ? `<p>Showing ${formatCount(shown.length)} of ${formatCount(rows.length)}. Apply still covers every checked row, including rows not shown.</p>`
        : '';
    box.innerHTML = `
        <p>${summary}</p>
        ${more}
        <table class="excel-table">
            <thead><tr>${headers.map(bulkHeaderCell).join('')}</tr></thead>
            <tbody>${shown.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
    `;
}

function scanYouTubeNormalize() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const plan = collectYouTubeNormalizePlan();
    const box = document.getElementById('yt-normalize-results');
    const rows = [];
    startBulkPick('yt-normalize');
    plan.normalize.forEach(item => {
        rows.push([
            bulkPickBox('yt-normalize', item.keep.node),
            escapeHtml(String(rows.length + 1)),
            escapeHtml(item.keep.node.title || ''),
            `<span class="log-url">${escapeHtml(nodeUri(item.keep.node))}</span>`,
            `<span class="log-url">${escapeHtml(item.standardUrl)}</span>`
        ]);
    });
    plan.remove.forEach(item => {
        rows.push([
            bulkPickBox('yt-normalize', item.entry.node),
            escapeHtml(String(rows.length + 1)),
            escapeHtml(item.entry.node.title || ''),
            `<span class="log-url">${escapeHtml(nodeUri(item.entry.node))}</span>`,
            escapeHtml(`Remove duplicate. Keep “${item.keep.node.title || 'oldest'}”.`)
        ]);
    });
    renderYtChangeTable(
        box,
        `${formatCount(plan.normalize.length)} URL(s) to canonicalize, ${formatCount(plan.remove.length)} duplicate(s) to remove.`,
        [{ pick: 'yt-normalize' }, '#', 'Title', 'Before', 'After'],
        rows
    );
    setBulkPlan('yt-normalize', { count: plan.count, label: 'YouTube normalize & dedupe', apply: applyYouTubeNormalize });
    logAffected('SYSTEM', 'YouTube normalize scan', `Grouped watch / youtu.be / embed bookmarks by video id (shorts skipped). ${formatCount(plan.normalize.length)} URL(s) would become https://www.youtube.com/watch?v=ID; ${formatCount(plan.remove.length)} extra copy(ies) of the same id would be deleted (oldest kept). ${formatCount(plan.count)} change(s) total. Scan did not rewrite or delete. Apply YouTube normalize & dedupe to commit.`, { source: 'YouTube normalize & dedupe', scan: true });
}

function applyYouTubeNormalize() {
    const plan = collectYouTubeNormalizePlan();
    plan.normalize = plan.normalize.filter(item => bulkPicked('yt-normalize', item.keep.node));
    plan.remove = plan.remove.filter(item => bulkPicked('yt-normalize', item.entry.node));
    plan.count = plan.normalize.length + plan.remove.length;
    if (!plan.count) return alert('Nothing to apply.');
    const n = withUndo('YouTube normalize & dedupe', api => {
        plan.normalize.forEach(item => {
            const oldUri = item.keep.node.uri;
            api.set(item.keep.node, 'uri', item.standardUrl);
            logAffected('MODIFIED', item.keep.node.title, 'YouTube URL normalized to canonical watch URL.', {
                source: 'YouTube normalize & dedupe',
                node: item.keep.node,
                oldUri,
                newUri: item.standardUrl,
                uri: item.standardUrl,
                dateAdded: item.keep.node.dateAdded,
                reason: `Video ID ${item.id}`
            });
        });
        plan.remove.forEach(item => {
            api.remove(item.entry.node, item.entry.parent);
            logAffected('REMOVED', item.entry.node.title, 'Duplicate YouTube video removed; oldest dateAdded kept.', {
                source: 'YouTube normalize & dedupe',
                node: item.entry.node,
                uri: item.entry.node.uri,
                dateAdded: item.entry.node.dateAdded,
                reason: `Video ID ${item.id}. Kept “${item.keep.node.title}”.`
            });
        });
    });
    if (n) {
        markChanged();
        renderSidebar();
    }
    scanYouTubeNormalize();
    alert(`Finished: ${plan.normalize.length} normalized, ${plan.remove.length} duplicate(s) removed.`);
}

function normalizeAndDedupeYouTube() {
    scanYouTubeNormalize();
    applyBulk('yt-normalize');
}

// --- YT Actions ---
function collectYtDuplicateGroups() {
    return [...getYouTubeMap().entries()]
        .filter(([, entries]) => entries.length > 1)
        .map(([id, entries]) => {
            const keep = getOldestYouTubeEntry(entries);
            return { id, keep, entries: entries.slice().sort((a, b) => a === keep ? -1 : b === keep ? 1 : 0) };
        });
}

function runYtDuplicates() {
    if (!bookmarkData) return alert("Library is not loaded.");
    const groups = collectYtDuplicateGroups();
    const container = document.getElementById('yt-dupes-results');
    startBulkPick('yt-dupes');
    const extras = groups.reduce((sum, group) => sum + group.entries.length - 1, 0);
    container.innerHTML = groups.length ? `<p>${formatCount(groups.length)} video id(s) with ${formatCount(extras)} extra cop${extras === 1 ? 'y' : 'ies'}. The oldest copy is kept; uncheck any copy to keep it too.</p>` + groups.map(group => `
        <table class="excel-table">
            <thead>
                <tr><th colspan="3" style="background:#fffac8;">ID: ${escapeHtml(group.id)} (${group.entries.length} dupes)</th></tr>
                <tr><th class="bulk-pick-col"></th><th style="width:35%">Title</th><th>URL</th></tr>
            </thead>
            <tbody>${group.entries.map(entry => `<tr>
                <td>${entry === group.keep ? '' : bulkPickBox('yt-dupes', entry.node)}</td>
                <td>${escapeHtml(entry.node.title || '')}${entry === group.keep ? ' <strong style="color:#20a46a">(oldest — keep)</strong>' : ''}</td>
                <td class="log-url">${escapeHtml(nodeUri(entry.node))}</td>
            </tr>`).join('')}</tbody>
        </table>`).join('') : `<p style="color:green;">No duplicates found.</p>`;
    setBulkPlan('yt-dupes', { count: extras, label: 'Delete duplicate YouTube links', apply: applyYtDuplicates });
}

function applyYtDuplicates() {
    const removes = [];
    collectYtDuplicateGroups().forEach(group => {
        group.entries.forEach(entry => {
            if (entry !== group.keep && bulkPicked('yt-dupes', entry.node)) removes.push({ ...entry, id: group.id });
        });
    });
    withUndo('Delete duplicate YouTube links', api => {
        removes.forEach(entry => {
            api.remove(entry.node, entry.parent);
            logAffected('REMOVED', entry.node.title, 'Deleted duplicate YouTube URL from scan table.', {
                source: 'YouTube duplicate scan',
                node: entry.node,
                uri: nodeUri(entry.node),
                dateAdded: entry.node.dateAdded,
                reason: `Video ID ${entry.id}`
            });
        });
    });
    markChanged();
    renderSidebar();
    runYtDuplicates();
    alert(`Deleted ${formatCount(removes.length)} duplicate YouTube link(s).`);
}

function runYtUnsameTitles() {
    if (!bookmarkData) return alert("Library is not loaded.");
    const ytMap = getYouTubeMap();
    const container = document.getElementById('yt-unsame-results');
    container.innerHTML = '';
    
    let found = 0;
    for (let [id, entries] of ytMap.entries()) {
        if (entries.length > 1) {
            const uniqueTitles = new Set(entries.map(e => comparableYouTubeTitle(e.node.title)));
            if (uniqueTitles.size > 1) {
                found++;
                const table = document.createElement('table');
                table.className = 'excel-table';
                table.innerHTML = `
                    <thead>
                        <tr>
                            <th colspan="3" style="background:#e6f2ff;">ID: ${id} (Mixed Titles)</th>
                        </tr>
                        <tr><th style="width:40%">Title</th><th style="width:40%">URL</th><th style="width:20%">Action</th></tr>
                    </thead>
                    <tbody></tbody>
                `;
                const tbody = table.querySelector('tbody');
                entries.forEach(entry => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td><input type="text" class="yt-title-edit" value="${escapeHtml(entry.node.title || '')}"></td>
                        <td class="log-url">${escapeHtml(entry.node.uri || '')}</td>
                        <td><div class="yt-row-actions">
                            <button type="button" class="apply-btn">Apply edit</button>
                            <button type="button" class="delete-btn">Delete bookmark</button>
                            <button type="button" class="ghost-btn">Show in bookmarks</button>
                        </div></td>
                    `;
                    tr.querySelector('.apply-btn').onclick = () => {
                        const input = tr.querySelector('input').value;
                        const oldTitle = entry.node.title;
                        if (input === oldTitle) return;
                        withUndo('YouTube unsame title', api => {
                            api.set(entry.node, 'title', input);
                            logAffected('MODIFIED', input, 'YouTube bookmark title edited from unsame-titles scan.', {
                                source: 'YouTube unsame titles',
                                node: entry.node,
                                uri: entry.node.uri,
                                oldTitle,
                                newTitle: input,
                                reason: `Video ID ${id}`
                            });
                        });
                        markChanged();
                    };
                    tr.querySelector('.delete-btn').onclick = () => {
                        withUndo('Delete YouTube bookmark', api => {
                            api.remove(entry.node, entry.parent);
                            logAffected('REMOVED', entry.node.title, 'Deleted YouTube bookmark from unsame-titles scan.', {
                                source: 'YouTube unsame titles',
                                node: entry.node,
                                uri: entry.node.uri,
                                reason: `Video ID ${id}`
                            });
                        });
                        tr.remove();
                        if (!tbody.children.length) table.remove();
                        markChanged();
                        renderSidebar();
                    };
                    tr.querySelector('.ghost-btn').onclick = () => {
                        if (typeof revealBookmark === 'function') revealBookmark({ node: entry.node, parent: entry.parent });
                    };
                    tbody.appendChild(tr);
                });
                container.appendChild(table);
            }
        }
    }
    if (found === 0) container.innerHTML = `<p style="color:green;">No unsame titles found.</p>`;
}

function collectYtSuffixHits() {
    const hits = [];
    (function traverse(node) {
        if ((node.typeCode === 1 || node.uri) && extractYouTubeID(node.uri) && node.title && !node.title.trim().endsWith('- YouTube')) {
            hits.push(node);
        }
        node.children?.forEach(traverse);
    })(bookmarkData);
    return hits;
}

function scanYtSuffix() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectYtSuffixHits();
    const box = document.getElementById('yt-suffix-results');
    startBulkPick('yt-suffix');
    const rows = hits.map((node, index) => [
        bulkPickBox('yt-suffix', node),
        escapeHtml(String(index + 1)),
        escapeHtml(node.title || ''),
        escapeHtml(`${node.title.trim()} - YouTube`)
    ]);
    renderYtChangeTable(
        box,
        `${formatCount(hits.length)} title(s) missing the suffix.`,
        [{ pick: 'yt-suffix' }, '#', 'Title now', 'Title after'],
        rows
    );
    setBulkPlan('yt-suffix', { count: hits.length, label: 'YouTube suffix', apply: applyYtSuffix });
    logAffected('SYSTEM', 'YouTube suffix scan', `Scanned YouTube watch titles that do not already end with “ - YouTube”. ${hits.length} title(s) would append that suffix on Apply. Shorts are skipped. Scan did not edit titles.`, { source: 'YouTube suffix repair', scan: true });
}

function applyYtSuffix() {
    const hits = collectYtSuffixHits().filter(node => bulkPicked('yt-suffix', node));
    withUndo('YouTube suffix', api => {
        hits.forEach(node => {
            const old = node.title;
            api.set(node, 'title', node.title.trim() + ' - YouTube');
            logAffected('MODIFIED', node.title, 'Appended missing “ - YouTube” suffix.', {
                source: 'YouTube suffix repair',
                node,
                uri: node.uri,
                oldTitle: old,
                newTitle: node.title
            });
        });
    });
    markChanged();
    scanYtSuffix();
    alert(`Added " - YouTube" suffix to ${hits.length} bookmarks.`);
}

function fixYtSuffix() {
    scanYtSuffix();
    applyBulk('yt-suffix');
}

function isMalformedYouTubeTitle(title) {
    const t = String(title || '');
    if (!t) return false;
    const hasDuration = /^\d{1,2}:\d{2}(?::\d{2})?\b/.test(t);
    const hasViews = /\d[\d,.]*\s*[KMB]?\s*views/i.test(t);
    const hasAgo = /\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago/i.test(t);
    const hasChrome = /Playlist\s*\(/i.test(t) || /Mix\s*\(/i.test(t) || /agoLive/i.test(t);
    return (hasDuration && (hasViews || hasAgo || hasChrome)) || (hasViews && (hasAgo || hasChrome));
}

function cleanMalformedYouTubeTitle(title) {
    let t = String(title || '').trim();
    t = t.replace(/\s*-\s*YouTube\s*$/i, '').trim();
    t = t.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s+/, '');
    t = t.replace(/\s*\d[\d,.]*\s*[KMB]?\s*views\b[\s\S]*$/i, '');
    t = t.replace(/\s*•?\s*\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago[\s\S]*$/i, '');
    t = t.replace(/\s*(Live)?\s*Playlist\s*\([^)]*\)\s*Mix\s*\([^)]*\)\s*$/i, '');
    t = t.replace(/\s*Playlist\s*\([^)]*\)\s*$/i, '');
    t = t.replace(/\s*Mix\s*\([^)]*\)\s*$/i, '');
    t = t.replace(/\s*Live\s*$/i, '');
    const mash = t.match(/^(.*[a-z0-9])([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4})$/);
    if (mash && mash[1].length >= 8) t = mash[1];
    t = t.replace(/\s+/g, ' ').trim();
    if (t) t += ' - YouTube';
    return t;
}

function collectMalformedYtHits() {
    const hits = [];
    (function walk(node, parent, path) {
        const folderPath = displayFolderPath(path.filter(Boolean).join(' / '));
        if (node.uri || node.url) {
            const uri = node.uri || node.url;
            if (extractYouTubeID(uri) && isMalformedYouTubeTitle(node.title)) {
                const next = cleanMalformedYouTubeTitle(node.title);
                hits.push({ node, parent, folderPath, uri, next, changed: next && next !== node.title });
            }
        }
        node.children?.forEach(child => walk(child, node, path.concat(displayFolderTitle(node))));
    })(bookmarkData, null, []);
    return hits;
}

let malformedYtScanHits = [];

function renderMalformedYtTable(hits) {
    const box = document.getElementById('yt-malformed-results');
    if (!box) return;
    if (!hits.length) {
        box.innerHTML = '<p>No malformed YouTube titles matched the watch-page scrape pattern.</p>';
        return;
    }
    box.innerHTML = `
        <p>${formatCount(hits.length)} title${hits.length === 1 ? '' : 's'}. Edit the cleaned title before Clean. A blank field or an unchecked row is skipped.</p>
        <table class="excel-table">
            <thead><tr>${bulkHeaderCell({ pick: 'yt-malformed' })}<th>#</th><th>Current</th><th>Cleaned</th></tr></thead>
            <tbody>
                ${hits.map((hit, i) => `<tr>
                    <td>${bulkPickBox('yt-malformed', hit.node)}</td>
                    <td class="row-num">${i + 1}</td>
                    <td>${escapeHtml(hit.node.title || '')}</td>
                    <td><input type="text" class="yt-title-edit" data-i="${i}" value="${escapeHtml(hit.next || '')}"></td>
                </tr>`).join('')}
            </tbody>
        </table>
    `;
}

function scanMalformedYtTitles() {
    if (!bookmarkData) return alert('Library is not loaded.');
    malformedYtScanHits = collectMalformedYtHits().filter(hit => hit.changed);
    startBulkPick('yt-malformed');
    renderMalformedYtTable(malformedYtScanHits);
    setBulkPlan('yt-malformed', { count: malformedYtScanHits.length, label: 'Malformed YouTube titles', apply: applyMalformedYtTitles });
    logAffected('SYSTEM', 'Malformed YouTube titles', `Scanned watch titles for the watch-page scrape pattern (duration, views, “ago”, Live/Playlist ()/Mix (50+), mashed channel). ${malformedYtScanHits.length} title(s) would clean and restore “ - YouTube”. Edit the cleaned field on the card before Apply; a blank field is skipped. Scan did not edit titles.`, {
        source: 'YouTube title repair',
        scan: true
    });
}

function editedMalformedTitle(hit, index) {
    const box = document.getElementById('yt-malformed-results');
    const input = box?.querySelector(`input.yt-title-edit[data-i="${index}"]`);
    const next = (input ? input.value : hit.next || '').trim();
    return next;
}

function applyMalformedYtTitles() {
    const planned = malformedYtScanHits.map((hit, index) => ({
        ...hit,
        next: editedMalformedTitle(hit, index)
    })).filter(hit => hit.next && hit.next !== (hit.node.title || '') && bulkPicked('yt-malformed', hit.node));
    withUndo('Malformed YouTube titles', api => {
        planned.forEach(hit => {
            const oldTitle = hit.node.title;
            api.set(hit.node, 'title', hit.next);
            logAffected('REPAIR', hit.next, 'Cleaned scraped YouTube watch-page chrome from the title.', {
                source: 'YouTube title repair',
                node: hit.node,
                uri: hit.uri,
                oldTitle,
                newTitle: hit.next,
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    const cleaned = planned.length;
    malformedYtScanHits = collectMalformedYtHits().filter(hit => hit.changed);
    startBulkPick('yt-malformed');
    renderMalformedYtTable(malformedYtScanHits);
    setBulkPlan('yt-malformed', { count: malformedYtScanHits.length, label: 'Malformed YouTube titles', apply: applyMalformedYtTitles });
    alert(`Cleaned ${cleaned} title${cleaned === 1 ? '' : 's'}.`);
}

function cleanMalformedYtTitles() {
    scanMalformedYtTitles();
    applyBulk('yt-malformed');
}
