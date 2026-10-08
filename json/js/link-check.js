const LINK_CHECK_TIMEOUT_MS = 12000;
const LINK_CHECK_CONCURRENCY = 6;
const LINK_CHECK_TITLE_BYTES = 262144;
let linkCheckRun = null;
let linkCheckRows = [];
let urlTitleRows = [];

function linkCheckAvailable() {
    if (typeof isLiveBookmarks === 'function' && isLiveBookmarks()) return true;
    alert('Link check fetches every page, which only the live add-on can do (it has cross-origin access). Open this library from the Firefox add-on.');
    return false;
}

function linkCheckScopeRoot() {
    const scope = document.getElementById('link-check-scope')?.value || 'folder';
    return scope === 'library' ? bookmarkData : (currentFolder || bookmarkData);
}

function linkCheckTargets(predicate) {
    const scope = linkCheckScopeRoot();
    const out = [];
    (function walk(node, parent, path, inScope) {
        if (!node) return;
        const here = inScope || node === scope;
        const uri = nodeUri(node);
        if (here && uri && /^https?:\/\//i.test(uri) && (!predicate || predicate(node, uri))) {
            out.push({ node, parent, uri, folderPath: displayFolderPath(path.join(' / ')) });
        }
        if (!node.children) return;
        const next = path.concat(displayFolderTitle(node));
        node.children.forEach(child => walk(child, node, next, here));
    })(bookmarkData, null, [], false);
    return out;
}

async function fetchWithTimeout(url, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LINK_CHECK_TIMEOUT_MS);
    const stop = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', stop);
    try {
        return { res: await fetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctrl.signal }), ctrl };
    } catch (err) {
        return { error: ctrl.signal.aborted && !(signal && signal.aborted) ? 'timeout' : 'unreachable', ctrl };
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', stop);
    }
}

async function runLinkPool(items, worker, onProgress) {
    let next = 0;
    let done = 0;
    const lane = async () => {
        while (next < items.length && linkCheckRun && !linkCheckRun.signal.aborted) {
            const item = items[next++];
            await worker(item);
            done += 1;
            onProgress(done, items.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(LINK_CHECK_CONCURRENCY, items.length) }, lane));
}

function startLinkCheckRun() {
    if (linkCheckRun) linkCheckRun.abort();
    linkCheckRun = new AbortController();
    return linkCheckRun;
}

function stopLinkCheck() {
    if (linkCheckRun) linkCheckRun.abort();
}

function linkCheckFolderCell(folderPath) {
    if (typeof folderChipsHtml === 'function') return folderChipsHtml(folderPath);
    return escapeHtml(folderPath || '—');
}

function linkStatusKind(status) {
    if (status === 'timeout' || status === 'unreachable') return 'dead';
    if (status === 404 || status === 410) return 'dead';
    if (status >= 400) return 'error';
    return 'ok';
}

async function checkDeadLinks() {
    if (!bookmarkData || !linkCheckAvailable()) return;
    const targets = linkCheckTargets();
    const box = document.getElementById('link-check-results');
    if (!targets.length) {
        box.innerHTML = '<p>No http(s) bookmarks in this scope.</p>';
        return;
    }
    const run = startLinkCheckRun();
    linkCheckRows = [];
    await runLinkPool(targets, async target => {
        const { res, error, ctrl } = await fetchWithTimeout(target.uri, run.signal);
        const status = res ? res.status : error;
        if (ctrl) ctrl.abort();
        const kind = linkStatusKind(status);
        if (kind !== 'ok') {
            linkCheckRows.push({ ...target, status, kind, checked: kind === 'dead' });
        }
    }, (done, total) => {
        box.innerHTML = `<p>Checked ${formatCount(done)} of ${formatCount(total)}… ${formatCount(linkCheckRows.length)} problem(s) so far.</p>`;
    });
    const stopped = run.signal.aborted;
    if (linkCheckRun === run) linkCheckRun = null;
    renderDeadLinks(stopped);
    logAffected('SYSTEM', 'Link check', `Fetched ${formatCount(targets.length)} bookmark URL(s)${stopped ? ' (stopped early)' : ''}. ${formatCount(linkCheckRows.filter(r => r.kind === 'dead').length)} dead (404/410, unreachable, or timed out) and ${formatCount(linkCheckRows.filter(r => r.kind === 'error').length)} other HTTP error(s). No bookmarks were changed.`, { source: 'Link check', scan: true });
}

