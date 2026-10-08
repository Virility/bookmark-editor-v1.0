// Shared primitives for json/ and live/ copies. No modules — classic globals.
const SEARCH_CHAIN_GAP_MS = 120000;
const APP_TABS = [
    { id: 'bookmarks-view', label: 'Bookmarks' },
    { id: 'stats-view', label: 'Statistics' },
    { id: 'actions-view', label: 'Actions' },
    { id: 'affected-view', label: 'Affected Log' },
    { id: 'settings-view', label: 'Settings' },
    { id: 'docs-view', label: 'Documentation' }
];
const POPUP_MENU_IDS = [
    'context-menu',
    'folder-chip-menu',
    'folder-tree-menu',
    'library-background-menu',
    'location-context-menu',
    'open-tabs-menu'
];
const EPOCH_DAY_MS = Date.UTC(1970, 0, 2);
const NETSCAPE_ADD_DATE_MAX = 1e11;
const SPECIAL_FOLDER_GUIDS = {
    'toolbar_____': 'Bookmarks Toolbar',
    'unfiled_____': 'Other Bookmarks',
    'menu________': 'Bookmarks Menu',
    'mobile______': 'Mobile Bookmarks',
    'tags________': 'Tags',
    'root________': 'Root'
};
const SEARCH_ENGINE_HOST_RE = /google\.|bing\.com|duckduckgo\.com|yahoo\.com|startpage\.com/i;

function getBrowserExt() {
    if (typeof browser !== 'undefined') return browser;
    if (typeof chrome !== 'undefined') return chrome;
    return null;
}

const AUTO_MOVE_HOURS_MIN = 0.25;
const AUTO_MOVE_HOURS_MAX = 168;
const AUTO_MOVE_HOURS_DEFAULT = 1;
const AUTO_MOVE_ALARM = 'auto-move-to-other';
const AUTO_MOVE_STORAGE_KEY = 'editorAutoMove';
const CAPTURE_STORAGE_KEY = 'editorCapture';
const CAPTURE_PREF_DEFAULTS = {
    youtubeTitleSuffix: true,
    googleTitleSuffix: true,
    cleanSentUrls: true,
    stripRedditChrome: true,
    obsidianNotePath: '',
    obsidianInsert: 'after',
    obsidianFallback: 'notice',
    startupFolder: 'toolbar',
    hideRootFolder: true
};
let capturePrefs = { ...CAPTURE_PREF_DEFAULTS };

function capturePrefsFrom(settings) {
    const src = settings || {};
    const flag = (key) => src[key] !== false && src[key] !== 'false' && src[key] !== 0 && src[key] !== '0';
    let path = String(src.obsidianNotePath || '').replace(/\\/g, '/').replace(/^\s+|\s+$/g, '').replace(/^\/+/, '');
    if (path.length > 180 || path.split('/').some(part => part === '..' || part === '.')) path = '';
    const startup = src.startupFolder === 'root' ? 'root' : 'toolbar';
    return {
        youtubeTitleSuffix: flag('youtubeTitleSuffix'),
        googleTitleSuffix: flag('googleTitleSuffix'),
        cleanSentUrls: flag('cleanSentUrls'),
        stripRedditChrome: flag('stripRedditChrome'),
        obsidianNotePath: path,
        // 'after' keeps the payload at the line's level, 'under' nests it one level beneath.
        obsidianInsert: String(src.obsidianInsert || '').toLowerCase() === 'under' ? 'under' : 'after',
        // What the plugin should do when no editor is open: report it, or fall back to the daily note.
        obsidianFallback: String(src.obsidianFallback || '').toLowerCase() === 'daily' ? 'daily' : 'notice',

        startupFolder: startup,
        hideRootFolder: flag('hideRootFolder')
    };
}

function applyCapturePrefs(settings) {
    capturePrefs = capturePrefsFrom(settings || CAPTURE_PREF_DEFAULTS);
    return capturePrefs;
}

function refreshCapturePrefs() {
    const ext = getBrowserExt();
    if (!ext || !ext.storage || !ext.storage.local || typeof ext.storage.local.get !== 'function') {
        return Promise.resolve(capturePrefs);
    }
    let got;
    try {
        got = ext.storage.local.get(CAPTURE_STORAGE_KEY);
    } catch (e) {
        return Promise.resolve(capturePrefs);
    }
    const finish = (data) => {
        const stored = data && data[CAPTURE_STORAGE_KEY];
        if (stored) applyCapturePrefs(stored);
        return capturePrefs;
    };
    if (got && typeof got.then === 'function') return got.then(finish).catch(() => capturePrefs);
    return new Promise(resolve => {
        ext.storage.local.get(CAPTURE_STORAGE_KEY, data => resolve(finish(data)));
    });
}

function clampAutoMoveHours(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return AUTO_MOVE_HOURS_DEFAULT;
    // Snap to quarter hours, so a stray value lands on one of the offered divisions.
    return Math.max(AUTO_MOVE_HOURS_MIN, Math.min(AUTO_MOVE_HOURS_MAX, Math.round(n * 4) / 4));
}

function autoMoveSettingsFrom(raw) {
    const s = raw || {};
    return {
        autoMoveToolbarLinks: s.autoMoveToolbarLinks !== false && s.autoMoveToolbarLinks !== 'false',
        autoMoveMobile: s.autoMoveMobile !== false && s.autoMoveMobile !== 'false',
        autoMoveHours: clampAutoMoveHours(s.autoMoveHours),
        autoMoveLastAt: Number(s.autoMoveLastAt) || 0
    };
}

function autoMoveEnabled(settings) {
    return Boolean(settings && (settings.autoMoveToolbarLinks || settings.autoMoveMobile));
}

function nodeUri(node) {
    if (!node) return '';
    return node.uri || node.url || '';
}

function isBookmarkLinkNode(node) {
    if (!node || node.type === 'separator') return false;
    return Boolean(nodeUri(node) || node.typeCode === 1 || node.type === 'url' || node.type === 'bookmark');
}

function isBookmarkFolderNode(node) {
    if (!node || node.type === 'separator') return false;
    if (nodeUri(node) || node.typeCode === 1 || node.type === 'bookmark' || node.type === 'url') return false;
    return node.typeCode === 2 || Boolean(node.children) || node.type === 'folder';
}

function displayFolderPath(path) {
    const parts = String(path || '').split(' / ').filter(Boolean);
    const rootTitle = (typeof bookmarkData !== 'undefined' && bookmarkData) ? displayFolderTitle(bookmarkData, 'Root') : 'Root';
    if (capturePrefs.hideRootFolder !== false && parts[0] === rootTitle) parts.shift();
    return parts.join(' / ');
}

function walkBookmarkTree(root, visit) {
    (function walk(node, parent, path) {
        if (!node) return;
        visit(node, parent, path);
        if (!node.children) return;
        const next = path.concat(displayFolderTitle(node));
        node.children.forEach(child => walk(child, node, next));
    })(root, null, []);
}

function findBookmarkNodeById(root, id) {
    const key = String(id || '');
    if (!key || !root) return null;
    let found = null;
    walkBookmarkTree(root, node => {
        if (!found && String(node.id) === key) found = node;
    });
    return found;
}

// --- Netscape Bookmark File Format export ---
// The file every browser reads on "Import Bookmarks from HTML". Times are Unix seconds,
// folders are <H3> + a nested <DL>, links are <A HREF>, separators are <HR>, and the
// indentation is the four spaces per level Firefox writes.
const NETSCAPE_DOCTYPE = '<!DOCTYPE NETSCAPE-Bookmark-file-1>';
const NETSCAPE_EPOCH_FALLBACK = Math.floor(Date.now() / 1000);

