// Statistics — domain stats, sessions, heatmap, panels. Globals used by HTML onclick.
const STATS_WINDOWS = [
    { id: 'minute', label: 'Minute', ms: 60 * 1000 },
    { id: 'hour', label: 'Hour', ms: 60 * 60 * 1000 },
    { id: 'day', label: 'Day', ms: 24 * 60 * 60 * 1000 },
    { id: 'month', label: 'Month', ms: 30 * 24 * 60 * 60 * 1000 },
    { id: 'year', label: 'Year', ms: 365.25 * 24 * 60 * 60 * 1000 },
    { id: 'years5', label: '5 years', ms: 5 * 365.25 * 24 * 60 * 60 * 1000 },
    { id: 'years10', label: '10 years', ms: 10 * 365.25 * 24 * 60 * 60 * 1000 }
];
let lastStatsModel = null;
let highlightBookmark = null;
let libraryRevealPending = false;
let folderChipPath = '';
let activeStatsTab = 'chains';
let statsFilterTimer = 0;
let panelTableState = { links: [], filtered: [], page: 0, pageSize: 100, query: '', title: '', meta: '', domain: null, bucketKey: null, windowId: null, chipsExpanded: false, folderFilter: '', selected: 0, chainId: null };
const PANEL_CHIP_PREVIEW = 40;
const STATS_TABS = [
    { id: 'chains', label: 'Search chains', countKey: 'chains' },
    { id: 'topics', label: 'Topics', countKey: 'topics' },
    { id: 'binges', label: 'Binges', countKey: 'binges' },
    { id: 'sessions', label: 'Sessions', countKey: 'bursts' },
    { id: 'collisions', label: 'Clock collisions', countKey: 'collisions' },
    { id: 'returning', label: 'Returning', countKey: 'returningCount' },
    // By domain carries the health columns too: one row per parent domain, with the time windows,
    // the tracking/duplicate/broken/never-used counts and the service preview side by side. The two
    // tabs read the same key, so they are one view.
    { id: 'domains', label: 'By domain', countKey: 'domains' },
    { id: 'heatmap', label: 'Heatmap', countKey: 'heatmap' },
    // Reporting views added for the library reports (folder sizes). They are ordinary STATS_TABS
    // entries, so the summary cards and switchStatsTab drive them with no other change.
    { id: 'folder-size', label: 'Folder sizes', countKey: 'folderRank' }
];

function formatStatsNumber(n) {
    if (!Number.isFinite(n) || n === 0) return '0';
    if (Math.abs(n) >= 100) return Math.round(n).toLocaleString('en-US');
    if (Math.abs(n) >= 1) {
        const [whole, frac] = n.toFixed(2).replace(/\.?0+$/, '').split('.');
        return frac ? `${Number(whole).toLocaleString('en-US')}.${frac}` : Number(whole).toLocaleString('en-US');
    }
    if (Math.abs(n) >= 0.01) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    const digits = Math.abs(n) >= 0.0001 ? 6 : 8;
    return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function formatRate(count, windowMs) {
    if (!windowMs) return '—';
    return `${formatStatsNumber(count / (windowMs / (24 * 60 * 60 * 1000)))} / day`;
}

function formatHourRate(count, windowMs) {
    if (!windowMs) return '—';
    return `${formatStatsNumber(count / (windowMs / (60 * 60 * 1000)))} / hour`;
}

function classifyLink(uri) {
    try {
        const url = new URL(uri);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const parent = parentDomainFromHost(host);
        const path = decodeURIComponent(url.pathname || '/');
        const service = serviceBreakdown(parent, host, url, path);
        return { host, parent, rdnn: toRdnn(parent), service };
    } catch (e) {
        return { host: 'invalid', parent: 'invalid', rdnn: 'invalid', service: null };
    }
}

function serviceBreakdown(parent, host, url, path) {
    if (parent === 'reddit.com') {
        const sub = redditSubredditFromUri(url.href);
        if (sub) return { service: 'Reddit', kind: 'Subreddit', key: sub.toLowerCase(), label: `r/${sub}` };
        const user = path.match(/\/(u|user)\/([^/]+)/i);
        if (user) return { service: 'Reddit', kind: 'User', key: user[2].toLowerCase(), label: `u/${user[2]}` };
        return { service: 'Reddit', kind: 'Other', key: 'other', label: 'Other Reddit pages' };
    }
    if (parent === 'youtube.com') {
        if (/\/shorts\//i.test(path)) return { service: 'YouTube', kind: 'Type', key: 'shorts', label: 'Shorts' };
        if (url.searchParams.get('list') || /\/playlist/i.test(path)) return { service: 'YouTube', kind: 'Type', key: 'playlist', label: 'Playlists' };
        if (/\/(channel|c|user)\//i.test(path) || path.startsWith('/@')) {
            const name = (path.match(/\/@([^/]+)/) || path.match(/\/(?:channel|c|user)\/([^/]+)/i) || [, 'channel'])[1];
            return { service: 'YouTube', kind: 'Channel', key: name.toLowerCase(), label: path.startsWith('/@') ? `@${name}` : name };
        }
        if (host === 'youtu.be' || /\/watch/i.test(path) || /\/embed\//i.test(path)) {
            return { service: 'YouTube', kind: 'Type', key: 'video', label: 'Videos' };
        }
        return { service: 'YouTube', kind: 'Type', key: 'other', label: 'Other YouTube pages' };
    }
    if (parent === 'x.com') {
        const skip = new Set(['home', 'search', 'explore', 'i', 'intent', 'share', 'hashtag', 'settings']);
        const user = path.match(/^\/([A-Za-z0-9_]+)(?:\/|$)/);
        if (user && !skip.has(user[1].toLowerCase())) {
            return { service: 'X / Twitter', kind: 'Account', key: user[1].toLowerCase(), label: `@${user[1]}` };
        }
        return { service: 'X / Twitter', kind: 'Other', key: 'other', label: 'Other X pages' };
    }
    if (parent === 'github.com') {
        const parts = path.split('/').filter(Boolean);
        if (parts.length >= 2 && !['topics', 'orgs', 'settings', 'marketplace', 'notifications', 'login'].includes(parts[0].toLowerCase())) {
            return { service: 'GitHub', kind: 'Repository', key: `${parts[0]}/${parts[1]}`.toLowerCase(), label: `${parts[0]}/${parts[1]}` };
        }
        if (parts.length === 1) return { service: 'GitHub', kind: 'User / org', key: parts[0].toLowerCase(), label: parts[0] };
        return { service: 'GitHub', kind: 'Other', key: 'other', label: 'Other GitHub pages' };
    }
    if (parent.endsWith('wikipedia.org') || parent === 'wikipedia.org') {
        const lang = host.split('.')[0] || 'wiki';
        const article = decodeURIComponent((path.match(/\/wiki\/(.+)/) || [, 'Other'])[1]).replace(/_/g, ' ');
        return { service: 'Wikipedia', kind: `${lang} article`, key: article.toLowerCase(), label: article };
    }
    if (parent === 'ycombinator.com' || host.includes('hcker.news') || host.includes('hckr.news')) {
        const id = url.searchParams.get('id') || url.searchParams.get('comments');
        return { service: 'Hacker News', kind: 'Item', key: id || 'other', label: id ? `Item ${id}` : 'Other HN pages' };
    }
    if (parent === 'stackoverflow.com' || parent.endsWith('.stackexchange.com')) {
        const tag = path.match(/\/questions\/tagged\/([^/]+)/i);
        if (tag) return { service: 'Stack Exchange', kind: 'Tag', key: tag[1].toLowerCase(), label: tag[1] };
        const q = path.match(/\/questions\/(\d+)/i);
        if (q) return { service: 'Stack Exchange', kind: 'Question', key: q[1], label: `Question ${q[1]}` };
        return { service: 'Stack Exchange', kind: 'Other', key: 'other', label: 'Other pages' };
    }
    if (parent === 'instagram.com') {
        const skip = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts']);
        const user = path.match(/^\/([^/]+)/);
        if (user && !skip.has(user[1].toLowerCase())) {
            return { service: 'Instagram', kind: 'Account', key: user[1].toLowerCase(), label: `@${user[1]}` };
        }
        if (/\/(p|reel|reels)\//i.test(path)) return { service: 'Instagram', kind: 'Type', key: 'post', label: 'Posts / reels' };
        return { service: 'Instagram', kind: 'Other', key: 'other', label: 'Other Instagram pages' };
    }
    if (parent === 'tiktok.com') {
        const user = path.match(/^\/@([^/]+)/);
        if (user) return { service: 'TikTok', kind: 'Account', key: user[1].toLowerCase(), label: `@${user[1]}` };
        return { service: 'TikTok', kind: 'Other', key: 'other', label: 'Other TikTok pages' };
    }
    return null;
}

function youtubeChannelNameFromTitle(title) {
    const name = String(title || '').replace(/\s*[-–—|]\s*YouTube\s*$/i, '').trim();
    if (!name || /^UC[\w-]{10,}$/i.test(name) || /^https?:/i.test(name)) return '';
    return name;
}

function youtubeChannelChipLabel(service) {
    const label = service.label || '';
    if (service.service !== 'YouTube' || service.kind !== 'Channel' || !/^UC/i.test(label)) return label;
    const counts = new Map();
    (service.links || []).forEach(link => {
        const name = youtubeChannelNameFromTitle(link.title);
        if (!name) return;
        const key = name.toLowerCase();
        const row = counts.get(key) || { name, count: 0 };
        row.count += 1;
        counts.set(key, row);
    });
    let best = null;
    counts.forEach(row => {
        if (!best || row.count > best.count) best = row;
    });
    return best ? best.name : label;
}

function windowStatsForDates(dates, now) {
    return STATS_WINDOWS.map(window => {
        const count = dates.filter(ms => ms != null && now - ms <= window.ms && now - ms >= 0).length;
        return { ...window, count, ratePerDay: count / (window.ms / (24 * 60 * 60 * 1000)) };
    });
}

function buildStatisticsModel(root) {
    const links = collectBookmarkLinks(root);
    const groups = new Map();
    const now = Date.now();
    for (const link of links) {
        const classified = classifyLink(link.uri);
        if (!groups.has(classified.rdnn)) {
            groups.set(classified.rdnn, {
                rdnn: classified.rdnn,
                parent: classified.parent,
                hosts: new Set(),
                links: [],
                services: new Map()
            });
        }
        const group = groups.get(classified.rdnn);
        group.hosts.add(classified.host);
        group.links.push(link);
        if (classified.service) {
            const bucketKey = `${classified.service.service}|${classified.service.kind}|${classified.service.key}`;
            if (!group.services.has(bucketKey)) {
                group.services.set(bucketKey, { ...classified.service, count: 0, dates: [], links: [] });
            }
            const bucket = group.services.get(bucketKey);
            bucket.count++;
            bucket.links.push(link);
            if (link.addedMs) bucket.dates.push(link.addedMs);
        }
    }
    const domains = [...groups.values()].map(group => {
        const dates = group.links.map(link => link.addedMs).filter(Boolean).sort((a, b) => a - b);
        return {
            rdnn: group.rdnn,
            parent: group.parent,
            hosts: [...group.hosts].sort(),
            count: group.links.length,
            datedCount: dates.length,
            firstAdded: dates[0] || null,
            lastAdded: dates[dates.length - 1] || null,
            windows: windowStatsForDates(dates, now),
            services: [...group.services.values()].map(service => {
                const label = youtubeChannelChipLabel(service);
                return label === service.label ? service : { ...service, label };
            }).sort((a, b) => b.count - a.count),
            links: group.links
        };
    });
    return { links, domains, now };
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60 * 1000) return `${formatStatsNumber(ms / 1000)} s`;
    if (ms < 60 * 60 * 1000) return `${formatStatsNumber(ms / 60000)} min`;
    return `${formatStatsNumber(ms / 3600000)} h`;
}

function coreLookupTitle(title, uri) {
    try {
        const url = new URL(uri);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (host.includes('google.') && (url.pathname.includes('/search') || url.searchParams.has('q'))) {
            const q = url.searchParams.get('q');
            if (q) return q;
        }
        if (host.includes('bing.com') && url.searchParams.get('q')) return url.searchParams.get('q');
        if (host.includes('duckduckgo.com') && url.searchParams.get('q')) return url.searchParams.get('q');
        if (host.includes('wikipedia.org')) {
            const article = decodeURIComponent((url.pathname.match(/\/wiki\/(.+)/) || [, ''])[1]).replace(/_/g, ' ');
            if (article && article !== 'Special:Search') return article;
        }
    } catch (e) {}
    return String(title || '')
        .replace(/\s*[-–—|]\s*(Google Search|Wikipedia|YouTube|Hacker News|Reddit|Bing|DuckDuckGo)\s*$/i, '')
        .trim();
}

function burstTopic(links) {
    const queries = [];
    for (const link of links) {
        try {
            const url = new URL(link.uri);
            const host = url.hostname.toLowerCase();
            if ((host.includes('google.') || host.includes('bing.com') || host.includes('duckduckgo.com')) && url.searchParams.get('q')) {
                queries.push(url.searchParams.get('q'));
            }
        } catch (e) {}
    }
    const uniqueQueries = [...new Set(queries)];
    if (uniqueQueries.length) return uniqueQueries.join(' · ');
    const cores = links.map(link => coreLookupTitle(link.title, link.uri)).filter(Boolean);
    const freq = new Map();
    const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'www']);
    cores.forEach(core => {
        String(core).toLowerCase().split(/[^a-z0-9]+/i).forEach(word => {
            if (word.length < 3 || stop.has(word)) return;
            freq.set(word, (freq.get(word) || 0) + 1);
        });
    });
    const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shared = ranked.filter(entry => entry[1] >= 2).slice(0, 3).map(entry => entry[0]);
    if (shared.length) return shared.join(' · ');
    return cores.slice(0, 3).join(' → ') || 'Untitled session';
}

const CLOCK_BATCH_MIN = 8;
const BINGE_DOMAINS = new Set(['youtube.com', 'reddit.com', 'ycombinator.com', 'x.com', 'tiktok.com', 'instagram.com', 'twitch.tv']);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function linkHost(link) {
    try { return new URL(link.uri).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) {
        const match = String(link.uri || '').match(/^https?:\/\/([^/?#:]+)/i);
        return match ? match[1].toLowerCase().replace(/^www\./, '') : '';
    }
}

function parentOfLink(link) {
    const host = linkHost(link);
    return host ? parentDomainFromHost(host) : 'unknown';
}

function chainActionButtonHtml(id, kind = 'Search chain') {
    const safe = escapeHtml(id);
    const label = escapeHtml(kind);
    return `<button type="button" class="ghost-btn chain-send-btn" data-send-chain="${safe}" data-send-mode="keep">Send ${label} to Obsidian</button>`
        + `<button type="button" class="ghost-btn chain-send-btn" data-send-chain="${safe}" data-send-mode="delete">Send ${label} to Obsidian and delete</button>`
        + `<button type="button" class="delete-btn chain-send-btn" data-delete-chain="${safe}">Delete whole ${label.toLowerCase()}</button>`;
}

function sendSearchChainToObsidian(groupId, mode) {
    // A row can be a chain, topic, binge, session or collision, so look in all of them.
    const group = lastStatsModel?.chains?.find(item => item.id === groupId)
        || (typeof findAnalyticsGroup === 'function' ? findAnalyticsGroup(groupId) : null);
    const links = group?.links || [];
    if (!links.length) return;
    const remove = mode === 'delete';
    const n = links.length;
    const kind = (typeof sessionKindLabel === 'function' ? (sessionKindLabel(group) || 'Search chain') : 'Search chain');
    const msg = remove
        ? `Send this ${kind} to Obsidian and delete ${formatCount(n)} bookmark(s)?`
        : `Send this ${kind} to Obsidian? Bookmarks stay in the library.`;
    if (!confirm(msg)) return;
    sendMarkdownByDestination(searchChainMarkdown(group)).then(() => {
        if (!remove) return;
        withUndo('Send Search chain to Obsidian and delete', api => {
            links.forEach(link => {
                if (!link.node || !link.parent) return;
                api.remove(link.node, link.parent);
                logAffected('REMOVED', link.title || link.uri, 'Sent Search chain to Obsidian and deleted.', {
                    source: 'Search chains',
                    node: link.node,
                    uri: link.uri,
                    dateAdded: link.dateAdded
                });
            });
        });
        markChanged();
        renderSidebar();
        closeStatsPanel();
        rebuildStatistics();
        if (typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') {
            maybeRefreshDuplicateBookmarksAfterDelete(links.map(link => link.node));
        }
    }).catch(err => alert(err && err.message ? err.message : String(err)));
}

function sendSearchChainToObsidianAndDelete(groupId) {
    sendSearchChainToObsidian(groupId, 'delete');
}

function deleteSearchChainWhole(groupId) {
    const group = lastStatsModel?.chains?.find(item => item.id === groupId);
    const links = group?.links || [];
    if (!links.length) return;
    const topic = group.topic || 'this Search chain';
    const n = links.length;
    if (!confirm(`Delete whole Search chain “${topic}” (${formatCount(n)} bookmark(s))? This does not send to Obsidian.`)) return;
    withUndo('Delete Search chain', api => {
        links.forEach(link => {
            if (!link.node) return;
            const parent = link.parent || findBookmarkParent(link.node);
            if (!parent) return;
            api.remove(link.node, parent);
            logAffected('REMOVED', link.title || link.uri, 'Deleted Search chain bookmark (no Obsidian send).', {
                source: 'Search chains',
                node: link.node,
                uri: link.uri,
                dateAdded: link.dateAdded,
                folderPath: link.folderPath
            });
        });
    });
    markChanged();
    renderSidebar();
    closeStatsPanel();
    rebuildStatistics();
    if (typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') {
        maybeRefreshDuplicateBookmarksAfterDelete(links.map(link => link.node));
    }
}

function bindChainSendButtons(root) {
    if (!root) return;
    root.querySelectorAll('[data-send-chain]').forEach(btn => {
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            sendSearchChainToObsidian(btn.dataset.sendChain, btn.dataset.sendMode || 'delete');
        });
    });
    root.querySelectorAll('[data-delete-chain]').forEach(btn => {
        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            deleteSearchChainWhole(btn.dataset.deleteChain);
        });
    });
}

function setPanelChainAction(chainId, kind = 'Search chain') {
    const box = document.getElementById('stats-panel-actions');
    if (!box) return;
    if (!chainId) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    box.hidden = false;
    box.innerHTML = chainActionButtonHtml(chainId, kind);
    bindChainSendButtons(box);
}

