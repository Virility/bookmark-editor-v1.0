// General repairs — epoch dates, short links, tracking, folders, AMP, titles.
function isEpochBookmarkNode(node) {
    if (!node || node.children || node.typeCode === 2 || node.type === 'folder') return false;
    return Boolean(node.uri || node.url || node.typeCode === 1 || node.type === 'url');
}

function firstHealthyDate(node) {
    const fields = ['lastModified', 'dateLastUsed', 'date_last_used', 'lastUsed'];
    for (const field of fields) {
        if (dateValueWallMs(node[field]) != null) return { field, value: node[field] };
    }
    return null;
}

function inferTreeDateStyle() {
    let style = 'firefox';
    let best = 0;
    function consider(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < NETSCAPE_ADD_DATE_MAX) return;
        const rank = n > 1e16 ? 3 : n > 1e14 ? 2 : 1;
        if (rank > best) {
            best = rank;
            style = n > 1e16 ? 'webkit' : n > 1e14 ? 'firefox' : 'chrome-ms';
        }
    }
    walkBookmarkTree(bookmarkData, node => {
        consider(node.dateAdded ?? node.date_added);
        consider(node.lastModified ?? node.dateModified ?? node.date_modified);
    });
    return style;
}

function toStoredDate(oldValue, ms, fallbackStyle) {
    const n = Number(oldValue);
    const style = (Number.isFinite(n) && n >= NETSCAPE_ADD_DATE_MAX)
        ? (n > 1e16 ? 'webkit' : n > 1e14 ? 'firefox' : 'chrome-ms')
        : (fallbackStyle || inferTreeDateStyle());
    if (style === 'webkit') return Math.round((ms + 11644473600000) * 1000);
    if (style === 'chrome-ms') return Math.round(ms);
    return Math.round(ms * 1000);
}

function collectRepairTargets(predicate) {
    const hits = [];
    walkBookmarkTree(bookmarkData, (node, parent, path) => {
        if (predicate(node)) hits.push({ node, parent, folderPath: displayFolderPath(path.join(' / ') || displayFolderTitle(bookmarkData)) });
    });
    return hits;
}

const REPAIR_PREVIEW_LIMIT = 250;

function renderRepairPreview(boxId, emptyText, summary, headers, rows) {
    const box = document.getElementById(boxId);
    if (!box) return;
    if (!rows.length) {
        box.innerHTML = `<p>${escapeHtml(emptyText)}</p>`;
        return;
    }
    const shown = rows.slice(0, REPAIR_PREVIEW_LIMIT);
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

function epochRepairPreview(node, nowMs, fallbackStyle) {
    const oldDate = node.dateAdded ?? node.date_added;
    const healthy = firstHealthyDate(node);
    const stored = healthy ? healthy.value : toStoredDate(oldDate, nowMs, fallbackStyle);
    const note = healthy ? `Copied ${healthy.field}` : 'No healthy lastModified; set to now';
    return {
        before: formatBookmarkDate(oldDate),
        after: `${formatBookmarkDate(stored)} — ${note}`
    };
}

function scanEpochDates() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectRepairTargets(node => isEpochBookmarkNode(node) && isEpochDateValue(node.dateAdded ?? node.date_added));
    const nowMs = Date.now();
    const fallbackStyle = inferTreeDateStyle();
    startBulkPick('epoch');
    renderRepairPreview(
        'repairs-epoch-results',
        'No Unix-second, missing, or 12/31/69 dateAdded values on bookmarks.',
        `${formatCount(hits.length)} bookmark(s) would get a new dateAdded.`,
        [{ pick: 'epoch' }, '#', 'Title', 'Before', 'After'],
        hits.map((hit, index) => {
            const preview = epochRepairPreview(hit.node, nowMs, fallbackStyle);
            return [
                bulkPickBox('epoch', hit.node),
                escapeHtml(String(index + 1)),
                escapeHtml(hit.node.title || 'Untitled'),
                escapeHtml(preview.before),
                escapeHtml(preview.after)
            ];
        })
    );
    setBulkPlan('epoch', { count: hits.length, label: 'Replace Unix-second dateAdded with lastModified', apply: applyEpochDates });
    logAffected('SYSTEM', 'Unix-second dateAdded scan', `Scanned dateAdded values. ${formatCount(hits.length)} bookmark(s) have missing, zero, NaN, Netscape Unix-second (< 1e11), or pre-2 Jan 1970 UTC dates (Firefox shows 12/31/69). JSON Apply copies lastModified, else dateLastUsed, else now. Live is scan-only (the WebExtensions API cannot write dateAdded). Scan did not change dates.`, {
        source: 'General repairs',
        scan: true,
        reason: 'dateAdded missing, zero, NaN, Netscape Unix seconds (< 1e11), or before 2 Jan 1970 UTC'
    });
}

function applyEpochDates() {
    if (typeof isLiveBookmarks === 'function' && isLiveBookmarks()) {
        alert('Firefox and Chrome extensions cannot write dateAdded. Scan still lists Unix-second / 12/31/69 values; repair is JSON-only and was removed with import/export.');
        return;
    }
    const hits = collectRepairTargets(node => isEpochBookmarkNode(node) && isEpochDateValue(node.dateAdded ?? node.date_added))
        .filter(hit => bulkPicked('epoch', hit.node));
    const nowMs = Date.now();
    const fallbackStyle = inferTreeDateStyle();
    withUndo('Replace Unix-second dateAdded with lastModified', api => {
        hits.forEach(hit => {
            const oldDate = hit.node.dateAdded ?? hit.node.date_added;
            const healthy = firstHealthyDate(hit.node);
            const field = ('dateAdded' in hit.node || hit.node.date_added == null) ? 'dateAdded' : 'date_added';
            const stored = healthy ? healthy.value : toStoredDate(oldDate, nowMs, fallbackStyle);
            api.set(hit.node, field, stored);
            const reason = healthy
                ? `Copied ${healthy.field}`
                    : 'No healthy lastModified; set to now.';
            logAffected('REPAIR', hit.node.title, 'Replaced Unix-second or missing dateAdded (Firefox shows 12/31/69).', {
                source: 'General repairs',
                node: hit.node,
                uri: hit.node.uri || hit.node.url,
                folderPath: hit.folderPath,
                oldDateAdded: oldDate,
                newDateAdded: stored,
                reason
            });
        });
    });
    markChanged();
    scanEpochDates();
    alert(`Repaired ${formatCount(hits.length)} date${hits.length === 1 ? '' : 's'}. Export to keep the fix.`);
}

function repairEpochDates() {
    scanEpochDates();
    applyBulk('epoch');
}

function collectBrokenLinkHits() {
    return collectRepairTargets(node => {
        const uri = node.uri || node.url || '';
        const title = node.title || '';
        if (!uri && !(node.children || node.typeCode === 2)) return /broken/i.test(title);
        if (!uri && (node.children || node.typeCode === 2)) return /broken/i.test(title);
        if (/broken/i.test(title) || /broken/i.test(uri)) return true;
        if (!uri && node.typeCode === 1) return true;
        try {
            const parsed = new URL(uri);
            return ['', 'about:blank', 'about:invalid'].includes(parsed.href) || parsed.protocol === 'javascript:';
        } catch (e) {
            return Boolean(uri);
        }
    });
}

