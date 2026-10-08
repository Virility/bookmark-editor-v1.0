// In-app self-tests for the pure logic: URL cleaning, the rule engine, the Netscape
// reader/writer, markdown lines, duplicate keys and the title-cleanup rules.
// Classic script, shared by the app (Actions card) and by self-test.html.
// Run: const result = runSelfTests(); -> { passed, failed, total, ms, results: [{ name, ok, error }] }

function selfTestOk(name, condition, detail) {
    return { name, ok: Boolean(condition), error: condition ? '' : (detail || 'expected a truthy result') };
}

function selfTestEqual(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return { name, ok, error: ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
}

function selfTestThrows(name, fn) {
    try {
        fn();
        return { name, ok: false, error: 'expected a thrown Error, nothing was thrown' };
    } catch (err) {
        return { name, ok: err instanceof Error, error: err instanceof Error ? '' : 'threw something that is not an Error' };
    }
}

function selfTestSkip(name, reason) {
    return { name, ok: true, skipped: reason || 'not applicable here', error: '' };
}

function selfTestGroup(group, tests) {
    return tests.map(test => ({ ...test, group }));
}

function selfTestUrlCleaning() {
    const tests = [];
    tests.push(selfTestEqual('utm_* and fbclid come off', stripTrackingParams('https://e.com/p?utm_source=a&fbclid=b&keep=1'), 'https://e.com/p?keep=1'));
    tests.push(selfTestEqual('a duplicated si parameter is fully dropped', stripTrackingParams('https://e.com/p?si=1&si=2&x=3'), 'https://e.com/p?x=3'));
    tests.push(selfTestEqual('a plain URL is untouched', stripTrackingParams('https://e.com/a/b?x=1&y=2'), 'https://e.com/a/b?x=1&y=2'));
    tests.push(selfTestEqual('rubbish in, rubbish out', stripTrackingParams('not a url at all'), 'not a url at all'));
    tests.push(selfTestEqual('an empty string survives', stripTrackingParams(''), ''));
    tests.push(selfTestEqual('the Google search URL is canonicalised', canonicalObsidianUrl('https://www.google.com/search?q=bookmark+editor&sxsrf=x&oq=bookmark&utm_source=chrome'), 'https://www.google.com/search?q=bookmark+editor'));
    tests.push(selfTestEqual('its query is URL-encoded', canonicalObsidianUrl('https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E'), 'https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E'));
    tests.push(selfTestEqual('YouTube keeps the id and drops the timestamp', canonicalObsidianUrl('https://www.youtube.com/watch?v=abc&t=30&si=x'), 'https://www.youtube.com/watch?v=abc'));
    tests.push(selfTestEqual('youtu.be shortens the same way', canonicalObsidianUrl('https://youtu.be/abc?si=x&t=10'), 'https://www.youtube.com/watch?v=abc'));
    tests.push(selfTestEqual('cleanCopyUrl is strip then canonicalise', cleanCopyUrl('https://www.youtube.com/watch?v=abc&utm_medium=s#frag'), canonicalObsidianUrl(stripTrackingParams('https://www.youtube.com/watch?v=abc&utm_medium=s#frag'))));
    tests.push(selfTestEqual('hasCleanableUrl only when cleaning changes it', [hasCleanableUrl('https://e.com/p?utm_source=x'), hasCleanableUrl('https://e.com/p')], [true, false]));
    tests.push(selfTestEqual('trackingParamKeys reports what it would drop', trackingParamKeys(new URL('https://e.com/p?utm_source=a&fbclid=b&keep=1')).map(item => item.key).sort(), ['fbclid', 'utm_source']));
    tests.push(selfTestEqual('a Google redirect unwraps to its target', canonicalObsidianUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage'), 'https://example.com/page'));
    tests.push(selfTestOk('a javascript: redirect is not unwrapped', canonicalObsidianUrl('https://www.google.com/url?q=javascript:alert(1)').startsWith('https://www.google.com/')));
    tests.push(selfTestOk('an unparseable redirect target is not unwrapped', canonicalObsidianUrl('https://www.google.com/url?q=not%20a%20url').startsWith('https://www.google.com/')));
    return selfTestGroup('URL cleaning', tests);
}

function selfTestUrlRules() {
    const tests = [];
    const defaults = getActiveUrlRules();
    tests.push(selfTestOk('the built-ins describe six rules', defaults.length === 6, `got ${defaults.length}`));
    tests.push(selfTestOk('a round trip through JSON is lossless', JSON.stringify(urlRulesFromJson(urlRulesToJson(defaults))) === JSON.stringify(defaults)));
    tests.push(selfTestThrows('not JSON is rejected', () => urlRulesFromJson('not json')));
    tests.push(selfTestThrows('an unknown builtin is rejected', () => urlRulesFromJson('[{"kind":"builtin","name":"nope"}]')));
    tests.push(selfTestThrows('a bad match mode is rejected', () => urlRulesFromJson('[{"kind":"params","match":"glob","value":"x"}]')));
    tests.push(selfTestThrows('an invalid regex is rejected', () => urlRulesFromJson('[{"kind":"params","match":"regex","value":"([unclosed"}]')));
    tests.push(selfTestOk('every builtin is a function', Object.values(URL_RULE_BUILTINS).every(fn => typeof fn === 'function')));
    const custom = [{ kind: 'params', name: 'affiliate', match: 'exact', value: 'tag', enabled: true }];
    tests.push(selfTestEqual('a custom rule applies', testUrlRules('https://s.example/p?tag=1&keep=2', custom).stripped, 'https://s.example/p?keep=2'));
    tests.push(selfTestEqual('an empty list cleans nothing', testUrlRules('https://e.com/p?utm_source=x', []).stripped, 'https://e.com/p?utm_source=x'));
    tests.push(selfTestEqual('activating custom rules changes the cleaners', (() => {
        const before = stripTrackingParams('https://e.com/p?utm_source=x');
        setActiveUrlRules(custom);
        const after = stripTrackingParams('https://e.com/p?utm_source=x');
        resetUrlRules();
        return [before, after, stripTrackingParams('https://e.com/p?utm_source=x')];
    })(), ['https://e.com/p', 'https://e.com/p?utm_source=x', 'https://e.com/p']));
    const steps = testUrlRules('https://www.youtube.com/watch?v=abc&utm_medium=s&si=x');
    tests.push(selfTestOk('testUrlRules reports one step per changing rule', steps.steps.length >= 2, `got ${steps.steps.length}`));
    tests.push(selfTestEqual('testUrlRules.stripped matches stripTrackingParams', steps.stripped, stripTrackingParams('https://www.youtube.com/watch?v=abc&utm_medium=s&si=x')));
    tests.push(selfTestEqual('testUrlRules.canonical matches cleanCopyUrl', steps.canonical, cleanCopyUrl('https://www.youtube.com/watch?v=abc&utm_medium=s&si=x')));
    tests.push(selfTestOk('a disabled rule is described as disabled', describeUrlRule({ kind: 'params', value: 'x', enabled: false }).indexOf('disabled') > -1));
    return selfTestGroup('URL rule engine', tests);
}

function selfTestNetscape() {
    const tests = [];
    const tree = {
        typeCode: 2,
        title: 'Bookmarks',
        children: [
            { typeCode: 1, title: 'A & B', uri: 'https://a.example/?utm_source=x', dateAdded: 1600000000, lastModified: 1600000100 },
            { typeCode: 2, title: 'Nested <folder>', children: [{ typeCode: 1, title: 'Inner', uri: 'https://b.example/i' }] },
            { typeCode: 2, title: 'Empty', children: [] }
        ]
    };
    const html = netscapeBookmarkHtml(tree, { title: 'Bookmarks', wrap: false });
    tests.push(selfTestOk('the doctype and title are written', html.indexOf('<!DOCTYPE NETSCAPE-Bookmark-file-1>') === 0 && html.indexOf('<TITLE>Bookmarks</TITLE>') > 0, html.slice(0, 80)));
    tests.push(selfTestOk('entities are escaped in titles', html.indexOf('A &amp; B') > -1 && html.indexOf('Nested &lt;folder&gt;') > -1));
    tests.push(selfTestOk('tracking parameters are kept in the file', html.indexOf('utm_source=x') > -1));
    tests.push(selfTestOk('dates are written as seconds', html.indexOf('ADD_DATE="1600000000"') > -1 && html.indexOf('LAST_MODIFIED="1600000100"') > -1));
    tests.push(selfTestOk('every folder gets its own list, even empty ones', (html.match(/<DL><p>/g) || []).length === 3, `${(html.match(/<DL><p>/g) || []).length} lists`));
    const parsed = parseNetscapeBookmarks(html);
    tests.push(selfTestOk('the parse finds the same nesting', parsed.entries.length === 3 && parsed.entries[1].children.length === 1, JSON.stringify(parsed.entries.map(entry => entry.title))));
    tests.push(selfTestEqual('titles come back decoded', parsed.entries[0].title, 'A & B'));
    tests.push(selfTestEqual('dates come back as milliseconds', parsed.entries[0].dateAdded, 1600000000000));
    tests.push(selfTestEqual('the URL survives the round trip', parsed.entries[0].uri, 'https://a.example/?utm_source=x'));
    tests.push(selfTestEqual('an empty folder survives as an empty folder', parsed.entries[2].children.length, 0));
    tests.push(selfTestOk('a separator is skipped', parseNetscapeBookmarks('<DL><p><DT><HR><DT><A HREF="https://x.example/">X</A></DL>').entries.length === 1));
    tests.push(selfTestOk('a filename is suggested per folder', /\.html$/.test(netscapeBookmarkFileName('My Folder'))));
    return selfTestGroup('Netscape reader and writer', tests);
}

function selfTestTitlesAndKeys() {
    const tests = [];
    tests.push(selfTestEqual('a matching site suffix is stripped', titleSuffixToStrip('Firefox — Mozilla', 'https://www.mozilla.org/firefox/'), 'Firefox'));
    tests.push(selfTestEqual('a non-matching suffix is left alone', titleSuffixToStrip('Postgres - Wikipedia', 'https://www.postgresql.org/docs/'), null));
    tests.push(selfTestEqual('a title is never emptied', titleSuffixToStrip('- Mozilla', 'https://mozilla.org/'), null));
    tests.push(selfTestEqual('spaces collapse and edge separators go', titleTrimSeparators('  Hello   world |  '), 'Hello world'));
    tests.push(selfTestEqual('long ALL CAPS folds', titleFoldAllCaps('THE QUICK BROWN FOX'), 'The quick brown fox'));
    tests.push(selfTestEqual('a short acronym is kept', titleFoldAllCaps('NASA'), 'NASA'));
    tests.push(selfTestEqual('edge emoji come off', titleStripEdgeEmoji('🎉 Hello 🎉'), 'Hello'));
    tests.push(selfTestEqual('an emoji-only title is kept', titleStripEdgeEmoji('🎉'), '🎉'));
    tests.push(selfTestEqual('mid-title emoji are untouched', titleStripEdgeEmoji('mid🎉dle'), 'mid🎉dle'));
    tests.push(selfTestOk('planTitleCleanup reports the rules that fired', (() => { const plan = planTitleCleanup('THE QUICK BROWN FOX', 'https://e.com/'); return plan && plan.rules.includes('caps'); })()));
    // Two deliberately different keys: bookmarkUrlKey is tracking-insensitive (it runs the
    // cleaning rules), duplicateUrlKey is exact apart from the host, trailing slashes and a
    // YouTube id. That is why the "same title and domain" scan exists on top of the duplicate
    // scan. Both behaviours are pinned here so a change to either is caught.
    tests.push(selfTestOk('bookmarkUrlKey keeps tracking parameters (it only canonicalises)', bookmarkUrlKey('https://e.com/p?utm_source=a') !== bookmarkUrlKey('https://e.com/p?utm_medium=b')));
    tests.push(selfTestEqual('libraryUrlKey treats different trackers as one page', libraryUrlKey('https://e.com/p?utm_source=a'), libraryUrlKey('https://e.com/p?utm_medium=b')));
    tests.push(selfTestEqual('libraryUrlKey folds YouTube variants together', libraryUrlKey('https://youtu.be/abc?si=x'), libraryUrlKey('https://www.youtube.com/watch?v=abc&t=30')));
    tests.push(selfTestOk('bookmarkUrlKey keeps real parameters apart', bookmarkUrlKey('https://e.com/p?x=1') !== bookmarkUrlKey('https://e.com/p?x=2')));
    tests.push(selfTestEqual('bookmarkUrlKey folds YouTube links to one id', bookmarkUrlKey('https://youtu.be/abc?si=x'), 'youtube.com/watch?v=abc'));
    if (typeof duplicateUrlKey === 'function') {
        tests.push(selfTestOk('duplicateUrlKey is exact about parameters', duplicateUrlKey('https://e.com/p?utm_source=a') !== duplicateUrlKey('https://e.com/p?utm_medium=b')));
        tests.push(selfTestEqual('duplicateUrlKey drops www and a trailing slash', duplicateUrlKey('https://www.e.com/p/'), duplicateUrlKey('https://e.com/p')));
        tests.push(selfTestOk('duplicateUrlKey keeps real parameters apart', duplicateUrlKey('https://e.com/p?x=1') !== duplicateUrlKey('https://e.com/p?x=2')));
    } else {
        tests.push(selfTestSkip('duplicateUrlKey checks', 'dupe-cleanup.js is not loaded in this page'));
    }
    tests.push(selfTestEqual('mdLinkLine builds a markdown link', mdLinkLine({ title: 'T', uri: 'https://e.com/p?utm_source=x' }, 0), '- [T](https://e.com/p)'));
    return selfTestGroup('Titles, keys and markdown', tests);
}

function runSelfTests() {
    const started = Date.now();
    const suites = [selfTestUrlCleaning, selfTestUrlRules, selfTestNetscape, selfTestTitlesAndKeys];
    const results = [];
    suites.forEach(suite => {
        try {
            results.push(...suite());
        } catch (err) {
            results.push({ group: 'suite', name: `${suite.name} threw`, ok: false, error: err && err.message ? err.message : String(err) });
        }
    });
    const passed = results.filter(result => result.ok).length;
    const skipped = results.filter(result => result.skipped).length;
    return { passed, failed: results.length - passed, skipped, total: results.length, ms: Date.now() - started, results };
}

function selfTestsSummaryHtml(run) {
    const esc = typeof escapeHtml === 'function' ? escapeHtml : value => String(value == null ? '' : value);
    const failures = run.results.filter(result => !result.ok);
    const groups = [...new Set(run.results.map(result => result.group))];
    return `<p><strong>${run.passed} passed, ${run.failed} failed${run.skipped ? `, ${run.skipped} skipped` : ''}</strong> of ${run.total} check(s) in ${run.ms} ms.</p>
        ${groups.map(group => {
            const rows = run.results.filter(result => result.group === group);
            const bad = rows.filter(result => !result.ok).length;
            return `<p class="stats-report-note">${esc(group)}: ${rows.length - bad}/${rows.length} passed</p>`;
        }).join('')}
        ${failures.length ? `<table class="excel-table"><thead><tr><th>Suite</th><th>Check</th><th>What went wrong</th></tr></thead><tbody>
            ${failures.map(result => `<tr><td>${esc(result.group)}</td><td>${esc(result.name)}</td><td>${esc(result.error)}</td></tr>`).join('')}
        </tbody></table>` : '<p>Every check passed.</p>'}`;
}

function selfTestsMarkdown(run) {
    const lines = [`Self-tests: ${run.passed} passed, ${run.failed} failed of ${run.total} (${run.ms} ms)`, ''];
    run.results.forEach(result => lines.push(`- ${result.ok ? 'PASS' : 'FAIL'} ${result.group} — ${result.name}${result.ok ? '' : `: ${result.error}`}`));
    return lines.join('\n');
}