function netscapeSeconds(value) {
    if (!value) return NETSCAPE_EPOCH_FALLBACK;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms)) return NETSCAPE_EPOCH_FALLBACK;
    // The tree mixes seconds (Firefox's dateAdded) and milliseconds (live writes, JSON).
    return Math.floor(ms > 1e12 ? ms / 1000 : ms);
}

function netscapeEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Every entry carries both dates. Firefox reports lastModified for bookmarks and folders;
// where a tree has none (Chrome, or a JSON saved before this) the modification time falls
// back to the creation time — which is what Firefox itself holds for an item that has not
// been edited since it was created — so no entry loses the attribute on import.
function netscapeModified(node, fallback) {
    const raw = node && (node.lastModified || node.dateGroupModified || node.dateModified);
    if (raw) return netscapeSeconds(raw);
    return netscapeSeconds(fallback || (node && node.dateAdded));
}

function netscapeNodeIcon(node) {
    const raw = node && (node.iconUri || node.icon || node.favIconUrl);
    if (typeof raw === 'string' && /^data:image\//i.test(raw)) return raw;
    return '';
}

function netscapeLine(level, text) {
    return '    '.repeat(level) + text;
}

function netscapeChildrenHtml(folder, level) {
    const lines = [];
    (folder && folder.children ? folder.children : []).forEach(child => {
        if (!child) return;
        if (child.type === 'separator') {
            lines.push(netscapeLine(level, '<DT><HR>'));
            return;
        }
        const uri = nodeUri(child);
        if (uri) {
            const icon = netscapeNodeIcon(child);
            const attrs = [
                `HREF="${netscapeEscape(uri)}"`,
                `ADD_DATE="${netscapeSeconds(child.dateAdded)}"`,
                `LAST_MODIFIED="${netscapeModified(child, child.dateAdded)}"`
            ];
            if (icon) attrs.push(`ICON="${netscapeEscape(icon)}"`);
            lines.push(netscapeLine(level, `<DT><A ${attrs.join(' ')}>${netscapeEscape(child.title || uri)}</A>`));
            if (child.description) lines.push(netscapeLine(level, `<DD>${netscapeEscape(child.description)}`));
            return;
        }
        if (!isBookmarkFolderNode(child)) return;
        const folderAttrs = [
            `ADD_DATE="${netscapeSeconds(child.dateAdded)}"`,
            `LAST_MODIFIED="${netscapeModified(child, child.dateAdded)}"`
        ];
        lines.push(netscapeLine(level, `<DT><H3 ${folderAttrs.join(' ')}>${netscapeEscape(displayFolderTitle(child) || child.title || 'Folder')}</H3>`));
        // Always the folder's own list, empty or not, so every <H3> is unambiguously
        // followed by the <DL> that holds its contents and a reader can never attach the
        // next sibling to an empty folder.
        lines.push(netscapeLine(level, '<DL><p>'));
        const inner = netscapeChildrenHtml(child, level + 1);
        if (inner) lines.push(inner);
        lines.push(netscapeLine(level, '</DL><p>'));
    });
    return lines.join('\n');
}

// The whole folder as one Netscape file: the folder itself is the single entry in the
// root list, so importing this file recreates the folder with everything inside it.
function netscapeBookmarkHtml(folder, options = {}) {
    const title = options.title || (folder && (displayFolderTitle(folder) || folder.title)) || 'Bookmarks';
    const folderAttrs = [
        `ADD_DATE="${netscapeSeconds(folder && folder.dateAdded)}"`,
        `LAST_MODIFIED="${netscapeModified(folder, folder && folder.dateAdded)}"`
    ];
    const body = [];
    // wrap: false is the whole-library shape Firefox itself writes — the root folders sit
    // directly in the top list instead of gaining a wrapper folder named after the library.
    if (options.wrap === false) {
        const flat = netscapeChildrenHtml(folder, 1);
        if (flat) body.push(flat);
    } else {
        body.push(netscapeLine(1, `<DT><H3 ${folderAttrs.join(' ')}>${netscapeEscape(title)}</H3>`));
        body.push(netscapeLine(1, '<DL><p>'));
        const inner = netscapeChildrenHtml(folder, 2);
        if (inner) body.push(inner);
        body.push(netscapeLine(1, '</DL><p>'));
    }
    return [
        NETSCAPE_DOCTYPE,
        '<!-- This is an automatically generated file.',
        '     It will be read and overwritten.',
        '     DO NOT EDIT! -->',
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        `<TITLE>${netscapeEscape(title)}</TITLE>`,
        `<H1>${netscapeEscape(title)}</H1>`,
        '<DL><p>',
        body.join('\n'),
        '</DL><p>',
        ''
    ].join('\n');
}

// --- Netscape Bookmark File Format import ---
function unescapeHtmlText(value) {
    return String(value == null ? '' : value)
        .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function netscapeAttr(tag, name) {
    const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
    if (quoted) return unescapeHtmlText(quoted[1]);
    const bare = new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag);
    return bare ? unescapeHtmlText(bare[1]) : '';
}

// The file stores Unix seconds; the tree uses milliseconds.
function netscapeDate(value) {
    const n = Number(String(value || '').trim());
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n > 1e12 ? n : n * 1000;
}

// Walks the <DT>/<H3>/<DL>/<A>/<DD>/<HR> stream the format is made of and rebuilds the tree.
// A <DL> with no folder above it keeps the current depth so its </DL> stays balanced, and
// separators are skipped because the bookmarks API cannot create them everywhere.
function parseNetscapeBookmarks(text) {
    const source = String(text || '');
    const titleMatch = /<TITLE>([\s\S]*?)<\/TITLE>/i.exec(source);
    const fileTitle = titleMatch ? unescapeHtmlText(titleMatch[1]).trim() : '';
    const tokenRe = /<DT>\s*<H3\b([^>]*)>([\s\S]*?)<\/H3>|<DT>\s*<A\b([^>]*)>([\s\S]*?)<\/A>|<DD>([^\n<]*)|<HR\b[^>]*>|<DL\b[^>]*>|<\/DL>/gi;
    const root = { typeCode: 2, title: fileTitle || 'Imported bookmarks', children: [] };
    const stack = [root];
    let pending = null;
    let lastLink = null;
    let token;
    while ((token = tokenRe.exec(source))) {
        const h3attrs = token[1];
        const aattrs = token[3];
        if (h3attrs !== undefined) {
            const node = {
                typeCode: 2,
                title: unescapeHtmlText(token[2]).trim() || 'Folder',
                children: [],
                dateAdded: netscapeDate(netscapeAttr(h3attrs, 'ADD_DATE'))
            };
            const modified = netscapeDate(netscapeAttr(h3attrs, 'LAST_MODIFIED'));
            if (modified) node.lastModified = modified;
            stack[stack.length - 1].children.push(node);
            pending = node;
            lastLink = null;
            continue;
        }
        if (aattrs !== undefined) {
            const uri = netscapeAttr(aattrs, 'HREF');
            if (!uri) continue;
            const node = {
                typeCode: 1,
                title: unescapeHtmlText(token[4]).trim() || uri,
                uri,
                dateAdded: netscapeDate(netscapeAttr(aattrs, 'ADD_DATE'))
            };
            const modified = netscapeDate(netscapeAttr(aattrs, 'LAST_MODIFIED'));
            if (modified) node.lastModified = modified;
            const icon = netscapeAttr(aattrs, 'ICON');
            if (/^data:image\//i.test(icon)) node.iconUri = icon;
            stack[stack.length - 1].children.push(node);
            lastLink = node;
            pending = null;
            continue;
        }
        if (token[5] !== undefined) {
            const description = unescapeHtmlText(token[5]).trim();
            if (description && lastLink) lastLink.description = description;
            continue;
        }
        if (/^<HR/i.test(token[0])) continue;
        if (/^<DL/i.test(token[0])) {
            stack.push(pending || stack[stack.length - 1]);
            pending = null;
            continue;
        }
        if (stack.length > 1) stack.pop();
        pending = null;
        lastLink = null;
    }
    return { title: root.title, entries: root.children };
}

function netscapeBookmarkFileName(title) {
    const cleaned = String(title || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .slice(0, 80)
        .trim();
    return `${cleaned || 'bookmarks'}.html`;
}

// Saves text as a file from either build. Blob first (keeps large exports off the URL),
// data: as the fallback, which is the trick the JSON export already used.
function downloadTextFile(filename, text, mime = 'text/plain') {
    const anchor = document.createElement('a');
    anchor.setAttribute('download', filename);
    if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
        anchor.setAttribute('href', url);
        anchor.click();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) {} }, 0);
        return true;
    }
    anchor.setAttribute('href', `data:${mime};charset=utf-8,${encodeURIComponent(text)}`);
    anchor.click();
    return true;
}