function isBrokenDeletable(hit) {
    return Boolean(hit.parent) && !isBookmarkFolderNode(hit.node);
}

function scanBrokenLinks() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectBrokenLinkHits();
    const deletable = hits.filter(isBrokenDeletable);
    startBulkPick('broken');
    renderRepairPreview(
        'repairs-broken-results',
        'No broken titles or unparseable URLs found.',
        `${formatCount(hits.length)} item(s). ${formatCount(deletable.length)} bookmark(s) can be deleted; folders are listed only.`,
        [{ pick: 'broken' }, '#', 'Title', 'URL', 'Folder'],
        hits.map((hit, index) => [
            isBrokenDeletable(hit) ? bulkPickBox('broken', hit.node) : '',
            escapeHtml(String(index + 1)),
            escapeHtml(hit.node.title || 'Untitled'),
            `<span class="log-url">${escapeHtml(hit.node.uri || hit.node.url || '—')}</span>`,
            escapeHtml(hit.folderPath)
        ])
    );
    setBulkPlan('broken', { count: deletable.length, label: 'Delete broken bookmarks', apply: applyBrokenLinks });
    logAffected('SYSTEM', 'Broken link scan', `Scanned titles and URLs. ${hits.length} item(s) look broken: empty href, javascript:, new URL() fails, or the word “broken” in the title/URL. Listed under General repairs. Scan did not delete or rewrite anything.`, {
        source: 'General repairs',
        scan: true
    });
}

