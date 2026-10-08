# Bookmark Editor

A bookmark manager that runs entirely on your own machine. Browse, edit, reorganise, deduplicate and
audit a Firefox bookmark library, and send links into Obsidian — as either a Firefox extension or a
standalone page that reads a bookmarks JSON export.

Nothing is sent anywhere. There is no server, no build step and no dependency install: the app is plain
JavaScript loaded straight from these files.

## Two builds, one codebase

| Build | What it is | How to run |
| --- | --- | --- |
| `live/` | Firefox extension (Manifest V2) — reads and writes the real bookmark library | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `live/manifest.json` |
| `json/` | The same app as a standalone page, working on a JSON export | Open `json/bookmark-editor-v1.0.html` in a browser |

The two builds share their scripts, styles and documentation and must stay in step. Everything under
`js/bookmark-lib.js`, `js/statistics.js`, `js/docs.js`, `js/open-tabs.js`, `js/background.js`,
`bookmark-editor-v1.0.js` and `bookmark-editor-v1.0.css` is identical between the two directories — only
the pages and the extension-only scripts (`js/bookmarks-live.js`, `js/obsidian-launch.js`) differ.

## What it does

**Library work.** Browse the tree with folder and bookmark metadata; multi-select; move, reorder, rename,
copy, cut and paste; merge folders; delete to a trash with undo; create nested folders; preview every
change before it happens.

**Finding things.** Search across titles, URLs and folders; filter by domain, folder or date; a changed-
only view; sortable columns everywhere.

**Duplicates.** Find duplicate bookmarks by URL, review them in groups, and remove the extras in one
undoable step.

**Link checking.** Check bookmarks for dead links and repair the results.

**Statistics.** Per-folder counts, a by-domain table with sortable headers, activity over time, and a
wrapped year-in-review view.

**Open Tabs.** Every window and tab, with search chains grouped by the search that opened them, pinned
tabs, duplicate detection, per-row and per-window actions, and multi-select for bulk work: bookmark the
selection, send it to Obsidian, move it into another window or a new one, close it, or close it without
bookmarking. Rows can be collapsed per window, filtered, and condensed for density.

**Obsidian.** Send a bookmark, a folder listing, a search chain or a whole window into a note — at the
cursor of the note you are editing, or appended to today's daily note, with foldering by source. A local
fork of [Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) adds the `insertatcursor`
parameter this uses; see *Obsidian URIs* below.

**Firefox integration.** Native context menus for links, tabs, windows and bookmarks, including *Send
folder to Obsidian*, plus a toolbar button that opens the library window.

**Automatic tidying.** Optionally collect links from the toolbar and other locations into Other Bookmarks
on a timer or from a folder pill.

**Appearance.** Light and dark themes, with an automatic setting that follows the system, plus a compact
density.

## Obsidian URIs

The app builds `obsidian://` links, so any link it produces can be reused by hand:

| Parameter | Values | Meaning |
| --- | --- | --- |
| `insertatcursor` | text | Write into the active editor. `{{clipboard}}` expands to the system clipboard. |
| `insertposition` | `caret`, `end` | Insert at the cursor, or at the end of the note. |
| `insertline` | `after`, `under` | A sibling line at the current depth, or nested one level beneath it. |
| `insertfallback` | `notice`, `daily` | With no editor open: show a notice, or append to the daily note. |

At-cursor sends use `obsidian://advanced-uri?insertatcursor=…`; daily-note sends use
`obsidian://adv-uri?filepath=…&mode=append&separator=&data=…`.

## Layout

```
live/                     the extension build
  manifest.json           MV2 manifest
  bookmark-editor-v1.0.html / .js / .css
  js/                     shared modules: library, statistics, docs, open tabs, background, live bridge
  icons/
json/                     the standalone build (same modules, no extension)
tools/
  check-listeners.js      verifies the extension's listener surface
prompt.md                 working notes
```

## Checks

```bash
node tools/check-listeners.js     # the extension's listeners, and that both builds match
```

It names the listeners the background script must register — the toolbar icon, context-menu clicks, the
runtime messages, tab and bookmark events, alarms — and fails if one is missing or has been disabled.
Dropping one is invisible in review and silent at runtime: the feature simply stops responding, which is
exactly how the toolbar button and every context-menu action broke at one point.

The app also ships its own test pages: open `live/self-test.html` (or `json/self-test.html`) and read the
pass/fail list.

## Notes and limits

- Built and tested against **Firefox**. The `browser.*` APIs are used in their promise form; Chromium has
  not been tested.
- Loading `live/` as a temporary add-on means it is gone when Firefox restarts — package or sign it for
  anything permanent.
- The extension only reads a library it has permission for: the JSON build is the safe way to try changes
  against an export.

## Credits

The Obsidian insertion feature builds on
[obsidian-advanced-uri](https://github.com/Vinzent03/obsidian-advanced-uri) by Vinzent, under its original
licence. This app's Obsidian support is a locally modified fork of that plugin, installed as
`advanced-uri-local` so it can sit alongside the original.