// Copies text, preferring the async clipboard and falling back to a temporary textarea,
// the same two steps the library's Copy link already used. Resolves true when it landed.
function copyTextToClipboard(text) {
    const value = String(text == null ? '' : text);
    if (!value) return Promise.resolve(false);
    const write = (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(value)
        : Promise.reject(new Error('no async clipboard'));
    return Promise.resolve(write).then(() => true).catch(() => {
        try {
            const area = document.createElement('textarea');
            area.value = value;
            area.setAttribute('readonly', 'readonly');
            area.style.position = 'fixed';
            area.style.top = '-1000px';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
            return true;
        } catch (err) {
            return false;
        }
    });
}

function countTree(root) {
    let links = 0, folders = 0;
    walkBookmarkTree(root, node => {
        if (nodeUri(node) || node.type === 'url') links++;
        if (node.children || node.typeCode === 2 || node.type === 'folder') folders++;
    });
    return { links, folders };
}

function folderMatchesSpecial(node, guid) {
    if (!node || !guid) return false;
    if (node.guid === guid) return true;
    const expected = SPECIAL_FOLDER_GUIDS[guid];
    if (!expected) return false;
    return displayFolderTitle(node).toLowerCase() === expected.toLowerCase();
}

function findSpecialFolder(guid) {
    let found = null;
    walkBookmarkTree(bookmarkData, node => {
        if (!found && isBookmarkFolderNode(node) && folderMatchesSpecial(node, guid)) found = node;
    });
    return found;
}

function placePopupMenu(menu, clientX, clientY) {
    if (!menu) return;
    const pad = 8;
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
    menu.style.display = 'block';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    let left = clientX;
    let top = clientY;
    if (left + width > viewW - pad) left = viewW - pad - width;
    if (left < pad) left = pad;
    if (top + height > viewH - pad) top = clientY - height;
    if (top < pad) top = pad;
    if (top + height > viewH - pad) {
        menu.style.maxHeight = `${Math.max(80, viewH - 2 * pad)}px`;
        menu.style.overflowY = 'auto';
        top = pad;
    }
    menu.style.left = `${left + window.scrollX}px`;
    menu.style.top = `${top + window.scrollY}px`;
}

function displayFolderTitle(node, fallback = 'Root') {
    if (!node) return fallback;
    const guid = node.guid || '';
    if (SPECIAL_FOLDER_GUIDS[guid]) return SPECIAL_FOLDER_GUIDS[guid];
    const raw = String(node.title || node.name || '').trim();
    const aliases = {
        unfiled: 'Other Bookmarks',
        toolbar: 'Bookmarks Toolbar',
        'bookmarks toolbar': 'Bookmarks Toolbar',
        'bookmarks bar': 'Bookmarks Toolbar',
        'bookmark bar': 'Bookmarks Toolbar',
        'other bookmarks': 'Other Bookmarks',
        'unsorted bookmarks': 'Other Bookmarks'
    };
    if (!raw) return fallback;
    return aliases[raw.toLowerCase()] || raw;
}

function parseToolbarSubredditSpec(title) {
    const raw = String(title || '').trim();
    const match = raw.match(/^(.+?)\s+-\s+(.+)$/);
    if (!match) return null;
    const description = match[1].trim();
    const subs = match[2].trim().split(/\s+/).map(token => token.replace(/^\/?r\//i, '')).filter(token => /^[A-Za-z0-9_]{2,21}$/.test(token));
    if (!description || !subs.length) return null;
    return { description, subs };
}

function subredditFolderView(title) {
    const full = String(title || '');
    const spec = parseToolbarSubredditSpec(full);
    return {
        full,
        spec,
        label: spec ? spec.description : full,
        markHtml: spec ? '<span class="subreddit-mark">/r</span>' : ''
    };
}

function isRedditHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it';
}

function isRedditPageUrl(uri) {
    try {
        return isRedditHost(new URL(uri).hostname);
    } catch (e) {
        return false;
    }
}

function redditActionCompact(text) {
    return String(text || '').replace(/[\s\u00a0]+/g, '').toLowerCase();
}

function isRedditActionChrome(text) {
    const compact = redditActionCompact(text);
    if (compact.indexOf('permalink') === -1) return false;
    return /^(permalink|embed|save|parent|report|reply|edit|delete|distinguish|share|copy|follow|giveaward|award)+$/.test(compact);
}

function isRedditAuthorChrome(text) {
    return /^\[(?:[+\-\u2013\u2014]|−)\]\s*[A-Za-z0-9_\-]{2,20}\b/.test(String(text || '').trim());
}

function isRedditScoreChrome(text) {
    const trimmed = String(text || '').trim();
    if (/^\[score hidden\]/i.test(trimmed)) return true;
    if (/^comment score below threshold/i.test(trimmed)) return true;
    return /^\d[\d,.]*[kKmMbB]?\s+points?\b/i.test(trimmed) && /\b(ago|just now)\b/i.test(trimmed);
}

function isRedditChromeLine(line) {
    const trimmed = String(line || '').replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
    if (!trimmed) return false;
    return isRedditActionChrome(trimmed) || isRedditAuthorChrome(trimmed) || isRedditScoreChrome(trimmed);
}

function stripRedditChromeFromLine(line) {
    let rest = String(line || '');
    rest = rest.replace(/\bpermalink(?:[\s\u00a0]*(?:embed|save|parent|report|reply|edit|delete|distinguish|share|copy|follow|give[\s\u00a0]*award|award))+\b/gi, '');
    rest = rest.replace(/\[(?:[+\-\u2013\u2014]|−)\]\s*[A-Za-z0-9_\-]{2,20}\b/g, '');
    rest = rest.replace(/\b\d[\d,.]*[kKmMbB]?\s+points?\b(?:[\s\u00a0]*\u00b7)?[\s\u00a0]*(?:\d+[\s\u00a0]+(?:years?|yrs?\.?|months?|mos?\.?|weeks?|wks?\.?|days?|hours?|hrs?\.?|minutes?|mins?\.?|seconds?|secs?\.?)[\s\u00a0]+ago|just[\s\u00a0]+now)/gi, '');
    rest = rest.replace(/\[score hidden\]/gi, '');
    rest = rest.replace(/comment score below threshold/gi, '');
    return rest;
}

function stripRedditCommentChrome(text) {
    const raw = String(text || '');
    if (!raw) return '';
    if (capturePrefs.stripRedditChrome === false) return raw;
    const kept = [];
    raw.split(/\r?\n/).forEach(line => {
        if (isRedditChromeLine(line)) return;
        const cleaned = stripRedditChromeFromLine(line);
        if (isRedditChromeLine(cleaned) || (/^[\s\u00a0]*$/.test(cleaned) && !/^[\s\u00a0]*$/.test(line))) return;
        kept.push(/^[\s\u00a0]*$/.test(cleaned) ? '' : cleaned);
    });
    const out = [];
    let blank = 0;
    kept.forEach(line => {
        if (/^[\s\u00a0]*$/.test(line)) {
            blank += 1;
            if (blank === 1) out.push('');
            return;
        }
        blank = 0;
        out.push(line);
    });
    while (out.length && /^[\s\u00a0]*$/.test(out[0])) out.shift();
    while (out.length && /^[\s\u00a0]*$/.test(out[out.length - 1])) out.pop();
    return out.join('\n');
}

function redditSubredditFromUri(uri) {
    let url;
    try { url = new URL(uri); } catch (e) { return ''; }
    if (!isRedditHost(url.hostname)) return '';
    const match = decodeURIComponent(url.pathname || '').match(/\/r\/([^/]+)/i);
    return match ? match[1] : '';
}

function countSubredditLinksInFolder(folder, subs) {
    const counts = new Map((subs || []).map(sub => [String(sub).toLowerCase(), 0]));
    walkBookmarkTree(folder, (node, parent) => {
        if (!parent || isBookmarkFolderNode(node)) return;
        const key = redditSubredditFromUri(nodeUri(node)).toLowerCase();
        if (key && counts.has(key)) counts.set(key, counts.get(key) + 1);
    });
    return counts;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function formatCount(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '0';
    return Math.round(x).toLocaleString('en-US');
}

function parseBookmarkDateMs(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) return 0;
    const chromeOffsetMs = 11644473600000;
    if (n > 1e16) return Math.round(n / 1000 - chromeOffsetMs);
    if (n > 1e14) return Math.round(n / 1000);
    if (n > 1e11) return Math.round(n);
    if (n > 1e8) return Math.round(n * 1000);
    return null;
}

function isEpochDateValue(value) {
    if (value == null || value === '') return true;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return true;
    if (n < NETSCAPE_ADD_DATE_MAX) return true;
    const ms = parseBookmarkDateMs(value);
    return ms == null || ms < EPOCH_DAY_MS;
}

function dateValueWallMs(value) {
    if (isEpochDateValue(value)) return null;
    const ms = parseBookmarkDateMs(value);
    if (ms == null || ms < EPOCH_DAY_MS) return null;
    return ms;
}

function formatBookmarkDate(value) {
    if (value == null || value === '') return '(missing)';
    const ms = parseBookmarkDateMs(value);
    if (ms == null) return `${value} (unparsed)`;
    if (isEpochDateValue(value)) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0 && n < 1e11 && ms >= Date.UTC(1970, 0, 2)) {
            return `${new Date(ms).toLocaleString()} — Unix ADD_DATE seconds (Firefox shows 12/31/69) [${value}]`;
        }
        return `${new Date(ms).toLocaleString()} — epoch/12/31/69 [${value}]`;
    }
    return `${new Date(ms).toLocaleString()} [${value}]`;
}