function wikiArticle(link) {
    try {
        const url = new URL(link.uri);
        if (!url.hostname.includes('wikipedia.org')) return '';
        const article = decodeURIComponent((url.pathname.match(/\/wiki\/(.+)/) || [, ''])[1]).replace(/_/g, ' ');
        if (article && !article.startsWith('Special:')) return article;
    } catch (e) {}
    const path = String(link.uri || '').match(/wikipedia\.org\/wiki\/([^?#]+)/i);
    if (path) {
        try {
            const article = decodeURIComponent(path[1]).replace(/_/g, ' ');
            if (article && !article.startsWith('Special:')) return article;
        } catch (e) {}
    }
    const titled = String(link.title || '').match(/^(.*?)\s*[-–—|]\s*Wikipedia\b/i);
    return titled ? titled[1].trim() : '';
}

function destinationKind(link) {
    const parent = parentOfLink(link);
    if (parent === 'wikipedia.org' || parent.endsWith('wikipedia.org')) return 'Wikipedia';
    if (parent === 'github.com') return 'GitHub';
    if (parent === 'youtube.com') return 'YouTube';
    if (parent === 'reddit.com') return 'Reddit';
    if (parent === 'ycombinator.com') return 'Hacker News';
    if (/amazon\.|amzn\.|ebay\.|etsy\.|walmart\.|aliexpress\./.test(parent)) return 'Shopping';
    if (/docs\.|readthedocs|developer\.|learn\./.test(parent) || /\/docs\//i.test(link.uri || '')) return 'Docs';
    if (isSearchLink(link)) return 'Search';
    return parent;
}

function classifyBurstMix(links) {
    const counts = new Map();
    links.forEach(link => {
        const parent = parentOfLink(link);
        counts.set(parent, (counts.get(parent) || 0) + 1);
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0] || ['unknown', 0];
    const share = links.length ? top[1] / links.length : 0;
    return {
        topDomain: top[0],
        share,
        isBinge: share >= 0.7 && (BINGE_DOMAINS.has(top[0]) || top[1] >= 5),
        isMixed: counts.size >= 3,
        uniqueDomains: counts.size
    };
}

function formatRelative(ms) {
    if (!ms) return '—';
    const delta = Date.now() - ms;
    if (delta < 60 * 1000) return 'just now';
    if (delta < 60 * 60 * 1000) return `${Math.round(delta / 60000)} min ago`;
    if (delta < 24 * 60 * 60 * 1000) return `${Math.round(delta / 3600000)} h ago`;
    if (delta < 30 * 24 * 60 * 60 * 1000) return `${Math.round(delta / (24 * 3600000))} d ago`;
    if (delta < 365 * 24 * 60 * 60 * 1000) return `${Math.round(delta / (30 * 24 * 3600000))} mo ago`;
    return `${formatStatsNumber(delta / (365.25 * 24 * 3600000))} y ago`;
}

function normalizeStem(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function findClockCollisions(links, minBatch = CLOCK_BATCH_MIN) {
    const byTime = new Map();
    links.forEach(link => {
        if (link.addedMs == null || link.addedMs < Date.UTC(1970, 0, 2)) return;
        if (!byTime.has(link.addedMs)) byTime.set(link.addedMs, []);
        byTime.get(link.addedMs).push(link);
    });
    return [...byTime.entries()]
        .filter(([, group]) => group.length >= minBatch)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([addedMs, group], index) => ({
            id: `collision-${index}-${addedMs}`,
            topic: `Clock collision · ${group.length} items`,
            links: group.slice().sort((a, b) => String(a.title).localeCompare(String(b.title))),
            count: group.length,
            firstAdded: addedMs,
            lastAdded: addedMs,
            spanMs: 0,
            maxGapMs: 0,
            hosts: [...new Set(group.map(link => linkHost(link) || 'unknown'))],
            sameTimestamp: true,
            trail: group.map(link => link.title || link.uri)
        }));
}

function clusterQuickAdds(links, gapMs, minSize, excludeNodes = new Set()) {
    const dated = links
        .filter(link => link.addedMs != null && link.addedMs >= Date.UTC(1970, 0, 2) && !excludeNodes.has(link.node))
        .sort((a, b) => a.addedMs - b.addedMs || String(a.title).localeCompare(String(b.title)));
    const bursts = [];
    let current = [];
    const flush = () => {
        if (current.length < minSize) {
            current = [];
            return;
        }
        const first = current[0].addedMs;
        const last = current[current.length - 1].addedMs;
        const gaps = current.slice(1).map((link, i) => link.addedMs - current[i].addedMs);
        const maxGap = gaps.length ? Math.max(...gaps) : 0;
        const hosts = [...new Set(current.map(link => linkHost(link) || 'unknown'))];
        const mix = classifyBurstMix(current);
        bursts.push({
            id: `burst-${bursts.length}-${first}`,
            topic: burstTopic(current),
            links: current.slice(),
            count: current.length,
            firstAdded: first,
            lastAdded: last,
            spanMs: last - first,
            maxGapMs: maxGap,
            hosts,
            sameTimestamp: maxGap === 0,
            trail: current.map(link => link.title || link.uri),
            ...mix
        });
        current = [];
    };
    dated.forEach(link => {
        if (!current.length) {
            current = [link];
            return;
        }
        if (link.addedMs - current[current.length - 1].addedMs <= gapMs) current.push(link);
        else {
            flush();
            current = [link];
        }
    });
    flush();
    return bursts.sort((a, b) => b.lastAdded - a.lastAdded);
}

function buildSearchChains(links, gapMs, excludeNodes = new Set()) {
    return clusterSearchChains(links, gapMs, excludeNodes).map((chain, index) => {
        const cluster = chain.links;
        return {
            id: `chain-${index}-${cluster[0].addedMs}`,
            topic: chain.topic || burstTopic(cluster),
            queries: chain.queries,
            destKinds: [...new Set(chain.destinations.map(destinationKind))],
            links: cluster,
            destinations: chain.destinations,
            count: cluster.length,
            firstAdded: cluster[0].addedMs,
            lastAdded: cluster[cluster.length - 1].addedMs,
            spanMs: cluster[cluster.length - 1].addedMs - cluster[0].addedMs,
            hosts: [...new Set(cluster.map(link => linkHost(link) || 'unknown'))],
            trail: cluster.map(link => link.title || link.uri),
            sameTimestamp: false
        };
    }).sort((a, b) => b.lastAdded - a.lastAdded);
}

function burstStems(group) {
    const stems = new Set();
    (group.queries || []).forEach(q => { const s = normalizeStem(q); if (s) stems.add(s); });
    if (group.topic) normalizeStem(group.topic).split(' ').forEach(word => { if (word.length > 2) stems.add(word); });
    (group.links || []).forEach(link => {
        const q = normalizeStem(extractSearchQuery(link));
        if (q) stems.add(q);
        const wiki = normalizeStem(wikiArticle(link));
        if (wiki) stems.add(wiki);
        const core = normalizeStem(coreLookupTitle(link.title, link.uri));
        if (core) stems.add(core);
        core.split(' ').forEach(word => { if (word.length > 2) stems.add(word); });
    });
    stems.delete('');
    ['the', 'and', 'for', 'with', 'from', 'this', 'that', 'www', 'http', 'https', 'com', 'org', 'search', 'google', 'wikipedia', 'youtube'].forEach(word => stems.delete(word));
    return [...stems].filter(stem => stem.length > 2);
}

function buildTopicMerges(bursts, chains) {
    const groups = [...bursts, ...chains];
    const stemMap = new Map();
    groups.forEach(group => {
        burstStems(group).forEach(stem => {
            if (!stemMap.has(stem)) stemMap.set(stem, new Set());
            stemMap.get(stem).add(group);
        });
    });
    const used = new Set();
    const topics = [];
    for (const [stem, members] of [...stemMap.entries()].sort((a, b) => b[1].size - a[1].size)) {
        const sessions = [...members].filter(item => !used.has(item.id));
        const days = new Set(sessions.map(item => new Date(item.firstAdded).toDateString()));
        if (sessions.length < 2 || days.size < 2) continue;
        sessions.forEach(item => used.add(item.id));
        const links = [];
        const seen = new Set();
        sessions.forEach(item => item.links.forEach(link => {
            if (!seen.has(link.node)) {
                seen.add(link.node);
                links.push(link);
            }
        }));
        links.sort((a, b) => a.addedMs - b.addedMs);
        topics.push({
            id: `topic-${topics.length}-${stem.replace(/\s+/g, '-')}`,
            topic: stem,
            sessions,
            links,
            count: links.length,
            sessionCount: sessions.length,
            dayCount: days.size,
            firstAdded: links[0]?.addedMs || sessions[0].firstAdded,
            lastAdded: links[links.length - 1]?.addedMs || sessions[0].lastAdded,
            hosts: [...new Set(links.map(link => linkHost(link) || 'unknown'))],
            trail: sessions.map(item => `${item.topic} (${new Date(item.firstAdded).toLocaleDateString()})`),
            sameTimestamp: false
        });
    }
    return topics.sort((a, b) => b.sessionCount - a.sessionCount || b.lastAdded - a.lastAdded);
}

const HEAT_GRAINS = [1, 2, 3, 4, 6, 8, 12];
const HEAT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let heatmapGrain = 1;
const HEAT_BOOM_MS = 1600;
const HEAT_FIRE_IN_MS = 250;
let heatmapHeld = false;
let heatmapPhase = '';
let heatmapFireTimer = 0;
let heatmapBoomAt = { x: 50, y: 50 };
let heatmapFlameAt = { x: 50, y: 80 };
let heatmapSawFire = false;

function heatLiveCard() {
    return document.querySelector('#stats-summary [data-tab="heatmap"]');
}

function heatStampOk(ms) {
    return ms != null && ms >= Date.UTC(1970, 0, 2);
}

function buildHeatmap(links) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    const buckets = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
    let max = 0;
    links.forEach(link => {
        if (!heatStampOk(link.addedMs)) return;
        const date = new Date(link.addedMs);
        const day = date.getDay();
        const hour = date.getHours();
        grid[day][hour]++;
        buckets[day][hour].push(link);
        if (grid[day][hour] > max) max = grid[day][hour];
    });
    const monthGrid = Array.from({ length: 12 }, () => Array(31).fill(0));
    const monthBuckets = Array.from({ length: 12 }, () => Array.from({ length: 31 }, () => []));
    let monthMax = 0;
    const byYear = new Map();
    links.forEach(link => {
        if (!heatStampOk(link.addedMs)) return;
        const date = new Date(link.addedMs);
        const month = date.getMonth();
        const dom = date.getDate() - 1;
        monthGrid[month][dom]++;
        monthBuckets[month][dom].push(link);
        if (monthGrid[month][dom] > monthMax) monthMax = monthGrid[month][dom];
        const year = date.getFullYear();
        if (!byYear.has(year)) {
            byYear.set(year, {
                grid: Array(12).fill(0),
                buckets: Array.from({ length: 12 }, () => [])
            });
        }
        const row = byYear.get(year);
        const m = date.getMonth();
        row.grid[m]++;
        row.buckets[m].push(link);
    });
    const years = [...byYear.keys()].sort((a, b) => a - b).map(year => {
        const row = byYear.get(year);
        return { year, grid: row.grid, buckets: row.buckets };
    });
    const yearMax = years.reduce((max, row) => Math.max(max, ...row.grid), 0);
    return {
        grid, buckets, max: max || 1,
        month: { grid: monthGrid, buckets: monthBuckets, max: monthMax || 1 },
        years, yearMax: yearMax || 1
    };
}

function collapseHeatHours(heatmap, grain) {
    const cols = Math.ceil(24 / grain);
    const grid = heatmap.grid.map(row => Array.from({ length: cols }, (_, col) => {
        let n = 0;
        for (let hour = col * grain; hour < Math.min(24, (col + 1) * grain); hour++) n += row[hour];
        return n;
    }));
    const buckets = heatmap.buckets.map(row => Array.from({ length: cols }, (_, col) => {
        const links = [];
        for (let hour = col * grain; hour < Math.min(24, (col + 1) * grain); hour++) links.push(...row[hour]);
        return links;
    }));
    const max = grid.reduce((peak, row) => Math.max(peak, ...row), 0);
    return { grid, buckets, max: max || 1, grain, cols };
}

function trailCellHtml(titles, dataAttr, dataValue) {
    const safe = titles.map(title => title || 'Untitled');
    if (safe.length <= 5) {
        return safe.map(title => escapeHtml(title)).join(' <span>→</span> ');
    }
    const head = safe.slice(0, 3).map(title => escapeHtml(title)).join(' <span>→</span> ');
    return `${head} <span>→</span> <button type="button" class="stats-chip trail-more" ${dataAttr}="${escapeHtml(dataValue)}">long trail · ${formatCount(safe.length)} items</button>`;
}

function filterStatistics() {
    clearTimeout(statsFilterTimer);
    statsFilterTimer = setTimeout(paintStatistics, 80);
}

function rebuildStatistics() {
    statsModelCache = { key: '', model: null };
    renderStatistics();
}

function switchStatsTab(tabId) {
    activeStatsTab = tabId;
    paintStatistics();
}

function groupHay(item) {
    if (item._hay) return item._hay;
    item._hay = [item.topic, item.trail?.join(' '), item.hosts?.join(' '), item.queries?.join(' '), ...(item.links || []).map(link => `${link.title} ${link.uri}`)].join(' ').toLowerCase();
    return item._hay;
}

function getAnalyticsModel() {
    const gapMs = Number(document.getElementById('stats-burst-gap')?.value) || SEARCH_CHAIN_GAP_MS;
    const minSize = Number(document.getElementById('stats-burst-min')?.value) || 3;
    const key = `${statsDataRev}|${gapMs}|${minSize}`;
    if (statsModelCache.key === key && statsModelCache.model) return statsModelCache.model;
    const model = buildStatisticsModel(bookmarkData);
    model.gapMs = gapMs;
    model.minSize = minSize;
    model.collisions = findClockCollisions(model.links);
    const excludeNodes = new Set(model.collisions.flatMap(batch => batch.links.map(link => link.node)));
    model.bursts = clusterQuickAdds(model.links, gapMs, minSize, excludeNodes);
    model.chains = buildSearchChains(model.links, gapMs, excludeNodes);
    model.topics = buildTopicMerges(model.bursts, model.chains);
    model.binges = model.bursts.filter(burst => burst.isBinge);
    model.heatmap = buildHeatmap(model.links);
    statsModelCache = { key, model };
    lastStatsModel = model;
    return model;
}

function renderStatistics() {
    paintStatistics();
}

// The By-domain table's row order, shared by the on-screen table and its CSV rows.
// A header click in the By-domain table: { key, dir }. Null means the dropdown decides.
let statsSortState = { key: null, dir: -1 };
// Folder size ranking: the model arrives by descendant links descending, which is the default.
let folderSort = { key: 'links', dir: -1 };

// Back to the table's own default order. Each section's chip calls this with its scope.
function resetStatsSort(scope) {
    if (scope === 'session') sessionSort = { key: 'started', dir: -1 };
    else if (scope === 'returning') returningSort = { key: 'last', dir: -1 };
    else if (scope === 'domains') statsSortState = { key: null, dir: -1 };
    else if (scope === 'folder') folderSort = { key: 'links', dir: -1 };
    repaintAnalytics();
}

// True when the table is already in its default order, i.e. when the chip would do nothing.
function sortIsDefault(scope) {
    if (scope === 'session') return sessionSort.key === 'started' && sessionSort.dir === -1;
    if (scope === 'returning') return returningSort.key === 'last' && returningSort.dir === -1;
    if (scope === 'domains') return !statsSortState.key;
    if (scope === 'folder') return folderSort.key === 'links' && folderSort.dir === -1;
    return true;
}

function sortResetButton(scope) {
    if (sortIsDefault(scope)) return '';
    return ` <button type="button" class="stats-chip" data-sort-reset="${scope}" title="Back to this table's default order">Reset sort</button>`;
}

function sortStatsDomains(domains) {
    const sort = statsSortState.key || document.getElementById('stats-sort')?.value || 'count';
    const dir = statsSortState.key ? statsSortState.dir : -1;
    // The health columns come from the memoised model, the window columns from the domain itself, so
    // every header in that table sorts on its own numbers.
    let health = null;
    const healthFor = rdnn => {
        if (!health) {
            try { health = buildDomainHealthTable(); } catch (err) { health = { rows: [] }; }
        }
        return (health.rows || []).find(row => row.rdnn === rdnn) || {};
    };
    const value = (domain, key) => {
        if (key === 'rdnn') return 0;
        if (key === 'count' || key === 'total') return domain.count || 0;
        if (['tracked', 'duplicates', 'broken'].includes(key)) return Number(healthFor(domain.rdnn)[key]) || 0;
        const window = (domain.windows || []).find(w => w.id === key);
        if (window) return window.count || 0;
        return 0;
    };
    return (domains || []).slice().sort((a, b) => {
        if (sort === 'rdnn') return dir * a.rdnn.localeCompare(b.rdnn);
        if (sort === 'recent') return dir * ((b.lastAdded || 0) - (a.lastAdded || 0));
        if (sort === 'oldest') return dir * ((a.firstAdded || Infinity) - (b.firstAdded || Infinity));
        if (sort === 'rate') {
            const rate = d => d.windows.find(w => w.id === 'day')?.count || 0;
            return dir * (rate(b) - rate(a)) || b.count - a.count;
        }
        // dir +1 is ascending, the same convention the session and returning sorters use, so the
        // header arrow means the same thing in every table.
        if (sort === 'rdnn' && statsSortState.key === 'rdnn') return dir * a.rdnn.localeCompare(b.rdnn);
        const diff = value(a, sort) - value(b, sort);
        if (diff) return dir * diff;
        return a.rdnn.localeCompare(b.rdnn);
    });
}

function paintStatistics() {
    const summary = document.getElementById('stats-summary');
    const body = document.getElementById('stats-body');
    const meta = document.getElementById('stats-meta');
    if (!summary || !body) return;
    if (!bookmarkData) {
        lastStatsModel = null;
        summary.innerHTML = '';
        // The two builds say this differently; keeping it in one file keeps the copies identical.
        const liveCopy = typeof isLiveEditorCopy === 'function' && isLiveEditorCopy();
        meta.textContent = liveCopy
            ? 'Load this app as a Firefox or Chrome extension to read the live library.'
            : 'Import a bookmark JSON file to group links by parent domain.';
        body.innerHTML = liveCopy
            ? '<div class="stats-empty">No library loaded. In Firefox: about:debugging → This Firefox → Load Temporary Add-on → <code>manifest.json</code>.</div>'
            : '<div class="stats-empty">No file loaded. Use Import and Backup → Import Bookmarks from JSON.</div>';
        return;
    }

    const query = (document.getElementById('stats-search')?.value || '').trim().toLowerCase();
    const model = getAnalyticsModel();
    lastStatsModel = model;
    let domains = model.domains;
    let bursts = model.bursts;
    let chains = model.chains;
    let topics = model.topics;
    let binges = model.binges;
    let collisions = model.collisions;
    if (query) {
        domains = domains.filter(domain => {
            const hay = [
                domain.rdnn, domain.parent, domain.hosts.join(' '),
                ...domain.services.map(s => `${s.service} ${s.kind} ${s.label}`)
            ].join(' ').toLowerCase();
            return hay.includes(query);
        });
        bursts = bursts.filter(item => groupHay(item).includes(query));
        chains = chains.filter(item => groupHay(item).includes(query));
        topics = topics.filter(item => groupHay(item).includes(query));
        binges = binges.filter(item => groupHay(item).includes(query));
        collisions = collisions.filter(item => groupHay(item).includes(query));
    }
    domains = sortStatsDomains(domains);
    const counts = {
        chains: chains.length,
        topics: topics.length,
        binges: binges.length,
        bursts: bursts.length,
        collisions: collisions.length,
        returningCount: domains.filter(d => d.count > 1).length,
        domains: domains.length,
        heatmap: model.heatmap.grid
            .reduce((sum, row) => sum + row.reduce((n, cell) => n + cell, 0), 0),
        // Reporting cards: ranked folders, and the domains the table would show (filter-aware).
        folderRank: getFolderSizeRanking().rows.length,
        domainHealth: domains.length
    };

    meta.textContent = `${formatCount(model.links.length)} bookmarks · clustering cached until you change gap, min size, Refresh, or the file.`;
    summary.innerHTML = STATS_TABS.map(tab => {
        const n = tab.countKey ? counts[tab.countKey] : 0;
        const on = tab.id === activeStatsTab ? ' active' : '';
        const heat = tab.id === 'heatmap' ? ' heat-rev-3' : '';
        return `<button type="button" class="stats-card${heat}${on}" data-tab="${tab.id}" aria-pressed="${on ? 'true' : 'false'}"><div class="k">${escapeHtml(tab.label)}</div><div class="v">${formatCount(n)}</div></button>`;
    }).join('');
    summary.querySelectorAll('[data-tab]').forEach(btn => {
        btn.onclick = () => switchStatsTab(btn.dataset.tab);
    });
    const heatCard = summary.querySelector('[data-tab="heatmap"]');
    if (heatCard) {
        heatCard.onpointerdown = event => {
            heatmapHeld = true;
            const at = heatClickPoint(heatCard, event);
            if (at) {
                heatmapBoomAt = at;
                heatmapFlameAt = at;
            }
            startHeatmapExplode(heatCard);
        };
    }
    const liveHeat = heatLiveCard();
    if (heatmapPhase === 'boom') startHeatmapExplode(liveHeat);
    else if (heatmapPhase === 'burn') startHeatmapBurn(liveHeat);
    else if (heatmapPhase === 'implode') startHeatmapImplode(liveHeat);
    if (!window._heatmapHoldBound) {
        window._heatmapHoldBound = true;
        const release = event => {
            const card = heatLiveCard();
            if (!heatmapHeld && heatmapPhase !== 'boom' && heatmapPhase !== 'burn') return;
            heatmapHeld = false;
            heatPark(card, event);
            startHeatmapImplode(card);
        };
        const moveFire = event => {
            if (!heatmapHeld) return;
            const card = heatLiveCard();
            const at = heatClickPoint(card, event);
            if (!at) return;
            heatmapFlameAt = at;
            if (heatmapPhase === 'burn') placeHeatmapFire(card, at);
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
        window.addEventListener('pointermove', moveFire);
    }

    const sessionRow = (item, attr = 'data-group') => {
        return `<tr class="stats-row" ${attr}="${escapeHtml(item.id)}">
            <td>${escapeHtml(new Date(item.firstAdded).toLocaleString())}</td>
            <td class="stats-topic"><div class="stats-rdnn">${escapeHtml(item.topic)}</div><div class="stats-host">${escapeHtml((item.destKinds || item.hosts || []).slice(0, 4).join(', '))}</div></td>
            <td class="stats-num">${formatCount(item.count)}</td>
            <td class="stats-num">${escapeHtml(item.spanMs != null ? formatDuration(item.spanMs) : '—')}</td>
            <td>${escapeHtml(sessionKindLabel(item))}</td>
            <td class="burst-trail">${trailCellHtml(item.trail, attr, item.id)}</td>
        </tr>`;
    };
    const sessionMark = col => sessionSort.key === col ? (sessionSort.dir > 0 ? ' ↑' : ' ↓') : '';
    const sessionTh = (label, key, extra = '') =>
        `<th class="sort-col${extra}" data-sort="${key}" data-sort-group="session">${label}${sessionMark(key)}</th>`;
    const sectionTable = (title, help, items, empty, attr) => `
        <section class="stats-section">
            <h2>${title}${sortResetButton('session')}</h2>
            <p class="stats-section-help">${help}</p>
            ${items.length ? `<table class="stats-table">
                <thead><tr>${sessionTh('Started', 'started')}${sessionTh('Topic', 'topic')}${sessionTh('Links', 'links', ' stats-num')}${sessionTh('Span', 'span', ' stats-num')}${sessionTh('Kind', 'kind')}<th>Trail</th></tr></thead>
                <tbody>${sortSessionItems(items).map(item => sessionRow(item, attr)).join('')}</tbody>
            </table>` : `<div class="stats-empty">${empty}</div>`}
        </section>
    `;
    const gapMs = model.gapMs;
    const domainMark = key => (statsSortState.key === key ? (statsSortState.dir > 0 ? ' ↑' : ' ↓') : '');
    const domainWindowHeads = STATS_WINDOWS.map(w => `<th class="stats-num sort-col" data-sort="${escapeHtml(w.id)}" data-sort-group="domains">${escapeHtml(w.label)}${domainMark(w.id)}</th>`).join('');
    const windowHeads = STATS_WINDOWS.map(w => `<th class="stats-num">${escapeHtml(w.label)}</th>`).join('');
    // The health model is keyed the same way (RDNN), so a row can carry both tables' numbers.
    const healthModel = buildDomainHealthTable();
    const healthByRdnn = new Map(healthModel.rows.map(row => [row.rdnn, row]));
    const domainRows = domains.map(domain => {
        const windowCells = domain.windows.map(w =>
            `<td class="stats-num stats-window-cell" data-rdnn="${escapeHtml(domain.rdnn)}" data-window="${escapeHtml(w.id)}" title="${escapeHtml(formatRate(w.count, w.ms))}">${formatCount(w.count)}</td>`
        ).join('');
        const preview = domain.services.slice(0, 8).map(s =>
            `<button type="button" class="stats-chip" data-rdnn="${escapeHtml(domain.rdnn)}" data-bucket="${escapeHtml(`${s.service}|${s.kind}|${s.key}`)}">${escapeHtml(s.label)} · ${formatCount(s.count)}</button>`
        ).join('') || '<span class="stats-host">No extra service split</span>';
        const more = domain.services.length > 8 ? `<button type="button" class="stats-chip" data-rdnn="${escapeHtml(domain.rdnn)}">+${formatCount(domain.services.length - 8)} more</button>` : '';
        const health = healthByRdnn.get(domain.rdnn) || { tracked: 0, duplicates: 0, broken: 0 };
        const healthCells = `<td class="stats-num" title="stripTrackingParams would change the URL">${formatCount(health.tracked)}</td>
                <td class="stats-num" title="more than one bookmark shares the duplicateUrlKey">${formatCount(health.duplicates)}</td>
                <td class="stats-num" title="in the app's link-check results">${formatCount(health.broken)}</td>`;
        return `
            <tr class="stats-row" data-rdnn="${escapeHtml(domain.rdnn)}">
                <td><div class="stats-rdnn">${escapeHtml(domain.rdnn)}</div><div class="stats-host">${escapeHtml(domain.parent)}</div></td>
                ${windowCells}
                <td class="stats-num">${formatCount(domain.count)}</td>
                ${healthCells}
                <td>${preview}${more}</td>
            </tr>
        `;
    }).join('');
    const views = {
        chains: () => sectionTable(
            'Search → result chains',
            'A search-engine bookmark (<code>q=</code> on Google, DDG, Bing, Yahoo, Startpage) followed by Wikipedia, docs, GitHub, shopping, or other destinations within the quick-add gap.',
            chains, 'No search-to-result chains at this gap.', 'data-group'
        ),
        topics: () => sectionTable(
            'Topics across days',
            'Sessions that share a search query or Wikipedia/title stem even when they happened on different days.',
            topics, 'Need at least two sessions on different days that share a stem.', 'data-group'
        ),
        heatmap: () => renderHeatmapSection(model),
        binges: () => sectionTable(
            'Binge windows',
            'Clusters where ≥70% of saves are one binge domain (YouTube, Reddit, HN, X, TikTok, Instagram, Twitch) or five-plus links on one host.',
            binges, 'No single-site binge windows at this gap.', 'data-group'
        ),
        sessions: () => sectionTable(
            'Quick-add sessions',
            `Groups whose <code>dateAdded</code> is within ${escapeHtml(formatDuration(gapMs))} of the previous save. Clock-collision batches and epoch dates are left out.`,
            bursts, 'No quick-add clusters at this gap and minimum size.', 'data-group'
        ),
        collisions: () => sectionTable(
            'Clock collision batches',
            `Imported or pasted groups that share one <code>dateAdded</code> (${CLOCK_BATCH_MIN}+ items). Excluded from session clustering.`,
            collisions, 'No identical-timestamp batches.', 'data-group'
        ),
        returning: () => renderReturningSection(domains),
        domains: () => `
            <section class="stats-section">
                <h2>By parent domain and its health${sortResetButton('domains')}</h2>
                <p class="stats-section-help">Click a domain, a time window, or a service chip to open the detail panel. Sort and search apply to this list. Tracking = <code>stripTrackingParams(uri)</code> would change the URL; Duplicates = more than one bookmark shares the <code>duplicateUrlKey</code>; Broken = the URL is in the app's link-check results${healthModel.brokenSource ? ` (<code>${escapeHtml(healthModel.brokenSource)}</code>)` : ' (none in this session, so 0)'}.</p>
                ${domains.length ? `<div class="stats-table-wrap"><table class="stats-table">
                <thead>
                    <tr>
                        <th class="sort-col" data-sort="rdnn" data-sort-group="domains">Parent domain (RDNN)${domainMark('rdnn')}</th>
                        ${domainWindowHeads}
                        <th class="stats-num sort-col" data-sort="count" data-sort-group="domains">Total${domainMark('count')}</th>
                        <th class="stats-num sort-col" data-sort="tracked" data-sort-group="domains">Tracking${domainMark('tracked')}</th>
                        <th class="stats-num sort-col" data-sort="duplicates" data-sort-group="domains">Duplicates${domainMark('duplicates')}</th>
                        <th class="stats-num sort-col" data-sort="broken" data-sort-group="domains">Broken${domainMark('broken')}</th>
                        <th>Service preview</th>
                    </tr>
                </thead>
                <tbody>${domainRows}</tbody>
            </table></div>` : '<div class="stats-empty">No domains match this filter.</div>'}
            </section>
        `,
        'folder-size': () => folderRankingSectionHtml(getFolderSizeRanking()),
    };
    body.innerHTML = (views[activeStatsTab] || views.chains)();
    bindAnalyticsRows(body);
    body.querySelectorAll('[data-heat-grain]').forEach(btn => {
        btn.onclick = () => {
            const grain = Number(btn.dataset.heatGrain);
            if (!HEAT_GRAINS.includes(grain) || grain === heatmapGrain) return;
            heatmapGrain = grain;
            paintStatistics();
        };
    });
    body.querySelectorAll('.stats-row[data-rdnn]').forEach(row => {
        row.addEventListener('click', () => openStatsPanel({ rdnn: row.dataset.rdnn }));
    });
    body.querySelectorAll('.stats-window-cell').forEach(cell => {
        cell.addEventListener('click', event => {
            event.stopPropagation();
            openStatsPanel({ rdnn: cell.dataset.rdnn, windowId: cell.dataset.window });
        });
    });
    body.querySelectorAll('.stats-chip[data-rdnn]').forEach(chip => {
        chip.addEventListener('click', event => {
            event.stopPropagation();
            openStatsPanel({ rdnn: chip.dataset.rdnn, bucketKey: chip.dataset.bucket || null });
        });
    });
    bindFolderChips(body);
    bindHeatInsights(body);
    bindReportSections(body);
    body.querySelectorAll('[data-sort-reset]').forEach(btn => {
        if (btn.dataset.sortWired) return;
        btn.dataset.sortWired = '1';
        btn.addEventListener('click', event => {
            event.stopPropagation();
            resetStatsSort(btn.dataset.sortReset);
        });
    });
    body.querySelectorAll('.sort-col').forEach(th => {
        // The By-domain headers have their own handler (statsSortState); this one covers the session
        // tables, Returning and the folder ranking.
        if (th.dataset.sortGroup === 'domains') return;
        th.onclick = event => {
            event.stopPropagation();
            const next = th.dataset.sort;
            if (th.dataset.sortGroup === 'folder') {
                if (folderSort.key === next) folderSort.dir *= -1;
                else {
                    folderSort.key = next;
                    folderSort.dir = next === 'folder' ? 1 : -1;
                }
            } else if (th.dataset.sortGroup === 'session') {
                if (sessionSort.key === next) sessionSort.dir *= -1;
                else {
                    sessionSort.key = next;
                    sessionSort.dir = (next === 'topic' || next === 'kind') ? 1 : -1;
                }
            } else {
                if (returningSort.key === next) returningSort.dir *= -1;
                else {
                    returningSort.key = next;
                    returningSort.dir = 1;
                }
            }
            // Repaint and rebind: the click replaces these headers, and a dead replacement is what made
            // the second click do nothing.
            repaintAnalytics();
        };
    });
}

function sessionKindLabel(item) {
    if (item.sessionCount) return `${formatCount(item.sessionCount)} sessions`;
    if (item.isBinge) return 'Binge';
    if (item.isMixed) return 'Mixed lookup';
    if (item.sameTimestamp) return 'Same timestamp';
    return 'Lookup';
}

function sortSessionItems(items) {
    const key = sessionSort.key;
    const dir = sessionSort.dir;
    return items.slice().sort((a, b) => {
        let cmp = 0;
        if (key === 'started') cmp = (a.firstAdded || 0) - (b.firstAdded || 0);
        else if (key === 'topic') cmp = String(a.topic || '').localeCompare(String(b.topic || ''));
        else if (key === 'links') cmp = (a.count || 0) - (b.count || 0);
        else if (key === 'span') cmp = (a.spanMs || 0) - (b.spanMs || 0);
        else if (key === 'kind') {
            if (a.sessionCount != null || b.sessionCount != null) {
                cmp = (a.sessionCount || 0) - (b.sessionCount || 0);
            } else {
                cmp = sessionKindLabel(a).localeCompare(sessionKindLabel(b));
            }
        }
        return cmp * dir || String(a.topic || '').localeCompare(String(b.topic || ''));
    });
}

function closeStatsPanel() {
    const panel = document.getElementById('stats-panel');
    if (panel) panel.hidden = true;
    setPanelChainAction(null);
}

function openLinkGroupPanel(group, title, meta) {
    const panel = document.getElementById('stats-panel');
    if (!panel || !group) return;
    // Any section's group can be sent or deleted, not only a Search chain: the buttons name the
    // kind the section reports (sessionKindLabel), and the lookup behind them searches every list.
    const kind = typeof sessionKindLabel === 'function' ? (sessionKindLabel(group) || 'Search chain') : 'Search chain';
    const chainId = group.id || null;
    if ((group.links || []).length > 40) {
        panelCompactRerender = null;
        openLinkTablePanel({ links: group.links, title, meta, chainId, kind });
        return;
    }
    document.getElementById('stats-panel-title').textContent = title;
    document.getElementById('stats-panel-meta').textContent = meta;
    setPanelChainAction(chainId, kind);
    document.getElementById('stats-panel-body').innerHTML = renderBurstPanelBody(group);
    panel.hidden = false;
    panelCompactRerender = () => {
        document.getElementById('stats-panel-body').innerHTML = renderBurstPanelBody(group);
        bindBurstPanel(group);
    };
    bindBurstPanel(group);
}

function findAnalyticsGroup(id) {
    if (!id || !lastStatsModel) return null;
    const lists = [
        lastStatsModel.bursts, lastStatsModel.chains, lastStatsModel.topics,
        lastStatsModel.binges, lastStatsModel.collisions
    ];
    for (const list of lists) {
        const match = list?.find(item => item.id === id);
        if (match) return match;
    }
    return null;
}

let chainLookup = { model: null, map: null };

function searchChainForNode(node) {
    if (!bookmarkData || !node || !nodeUri(node)) return null;
    const model = getAnalyticsModel();
    if (chainLookup.model !== model) {
        const map = new Map();
        (model.chains || []).forEach(chain => (chain.links || []).forEach(link => map.set(link.node, chain)));
        chainLookup = { model, map };
    }
    return chainLookup.map.get(node) || null;
}

function showSearchChainForNode(node) {
    const chain = searchChainForNode(node);
    if (!chain) return alert('That bookmark is not part of a search chain.');
    const search = document.getElementById('stats-search');
    if (search && search.value) search.value = '';
    switchTabById('stats-view');
    switchStatsTab('chains');
    openStatsPanel({ groupId: chain.id });
    const body = document.getElementById('stats-panel-body');
    const index = chain.links.findIndex(link => link.node === node);
    const card = body && index >= 0 ? body.querySelectorAll('.trail-card')[index] : null;
    if (card) {
        card.classList.add('stats-located');
        card.scrollIntoView({ block: 'center' });
    } else {
        revealPanelLink(nodeUri(node));
    }
}

function openStatsPanel({ rdnn, bucketKey = null, windowId = null, burstId = null, groupId = null, heatView = null, heatRow = null, heatCol = null }) {
    const panel = document.getElementById('stats-panel');
    if (!panel || !lastStatsModel) return;
    if (heatView) {
        const map = lastStatsModel.heatmap;
        const clock = heatView === 'clock' ? collapseHeatHours(map, heatmapGrain) : null;
        let links = [];
        let label = 'Heatmap';
        let scope = 'in this cell';
        if (heatView === 'clock' && clock) {
            if (heatRow != null && heatCol != null) {
                links = clock.buckets[heatRow]?.[heatCol] || [];
                const start = heatCol * heatmapGrain;
                const end = Math.min(24, start + heatmapGrain);
                label = `${WEEKDAYS[heatRow]} ${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00`;
            } else if (heatRow != null) {
                links = (clock.buckets[heatRow] || []).flat();
                label = `${WEEKDAYS[heatRow]}s`;
                scope = 'on this weekday';
            } else if (heatCol != null) {
                links = (clock.buckets || []).flatMap(row => row[heatCol] || []);
                const start = heatCol * heatmapGrain;
                const end = Math.min(24, start + heatmapGrain);
                label = `${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00`;
                scope = 'in this hour block';
            }
        } else if (heatView === 'month') {
            if (heatRow != null && heatCol != null) {
                links = map.month.buckets[heatRow]?.[heatCol] || [];
                label = `${HEAT_MONTHS[heatRow]} ${heatCol + 1}`;
            } else if (heatRow != null) {
                links = (map.month.buckets[heatRow] || []).flat();
                label = HEAT_MONTHS[heatRow];
                scope = 'in this month';
            } else if (heatCol != null) {
                links = (map.month.buckets || []).flatMap(row => row[heatCol] || []);
                label = `Day ${heatCol + 1}`;
                scope = 'on this day of the month';
            }
        } else if (heatView === 'year') {
            const year = map.years[heatRow];
            if (heatRow != null && heatCol != null && year) {
                links = year.buckets[heatCol] || [];
                label = `${year.year} ${HEAT_MONTHS[heatCol]}`;
            } else if (heatRow != null && year) {
                links = (year.buckets || []).flat();
                label = String(year.year);
                scope = 'in this year';
            } else if (heatCol != null) {
                links = map.years.flatMap(row => row.buckets[heatCol] || []);
                label = HEAT_MONTHS[heatCol];
                scope = 'in this month across years';
            }
        }
        links = links.slice().sort((a, b) => (a.addedMs || 0) - (b.addedMs || 0));
        openLinkGroupPanel(
            { links, sameTimestamp: false },
            label,
            `${formatCount(links.length)} bookmark${links.length === 1 ? '' : 's'} ${scope} (local dateAdded)`
        );
        return;
    }
    const group = findAnalyticsGroup(groupId || burstId);
    if (group) {
        const extra = group.sessionCount ? `${group.sessionCount} sessions over ${group.dayCount} days · ` : '';
        const dest = group.destKinds?.length ? ` → ${group.destKinds.join(', ')}` : '';
        openLinkGroupPanel(
            group,
            `${group.topic}${dest}`,
            `${extra}${group.count} bookmarks${group.spanMs != null ? ` in ${formatDuration(group.spanMs)}` : ''}${group.hosts?.length ? ` · ${group.hosts.slice(0, 6).join(', ')}` : ''}`
        );
        return;
    }
    const domain = lastStatsModel.domains.find(d => d.rdnn === rdnn);
    if (!domain) return;
    const windowSpec = windowId ? domain.windows.find(w => w.id === windowId) : null;
    const now = lastStatsModel.now || Date.now();
    const inWindow = (link) => {
        if (!windowSpec) return true;
        return link.addedMs != null && now - link.addedMs <= windowSpec.ms && now - link.addedMs >= 0;
    };
    let sourceLinks = domain.links;
    let title = domain.parent;
    let meta = `${domain.rdnn} · ${domain.count} links · hosts ${domain.hosts.join(', ')}`;
    if (bucketKey) {
        const bucket = domain.services.find(s => `${s.service}|${s.kind}|${s.key}` === bucketKey);
        if (bucket) {
            sourceLinks = bucket.links;
            title = `${bucket.service}: ${bucket.label}`;
            meta = `${bucket.kind} on ${domain.parent}`;
        }
    }
    const links = sourceLinks.filter(inWindow);
    if (windowSpec) {
        title = `${title} · last ${windowSpec.label.toLowerCase()}`;
        meta = `${links.length} in the last ${windowSpec.label.toLowerCase()} (${formatRate(links.length, windowSpec.ms)})`;
    } else if (bucketKey) {
        meta = `${links.length} links · ${meta}`;
    }
    openLinkTablePanel({ links, title, meta, domain, bucketKey, windowId });
}

function servicesVisibleInScope(domain, windowId) {
    const windowSpec = windowId ? STATS_WINDOWS.find(w => w.id === windowId) : null;
    const now = lastStatsModel?.now || Date.now();
    return domain.services.map(service => {
        const scoped = windowSpec
            ? service.links.filter(link => link.addedMs != null && now - link.addedMs <= windowSpec.ms && now - link.addedMs >= 0)
            : service.links;
        return { ...service, count: scoped.length };
    }).filter(service => service.count > 0);
}

function windowButtonsHtml(domain, activeWindowId, bucketKey) {
    const source = bucketKey
        ? (domain.services.find(s => `${s.service}|${s.kind}|${s.key}` === bucketKey)?.links || [])
        : domain.links;
    const now = lastStatsModel?.now || Date.now();
    return `<div class="stats-windows">${STATS_WINDOWS.map(window => {
        const count = source.filter(link => link.addedMs != null && now - link.addedMs <= window.ms && now - link.addedMs >= 0).length;
        const on = window.id === activeWindowId ? ' open' : '';
        return `<button type="button" class="stats-window${on}" data-window="${escapeHtml(window.id)}">
            <div class="k">Last ${escapeHtml(window.label.toLowerCase())}</div>
            <div class="v">${formatCount(count)}</div>
            <div class="r">${escapeHtml(formatRate(count, window.ms))} · ${escapeHtml(formatHourRate(count, window.ms))}</div>
        </button>`;
    }).join('')}</div>
    ${activeWindowId ? '<button type="button" class="ghost-btn" id="panel-clear-window">All time</button>' : ''}`;
}

function openLinkTablePanel({ links, title, meta, domain = null, bucketKey = null, windowId = null, chainId = null, kind = 'Search chain' }) {
    const panel = document.getElementById('stats-panel');
    const sorted = links.slice().sort((a, b) => (a.addedMs || 0) - (b.addedMs || 0) || String(a.title).localeCompare(String(b.title)));
    const chipsExpanded = domain && panelTableState.domain && domain.rdnn === panelTableState.domain.rdnn
        ? Boolean(panelTableState.chipsExpanded)
        : false;
    panelCompactRerender = null;
    panelTableState = { links: sorted, filtered: sorted, page: 0, pageSize: 100, query: '', title, meta, domain, bucketKey, windowId, chipsExpanded, folderFilter: '', selected: 0, chainId };
    document.getElementById('stats-panel-title').textContent = title;
    document.getElementById('stats-panel-meta').textContent = meta;
    setPanelChainAction(chainId, kind);
    renderPanelTable();
    panel.hidden = false;
}

let panelCompact = localStorage.getItem('statsPanelCompact') === '1';
// The group panel the chip was clicked in, so it can be re-rendered in place (the tables it draws
// depend on panelCompact).
let panelCompactRerender = null;

document.addEventListener('click', event => {
    const btn = event.target.closest?.('[data-cards-compact]');
    if (!btn) return;
    panelCompact = !panelCompact;
    localStorage.setItem('statsPanelCompact', panelCompact ? '1' : '0');
    document.querySelectorAll('[data-cards-compact]').forEach(chip => {
        chip.classList.toggle('open', panelCompact);
        chip.setAttribute('aria-pressed', String(panelCompact));
    });
    // Both panels draw their rows from panelCompact, so whichever one this chip belongs to is redrawn:
    // the service table through renderPanelTable(), a group panel through its own body renderer.
    if (panelCompactRerender) panelCompactRerender();
    else if (panelTableState && panelTableState.links && panelTableState.links.length) renderPanelTable();
});

function panelRowActionsHtml(idx) {
    if (panelCompact) {
        return `<div class="trail-actions compact"><button type="button" class="dupe-icon-btn" data-reveal="${idx}" title="Show in library" aria-label="Show in library">👁</button><button type="button" class="dupe-icon-btn" data-nearby="${idx}" title="Nearby bookmarks" aria-label="Nearby bookmarks">⏱</button><button type="button" class="dupe-icon-btn panel-delete-icon" data-panel-delete="${idx}" title="Delete" aria-label="Delete">🗑</button></div>`;
    }
    return `<div class="trail-actions"><button type="button" class="ghost-btn chain-send-btn" data-reveal="${idx}">Show in library</button><button type="button" class="ghost-btn chain-send-btn" data-nearby="${idx}">Nearby</button><button type="button" class="delete-btn chain-send-btn" data-panel-delete="${idx}">Delete</button></div>`;
}

function revealPanelLink(uri) {
    const state = panelTableState;
    if (!state?.links?.length || !uri) return;
    const index = state.filtered.findIndex(link => link.uri === uri);
    if (index < 0) return;
    state.selected = index;
    state.page = Math.floor(index / state.pageSize);
    renderPanelTable();
    document.querySelector(`#stats-panel-body tr[data-row="${index}"]`)?.scrollIntoView({ block: 'center' });
}

function renderPanelTable() {
    const state = panelTableState;
    const q = state.query.trim().toLowerCase();
    const folder = state.folderFilter || '';
    state.filtered = state.links.filter(link => {
        if (folder && link.folderPath !== folder && !(link.folderPath || '').startsWith(`${folder} / `)) return false;
        if (q && !`${link.title} ${link.uri} ${link.folderPath || ''}`.toLowerCase().includes(q)) return false;
        return true;
    });
    state.filtered.sort((a, b) => ((a.addedMs || 0) - (b.addedMs || 0)) * panelAddedSort || String(a.title || '').localeCompare(String(b.title || '')));
    const pages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    const start = state.page * state.pageSize;
    const slice = state.filtered.slice(start, start + state.pageSize);
    const visibleServices = state.domain ? servicesVisibleInScope(state.domain, state.windowId) : [];
    const chipHead = visibleServices.slice(0, PANEL_CHIP_PREVIEW);
    const chipRest = visibleServices.slice(PANEL_CHIP_PREVIEW);
    const serviceChipHtml = service => {
        const key = `${service.service}|${service.kind}|${service.key}`;
        const on = key === state.bucketKey ? ' open' : '';
        return `<button type="button" class="stats-chip${on}" data-bucket="${escapeHtml(key)}">${escapeHtml(service.label)} · ${formatCount(service.count)}</button>`;
    };
    const chips = state.domain
        ? `<div class="panel-toolbar">${chipHead.map(serviceChipHtml).join('') || '<span class="stats-host">No service chips in this time window.</span>'}${chipRest.length ? `<button type="button" class="stats-chip" id="panel-chips-more">${state.chipsExpanded ? `Hide ${formatCount(chipRest.length)}` : `+${formatCount(chipRest.length)} more`}</button>` : ''}</div>${state.chipsExpanded && chipRest.length ? `<div class="panel-chip-list">${chipRest.map(serviceChipHtml).join('')}</div>` : ''}`
        : '';
    const windowsHtml = state.domain ? windowButtonsHtml(state.domain, state.windowId, state.bucketKey) : '';
    const rows = slice.map((link, i) => {
        const idx = start + i;
        const added = link.addedMs ? new Date(link.addedMs).toLocaleString() : '—';
        return `<tr data-row="${idx}" class="${idx === (state.selected ?? 0) ? 'kb-on' : ''}">
            <td class="stats-num">${idx + 1}</td>
            <td class="title">${titleLinkHtml(link)}</td>
            <td>${escapeHtml(added)}</td>
            <td>${folderChipsHtml(link.folderPath)}</td>
            <td class="panel-row-actions">${panelRowActionsHtml(idx)}</td>
        </tr>`;
    }).join('');
    document.getElementById('stats-panel-body').innerHTML = `
        ${windowsHtml}
        ${chips}
        <div class="panel-toolbar">
            <input id="panel-link-filter" type="search" placeholder="Filter title, URL, or folder" value="${escapeHtml(state.query)}">
            <button type="button" class="stats-chip${panelCompact ? ' open' : ''}" id="panel-compact" title="Hide the URL under each title and shrink the row buttons to icons" aria-pressed="${panelCompact}">Compact</button>
            <span class="stats-host">${formatCount(state.filtered.length)} shown${q || folder ? ` of ${formatCount(state.links.length)}` : ''}${folder ? ` · folder ${escapeHtml(folder.split(' / ').pop())}` : ''}</span>
        </div>
        <div class="panel-table-wrap">
            <table class="panel-table${panelCompact ? ' compact' : ''}">
                <thead><tr><th>#</th><th>Link</th><th class="sort-col" id="panel-sort-added">Added${panelAddedSort > 0 ? ' ↑' : ' ↓'}</th><th>Folder</th><th></th></tr></thead>
                <tbody>${rows || '<tr><td colspan="5">No links match this filter.</td></tr>'}</tbody>
            </table>
        </div>
        <div class="panel-pager">
            <button type="button" class="ghost-btn" id="panel-prev" ${state.page <= 0 ? 'disabled' : ''}>Previous</button>
            <span>Page ${formatCount(state.page + 1)} / ${formatCount(pages)}</span>
            <button type="button" class="ghost-btn" id="panel-next" ${state.page >= pages - 1 ? 'disabled' : ''}>Next</button>
        </div>
    `;
    const filter = document.getElementById('panel-link-filter');
    filter.oninput = () => {
        panelTableState.query = filter.value;
        panelTableState.page = 0;
        renderPanelTable();
        const again = document.getElementById('panel-link-filter');
        if (again) {
            again.focus();
            const len = again.value.length;
            again.setSelectionRange(len, len);
        }
    };
    document.getElementById('panel-compact').onclick = () => {
        panelCompact = !panelCompact;
        localStorage.setItem('statsPanelCompact', panelCompact ? '1' : '0');
        renderPanelTable();
    };
    document.getElementById('panel-prev').onclick = () => { panelTableState.page--; renderPanelTable(); };
    document.getElementById('panel-next').onclick = () => { panelTableState.page++; renderPanelTable(); };
    const sortAdded = document.getElementById('panel-sort-added');
    if (sortAdded) sortAdded.onclick = () => {
        panelAddedSort *= -1;
        renderPanelTable();
    };
    document.getElementById('stats-panel-body').querySelectorAll('[data-window]').forEach(btn => {
        btn.onclick = () => {
            const next = btn.dataset.window === state.windowId ? null : btn.dataset.window;
            openStatsPanel({ rdnn: state.domain.rdnn, bucketKey: state.bucketKey, windowId: next });
        };
    });
    const clearWindow = document.getElementById('panel-clear-window');
    if (clearWindow) clearWindow.onclick = () => openStatsPanel({ rdnn: state.domain.rdnn, bucketKey: state.bucketKey });
    const chipsMore = document.getElementById('panel-chips-more');
    if (chipsMore) chipsMore.onclick = () => {
        panelTableState.chipsExpanded = !panelTableState.chipsExpanded;
        renderPanelTable();
    };
    document.getElementById('stats-panel-body').querySelectorAll('[data-bucket]').forEach(btn => {
        btn.onclick = () => openStatsPanel({
            rdnn: state.domain.rdnn,
            bucketKey: btn.dataset.bucket === state.bucketKey ? null : btn.dataset.bucket,
            windowId: state.windowId
        });
    });
    document.getElementById('stats-panel-body').querySelectorAll('[data-reveal]').forEach(btn => {
        btn.onclick = () => {
            const match = panelTableState.filtered[Number(btn.dataset.reveal)];
            if (match) revealBookmark(match);
        };
    });
    document.getElementById('stats-panel-body').querySelectorAll('[data-nearby]').forEach(btn => {
        btn.onclick = () => {
            const match = panelTableState.filtered[Number(btn.dataset.nearby)];
            if (match) openNearbyBookmarks(match.node);
        };
    });
    document.getElementById('stats-panel-body').querySelectorAll('[data-panel-delete]').forEach(btn => {
        btn.onclick = () => {
            const match = panelTableState.filtered[Number(btn.dataset.panelDelete)];
            if (!match || !deletePanelBookmark(match)) return;
            panelTableState.links = panelTableState.links.filter(item => item.node !== match.node);
            renderPanelTable();
        };
    });
    bindFolderChips(document.getElementById('stats-panel-body'));
}

function renderLinkCards(links, note, offset = 0) {
    // The table the By domain view uses, for every Analytics group panel: one row per link, with
    // the URL under the title, Added and Gap, the folder chips and the row actions. Compact only
    // tightens it (smaller rows, the URL hidden, the actions shrunk to icons) — the panel stays a
    // table either way, which is how the service table behaves too.
    if (!links.length) return `<p class="stats-host">No links in this slice.</p>`;
    const toggle = `<button type="button" class="stats-chip${panelCompact ? ' open' : ''}" data-cards-compact title="Hide the URL under each title and shrink the row buttons to icons" aria-pressed="${panelCompact}">Compact</button>`;
    const head = `<div class="trail-head">${note ? `<p class="trail-note">${escapeHtml(note)}</p>` : '<span></span>'}${toggle}</div>`;
    const rows = links.map((link, index) => {
        // The panel binder resolves a button through the whole filtered list, so a page slice numbers
        // its buttons from where the slice starts.
        const at = offset + index;
        const gap = index === 0 ? 'start' : formatDuration((link.addedMs || 0) - (links[index - 1].addedMs || 0));
        const added = link.addedMs ? new Date(link.addedMs).toLocaleString() : '—';
        const actions = panelCompact
            ? `<div class="trail-actions compact"><button type="button" class="dupe-icon-btn" data-reveal="${at}" title="Show in library" aria-label="Show in library">👁</button><button type="button" class="dupe-icon-btn" data-nearby="${at}" title="Nearby bookmarks" aria-label="Nearby bookmarks">⏱</button><button type="button" class="dupe-icon-btn panel-delete-icon" data-panel-delete="${at}" title="Delete" aria-label="Delete">🗑</button></div>`
            : `<div class="trail-actions"><button type="button" class="ghost-btn chain-send-btn" data-reveal="${at}">Show in library</button><button type="button" class="ghost-btn chain-send-btn" data-nearby="${at}">Nearby</button><button type="button" class="delete-btn chain-send-btn" data-panel-delete="${at}">Delete</button></div>`;
        return `<tr class="stats-row" data-link-row="${at}">
            <td class="stats-num">${index + 1}</td>
            <td class="title">${titleLinkHtml(link)}</td>
            <td>${escapeHtml(added)}</td>
            <td>${escapeHtml(gap)}</td>
            <td>${folderChipsHtml(link.folderPath)}</td>
            <td class="panel-row-actions">${actions}</td>
        </tr>`;
    }).join('');
    return `${head}<div class="panel-table-wrap"><table class="panel-table${panelCompact ? ' compact' : ''} stats-table-like">
        <thead><tr><th>#</th><th>Link</th><th>Added</th><th>Gap</th><th>Folder</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
    </table></div>`;
}
function renderBurstPanelBody(burst) {
    const note = burst.sameTimestamp
        ? 'All items share the same dateAdded (possible paste/import batch).'
        : 'Ordered by dateAdded, oldest first — the lookup trail.';
    return renderLinkCards(burst.links, note);
}

function bindBurstPanel(burst) {
    const body = document.getElementById('stats-panel-body');
    body.querySelectorAll('[data-reveal]').forEach(btn => {
        btn.onclick = () => {
            const match = burst.links[Number(btn.dataset.reveal)];
            if (match) revealBookmark(match);
        };
    });
    body.querySelectorAll('[data-nearby]').forEach(btn => {
        btn.onclick = () => {
            const match = burst.links[Number(btn.dataset.nearby)];
            if (match) openNearbyBookmarks(match.node);
        };
    });
    body.querySelectorAll('[data-panel-delete]').forEach(btn => {
        btn.onclick = () => {
            const match = burst.links[Number(btn.dataset.panelDelete)];
            if (!match || !deletePanelBookmark(match)) return;
            burst.links = burst.links.filter(item => item.node !== match.node);
            body.innerHTML = renderBurstPanelBody(burst);
            bindBurstPanel(burst);
        };
    });
    bindFolderChips(body);
}

function renderStatsPanelBody(domain, links, activeBucketKey) {
    const windows = domain.windows.map(w => `
        <button type="button" class="stats-window" data-window="${escapeHtml(w.id)}">
            <div class="k">Last ${escapeHtml(w.label.toLowerCase())}</div>
            <div class="v">${w.count}</div>
            <div class="r">${escapeHtml(formatRate(w.count, w.ms))} · ${escapeHtml(formatHourRate(w.count, w.ms))}</div>
        </button>
    `).join('');
    const serviceBtns = domain.services.map(s => {
        const key = `${s.service}|${s.kind}|${s.key}`;
        const on = key === activeBucketKey ? ' open' : '';
        return `<button type="button" class="stats-chip${on}" data-bucket="${escapeHtml(key)}">${escapeHtml(s.label)} · ${s.count}</button>`;
    }).join('') || '<span class="stats-host">No extra service split for this domain.</span>';
    const note = domain.firstAdded
        ? `First ${new Date(domain.firstAdded).toLocaleString()} · last ${new Date(domain.lastAdded).toLocaleString()}`
        : 'No parseable dates on this domain.';
    const sorted = links.slice().sort((a, b) => (a.addedMs || 0) - (b.addedMs || 0) || String(a.title).localeCompare(String(b.title)));
    return `
        <div class="stats-windows">${windows}</div>
        <div style="margin:10px 0 14px">${serviceBtns}</div>
        ${renderLinkCards(sorted, note)}
    `;
}

function bindStatsPanel(domain, links) {
    const body = document.getElementById('stats-panel-body');
    body.querySelectorAll('[data-window]').forEach(btn => {
        btn.onclick = () => openStatsPanel({ rdnn: domain.rdnn, windowId: btn.dataset.window });
    });
    body.querySelectorAll('[data-bucket]').forEach(btn => {
        btn.onclick = () => openStatsPanel({ rdnn: domain.rdnn, bucketKey: btn.dataset.bucket });
    });
    body.querySelectorAll('[data-reveal]').forEach(btn => {
        btn.onclick = () => {
            const match = links[Number(btn.dataset.reveal)];
            if (match) revealBookmark(match);
        };
    });
}

function titleLinkHtml(link) {
    const href = link.uri || '#';
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title || 'Untitled')}<span class="href">${escapeHtml(link.uri || '')}</span></a>`;
}

function folderChipsHtml(folderPath) {
    const parts = String(folderPath || '').split(' / ').filter(Boolean);
    if (!parts.length) return '<span class="stats-host">—</span>';
    return `<div class="folder-chips">${parts.map((part, index) => {
        const path = parts.slice(0, index + 1).join(' / ');
        const view = subredditFolderView(part);
        const tip = view.spec ? `Subreddit folder · ${view.spec.subs.length} subreddits` : 'Open folder in Bookmarks';
        return `<button type="button" class="folder-chip${view.spec ? ' subreddit-folder' : ''}" data-folder-path="${escapeHtml(path)}" title="${escapeHtml(tip)}">${escapeHtml(view.label)}${view.markHtml}</button>`;
    }).join('')}</div>`;
}

function bindFolderChips(root) {
    root.querySelectorAll('.folder-chip[data-folder-path]').forEach(chip => {
        if (panelTableState.folderFilter && chip.dataset.folderPath === panelTableState.folderFilter) chip.classList.add('open');
        chip.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openFolderChipInLibrary(chip.dataset.folderPath);
        };
        chip.oncontextmenu = event => {
            event.preventDefault();
            event.stopPropagation();
            folderChipPath = chip.dataset.folderPath;
            const menu = document.getElementById('folder-chip-menu');
            document.getElementById('context-menu').style.display = 'none';
            setFolderChipMenuInfo(folderChipPath);
            placePopupMenu(menu, event.clientX, event.clientY);
        };
    });
}

// The chip menu's information panel, plus the two actions that need the resolved folder.
function setFolderChipMenuInfo(pathStr) {
    const folder = resolveFolderPath(pathStr);
    const show = Boolean(folder) && typeof isBookmarkFolderNode === 'function' && isBookmarkFolderNode(folder);
    const panel = document.getElementById('folder-chip-stats');
    if (panel) {
        panel.hidden = !show;
        if (show) panel.innerHTML = folderStatsInnerHtml(folder, false);
    }
    const sep = document.getElementById('folder-chip-stats-sep');
    if (sep) sep.hidden = !show;
    const exportItem = document.getElementById('folder-chip-export');
    if (exportItem) exportItem.hidden = !show;
    const exportSep = document.getElementById('folder-chip-export-sep');
    if (exportSep) exportSep.hidden = !show;
}

function hideFolderChipMenu() {
    const menu = document.getElementById('folder-chip-menu');
    if (menu) menu.style.display = 'none';
}

function copyFolderChipPath() {
    hideFolderChipMenu();
    const path = String(folderChipPath || '');
    if (!path) return;
    return copyTextToClipboard(path);
}

function exportFolderChipAsHtml() {
    hideFolderChipMenu();
    const folder = resolveFolderPath(folderChipPath);
    if (!folder) return alert('Could not find that folder in the library.');
    return exportFolderNodeAsHtml(folder);
}

function resolveFolderPath(pathStr) {
    const parts = String(pathStr || '').split(' / ').filter(Boolean);
    if (!parts.length || !bookmarkData) return null;
    let node = bookmarkData;
    let start = 0;
    if (displayFolderTitle(node) === parts[0]) start = 1;
    for (let i = start; i < parts.length; i++) {
        const next = node.children?.find(child => (child.children || child.typeCode === 2) && displayFolderTitle(child) === parts[i]);
        if (!next) return null;
        node = next;
    }
    return node;
}

function openFolderChipInLibrary(path) {
    const menu = document.getElementById('folder-chip-menu');
    if (menu) menu.style.display = 'none';
    const pathStr = typeof path === 'string' ? path : folderChipPath;
    const folder = resolveFolderPath(pathStr);
    if (!folder) return alert('Could not find that folder in the library.');
    closeStatsPanel();
    switchTabById('bookmarks-view');
    expandFolderAncestors(folder);
    openFolder(folder);
}

// --- Folder drill-down report ------------------------------------------------
// One folder's own subtree in the statistics side panel: what it holds, when its
// bookmarks were added, where they point, which carry tracking parameters, and
// which URLs repeat inside it. Opened by the folder chip menu's “Folder report”.
let lastFolderReport = null;
const FOLDER_REPORT_EXAMPLES = 5;

// The tree mixes Netscape/Firefox seconds, Firefox µs, and live API milliseconds.
// formatInfoDate (bookmark-editor-v1.0.js) reads the same mix; mirror its rule
// (above 1e12 is already milliseconds) and treat anything undated as missing.
function folderReportAddedMs(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n > 1e12 ? n : n * 1000);
}

// The same date style the folder information views use (formatInfoDate).
function folderReportDateText(ms) {
    if (ms == null) return '';
    return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// The folder views' own rows (infoRowHtml / infoPathRowHtml) when they are loaded.
function folderReportRowHtml(label, value, note) {
    if (typeof infoRowHtml === 'function') return infoRowHtml(label, value, note);
    return `<div class="menu-stat-row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><span class="menu-stat-total">${escapeHtml(note || '')}</span></div>`;
}

function folderReportPathRowHtml(label, path) {
    if (!path) return '';
    if (typeof infoPathRowHtml === 'function') return infoPathRowHtml(label, path);
    return `<div class="menu-stat-row is-path"><span>${escapeHtml(label)}</span><b title="${escapeHtml(path)}">${escapeHtml(path)}</b></div>`;
}

function folderReportHeadingHtml(text) {
    return `<h3 style="font-size:13px;margin:12px 0 6px">${escapeHtml(text)}</h3>`;
}

function folderReportLinkTitle(node) {
    const title = String((node && node.title) || '').trim();
    return title || nodeUri(node) || 'Untitled';
}

// Every fact the report shows, computed once from the folder's own subtree so the
// HTML report and the copied plain-text report can never drift apart.
function folderReportModel(folder) {
    const stats = folderMenuStats(folder);
    const links = [];
    walkBookmarkTree(folder, node => {
        if (node !== folder && nodeUri(node)) links.push(node);
    });
    let oldest = null;
    let newest = null;
    let dated = 0;
    links.forEach(node => {
        const ms = folderReportAddedMs(node.dateAdded);
        if (ms == null) return;
        dated += 1;
        if (oldest == null || ms < oldest) oldest = ms;
        if (newest == null || ms > newest) newest = ms;
    });
    // The By-domain helpers in this file, so the report groups links exactly the
    // way the By domain table does.
    const domainMap = new Map();
    links.forEach(node => {
        const info = classifyLink(nodeUri(node));
        const key = info.rdnn || 'unknown';
        const row = domainMap.get(key) || { rdnn: key, parent: info.parent || 'unknown', count: 0 };
        row.count += 1;
        domainMap.set(key, row);
    });
    const tracking = links.filter(node => stripTrackingParams(nodeUri(node)) !== nodeUri(node));
    const dupeMap = new Map();
    links.forEach(node => {
        const uri = nodeUri(node);
        const key = typeof duplicateUrlKey === 'function' ? duplicateUrlKey(uri) : uri;
        if (!key) return;
        const row = dupeMap.get(key) || { key, count: 0, nodes: [] };
        row.count += 1;
        row.nodes.push(node);
        dupeMap.set(key, row);
    });
    const duplicateGroups = [...dupeMap.values()]
        .filter(row => row.count > 1)
        .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
    return {
        folder,
        title: displayFolderTitle(folder),
        path: folderPathFor(folder),
        isRoot: folder === bookmarkData,
        stats,
        linkCount: links.length,
        dated,
        oldest,
        newest,
        domains: [...domainMap.values()].sort((a, b) => b.count - a.count || a.rdnn.localeCompare(b.rdnn)),
        tracking,
        duplicateGroups,
        duplicateExtra: duplicateGroups.reduce((n, row) => n + row.count - 1, 0)
    };
}

function folderReportBodyHtml(report) {
    const s = report.stats;
    const facts = [
        report.path
            ? folderReportPathRowHtml('Path', report.path)
            : folderReportRowHtml('Path', report.isRoot ? 'the whole library' : 'at the top level', ''),
        folderReportRowHtml('Bookmarks', `${formatCount(s.directLinks)} here`, `${formatCount(s.links)} with subfolders`),
        folderReportRowHtml('Folders', `${formatCount(s.directFolders)} here`, `${formatCount(s.folders)} with subfolders`),
        s.emptyFolders ? folderReportRowHtml('Empty folders', formatCount(s.emptyFolders), '') : '',
        report.oldest != null
            ? folderReportRowHtml('Added range', `${folderReportDateText(report.oldest)} → ${folderReportDateText(report.newest)}`, `${formatCount(report.dated)} dated of ${formatCount(report.linkCount)}`)
            : folderReportRowHtml('Added range', 'No dated bookmarks', '')
    ].join('');
    const topDomains = report.domains.slice(0, 5);
    const domainRows = topDomains.length
        ? topDomains.map(row => folderReportRowHtml(row.rdnn, formatCount(row.count), row.parent)).join('')
        : '<p class="stats-host">No links in this folder.</p>';
    const trackingRows = report.tracking.slice(0, FOLDER_REPORT_EXAMPLES)
        .map(node => folderReportPathRowHtml(folderReportLinkTitle(node), nodeUri(node))).join('');
    const dupeRows = report.duplicateGroups.slice(0, FOLDER_REPORT_EXAMPLES).map(row => {
        const first = row.nodes[0];
        return folderReportPathRowHtml(`${folderReportLinkTitle(first)} ×${formatCount(row.count)}`, nodeUri(first));
    }).join('');
    return `<section class="stats-section folder-report">
        <div class="menu-stat-head" title="${escapeHtml(report.title)}">${escapeHtml(report.title)}</div>
        ${facts}
        ${folderReportHeadingHtml(report.domains.length > 5 ? `Top domains (of ${formatCount(report.domains.length)})` : 'Top domains')}
        ${domainRows}
        ${folderReportHeadingHtml('Tracking parameters')}
        ${folderReportRowHtml('Bookmarks with tracking parameters', formatCount(report.tracking.length), report.linkCount ? `of ${formatCount(report.linkCount)}` : '')}
        ${trackingRows}
        ${report.tracking.length > FOLDER_REPORT_EXAMPLES ? `<p class="stats-host">…and ${formatCount(report.tracking.length - FOLDER_REPORT_EXAMPLES)} more.</p>` : ''}
        ${folderReportHeadingHtml('Duplicate URLs in this folder')}
        ${folderReportRowHtml('URLs saved more than once', formatCount(report.duplicateGroups.length), `${formatCount(report.duplicateExtra)} extra copies`)}
        ${dupeRows}
        ${report.duplicateGroups.length > FOLDER_REPORT_EXAMPLES ? `<p class="stats-host">…and ${formatCount(report.duplicateGroups.length - FOLDER_REPORT_EXAMPLES)} more.</p>` : ''}
    </section>`;
}

function folderReportText(report) {
    const s = report.stats;
    const lines = [
        `Folder report — ${report.title}`,
        `Path: ${report.path || (report.isRoot ? 'the whole library' : 'at the top level')}`,
        `Bookmarks: ${formatCount(s.directLinks)} here · ${formatCount(s.links)} with subfolders`,
        `Folders: ${formatCount(s.directFolders)} here · ${formatCount(s.folders)} with subfolders`
    ];
    if (s.emptyFolders) lines.push(`Empty folders: ${formatCount(s.emptyFolders)}`);
    lines.push(report.oldest != null
        ? `Added range: ${folderReportDateText(report.oldest)} → ${folderReportDateText(report.newest)} (${formatCount(report.dated)} dated of ${formatCount(report.linkCount)})`
        : 'Added range: no dated bookmarks');
    lines.push('', 'Top domains:');
    if (report.domains.length) {
        report.domains.slice(0, 5).forEach((row, index) => lines.push(`${index + 1}. ${row.rdnn} — ${formatCount(row.count)} (${row.parent})`));
        if (report.domains.length > 5) lines.push(`…and ${formatCount(report.domains.length - 5)} more domains.`);
    } else {
        lines.push('No links in this folder.');
    }
    lines.push('', `Tracking parameters: ${formatCount(report.tracking.length)}`);
    report.tracking.slice(0, FOLDER_REPORT_EXAMPLES).forEach(node => lines.push(`• ${folderReportLinkTitle(node)} — ${nodeUri(node)}`));
    if (report.tracking.length > FOLDER_REPORT_EXAMPLES) lines.push(`…and ${formatCount(report.tracking.length - FOLDER_REPORT_EXAMPLES)} more.`);
    lines.push('', `Duplicate URLs in this folder: ${formatCount(report.duplicateGroups.length)} (${formatCount(report.duplicateExtra)} extra copies)`);
    report.duplicateGroups.slice(0, FOLDER_REPORT_EXAMPLES).forEach(row => {
        const first = row.nodes[0];
        lines.push(`• ${folderReportLinkTitle(first)} ×${formatCount(row.count)} — ${nodeUri(first)}`);
    });
    if (report.duplicateGroups.length > FOLDER_REPORT_EXAMPLES) lines.push(`…and ${formatCount(report.duplicateGroups.length - FOLDER_REPORT_EXAMPLES)} more.`);
    return lines.join('\n');
}

function openFolderReportTarget(folder) {
    const node = typeof folder === 'string' ? resolveFolderPath(folder) : folder;
    if (!node) return alert('Could not find that folder in the library.');
    closeStatsPanel();
    if (typeof switchTabById === 'function') switchTabById('bookmarks-view');
    if (typeof expandFolderAncestors === 'function') expandFolderAncestors(node);
    if (typeof openFolder === 'function') openFolder(node);
}

function copyFolderReport(report) {
    const source = report || lastFolderReport;
    if (!source || typeof copyTextToClipboard !== 'function') return;
    return copyTextToClipboard(folderReportText(source));
}

function bindFolderReportActions(report) {
    const box = document.getElementById('stats-panel-actions');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `<button type="button" class="ghost-btn chain-send-btn" data-folder-report-open>Open in Bookmarks</button>`
        + `<button type="button" class="ghost-btn chain-send-btn" data-folder-report-copy>Copy report</button>`;
    box.querySelectorAll('[data-folder-report-open]').forEach(btn => {
        btn.addEventListener('click', () => openFolderReportTarget(report.folder));
    });
    box.querySelectorAll('[data-folder-report-copy]').forEach(btn => {
        btn.addEventListener('click', () => copyFolderReport(report));
    });
}

// Accepts a folder node, or a display path the way the folder chips hold it.
function openFolderDrilldown(folder) {
    const panel = document.getElementById('stats-panel');
    if (!panel) return null;
    const node = typeof folder === 'string' ? resolveFolderPath(folder) : folder;
    if (!node) {
        alert('Could not find that folder in the library.');
        return null;
    }
    if (typeof isBookmarkFolderNode === 'function' && !isBookmarkFolderNode(node)) {
        alert('Folder report needs a folder.');
        return null;
    }
    const report = folderReportModel(node);
    lastFolderReport = report;
    // This is not a link table, so clear the panel state the panel's keyboard
    // shortcuts, Compact chip, and pager read.
    panelTableState = { links: [], filtered: [], page: 0, pageSize: 100, query: '', title: '', meta: '', domain: null, bucketKey: null, windowId: null, chipsExpanded: false, folderFilter: '', selected: 0, chainId: null };
    setPanelChainAction(null);
    const title = document.getElementById('stats-panel-title');
    if (title) title.textContent = 'Folder report';
    const meta = document.getElementById('stats-panel-meta');
    if (meta) meta.textContent = report.path || report.title;
    const body = document.getElementById('stats-panel-body');
    if (body) body.innerHTML = folderReportBodyHtml(report);
    bindFolderReportActions(report);
    panel.hidden = false;
    return report;
}

// The folder chip menu's “Folder report” item (data-call="reportFolderChip").
function reportFolderChip() {
    hideFolderChipMenu();
    const folder = resolveFolderPath(folderChipPath);
    if (!folder) return alert('Could not find that folder in the library.');
    if (typeof switchTabById === 'function') switchTabById('stats-view');
    return openFolderDrilldown(folder);
}

function deletePanelBookmark(link) {
    if (!link || !link.node) {
        alert('Could not find that bookmark.');
        return false;
    }
    const parent = link.parent || findBookmarkParent(link.node);
    if (!parent || !parent.children || parent.children.indexOf(link.node) < 0) {
        alert('Could not find that bookmark in the library.');
        return false;
    }
    const name = link.title || nodeUri(link.node) || 'this bookmark';
    if (!confirm(`Delete "${name}"?`)) return false;
    const removed = withUndo('Delete bookmark', api => {
        api.remove(link.node, parent);
        logAffected('REMOVED', name, 'Deleted from the statistics panel.', {
            source: 'Statistics panel',
            node: link.node,
            uri: nodeUri(link.node),
            dateAdded: link.dateAdded,
            folderPath: link.folderPath
        });
    });
    if (!removed) return false;
    markChanged();
    renderSidebar();
    if (typeof maybeRefreshDuplicateBookmarksAfterDelete === 'function') maybeRefreshDuplicateBookmarksAfterDelete(link.node);
    return true;
}

function revealBookmark(link) {
    closeStatsPanel();
    const node = link.node;
    highlightBookmark = node;
    libraryRevealPending = true;
    const search = document.getElementById('bookmark-search');
    if (search) search.value = '';
    const parent = link.parent || findBookmarkParent(node);
    switchTabById('bookmarks-view');
    if (parent) {
        expandFolderAncestors(parent);
        openFolder(parent);
    } else {
        renderFolderContents(currentFolder || bookmarkData);
    }
}

function revealBookmarkById(id) {
    const node = typeof findBookmarkNodeById === 'function' ? findBookmarkNodeById(bookmarkData, id) : null;
    if (!node) {
        alert('Could not find that bookmark in the library.');
        return false;
    }
    revealBookmark({ node, parent: findBookmarkParent(node) });
    return true;
}

function findBookmarkParent(target) {
    let found = null;
    (function walk(node, parent) {
        if (node === target) {
            found = parent;
            return true;
        }
        return node?.children?.some(child => walk(child, node));
    })(bookmarkData, null);
    return found;
}

function expandFolderAncestors(folderNode) {
    const chain = [];
    (function find(node) {
        if (node === folderNode) return true;
        if (!node?.children) return false;
        return node.children.some(child => {
            if (!find(child)) return false;
            chain.push(node);
            return true;
        });
    })(bookmarkData);
    chain.reverse().forEach(node => {
        const entry = folderTreeItems.get(node);
        if (entry) entry.nodeDiv.classList.add('expanded');
    });
}

// One place that repaints the statistics body and rebinds it, so a click that redraws the table
// leaves the new headers wired too.
function repaintAnalytics() {
    if (typeof paintStatistics === 'function') paintStatistics();
    const body = document.getElementById('stats-body');
    if (body) bindAnalyticsRows(body);
}

function bindAnalyticsRows(root) {
    // The per-row chain buttons, wherever a group row was just painted.
    if (typeof bindChainSendButtons === 'function') bindChainSendButtons(root);
    root.querySelectorAll('[data-sort-group="domains"]').forEach(th => {
        if (th.dataset.sortWired) return;
        th.dataset.sortWired = '1';
        th.addEventListener('click', () => {
            const key = th.getAttribute('data-sort');
            // dir +1 means descending for this comparator (dir * (value(b) - value(a))).
            statsSortState = statsSortState.key === key ? { key, dir: -statsSortState.dir } : { key, dir: -1 };
            repaintAnalytics();
        });
    });
    const openGroup = id => openStatsPanel({ groupId: id });
    root.querySelectorAll('[data-group]').forEach(el => {
        el.addEventListener('click', event => {
            event.stopPropagation();
            openGroup(el.dataset.group);
        });
    });
    root.querySelectorAll('[data-heat-view]').forEach(el => {
        el.addEventListener('click', () => {
            if (Number(el.dataset.count) <= 0) return;
            const row = el.dataset.heatRow;
            const col = el.dataset.heatCol;
            openStatsPanel({
                heatView: el.dataset.heatView,
                heatRow: row === undefined || row === '' ? null : Number(row),
                heatCol: col === undefined || col === '' ? null : Number(col)
            });
        });
    });
}

function heatClickPoint(card, event) {
    if (!card || !event || event.clientX == null) return null;
    const box = card.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
        x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
        y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100))
    };
}