function applyBrokenLinks() {
    const hits = collectBrokenLinkHits().filter(hit => isBrokenDeletable(hit) && bulkPicked('broken', hit.node));
    withUndo('Delete broken bookmarks', api => {
        hits.forEach(hit => {
            api.remove(hit.node, hit.parent);
            logAffected('REMOVED', hit.node.title, 'Deleted broken bookmark from the General repairs scan.', {
                source: 'General repairs',
                node: hit.node,
                uri: hit.node.uri || hit.node.url,
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    renderSidebar();
    scanBrokenLinks();
    alert(`Deleted ${formatCount(hits.length)} broken bookmark(s).`);
}

function planShortLinkExpand(uri) {
    let host = '';
    let pathname = '';
    let search = '';
    try {
        const url = new URL(uri);
        host = url.hostname.toLowerCase().replace(/^www\./, '');
        pathname = url.pathname;
        search = url.search;
    } catch (e) {
        const match = String(uri || '').match(/^https?:\/\/([^/?#:]+)([^?#]*)(\?[^#]*)?/i);
        if (!match) return null;
        host = match[1].toLowerCase().replace(/^www\./, '');
        pathname = match[2] || '/';
        search = match[3] || '';
    }
    if (host === 'youtu.be') {
        const id = pathname.split('/').filter(Boolean)[0];
        if (id) return { next: `https://www.youtube.com/watch?v=${id}`, reason: 'youtu.be → youtube.com/watch', expandable: true };
    }
    if (host === 'm.youtube.com') {
        return { next: `https://www.youtube.com${pathname}${search}`, reason: 'm.youtube.com → www.youtube.com', expandable: true };
    }
    if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && pathname.startsWith('/embed/')) {
        const id = pathname.split('/')[2];
        if (id) return { next: `https://www.youtube.com/watch?v=${id}`, reason: 'embed → watch', expandable: true };
    }
    if (host === 'redd.it') {
        const id = pathname.split('/').filter(Boolean)[0];
        if (id) return { next: `https://www.reddit.com/comments/${id}`, reason: 'redd.it → reddit.com/comments', expandable: true };
    }
    if (host.includes('.m.wikipedia.org') || host === 'm.wikipedia.org') {
        const canon = host.replace('.m.wikipedia.org', '.wikipedia.org').replace(/^m\.wikipedia\.org$/, 'wikipedia.org');
        return { next: `https://${canon}${pathname}${search}`, reason: 'mobile Wikipedia → desktop host', expandable: true };
    }
    if (host === 't.co') return { next: uri, reason: 't.co cannot be expanded offline', expandable: false };
    if (host === 'amzn.to') return { next: uri, reason: 'amzn.to cannot be expanded offline', expandable: false };
    return null;
}

function collectShortLinkHits() {
    const hits = [];
    collectRepairTargets(node => Boolean(node.uri || node.url)).forEach(hit => {
        const plan = planShortLinkExpand(hit.node.uri || hit.node.url);
        if (plan) hits.push({ ...hit, plan });
    });
    return hits;
}

function renderShortLinkTable(hits) {
    const expandable = hits.filter(hit => hit.plan.expandable && hit.plan.next !== (hit.node.uri || hit.node.url));
    startBulkPick('short');
    renderRepairPreview(
        'repairs-short-results',
        'No short or mobile-host links matched the offline rules.',
        `${formatCount(expandable.length)} URL(s) would expand. ${formatCount(hits.length - expandable.length)} listed only (t.co / amzn.to).`,
        [{ pick: 'short' }, '#', 'Title', 'Before', 'After'],
        hits.map((hit, index) => [
            expandable.includes(hit) ? bulkPickBox('short', hit.node) : '',
            escapeHtml(String(index + 1)),
            escapeHtml(hit.node.title || 'Untitled'),
            `<span class="log-url">${escapeHtml(hit.node.uri || hit.node.url)}</span>`,
            hit.plan.expandable
                ? `<span class="log-url">${escapeHtml(hit.plan.next)}</span>`
                : escapeHtml(hit.plan.reason)
        ])
    );
}

function scanShortLinks() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectShortLinkHits();
    const expandable = hits.filter(hit => hit.plan.expandable && hit.plan.next !== (hit.node.uri || hit.node.url));
    renderShortLinkTable(hits);
    setBulkPlan('short', { count: expandable.length, label: 'Short-link expand', apply: applyShortLinks });
    logAffected('SYSTEM', 'Short-link scan', `Scanned for short or mobile URLs. ${hits.length} bookmark(s) matched youtu.be, YouTube embed/mobile, redd.it, *.m.wikipedia.org, t.co, or amzn.to. Expandable hosts rewrite to canonical URLs on Apply; t.co / amzn.to are listed only. Scan did not change URLs.`, {
        source: 'General repairs',
        scan: true
    });
}

function applyShortLinks() {
    const hits = collectShortLinkHits().filter(hit => hit.plan.expandable && hit.plan.next !== (hit.node.uri || hit.node.url) && bulkPicked('short', hit.node));
    withUndo('Short-link expand', api => {
        hits.forEach(hit => {
            const oldUri = hit.node.uri || hit.node.url;
            api.set(hit.node, 'uri' in hit.node ? 'uri' : 'url', hit.plan.next);
            logAffected('REPAIR', hit.node.title, 'Expanded short/mobile URL with an offline rule.', {
                source: 'General repairs',
                node: hit.node,
                oldUri,
                newUri: hit.plan.next,
                uri: hit.plan.next,
                folderPath: hit.folderPath,
                reason: hit.plan.reason
            });
        });
    });
    markChanged();
    renderShortLinkTable(collectShortLinkHits());
    alert(`Expanded ${hits.length} URL${hits.length === 1 ? '' : 's'}. Export to keep the fix.`);
}

function expandShortLinks() {
    scanShortLinks();
    applyBulk('short');
}

// trackingParamKeys lives in js/bookmark-lib.js, with the copies that use the same rule.

function collectTrackingHits() {
    const hits = [];
    collectRepairTargets(node => Boolean(node.uri || node.url)).forEach(hit => {
        const uri = hit.node.uri || hit.node.url;
        try {
            const url = new URL(uri);
            const params = trackingParamKeys(url);
            if (!params.length) return;
            params.forEach(param => url.searchParams.delete(param.key));
            hits.push({
                ...hit,
                uri,
                next: url.toString(),
                drop: params.map(param => param.key),
                params
            });
        } catch (e) {}
    });
    return hits;
}


// --- Find and replace ---
let findReplaceHits = [];

function replaceScopeRoots() {
    const scope = document.getElementById('repairs-replace-scope')?.value || 'library';
    if (scope === 'selection') return librarySelection.length ? librarySelection.slice() : [];
    if (scope === 'folder') return currentFolder ? [currentFolder] : [];
    return bookmarkData ? [bookmarkData] : [];
}

function findReplacePattern() {
    const pattern = document.getElementById('repairs-find')?.value || '';
    if (!pattern) return null;
    const flags = document.getElementById('repairs-replace-case')?.checked ? 'g' : 'gi';
    try {
        return new RegExp(pattern, flags);
    } catch (err) {
        alert(`That is not a valid regular expression: ${err.message}`);
        return null;
    }
}

function collectFindReplaceHits() {
    const re = findReplacePattern();
    if (!re) return [];
    const fields = document.getElementById('repairs-replace-fields')?.value || 'title';
    const replacement = document.getElementById('repairs-replace-with')?.value || '';
    const roots = replaceScopeRoots();
    if (!roots.length) return [];
    const seen = new Set();
    const hits = [];
    const walk = node => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        const next = {};
        if (fields !== 'url' && node.title) {
            const replaced = String(node.title).replace(re, replacement);
            if (replaced !== node.title) next.title = replaced;
        }
        const uri = nodeUri(node);
        if (fields !== 'title' && uri) {
            const replaced = uri.replace(re, replacement);
            if (replaced !== uri) next.uri = replaced;
        }
        if (Object.keys(next).length) {
            hits.push({ node, folderPath: folderPathFor(node), beforeTitle: node.title || '', beforeUri: uri, next });
        }
        (node.children || []).forEach(walk);
    };
    roots.forEach(walk);
    return hits;
}

function scanFindReplace() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const pattern = document.getElementById('repairs-find')?.value || '';
    if (!pattern) return alert('Type a pattern to find first.');
    findReplaceHits = collectFindReplaceHits();
    startBulkPick('replace');
    renderRepairPreview(
        'repairs-replace-results',
        'Nothing in that scope matches the pattern.',
        `${formatCount(findReplaceHits.length)} entry(ies) would change.`,
        [{ pick: 'replace' }, 'Title now', 'URL now', 'After'],
        findReplaceHits.map(hit => [
            bulkPickBox('replace', hit.node),
            escapeHtml(hit.beforeTitle || 'Untitled'),
            `<span class="log-url">${escapeHtml(hit.beforeUri || '')}</span>`,
            escapeHtml(hit.next.title !== undefined ? hit.next.title : hit.next.uri)
        ])
    );
    setBulkPlan('replace', { count: findReplaceHits.length, label: 'Find and replace', apply: applyFindReplace });
    logAffected('SYSTEM', 'Find and replace scan', `Scanned ${escapeHtml(pattern)} over ${document.getElementById('repairs-replace-fields')?.value || 'title'} in ${document.getElementById('repairs-replace-scope')?.value || 'library'}. ${formatCount(findReplaceHits.length)} entry(ies) would change. Scan did not change anything.`, { source: 'General repairs', scan: true });
}

function applyFindReplace() {
    const hits = findReplaceHits.filter(hit => bulkPicked('replace', hit.node));
    if (!hits.length) return;
    withUndo('Find and replace', api => {
        hits.forEach(hit => {
            if (hit.next.title !== undefined) api.set(hit.node, 'title', hit.next.title);
            if (hit.next.uri !== undefined) api.set(hit.node, 'uri' in hit.node ? 'uri' : 'url', hit.next.uri);
            logAffected('REPAIR', hit.next.title || hit.beforeTitle || 'Entry', 'Find and replace changed this entry.', {
                source: 'Find and replace',
                node: hit.node,
                oldTitle: hit.beforeTitle,
                newTitle: hit.next.title,
                oldUri: hit.beforeUri,
                newUri: hit.next.uri,
                uri: nodeUri(hit.node),
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    scanFindReplace();
    alert(`Replaced in ${formatCount(hits.length)} entry(ies). The whole run is one undo step.`);
}

// --- Same title and domain ---
let sameTitleExtras = [];

function collectSameTitleGroups() {
    const groups = new Map();
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const uri = nodeUri(link);
        const title = String(link.title || '').trim().toLowerCase();
        if (!uri || !title) return;
        let host = '';
        try {
            const hostname = new URL(uri).hostname.toLowerCase().replace(/^www\./, '');
            host = typeof parentDomainFromHost === 'function' ? (parentDomainFromHost(hostname) || hostname) : hostname;
        } catch (err) {
            host = '';
        }
        if (!host) return;
        const key = `${host}::${title}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(link);
    });
    const rows = [];
    groups.forEach(links => {
        if (links.length < 2) return;
        // Compare the URLs as saved, not the tracking-stripped key: the whole point of this
        // scan is the same page saved with different parameters, which the duplicate scan
        // deliberately treats as one URL. Identical URLs are the duplicate scan's job.
        const keys = new Set(links.map(link => String(nodeUri(link)).trim().toLowerCase().replace(/#.*$/, '')));
        if (keys.size < 2) return;
        // Keep the first copy that carries no tracking parameters, so the clean URL survives
        // and the parameterised copies are the ones offered for deletion.
        const keeper = links.find(link => typeof stripTrackingParams === 'function' && stripTrackingParams(nodeUri(link)) === nodeUri(link)) || links[0];
        rows.push([keeper, ...links.filter(link => link !== keeper)]);
    });
    return rows;
}

function scanSameTitleDomain() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const groups = collectSameTitleGroups();
    sameTitleExtras = [];
    const rows = [];
    groups.forEach(links => {
        const [keep, ...extras] = links;
        extras.forEach(extra => sameTitleExtras.push(extra));
        rows.push([
            bulkPickBox('sametitle', keep, 0),
            escapeHtml(String(keep.title || '').trim() || 'Untitled'),
            `<span class="log-url">${escapeHtml(nodeUri(keep))}</span>`,
            escapeHtml(folderPathFor(keep)),
            `<span class="menu-stat-total">keeps</span>`
        ]);
        extras.forEach(extra => {
            rows.push([
                bulkPickBox('sametitle', extra),
                escapeHtml(String(extra.title || '').trim() || 'Untitled'),
                `<span class="log-url">${escapeHtml(nodeUri(extra))}</span>`,
                escapeHtml(folderPathFor(extra)),
                ''
            ]);
        });
    });
    startBulkPick('sametitle');
    renderRepairPreview(
        'repairs-sametitle-results',
        'No two bookmarks share a title and domain with different URLs.',
        `${formatCount(groups.length)} group(s), ${formatCount(sameTitleExtras.length)} extra copy(ies). The first copy of each group is kept and cannot be checked.`,
        [{ pick: 'sametitle' }, 'Title', 'URL', 'Folder', ''],
        rows
    );
    setBulkPlan('sametitle', { count: sameTitleExtras.length, label: 'Delete same-title copies', apply: applySameTitleDomain });
    logAffected('SYSTEM', 'Same title and domain scan', `Scanned ${formatCount(groups.length)} group(s) of bookmarks that share a title and parent domain but not a URL; ${formatCount(sameTitleExtras.length)} extra copy(ies) could be deleted. Scan did not change anything.`, { source: 'General repairs', scan: true });
}

function applySameTitleDomain() {
    const victims = sameTitleExtras.filter(link => bulkPicked('sametitle', link));
    if (!victims.length) return;
    withUndo('Delete same-title copies', api => {
        victims.forEach(link => {
            const parent = findNodeParent(link);
            if (!parent) return;
            api.remove(link, parent);
            logAffected('REMOVED', link.title || 'Untitled', 'Deleted a bookmark that shared its title and domain with another copy.', {
                source: 'Same title and domain',
                node: link,
                uri: nodeUri(link),
                folderPath: folderPathFor(parent)
            });
        });
    });
    markChanged();
    renderSidebar();
    scanSameTitleDomain();
    alert(`Deleted ${formatCount(victims.length)} copy(ies). Undo restores them.`);
}

// --- Library health ---
function libraryHealthRows() {
    const rows = [];
    const add = (label, count, jump, safe) => rows.push({ label, count, jump: jump || '', safe: Boolean(safe) });
    add('Tracking parameters', typeof collectTrackingHits === 'function' ? collectTrackingHits().length : 0, 'scanTrackingParams', true);
    add('Empty folders', typeof planEmptyFolderRemoval === 'function' ? planEmptyFolderRemoval(bookmarkData).length : 0, 'showRemoveEmptyFolders', true);
    add('Same title and domain', collectSameTitleGroups().reduce((sum, group) => sum + group.length - 1, 0), 'scanSameTitleDomain', false);
    add('Short or mobile links', typeof collectShortLinkHits === 'function' ? collectShortLinkHits().filter(hit => hit.plan && hit.plan.expandable).length : 0, 'scanShortLinks', false);
    add('AMP host links', typeof collectAmpHostHits === 'function' ? collectAmpHostHits().length : 0, 'scanAmpHosts', false);
    add('Escaped entities in titles', typeof collectEntityTitleHits === 'function' ? collectEntityTitleHits().length : 0, 'scanEntityTitles', false);
    add('Broken links found earlier', typeof collectBrokenLinkHits === 'function' ? collectBrokenLinkHits().length : 0, 'scanBrokenLinks', false);
    return rows;
}

let libraryHealthRowsCache = [];

function scanLibraryHealth() {
    if (!bookmarkData) return alert('Library is not loaded.');
    libraryHealthRowsCache = libraryHealthRows();
    const total = libraryHealthRowsCache.reduce((sum, row) => sum + row.count, 0);
    const box = document.getElementById('repairs-health-results');
    if (box) {
        box.innerHTML = `<p>${total ? `${formatCount(total)} finding(s) across ${formatCount(libraryHealthRowsCache.filter(row => row.count).length)} scan(s).` : 'Nothing found: every scan came back clean.'}</p>
            <table class="excel-table"><thead><tr><th>Scan</th><th>Count</th><th>Open</th></tr></thead><tbody>
            ${libraryHealthRowsCache.map(row => `<tr>
                <td>${escapeHtml(row.label)}</td>
                <td class="stats-num">${formatCount(row.count)}</td>
                <td>${row.jump && row.count ? `<button type="button" class="ghost-btn" data-health-jump="${escapeHtml(row.jump)}">Scan</button>` : '—'}</td>
            </tr>`).join('')}
            </tbody></table>`;
        box.querySelectorAll('[data-health-jump]').forEach(btn => {
            btn.onclick = () => {
                const fn = window[btn.dataset.healthJump];
                if (typeof fn === 'function') fn();
            };
        });
    }
    const fix = document.getElementById('repairs-health-fix');
    const safeCount = libraryHealthRowsCache.filter(row => row.safe).reduce((sum, row) => sum + row.count, 0);
    if (fix) {
        fix.disabled = !safeCount;
        fix.textContent = safeCount ? `Fix safe ones (${formatCount(safeCount)})` : 'Fix safe ones';
    }
    logAffected('SYSTEM', 'Library health scan', `Counted ${formatCount(total)} finding(s): ${libraryHealthRowsCache.map(row => `${row.label} ${row.count}`).join(', ')}. Scan did not change anything.`, { source: 'General repairs', scan: true });
}

function applyHealthFixes() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const tracking = typeof collectTrackingHits === 'function' ? collectTrackingHits() : [];
    const empties = typeof planEmptyFolderRemoval === 'function' ? planEmptyFolderRemoval(bookmarkData) : [];
    if (!tracking.length && !empties.length) return alert('Nothing in the safe set needs fixing.');
    if (!confirm(`Fix ${formatCount(tracking.length)} tracked URL(s) and remove ${formatCount(empties.length)} empty folder(s)? One undo step.`)) return;
    let changed = 0;
    withUndo('Fix safe health findings', api => {
        tracking.forEach(hit => {
            api.set(hit.node, 'uri' in hit.node ? 'uri' : 'url', hit.next);
            logAffected('REPAIR', hit.node.title, `Stripped ${hit.drop.join(', ')}.`, { source: 'Library health', node: hit.node, oldUri: hit.uri, newUri: hit.next, uri: hit.next, folderPath: hit.folderPath });
            changed += 1;
        });
        empties.forEach(entry => {
            const node = entry.node || entry.folder || entry;
            const parent = findNodeParent(node);
            if (!parent) return;
            api.remove(node, parent);
            logAffected('REMOVED', node.title || 'Empty folder', 'Removed an empty folder.', { source: 'Library health', node, folderPath: folderPathFor(parent) });
            changed += 1;
        });
    });
    markChanged();
    renderSidebar();
    scanLibraryHealth();
    alert(`Fixed ${formatCount(changed)} finding(s). One Undo reverses the whole run.`);
}

function scanTrackingParams() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectTrackingHits();
    startBulkPick('tracking');
    renderRepairPreview(
        'repairs-tracking-results',
        'No tracking parameters found.',
        `${formatCount(hits.length)} URL(s) with trackers to strip.`,
        [{ pick: 'tracking' }, '#', 'Title', 'Before', 'After', 'Stripped'],
        hits.map((hit, index) => [
            bulkPickBox('tracking', hit.node),
            escapeHtml(String(index + 1)),
            escapeHtml(hit.node.title || 'Untitled'),
            `<span class="log-url">${escapeHtml(hit.uri)}</span>`,
            `<span class="log-url">${escapeHtml(hit.next)}</span>`,
            escapeHtml(hit.params.map(param => `${param.key}=${param.value}`).join(', '))
        ])
    );
    setBulkPlan('tracking', { count: hits.length, label: 'Tracking-parameter strip', apply: applyTrackingParams });
    logAffected('SYSTEM', 'Tracking param scan', `Scanned query strings for utm_* plus ${getActiveUrlRules().filter(rule => rule.kind === 'params' && rule.enabled !== false).map(rule => rule.name || rule.value).join(', ')}. ${hits.length} URL(s) would drop those parameters on Apply. Scan did not change URLs.`, { source: 'General repairs', scan: true });
}

function applyTrackingParams() {
    const hits = collectTrackingHits().filter(hit => bulkPicked('tracking', hit.node));
    withUndo('Tracking-parameter strip', api => {
        hits.forEach(hit => {
            const field = 'uri' in hit.node ? 'uri' : 'url';
            api.set(hit.node, field, hit.next);
            logAffected('REPAIR', hit.node.title, `Stripped ${hit.drop.join(', ')}.`, {
                source: 'General repairs',
                node: hit.node,
                oldUri: hit.uri,
                newUri: hit.next,
                uri: hit.next,
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    scanTrackingParams();
    alert(`Stripped tracking parameters from ${hits.length} URL${hits.length === 1 ? '' : 's'}.`);
}

function folderMergeKey(node) {
    return displayFolderTitle(node).trim().replace(/^\/?r\//i, '').toLowerCase();
}

function collectDuplicateFolderMerges() {
    const merges = [];
    (function walk(parent) {
        if (!parent?.children) return;
        const groups = new Map();
        parent.children.forEach(child => {
            if (!isBookmarkFolder(child)) return;
            const key = folderMergeKey(child);
            if (!key) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(child);
        });
        groups.forEach(folders => {
            if (folders.length < 2) return;
            const keep = folders.slice().sort((a, b) => (Number(a.dateAdded) || 0) - (Number(b.dateAdded) || 0))[0];
            folders.filter(folder => folder !== keep).forEach(folder => {
                merges.push({ parent, keep, folder, count: (folder.children || []).length });
            });
        });
        parent.children.forEach(child => walk(child));
    })(bookmarkData);
    return merges;
}

function scanDuplicateFolders() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const merges = collectDuplicateFolderMerges();
    startBulkPick('dup-folders');
    renderRepairPreview(
        'repairs-dup-folders-results',
        'No duplicate sibling folders.',
        `${formatCount(merges.length)} extra folder(s) would merge into the older folder.`,
        [{ pick: 'dup-folders' }, '#', 'Before', 'After'],
        merges.map((item, index) => [
            bulkPickBox('dup-folders', item.folder),
            escapeHtml(String(index + 1)),
            escapeHtml(`${displayFolderTitle(item.folder)} (${formatCount(item.count)} item${item.count === 1 ? '' : 's'})`),
            escapeHtml(`Merged into ${displayFolderTitle(item.keep)}`)
        ])
    );
    setBulkPlan('dup-folders', { count: merges.length, label: 'Merge duplicate folders', apply: applyDuplicateFolders });
    logAffected('SYSTEM', 'Duplicate folder scan', `Scanned sibling folders that share a merge key (display title, r/ prefix stripped, lowercased — so news and r/news match). ${merges.length} extra folder(s) would merge into the older sibling: children move over, then the empty extra is removed. Scan did not merge. Apply Merge duplicate folders to commit.`, { source: 'General repairs', scan: true });
}

function applyDuplicateFolders() {
    const merges = collectDuplicateFolderMerges().filter(item => bulkPicked('dup-folders', item.folder));
    withUndo('Merge duplicate folders', api => {
        merges.forEach(item => {
            [...(item.folder.children || [])].forEach(child => api.move(child, item.folder, item.keep));
            api.remove(item.folder, item.parent);
            logAffected('MODIFIED', displayFolderTitle(item.keep), `Merged “${displayFolderTitle(item.folder)}” into “${displayFolderTitle(item.keep)}”.`, {
                source: 'General repairs',
                node: item.keep
            });
        });
    });
    markChanged();
    renderSidebar();
    scanDuplicateFolders();
    alert(`Merged ${formatCount(merges.length)} duplicate folder${merges.length === 1 ? '' : 's'}.`);
}

function canonicalUrlKey(uri) {
    try {
        const url = new URL(uri);
        let host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'old.reddit.com' || host === 'm.reddit.com' || host === 'np.reddit.com') host = 'reddit.com';
        let path = decodeURIComponent(url.pathname || '/').replace(/\/amp(?=\/|$)/gi, '');
        path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
        return `${url.protocol}//${host}${path}`;
    } catch (e) {
        return uri;
    }
}

function collectCanonicalDupes() {
    const groups = new Map();
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const key = canonicalUrlKey(link.uri);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(link);
    });
    const dupes = [];
    groups.forEach(items => {
        if (items.length < 2) return;
        const hrefs = new Set(items.map(item => item.uri));
        if (hrefs.size < 2) return;
        const keep = items.slice().sort((a, b) => (a.addedMs || 0) - (b.addedMs || 0) || a.uri.length - b.uri.length)[0];
        items.filter(item => item.node !== keep.node).forEach(item => dupes.push({ ...item, keep, key: canonicalUrlKey(keep.uri) }));
    });
    return dupes;
}

function scanCanonicalDupes() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const dupes = collectCanonicalDupes();
    startBulkPick('canon-dupes');
    renderRepairPreview(
        'repairs-canon-results',
        'No same-path / different-query duplicates.',
        `${formatCount(dupes.length)} extra bookmark(s) would be removed. The oldest URL is kept.`,
        [{ pick: 'canon-dupes' }, '#', 'Title', 'Before', 'After'],
        dupes.map((item, index) => [
            bulkPickBox('canon-dupes', item.node),
            escapeHtml(String(index + 1)),
            escapeHtml(item.title || 'Untitled'),
            `<span class="log-url">${escapeHtml(item.uri)}</span>`,
            `<span class="log-url">${escapeHtml(item.keep.uri)}</span>`
        ])
    );
    setBulkPlan('canon-dupes', { count: dupes.length, label: 'Canonical path duplicates', apply: applyCanonicalDupes });
    logAffected('SYSTEM', 'Canonical dupe scan', `Scanned bookmarks that share host + path after www. and AMP path stripping (old/m/np.reddit.com count as reddit.com) but differ in query string. ${formatCount(dupes.length)} extra bookmark(s) would be removed; the oldest URL is kept. Scan did not delete. Apply Canonical path duplicates to remove extras.`, { source: 'General repairs', scan: true });
}

function applyCanonicalDupes() {
    const dupes = collectCanonicalDupes().filter(item => bulkPicked('canon-dupes', item.node));
    withUndo('Canonical path duplicates', api => {
        dupes.forEach(item => {
            api.remove(item.node, item.parent);
            logAffected('REMOVED', item.title, `Same path as “${item.keep.title}”.`, { source: 'General repairs', node: item.node, uri: item.uri });
        });
    });
    markChanged();
    renderSidebar();
    scanCanonicalDupes();
    alert(`Removed ${formatCount(dupes.length)} same-path duplicate(s).`);
}

function planAmpHostFix(uri) {
    try {
        const url = new URL(uri);
        const host = url.hostname.toLowerCase();
        let changed = false;
        if (/^(old|m|np)\.reddit\.com$/i.test(host)) {
            url.hostname = 'www.reddit.com';
            changed = true;
        }
        const nextPath = url.pathname.replace(/\/amp(?=\/|$)/gi, '').replace(/\/{2,}/g, '/') || '/';
        if (nextPath !== url.pathname) {
            url.pathname = nextPath;
            changed = true;
        }
        return changed ? url.toString() : null;
    } catch (e) {
        return null;
    }
}

function collectAmpHostHits() {
    const hits = [];
    collectRepairTargets(node => Boolean(node.uri || node.url)).forEach(hit => {
        const uri = hit.node.uri || hit.node.url;
        const next = planAmpHostFix(uri);
        if (next && next !== uri) hits.push({ ...hit, uri, next });
    });
    return hits;
}

function scanAmpHosts() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectAmpHostHits();
    startBulkPick('amp-host');
    renderRepairPreview(
        'repairs-amp-results',
        'No /amp/ or old.reddit.com hosts.',
        `${formatCount(hits.length)} URL(s) would be rewritten.`,
        [{ pick: 'amp-host' }, '#', 'Title', 'Before', 'After'],
        hits.map((hit, index) => [
            bulkPickBox('amp-host', hit.node),
            escapeHtml(String(index + 1)),
            escapeHtml(hit.node.title || 'Untitled'),
            `<span class="log-url">${escapeHtml(hit.uri)}</span>`,
            `<span class="log-url">${escapeHtml(hit.next)}</span>`
        ])
    );
    setBulkPlan('amp-host', { count: hits.length, label: 'AMP / old.reddit rewrite', apply: applyAmpHosts });
    logAffected('SYSTEM', 'AMP/old reddit scan', `Scanned URLs for /amp in the path and old.reddit.com / m.reddit.com / np.reddit.com hosts. ${formatCount(hits.length)} URL(s) would drop /amp and rewrite those Reddit hosts to www.reddit.com. Scan did not change URLs. Apply AMP / old.reddit rewrite to commit.`, { source: 'General repairs', scan: true });
}

function applyAmpHosts() {
    const hits = collectAmpHostHits().filter(hit => bulkPicked('amp-host', hit.node));
    withUndo('AMP / old.reddit rewrite', api => {
        hits.forEach(hit => {
            api.set(hit.node, 'uri' in hit.node ? 'uri' : 'url', hit.next);
            logAffected('REPAIR', hit.node.title, 'Rewrote AMP path or old/m.reddit host.', {
                source: 'General repairs', node: hit.node, oldUri: hit.uri, newUri: hit.next, uri: hit.next
            });
        });
    });
    markChanged();
    scanAmpHosts();
    alert(`Rewrote ${formatCount(hits.length)} URL(s).`);
}

function decodeHtmlEntities(value) {
    let text = String(value || '');
    for (let i = 0; i < 3; i++) {
        const box = document.createElement('textarea');
        box.innerHTML = text;
        const next = box.value;
        if (next === text) break;
        text = next;
    }
    return text;
}

function collectEntityTitleHits() {
    const hits = [];
    collectRepairTargets(node => Boolean(node.title) && /&(?:amp|lt|gt|quot|#39|#x[\da-f]+|#\d+);/i.test(node.title)).forEach(hit => {
        const next = decodeHtmlEntities(hit.node.title);
        if (next && next !== hit.node.title) hits.push({ ...hit, next });
    });
    return hits;
}

function scanEntityTitles() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectEntityTitleHits();
    startBulkPick('entities');
    renderRepairPreview(
        'repairs-entities-results',
        'No HTML-entity titles.',
        `${formatCount(hits.length)} title(s) would be decoded.`,
        [{ pick: 'entities' }, '#', 'Before', 'After'],
        hits.map((hit, index) => [
            bulkPickBox('entities', hit.node),
            escapeHtml(String(index + 1)),
            escapeHtml(hit.node.title),
            escapeHtml(hit.next)
        ])
    );
    setBulkPlan('entities', { count: hits.length, label: 'HTML-entity titles', apply: applyEntityTitles });
    logAffected('SYSTEM', 'Entity title scan', `Scanned titles for HTML entities such as &amp; &lt; &gt; &quot; &#39;. ${formatCount(hits.length)} title(s) would decode (up to three passes). Scan did not edit titles. Apply HTML-entity titles to commit.`, { source: 'General repairs', scan: true });
}

function applyEntityTitles() {
    const hits = collectEntityTitleHits().filter(hit => bulkPicked('entities', hit.node));
    withUndo('HTML-entity titles', api => {
        hits.forEach(hit => {
            const oldTitle = hit.node.title;
            api.set(hit.node, 'title', hit.next);
            logAffected('REPAIR', hit.next, 'Decoded HTML entities in title.', {
                source: 'General repairs', node: hit.node, oldTitle, newTitle: hit.next
            });
        });
    });
    markChanged();
    scanEntityTitles();
    alert(`Decoded ${formatCount(hits.length)} title(s).`);
}

// --- Title cleanup ---
// The separators the site-suffix rule understands between a title and its site name.
const TITLE_CLEANUP_SEPARATORS = ['::', '»', '·', '—', '–', '|', '-'];

// Each rule can be turned off with a checkbox in the card; when the element is absent the
// rule stays on, so the card keeps working before the markup exists.
const TITLE_CLEANUP_RULES = [
    { key: 'suffix', id: 'repairs-title-suffix', label: 'site suffix' },
    { key: 'space', id: 'repairs-title-space', label: 'whitespace and separators' },
    { key: 'caps', id: 'repairs-title-caps', label: 'ALL CAPS to sentence case' },
    { key: 'emoji', id: 'repairs-title-emoji', label: 'edge emoji' }
];

// Pictographs only. \p{Emoji_Component} is deliberately not used: it also matches plain
// digits, '#', and '*', which would make the edge rule eat numbers.
const TITLE_CLEANUP_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{20E3}\u{200D}]/u;
const TITLE_CLEANUP_EDGES = /^[\s|\-–—·»:]+|[\s|\-–—·»:]+$/g;

function titleCleanupRuleOn(id) {
    const el = document.getElementById(id);
    return el ? Boolean(el.checked) : true;
}

function titleCleanupFlags() {
    const flags = {};
    TITLE_CLEANUP_RULES.forEach(rule => { flags[rule.key] = titleCleanupRuleOn(rule.id); });
    return flags;
}

function titleCleanupHost(uri) {
    try {
        return new URL(uri).hostname.toLowerCase();
    } catch (err) {
        return '';
    }
}

// Everything the site name after a separator may legitimately be: the host, the parent
// domain, any host label, and the same values with their dots removed (so “Mozilla”
// matches mozilla.org and “Mozilla.org” matches too).
function titleCleanupHostTokens(host) {
    const tokens = new Set();
    if (!host) return tokens;
    const clean = host.replace(/\.$/, '').replace(/^www\./, '');
    const domain = typeof parentDomainFromHost === 'function' ? (parentDomainFromHost(clean) || clean) : clean;
    [clean, domain].forEach(value => {
        if (!value) return;
        tokens.add(value);
        tokens.add(value.replace(/[^a-z0-9]+/g, ''));
        value.split('.').forEach(label => {
            if (label && label !== 'www') tokens.add(label);
        });
    });
    return tokens;
}

// Pure decision for the site-suffix rule: the title with a trailing " <sep> Site" removed
// when Site names the link's own host or parent domain. Returns null when there is nothing
// to strip (no host, no separator match, 0 or 4+ words after the separator, no host match,
// an empty head, or a result identical to the input) so it can be unit-tested directly.
function titleSuffixToStrip(title, uri) {
    const text = String(title == null ? '' : title);
    const host = titleCleanupHost(uri);
    if (!text || !host) return null;
    const tokens = titleCleanupHostTokens(host);
    let best = null;
    TITLE_CLEANUP_SEPARATORS.forEach(sep => {
        const marker = ` ${sep} `;
        let index = text.indexOf(marker);
        while (index > 0) {
            const head = text.slice(0, index).replace(/\s+$/, '');
            const tail = text.slice(index + marker.length).trim();
            const words = tail.split(/\s+/).filter(Boolean);
            const compact = tail.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (head && words.length >= 1 && words.length <= 3 && compact && tokens.has(compact)) {
                if (!best || index > best.index) best = { index, head };
            }
            index = text.indexOf(marker, index + 1);
        }
    });
    if (!best) return null;
    const next = best.head.trim();
    return next && next !== text ? next : null;
}

function titleCollapseSpaces(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

// Collapse whitespace, then peel leading/trailing separators (repeat until stable so
// " - hello | - " becomes "hello").
function titleTrimSeparators(text) {
    let out = titleCollapseSpaces(text);
    let previous;
    do {
        previous = out;
        out = out.replace(TITLE_CLEANUP_EDGES, '').trim();
    } while (out !== previous);
    return out;
}

// ALL CAPS and longer than 12 characters folds to sentence case; short acronyms stay put.
function titleFoldAllCaps(text) {
    const value = String(text == null ? '' : text);
    if (value.length <= 12) return value;
    if (value !== value.toUpperCase() || value === value.toLowerCase()) return value;
    const first = value.search(/[A-Za-z]/);
    if (first < 0) return value;
    return value.slice(0, first) + value.charAt(first).toUpperCase() + value.slice(first + 1).toLowerCase();
}

// Remove runs of emoji/pictographs only when they sit at the very start or the very end of
// the title, with any whitespace that belongs to that same run. Never returns ''.
function titleStripEdgeEmoji(text) {
    const value = String(text == null ? '' : text);
    const chars = Array.from(value);
    const isEmoji = ch => TITLE_CLEANUP_EMOJI.test(ch);
    const isSpace = ch => /\s/.test(ch);
    let start = 0;
    while (start < chars.length && isSpace(chars[start])) start += 1;
    if (start < chars.length && isEmoji(chars[start])) {
        let end = start;
        while (end < chars.length && (isEmoji(chars[end]) || isSpace(chars[end]))) end += 1;
        chars.splice(0, end);
    }
    let stop = chars.length;
    while (stop > 0 && isSpace(chars[stop - 1])) stop -= 1;
    if (stop > 0 && isEmoji(chars[stop - 1])) {
        let begin = stop - 1;
        while (begin > 0 && (isEmoji(chars[begin - 1]) || isSpace(chars[begin - 1]))) begin -= 1;
        chars.splice(begin, chars.length - begin);
    }
    const out = chars.join('').trim();
    return out && out !== value ? out : value;
}

// Pure pipeline over the four rules. Returns { next, rules } or null when nothing changes
// or the result would be empty.
function planTitleCleanup(title, uri, flags) {
    const before = String(title == null ? '' : title);
    if (!before.trim()) return null;
    const on = flags || {};
    let out = before;
    const rules = [];
    if (on.suffix !== false) {
        const stripped = titleSuffixToStrip(out, uri);
        if (stripped && stripped !== out) {
            out = stripped;
            rules.push('suffix');
        }
    }
    if (on.space !== false) {
        const tidy = titleTrimSeparators(out);
        if (tidy && tidy !== out) {
            out = tidy;
            rules.push('space');
        }
    }
    if (on.caps !== false) {
        const folded = titleFoldAllCaps(out);
        if (folded && folded !== out) {
            out = folded;
            rules.push('caps');
        }
    }
    if (on.emoji !== false) {
        const trimmed = titleStripEdgeEmoji(out);
        if (trimmed && trimmed !== out) {
            out = trimmed;
            rules.push('emoji');
        }
    }
    if (!rules.length) return null;
    const next = out.trim();
    if (!next || next === before) return null;
    return { next, rules };
}

function titleCleanupRuleLabel(key) {
    const rule = TITLE_CLEANUP_RULES.find(item => item.key === key);
    return rule ? rule.label : key;
}

function collectTitleCleanupHits() {
    const flags = titleCleanupFlags();
    const hits = [];
    if (!bookmarkData) return hits;
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const before = String(link.node.title || '');
        if (!before) return;
        const plan = planTitleCleanup(before, link.uri, flags);
        if (!plan) return;
        hits.push({
            node: link.node,
            parent: link.parent,
            uri: link.uri,
            folderPath: link.folderPath,
            before,
            next: plan.next,
            rules: plan.rules
        });
    });
    return hits;
}

function scanTitleCleanup() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectTitleCleanupHits();
    const counts = {};
    TITLE_CLEANUP_RULES.forEach(rule => { counts[rule.key] = 0; });
    hits.forEach(hit => hit.rules.forEach(key => { counts[key] = (counts[key] || 0) + 1; }));
    const ruleText = TITLE_CLEANUP_RULES.map(rule => `${rule.label} ${formatCount(counts[rule.key] || 0)}`).join(' · ');
    startBulkPick('title-cleanup');
    renderRepairPreview(
        'repairs-title-results',
        'No titles need suffix, whitespace, ALL-CAPS, or edge-emoji cleanup.',
        `${formatCount(hits.length)} title(s) would change. ${ruleText}.`,
        [{ pick: 'title-cleanup' }, '#', 'Before', 'After', 'Rules'],
        hits.map((hit, index) => [
            bulkPickBox('title-cleanup', hit.node),
            escapeHtml(String(index + 1)),
            escapeHtml(hit.before),
            escapeHtml(hit.next),
            escapeHtml(hit.rules.map(titleCleanupRuleLabel).join(', '))
        ])
    );
    setBulkPlan('title-cleanup', { count: hits.length, label: 'Title cleanup', apply: applyTitleCleanup });
    logAffected('SYSTEM', 'Title cleanup scan', `Scanned ${formatCount(hits.length)} title(s) against four rules (${ruleText}). The suffix rule strips " <sep> Site" only when Site matches the link's own host or parent domain; whitespace runs collapse and leading/trailing separators come off; ALL CAPS longer than 12 characters folds to sentence case; emoji runs come off only at the very start or end, and never down to an empty title. Scan did not change titles.`, {
        source: 'General repairs',
        scan: true,
        reason: 'title suffix, whitespace, ALL CAPS, or edge emoji'
    });
}

function applyTitleCleanup() {
    if (!bookmarkData) return alert('Library is not loaded.');
    // Re-collect so the rule checkboxes are honoured at apply time; node identity is stable.
    const hits = collectTitleCleanupHits().filter(hit => bulkPicked('title-cleanup', hit.node));
    if (!hits.length) return;
    withUndo('Title cleanup', api => {
        hits.forEach(hit => {
            api.set(hit.node, 'title', hit.next);
            logAffected('REPAIR', hit.next, `Title cleanup (${hit.rules.map(titleCleanupRuleLabel).join(', ')}).`, {
                source: 'General repairs',
                node: hit.node,
                oldTitle: hit.before,
                newTitle: hit.next,
                uri: hit.uri,
                folderPath: hit.folderPath
            });
        });
    });
    markChanged();
    scanTitleCleanup();
    alert(`Cleaned ${formatCount(hits.length)} title(s). One Undo reverses the whole run.`);
}

// --- Broken links by domain ---
const DEAD_DOMAIN_PREVIEW_LINKS = 100;

function deadDomainForUri(uri) {
    try {
        const host = new URL(uri).hostname.toLowerCase();
        if (!host) return '';
        return typeof parentDomainFromHost === 'function' ? (parentDomainFromHost(host) || host) : host.replace(/^www\./, '');
    } catch (err) {
        return '';
    }
}

// Only links the app has already decided are broken are counted here: the heuristic hits
// from collectBrokenLinkHits() plus the rows of a finished Link check whose status is dead
// (404/410, unreachable, timeout). A link that was never checked appears in neither source,
// so it is never counted as broken. Folders and URI-less nodes are dropped because they
// cannot belong to a domain.
function collectDeadLinkRows() {
    const rows = [];
    const seen = new Set();
    collectBrokenLinkHits().forEach(hit => {
        const uri = nodeUri(hit.node);
        if (!uri || seen.has(hit.node)) return;
        seen.add(hit.node);
        rows.push({
            node: hit.node,
            parent: hit.parent,
            uri,
            folderPath: hit.folderPath || folderPathFor(hit.node),
            status: 'broken title/URL',
            source: 'Broken scan'
        });
    });
    let checked = [];
    try {
        if (typeof linkCheckRows !== 'undefined' && Array.isArray(linkCheckRows)) checked = linkCheckRows;
    } catch (err) {
        checked = [];
    }
    checked.forEach(row => {
        if (!row || !row.node || seen.has(row.node)) return;
        const kind = row.kind || (typeof linkStatusKind === 'function' ? linkStatusKind(row.status) : '');
        if (kind !== 'dead') return;
        const uri = nodeUri(row.node);
        if (!uri) return;
        seen.add(row.node);
        rows.push({
            node: row.node,
            parent: row.parent || (typeof findNodeParent === 'function' ? findNodeParent(row.node) : null),
            uri,
            folderPath: row.folderPath || folderPathFor(row.node),
            status: String(row.status == null ? 'dead' : row.status),
            source: 'Link check'
        });
    });
    return rows;
}

function collectDeadDomainGroups() {
    const totals = new Map();
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const domain = deadDomainForUri(link.uri);
        if (!domain) return;
        totals.set(domain, (totals.get(domain) || 0) + 1);
    });
    const groups = new Map();
    collectDeadLinkRows().forEach(row => {
        const domain = deadDomainForUri(row.uri);
        if (!domain) return;
        if (!groups.has(domain)) groups.set(domain, { domain, links: [], total: totals.get(domain) || 0 });
        groups.get(domain).links.push({ ...row, domain });
    });
    return [...groups.values()].sort((a, b) => b.links.length - a.links.length || a.domain.localeCompare(b.domain));
}

