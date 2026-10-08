#!/usr/bin/env node
/*
 * Guards the extension's listener surface.
 *
 * The background script registers everything the browser talks to: the toolbar icon, the context
 * menus, the runtime messages, the tab and bookmark events, the alarms. Each is a single addListener
 * line, so an edit that drops one is invisible in review and silent at runtime — the feature simply
 * stops answering. That happened twice: the toolbar icon stopped opening the library window, and every
 * context-menu action (including "Send folder to Obsidian") went dead, because the menus.onClicked
 * listener was gone.
 *
 * This script names the listeners that must exist, fails if any is missing, and fails if one is
 * present but disabled (wrapped in a condition that never runs).
 *
 *   node tools/check-listeners.js            # both builds, plus the mirror check
 *   node tools/check-listeners.js live/js/background.js
 */
const fs = require('fs');

// Each entry: the label to report, and a pattern the file must contain.
const REQUIRED = [
    ['toolbar icon opens the editor', /\.(browserAction|action)\.onClicked\.addListener\(\s*openEditor\s*\)/],
    ['context menu clicks', /menus\.onClicked\.addListener\(/],
    ['context menu shown (visibility pass)', /menus\.onShown\.addListener\(/],
    ['runtime messages', /\.runtime\.onMessage\.addListener\(/],
    ['install and startup', /\.runtime\.on(Installed|Startup)\.addListener\(/],
    ['tab created / activated / updated', /\.tabs\.on(Created|Activated|Updated)\.addListener\(/],
    ['alarms', /\.alarms\.onAlarm\.addListener\(/],
    ['bookmark changes invalidate the link cache', /invalidateLinkCache/]
];

// A listener can also be present but unreachable, which still reads as present to a text search.
const DEAD = [/if \(false\)/, /DISABLED\(/, /listener removed/];

function checkFile(file) {
    const source = fs.readFileSync(file, 'utf8');
    const missing = REQUIRED.filter(item => !item[1].test(source)).map(item => item[0]);
    const dead = DEAD.filter(pattern => pattern.test(source)).map(pattern => String(pattern));
    return { missing, dead };
}

function main() {
    const args = process.argv.slice(2);
    const targets = args.length ? args : ['live/js/background.js', 'json/js/background.js'];
    let failures = 0;
    for (const file of targets) {
        if (!fs.existsSync(file)) {
            console.log('   FAIL  ' + file + ' does not exist');
            failures++;
            continue;
        }
        const { missing, dead } = checkFile(file);
        for (const label of missing) {
            console.log('   FAIL  ' + label + '  [missing from ' + file + ']');
        }
        if (dead.length) {
            console.log('   FAIL  a listener is present but disabled (' + dead.join(', ') + ')  [' + file + ']');
        }
        failures += missing.length + dead.length;
        const present = REQUIRED.length - missing.length;
        const verdict = missing.length || dead.length ? 'FAIL' : 'PASS';
        console.log('   ' + verdict + '  ' + present + '/' + REQUIRED.length + ' listeners present in ' + file);
    }
    // The two builds ship the same background script, so drift here is a bug of its own.
    if (!args.length) {
        const same = fs.readFileSync('live/js/background.js').equals(fs.readFileSync('json/js/background.js'));
        if (!same) failures++;
        console.log('   ' + (same ? 'PASS' : 'FAIL') + '  live and json background scripts are identical');
    }
    console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall listener checks passed');
    process.exit(failures ? 1 : 0);
}

main();