function collectBookmarkLinks(root) {
    const links = [];
    walkBookmarkTree(root, (node, parent, path) => {
        const uri = nodeUri(node);
        if (!uri) return;
        links.push({
            node,
            parent,
            id: node.id,
            title: node.title || '',
            uri,
            addedMs: parseBookmarkDateMs(node.dateAdded ?? node.date_added),
            usedMs: parseBookmarkDateMs(node.dateLastUsed ?? node.date_last_used ?? node.lastUsed),
            dateAdded: node.dateAdded ?? node.date_added,
            folderPath: displayFolderPath(path.join(' / ') || displayFolderTitle(root))
        });
    });
    return links;
}

function mdSafe(text) {
    return String(text ?? '').replace(/[\[\]]/g, '');
}

// The 21 names the default tracking-parameter rule drops, kept as a plain alias of
// DEFAULT_URL_RULES: General repairs reads them for its scan log, and the rules engine builds
// that rule's regex from this list, so the two can never drift apart.
const TRACKING_PARAM_NAMES = ['fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'si', 'feature', 'pp', 'ref_src', 'ref_url', 'rdt_cid', 'spm', 'mkt_tok', 'mc_cid', 'mc_eid', 'wickedid', 'oly_anon_id', 'oly_enc_id', '_hsenc', '_hsmi'];

// --- URL cleaning rules ---------------------------------------------------------------
// stripTrackingParams / canonicalObsidianUrl are now the default settings of an ordered,
// user-editable rule list. It mixes two kinds of rule:
//   { kind: 'params',  name: 'utm_*', match: 'prefix' | 'exact' | 'regex', value: 'utm_', enabled: true }
//   { kind: 'builtin', name: 'google-search', enabled: true }
// A params rule drops every query parameter it matches: prefix and exact compare the name
// case-insensitively, regex compiles value with the i flag (or with the flags written into a
// /body/flags value). A builtin rule runs one named pure function from URL_RULE_BUILTINS.
// Rules run in array order inside their stage — params first, then builtins, the exact two
// steps cleanCopyUrl has always taken — and this list is DEFAULT_URL_RULES, which reproduces
// the old hard-coded behaviour character for character.
const DEFAULT_URL_RULES = [
    { kind: 'params', name: 'utm_*', match: 'prefix', value: 'utm_', enabled: true },
    { kind: 'params', name: 'Tracking parameters', match: 'regex', value: `^(?:${TRACKING_PARAM_NAMES.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, enabled: true },
    { kind: 'builtin', name: 'youtube', enabled: true },
    { kind: 'builtin', name: 'google-redirect', enabled: true },
    { kind: 'builtin', name: 'google-image-redirect', enabled: true },
    { kind: 'builtin', name: 'google-search', enabled: true }
];

// Everything else lives in one closure, so the shared classic-script global scope gains no
// helper names that another file could collide with.
const URL_RULE_ENGINE = (function () {
    const PARAM_MATCHES = ['prefix', 'exact', 'regex'];
    const LABELS = {
        youtube: 'rewrite YouTube watch, embed, live, /v and youtu.be links to https://www.youtube.com/watch?v=ID (shorts stay as they are)',
        'google-redirect': 'unwrap a Google /url redirect to its destination',
        'google-image-redirect': 'unwrap a Google /imgres image result to its image URL',
        'google-search': 'keep only q, tbm, non-14 udm and non-zero start on a Google search URL'
    };

    // The old canonicalisation bailed out for any URL holding a "shorts" path segment, before
    // both the YouTube and the Google branches. Each builtin keeps that same bail-out.
    function hasShortsSegment(u) {
        return u.pathname.split('/').filter(Boolean).some(segment => segment.toLowerCase() === 'shorts');
    }

    // One named pure function per canonicalisation the hard-coded version did. Each takes a URL
    // string and returns the canonical URL string, or its input untouched when it does not
    // apply, so the engine can tell "no change" from "changed".
    const BUILTINS = {
        youtube: function urlRuleBuiltinYouTube(url) {
            try {
                const u = new URL(url);
                const host = u.hostname.toLowerCase().replace(/^www\./, '');
                const segments = u.pathname.split('/').filter(Boolean);
                if (hasShortsSegment(u)) return url;
                let id = '';
                if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
                    if (segments[0] === 'watch') id = u.searchParams.get('v') || '';
                    else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/live/') || u.pathname.startsWith('/v/')) id = segments[1] || '';
                    if (!id) id = u.searchParams.get('v') || '';
                } else if (host === 'youtu.be') {
                    id = segments[0] || '';
                }
                if (id) return `https://www.youtube.com/watch?v=${id}`;
            } catch (e) {}
            return url;
        },
        'google-redirect': function urlRuleBuiltinGoogleRedirect(url) {
            try {
                const u = new URL(url);
                const host = u.hostname.toLowerCase().replace(/^www\./, '');
                if (hasShortsSegment(u) || !isBareGoogleHost(host)) return url;
                const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
                if (path !== '/url') return url;
                return googleHttpDest(u.searchParams.get('url') || u.searchParams.get('q')) || url;
            } catch (e) { return url; }
        },
        'google-image-redirect': function urlRuleBuiltinGoogleImageRedirect(url) {
            try {
                const u = new URL(url);
                const host = u.hostname.toLowerCase().replace(/^www\./, '');
                if (hasShortsSegment(u) || !isBareGoogleHost(host)) return url;
                const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
                if (path !== '/imgres') return url;
                return googleHttpDest(u.searchParams.get('imgurl') || u.searchParams.get('imgrefurl')) || url;
            } catch (e) { return url; }
        },
        'google-search': function urlRuleBuiltinGoogleSearch(url) {
            try {
                const u = new URL(url);
                const host = u.hostname.toLowerCase().replace(/^www\./, '');
                if (hasShortsSegment(u) || !isBareGoogleHost(host)) return url;
                const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
                if (path !== '/search' && path !== '/webhp' && path !== '/') return url;
                const q = u.searchParams.get('q');
                if (!q) return url;
                const next = new URL('https://www.google.com/search');
                next.searchParams.set('q', q);
                const tbm = u.searchParams.get('tbm');
                if (tbm) next.searchParams.set('tbm', tbm);
                const udm = u.searchParams.get('udm');
                if (udm && udm !== '14') next.searchParams.set('udm', udm);
                const start = u.searchParams.get('start');
                if (start && start !== '0') next.searchParams.set('start', start);
                return next.href;
            } catch (e) { return url; }
        }
    };

    let active = null;

    function cloneRule(rule) { return Object.assign({}, rule); }
    function cloneList(list) { return (list || []).map(cloneRule); }
    function isOff(value) { return value === false || value === 'false' || value === 0 || value === '0'; }

    function paramRegex(rule) {
        const raw = rule && typeof rule.value === 'string' ? rule.value : '';
        const wrapped = /^\/(.*)\/([a-z]*)$/.exec(raw);
        try { return new RegExp(wrapped ? wrapped[1] : raw, wrapped ? wrapped[2] : 'i'); } catch (e) { return null; }
    }

    // A valid rule, normalised to the documented shape, or null when it is malformed.
    function normalizeRule(rule) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
        const enabled = !isOff(rule.enabled);
        if (rule.kind === 'params') {
            if (!PARAM_MATCHES.includes(rule.match)) return null;
            const value = typeof rule.value === 'string' ? rule.value : '';
            if (!value) return null;
            const out = {
                kind: 'params',
                name: (typeof rule.name === 'string' && rule.name.trim()) ? rule.name.trim() : value,
                match: rule.match,
                value,
                enabled
            };
            if (rule.match === 'regex' && !paramRegex(out)) return null;
            return out;
        }
        if (rule.kind === 'builtin') {
            const name = typeof rule.name === 'string' ? rule.name.trim() : '';
            if (!name || typeof BUILTINS[name] !== 'function') return null;
            return { kind: 'builtin', name, enabled };
        }
        return null;
    }

    // An array of valid rules (an empty array is valid: clean nothing), or null when any entry
    // is malformed.
    function normalizeList(list) {
        if (!Array.isArray(list)) return null;
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const rule = normalizeRule(list[i]);
            if (!rule) return null;
            out.push(rule);
        }
        return out;
    }

    function ruleProblem(rule) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            return `expected a rule object, got ${rule === null ? 'null' : Array.isArray(rule) ? 'an array' : typeof rule}`;
        }
        if (rule.kind === 'params') {
            if (!PARAM_MATCHES.includes(rule.match)) return `params rule "match" must be one of ${PARAM_MATCHES.join(', ')} (got ${JSON.stringify(rule.match)})`;
            if (typeof rule.value !== 'string' || !rule.value) return 'params rule needs a non-empty string "value"';
            if (rule.match === 'regex' && !paramRegex({ value: rule.value })) return `params rule "value" is not a valid regular expression (${JSON.stringify(rule.value)})`;
            return 'params rule is malformed';
        }
        if (rule.kind === 'builtin') {
            const name = typeof rule.name === 'string' ? rule.name.trim() : '';
            if (!name) return 'builtin rule needs a "name"';
            if (typeof BUILTINS[name] !== 'function') return `unknown builtin ${JSON.stringify(name)} (known: ${Object.keys(BUILTINS).join(', ')})`;
            return 'builtin rule is malformed';
        }
        return `"kind" must be "params" or "builtin" (got ${JSON.stringify(rule.kind)})`;
    }

    function ruleMatchesKey(rule, key) {
        const name = String(key == null ? '' : key);
        const lower = name.toLowerCase();
        const value = String(rule.value);
        if (rule.match === 'prefix') return lower.indexOf(value.toLowerCase()) === 0;
        if (rule.match === 'exact') return lower === value.toLowerCase();
        const re = paramRegex(rule);
        return re ? re.test(name) : false;
    }

    function paramsToDrop(url, rules) {
        const drop = [];
        if (!url || typeof url.searchParams.forEach !== 'function') return drop;
        const activeRules = (rules || []).filter(rule => rule && rule.kind === 'params' && rule.enabled !== false);
        url.searchParams.forEach((value, key) => {
            if (activeRules.some(rule => ruleMatchesKey(rule, key))) drop.push({ key, value });
        });
        return drop;
    }

    function step(rule, before, after) {
        return { rule: cloneRule(rule), name: rule.name || rule.value || '', before: String(before), after: String(after) };
    }

    // Stage 1: tracking parameters. One rule at a time, every one of its matches dropped at
    // once — the shape trackingParamKeys + stripTrackingParams always had.
    function applyParams(uri, rules, steps) {
        const value = String(uri == null ? '' : uri);
        if (!value) return value;
        const activeRules = (rules || []).filter(rule => rule && rule.kind === 'params' && rule.enabled !== false);
        let current = value;
        for (let i = 0; i < activeRules.length; i++) {
            const rule = activeRules[i];
            let next = current;
            try {
                const url = new URL(current);
                const drop = paramsToDrop(url, [rule]);
                if (drop.length) {
                    drop.forEach(item => url.searchParams.delete(item.key));
                    next = url.toString();
                }
            } catch (e) { next = current; }
            if (next !== current) {
                if (steps) steps.push(step(rule, current, next));
                current = next;
            }
        }
        return current;
    }

    // Stage 2: canonicalisation. A change restarts the list one hop later, which is exactly the
    // recursion — and the stop after four more hops — the hard-coded version used.
    function applyBuiltins(uri, rules, depth, steps) {
        if (!uri) return uri;
        const activeRules = (rules || []).filter(rule => rule && rule.kind === 'builtin' && rule.enabled !== false && typeof BUILTINS[rule.name] === 'function');
        if (!activeRules.length) return uri;
        return runBuiltins(uri, activeRules, depth || 0, steps);
    }

    function runBuiltins(url, activeRules, hops, steps) {
        if (hops > 4) return url;
        for (let i = 0; i < activeRules.length; i++) {
            const rule = activeRules[i];
            let next;
            try { next = BUILTINS[rule.name](url); } catch (e) { next = url; }
            if (typeof next !== 'string' || !next || next === url) continue;
            if (steps) steps.push(step(rule, url, next));
            return runBuiltins(next, activeRules, hops + 1, steps);
        }
        return url;
    }

    // getActive() hands out a clone so callers cannot mutate the live list, which means it also
    // allocates on every call — and the cleaner asks once per URL. rev lets callers cache their
    // own results, and applyParamsActive() reads the live list without cloning it.
    let rev = 0;

    function getRev() {
        return rev;
    }

    function getActive() {
        if (active === null) active = cloneList(normalizeList(DEFAULT_URL_RULES) || []);
        return cloneList(active);
    }

    function getActiveRef() {
        if (active === null) active = cloneList(normalizeList(DEFAULT_URL_RULES) || []);
        return active;
    }

    function applyParamsActive(url) {
        return applyParams(url, getActiveRef(), null);
    }

    function setActive(rules) {
        const list = normalizeList(rules);
        active = list === null ? cloneList(DEFAULT_URL_RULES) : list;
        rev += 1;
        return cloneList(active);
    }

    function reset() {
        active = cloneList(DEFAULT_URL_RULES);
        rev += 1;
        return cloneList(active);
    }

    function toJson(rules) {
        const list = (rules === undefined || rules === null) ? getActive() : (normalizeList(rules) || getActive());
        return JSON.stringify(list, null, 2);
    }

    function fromJson(text) {
        const raw = String(text == null ? '' : text).trim();
        if (!raw) throw new Error('URL rules JSON is empty. Expected an array of rules, for example [{"kind":"params","name":"utm_*","match":"prefix","value":"utm_","enabled":true}].');
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new Error(`URL rules JSON is not valid JSON: ${e.message}`);
        }
        let list = parsed;
        if (list && typeof list === 'object' && !Array.isArray(list) && Array.isArray(list.rules)) list = list.rules;
        if (!Array.isArray(list)) throw new Error('URL rules JSON must be an array of rule objects (or {"rules": [...]}).');
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const rule = normalizeRule(list[i]);
            if (!rule) throw new Error(`URL rules item ${i + 1} is not a valid rule: ${ruleProblem(list[i])}`);
            out.push(rule);
        }
        return out;
    }

    function test(uri, rules) {
        const list = (rules === undefined || rules === null) ? getActive() : (normalizeList(rules) || getActive());
        const original = String(uri == null ? '' : uri);
        const steps = [];
        const stripped = applyParams(original, list, steps);
        const canonical = applyBuiltins(stripped, list, 0, steps);
        return { original, stripped, canonical, steps };
    }

    function describe(rule) {
        if (!rule || typeof rule !== 'object') return 'Unknown rule';
        const off = isOff(rule.enabled) ? ' (disabled)' : '';
        if (rule.kind === 'params') {
            const value = typeof rule.value === 'string' ? rule.value : '';
            const detail = rule.match === 'prefix' ? `drop query parameters whose name starts with "${value}"`
                : rule.match === 'exact' ? `drop the query parameter "${value}"`
                    : rule.match === 'regex' ? `drop query parameters matching /${value}/i`
                        : 'drop query parameters (unknown match mode)';
            return `${rule.name || value}: ${detail}${off}`;
        }
        if (rule.kind === 'builtin') {
            return `${rule.name}: ${LABELS[rule.name] || 'unknown canonicalisation step'}${off}`;
        }
        return 'Unknown rule';
    }

    return {
        builtins: BUILTINS,
        labels: LABELS,
        normalizeRule,
        normalizeList,
        getActive,
        setActive,
        reset,
        toJson,
        fromJson,
        test,
        describe,
        paramsToDrop,
        applyParams,
        applyParamsActive,
        getRev,
        applyBuiltins
    };
})();