function boomGroup(x, y, kind, pieces) {
    return `<span class="boom boom-${kind}" style="--bx:${x}%;--by:${y}%">${pieces}</span>`;
}

function rev3Pieces() {
    return '<b class="rev3-spark"></b><b class="rev3-spark2"></b><b class="rev3-core"></b><b class="rev3-ring"></b><b class="rev3-bits"></b><b class="rev3-bits-in"></b>';
}

function rev3Markup(at) {
    const flames = [-135, -45, 45, 135].map((angle, i) => `<b class="boom-flame" style="--r:${angle}deg;--d:${(i * 0.11).toFixed(2)}s"></b>`).join('');
    const pieces = rev3Pieces();
    const corners = [[0, 0], [100, 0], [0, 100], [100, 100]];
    const groups = [boomGroup(at.x, at.y, 'click', pieces), ...corners.map(([x, y]) => boomGroup(x, y, 'corner', pieces))].join('');
    return `${flames}${groups}`;
}

function armHeatmapFire(ms, done) {
    clearTimeout(heatmapFireTimer);
    heatmapFireTimer = setTimeout(() => {
        heatmapFireTimer = 0;
        done();
    }, ms);
}

function mountHeatFire(card, html) {
    let fire = card.querySelector('.heat-fire');
    if (!fire) {
        fire = document.createElement('div');
        fire.className = 'heat-fire';
        fire.setAttribute('aria-hidden', 'true');
        card.appendChild(fire);
    }
    fire.innerHTML = html;
    return fire;
}

