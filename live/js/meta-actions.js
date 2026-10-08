const META_NOTIF_PREFIX_RE = /^\(\d+\+?\)\s*/;
const META_PREVIEW_LIMIT = 250;

function metaNotificationSite(uri) {
    const raw = String(uri || '').trim();
    if (!raw) return '';
    try {
        const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.com' || host === 'fb.watch' || host.endsWith('.facebook.com')) return 'Facebook';
        if (host === 'instagram.com' || host === 'instagr.am' || host.endsWith('.instagram.com') || host.endsWith('.instagr.am')) return 'Instagram';
        return '';
    } catch (err) {
        if (/(?:^|[/.])facebook\.com(?:\/|$)/i.test(raw) || /(?:^|[/.])fb\.com(?:\/|$)/i.test(raw) || /(?:^|[/.])fb\.watch(?:\/|$)/i.test(raw)) return 'Facebook';
        if (/(?:^|[/.])instagram\.com(?:\/|$)/i.test(raw) || /(?:^|[/.])instagr\.am(?:\/|$)/i.test(raw)) return 'Instagram';
        return '';
    }
}

function stripMetaNotificationPrefix(title) {
    const text = String(title || '');
    const cleaned = text.replace(META_NOTIF_PREFIX_RE, '');
    if (cleaned === text) return null;
    const next = cleaned.replace(/^\s+/, '');
    return next || null;
}

function collectMetaNotificationTitleHits() {
    const hits = [];
    if (!bookmarkData) return hits;
    walkBookmarkTree(bookmarkData, (node) => {
        if (!isBookmarkLinkNode(node)) return;
        const site = metaNotificationSite(nodeUri(node));
        if (!site) return;
        const after = stripMetaNotificationPrefix(node.title);
        if (!after) return;
        hits.push({ node, site, before: node.title, after });
    });
    return hits;
}

function renderMetaChangeTable(box, summary, headers, rows) {
    if (!box) return;
    if (!rows.length) {
        box.innerHTML = `<p>${summary}</p>`;
        return;
    }
    const shown = rows.slice(0, META_PREVIEW_LIMIT);
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

function scanMetaNotificationTitles() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const hits = collectMetaNotificationTitleHits();
    const box = document.getElementById('meta-notif-results');
    startBulkPick('meta-notif');
    const rows = hits.map((hit, index) => [
        bulkPickBox('meta-notif', hit.node),
        escapeHtml(String(index + 1)),
        escapeHtml(hit.site),
        escapeHtml(hit.before || ''),
        escapeHtml(hit.after || ''),
        `<span class="log-url">${escapeHtml(nodeUri(hit.node))}</span>`
    ]);
    renderMetaChangeTable(
        box,
        `${formatCount(hits.length)} Facebook or Instagram title(s) with a leading notification count.`,
        [{ pick: 'meta-notif' }, '#', 'Site', 'Title now', 'Title after', 'URL'],
        rows
    );
    setBulkPlan('meta-notif', {
        count: hits.length,
        label: 'Meta notification titles',
        apply: applyMetaNotificationTitles
    });
    logAffected('SYSTEM', 'Meta notification titles scan', `Scanned Facebook and Instagram bookmark titles for notification-count prefixes such as (20+) or (14). ${hits.length} title(s) would drop that prefix on Apply (skipped if the leftover title would be empty). Scan did not edit titles.`, {
        source: 'Meta notification titles',
        scan: true
    });
}

function applyMetaNotificationTitles() {
    const hits = collectMetaNotificationTitleHits().filter(hit => bulkPicked('meta-notif', hit.node));
    if (!hits.length) return alert('Nothing to apply.');
    withUndo('Meta notification titles', api => {
        hits.forEach(hit => {
            const old = hit.node.title;
            api.set(hit.node, 'title', hit.after);
            logAffected('MODIFIED', hit.after, `Removed leading ${hit.site} notification count from title.`, {
                source: 'Meta notification titles',
                node: hit.node,
                uri: nodeUri(hit.node),
                oldTitle: old,
                newTitle: hit.after
            });
        });
    });
    markChanged();
    scanMetaNotificationTitles();
    alert(`Cleaned ${formatCount(hits.length)} title(s).`);
}
