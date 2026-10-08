// Standalone runner for self-test.html. The app runs the same tests from its Actions card.
function renderSelfTests() {
    const run = runSelfTests();
    const summary = document.getElementById('summary');
    const results = document.getElementById('results');
    const stamp = document.getElementById('stamp');
    if (summary) {
        summary.textContent = `${run.passed} passed, ${run.failed} failed${run.skipped ? `, ${run.skipped} skipped` : ''} of ${run.total} check(s) in ${run.ms} ms`;
        summary.classList.toggle('is-bad', run.failed > 0);
        summary.classList.toggle('is-good', run.failed === 0);
    }
    if (stamp) stamp.textContent = `Run ${new Date().toLocaleTimeString()}`;
    if (!results) return run;
    const groups = [...new Set(run.results.map(result => result.group))];
    results.innerHTML = groups.map(group => {
        const rows = run.results.filter(result => result.group === group);
        return `<h2>${escapeHtml(group)} — ${rows.filter(row => row.ok).length}/${rows.length}</h2>
            <table><thead><tr><th>Result</th><th>Check</th><th>Detail</th></tr></thead><tbody>
            ${rows.map(row => `<tr class="${row.ok ? '' : 'is-fail'}">
                <td class="mark ${row.skipped ? 'skip' : row.ok ? 'ok' : 'bad'}">${row.skipped ? 'SKIP' : row.ok ? 'PASS' : 'FAIL'}</td>
                <td>${escapeHtml(row.name)}</td>
                <td>${escapeHtml(row.skipped || row.error || '')}</td>
            </tr>`).join('')}
            </tbody></table>`;
    }).join('');
    return run;
}

document.getElementById('rerun')?.addEventListener('click', renderSelfTests);
document.getElementById('copy')?.addEventListener('click', () => {
    const run = runSelfTests();
    if (typeof copyTextToClipboard === 'function') copyTextToClipboard(selfTestsMarkdown(run));
    else navigator.clipboard?.writeText(selfTestsMarkdown(run));
});
renderSelfTests();