function startHeatmapExplode(card) {
    if (!card) return;
    heatmapPhase = 'boom';
    heatmapSawFire = false;
    mountHeatFire(card, rev3Markup(heatmapBoomAt));
    card.classList.remove('fire-hold', 'boom-back', 'on-fire', 'fire-out');
    card.classList.add('boom-play');
    armHeatmapFire(HEAT_FIRE_IN_MS, () => {
        if (heatmapHeld && heatmapPhase === 'boom') startHeatmapBurn(heatLiveCard());
    });
}

function placeHeatmapFire(card, at) {
    const fire = card && card.querySelector('.heat-fire');
    if (!fire || !at) return;
    fire.style.setProperty('--mx', `${at.x}%`);
    fire.style.setProperty('--my', `${at.y}%`);
}

function startHeatmapBurn(card) {
    if (!card) return;
    heatmapPhase = 'burn';
    heatmapSawFire = true;
    if (!card.querySelector('.boom')) mountHeatFire(card, rev3Markup(heatmapBoomAt));
    card.classList.remove('boom-back', 'fire-out');
    card.classList.add('fire-hold', 'on-fire', 'boom-play');
    placeHeatmapFire(card, heatmapFlameAt);
}

function boomProgress(card) {
    const rows = [];
    for (const anim of card.getAnimations({ subtree: true })) {
        const el = anim.effect && anim.effect.target;
        if (!el || !el.closest || !el.closest('.boom')) continue;
        const timing = anim.effect.getComputedTiming();
        rows.push({ el, progress: timing.progress });
    }
    return rows;
}

