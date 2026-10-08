(function () {
    const ext = typeof browser !== 'undefined' ? browser : chrome;
    const MAX_URI = 6000;

    // The local Advanced URI's insert-at-cursor mode. Too long for a URL: copy the text and let the
    // plugin paste it with {{clipboard}}, which is the same fallback the append path uses.
    function appendUri(file, extra) {
        let href = `obsidian://adv-uri?filepath=${encodeURIComponent(file)}&mode=append&separator=`;
        Object.keys(extra).forEach(key => {
            href += `&${encodeURIComponent(key)}=${encodeURIComponent(extra[key])}`;
        });
        return href;
    }

    function atCursorUri(text) {
        // No filepath: the plugin inserts into whichever note is open.
        return `obsidian://advanced-uri?insertatcursor=${encodeURIComponent(text)}`;
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((resolve, reject) => {
            try {
                const area = document.createElement('textarea');
                area.value = text;
                document.body.appendChild(area);
                area.select();
                document.execCommand('copy');
                area.remove();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    function sendMessage(payload) {
        if (!ext.runtime || typeof ext.runtime.sendMessage !== 'function') return Promise.resolve();
        try {
            const ret = ext.runtime.sendMessage(payload);
            if (ret && typeof ret.then === 'function') return ret.catch(() => {});
        } catch (err) { /* Chrome callback form */ }
        return new Promise(resolve => {
            try {
                ext.runtime.sendMessage(payload, () => {
                    if (typeof chrome !== 'undefined' && chrome.runtime) void chrome.runtime.lastError;
                    resolve();
                });
            } catch (err) {
                resolve();
            }
        });
    }

    function restoreReturnTab(returnTabId) {
        if (returnTabId == null) return Promise.resolve();
        return sendMessage({ type: 'obsidian-handoff-done', returnTabId });
    }

    function finish(href, returnTabId) {
        window.location.href = href;
        restoreReturnTab(returnTabId).then(() => {
            setTimeout(() => {
                try { window.close(); } catch (err) { /* ignore */ }
            }, 1200);
        });
    }

    ext.storage.local.get('obsidianPending').then(store => {
        const pending = store && store.obsidianPending;
        const file = pending && pending.file;
        const chunk = pending && pending.chunk;
        const returnTabId = pending && pending.returnTabId;
        ext.storage.local.remove('obsidianPending').catch(() => {});
        if ((!file && !(pending && pending.atCursor)) || !chunk) {
            document.body.textContent = 'Nothing to send.';
            return;
        }
        if (pending && pending.atCursor) {
            const withText = atCursorUri(chunk) + (pending.insertUnder ? '&insertline=under' : '') + (pending.insertFallback ? '&insertfallback=daily' : '');
            if (withText.length <= MAX_URI) {
                finish(withText, returnTabId);
                return;
            }
            // Too long for a URI: copy the text and let the plugin paste it with {{clipboard}}.
            copyText(chunk).then(() => {
                finish(atCursorUri('{{clipboard}}') + (pending.insertUnder ? '&insertline=under' : '') + (pending.insertFallback ? '&insertfallback=daily' : ''), returnTabId);
            }).catch(() => {
                finish(withText, returnTabId);
            });
            return;
        }
        const withData = appendUri(file, { data: chunk });
        if (withData.length <= MAX_URI) {
            finish(withData, returnTabId);
            return;
        }
        copyText(chunk).then(() => {
            finish(appendUri(file, { clipboard: 'true' }), returnTabId);
        }).catch(() => {
            finish(withData, returnTabId);
        });
    }).catch(err => {
        document.body.textContent = String(err && err.message ? err.message : err);
    });
}());
