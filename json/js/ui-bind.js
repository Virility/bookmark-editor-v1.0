// Extension CSP forbids inline onclick. Wire data-view / data-child / data-call here.
function wireExtensionUi() {
    document.querySelectorAll('.tab-btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.getAttribute('data-view'), btn));
    });
    document.querySelectorAll('.child-tab-btn[data-child]').forEach(btn => {
        btn.addEventListener('click', () => switchChildTab(btn.getAttribute('data-child'), btn));
    });
    document.querySelectorAll('[data-call]').forEach(el => {
        const name = el.getAttribute('data-call');
        const eventName = el.tagName === 'SELECT' || el.type === 'file' || el.type === 'checkbox' || el.type === 'number' ? 'change' : (el.tagName === 'INPUT' ? 'input' : 'click');
        el.addEventListener(eventName, event => {
            if (el.tagName === 'A') event.preventDefault();
            const fn = window[name];
            if (typeof fn !== 'function') return;
            if (el.hasAttribute('data-arg')) fn(el.getAttribute('data-arg'));
            else if (el.getAttribute('data-apply')) fn(el.getAttribute('data-apply'));
            else fn(event);
        });
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireExtensionUi);
else wireExtensionUi();