function seekBoomReverse(card, rows) {
    const byEl = new Map(rows.map(row => [row.el, row]));
    for (const anim of card.getAnimations({ subtree: true })) {
        const el = anim.effect && anim.effect.target;
        const prev = byEl.get(el);
        if (!prev) continue;
        if (prev.progress == null) {
            el.style.animation = 'none';
            anim.cancel();
            continue;
        }
        const dur = anim.effect.getComputedTiming().duration;
        if (typeof dur === 'number') anim.currentTime = dur * (1 - prev.progress);
    }
}

function heatPark(card, event) {
    const at = heatClickPoint(card, event);
    if (!card || !at) return;
    heatmapBoomAt = at;
    heatmapFlameAt = at;
    card.querySelectorAll('.boom').forEach(boom => {
        boom.style.setProperty('--bx', `${at.x}%`);
        boom.style.setProperty('--by', `${at.y}%`);
    });
    placeHeatmapFire(card, at);
}

function startHeatmapImplode(card) {
    if (!card) return;
    heatmapPhase = 'implode';
    if (!card.querySelector('.boom')) mountHeatFire(card, rev3Markup(heatmapBoomAt));
    placeHeatmapFire(card, heatmapFlameAt);
    const shots = boomProgress(card);
    card.classList.remove('boom-play', 'fire-hold', 'on-fire', 'fire-out');
    card.classList.toggle('no-flame', !heatmapSawFire);
    card.classList.add('boom-back');
    void card.offsetWidth;
    seekBoomReverse(card, shots);
    armHeatmapFire(HEAT_BOOM_MS + 80, () => {
        heatmapPhase = '';
        const live = heatLiveCard();
        if (live) live.classList.remove('boom-back', 'boom-play', 'fire-hold', 'on-fire', 'no-flame');
    });
}