// The registry of named canonicalisation steps a { kind: 'builtin' } rule can point at.
const URL_RULE_BUILTINS = URL_RULE_ENGINE.builtins;
const URL_RULE_BUILTIN_LABELS = URL_RULE_ENGINE.labels;

function getActiveUrlRules() { return URL_RULE_ENGINE.getActive(); }
function setActiveUrlRules(rules) { return URL_RULE_ENGINE.setActive(rules); }
function resetUrlRules() { return URL_RULE_ENGINE.reset(); }
function urlRulesToJson(rules) { return URL_RULE_ENGINE.toJson(rules); }
function urlRulesFromJson(text) { return URL_RULE_ENGINE.fromJson(text); }
function testUrlRules(uri, rules) { return URL_RULE_ENGINE.test(uri, rules); }
function describeUrlRule(rule) { return URL_RULE_ENGINE.describe(rule); }

function trackingParamKeys(url) {
    return URL_RULE_ENGINE.paramsToDrop(url, URL_RULE_ENGINE.getActive());
}

// Returns the URL with its tracking parameters removed, or the original string when there is
// nothing to strip (or it cannot be parsed), so a clean URL is never rewritten or normalised.
// The parameters it drops come from the active params rules (DEFAULT_URL_RULES by default).
// Called for every row while rendering (the cleaning tools, the copy menu and the badges all ask),
// so results are memoised against the active rule list's identity: saving new rules replaces that
// list and drops the cache with it.
const CLEAN_URL_CACHE_LIMIT = 20000;
let cleanUrlCache = new Map();
let cleanUrlCacheRules = null;

