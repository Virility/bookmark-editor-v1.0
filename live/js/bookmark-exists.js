(function () {
    const ext = typeof browser !== 'undefined' ? browser : chrome;

    function closeDialog() {
        window.close();
    }

    function openLibraryAt(id) {
        if (!id || !ext.runtime || typeof ext.runtime.sendMessage !== 'function') return;
        const done = () => closeDialog();
        try {
            const ret = ext.runtime.sendMessage({ type: 'open-library-at', id });
            if (ret && typeof ret.then === 'function') {
                ret.then(done).catch(done);
                return;
            }
        } catch (err) { /* Chrome callback form */ }
        ext.runtime.sendMessage({ type: 'open-library-at', id }, done);
    }

    function addPlace(list, item) {
        const wrap = document.createElement('div');
        wrap.className = 'place';
        const locLabel = document.createElement('p');
        locLabel.className = 'label';
        locLabel.textContent = 'Location';
        const pathText = (item && item.folderPath) || 'Unknown folder';
        let loc;
        if (item && item.id) {
            loc = document.createElement('a');
            loc.className = 'path';
            loc.href = '#';
            loc.textContent = pathText;
            loc.addEventListener('click', event => {
                event.preventDefault();
                openLibraryAt(item.id);
            });
        } else {
            loc = document.createElement('p');
            loc.className = 'path';
            loc.textContent = pathText;
        }
        const titleLabel = document.createElement('p');
        titleLabel.className = 'label';
        titleLabel.textContent = 'Title';
        const title = document.createElement('p');
        title.className = 'title';
        title.textContent = (item && item.title) || 'Untitled';
        wrap.appendChild(locLabel);
        wrap.appendChild(loc);
        wrap.appendChild(titleLabel);
        wrap.appendChild(title);
        list.appendChild(wrap);
    }

    const ok = document.getElementById('ok');
    if (ok) ok.addEventListener('click', closeDialog);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeDialog();
        if (event.key === 'Enter' && event.target && event.target.id === 'ok') closeDialog();
    });

    ext.storage.local.get('bookmarkExists').then(store => {
        const pending = store && store.bookmarkExists;
        ext.storage.local.remove('bookmarkExists').catch(() => {});
        const items = pending && Array.isArray(pending.items) ? pending.items : [];
        const error = document.getElementById('error');
        const list = document.getElementById('where');
        if (!items.length) {
            if (error) error.textContent = 'This link was not bookmarked.';
            return;
        }
        if (error) {
            error.textContent = items.length === 1
                ? 'It already exists in the library.'
                : `It already exists in the library (${items.length} bookmarks).`;
        }
        items.forEach(item => addPlace(list, item));
    }).catch(err => {
        const error = document.getElementById('error');
        if (error) error.textContent = String(err && err.message ? err.message : err);
    });
}());