function bindHeatInsights(root) {
    root.querySelectorAll('.heat-wrapped').forEach(bindHeatInsightBox);
}

function bindHeatInsightBox(box) {
    clearTimeout(box._heatTimer);
    box._heatTimer = 0;
    const items = [...box.querySelectorAll('p')];
    if (!items.length) return;
    let index = Math.max(0, items.findIndex(item => item.classList.contains('on')));
    let fadeWatch = 0;
    let generation = 0;
    const show = (next, instant) => {
        generation += 1;
        clearTimeout(box._heatTimer);
        box._heatTimer = 0;
        clearTimeout(fadeWatch);
        box.querySelectorAll('.heat-num.spin').forEach(el => el.classList.remove('spin'));
        const incoming = items[(next + items.length) % items.length];
        if (instant) {
            box.classList.remove('fading');
            box.classList.add('instant');
        } else if (items.length > 1) {
            box.classList.add('fading');
        }
        items[index].classList.remove('on');
        index = (next + items.length) % items.length;
        items[index].classList.add('on');
        if (instant) {
            void box.offsetWidth;
            box.classList.remove('instant');
            playSpins();
            return;
        }
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            box.classList.remove('fading');
            playSpins();
        };
        incoming.addEventListener('transitionend', event => {
            if (event.propertyName === 'opacity' && event.target === incoming) settle();
        });
        fadeWatch = setTimeout(settle, 500);
    };
    const playSpins = () => {
        const gen = generation;
        const nums = [...box.querySelectorAll('p.on .heat-num')];
        clearTimeout(box._heatTimer);
        const advance = () => {
            if (gen !== generation || box.classList.contains('fading')) return;
            if (items.length > 1) show(index + 1, false);
        };
        if (!nums.length) {
            box._heatTimer = setTimeout(advance, 6000);
            return;
        }
        const each = Math.min(10000 / nums.length, Math.max(1000, 6000 / nums.length));
        box._heatTimer = setTimeout(advance, 10000);
        const step = (i) => {
            if (gen !== generation || box.classList.contains('fading')) return;
            box.querySelectorAll('.heat-num.spin').forEach(node => node.classList.remove('spin'));
            const el = nums[i];
            el.style.animationDuration = `${each}ms`;
            el.addEventListener('animationend', event => {
                if (event.animationName !== 'heat-spin' || gen !== generation) return;
                el.classList.remove('spin');
                if (i + 1 < nums.length) step(i + 1);
                else advance();
            }, { once: true });
            void el.offsetWidth;
            el.classList.add('spin');
        };
        step(0);
    };
    playSpins();
    const advance = () => {
        box.classList.toggle('mark-out');
        show(index + 1, true);
    };
    box.onclick = advance;
    box.onkeydown = event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            advance();
        }
    };
}

function heatIntensityLevel(count, max) {
    if (!count) return 0;
    return Math.max(1, Math.min(8, Math.round((count / (max || 1)) * 8)));
}

function heatHourRange(start, grain) {
    const end = Math.min(24, start + grain);
    return `${String(start).padStart(2, '0')}:00–${String(end).padStart(2, '0')}:00`;
}

function heatMatrixHtml(view, rowLabels, colLabels, grid, max, colTitle, colText) {
    const cols = colLabels.length;
    const colMin = view === 'clock' ? 52 : 12;
    const style = `grid-template-columns:48px repeat(${cols}, minmax(${colMin}px, 1fr)) minmax(36px, 1.1fr)`;
    const colTotals = Array.from({ length: cols }, (_, col) => grid.reduce((sum, row) => sum + (row[col] || 0), 0));
    const heads = colLabels.map((label, col) => {
        const n = colTotals[col];
        const shown = colText ? colText(label, col) : String(label);
        return `<button type="button" class="heatmap-hour${n ? ' is-hot' : ''}" data-heat-view="${view}" data-heat-col="${col}" data-count="${n}" ${n ? '' : 'disabled'} title="${escapeHtml(colTitle(label, n))}">${escapeHtml(shown)}</button>`;
    }).join('');
    const headSums = colTotals.map((n, col) =>
        `<button type="button" class="heatmap-total" data-heat-view="${view}" data-heat-col="${col}" data-count="${n}" ${n ? '' : 'disabled'} title="${escapeHtml(colTitle(colLabels[col], n))}">${n ? formatCount(n) : ''}</button>`
    ).join('');
    const rows = rowLabels.map((label, row) => {
        const cells = colLabels.map((colLabel, col) => {
            const count = grid[row][col] || 0;
            const level = heatIntensityLevel(count, max);
            const shown = colText ? colText(colLabel, col) : String(colLabel);
            return `<button type="button" class="heatmap-cell" data-heat-view="${view}" data-heat-row="${row}" data-heat-col="${col}" data-count="${count}" data-intensity="${level}" ${count ? '' : 'disabled'} title="${escapeHtml(label)} ${escapeHtml(shown)} · ${formatCount(count)}"></button>`;
        }).join('');
        const dayN = grid[row].reduce((sum, n) => sum + n, 0);
        return `<div class="heatmap-label">${escapeHtml(String(label))}</div>${cells}<button type="button" class="heatmap-total heatmap-day-total" data-heat-view="${view}" data-heat-row="${row}" data-count="${dayN}" ${dayN ? '' : 'disabled'} title="${escapeHtml(String(label))} · ${formatCount(dayN)}">${dayN ? formatCount(dayN) : ''}</button>`;
    }).join('');
    const grand = colTotals.reduce((sum, n) => sum + n, 0);
    return { html: `
        <div class="heatmap-wrap">
            <div class="heatmap" style="${style}">
                <div class="heatmap-corner" aria-hidden="true"></div>${heads}<div class="heatmap-corner heatmap-sum-label">Σ</div>
                ${rows}
                <div class="heatmap-sum-label">Σ</div>${headSums}<div class="heatmap-grand" title="All plotted bookmarks">${formatCount(grand)}</div>
            </div>
        </div>`, grand };
}

function heatSpanLabel(ms) {
    const days = ms / 86400000;
    if (!Number.isFinite(days) || days < 1) return formatDuration(ms);
    if (days < 60) return `${Math.round(days)} days`;
    if (days < 540) return `${(days / 30.44).toFixed(1)} months`;
    return `${(days / 365.25).toFixed(1)} years`;
}

function heatNumHtml(line) {
    return escapeHtml(line).replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%?/g, match => `<span class="heat-num">${match}</span>`);
}

function heatWrappedHtml(model, clock, lead) {
    const heatmap = model.heatmap;
    const sum = row => row.reduce((n, value) => n + value, 0);
    const grand = clock.grid.reduce((n, row) => n + sum(row), 0);
    if (!grand) return '';
    const argmax = values => values.reduce((best, value, index) => value > values[best] ? index : best, 0);
    const share = n => `${Math.round((n / grand) * 100)}%`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayTotals = clock.grid.map(sum);
    const colTotals = Array.from({ length: clock.cols }, (_, col) => clock.grid.reduce((n, row) => n + row[col], 0));
    const bestDay = argmax(dayTotals);
    const bestCol = argmax(colTotals);
    const weekend = dayTotals[0] + dayTotals[6];
    const night = heatmap.grid.reduce((n, row) => n + row.slice(0, 6).reduce((a, b) => a + b, 0), 0);
    const monthTotals = heatmap.month.grid.map(sum);
    const bestMonth = argmax(monthTotals);
    const domTotals = Array.from({ length: 31 }, (_, day) => heatmap.month.grid.reduce((n, row) => n + row[day], 0));
    const bestDom = argmax(domTotals);
    const yearTotals = heatmap.years.map(row => sum(row.grid));
    const bestYear = yearTotals.length ? argmax(yearTotals) : -1;
    const year = bestYear >= 0 ? heatmap.years[bestYear] : null;
    const yearMonth = year ? argmax(year.grid) : 0;
    const dated = model.links.filter(link => heatStampOk(link.addedMs)).slice().sort((a, b) => a.addedMs - b.addedMs);
    const first = dated[0];
    const last = dated[dated.length - 1];
    const spanMs = last.addedMs - first.addedMs;
    const spanDays = Math.max(spanMs / 86400000, 1);
    const perDay = grand / spanDays;
    const perWeek = perDay * 7;
    const rateLine = spanMs < 86400000
        ? `Everything dated landed inside ${formatDuration(spanMs) === '—' ? 'one moment' : formatDuration(spanMs)}, so a daily rate would just be that burst.`
        : `From ${new Date(first.addedMs).toLocaleDateString()} to ${new Date(last.addedMs).toLocaleDateString()} is ${heatSpanLabel(spanMs)}. That is about ${perDay >= 1 ? perDay.toFixed(1) : perDay.toFixed(2)} bookmarks a day, or ${perWeek >= 1 ? perWeek.toFixed(1) : perWeek.toFixed(2)} a week.`;
    const recentCut = last.addedMs - 30 * 86400000;
    const recent = dated.filter(link => link.addedMs >= recentCut).length;
    const recentPerDay = recent / 30;
    const pace = spanMs < 30 * 86400000
        ? ''
        : recentPerDay > perDay * 1.25
            ? ` The last 30 days of that span ran hotter: ${formatCount(recent)} saves, about ${recentPerDay.toFixed(1)} a day, above the lifetime pace.`
            : recentPerDay < perDay * 0.75
                ? ` The last 30 days of that span cooled off: ${formatCount(recent)} saves, about ${recentPerDay.toFixed(1)} a day, under the lifetime pace.`
                : ` The last 30 days of that span stayed near the lifetime pace (${formatCount(recent)} saves).`;
    let quietMs = 0;
    let quietAt = 0;
    for (let i = 1; i < dated.length; i++) {
        const gap = dated[i].addedMs - dated[i - 1].addedMs;
        if (gap > quietMs) {
            quietMs = gap;
            quietAt = dated[i - 1].addedMs;
        }
    }
    const dayCounts = new Map();
    dated.forEach(link => {
        const key = new Date(link.addedMs).toDateString();
        dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
    });
    let busiestKey = '';
    let busiestN = 0;
    dayCounts.forEach((n, key) => {
        if (n > busiestN) {
            busiestN = n;
            busiestKey = key;
        }
    });
    const top = (model.domains || []).slice().sort((a, b) => b.count - a.count)[0];
    const once = (model.domains || []).filter(domain => domain.count === 1).length;
    const returning = (model.domains || []).filter(domain => domain.count > 1).length;
    const undated = model.links.length - grand;
    const topChain = (model.chains || []).slice().sort((a, b) => b.count - a.count)[0];
    const lines = [
        `${lead ? `${lead} ` : ''}${formatCount(grand)} dated bookmarks${undated ? `, plus ${formatCount(undated)} with no usable date` : ''}. ${days[bestDay]} holds ${formatCount(dayTotals[bestDay])} of the dated ones (${share(dayTotals[bestDay])}). The busiest block on the clock is ${heatHourRange(bestCol * heatmapGrain, heatmapGrain)}, with ${formatCount(colTotals[bestCol])}.`,
        weekend >= grand - weekend
            ? `Weekends carry ${formatCount(weekend)} (${share(weekend)}). Weekdays carry the rest. Midnight to 6:00 holds ${formatCount(night)} (${share(night)}).`
            : `Weekdays carry ${formatCount(grand - weekend)} (${share(grand - weekend)}). Weekends carry the rest. Midnight to 6:00 holds ${formatCount(night)} (${share(night)}).`,
        `${HEAT_MONTHS[bestMonth]} is the heaviest month across years (${formatCount(monthTotals[bestMonth])}, ${share(monthTotals[bestMonth])}). Day ${bestDom + 1} of the month is the heaviest date (${formatCount(domTotals[bestDom])}). The single busiest calendar day is ${busiestKey} with ${formatCount(busiestN)}.`,
        year
            ? `${year.year} is the biggest year (${formatCount(yearTotals[bestYear])}, ${share(yearTotals[bestYear])}), and inside it ${HEAT_MONTHS[yearMonth]} leads. The library spans ${heatmap.years[0].year}–${heatmap.years[heatmap.years.length - 1].year}.`
            : '',
        rateLine + pace,
        quietMs > 0
            ? `The longest quiet stretch between two dated bookmarks is ${heatSpanLabel(quietMs)}, starting ${new Date(quietAt).toLocaleDateString()}.`
            : '',
        top
            ? `${top.parent} is the largest domain, ${formatCount(top.count)} bookmarks (${Math.round((top.count / model.links.length) * 100)}% of the library). ${formatCount(returning)} domain${returning === 1 ? '' : 's'} come back more than once; ${formatCount(once)} appear only once.`
            : '',
        model.chains?.length
            ? `${formatCount(model.chains.length)} search chain${model.chains.length === 1 ? '' : 's'}. The longest is “${topChain.topic}” with ${formatCount(topChain.count)} links.`
            : 'No search chains at the current gap.',
        model.bursts?.length
            ? `${formatCount(model.bursts.length)} quick-add session${model.bursts.length === 1 ? '' : 's'}${model.binges?.length ? `, including ${formatCount(model.binges.length)} binge${model.binges.length === 1 ? '' : 's'}` : ''}.${model.collisions?.length ? ` ${formatCount(model.collisions.length)} clock-collision batch${model.collisions.length === 1 ? '' : 'es'} share one timestamp and stay out of those sessions.` : ''}`
            : ''
    ].filter(Boolean);
    return `<div class="heat-wrapped" role="button" tabindex="0" title="Next insight">${lines.map((line, index) => `<p class="${index ? '' : 'on'}"><span>${heatNumHtml(line)}</span></p>`).join('')}</div>`;
}