function stripTrackingParams(uri) {
    const value = String(uri == null ? '' : uri);
    if (!value) return value;
    // Fall back to the older calls if the engine does not expose the revision helpers, so a stubbed
    // or older engine still works and simply keeps no cache.
    const hasRev = typeof URL_RULE_ENGINE.getRev === 'function';
    const rev = hasRev ? URL_RULE_ENGINE.getRev() : -1;
    if (cleanUrlCacheRules !== rev) {
        cleanUrlCache = new Map();
        cleanUrlCacheRules = rev;
    }
    const hit = cleanUrlCache.get(value);
    if (hit !== undefined) return hit;
    const out = typeof URL_RULE_ENGINE.applyParamsActive === 'function'
        ? URL_RULE_ENGINE.applyParamsActive(value)
        : URL_RULE_ENGINE.applyParams(value, URL_RULE_ENGINE.getActive(), null);
    if (cleanUrlCache.size >= CLEAN_URL_CACHE_LIMIT) cleanUrlCache.clear();
    cleanUrlCache.set(value, out);
    return out;
}

// The canonicalisation itself, with no preference gate: the builtin rules canonicalise YouTube
// watch/embed/youtu.be links, unwrap Google /url and /imgres redirects, and keep only q / tbm /
// udm / start on Google search URLs. Same signature and same depth stop as the old version.
function canonicalObsidianUrl(url, depth) {
    if (!url) return url;
    return URL_RULE_ENGINE.applyBuiltins(url, URL_RULE_ENGINE.getActive(), depth, null);
}

function urlForObsidian(url, depth) {
    if (!url) return url;
    if (capturePrefs.cleanSentUrls === false) return url;
    return canonicalObsidianUrl(url, depth);
}

// What the copy menus put on the clipboard: the tracking rule, then the same Google/YouTube
// canonicalisation the Obsidian sends use — applied whatever the “clean sent URLs”
// preference says, because a copy should always be the clean link. The original URL stays
// one item away whenever this changes anything, which is what hasCleanableUrl decides.
function cleanCopyUrl(uri) {
    const value = String(uri == null ? '' : uri);
    if (!value) return value;
    return canonicalObsidianUrl(stripTrackingParams(value));
}

// The key two bookmarks/tabs share when they are the same page: canonicalise (Google,
// YouTube) and strip tracking parameters. bookmarkUrlKey alone does NOT strip trackers, and
// duplicateUrlKey is deliberately exact about them, so neither is right for this question.
function libraryUrlKey(uri) {
    return bookmarkUrlKey(stripTrackingParams(uri));
}

