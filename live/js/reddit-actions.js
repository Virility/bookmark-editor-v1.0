// Reddit Actions — subreddit filing, Netscape dates, comment-chain keep-oldest.
function extractRedditSubreddit(uri, title) {
    try {
        const url = new URL(uri);
        const fromPath = url.pathname.match(/\/r\/([^/]+)/i);
        if (fromPath && fromPath[1].toLowerCase() !== 'all') return fromPath[1].toLowerCase();
    } catch (e) {}
    const fromTitle = String(title || '').match(/\s[:\-]\s(?:r\/)?([A-Za-z0-9_]+)\s*$/i);
    if (fromTitle) return fromTitle[1].toLowerCase();
    return null;
}

function findFoldersNamed(root, name) {
    const hits = [];
    const needle = name.toLowerCase();
    (function walk(node, parent) {
        if ((node.children || node.typeCode === 2) && (node.title || '').trim().toLowerCase() === needle) {
            hits.push({ node, parent });
        }
        node.children?.forEach(child => walk(child, node));
    })(root, null);
    return hits;
}

function folderLooksLikeSubreddit(folder, sub) {
    const title = (folder.title || '').trim().toLowerCase().replace(/^\/?r\//i, '');
    const key = String(sub || '').replace(/^\/?r\//i, '').toLowerCase();
    return Boolean(key) && title === key;
}

function findSubredditFolderUnder(root, sub) {
    if (!root || !sub) return null;
    let found = null;
    (function walk(node) {
        if (found || !node) return;
        if (node !== root && isBookmarkFolderNode(node) && folderLooksLikeSubreddit(node, sub)) {
            found = node;
            return;
        }
        (node.children || []).forEach(walk);
    })(root);
    return found;
}

function ensureChildFolder(parent, title) {
    if (!parent.children) parent.children = [];
    const sub = String(title || '').replace(/^\/?r\//i, '').toLowerCase();
    let folder = findSubredditFolderUnder(parent, sub);
    if (folder) return folder;
    folder = { typeCode: 2, title: sub, children: [], dateAdded: liveCopy() ? Date.now() : Date.now() * 1000, _modified: true };
    parent.children.push(folder);
    if (liveCopy() && typeof liveCreateNode === 'function') liveCreateNode(parent, folder);
    return folder;
}

function collectRedditFilingPlan() {
    const roots = findFoldersNamed(bookmarkData, 'Reddit Links');
    const moves = [];
    const skipped = [];
    roots.forEach(({ node: root }) => {
        (function walk(node, parent) {
            if (parent && (node.uri || node.url)) {
                const uri = node.uri || node.url;
                const sub = extractRedditSubreddit(uri, node.title);
                if (!sub) skipped.push({ node, parent, reason: 'No subreddit in URL or title' });
                else if (folderLooksLikeSubreddit(parent, sub)) skipped.push({ node, parent, reason: `Already in ${parent.title}` });
                else moves.push({
                    node,
                    parent,
                    root,
                    sub,
                    folderTitle: sub,
                    destExists: Boolean(findSubredditFolderUnder(root, sub))
                });
            }
            node.children?.forEach(child => walk(child, node));
        })(root, null);
    });
    return { roots, moves, skipped };
}

function renderRedditFileResults(plan, heading) {
    const box = document.getElementById('reddit-file-results');
    if (!box) return;
    if (!plan.roots.length) {
        box.innerHTML = '<p>No folder named <code>Reddit Links</code> was found.</p>';
        return;
    }
    const bySub = new Map();
    plan.moves.forEach(move => {
        const cur = bySub.get(move.folderTitle) || { count: 0, exists: false };
        cur.count++;
        if (move.destExists) cur.exists = true;
        bySub.set(move.folderTitle, cur);
    });
    const rows = [...bySub.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([name, info]) => `<tr><td>${bulkPickBox('reddit-v1', name, info.count)}</td><td>${escapeHtml(name)}</td><td>${info.exists ? 'Move into existing folder' : 'Create under Reddit Links, then move'}</td><td class="stats-num">${info.count}</td></tr>`).join('');
    box.innerHTML = `
        <p>${heading} ${plan.roots.length} <code>Reddit Links</code> folder${plan.roots.length === 1 ? '' : 's'}: ${plan.moves.length} to move, ${plan.skipped.length} already filed or unknown.</p>
        ${rows ? `<table class="excel-table"><thead><tr>${bulkHeaderCell({ pick: 'reddit-v1' })}<th>Destination folder</th><th>If missing</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Nothing to move.</p>'}
    `;
}

function scanRedditSubredditFolders() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const plan = collectRedditFilingPlan();
    startBulkPick('reddit-v1');
    renderRedditFileResults(plan, 'Scan of');
    setBulkPlan('reddit-v1', { count: plan.moves.length, label: 'Reddit file into subreddit folders', apply: applyRedditBySubreddit });
    logAffected('SYSTEM', 'Reddit subreddit file scan', `Reddit v1 scan: ${plan.moves.length} unfiled bookmark(s) under Reddit Links would move into a child folder named the plain subreddit (news, never r/news). Existing folder: move only. Missing folder: create then move. Subreddit comes from /r/name in the URL or a “: name” title suffix. Scan did not move anything. Apply files those bookmarks.`, {
        source: 'Reddit tools',
        scan: true
    });
}

function applyRedditBySubreddit() {
    const plan = collectRedditFilingPlan();
    plan.moves = plan.moves.filter(move => bulkPicked('reddit-v1', move.folderTitle));
    withUndo('Reddit file into subreddit folders', api => {
        plan.moves.forEach(move => {
            const dest = ensureChildFolder(move.root, move.folderTitle);
            if (dest === move.parent) return;
            api.move(move.node, move.parent, dest);
            logAffected('MODIFIED', move.node.title, `Moved into ${move.folderTitle} under Reddit Links.`, {
                source: 'Reddit tools',
                node: move.node,
                uri: move.node.uri || move.node.url,
                folderPath: `${displayFolderTitle(move.root)} / ${move.folderTitle}`,
                reason: `Subreddit ${move.sub}`
            });
        });
    });
    markChanged();
    renderSidebar();
    startBulkPick('reddit-v1');
    renderRedditFileResults(collectRedditFilingPlan(), 'After filing');
    alert(`Moved ${plan.moves.length} bookmark${plan.moves.length === 1 ? '' : 's'} into subreddit folders.`);
}

// The JSON copy stores seconds-precision dates and creates folders in memory; the live copy
// writes through the browser. One file, one branch — that is what keeps the builds identical.
function liveCopy() {
    return typeof isLiveEditorCopy === 'function' && isLiveEditorCopy();
}

function fileRedditBySubreddit() {
    scanRedditSubredditFolders();
    applyBulk('reddit-v1');
}

function isBookmarkFolder(node) {
    return isBookmarkFolderNode(node);
}

function bookmarkNodeTitle(node) {
    return displayFolderTitle(node, '');
}

function findSpecialBookmarkFolder(titles, guids, chromeKey) {
    const needles = titles.map(title => title.toLowerCase());
    let found = null;
    (function walk(node, parent) {
        if (found || !node) return;
        const title = bookmarkNodeTitle(node).toLowerCase();
        if (isBookmarkFolder(node) && (needles.includes(title) || guids.includes(node.guid))) {
            found = { node, parent };
            return;
        }
        node.children?.forEach(child => walk(child, node));
        if (node.roots && typeof node.roots === 'object') {
            Object.values(node.roots).forEach(child => {
                if (child && typeof child === 'object') walk(child, node.roots);
            });
        }
    })(bookmarkData, null);
    if (!found && chromeKey && bookmarkData.roots?.[chromeKey]) {
        found = { node: bookmarkData.roots[chromeKey], parent: bookmarkData.roots };
    }
    return found;
}

function collectRedditFilingPlanV2() {
    const toolbar = findSpecialBookmarkFolder(
        ['Bookmarks Toolbar', 'Bookmarks Bar', 'Bookmark Bar', 'Favorites Bar', 'Favourites Bar'],
        ['toolbar_____'],
        'bookmark_bar'
    );
    const other = findSpecialBookmarkFolder(
        ['Other Bookmarks', 'Unsorted Bookmarks'],
        ['unfiled_____'],
        'other'
    );
    const redditHits = other ? findFoldersNamed(other.node, 'Reddit Links') : [];
    const redditLinks = redditHits[0]?.node || null;
    const categories = [];
    const subToCategory = new Map();
    const conflicts = [];
    (toolbar?.node.children || []).forEach(child => {
        if (!isBookmarkFolder(child)) return;
        const spec = parseToolbarSubredditSpec(bookmarkNodeTitle(child));
        if (!spec) return;
        categories.push({ folder: child, spec });
        spec.subs.forEach(token => {
            const key = token.toLowerCase();
            if (subToCategory.has(key) && subToCategory.get(key).folder !== child) {
                const winner = subToCategory.get(key);
                conflicts.push({ sub: winner.token, first: winner.spec.description, second: spec.description });
                return;
            }
            if (!subToCategory.has(key)) subToCategory.set(key, { folder: child, token, spec });
        });
    });
    const folderMoves = [];
    const moves = [];
    const skipped = [];
    if (redditLinks) {
        (function walk(node, parent) {
            if (!parent) {
                node.children?.forEach(child => walk(child, node));
                return;
            }
            if (isBookmarkFolder(node)) {
                const key = bookmarkNodeTitle(node).replace(/^\/?r\//i, '').toLowerCase();
                const mapped = subToCategory.get(key);
                if (mapped && folderLooksLikeSubreddit(node, key)) {
                    if (parent === mapped.folder) {
                        skipped.push({ node, parent, reason: `Already under ${bookmarkNodeTitle(mapped.folder)}` });
                    } else {
                        folderMoves.push({ node, parent, destParent: mapped.folder, folderTitle: mapped.token, sub: key });
                    }
                    return;
                }
                node.children?.forEach(child => walk(child, node));
                return;
            }
            if (node.uri || node.url) {
                const sub = extractRedditSubreddit(node.uri || node.url, node.title);
                if (!sub) {
                    skipped.push({ node, parent, reason: 'No subreddit in URL or title' });
                    return;
                }
                const mapped = subToCategory.get(sub);
                if (!mapped) return;
                if (folderLooksLikeSubreddit(parent, sub)) {
                    skipped.push({ node, parent, reason: `Already in ${parent.title}` });
                    return;
                }
                // Phase 1: file loose links into a subreddit folder under Reddit Links.
                moves.push({ node, parent, folderTitle: mapped.token, sub });
            }
        })(redditLinks, null);
    }
    return { toolbar, other, redditLinks, categories, subToCategory, conflicts, folderMoves, moves, skipped };
}

function redditV2RowKey(destParent, folderTitle) {
    return `${bookmarkNodeTitle(destParent)}\0${folderTitle}`;
}

function redditV2MovePicked(plan, move) {
    const mapped = plan.subToCategory.get(move.sub);
    return !mapped || bulkPicked('reddit-v2', redditV2RowKey(mapped.folder, move.folderTitle));
}

function renderRedditFileV2Results(plan, heading) {
    const box = document.getElementById('reddit-file-v2-results');
    if (!box) return;
    if (!plan.toolbar) {
        box.innerHTML = '<p>No <code>Bookmarks Toolbar</code> folder was found.</p>';
        return;
    }
    if (!plan.other) {
        box.innerHTML = '<p>No <code>Other Bookmarks</code> folder was found.</p>';
        return;
    }
    if (!plan.redditLinks) {
        box.innerHTML = '<p>No <code>Reddit Links</code> folder under <code>Other Bookmarks</code>.</p>';
        return;
    }
    if (!plan.categories.length) {
        box.innerHTML = '<p>No toolbar folders matched <code>description - sub1 sub2 …</code>.</p>';
        return;
    }
    const counts = new Map();
    const bump = (destParent, folderTitle, field, n = 1) => {
        const key = redditV2RowKey(destParent, folderTitle);
        if (!counts.has(key)) counts.set(key, { key, destParent, folderTitle, folders: 0, links: 0 });
        counts.get(key)[field] += n;
    };
    plan.folderMoves.forEach(move => bump(move.destParent, move.folderTitle, 'folders'));
    plan.moves.forEach(move => {
        const mapped = plan.subToCategory.get(move.sub);
        if (mapped) bump(mapped.folder, move.folderTitle, 'links');
    });
    const byCategory = new Map();
    [...counts.values()].forEach(row => {
        if (!byCategory.has(row.destParent)) byCategory.set(row.destParent, []);
        byCategory.get(row.destParent).push(row);
    });
    const categoryBlocks = [...byCategory.entries()]
        .sort((a, b) => {
            const specA = parseToolbarSubredditSpec(bookmarkNodeTitle(a[0]));
            const specB = parseToolbarSubredditSpec(bookmarkNodeTitle(b[0]));
            return (specA?.description || bookmarkNodeTitle(a[0])).localeCompare(specB?.description || bookmarkNodeTitle(b[0]));
        })
        .map(([folder, rows]) => {
            const spec = parseToolbarSubredditSpec(bookmarkNodeTitle(folder));
            const label = spec?.description || bookmarkNodeTitle(folder);
            const body = rows
                .sort((a, b) => a.folderTitle.localeCompare(b.folderTitle))
                .map(row => `<tr>
                    <td>${bulkPickBox('reddit-v2', row.key, row.folders + row.links)}</td>
                    <td>${escapeHtml(row.folderTitle)}</td>
                    <td class="stats-num">${row.folders}</td>
                    <td class="stats-num">${row.links}</td>
                </tr>`).join('');
            return `<section class="reddit-v2-cat">
                <h3>${escapeHtml(label)}</h3>
                <table class="excel-table"><thead><tr><th class="bulk-pick-col"></th><th>Subreddit folder</th><th>Folders</th><th>Loose links</th></tr></thead><tbody>${body}</tbody></table>
            </section>`;
        }).join('');
    const conflictGroups = new Map();
    plan.conflicts.forEach(item => {
        const key = item.sub.toLowerCase();
        if (!conflictGroups.has(key)) conflictGroups.set(key, { sub: item.sub, first: item.first, others: [] });
        const group = conflictGroups.get(key);
        if (!group.others.includes(item.second)) group.others.push(item.second);
    });
    const conflictHtml = conflictGroups.size
        ? `<p>${conflictGroups.size} name${conflictGroups.size === 1 ? '' : 's'} listed in more than one toolbar folder. The leftmost folder keeps the name; the others are ignored:</p>
           <ul class="reddit-conflicts">${[...conflictGroups.values()].map(group => `<li><code>${escapeHtml(group.sub)}</code>: <strong>${escapeHtml(group.first)}</strong> (kept), ${group.others.map(escapeHtml).join(', ')}</li>`).join('')}</ul>`
        : '';
    box.innerHTML = `
        <p>${heading} ${plan.categories.length} toolbar categor${plan.categories.length === 1 ? 'y' : 'ies'}, ${plan.subToCategory.size} subreddit name${plan.subToCategory.size === 1 ? '' : 's'}: ${plan.moves.length} loose link(s) to file under Reddit Links, then ${plan.folderMoves.length} folder(s) to nest under toolbar groups (leaving Reddit Links); leftover Reddit Links folders are sorted A→Z. ${plan.skipped.length} skipped (already filed or no subreddit).</p>
        ${conflictHtml}
        ${categoryBlocks || '<p>Nothing to move.</p>'}
    `;
}

function scanRedditToolbarFolders() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const plan = collectRedditFilingPlanV2();
    startBulkPick('reddit-v2');
    renderRedditFileV2Results(plan, 'Scan of');
    setBulkPlan('reddit-v2', {
        count: plan.folderMoves.length + plan.moves.length,
        label: 'Reddit toolbar file v2',
        apply: applyRedditByToolbarMap
    });
    logAffected('SYSTEM', 'Reddit toolbar file scan v2', `Reddit v2 scan (experimental): would file ${plan.moves.length} loose matching link(s) from Other Bookmarks / Reddit Links into a subreddit-named folder, then nest ${plan.folderMoves.length} folder(s) under toolbar category folders (description - sub1 sub2 …), leaving Reddit Links in place. Conflicts keep the first listing. Scan did not move folders. Apply runs those moves then sorts leftover Reddit Links folders A→Z.`, {
        source: 'Reddit tools v2',
        scan: true
    });
}

function sortRedditLinksRemainingFolders(redditLinks, api) {
    if (!redditLinks?.children?.length) return 0;
    const kids = redditLinks.children.slice();
    const folders = kids
        .filter(child => isBookmarkFolder(child))
        .sort((a, b) => bookmarkNodeTitle(a).localeCompare(bookmarkNodeTitle(b), undefined, { sensitivity: 'base' }));
    const nonFolders = kids.filter(child => !isBookmarkFolder(child));
    const desired = folders.concat(nonFolders);
    let reordered = 0;
    desired.forEach((node, targetIndex) => {
        if (redditLinks.children[targetIndex] === node) return;
        api.move(node, redditLinks, redditLinks, targetIndex);
        reordered++;
    });
    if (reordered) {
        logAffected('MODIFIED', 'Reddit Links', `Sorted ${reordered} remaining folder child(ren) A→Z under Reddit Links.`, {
            source: 'Reddit tools v2',
            node: redditLinks,
            folderPath: displayFolderTitle(redditLinks),
            reason: 'Case-insensitive folder title sort'
        });
    }
    return reordered;
}

function applyRedditByToolbarMap() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const plan = collectRedditFilingPlanV2();
    if (!plan.redditLinks) {
        alert('No Reddit Links folder under Other Bookmarks.');
        return;
    }
    let movedFolders = 0;
    let mergedFolders = 0;
    let movedLinks = 0;
    let sortedFolders = 0;
    withUndo('Reddit toolbar file v2', api => {
        // Phase 1: loose mapped bookmarks → subreddit folders under Reddit Links.
        plan.moves.filter(move => redditV2MovePicked(plan, move)).forEach(move => {
            const dest = ensureChildFolder(plan.redditLinks, move.folderTitle);
            if (dest === move.parent) return;
            api.move(move.node, move.parent, dest);
            movedLinks++;
            logAffected('MODIFIED', move.node.title, `Filed into ${move.folderTitle} under Reddit Links.`, {
                source: 'Reddit tools v2',
                node: move.node,
                uri: move.node.uri || move.node.url,
                folderPath: `${displayFolderTitle(plan.redditLinks)} / ${move.folderTitle}`,
                reason: `Subreddit ${move.sub}`
            });
        });
        // Phase 2: nest each original subreddit folder under its toolbar group (move removes it from Reddit Links).
        collectRedditFilingPlanV2().folderMoves.filter(move => bulkPicked('reddit-v2', redditV2RowKey(move.destParent, move.folderTitle))).forEach(move => {
            const existing = findSubredditFolderUnder(move.destParent, move.sub);
            if (existing && existing !== move.node) {
                [...(move.node.children || [])].forEach(child => api.move(child, move.node, existing));
                if ((move.node.children || []).length) return;
                api.remove(move.node, move.parent);
                mergedFolders++;
                logAffected('REMOVED', move.folderTitle, `Merged into existing ${move.folderTitle} under ${bookmarkNodeTitle(move.destParent)} and deleted empty folder from Reddit Links.`, {
                    source: 'Reddit tools v2',
                    node: existing,
                    folderPath: `${bookmarkNodeTitle(move.destParent)} / ${move.folderTitle}`,
                    reason: `Subreddit ${move.sub}`
                });
                return;
            }
            api.move(move.node, move.parent, move.destParent);
            movedFolders++;
            logAffected('MODIFIED', move.folderTitle, `Nested subreddit folder under ${bookmarkNodeTitle(move.destParent)} (removed from Reddit Links).`, {
                source: 'Reddit tools v2',
                node: move.node,
                folderPath: `${bookmarkNodeTitle(move.destParent)} / ${move.folderTitle}`,
                reason: `Subreddit ${move.sub}`
            });
        });
        // Phase 3: leftover Reddit Links folders A→Z; non-folders keep relative order after them.
        sortedFolders = sortRedditLinksRemainingFolders(plan.redditLinks, api);
    });
    markChanged();
    renderSidebar();
    startBulkPick('reddit-v2');
    renderRedditFileV2Results(collectRedditFilingPlanV2(), 'After filing');
    const folderBit = [
        movedFolders ? `${movedFolders} folder${movedFolders === 1 ? '' : 's'} nested` : '',
        mergedFolders ? `${mergedFolders} folder${mergedFolders === 1 ? '' : 's'} merged` : '',
        sortedFolders ? `${sortedFolders} leftover folder move${sortedFolders === 1 ? '' : 's'} for A→Z` : ''
    ].filter(Boolean).join(', ');
    alert(`Filed ${movedLinks} loose link${movedLinks === 1 ? '' : 's'} under Reddit Links${folderBit ? `; ${folderBit}` : ''} into toolbar groups.`);
}

function fileRedditByToolbarMap() {
    scanRedditToolbarFolders();
    applyBulk('reddit-v2');
}

function parseRedditCommentRef(uri) {
    try {
        const url = new URL(uri);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host !== 'reddit.com' && !host.endsWith('.reddit.com')) return null;
        const match = url.pathname.match(/\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/[^/]*\/([a-z0-9]+))?/i);
        if (!match) return null;
        return { post: match[1].toLowerCase(), comment: (match[2] || '').toLowerCase() };
    } catch (e) {
        return null;
    }
}

function collectRedditCommentChainGroups() {
    const groups = new Map();
    collectBookmarkLinks(bookmarkData).forEach(link => {
        const ref = parseRedditCommentRef(link.uri);
        if (!ref) return;
        if (!groups.has(ref.post)) groups.set(ref.post, []);
        groups.get(ref.post).push({ ...link, ...ref });
    });
    return [...groups.values()].filter(items => new Set(items.map(item => item.comment || '')).size > 1);
}

function pickCommentKeep(items) {
    return items.slice().sort((a, b) => {
        const delta = (a.addedMs || 0) - (b.addedMs || 0);
        if (delta) return delta;
        return (a.comment ? 1 : 0) - (b.comment ? 1 : 0);
    })[0];
}

function collectCommentKeepRemoves() {
    const removes = [];
    collectRedditCommentChainGroups().forEach(items => {
        const keep = pickCommentKeep(items);
        items.filter(item => item.node !== keep.node).forEach(item => removes.push({ ...item, keep }));
    });
    return removes;
}

function scanRedditCommentChains() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const chains = collectRedditCommentChainGroups();
    const removes = collectCommentKeepRemoves();
    const box = document.getElementById('reddit-comment-results');
    if (!box) return;
    startBulkPick('comment-keep');
    removes.forEach(item => bulkPickBox('comment-keep', item.node));
    if (!chains.length) {
        box.innerHTML = '<p>No posts with more than one comment permalink in this library.</p>';
        setBulkPlan('comment-keep', { count: 0, label: 'Keep oldest comment chain', apply: applyCommentKeep });
        return;
    }
    box.innerHTML = `<p>${formatCount(chains.length)} post(s) have multiple comment chains. Apply keeps the oldest (post-only wins ties) and removes ${formatCount(removes.length)} extra(s). Uncheck an extra to keep it.</p>` + chains.slice(0, 40).map(items => {
        const keep = pickCommentKeep(items);
        return `<table class="excel-table">
            <thead><tr><th colspan="4">Post ${escapeHtml(items[0].post)} · ${formatCount(items.length)} links</th></tr>
            <tr><th class="bulk-pick-col"></th><th>Title</th><th>Comment id</th><th>URL</th></tr></thead>
            <tbody>${items.map(item => `<tr>
                <td>${item.node === keep.node ? '' : bulkPickBox('comment-keep', item.node)}</td>
                <td>${escapeHtml(item.title)}${item.node === keep.node ? ' <strong>(keep)</strong>' : ''}</td>
                <td>${escapeHtml(item.comment || '(post)')}</td>
                <td class="log-url">${escapeHtml(item.uri)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    }).join('');
    setBulkPlan('comment-keep', { count: removes.length, label: 'Keep oldest comment chain', apply: applyCommentKeep });
    logAffected('SYSTEM', 'Reddit comment chains', `Comment-keep scan: grouped Reddit comment permalinks that share a post id. ${formatCount(chains.length)} post(s); ${formatCount(removes.length)} extra comment bookmark(s) would be deleted on Apply (oldest kept; a post-only URL wins ties). Scan did not delete. Apply Keep oldest to remove the extras.`, { source: 'Reddit tools', scan: true });
}

function applyCommentKeep() {
    const removes = collectCommentKeepRemoves().filter(item => bulkPicked('comment-keep', item.node));
    withUndo('Keep oldest comment chain', api => {
        removes.forEach(item => {
            api.remove(item.node, item.parent);
            logAffected('REMOVED', item.title, `Dropped extra comment permalink; kept “${item.keep.title}”.`, {
                source: 'Reddit tools',
                node: item.node,
                uri: item.uri
            });
        });
    });
    markChanged();
    renderSidebar();
    scanRedditCommentChains();
    alert(`Removed ${formatCount(removes.length)} extra comment permalink(s).`);
}