function renderDeadLinks(stopped) {
    const box = document.getElementById('link-check-results');
    if (!box) return;
    if (!linkCheckRows.length) {
        box.innerHTML = `<p>${stopped ? 'Stopped. ' : ''}No dead links found.</p>`;
        updateDeadLinkButton();
        return;
    }
    const order = { dead: 0, error: 1 };
    linkCheckRows.sort((a, b) => order[a.kind] - order[b.kind]);
    box.innerHTML = `
        <p>${stopped ? 'Stopped early. ' : ''}${formatCount(linkCheckRows.length)} problem link(s). Dead ones are checked; other HTTP errors (403, 5xx) often mean the site blocks bots, so they start unchecked.</p>
        <table class="excel-table">
            <thead><tr><th></th><th>Status</th><th>Title</th><th>URL</th><th>Folder</th></tr></thead>
            <tbody>${linkCheckRows.map((row, i) => `<tr>
                <td><input type="checkbox" data-dead-index="${i}"${row.checked ? ' checked' : ''}></td>
                <td>${escapeHtml(String(row.status))}</td>
                <td>${escapeHtml(row.node.title || '')}</td>
                <td><a href="${escapeHtml(row.uri)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.uri)}</a></td>
                <td>${linkCheckFolderCell(row.folderPath)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    if (typeof bindFolderChips === 'function') bindFolderChips(box);
    box.querySelectorAll('input[data-dead-index]').forEach(input => {
        input.addEventListener('change', () => {
            const row = linkCheckRows[Number(input.dataset.deadIndex)];
            if (row) row.checked = input.checked;
            updateDeadLinkButton();
        });
    });
    updateDeadLinkButton();
}

function updateDeadLinkButton() {
    const btn = document.getElementById('link-check-delete');
    if (!btn) return;
    const count = linkCheckRows.filter(row => row.checked).length;
    btn.disabled = !count;
    btn.textContent = count ? `Delete selected (${formatCount(count)})` : 'Delete selected';
}

function deleteDeadLinks() {
    const picked = linkCheckRows.filter(row => row.checked);
    if (!picked.length) return;
    if (!confirm(`Delete ${formatCount(picked.length)} bookmark(s)? Undo can restore them.`)) return;
    withUndo('Delete dead links', api => {
        picked.forEach(row => {
            api.remove(row.node, row.parent);
            logAffected('DELETED', row.node.title, `Dead link (${row.status}).`, {
                source: 'Link check', node: row.node, parent: row.parent, uri: row.uri
            });
        });
    });
    linkCheckRows = linkCheckRows.filter(row => !row.checked);
    markChanged();
    renderSidebar();
    if (currentFolder) renderFolderContents(currentFolder);
    renderDeadLinks(false);
}

function linkCheckTargetFor(node) {
    let found = null;
    walkBookmarkTree(bookmarkData, (item, parent, path) => {
        if (!found && item === node) found = { node, parent, uri: nodeUri(node), folderPath: displayFolderPath(path.join(' / ')) };
    });
    return found;
}

async function checkSingleLink(node) {
    if (!bookmarkData || !node || !linkCheckAvailable()) return;
    const uri = nodeUri(node);
    if (!/^https?:\/\//i.test(uri || '')) return alert('Only http(s) bookmarks can be checked.');
    const target = linkCheckTargetFor(node) || { node, parent: null, uri, folderPath: '' };
    switchTab('actions-view', document.querySelector('.tab-btn[data-view="actions-view"]'));
    switchChildTab('link-check-actions', document.querySelector('.child-tab-btn[data-child="link-check-actions"]'));
    const deadBox = document.getElementById('link-check-results');
    const titleBox = document.getElementById('url-title-results');
    clearBulkPlan('url-titles');
    if (deadBox) deadBox.innerHTML = `<p>Checking ${escapeHtml(uri)}…</p>`;
    if (titleBox) titleBox.innerHTML = '<p>Fetching the page title…</p>';
    const run = startLinkCheckRun();
    const { res, error, ctrl } = await fetchWithTimeout(uri, run.signal);
    const status = res ? res.status : error;
    if (ctrl) ctrl.abort();
    const kind = linkStatusKind(status);
    linkCheckRows = kind === 'ok' ? [] : [{ ...target, status, kind, checked: kind === 'dead' }];
    if (kind === 'ok') {
        if (deadBox) deadBox.innerHTML = `<p>${escapeHtml(node.title || uri)} is reachable (HTTP ${escapeHtml(String(status))}).</p>`;
        updateDeadLinkButton();
    } else {
        renderDeadLinks(run.signal.aborted);
    }
    const query = googleQueryTitle(uri);
    const fetched = run.signal.aborted ? '' : (query || await fetchPageTitle(uri, run.signal));
    const next = fetched && (query || !isGenericPageTitle(fetched)) ? titleForObsidian(fetched, uri) : '';
    urlTitleRows = [{ ...target, next, checked: Boolean(next && next !== node.title && titleIsUrl(node, uri)) }];
    const stopped = run.signal.aborted;
    if (linkCheckRun === run) linkCheckRun = null;
    renderUrlTitles(stopped);
    if (titleBox && next) titleBox.insertAdjacentHTML('afterbegin', `<p>${next === node.title ? 'The page title matches this bookmark.' : 'The page title differs from this bookmark. Check the row to rename it.'}</p>`);
    logAffected('SYSTEM', node.title || uri, `Checked one bookmark: HTTP ${status}${kind === 'ok' ? '' : ` (${kind})`}; page title ${next ? `“${next}”` : 'not found'}. No bookmarks were changed.`, { source: 'Link check', scan: true, node, uri });
}

function titleIsUrl(node, uri) {
    const title = String(node.title || '').trim();
    if (!title) return true;
    if (title === uri) return true;
    const asUrl = /^https?:\/\//i.test(title) || /^www\./i.test(title);
    return asUrl && bookmarkUrlKey(title.startsWith('www.') ? `https://${title}` : title) === bookmarkUrlKey(uri);
}

function youTubeOembedUrl(uri) {
    const watch = urlForObsidian(uri);
    if (!isYouTubeWatchObsidianUrl(watch)) return '';
    return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`;
}

async function readTitleFromResponse(res) {
    if (!res.body || !res.body.getReader) {
        const text = await res.text();
        return titleFromHtml(text);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < LINK_CHECK_TITLE_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (/<\/title>/i.test(html)) break;
    }
    try { reader.cancel(); } catch (err) {}
    return titleFromHtml(html);
}

const GENERIC_PAGE_TITLES = new Set([
    'google search', 'google', 'reddit', 'reddit - dive into anything', 'reddit - the heart of the internet',
    'youtube', 'before you continue', 'before you continue to google', 'before you continue to youtube',
    'just a moment...', 'just a moment', 'attention required! | cloudflare', 'access denied', 'forbidden',
    '403 forbidden', '404 not found', 'not found', 'page not found', 'error', 'sign in', 'log in', 'login'
]);

function isGenericPageTitle(title) {
    const text = String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!text) return true;
    if (GENERIC_PAGE_TITLES.has(text)) return true;
    const base = text.replace(/\s*[-–|:]\s*(google search|google|reddit|youtube)$/, '').trim();
    return GENERIC_PAGE_TITLES.has(base);
}

function titleFromHtml(html) {
    const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const tag = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const raw = (tag && tag[1]) || (og && og[1]) || '';
    return decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim();
}

function googleQueryTitle(uri) {
    try {
        const u = new URL(uri);
        const search = googleUrlForObsidian(u, u.hostname.toLowerCase().replace(/^www\./, ''));
        if (!isGoogleSearchObsidianUrl(search)) return '';
        return new URL(search).searchParams.get('q').replace(/\s+/g, ' ').trim();
    } catch (err) {
        return '';
    }
}

async function fetchPageTitle(uri, signal) {
    const oembed = youTubeOembedUrl(uri);
    if (oembed) {
        const { res } = await fetchWithTimeout(oembed, signal);
        if (res && res.ok) {
            try {
                const data = await res.json();
                if (data && data.title) return String(data.title).trim();
            } catch (err) {}
        }
    }
    const { res } = await fetchWithTimeout(uri, signal);
    if (!res || !res.ok) return '';
    const type = res.headers.get('content-type') || '';
    if (type && !/html/i.test(type)) return '';
    return readTitleFromResponse(res);
}

async function fetchUrlTitles() {
    if (!bookmarkData || !linkCheckAvailable()) return;
    const targets = linkCheckTargets(titleIsUrl);
    const box = document.getElementById('url-title-results');
    clearBulkPlan('url-titles');
    if (!targets.length) {
        box.innerHTML = '<p>No bookmarks in this scope have an empty or URL-only title.</p>';
        return;
    }
    const run = startLinkCheckRun();
    urlTitleRows = [];
    await runLinkPool(targets, async target => {
        const query = googleQueryTitle(target.uri);
        const fetched = query || await fetchPageTitle(target.uri, run.signal);
        const next = fetched && (query || !isGenericPageTitle(fetched)) ? titleForObsidian(fetched, target.uri) : '';
        const found = Boolean(next && next !== target.node.title);
        urlTitleRows.push({ ...target, next: found ? next : '', checked: found });
    }, (done, total) => {
        const found = urlTitleRows.filter(row => row.next).length;
        box.innerHTML = `<p>Fetched ${formatCount(done)} of ${formatCount(total)}… ${formatCount(found)} title(s) found.</p>`;
    });
    const stopped = run.signal.aborted;
    if (linkCheckRun === run) linkCheckRun = null;
    urlTitleRows.sort((a, b) => Number(Boolean(b.next)) - Number(Boolean(a.next)));
    renderUrlTitles(stopped);
    const found = urlTitleRows.filter(row => row.next).length;
    logAffected('SYSTEM', 'URL-only titles', `Fetched page titles for ${formatCount(targets.length)} bookmark(s) whose title was empty or the URL${stopped ? ' (stopped early)' : ''}. ${formatCount(found)} new title(s) ready; nothing was changed yet.`, { source: 'Link check', scan: true });
}

function renderUrlTitles(stopped) {
    const box = document.getElementById('url-title-results');
    if (!box) return;
    const found = urlTitleRows.filter(row => row.next).length;
    const misses = urlTitleRows.length - found;
    if (!urlTitleRows.length) {
        box.innerHTML = `<p>${stopped ? 'Stopped. ' : ''}Nothing fetched.</p>`;
        updateUrlTitlePlan();
        return;
    }
    box.innerHTML = `
        <p>${stopped ? 'Stopped early. ' : ''}${formatCount(found)} title(s) found; ${formatCount(misses)} page(s) gave none. Rename applies to checked rows only.</p>
        <table class="excel-table">
            <thead><tr><th></th><th>Before</th><th>After</th><th>Folder</th></tr></thead>
            <tbody>${urlTitleRows.map((row, i) => `<tr>
                <td><input type="checkbox" data-title-index="${i}"${row.checked ? ' checked' : ''}${row.next ? '' : ' disabled'}></td>
                <td>${escapeHtml(row.node.title || '(empty)')}<div class="href">${escapeHtml(row.uri)}</div></td>
                <td><input type="text" class="url-title-input" data-title-edit="${i}" value="${escapeHtml(row.next)}" placeholder="No title found — type one" style="width:100%;min-width:16em;box-sizing:border-box"></td>
                <td>${linkCheckFolderCell(row.folderPath)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    if (typeof bindFolderChips === 'function') bindFolderChips(box);
    box.querySelectorAll('input[data-title-index]').forEach(input => {
        input.addEventListener('change', () => {
            const row = urlTitleRows[Number(input.dataset.titleIndex)];
            if (row) row.checked = input.checked;
            updateUrlTitlePlan();
        });
    });
    box.querySelectorAll('input[data-title-edit]').forEach(input => {
        input.addEventListener('input', () => {
            const index = input.dataset.titleEdit;
            const row = urlTitleRows[Number(index)];
            if (!row) return;
            const value = input.value.trim();
            const usable = Boolean(value && value !== row.node.title);
            row.next = value;
            row.checked = usable;
            const check = box.querySelector(`input[data-title-index="${index}"]`);
            if (check) {
                check.disabled = !usable;
                check.checked = usable;
            }
            updateUrlTitlePlan();
        });
    });
    updateUrlTitlePlan();
}

function updateUrlTitlePlan() {
    const count = urlTitleRows.filter(row => row.checked && row.next).length;
    if (count) setBulkPlan('url-titles', { count, label: 'Fetched page titles', apply: applyUrlTitles });
    else clearBulkPlan('url-titles');
}

function applyUrlTitles() {
    const rows = urlTitleRows.filter(row => row.checked && row.next);
    withUndo('Fetched page titles', api => {
        rows.forEach(row => {
            const oldTitle = row.node.title;
            api.set(row.node, 'title', row.next);
            logAffected('REPAIR', row.next, 'Replaced URL-only title with the fetched page title.', {
                source: 'Link check', node: row.node, oldTitle, newTitle: row.next, uri: row.uri
            });
        });
    });
    urlTitleRows = urlTitleRows.filter(row => !rows.includes(row));
    markChanged();
    renderSidebar();
    if (currentFolder) renderFolderContents(currentFolder);
    renderUrlTitles(false);
    const box = document.getElementById('url-title-results');
    if (box) box.insertAdjacentHTML('afterbegin', `<p>Renamed ${formatCount(rows.length)} bookmark(s).</p>`);
}