// Asked once per row while rendering; memoised on the same rule-list identity as the cleaner.
let cleanableCache = new Map();
let cleanableCacheRules = null;

function hasCleanableUrl(uri) {
    const key = String(uri == null ? '' : uri);
    if (!key) return false;
    const rev = typeof URL_RULE_ENGINE.getRev === 'function' ? URL_RULE_ENGINE.getRev() : -1;
    if (cleanableCacheRules !== rev) {
        cleanableCache = new Map();
        cleanableCacheRules = rev;
    }
    const hit = cleanableCache.get(key);
    if (hit !== undefined) return hit;
    const out = hasCleanableUrlUncached(key);
    if (cleanableCache.size >= CLEAN_URL_CACHE_LIMIT) cleanableCache.clear();
    cleanableCache.set(key, out);
    return out;
}

function hasCleanableUrlUncached(uri) {
    const value = String(uri == null ? '' : uri);
    return Boolean(value) && cleanCopyUrl(value) !== value;
}

function isBareGoogleHost(host) {
    return /^google\.[a-z.]+$/i.test(host || '');
}

function googleHttpDest(value) {
    const href = String(value || '').trim();
    if (!/^https?:\/\//i.test(href)) return '';
    try {
        return new URL(href).href;
    } catch (e) {
        return '';
    }
}

function googleUrlForObsidian(u, host) {
    if (!isBareGoogleHost(host)) return '';
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/url') {
        return googleHttpDest(u.searchParams.get('url') || u.searchParams.get('q'));
    }
    if (path === '/imgres') {
        return googleHttpDest(u.searchParams.get('imgurl') || u.searchParams.get('imgrefurl'));
    }
    const q = u.searchParams.get('q');
    if (!q) return '';
    if (path !== '/search' && path !== '/webhp' && path !== '/') return '';
    const next = new URL('https://www.google.com/search');
    next.searchParams.set('q', q);
    const tbm = u.searchParams.get('tbm');
    if (tbm) next.searchParams.set('tbm', tbm);
    const udm = u.searchParams.get('udm');
    if (udm && udm !== '14') next.searchParams.set('udm', udm);
    const start = u.searchParams.get('start');
    if (start && start !== '0') next.searchParams.set('start', start);
    return next.href;
}

function googleSearchUrlForQuery(query) {
    const q = String(query || '').replace(/^\s+|\s+$/g, '');
    if (!q) return '';
    const next = new URL('https://www.google.com/search');
    next.searchParams.set('q', q);
    return next.href;
}

function isYouTubeWatchObsidianUrl(url) {
    return /^https:\/\/www\.youtube\.com\/watch\?v=/i.test(url || '');
}

function isYouTubeHandleObsidianUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
        return host === 'youtube.com' && /^\/@[^/]+/.test(u.pathname);
    } catch (e) {
        return false;
    }
}

function isGoogleSearchObsidianUrl(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        if (!isBareGoogleHost(host)) return false;
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        return path === '/search' && Boolean(u.searchParams.get('q'));
    } catch (e) {
        return false;
    }
}

function titleForObsidian(title, url) {
    const clean = capturePrefs.cleanSentUrls;
    capturePrefs.cleanSentUrls = true;
    const uri = urlForObsidian(url);
    capturePrefs.cleanSentUrls = clean;
    let text = String(title || '').trim();
    if (isYouTubeWatchObsidianUrl(uri) || isYouTubeHandleObsidianUrl(uri)) {
        text = text.replace(/^\s*(?:\(\d+\)|▶)\s*/, '');
        text = text.replace(/\s*-\s*YouTube\s*$/i, '').trim();
        const titleAsUrl = text ? urlForObsidian(text) : '';
        if (!text || text === uri || titleAsUrl === uri) return uri || 'Untitled';
        return capturePrefs.youtubeTitleSuffix === false ? text : `${text} - YouTube`;
    }
    if (isGoogleSearchObsidianUrl(uri)) {
        text = text.replace(/\s*[-–—|]\s*Google Search\s*$/i, '').trim();
        const titleAsUrl = text ? urlForObsidian(text) : '';
        if (!text || text === uri || titleAsUrl === uri) return uri || 'Untitled';
        return capturePrefs.googleTitleSuffix === false ? text : `${text} - Google Search`;
    }
    return text || uri || 'Untitled';
}

function bookmarkUrlKey(url) {
    const clean = capturePrefs.cleanSentUrls;
    capturePrefs.cleanSentUrls = true;
    const href = urlForObsidian(url);
    capturePrefs.cleanSentUrls = clean;
    try {
        const parsed = new URL(href);
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
            let ytId = '';
            if (segments[0] === 'watch') ytId = parsed.searchParams.get('v') || '';
            else if (segments[0] === 'embed' || segments[0] === 'live' || segments[0] === 'v' || segments[0] === 'shorts') ytId = segments[1] || '';
            else if (host === 'youtu.be') ytId = segments[0] || '';
            if (!ytId) ytId = parsed.searchParams.get('v') || '';
            if (ytId) return `youtube.com/watch?v=${ytId}`;
        }
        const path = parsed.pathname.replace(/\/+$/, '') || '/';
        return `${host}${path}${parsed.search || ''}`;
    } catch (e) {
        return String(href || '').trim().toLowerCase();
    }
}

function mdIndent(depth, unit = '\t') {
    return unit.repeat(Math.max(0, depth));
}

function mdLinkLine(node, depth, unit = '\t') {
    // Tracking parameters never reach a note: every send line goes through here, and the
    // strip runs before urlForObsidian so it applies whatever “clean sent URLs” says.
    const uri = urlForObsidian(stripTrackingParams(nodeUri(node)));
    const title = mdSafe(titleForObsidian(node && node.title, uri));
    return `${mdIndent(depth, unit)}- [${title}](${uri})`;
}

function mdFolderLine(node, depth, unit = '\t') {
    return `${mdIndent(depth, unit)}- ${mdSafe(displayFolderTitle(node, 'Untitled'))}`;
}