function scanDeadDomains() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const groups = collectDeadDomainGroups();
    const broken = groups.reduce((sum, group) => sum + group.links.length, 0);
    const ungrouped = Math.max(0, collectDeadLinkRows().length - broken);
    startBulkPick('deaddomain');
    let shownLinks = 0;
    const rows = groups.map((group, groupIndex) => {
        const boxes = group.links.map(link => {
            // Register every broken link so Apply covers them all, but only the first
            // DEAD_DOMAIN_PREVIEW_LINKS rows put a checkbox in the preview table.
            const box = bulkPickBox('deaddomain', link.node);
            if (shownLinks >= DEAD_DOMAIN_PREVIEW_LINKS) return '';
            shownLinks += 1;
            return `<label class="dead-domain-pick">${box} ${escapeHtml(link.node.title || '(untitled)')} <span class="log-url">${escapeHtml(link.uri)}</span></label>`;
        }).filter(Boolean);
        return [
            escapeHtml(group.domain),
            formatCount(group.links.length),
            formatCount(group.total),
            `<div class="dead-domain-links" data-dead-domain-cell="${groupIndex}">${
                group.links.length > 1
                    ? `<label class="dead-domain-all"><input type="checkbox" data-dead-domain-all="${groupIndex}" checked> all ${formatCount(group.links.length)}</label>`
                    : ''
            }${boxes.join('')}</div>`
        ];
    });
    renderRepairPreview(
        'repairs-deaddomain-results',
        'No checked or heuristically broken links with a parent domain.',
        `${formatCount(groups.length)} domain(s), ${formatCount(broken)} broken link(s) ready to delete. ${formatCount(shownLinks)} of ${formatCount(broken)} link checkbox(es) shown; Apply still covers every checked link.${ungrouped ? ` ${formatCount(ungrouped)} broken link(s) have no usable host and are not listed.` : ''}`,
        ['Domain', 'Broken', 'Links on domain', 'Broken links (check to delete)'],
        rows
    );
    const box = document.getElementById('repairs-deaddomain-results');
    if (box && typeof Event === 'function') {
        box.querySelectorAll('[data-dead-domain-all]').forEach(toggle => {
            toggle.addEventListener('change', () => {
                const cell = box.querySelector(`[data-dead-domain-cell="${toggle.dataset.deadDomainAll}"]`);
                if (!cell) return;
                cell.querySelectorAll('input[data-bulk-pick="deaddomain"]').forEach(input => {
                    if (input.checked === toggle.checked) return;
                    input.checked = toggle.checked;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
        });
    }
    setBulkPlan('deaddomain', { count: broken, label: 'Delete broken links by domain', apply: applyDeadDomains });
    logAffected('SYSTEM', 'Broken links by domain scan', `Grouped ${formatCount(broken)} broken link(s) the app already knows about across ${formatCount(groups.length)} parent domain(s)${ungrouped ? `, plus ${formatCount(ungrouped)} without a usable host` : ''}. Sources: the broken title/URL scan and the dead rows (404/410, unreachable, timeout) of a finished Link check; a link that was never checked is not counted. Scan did not delete anything.`, {
        source: 'General repairs',
        scan: true
    });
}

function applyDeadDomains() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const picked = [];
    collectDeadDomainGroups().forEach(group => {
        group.links.forEach(link => {
            if (bulkPicked('deaddomain', link.node)) picked.push(link);
        });
    });
    if (!picked.length) return;
    const nodes = [];
    picked.forEach(link => {
        if (link.node && !nodes.includes(link.node)) nodes.push(link.node);
    });
    // The coordinator's preview dialog owns the undoable delete (and honours protected
    // folders) when it is present. Use it instead of deleting here.
    if (typeof previewDeleteLibraryNodes === 'function') {
        previewDeleteLibraryNodes(nodes);
        return;
    }
    withUndo('Delete broken links by domain', api => {
        picked.forEach(link => {
            const parent = (typeof findNodeParent === 'function' ? findNodeParent(link.node) : null) || link.parent;
            if (!parent) return;
            api.remove(link.node, parent);
            logAffected('REMOVED', link.node.title || 'Untitled', `Deleted a broken link on ${link.domain} (${link.status}).`, {
                source: 'Broken links by domain',
                node: link.node,
                uri: link.uri,
                folderPath: link.folderPath
            });
        });
    });
    markChanged();
    renderSidebar();
    scanDeadDomains();
    alert(`Deleted ${formatCount(picked.length)} broken link(s). Undo restores them.`);
}