function heatWeekModel(model) {
    const cut = Date.now() - 7 * 86400000;
    const links = model.links.filter(link => heatStampOk(link.addedMs) && link.addedMs >= cut);
    const nodes = new Set(links.map(link => link.node));
    const trim = list => (list || []).map(item => {
        const kept = (item.links || []).filter(link => nodes.has(link.node));
        if (!kept.length) return null;
        return { ...item, links: kept, count: kept.length };
    }).filter(Boolean);
    return {
        links,
        heatmap: buildHeatmap(links),
        domains: trim(model.domains),
        chains: trim(model.chains),
        bursts: trim(model.bursts),
        binges: trim(model.binges),
        collisions: trim(model.collisions)
    };
}

function heatWeekHtml(model) {
    const now = Date.now();
    const cut = now - 7 * 86400000;
    const dated = model.links.filter(link => heatStampOk(link.addedMs));
    const weekLinks = dated.filter(link => link.addedMs >= cut);
    const card = lines => `<div class="heat-wrapped heat-wrapped-week" role="button" tabindex="0" title="Next insight">${lines.map((line, index) => `<p class="${index ? '' : 'on'}"><span>${heatNumHtml(line)}</span></p>`).join('')}</div>`;
    if (!weekLinks.length) return card(['No bookmarks in the last 7 days.']);
    const week = heatWeekModel(model);
    const clock = collapseHeatHours(week.heatmap, heatmapGrain);
    const sum = row => row.reduce((n, value) => n + value, 0);
    const grand = weekLinks.length;
    const argmax = values => values.reduce((best, value, index) => value > values[best] ? index : best, 0);
    const share = (n, of) => `${Math.round((n / of) * 100)}%`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayTotals = clock.grid.map(sum);
    const colTotals = Array.from({ length: clock.cols }, (_, col) => clock.grid.reduce((n, row) => n + row[col], 0));
    const bestDay = argmax(dayTotals);
    const bestCol = argmax(colTotals);
    const byCalendar = new Map();
    weekLinks.forEach(link => {
        const key = new Date(link.addedMs).toDateString();
        byCalendar.set(key, (byCalendar.get(key) || 0) + 1);
    });
    let busiestKey = '';
    let busiestN = 0;
    byCalendar.forEach((n, key) => {
        if (n > busiestN) {
            busiestN = n;
            busiestKey = key;
        }
    });
    const slots = [];
    for (let i = 6; i >= 0; i--) {
        const day = new Date(now);
        day.setHours(12, 0, 0, 0);
        day.setDate(day.getDate() - i);
        slots.push(day);
    }
    const quiet = slots.filter(day => !byCalendar.has(day.toDateString()));
    const prior = dated.filter(link => link.addedMs >= cut - 7 * 86400000 && link.addedMs < cut).length;
    const lastDay = weekLinks.filter(link => link.addedMs >= now - 86400000).length;
    const hostOf = link => parentDomainFromHost(linkHost(link));
    const olderHosts = new Set(dated.filter(link => link.addedMs < cut).map(hostOf).filter(Boolean));
    const weekHostCounts = new Map();
    weekLinks.forEach(link => {
        const host = hostOf(link);
        if (host) weekHostCounts.set(host, (weekHostCounts.get(host) || 0) + 1);
    });
    let topHost = '';
    let topN = 0;
    weekHostCounts.forEach((n, host) => {
        if (n > topN) {
            topN = n;
            topHost = host;
        }
    });
    const fresh = [...weekHostCounts.keys()].filter(host => !olderHosts.has(host));
    const back = [...weekHostCounts.keys()].filter(host => olderHosts.has(host));
    const pace = !prior
        ? 'The 7 days before this had no dated bookmarks.'
        : grand > prior * 1.25
            ? `That is ahead of the previous 7 days, which had ${formatCount(prior)}.`
            : grand < prior * 0.75
                ? `That is behind the previous 7 days, which had ${formatCount(prior)}.`
                : `That is about even with the previous 7 days, which had ${formatCount(prior)}.`;
    const topChain = [...(week.chains || [])].sort((a, b) => b.count - a.count)[0];
    const lines = [
        `This week has ${formatCount(grand)} dated bookmark${grand === 1 ? '' : 's'} across ${formatCount(byCalendar.size)} calendar day${byCalendar.size === 1 ? '' : 's'}. ${days[bestDay]} is the heaviest weekday (${formatCount(dayTotals[bestDay])}, ${share(dayTotals[bestDay], grand)}). The busiest block is ${heatHourRange(bestCol * heatmapGrain, heatmapGrain)}, with ${formatCount(colTotals[bestCol])}.`,
        `${pace} These ${formatCount(grand)} are ${share(grand, dated.length)} of every dated bookmark in the library. The busiest day is ${busiestKey} with ${formatCount(busiestN)}.`,
        quiet.length
            ? `Quiet calendar days in this window: ${quiet.map(day => days[day.getDay()]).join(', ')}.`
            : 'Every one of the last 7 calendar days has at least one bookmark.',
        `The last 24 hours account for ${formatCount(lastDay)} of this week (${share(lastDay, grand)}). The earlier part of the week holds ${formatCount(grand - lastDay)}.`,
        topHost
            ? `${topHost} leads this week with ${formatCount(topN)} (${share(topN, grand)}). ${formatCount(fresh.length)} domain${fresh.length === 1 ? ' is' : 's are'} new compared with everything older${fresh.length ? ` (${fresh.slice(0, 4).join(', ')}${fresh.length > 4 ? '…' : ''})` : ''}. ${formatCount(back.length)} already appeared before this week.`
            : '',
        topChain
            ? `${formatCount(week.chains.length)} search chain${week.chains.length === 1 ? '' : 's'} landed this week. The longest is “${topChain.topic}” with ${formatCount(topChain.count)} links.`
            : 'No search chains in the last 7 days.',
        week.bursts?.length
            ? `${formatCount(week.bursts.length)} quick-add session${week.bursts.length === 1 ? '' : 's'} this week${week.binges?.length ? `, including ${formatCount(week.binges.length)} binge${week.binges.length === 1 ? '' : 's'}` : ''}.${week.collisions?.length ? ` ${formatCount(week.collisions.length)} clock-collision batch${week.collisions.length === 1 ? '' : 'es'} share one timestamp.` : ''}`
            : 'No quick-add sessions in the last 7 days.'
    ].filter(Boolean);
    return card(lines);
}

function renderHeatmapSection(model) {
    const heatmap = model.heatmap;
    const clock = collapseHeatHours(heatmap, heatmapGrain);
    const grainBtns = HEAT_GRAINS.map(grain =>
        `<button type="button" class="heat-mode-btn${grain === heatmapGrain ? ' active' : ''}" data-heat-grain="${grain}" aria-pressed="${grain === heatmapGrain}">${grain}h</button>`
    ).join('');
    const legend = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(level =>
        `<span class="heatmap-swatch" data-intensity="${level}"></span>`
    ).join('');
    const hourLabels = Array.from({ length: clock.cols }, (_, col) => col * heatmapGrain);
    const clockGrid = heatMatrixHtml(
        'clock', WEEKDAYS, hourLabels, clock.grid, clock.max,
        (label, n) => `${heatHourRange(Number(label), heatmapGrain)} · ${formatCount(n)}`,
        label => heatHourRange(Number(label), heatmapGrain)
    );
    const dayLabels = Array.from({ length: 31 }, (_, i) => i + 1);
    const monthGrid = heatMatrixHtml(
        'month', HEAT_MONTHS, dayLabels, heatmap.month.grid, heatmap.month.max,
        (label, n) => `Day ${label} · ${formatCount(n)}`
    );
    const yearLabels = heatmap.years.map(row => row.year);
    const yearRows = heatmap.years.map(row => row.grid);
    const yearGrid = yearLabels.length
        ? heatMatrixHtml('year', yearLabels, HEAT_MONTHS, yearRows, heatmap.yearMax, (label, n) => `${label} · ${formatCount(n)}`)
        : { html: '<div class="stats-empty">No dated bookmarks to plot.</div>', grand: 0 };
    return `
        <section class="stats-section heatmap-section">
            <div class="heatmap-head">
                <div>
                    <h2>When bookmarks were added</h2>
                    <p class="stats-section-help">Three local <code>dateAdded</code> views. Epoch / 12/31/69 dates are excluded. Click a cell, row total, or column total. Hour blocks merge the weekday view; month × day and year × month stay beside it.</p>
                </div>
            </div>
            <div class="heat-insight-row">
                ${heatWrappedHtml(model, clock)}
                ${heatWeekHtml(model)}
            </div>
            <div class="heatmap-legend">
                <span>Empty</span>${legend}<span>Hot</span>
            </div>
            <h3 class="heatmap-view-title">Weekday × hour</h3>
            <div class="heat-mode" role="group" aria-label="Hour block size">
                ${grainBtns}
            </div>
            <p class="stats-section-help">Peak ${formatCount(clock.max)} per block. These buttons only change this grid and the hour-block sentence above.</p>
            ${clockGrid.grand ? clockGrid.html : '<div class="stats-empty">No dated bookmarks to plot.</div>'}
            <h3 class="heatmap-view-title">Month × day</h3>
            <p class="stats-section-help">Same month and day-of-month across years. Peak ${formatCount(heatmap.month.max)}.</p>
            ${monthGrid.grand ? monthGrid.html : '<div class="stats-empty">No dated bookmarks to plot.</div>'}
            <h3 class="heatmap-view-title">Year × month</h3>
            <p class="stats-section-help">One row per year that has a dated bookmark. Peak ${formatCount(heatmap.yearMax)}.</p>
            ${yearGrid.grand ? yearGrid.html : '<div class="stats-empty">No dated bookmarks to plot.</div>'}
        </section>
    `;
}

// The Returning table's row order, shared by the on-screen table and its CSV rows.
function returningSortItems(domains) {
    const key = returningSort.key || 'last';
    const dir = returningSort.dir;
    const span = domain => (domain.firstAdded && domain.lastAdded) ? domain.lastAdded - domain.firstAdded : 0;
    const value = (domain) => {
        if (key === 'domain') return String(domain.rdnn || '');
        if (key === 'links' || key === 'count') return domain.count || 0;
        if (key === 'span') return span(domain);
        if (key === 'first') return domain.firstAdded || 0;
        return domain.lastAdded || 0;
    };
    return (domains || []).slice().sort((a, b) => {
        if (key === 'domain') return dir * String(a.rdnn || '').localeCompare(String(b.rdnn || ''));
        const diff = value(a) - value(b);
        return diff ? diff * dir : String(a.rdnn || '').localeCompare(String(b.rdnn || ''));
    });
}

function renderReturningSection(domains) {
    const key = returningSort.key;
    const dir = returningSort.dir;
    const sorted = returningSortItems(domains);
    const once = sorted.filter(domain => domain.count === 1);
    const returning = sorted.filter(domain => domain.count > 1);
    const mark = col => key === col ? (dir > 0 ? ' ↑' : ' ↓') : '';
    const row = domain => `<tr class="stats-row" data-rdnn="${escapeHtml(domain.rdnn)}">
        <td><div class="stats-rdnn">${escapeHtml(domain.rdnn)}</div><div class="stats-host">${escapeHtml(domain.parent)}</div></td>
        <td class="stats-num">${formatCount(domain.count)}</td>
        <td>${domain.firstAdded ? escapeHtml(new Date(domain.firstAdded).toLocaleDateString()) : '—'}</td>
        <td>${domain.lastAdded ? `${escapeHtml(new Date(domain.lastAdded).toLocaleString())} <span class="stats-host">(${escapeHtml(formatRelative(domain.lastAdded))})</span>` : '—'}</td>
        <td class="stats-num">${domain.firstAdded && domain.lastAdded ? escapeHtml(formatDuration(domain.lastAdded - domain.firstAdded)) : '—'}</td>
    </tr>`;
    const table = (title, help, items) => `
        <h3 style="font-size:13px;margin:12px 0 6px">${title}</h3>
        <p class="stats-section-help">${help}</p>
        ${items.length ? `<table class="stats-table">
            <thead><tr><th class="sort-col" data-sort="domain">Domain${mark('domain')}</th><th class="stats-num sort-col" data-sort="links">Links${mark('links')}</th><th class="sort-col" data-sort="first">First seen${mark('first')}</th><th class="sort-col" data-sort="last">Last bookmarked${mark('last')}</th><th class="stats-num sort-col" data-sort="span">Span${mark('span')}</th></tr></thead>
            <tbody>${items.map(row).join('')}</tbody>
        </table>` : '<div class="stats-empty">None in this filter.</div>'}
    `;
    return `
        <section class="stats-section">
            <h2>First-seen vs returning domains${sortResetButton('returning')}</h2>
            <p class="stats-section-help">Last bookmarked is the latest <code>dateAdded</code> on that parent domain. Click any column to sort by it.</p>
            ${table('Returning', 'Domains you added more than once.', returning)}
            ${table('First-seen only', 'Domains that appear exactly once in this library.', once)}
        </section>
    `;
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeStatsPanel();
    const panel = document.getElementById('stats-panel');
    if (!panel || panel.hidden) return;
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const state = panelTableState;
    if (!state.filtered?.length) return;
    if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const dir = event.key === 'j' ? 1 : -1;
        state.selected = Math.max(0, Math.min(state.filtered.length - 1, (state.selected ?? 0) + dir));
        const page = Math.floor(state.selected / state.pageSize);
        if (page !== state.page) {
            state.page = page;
            renderPanelTable();
        } else {
            document.querySelectorAll('#stats-panel-body tr.kb-on').forEach(row => row.classList.remove('kb-on'));
            const row = document.querySelector(`#stats-panel-body tr[data-row="${state.selected}"]`);
            if (row) {
                row.classList.add('kb-on');
                row.scrollIntoView({ block: 'nearest' });
            }
        }
    }
    if (event.key === 'Enter') {
        const link = state.filtered[state.selected ?? 0];
        if (link?.uri) {
            event.preventDefault();
            window.open(link.uri, '_blank', 'noopener,noreferrer');
        }
    }
    if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        const link = state.filtered[state.selected ?? 0];
        if (link) revealBookmark(link);
    }
});