function datedObsidianFile() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The at-cursor URL: insertatcursor is the whole mode, filepath only names the note (omitted, the
// plugin inserts into the editor you are in). encodeURIComponent already matches the encoding the
// plugin expects: %20 spaces (never a bare +), %0A newlines, %23 for #, %26 for &, %25 for %.
function obsidianAtCursorUri(text) {
    // No filepath: the plugin inserts into whichever note is open.
    return `obsidian://advanced-uri?insertatcursor=${encodeURIComponent(text)}`;
}

// The append destination: the daily note, or capturePrefs.obsidianNotePath when one is set.
function obsidianAppendUri(file, chunk) {
    return `obsidian://adv-uri?filepath=${encodeURIComponent(file)}&mode=append&separator=&data=${encodeURIComponent(chunk)}`;
}

function obsidianAppendChunk(content) {
    const body = String(content || '').replace(/^\n+/, '').replace(/\n+$/, '');
    return body ? `${body}\n` : '';
}

function extTabsCall(ext, method, ...args) {
    const api = ext && ext.tabs;
    if (!api || typeof api[method] !== 'function') return Promise.reject(new Error('Tabs API is not available.'));
    if (typeof browser !== 'undefined' && browser.tabs && typeof browser.tabs[method] === 'function') {
        return Promise.resolve(browser.tabs[method](...args));
    }
    return new Promise((resolve, reject) => {
        api[method](...args, result => {
            const last = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
            if (last) reject(new Error(last.message));
            else resolve(result);
        });
    });
}

function activeTabForObsidian(ext) {
    return extTabsCall(ext, 'query', { active: true, lastFocusedWindow: true }).then(tabs => {
        if (Array.isArray(tabs) && tabs[0]) return tabs[0];
        return extTabsCall(ext, 'query', { active: true, currentWindow: true }).then(found => {
            return (Array.isArray(found) && found[0]) || null;
        });
    }).catch(() => null);
}

function openObsidianHandoffTab(ext, url, origin) {
    // active: true on purpose. Firefox drops obsidian:// navigations started from a background tab,
    // so the handoff page must be the active tab for the launch to reach the OS. finish() restores
    // the originating tab and closes the page, so the flash is momentary.
    const spec = { url, active: true };
    if (origin && origin.id != null) spec.openerTabId = origin.id;
    if (origin && origin.windowId != null) spec.windowId = origin.windowId;
    return extTabsCall(ext, 'create', spec).catch(() => extTabsCall(ext, 'create', { url, active: true }));
}

function openObsidianAppend(content, dailyNote = false) {
    // Two destinations. Default: insert at the cursor of whichever note is open, sending no filepath,
    // with the text exactly as given because insertatcursor does no trimming. dailyNote: the original
    // append behaviour, targeting capturePrefs.obsidianNotePath or today's dated note.
    const chunk = dailyNote ? obsidianAppendChunk(content) : String(content || '');
    if (!chunk) return Promise.resolve();
    const file = dailyNote ? (capturePrefs.obsidianNotePath || datedObsidianFile()) : '';
    const ext = getBrowserExt();
    if (ext && ext.storage && ext.storage.local && ext.runtime && typeof ext.runtime.getURL === 'function') {
        return activeTabForObsidian(ext).then(origin => {
            const pending = { chunk, file, t: Date.now(), atCursor: !dailyNote, insertUnder: capturePrefs.obsidianInsert === 'under', insertFallback: capturePrefs.obsidianFallback === 'daily' };
            if (origin && origin.id != null) {
                pending.returnTabId = origin.id;
                if (origin.windowId != null) pending.returnWindowId = origin.windowId;
            }
            return ext.storage.local.set({ obsidianPending: pending }).then(() => {
                const url = ext.runtime.getURL('obsidian-launch.html');
                if (ext.tabs && ext.tabs.create) return openObsidianHandoffTab(ext, url, origin);
                if (typeof window !== 'undefined' && window.open) window.open(url, '_blank');
            });
        });
    }
    if (typeof window === 'undefined') return Promise.reject(new Error('Obsidian send is not available.'));
    // The app's own wording for the switch the plugin exposes as insertline=.
    const href = dailyNote
        ? obsidianAppendUri(file, chunk)
        : obsidianAtCursorUri(chunk) + (capturePrefs.obsidianInsert === 'under' ? '&insertline=under' : '') + (capturePrefs.obsidianFallback === 'daily' ? '&insertfallback=daily' : '');
    const opener = window.open(href, '_blank');
    if (!opener) window.location.href = href;
    return Promise.resolve();
}

function extractSearchQuery(link) {
    const uri = nodeUri(link);
    try {
        const parsed = new URL(uri);
        const host = parsed.hostname.toLowerCase();
        if ((host.includes('google.') || host.includes('bing.com') || host.includes('duckduckgo.com') || host.includes('yahoo.com') || host.includes('startpage.com')) && parsed.searchParams.get('q')) {
            return parsed.searchParams.get('q').trim();
        }
    } catch (err) { /* ignore */ }
    const fromTitle = String(link && link.title || '').match(/^(.*?)\s*[-–—|]\s*(Google Search|Bing|DuckDuckGo|Yahoo|Startpage)\s*$/i);
    if (fromTitle && fromTitle[1].trim()) return fromTitle[1].trim();
    const raw = String(uri).match(/[?&]q=([^&]+)/i);
    if (raw && SEARCH_ENGINE_HOST_RE.test(uri)) {
        try { return decodeURIComponent(raw[1].replace(/\+/g, ' ')).trim(); } catch (err) { return raw[1]; }
    }
    return '';
}

function isSearchLink(link) {
    return Boolean(extractSearchQuery(link));
}

function clusterSearchChains(links, gapMs, excludeNodes = new Set()) {
    const dated = links
        .filter(link => link.addedMs != null && link.addedMs >= EPOCH_DAY_MS && !excludeNodes.has(link.node))
        .sort((a, b) => a.addedMs - b.addedMs);
    const chains = [];
    for (let i = 0; i < dated.length; i++) {
        if (!isSearchLink(dated[i])) continue;
        const cluster = [dated[i]];
        for (let j = i + 1; j < dated.length; j++) {
            if (dated[j].addedMs - cluster[cluster.length - 1].addedMs > gapMs) break;
            cluster.push(dated[j]);
        }
        const searches = cluster.filter(isSearchLink);
        const destinations = cluster.filter(link => !isSearchLink(link));
        if (!destinations.length) continue;
        const queries = [...new Set(searches.map(extractSearchQuery).filter(Boolean))];
        chains.push({
            topic: queries.join(' · ') || '',
            queries,
            links: cluster,
            destinations
        });
        i += cluster.length - 1;
    }
    return chains;
}

function searchChainMarkdown(chain) {
    const links = (chain && chain.links) || [];
    const search = links.find(isSearchLink) || links[0];
    if (!search) return '';
    const extras = links.filter(link => link !== search);
    return [mdLinkLine(search, 0), ...extras.map(link => mdLinkLine(link, 1))].join('\n');
}

const MULTI_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr',
    'co.in', 'com.br', 'com.mx', 'co.nz', 'co.za', 'com.tr', 'com.ar', 'co.id', 'com.tw'
]);
const PARENT_ALIASES = {
    'youtu.be': 'youtube.com',
    'youtube-nocookie.com': 'youtube.com',
    'x.com': 'x.com',
    'twitter.com': 'x.com',
    't.co': 'x.com',
    'mobile.twitter.com': 'x.com',
    'redd.it': 'reddit.com',
    'old.reddit.com': 'reddit.com',
    'new.reddit.com': 'reddit.com',
    'np.reddit.com': 'reddit.com',
    'hcker.news': 'ycombinator.com',
    'hckr.news': 'ycombinator.com',
    'm.facebook.com': 'facebook.com',
    'fb.me': 'facebook.com',
    'fb.com': 'facebook.com',
    'instagr.am': 'instagram.com',
    'youtubekids.com': 'youtube.com'
};

function isIPv4Host(host) {
    const parts = String(host || '').split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function isIPv6Host(host) {
    const raw = String(host || '').replace(/^\[|\]$/g, '');
    return raw.includes(':') && /^[0-9a-f:]+$/i.test(raw);
}

function parentDomainFromHost(hostname) {
    let host = (hostname || '').toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host) return 'unknown';
    if (isIPv4Host(host) || isIPv6Host(host)) return host;
    if (PARENT_ALIASES[host]) return PARENT_ALIASES[host];
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 1) return host;
    const lastTwo = parts.slice(-2).join('.');
    const lastThree = parts.slice(-3).join('.');
    if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
        const parent = lastThree;
        return PARENT_ALIASES[parent] || parent;
    }
    return PARENT_ALIASES[lastTwo] || lastTwo;
}

function toRdnn(domain) {
    const value = (domain || 'unknown').replace(/^\[|\]$/g, '');
    if (isIPv6Host(value)) return value.split(':').reverse().join(':');
    return value.split('.').filter(Boolean).reverse().join('.');
}

function nextNewFolderName(folderTitles, base = 'New Folder') {
    const taken = new Set((folderTitles || []).map(title => String(title || '').trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
}
