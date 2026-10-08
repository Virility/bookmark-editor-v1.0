(function () {
    const ext = typeof browser !== 'undefined' ? browser : chrome;
    const form = document.getElementById('nest-form');
    const input = document.getElementById('folder-name');
    const entries = document.getElementById('entries');
    const error = document.getElementById('error');
    let ids = [];

    function showError(text) {
        error.textContent = text;
        error.hidden = false;
    }

    document.getElementById('cancel').addEventListener('click', () => window.close());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') window.close();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        const title = input.value.trim();
        if (!title) return showError('Folder name cannot be empty.');
        if (!ids.length) return showError('Nothing to nest.');
        try {
            const res = await ext.runtime.sendMessage({ type: 'nest-entries', ids, title });
            if (res && res.ok) return window.close();
            showError((res && res.error) || 'Could not nest those entries.');
        } catch (err) {
            showError(String(err && err.message || err));
        }
    });

    ext.storage.local.get('nestEntries').then(store => {
        const pending = store && store.nestEntries;
        ext.storage.local.remove('nestEntries').catch(() => {});
        const items = pending && Array.isArray(pending.items) ? pending.items : [];
        ids = items.map(item => item.id).filter(Boolean);
        if (pending && pending.defaultName) input.value = pending.defaultName;
        entries.textContent = items.length ? items.map(item => item.title).join(', ') : 'Nothing to nest.';
        input.focus();
        input.select();
    }).catch(err => showError(String(err && err.message || err)));
})();