function csvEscape(value) {
    const text = String(value ?? '');
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

function csvLine(cells) {
    return (cells || []).map(csvEscape).join(',');
}

// The session-family tables (Search chains, Topics, Binges, Sessions, Clock
// collisions) all share one set of on-screen columns.
function statsCsvSessionRows(items) {
    return sortSessionItems(items || []).map(item => csvLine([
        item.firstAdded ? new Date(item.firstAdded).toISOString() : '',
        item.topic || '',
        item.count || 0,
        item.spanMs != null ? formatDuration(item.spanMs) : '',
        sessionKindLabel(item),
        (item.trail || []).join(' → ')
    ]));
}

// Every statistics table that currently has data, as sections with a title row
// and a blank line between them. Columns match the on-screen tables.
function buildStatsCsv() {
    const model = getAnalyticsModel();
    const sections = [];
    const sessionSection = (title, items) => {
        if (!items || !items.length) return;
        sections.push([
            title,
            csvLine(['Started', 'Topic', 'Links', 'Span', 'Kind', 'Trail']),
            ...statsCsvSessionRows(items)
        ].join('\n'));
    };
    sessionSection('Search chains', model.chains);
    sessionSection('Topics', model.topics);
    sessionSection('Binges', model.binges);
    sessionSection('Sessions', model.bursts);
    sessionSection('Clock collisions', model.collisions);
    const returningSection = (title, items) => {
        if (!items.length) return;
        sections.push([
            title,
            csvLine(['Domain', 'Links', 'First seen', 'Last bookmarked', 'Span']),
            ...items.map(domain => csvLine([
                domain.rdnn,
                domain.count,
                domain.firstAdded ? new Date(domain.firstAdded).toISOString() : '',
                domain.lastAdded ? new Date(domain.lastAdded).toISOString() : '',
                domain.firstAdded && domain.lastAdded ? formatDuration(domain.lastAdded - domain.firstAdded) : ''
            ]))
        ].join('\n'));
    };
    const sortedDomains = sortStatsDomains(model.domains);
    returningSection('Returning', returningSortItems(sortedDomains.filter(domain => domain.count > 1)));
    returningSection('First-seen only', returningSortItems(sortedDomains.filter(domain => domain.count === 1)));
    if (sortedDomains.length) {
        sections.push([
            'By domain',
            csvLine(['Parent domain (RDNN)', ...STATS_WINDOWS.map(window => window.label), 'Total', 'Service preview']),
            ...sortedDomains.map(domain => csvLine([
                domain.rdnn,
                ...domain.windows.map(window => window.count),
                domain.count,
                domain.services.map(service => `${service.label} · ${service.count}`).join('; ')
            ]))
        ].join('\n'));
    }
    const clock = collapseHeatHours(model.heatmap, heatmapGrain);
    const heatViews = [
        {
            title: `Heatmap — Weekday × hour (${heatmapGrain}h blocks)`,
            rowLabels: WEEKDAYS,
            colLabels: Array.from({ length: clock.cols }, (_, col) => heatHourRange(col * heatmapGrain, heatmapGrain)),
            grid: clock.grid
        },
        {
            title: 'Heatmap — Month × day',
            rowLabels: HEAT_MONTHS,
            colLabels: Array.from({ length: 31 }, (_, day) => String(day + 1)),
            grid: model.heatmap.month.grid
        },
        {
            title: 'Heatmap — Year × month',
            rowLabels: model.heatmap.years.map(row => String(row.year)),
            colLabels: HEAT_MONTHS,
            grid: model.heatmap.years.map(row => row.grid)
        }
    ];
    heatViews.forEach(view => {
        if (!view.rowLabels.length) return;
        const colTotals = view.colLabels.map((label, col) => view.grid.reduce((sum, row) => sum + (row[col] || 0), 0));
        const grand = colTotals.reduce((sum, n) => sum + n, 0);
        if (!grand) return;
        sections.push([
            view.title,
            csvLine(['', ...view.colLabels, 'Total']),
            ...view.rowLabels.map((label, row) => csvLine([
                label,
                ...view.grid[row],
                (view.grid[row] || []).reduce((sum, n) => sum + n, 0)
            ])),
            csvLine(['Total', ...colTotals, grand])
        ].join('\n'));
    });
    const health = buildDomainHealthTable();
    if (health.rows.length) sections.push(domainHealthCsv(health));
    return sections.join('\n\n');
}

function exportStatsCsv() {
    if (!bookmarkData) return alert('Library is not loaded.');
    const csv = buildStatsCsv();
    if (!csv) return alert('No statistics to export yet.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'bookmark-stats.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Reporting: folder size ranking · domain health
// Additive only. Every new top-level name carries a stats/report prefix so it can
// never collide with another classic script (a duplicate top-level name in the
// shared global scope is a fatal SyntaxError).
// ---------------------------------------------------------------------------
const STATS_AFFECTED_LOG_KEY_FALLBACK = 'bookmark-editor-affected-log';
const STATS_AFFECTED_LOG_LEGACY_KEY = 'bookmark-editor-log';
const STATS_REPORT_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const STATS_FOLDER_RANK_LIMIT = 50;
const STATS_DOMAIN_TOP = 10;
// `data-child` ids the coordinator can hang off openStatisticsChildTab, mapped to
// the statistics sub-view ids in STATS_TABS.
const STATS_REPORT_CHILD_TABS = {
    'folder-size': 'folder-size',
    'folder-sizes': 'folder-size',
    'folder-size-ranking': 'folder-size',
    'stats-folder-size': 'folder-size',
    'domain-health': 'domains',
    'stats-domain-health': 'domains'
};
let lastFolderRankingModel = null;
// The health model the CSV reads. buildDomainHealthTable() assigns it on every build.
let lastDomainHealthModel = null;
let lastDomainHealthCacheKey = null;
let statsFolderRankingCache = { rev: '', root: null, model: null };
let statsAffectedLogCache = { key: '', raw: '', rows: null };

// --- storage, read defensively (file://, private mode, and a vm with no storage) ---
function statsStorageRaw(key) {
    try {
        if (!key || typeof localStorage === 'undefined' || !localStorage) return '';
        return localStorage.getItem(key) || '';
    } catch (err) {
        return '';
    }
}

function statsStorageJson(key) {
    const raw = statsStorageRaw(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed == null ? null : parsed;
    } catch (err) {
        return null;
    }
}

// The real constants live in bookmark-editor-v1.0.js (SNAPSHOT_STORAGE_KEY,
// AFFECTED_LOG_KEY); the literals are only a fallback for a page that loads this
// file on its own (the verification harness, for one).
// The affected log. Same idea: the core's in-memory array first (affectedLog),
// then the persisted key, at the real name first and the first brief's name after.
// The key: the core's constant when that script is loaded, the literal name otherwise. This sat
// inside the snapshot block that was repealed, so it is restored here where its reader needs it.
function statsAffectedLogKey() {
    try {
        if (typeof AFFECTED_LOG_KEY === 'string' && AFFECTED_LOG_KEY) return AFFECTED_LOG_KEY;
    } catch (err) {}
    return STATS_AFFECTED_LOG_KEY_FALLBACK;
}

function statsStoredAffectedLog() {
    try {
        if (typeof affectedLog !== 'undefined' && Array.isArray(affectedLog) && affectedLog.length) {
            return affectedLog.filter(row => row && Number.isFinite(Number(row.at)));
        }
    } catch (err) {}
    const keys = [statsAffectedLogKey(), STATS_AFFECTED_LOG_LEGACY_KEY];
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const raw = statsStorageRaw(key);
        if (!raw) continue;
        if (statsAffectedLogCache.key === key && statsAffectedLogCache.raw === raw && statsAffectedLogCache.rows) return statsAffectedLogCache.rows;
        const parsed = statsStorageJson(key);
        const rows = Array.isArray(parsed)
            ? parsed.filter(row => row && Number.isFinite(Number(row.at)))
            : [];
        statsAffectedLogCache = { key, raw, rows };
        return rows;
    }
    return [];
}

// --- small tree helpers (bookmark-lib's rules, with local fallbacks) ---
function statsNodeUri(node) {
    if (!node) return '';
    if (typeof nodeUri === 'function') return nodeUri(node) || '';
    return String(node.uri || node.url || '');
}

function statsIsFolderNode(node) {
    if (!node) return false;
    if (typeof isBookmarkFolderNode === 'function') return isBookmarkFolderNode(node);
    if (node.type === 'separator') return false;
    if (statsNodeUri(node) || node.typeCode === 1 || node.type === 'url' || node.type === 'bookmark') return false;
    return node.typeCode === 2 || Array.isArray(node.children) || node.type === 'folder';
}

function statsFolderLabel(node) {
    if (!node) return 'Root';
    try {
        if (typeof displayFolderTitle === 'function') return displayFolderTitle(node);
    } catch (err) {}
    const raw = String(node.title || node.name || '').trim();
    return raw || 'Root';
}

function statsWalkTree(root, visit) {
    if (!root) return;
    visit(root, null);
    const children = root.children;
    if (!children || !children.length) return;
    for (let i = 0; i < children.length; i++) statsWalkTree(children[i], visit);
}

// countTree's rule, so the growth numbers agree with the Bookmarks tab total
// (the library root counts as a folder).
function statsTreeCounts(root) {
    const out = { links: 0, folders: 0 };
    statsWalkTree(root, node => {
        if (statsNodeUri(node) || node.type === 'url') out.links += 1;
        if (node.children || node.typeCode === 2 || node.type === 'folder') out.folders += 1;
    });
    return out;
}

function statsSameFolder(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
    if (a.guid && b.guid && String(a.guid) === String(b.guid)) return true;
    return false;
}

function statsTreeHasFolder(root, target) {
    if (!root) return false;
    if (statsSameFolder(root, target)) return true;
    return (root.children || []).some(child => statsIsFolderNode(child) && statsTreeHasFolder(child, target));
}

// true when openFolderDrilldown would resolve this node in the loaded library.
function statsFolderResolves(folder) {
    let root = null;
    try {
        if (typeof bookmarkData !== 'undefined' && bookmarkData) root = bookmarkData;
    } catch (err) {}
    if (!root) return false;
    return statsTreeHasFolder(root, folder);
}

// --- 1. Library growth over time ---
function statsLocalDayKey(ms) {
    const d = new Date(Number(ms) || 0);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// type ADDED counts as added, REMOVED/DELETED as removed, MODIFIED separately.
function statsDayLogCounts(entries) {
    const map = new Map();
    (entries || []).forEach(entry => {
        const at = Number(entry && entry.at);
        if (!Number.isFinite(at)) return;
        const key = statsLocalDayKey(at);
        const row = map.get(key) || { added: 0, removed: 0, modified: 0, events: 0 };
        const type = String(entry.type || '').toUpperCase();
        if (type === 'ADDED') row.added += 1;
        else if (type === 'REMOVED' || type === 'DELETED') row.removed += 1;
        else if (type === 'MODIFIED') row.modified += 1;
        row.events += 1;
        map.set(key, row);
    });
    return map;
}

// Pure when every argument is given; with no arguments it reads the affected log
// and the clock.
function statsRankingWalk(node, pathParts, rows) {
    let links = 0;
    let folders = 0;
    let empty = 0;
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!statsIsFolderNode(child)) {
            if (statsNodeUri(child)) links += 1;
            continue;
        }
        const childPath = pathParts.concat([statsFolderLabel(child)]);
        const sub = statsRankingWalk(child, childPath, rows);
        const childEmpty = (child.children || []).length ? 0 : 1;
        links += sub.links;
        folders += 1 + sub.folders;
        empty += sub.empty + childEmpty;
        rows.push({
            folder: child,
            pathParts: childPath,
            links: sub.links,
            folders: sub.folders,
            emptyFolders: sub.empty,
            emptyItself: childEmpty
        });
    }
    return { links, folders, empty };
}

// Pure when a root is given; otherwise the loaded library.
function buildFolderSizeRanking(root) {
    let tree = root;
    if (!tree) {
        try {
            if (typeof bookmarkData !== 'undefined' && bookmarkData) tree = bookmarkData;
        } catch (err) {}
    }
    const raw = [];
    if (tree) statsRankingWalk(tree, [], raw);
    const maxLinks = raw.reduce((max, row) => Math.max(max, row.links), 0);
    const rows = raw.map(row => {
        const joined = row.pathParts.join(' / ');
        let path = joined;
        try {
            if (typeof displayFolderPath === 'function') path = displayFolderPath(joined) || joined;
        } catch (err) {}
        return {
            folder: row.folder,
            title: statsFolderLabel(row.folder),
            path,
            links: row.links,
            folders: row.folders,
            emptyFolders: row.emptyFolders,
            emptyItself: row.emptyItself,
            resolves: statsFolderResolves(row.folder),
            barPct: maxLinks ? Math.round((row.links / maxLinks) * 1000) / 10 : 0
        };
    }).sort((a, b) => b.links - a.links || b.folders - a.folders || a.path.localeCompare(b.path));
    rows.forEach((row, index) => { row.rank = index + 1; });
    return {
        generatedAt: Date.now(),
        root: tree,
        totalFolders: rows.length,
        maxLinks,
        rows: rows.slice(0, STATS_FOLDER_RANK_LIMIT)
    };
}

function statsReportRev() {
    try {
        if (typeof statsDataRev !== 'undefined' && statsDataRev != null) return String(statsDataRev);
    } catch (err) {}
    return '';
}

// The ranking walks the whole library, so it is remembered until the tree
// revision (statsDataRev) or the loaded root changes.
function getFolderSizeRanking() {
    let root = null;
    try {
        if (typeof bookmarkData !== 'undefined' && bookmarkData) root = bookmarkData;
    } catch (err) {}
    const rev = statsReportRev();
    const cache = statsFolderRankingCache;
    if (cache.model && cache.rev === rev && cache.root === root) {
        lastFolderRankingModel = cache.model;
        return cache.model;
    }
    const model = buildFolderSizeRanking(root);
    statsFolderRankingCache = { rev, root, model };
    lastFolderRankingModel = model;
    return model;
}

// The share-of-peak bar the folder-size table draws. It lived in the snapshot reporting block that
// was repealed, and the ranking view still asks for it.
function statsBarHtml(pct) {
    const width = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="stats-bar"><span class="stats-bar-fill" style="width:${width}%"></span></div>`;
}

function folderRankingSectionHtml(model) {
    const data = model || getFolderSizeRanking();
    lastFolderRankingModel = data;
    const head = `<h2>Folder size ranking${sortResetButton('folder')}</h2>
        <p class="stats-section-help">The ${formatCount(STATS_FOLDER_RANK_LIMIT)} folders holding the most descendant links. Links and Folders count everything below the folder; Empty folders counts descendants with no children. Click a row to open that folder's report.</p>`;
    if (!data.rows.length) {
        return `<section class="stats-section">${head}<div class="stats-empty">No folders to rank.</div></section>`;
    }
    // Sorted here rather than in the model: the drill-down index has to stay the model's own index.
    const fkey = folderSort.key;
    const fdir = folderSort.dir;
    const fvalue = (row, key) => {
        if (key === 'folder') return String(row.path || row.title || '');
        if (key === 'folders') return row.folders || 0;
        if (key === 'empty') return row.emptyFolders || 0;
        if (key === 'rank') return row.rank || 0;
        return row.links || 0;
    };
    const fmark = col => (fkey === col ? (fdir > 0 ? ' ↑' : ' ↓') : '');
    const ordered = data.rows.map((row, index) => ({ row, index })).sort((a, b) => {
        if (fkey === 'folder') return fdir * String(fvalue(a.row, 'folder')).localeCompare(String(fvalue(b.row, 'folder')));
        const diff = fvalue(a.row, fkey) - fvalue(b.row, fkey);
        return diff ? fdir * diff : (a.row.rank || 0) - (b.row.rank || 0);
    });
    const rows = ordered.map(({ row, index }) => {
        const label = row.path || row.title || 'Untitled';
        const pathCell = row.resolves
            ? `<button type="button" class="stats-chip" data-folder-drill="${index}" title="Open this folder's report">${escapeHtml(label)}</button>`
            : `<span class="stats-host">${escapeHtml(label)}</span>`;
        return `<tr class="stats-row"${row.resolves ? ` data-folder-drill="${index}"` : ''}>
            <td class="stats-num">${formatCount(row.rank)}</td>
            <td>${pathCell}</td>
            <td class="stats-num">${formatCount(row.links)}</td>
            <td class="stats-bar-cell">${statsBarHtml(row.barPct)}</td>
            <td class="stats-num">${formatCount(row.folders)}</td>
            <td class="stats-num">${formatCount(row.emptyFolders)}</td>
        </tr>`;
    }).join('');
    return `<section class="stats-section">${head}
        <p class="stats-report-note">${formatCount(data.totalFolders)} folder(s) ranked · peak ${formatCount(data.maxLinks)} descendant links.</p>
        <table class="stats-table excel-table">
            <thead><tr><th class="stats-num sort-col" data-sort="rank" data-sort-group="folder">#${fmark('rank')}</th><th class="sort-col" data-sort="folder" data-sort-group="folder">Folder${fmark('folder')}</th><th class="stats-num sort-col" data-sort="links" data-sort-group="folder">Links${fmark('links')}</th><th>Bar</th><th class="stats-num sort-col" data-sort="folders" data-sort-group="folder">Folders${fmark('folders')}</th><th class="stats-num sort-col" data-sort="empty" data-sort-group="folder">Empty folders${fmark('empty')}</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </section>`;
}

// --- 4. Domain health ---
// seconds below 1e12, milliseconds above it, Firefox/Chrome microseconds above that.
function statsDateLastUsedMs(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n > 1e16) return Math.round(n / 1000) - 11644473600000;
    if (n > 1e14) return Math.round(n / 1000);
    if (n >= 1e12) return Math.round(n);
    return Math.round(n * 1000);
}

function statsParentDomainOf(uri) {
    const info = classifyLink(uri) || {};
    const parent = info.parent || 'unknown';
    return { rdnn: info.rdnn || parent || 'unknown', parent: parent || 'unknown' };
}

// Feature-detect the app's link-check / broken-link results by name. Nothing is
// assumed: an undeclared, uninitialised, or non-array global is skipped.
function statsLinkCheckProbe() {
    try {
        if (typeof linkCheckRows !== 'undefined' && Array.isArray(linkCheckRows)) return { source: 'linkCheckRows', rows: linkCheckRows };
    } catch (err) {}
    try {
        if (typeof linkCheckResults !== 'undefined' && Array.isArray(linkCheckResults)) return { source: 'linkCheckResults', rows: linkCheckResults };
    } catch (err) {}
    try {
        if (typeof brokenLinkRows !== 'undefined' && Array.isArray(brokenLinkRows)) return { source: 'brokenLinkRows', rows: brokenLinkRows };
    } catch (err) {}
    try {
        if (typeof brokenLinks !== 'undefined' && Array.isArray(brokenLinks)) return { source: 'brokenLinks', rows: brokenLinks };
    } catch (err) {}
    try {
        if (typeof brokenScanRows !== 'undefined' && Array.isArray(brokenScanRows)) return { source: 'brokenScanRows', rows: brokenScanRows };
    } catch (err) {}
    return { source: '', rows: [] };
}

function statsBrokenUriSet(probe) {
    const set = new Set();
    const kinds = ['dead', 'error', 'broken', 'unreachable', 'timeout'];
    ((probe && probe.rows) || []).forEach(row => {
        if (!row) return;
        const uri = statsNodeUri(row);
        if (!uri) return;
        const kind = String(row.kind || row.type || '').toLowerCase();
        if (kind && kinds.indexOf(kind) === -1) return;
        set.add(uri);
    });
    return set;
}

// Pure when a root is given; otherwise the loaded library. brokenRows is only for
// callers that already hold link-check rows.
function buildDomainHealthTable(root, brokenRows) {
    let tree = root;
    if (!tree) {
        try {
            if (typeof bookmarkData !== 'undefined' && bookmarkData) tree = bookmarkData;
        } catch (err) {}
    }
    const probe = Array.isArray(brokenRows) ? { source: 'provided', rows: brokenRows } : statsLinkCheckProbe();
    // A full walk of every bookmark, and the Domains tab repaints often: keep the model until the tree
    // revision or the link-check results change.
    const cacheKey = `${typeof statsDataRev === 'number' ? statsDataRev : 'x'}|${probe.source || ''}|${(probe.rows || []).length}`;
    if (lastDomainHealthModel && lastDomainHealthCacheKey === cacheKey) return lastDomainHealthModel;
    const broken = statsBrokenUriSet(probe);
    const nodes = [];
    statsWalkTree(tree, node => {
        if (statsNodeUri(node)) nodes.push(node);
    });
    const keyOf = uri => {
        if (typeof duplicateUrlKey === 'function') {
            try {
                return duplicateUrlKey(uri) || uri;
            } catch (err) {
                return uri;
            }
        }
        return uri;
    };
    const keyCounts = new Map();
    nodes.forEach(node => {
        const key = keyOf(statsNodeUri(node));
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    });
    const now = Date.now();
    const map = new Map();
    nodes.forEach(node => {
        const uri = statsNodeUri(node);
        const info = statsParentDomainOf(uri);
        const row = map.get(info.rdnn) || {
            rdnn: info.rdnn,
            parent: info.parent,
            total: 0,
            tracked: 0,
            duplicates: 0,
            broken: 0,
            neverUsed: 0,
            usedRecently: 0
        };
        row.total += 1;
        if (typeof stripTrackingParams === 'function') {
            try {
                if (stripTrackingParams(uri) !== uri) row.tracked += 1;
            } catch (err) {}
        }
        if ((keyCounts.get(keyOf(uri)) || 0) > 1) row.duplicates += 1;
        if (broken.has(uri)) row.broken += 1;
        const used = statsDateLastUsedMs(node.dateLastUsed);
        if (used == null || now - used > STATS_REPORT_YEAR_MS) row.neverUsed += 1;
        else row.usedRecently += 1;
        map.set(info.rdnn, row);
    });
    const rows = [...map.values()].map(row => ({
        ...row,
        trackedPct: row.total ? Math.round((row.tracked / row.total) * 1000) / 10 : 0,
        neverUsedPct: row.total ? Math.round((row.neverUsed / row.total) * 1000) / 10 : 0
    })).sort((a, b) => b.total - a.total || a.rdnn.localeCompare(b.rdnn));
    rows.forEach((row, index) => { row.rank = index + 1; });
    const model = {
        generatedAt: now,
        totalLinks: nodes.length,
        domains: rows.length,
        brokenSource: probe.source || '',
        brokenLinks: broken.size,
        rows
    };
    // Cached for the CSV and the merged view, which ask for it without rebuilding the walk.
    lastDomainHealthModel = model;
    lastDomainHealthCacheKey = cacheKey;
    return model;
}

function domainHealthCsv(model) {
    const data = model && Array.isArray(model.rows) ? model : lastDomainHealthModel;
    if (!data) return '';
    const lines = [];
    lines.push(csvLine(['Domain health', `${data.domains} domain(s), ${data.totalLinks} link(s)`]));
    if (data.brokenSource) lines.push(csvLine(['Broken-link source', data.brokenSource]));
    lines.push('');
    lines.push(csvLine(['Parent domain (RDNN)', 'Parent', 'Total links', 'Tracking params', 'Duplicate URLs', 'Broken links', 'Never used', 'Never used %']));
    data.rows.forEach(row => lines.push(csvLine([
        row.rdnn,
        row.parent,
        row.total,
        row.tracked,
        row.duplicates,
        row.broken,
        row.neverUsed,
        row.neverUsedPct
    ])));
    return lines.join('\n');
}

// Wires the reporting tables' clickable folder rows (paintStatistics calls this).
function bindReportSections(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('[data-folder-drill]').forEach(el => {
        el.addEventListener('click', event => {
            event.stopPropagation();
            const entry = lastFolderRankingModel && lastFolderRankingModel.rows[Number(el.dataset.folderDrill)];
            if (!entry || !entry.resolves) return;
            if (typeof openFolderDrilldown === 'function') openFolderDrilldown(entry.folder);
        });
    });
}

// The coordinator's entry point: show the Statistics view on one of the
// reporting (or any STATS_TABS) sub-views. Accepts a STATS_TABS id or one of the
// STATS_REPORT_CHILD_TABS data-child aliases, and marks a matching
// .child-tab-btn[data-child] inside #stats-view active when one exists.
function openStatisticsChildTab(childId) {
    const key = String(childId == null ? '' : childId).trim();
    const tabId = STATS_REPORT_CHILD_TABS[key] || key;
    activeStatsTab = tabId;
    if (typeof switchTabById === 'function') switchTabById('stats-view');
    else if (typeof switchTab === 'function') switchTab('stats-view');
    if (typeof document === 'undefined' || !document) return tabId;
    const body = document.getElementById('stats-body');
    if (body && typeof paintStatistics === 'function') paintStatistics();
    document.querySelectorAll('#stats-view .child-tab-btn[data-child]').forEach(btn => {
        const on = btn.dataset.child === key || btn.dataset.child === tabId;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    return tabId;
}
