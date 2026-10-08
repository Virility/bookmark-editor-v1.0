// In-app manual. Classic globals. Copied into json/ and live/.
function isLiveEditorCopy() {
    return typeof isLiveBookmarks === 'function' ? isLiveBookmarks() : typeof liveCreateNode === 'function';
}

function editorCopyName() {
    return isLiveEditorCopy() ? 'Live extension' : 'JSON file editor';
}

const APP_DOC = [
    {
        id: 'start',
        title: 'What this app is, and which copy you have',
        html: `
<h3>Two builds, one interface</h3>
<p>The same editor ships twice. <strong>Live extension</strong> reads your real bookmarks through the browser's
bookmarks API and writes changes straight back to them. <strong>JSON file editor</strong> opens an exported
<code>.json</code> file, edits it and downloads the result. The interface, the search, the statistics and the repair
tools are identical; only the way data arrives and leaves differs, and the differences are collected in
<em>Storage, export and import</em>.</p>
<p>Every page states which copy you are in, and the manual's first lines here are the same text for both. If a button
would write to the browser but you have a file open, the app says so rather than pretending.</p>
<h3>The shape of the thing</h3>
<ul>
<li><strong>A library view</strong> for browsing, searching and editing bookmarks as a tree.</li>
<li><strong>Statistics</strong> over your bookmark history: domains, sessions, bursts and rankings.</li>
<li><strong>Open Tabs</strong> for the windows and tabs the browser has open right now.</li>
<li><strong>Actions</strong> for the repair and cleanup tools, plus <strong>Script Lab</strong> for writing your own.</li>
<li><strong>Affected Links Log</strong>, a running record of what was changed and when.</li>
<li><strong>Settings</strong> and this <strong>manual</strong>.</li>
</ul>
<h3>Nothing happens by surprise</h3>
<p>Anything destructive is previewed or undoable. Deletes go to an in-app trash with an undo window, scans only
report until you apply them, and every write is logged in the affected-links log with its source.</p>
`
    },
    {
        id: 'layout',
        title: 'Getting around: the seven views',
        html: `
<h3>The tab strip</h3>
<p>Seven views share one page, in this order: <strong>Open Tabs</strong>, <strong>Bookmarks</strong> (the one you land on),
<strong>Statistics</strong>, <strong>Actions</strong>, <strong>Affected Log</strong>, <strong>Settings</strong> and
<strong>Documentation</strong> (this manual).
Exactly one is visible at a time; the strip keeps your place and the Open Tabs tab carries a live count of open tabs.</p>
<h3>What each view is for</h3>
<ul>
<li><strong>Bookmarks</strong> — the tree, the folder heading, the search box and everything that edits a bookmark.</li>
<li><strong>Statistics</strong> — how your library has been used over time, with a detail panel for any row.</li>
<li><strong>Open Tabs</strong> — windows and their tabs, with sorting, saving and cleanup for what is open now.</li>
<li><strong>Actions</strong> — scans and repairs grouped by what they touch (YouTube, Hacker News, Reddit, Meta, general, duplicates, nearby, link check), plus Script Lab.</li>
<li><strong>Affected Log</strong> — the audit trail, newest first.</li>
<li><strong>Settings</strong> — tidy schedule, search syntax, URL cleaning rules, stored data, the live write outbox and scheduled jobs.</li>
<li><strong>Manual</strong> — this document, with a filter box and a jump list.</li>
</ul>
<h3>Small conventions</h3>
<p>A view keeps its own scroll position and its own toolbar. Where a tool could not do anything useful it is
<em>disabled with the reason in its tooltip</em> rather than hidden mid-task, and where an item would be meaningless it
is not shown at all. Toasts report what finished; the affected log keeps the detail.</p>
`
    },
    {
        id: 'library',
        title: 'The bookmark library',
        html: `
<h3>The tree, and where you are</h3>
<p>The library draws your bookmarks as a tree. Selecting a folder makes it the current one: the heading above the list
names it, a chip shows its parent (click it to go up; a subreddit folder is named by its short label there, not by its full title with every subreddit in it), and the subreddit pills next to it are shortcuts back to the
folders a Reddit clean-up would use. The path in the row tooltips is deliberately short — the folder name, not the
whole ancestry. The parent chip only offers a step up when there is a folder above this one: a top-level folder has
no chip, because the library root is not a place you navigate to.</p>
<h3>Working with rows</h3>
<ul>
<li><strong>Select</strong> one row, or several: click with <code>shift</code> for a range, <code>ctrl</code>/<code>cmd</code> to add or remove one.</li>
<li><strong>The header’s Library menu is grouped too.</strong> Its items sit under <em>Live library</em>, <em>Import and backup</em> (with the merge policy beside it), <em>Settings</em> and <em>Tools</em> captions, separated by a line, so the long list reads in sections rather than as one column.</li>
<li><strong>Every row has a menu</strong> — the same actions as the right-click menu, closest to the pointer: open in a new tab, edit title, edit URL, add or edit a note, move, nest in a new folder, delete. The right-click menu is <strong>grouped</strong>: <em>Create</em>, <em>Edit</em>, <em>Remove</em>, <em>Open and find</em>, <em>Send</em>, <em>Folder</em>, <em>Move</em>. A caption is only there while its group has something in it — a folder has no <em>Copy</em>, a bookmark has no <em>Export as HTML</em> — and a group never leaves a rule behind.
</li><li><strong>Go to its folder</strong> (in the row menu, under Edit) is for a row you are seeing away from home — a search result, or a recursive listing: it clears the search, unfolds the tree to the folder the entry lives in, opens that folder, and lands with the entry selected and scrolled to.</li>
<li><strong>Sort</strong> by title, date added, date modified, URL or manual order; the choice is remembered per folder.</li>
<li><strong>Columns and density</strong> are settings, not one-off toggles, so the table looks the same when you come back.</li>
<li><strong>The tree filter</strong> narrows the tree itself, expanding every folder that survived the filter and restoring the exact expansion you had when you clear it.</li>
</ul>
<h3>Reading a folder</h3>
<p>The line above the list counts what is inside — bookmarks here, bookmarks with subfolders, folders, empty folders —
and adds the added/modified dates and the folder's path. When a <em>scoped</em> search finds nothing, that line offers a
<strong>search everywhere</strong> button rather than leaving an empty list looking broken.</p>
<h3>Protecting things</h3>
<p>Folders and bookmarks can be protected from scans and cleanup tools. Protected items are skipped by the everywhere
search and by the repair tools, and they say so in their tooltip; nothing about protection hides them from you.</p>
`
    },
    {
        id: 'editing',
        title: 'Editing, moving and deleting',
        html: `
<h3>What you can change</h3>
<ul>
<li><strong>Title</strong> and <strong>URL</strong> — inline, in a dialog, or in bulk from a CSV-style paste.</li>
<li><strong>Notes</strong> — a note per bookmark, kept beside the library and searchable with <code>has:note</code> and <code>is:noted</code>.</li>
<li><strong>New bookmark, new folder</strong> — created inside the current folder; a new folder defaults to a name that does not collide with its siblings.</li>
<li><strong>Move and nest</strong> — drag, move to a folder, or <em>Nest in new folder</em>, which creates the folder in the entry's own parent at its index and offers an undo for five minutes.</li>
<li><strong>Delete</strong> — one row or many. Deletes land in the in-app trash, which can restore them or empty itself.</li>
</ul>
<h3>Bulk edits</h3>
<p>Paste a list of changes and they are previewed before anything is written: the preview dialog lists every affected
entry with its old and new value, and only <em>Apply</em> writes them. The same preview stands in front of the repair
tools, dead-link deletion and epoch application.</p>
<h3>Tags</h3>
<p>There is no tag editor, because the browser's bookmark API does not expose tags and this app does not store its own.
The <code>tag:</code> search operator exists for imported JSON files that carry a <code>tags</code> field — see the
search FAQ for the exact behaviour.</p>
<h3>Undo</h3>
<p><code>ctrl</code>/<code>cmd</code>+<code>z</code> undoes the last change and <code>ctrl</code>/<code>cmd</code>+<code>shift</code>+<code>z</code>
redoes it. Deletes and nest operations carry their own timed undo in the menu, so the quick path never depends on
remembering a shortcut.</p>
`
    },
    {
        id: 'search',
        title: 'Search: the box, the filters and the scope',
        html: `
<h3>One box, one source of truth</h3>
<p>The search box and the Filters panel are the same query seen two ways. The panel is the clickable face of the
syntax: a row for each operator family with the right kind of control (text, after/before months, choices for
<code>has:</code> and <code>is:</code>, an exclude box, a regex box). Opening the panel fills it from whatever is in
the box — and, for the folder box, from the folder the sidebar has open when the box is empty (see
<em>Scope, timing and history</em>); applying it rebuilds the query as your plain words plus the panel's tokens, and strips those tokens back out
of the free text so nothing is written twice.</p>
<h3>Operators</h3>
<table>
<tr><th>Family</th><th>Form</th><th>Matches</th></tr>
<tr><td><code>domain:</code></td><td><code>domain:example.com</code></td><td>a host, any subdomain, an IP, or an internal scheme (<code>domain:about</code> finds every <code>about:</code> link)</td></tr>
<tr><td><code>folder:</code></td><td><code>folder:Cats</code></td><td>a folder path inside the current scope</td></tr>
<tr><td><code>title:</code></td><td><code>title:postgres</code></td><td>text in the title</td></tr>
<tr><td><code>url:</code></td><td><code>url:docs</code></td><td>text in the URL</td></tr>
<tr><td><code>tag:</code></td><td><code>tag:recipe</code></td><td>a <code>tags</code> field on the record (imported files only)</td></tr>
<tr><td><code>type:</code></td><td><code>type:pdf</code>, <code>type:image</code>, <code>type:web</code></td><td>an extension, a family, or a kind</td></tr>
<tr><td><code>added:</code></td><td><code>added:&gt;2024-01</code></td><td>added after or before a month or date; a bare date means that day</td></tr>
<tr><td><code>has:</code></td><td><code>has:note</code>, <code>dupe</code>, <code>tracked</code>, <code>folder</code>, <code>date</code></td><td>the entry has that thing</td></tr>
<tr><td><code>is:</code></td><td><code>is:folder</code>, <code>bookmark</code>, <code>untitled</code>, <code>tracked</code>, <code>dupe</code>, <code>noted</code></td><td>the entry is that thing</td></tr>
<tr><td><code>-word</code></td><td><code>-spam</code>, <code>-spam,-draft</code></td><td>must not appear</td></tr>
<tr><td><code>/pattern/</code></td><td><code>/^how to .*\d+$/i</code></td><td>a regular expression over the fields</td></tr>
</table>
<p>Several values per operator and a repeated operator mean the same thing: <code>domain:a.com, b.com</code> is
<code>domain:a.com domain:b.com</code>. Quoted values keep their spaces. Plain words are substring matches over the
title, URL, folder path and tags.</p>
<h3>Scope, timing and history</h3>
<ul>
<li><strong>The folder box follows the tree — and waits for Apply.</strong> Whichever folder is open in the sidebar is the <code>folder:</code> filter's default: opening the panel puts it in the folder box, where it <em>stands by</em> without being searched — clicking the search box opens this panel, and searching a whole folder just because you clicked would freeze a large library. <strong>Apply filters</strong> — up beside the <em>Search filters</em> title, greyed and quiet until something is waiting, then faintly lit — folds it, and everything else in the boxes, into the query and searches. Typing in the box yourself applies as before; a value you type or pick is yours and stops the following; the × clears it, and the next folder you click sets it again. Moving to another folder in the tree takes back the default it wrote, so a tree click never re-runs a scoped search over everything.</li>
<li><strong>Whole words, from the panel or from Settings.</strong> The Filters panel has a <em>Matching</em> row with a <em>Whole words</em> box: with it ticked, <em>Tron</em> finds Tron but not Electronics — matching on word boundaries, so <code>post*</code> still works inside a word, and tags are always matched whole. It is the same switch as Settings → Search syntax, so the two never disagree; unlike the panel's text fields it applies on the click, because it changes how the query you already typed matches.</li>
<li><strong>Exhaustive search, if you want it.</strong> Settings → Search syntax has an off-by-default <em>Exhaustive search (slow, quadratic)</em> switch. With it on, a search trusts nothing: every bookmark's folder path is re-derived by walking the library, the tracked/duplicate sets are rebuilt, and the cached index is not used at all — the old, slow way of searching, kept because it is the way to confirm a result the fast path may have missed. It is quadratic, so expect seconds on a large library; the meta line marks such a search <em>exhaustive, uncached</em>. The folder picker's outline follows the same switch (walking parents instead of reading the map its last walk filled). With the caches correct the two agree hit for hit.</li>
<li><strong>The selected folder's tree row says how much of the listing you are seeing.</strong> A chip on that row compares the rows on screen with the rows there are to load — <em>300 / 441</em> while a wide search is drawn a page at a time, <em>2 / 2</em> once everything that listing has is on screen (the second number is the entries the listing would draw, the same figure the pager's <em>Show N more of M</em> uses, not every bookmark buried in the folder's subfolders). The tooltip says both numbers, names the scope, notes when a search or the filters decide which rows those are, and points at <em>Show more</em> while rows are still held back. It is on the row you have selected, and only there.</li>
<li><strong>Long result lists are paged.</strong> The table draws the first 300 rows and offers <em>Show N more of M</em> beside <em>Show all M</em> under them (the second draws the whole list at once, which is slower); while fewer than all hits are on screen the meta line says “showing the first N”. Every hit is still counted for the totals, select-all, the row actions, the exports and the reports — only the drawing is limited, so a search that matches thousands of bookmarks can no longer lock the page up.</li>
<li><strong>Main folders are always listed, and open everything inside them.</strong> The folder list is an indented outline whenever the box is empty or holds the folder the tree has open; type anything else and it becomes a flat list of matching paths. The library's own roots — Bookmarks Toolbar, Bookmarks Menu, Other Bookmarks, Mobile Bookmarks — are always listed, however long a branch or narrow a search, and clicking one unfolds every folder beneath it at once, listed straight after it with one indent per level; clicking it again folds the whole branch away. Deeper folders keep the one-caret-at-a-time toggle, so a big tree can still be opened a piece at a time.</li>
<li><strong>Recursive search</strong> unticked searches the current folder; ticked, it and its subfolders. <strong>Search everywhere</strong> searches all four roots.</li>
<li>Typing waits 300 ms of quiet before searching — the usual debounce for a search box, so a word is searched once rather than once per letter. Enter, leaving the box and <em>Apply filters</em> act immediately.</li>
<li>A further second of quiet files the query into <strong>recent searches</strong>, which is the first thing in the panel. Each entry has its own remove button; <em>Clear history</em> appears only when there is something to clear, and removing the entry that is in the box cancels the pending save so it stays removed.</li>
<li><strong>Saved searches</strong> (stored smart folders) appear at the top of the sidebar and restore their query along with the everywhere and recursive flags. They store the query text, so everything the parser understands works in them — but the <em>Save search</em> control was deliberately removed in this build, so existing ones can be opened and deleted, not created.</li>
</ul>
<h3>Optional by design</h3>
<p>Settings → Search syntax has one master switch and a checkbox per family. With the master off the whole query is one
literal phrase — dashes, colons and slashes included — and the Filters panel does not open at all. With one family
unticked, only that family's tokens become literal text, so nothing is silently reinterpreted.</p>
`
    },
    {
        id: 'faq-search',
        title: 'FAQ: search use cases and edge cases',
        html: `
<h3>Either, both, or neither</h3>
<ul>
<li><strong>Either of two:</strong> <code>title:postgres OR title:mysql</code> — <code>|</code> works too. OR binds loosest, then AND, then a leading dash.</li>
<li><strong>Both, deliberately:</strong> <code>title:postgres AND title:tutorial</code> requires both, so it matches only a title carrying the two words.</li>
<li><strong>Two values side by side still mean either:</strong> <code>title:postgres title:tutorial</code> is the OR form — the behaviour the search has always had, kept so old queries do not change meaning.</li>
<li><strong>Grouping:</strong> <code>(title:postgres OR tag:reference) type:web</code>.</li>
<li><strong>Excluding one thing:</strong> <code>postgres -tutorial</code>.</li>
<li><strong>Excluding a group:</strong> <code>-(title:postgres OR title:tutorial)</code> matches everything the group does not.</li>
</ul>
<h3>Wildcards</h3>
<ul>
<li><code>title:post*</code> starts with, <code>title:*tutorial</code> ends with, <code>title:*post*</code> anywhere, <code>title:Di?gram</code> exactly one character.</li>
<li>A wildcard is anchored to the whole value, so <code>post*</code> is a prefix rather than “contains”, and <code>url:*.pdf</code> means “ends in .pdf”.</li>
<li>With no wildcard a value is still a plain substring, so an ordinary search behaves exactly as before.</li>
<li>Wildcards apply to <code>title:</code>, <code>url:</code>, <code>folder:</code>, <code>tag:</code> and plain words. For a host use <code>domain:example.com</code>, which already covers every subdomain.</li>
</ul>
<h3>tag: and type:</h3>
<ul>
<li><code>type:pdf</code> matches an extension; <code>type:image</code>, <code>video</code>, <code>audio</code>, <code>doc</code>, <code>sheet</code>, <code>slide</code>, <code>archive</code> and <code>code</code> match whole families of them; <code>type:web</code>, <code>type:file</code> and <code>type:folder</code> match by kind.</li>
<li><strong><code>tag:</code> needs data to match.</strong> It reads a <code>tags</code> field on the bookmark record, which an imported JSON file can carry. The browser's bookmark API does not expose tags and this app never writes them, so in the live extension <code>tag:…</code> finds nothing — the operator is there for files that have the field.</li>
<li><strong>There is no <code>size:</code>.</strong> Bookmarks carry no byte size, so the operator cannot exist honestly. <code>type:</code> is the useful part of that idea.</li>
</ul>
<h3>Whole words and case</h3>
<ul>
<li><strong>Whole words only</strong> (Settings → Search syntax) makes every text value match on word boundaries: <code>title:post</code> stops finding “postgres”.</li>
<li><strong>Case sensitive</strong> compares text exactly as typed, so <code>title:Postgres</code> finds only titles with that capital. Operator values keep their capitals for this; the Filters panel and the plain-English line still work in lowercase.</li>
<li>Hosts stay case-insensitive whatever the setting: <code>domain:EXAMPLE.com</code> behaves like <code>domain:example.com</code>.</li>
</ul>
<h3>Scope and timing</h3>
<ul>
<li><strong>Recursive search</strong> unticked: this folder. Ticked: this folder and its subfolders. <strong>Search everywhere</strong>: all four roots.</li>
<li>A scoped search that finds nothing offers <em>search everywhere</em> as a button.</li>
<li>Typing waits 300 ms of quiet to search; a further second files the query into the recent history. Enter, leaving the box or Apply act at once.</li>
</ul>
<h3>Odd cases</h3>
<ul>
<li><code>OR</code> and <code>AND</code> are recognised only as bare words: <code>title:OR</code> is a title search for “OR”.</li>
<li>Unmatched brackets are ignored rather than failing the search, and a lone <code>-</code> negates whatever follows it.</li>
<li>A broken regular expression reports its error instead of quietly finding nothing.</li>
<li>With the operator master switch off, everything above is literal text — dashes, colons and brackets included. With a single family unticked, only that family's tokens become literal.</li>
<li>Smart folders store the query text, so a saved search can use OR, wildcards and the new families like any other query.</li>
</ul>
`
    },
    {
        id: 'statistics',
        title: 'Statistics',
        html: `
<h3>The twelve tabs</h3>
<p>Statistics are built from your bookmarks' own dates, not from browsing history. Twelve tabs cover the ways they cluster:</p>
<ul>
<li><strong>Search chains</strong> — a search bookmark and the links it led to, the closest thing to browsing history this app has.</li>
<li><strong>Topics</strong> — word clusters across titles.</li>
<li><strong>Binges</strong> — bursts of additions larger than the session minimum.</li>
<li><strong>Sessions</strong> — groups of bookmarks added within the burst gap (<code>setting-burst-gap</code>, <code>setting-burst-min</code>).</li>
<li><strong>Clock collisions</strong> — bookmarks sharing an identical timestamp.</li>
<li><strong>Returning</strong> — links you keep coming back to.</li>
<li><strong>By domain</strong> — hosts and subdomains with counts, per-window rates (minute, hour, day, month, year, five years, ten years) and the health numbers beside them: tracking parameters, duplicate URLs, broken links from the link-check run, and the service split. The old separate Domain health view is folded in here, so one row answers both questions; the wide table scrolls sideways inside its section rather than pushing the page.</li>
<li><strong>Heatmap</strong> — when you add things: weekday by hour, month by day, year by month.</li>
<li><strong>Folder sizes</strong> — which folders hold the most.</li>
</ul>
<h3>The toolbar</h3>
<ul>
<li><strong>Sort</strong> — <code>count</code>, <code>rdnn</code>, <code>recent</code>, <code>oldest</code>, or <code>rate</code>; the choice is remembered (<code>setting-stats-sort</code>).</li>
<li><strong>Burst gap</strong> — 30s, 1m, 2m (default), 5m, 15m, or 1h; <strong>burst minimum</strong> — 2, 3 (default), 4, or 5. Together they decide what a “session” means.</li>
<li><strong>Refresh</strong> and <strong>CSV</strong> — the CSV writes every table that has data, one section each.</li>
<li><strong>Search</strong> filters the current tab; <code>j</code>/<code>k</code> move through the list, Enter opens, and <code>l</code> shows the row in the library.</li>
</ul>
<h3>The detail panel</h3>
<p>Clicking a row opens <em>Service details</em>: a filter over title, URL and folder, paginated 100 at a time, an Added-date sort, a Compact toggle that tightens the table (smaller rows, the URL line hidden, the row actions shrunk to the icon row), per-row show/nearby/delete actions, folder chips, window buttons and service chips with a count of the rest. Each card in these panels shows one set of actions — the named buttons on a wide card, the icon row when it is narrow or when Compact is on — and in the service table those three row actions stay on one line at the right of the row — they were laid out by the trail card's stacked 132px column, which made the last column huge and pushed them around — and the Compact toggle with the density setting both tighten the rows.</p>
<p>Never-opened bookmarks are not here: they live in Actions → General repairs, where removal is previewed like any other change.</p>
`
    },
    {
        id: 'open-tabs',
        title: 'Open Tabs',
        html: `
<h3>Windows first, then their tabs</h3>
<p>Each normal window gets a card with its tabs in tab order, the <code>windowId</code> available on hover, and badges
for the tab's state. <strong>Window numbers follow the oldest tab in each window</strong>: Window 1 is the window that
has been open longest, which keeps the numbering stable instead of following whatever order the browser listed them in.
A window whose tabs carry no recorded time sorts after the ones that do. Tabs that belong to no chain are grouped under <strong>Other tabs</strong>, and both groups carry the same two dropdowns: one for bookmarking the whole group (or bookmarking it and closing it) and one for sending it to Obsidian.</p>
<h3>Finding and reading</h3>
<ul>
<li><strong>Filter</strong> by title or URL.</li>
<li><strong>Condensed view</strong> — one line per tab, with the times moved into the tooltip.</li>
<li><strong>Group chains</strong> — display each search chain (a search tab and what it opened within the gap) as a subgroup. Display only: the real tab order never changes.</li>
<li><strong>Collapse all</strong> — fold every window to its header, or open them all again.</li>
<li><strong>Refresh</strong> — read the browser's windows and tabs again.</li>
<li><strong>State badges each have their own colour</strong>: <em>Focused</em> (teal) is the window you are in, <em>Active</em> (indigo) is that window's active tab, <em>Current</em> (green) is the tab you are looking at, and <em>Library</em> (magenta) is this app's own page. Pinned is amber and a tab that cannot be bookmarked at all is red.</li>
<li>Row menus open <strong>upwards</strong> — a tab list is long, so that is the reliable direction — and drop downward only for a row at the very top where upward would not fit. The window's own menus open downward and flip up when there is no room. Either way the gap between the button and the menu is bridged, so the pointer can travel into it.</li>
</ul>
<h3>Acting on what is open</h3>
<ul>
<li><strong>Bookmark this tab</strong>, or <strong>bookmark and close</strong> it, from the row's menu. A tab that is already bookmarked shows the 👁 button to find it in the library, and <em>also</em> keeps the 🔖 menu while <em>Skip bookmarked tabs</em> is off — because that setting is what decides whether a second copy may be made at all. Its items then read <em>Bookmark a second copy</em> rather than pretending the first one does not exist.</li>
<li><strong>Bookmark window</strong> saves one window into its own subfolder of <em>Other Bookmarks / Opened Tabs</em>, named <em>Window N · date</em>. When every tab is already saved the button offers the close-only menu rather than sitting disabled for no visible reason.</li>
<li><strong>Bookmark all windows</strong> does the same for every window except the library's own, with <em>Bookmark and Close</em> or <em>Bookmark Only</em>.</li>
<li><strong>Merge windows</strong> moves every tab from every other normal window into this one, then closes the windows it emptied. It asks first and names the counts, because there is no undo for it. Private windows are skipped — a private tab cannot be moved into a normal window — and every move is counted, so a tab the browser refuses is reported rather than lost.</li>
<li><strong>Close duplicate tabs</strong> closes a tab whose URL is already open earlier in the same window, keeping the first — and it is only offered when there is one to close, with the count in its tooltip. Pinned tabs and this library page always stay, so a window whose only duplicates are pinned says exactly that rather than looking broken. URLs that differ only by tracking parameters count as duplicates, because the same key decides both. Tabs you have bookmarked can be skipped automatically (<code>setting-open-tabs-skip-saved</code>).</li>
</ul>
`
    },
    {
        id: 'selecting',
        title: 'Selecting tabs in bulk',
        html: `
            <h3>Selecting tabs in bulk</h3>
            <p>Every row in Open Tabs has a checkbox, shown when you hover the row, when it has keyboard
            focus, or when it is selected. Tick one to begin, and <strong>shift-click</strong> another to
            extend the range from the last tab you ticked, in that window's tab order.</p>
            <p>The selection outlives redrawing: collapsing a window, refreshing the tab list or changing the
            filter will not lose it, and a tab that closes simply drops out of it. It can span windows, and the
            bar reports how many it covers.</p>
            <p>A bar appears above the windows whenever something is selected:</p>
            <ul>
                <li><strong>Obsidian &rsaquo;</strong> &mdash; <em>Send to Obsidian</em>, <em>Send to Obsidian
                and close them</em>, or <em>Copy as Markdown</em> (the same text, without sending it).</li>
                <li><strong>Bookmark &rsaquo;</strong> &mdash; <em>Bookmark these tabs</em>, <em>Bookmark these
                tabs and close them</em>, or <em>Close without bookmarking</em>.</li>
                <li><strong>Move to window &rsaquo;</strong> &mdash; <em>Move to a new window</em>, or into any
                other window holding a tab you have not selected.</li>
                <li><strong>Clear selection</strong> &mdash; empties it.</li>
            </ul>
            <p>Bookmarking a selection gathers it into a folder named <em>Selected tabs</em>, the way
            bookmarking a search chain uses the chain's search term.</p>
        `
    },
    {
        id: 'actions',
        title: 'Actions: every repair and cleanup tool',
        html: `
<h3>Scans report, you decide</h3>
<p>Every tool works the same way: it scans, shows the findings with each entry and its reason, and waits. Nothing is written until you apply, through the same preview dialog as any other bulk edit. Each card keeps its own results.</p>
<h3>General repairs</h3>
<ul>
<li><strong>Library health</strong> (<code>scanLibraryHealth</code>) — every scan in one table with counts, plus <em>Fix safe ones</em> (<code>applyHealthFixes</code>), which strips tracking parameters and removes empty folders as one undo step.</li>
<li><strong>Library problems</strong> (<code>scanLibraryProblems</code>), <strong>Unused bookmarks</strong> (<code>scanUnusedBookmarks</code>), <strong>Orphan notes</strong> (<code>scanOrphanNotes</code>, with <em>Delete orphans</em>), <strong>Epoch dates</strong> (<code>scanEpochDates</code> — scan-only in the live copy).</li>
<li><strong>Short links</strong> (<code>scanShortLinks</code>), <strong>Tracking parameters</strong> (<code>scanTrackingParams</code>), <strong>Title cleanup</strong> (<code>scanTitleCleanup</code>), <strong>Dead domains</strong> (<code>scanDeadDomains</code>).</li>
<li><strong>Find and replace</strong> (<code>scanFindReplace</code>) — a regular expression over titles, URLs or both, with the scope and a match-case option, applied to the checked rows.</li>
<li><strong>Bulk edit</strong> (<code>scanBulkEditTemplate</code>) — paste a list of changes and preview every pair before renaming.</li>
<li><strong>Same title and domain</strong> (<code>scanSameTitleDomain</code>) — the same page saved with different parameters.</li>
<li><strong>Broken links</strong> (<code>scanBrokenLinks</code>), <strong>Fetch titles</strong> (<code>fetchUrlTitles</code>), <strong>HTML entities</strong> (<code>scanEntityTitles</code>), <strong>AMP hosts</strong> (<code>scanAmpHosts</code>), <strong>Canonical duplicates</strong> (<code>scanCanonicalDupes</code>), <strong>Duplicate folders</strong> (<code>scanDuplicateFolders</code>).</li>
</ul>
<h3>Duplicates</h3>
<ul>
<li><strong>Find duplicate bookmarks</strong> (<code>scanDuplicateBookmarks</code>) — grouped by <code>duplicateUrlKey</code>, 20 groups a page, with show/nearby/domain and folder marks, and a group delete that keeps the oldest.</li>
<li><strong>Remove empty folders</strong> (<code>removeEmptyFoldersCleanup</code>) — lists every folder holding only empty folders, coupled ancestor/descendant checkboxes, one undo step.</li>
<li><strong>Merge duplicate folders</strong> (<code>mergeDuplicateFoldersCleanup</code>) — same-named siblings, including <code>news</code> versus <code>r/news</code>.</li>
<li><strong>Select newest in same folder</strong> (<code>markNewestSameFolderDupes</code>) and <strong>Select outer nested copies</strong> (<code>markOuterNestedDupes</code>).</li>
</ul>
<h3>YouTube, Hacker News, Reddit and Meta</h3>
<ul>
<li><strong>YouTube</strong>: Scan Duplicates (<code>runYtDuplicates</code>), Scan Unsame Titles (<code>runYtUnsameTitles</code>), Normalize (<code>scanYouTubeNormalize</code>), Suffix (<code>scanYtSuffix</code>), Malformed titles (<code>scanMalformedYtTitles</code>).</li>
<li><strong>Hacker News</strong>: Convert (<code>scanHackerNewsLinks</code>).</li>
<li><strong>Reddit</strong>: subreddit folders (<code>scanRedditSubredditFolders</code>), toolbar folders (<code>scanRedditToolbarFolders</code>), comment chains (<code>scanRedditCommentChains</code>).</li>
<li><strong>Meta</strong>: notification titles (<code>scanMetaNotificationTitles</code>).</li>
</ul>
<h3>Link check and Script Lab</h3>
<ul>
<li><strong>Link check</strong> (<code>checkDeadLinks</code>) fetches http(s) links six at a time with a 12-second timeout, over the open folder and its subfolders or the whole library; <em>Stop</em> aborts, and <em>Delete selected</em> removes the dead ones through the preview. Dead means 404/410, unreachable, or timed out.</li>
<li><strong>Script Lab</strong> (<code>runBookmarkScript</code>) runs your function over the library with the same preview-then-apply safety, and <em>Load an example</em> fills a working template. The self-tests card runs, copies and opens the built-in tests.</li>
</ul>
`
    },
    {
        id: 'menus',
        title: 'Every menu, in one place',
        html: `
<h3>Bookmark row (the table)</h3>
<ul>
<li>New Bookmark, New Folder, <strong>Nest in new folder</strong>, Edit, Delete.</li>
<li><strong>Copy</strong> — Title, URL, URL Original (only while cleaning would change it), and as Markdown.</li>
<li>Open, Nearby bookmarks, Show in By domain, Show in Search chain, Show duplicates, Check link, Send to Obsidian (and delete).</li>
<li>Export HTML, Export JSON, Open all in tabs, Protect from scans, Move to Other Bookmarks, Move links underneath folders.</li>
</ul>
<h3>Folder in the sidebar tree</h3>
<ul>
<li>New Folder, Delete, Protect from scans, Open subreddit, Merge folders (with two or more picked).</li>
<li>Send folder to Obsidian (and delete), Export as HTML, Move links underneath folders, Move Mobile Bookmarks, Move Toolbar links.</li>
</ul>
<h3>The folder heading chip</h3>
<ul>
<li>Open folder in Bookmarks, Copy folder path, Folder report, Export folder as JSON, Export folder as HTML.</li>
</ul>
<h3>The empty-list background</h3>
<ul>
<li>New Folder, New Bookmark, Export as HTML for the open folder.</li>
</ul>
<h3>An Open Tabs row (the tab)</h3>
<ul>
<li>Switch to tab, Reload, Duplicate, Copy (Title, URL, URL Original, Markdown), Pin, Mute.</li>
<li>Bookmark this tab, Bookmark and close, Show in library, Send to Obsidian (and close), Send search chain to Obsidian (and close).</li>
<li>Close tab, Close others, Close to the right.</li>
</ul>
<p>Copy actions always use the cleaned URL, so tracking parameters and site chrome never reach what you paste. The toolbar dropdown and the command palette reach the same actions — import, export, snapshots, trash, self-tests and the scans — from one filtered list.</p>
`
    },
    {
        id: 'script-lab',
        title: 'Script Lab',
        html: `
<h3>Write the repair you need</h3>
<p>Script Lab runs a JavaScript function over the library you choose, with the same preview-then-apply safety as every
other tool: your script returns a list of changes, the app shows them, and nothing is written until you accept it.
<em>Load an example</em> fills the editor with a working template so you can start from something that already runs.</p>
<h3>What is available inside a script</h3>
<ul>
<li><strong>The library</strong> as the app sees it, with helpers for walking it, reading titles and URLs, and finding duplicate or dead entries.</li>
<li><strong>The same URL rules</strong> the cleaning tools use, so a script can ask what a URL would become before proposing it.</li>
<li><strong>Bulk-edit templates</strong> — the paste-a-list flow is generated from a template you can inspect, which is also the quickest way to see the expected shape.</li>
</ul>
<h3>Testing the app itself</h3>
<p>The card also runs the built-in self-tests, copies their report, and opens the self-test page. Those tests cover the
pure logic — URL keys, rule matching, parsing, duplicate detection — not your data.</p>
`
    },
    {
        id: 'affected',
        title: 'Affected Links Log',
        html: `
<h3>What it records</h3>
<p>Every change — and every scan that found something — is written with a timestamp, the source that did it (a tool, a bulk apply, a live write), the kind of change, and the entry it touched. Rows are newest first.</p>
<h3>The record's shape</h3>
<ul>
<li><code>at</code> — when it happened.</li>
<li><code>type</code> — one of <code>REMOVED</code>, <code>ADDED</code>, <code>MODIFIED</code>, <code>SCRIPT</code>, <code>SYSTEM</code>, or <code>REPAIR</code>.</li>
<li><code>title</code>, <code>folder</code>, <code>url</code>, <code>details</code> — what was touched and how.</li>
<li><code>source</code> and <code>kind</code> — which part of the app did it, for filtering.</li>
</ul>
<h3>Retention and export</h3>
<ul>
<li>Seven days, pruned on load and on each write; a storage failure halves the log rather than failing the write.</li>
<li>Three filters (type, source, free text) are populated from the log itself.</li>
<li><strong>Export CSV</strong> and <strong>Export JSON</strong> write the filtered rows; <em>Clear log</em> empties it after a confirmation, and clearing is not itself logged.</li>
</ul>
`
    },
    {
        id: 'undo',
        title: 'Undo, bulk apply and epoch',
        html: `
<h3>Undo</h3>
<p>The last change can be undone with <code>ctrl</code>/<code>cmd</code>+<code>z</code> and redone with
<code>ctrl</code>/<code>cmd</code>+<code>shift</code>+<code>z</code>. Deletes go to the trash and stay recoverable there
until it is emptied; deleting offers its own timed undo in the menu. Nesting a set of entries in a new folder offers
<em>Undo nest</em> for five minutes, which moves every entry back to its recorded parent and index and then removes the
folder it created.</p>
<h3>Bulk apply</h3>
<p>Bulk edits, repairs and policy changes are applied as a batch: the preview lists every affected entry with its old and
new value, applying records one undo step for the batch, and the affected log keeps the detail. A batch that would touch
protected items leaves them alone and says how many it skipped.</p>
<h3>Keeping a copy: export, don't snapshot</h3>
<p>There are no named snapshots. A whole tree is tens of megabytes of JSON, which does not fit the few megabytes a
browser gives a page, so saving one either failed or filled the storage; the feature was removed rather than kept
half-working. Keep a copy the way the rest of the tool works: <strong>Import and Backup → Export bookmarks as JSON</strong>
writes the current tree to a file, and <strong>Import JSON</strong> or <strong>Compare another JSON</strong> reads one back.
There is no last-known-good copy either, for the same reason: it was a full JSON clone in this browser's storage, capped at 3,000 bookmarks, so on a real library it silently stored nothing. Undo, the trash and the previewed batches are what cover a bad batch.</p>
<h3>Epoch</h3>
<p>An epoch is a dated checkpoint of the library's dates and structure, used to re-stamp or compare entries after a
restore. The epoch scan reports what would change; applying is a normal previewed batch, and in the live extension it
announces that it is scan-only where a change cannot be written back safely.</p>
`
    },
    {
        id: 'data',
        title: 'Storage, export and import',
        html: `
<h3>The two copies</h3>
<ul>
<li><strong>Live extension</strong> — reads the browser's bookmarks and writes changes back through the API, via an <strong>outbox</strong> (Settings → Live write outbox: retry failed, clear finished) so an interrupted write is visible rather than lost.</li>
<li><strong>JSON file editor</strong> — imports an exported <code>.json</code>, edits in memory, and downloads the result.</li>
</ul>
<h3>Import, export and merge</h3>
<ul>
<li><strong>Export JSON</strong> writes <code>bookmarks_exported.json</code>; <strong>Import JSON</strong> reads the same shape back. <strong>Merge Bookmarks from JSON</strong> adds only what is missing, matching by <code>bookmarkUrlKey</code> so a URL saved with different tracking parameters still counts as present — one undo step, with the counts named in the confirm.</li>
<li>The <strong>merge policy</strong> decides what an import does when an entry exists: <code>skip</code> (default), <code>prefer-newer</code>, <code>overwrite</code>, or <code>keep-both</code>.</li>
<li>Export and import also exist for <strong>HTML</strong>, for <strong>editor settings</strong>, and for the <strong>URL cleaning rules</strong> on their own.</li>
</ul>
<h3>Where everything lives</h3>
<p>All app state is in this browser's local storage, under these keys:</p>
<table>
<tr><th>Key</th><th>Holds</th></tr>
<tr><td><code>bookmark-editor-settings</code></td><td>every setting below</td></tr>
<tr><td><code>bookmark-editor-notes</code></td><td>notes, keyed by URL</td></tr>
<tr><td><code>bookmark-editor-trash</code></td><td>deletion steps, up to 50</td></tr>
<tr><td><code>bookmark-editor-last-good</code></td><td>the repealed pre-destructive copy: whatever an older build left there is deleted on the next load</td></tr>
<tr><td><code>bookmark-editor-snapshots</code></td><td>the repealed named-snapshot store: whatever an older build left there is deleted on the next load</td></tr>
<tr><td><code>bookmark-editor-affected-log</code></td><td>the affected-links log</td></tr>
<tr><td><code>bookmark-editor-protected-folders</code></td><td>folders skipped by scans and the tidy</td></tr>
<tr><td><code>bookmark-editor-url-rules</code></td><td>the editable URL cleaning rules</td></tr>
<tr><td><code>bookmark-editor-search-history</code></td><td>recent searches, up to 30</td></tr>
<tr><td><code>bookmark-editor-recent-folders</code></td><td>recent folders</td></tr>
<tr><td><code>bookmark-editor-smart-folders</code></td><td>saved searches</td></tr>
<tr><td><code>bookmark-editor-sort-memory</code></td><td>each folder's sort column and direction</td></tr>
<tr><td><code>bookmark-editor-column-widths</code></td><td>dragged column widths</td></tr>
<tr><td><code>bookmark-editor-schema</code></td><td>the stored-data schema marker</td></tr>
<tr><td><code>bookmark-editor-last-load</code></td><td>the stamp of the last library load</td></tr>
<tr><td><code>bookmark-editor-theme</code></td><td>the legacy theme key, read as a fallback</td></tr>
</table>
<p>The log lives under <code>bookmark-editor-affected-log</code> — not a shorter <code>bookmark-editor-log</code>, which the code notes is the wrong name.</p>
<p>Settings → <strong>Stored data</strong> lists each key with its size and lets you clear individual keys (never the log, settings or schema). The <code>file://</code> JSON app and the extension each keep their own origin, so settings and the log are separate between them.</p>
`
    },
    {
        id: 'urlkeys',
        title: 'URL keys and cleaning rules',
        html: `
<h3>Three keys, deliberately different</h3>
<ul>
<li><code>duplicateUrlKey(uri)</code> — exact about parameters: host without <code>www</code>, trailing slash trimmed, parameters kept. This is what the duplicate scan groups by.</li>
<li><code>bookmarkUrlKey(url)</code> — canonicalises Google and YouTube, keeps parameters.</li>
<li><code>libraryUrlKey(uri)</code> — <code>bookmarkUrlKey(stripTrackingParams(uri))</code>: the key two bookmarks share when they are the same page no matter how it was saved. Used by the JSON merge, the duplicate-tab closers and the background duplicate report.</li>
</ul>
<h3>The cleaning rules are editable</h3>
<p>The tracker list and the Google/YouTube canonicalisation are not hard-coded. <code>bookmark-lib.js</code> holds an ordered engine whose defaults are today's behaviour: a <code>utm_*</code> prefix rule, an exact-list rule for the tracking parameters, then the <code>youtube</code>, <code>google-redirect</code>, <code>google-image-redirect</code> and <code>google-search</code> builtins.</p>
<p>A rule is either <code>{ kind: 'params', name, match: 'prefix' | 'exact' | 'regex', value, enabled }</code> or <code>{ kind: 'builtin', name, enabled }</code>. <code>urlRulesFromJson(text)</code> validates and names the item and the reason it failed; <code>testUrlRules(uri)</code> returns the stripped URL, the clean copy and one step per rule that changed something — which is what the Settings test box prints. Every cleaner follows the saved rules: the copy menus, the Obsidian sends, the repairs scan and the background tidy.</p>
`
    },
    {
        id: 'obsidian',
        title: 'Sending to Obsidian',
        html: `
<h3>What gets sent</h3>
<p>Links, selections and reports reach Obsidian through the <strong>Send …</strong> items. By default each one
is inserted <strong>at the cursor</strong> of whichever note is open; the <strong>Send bookmarks to</strong> setting
sends to the daily note instead, or leaves an item for each in the menu. Sending to the daily note writes a heading
for the day and a bullet per entry with the cleaned title and URL. The note's path is a setting
(<code>setting-obsidian-note</code>), and it is the only place the app writes outside its own storage.</p>
<h3>What “cleaned” means</h3>
<ul>
<li>The same URL cleaning rules used everywhere else, so tracking parameters and site chrome do not reach the note.</li>
<li>Titles trimmed of the suffixes the cleaning rules remove, and YouTube titles normalised to the canonical watch form.</li>
<li>Links that are already bookmarked are still sent — the assumption is that a note is about reading, not about the library's contents.</li>
</ul>
<p>Reports from Statistics use the same sink: <em>send report to Obsidian</em> sends the table you are looking at to the destination above.</p>
<h3>Sending to the cursor</h3>
<p>Every surface that sends — the bookmark and folder menus, the folder tree, search results, the Statistics
chain panels, the Open tabs page and the browser’s own tab menu — inserts through the local Advanced URI
plugin’s <code>insertatcursor</code> mode, so the text lands where the caret already is and nothing else in
the note moves. On a list item the bookmark becomes a new sibling item at the same depth, keeping the
indentation and marker style, and any following lines nest one level deeper.</p>
<p><strong>Insert sent bookmarks</strong> (<code>setting-obsidian-insert</code>) chooses between landing below the current line and nesting under it.
<strong>If no note is open</strong> (<code>setting-obsidian-fallback</code>) chooses what happens when Obsidian has no editor: show a notice and write
nothing, or append to the daily note instead.</p>
<p><strong>Send bookmarks to</strong> (<code>setting-obsidian-destination</code>) picks between the cursor and the daily note — or both, which leaves an item for each in the menu. The menus themselves are condensed to one item per destination. <em>Alt-click</em> (or Shift-click) deletes the
bookmarks afterwards, and a page can ask for the long form with <code>data-send-menu="full"</code>.</p>
`
    },
    {
        id: 'settings',
        title: 'Settings reference',
        html: `
<h3>Tidy and schedule</h3>
<ul>
<li><code>setting-tidy-enabled</code>, <code>setting-tidy-weekday</code>, <code>setting-tidy-hour</code> — the weekly tidy and when it runs.</li>
<li><code>setting-auto-move-toolbar</code>, <code>setting-auto-move-mobile</code>, <code>setting-auto-move-hours</code> — moving toolbar and mobile bookmarks into their folders, and the age at which that is allowed.</li>
</ul>
<h3>Search syntax</h3>
<ul>
<li><code>setting-search-operators</code> — the master switch; off means every query is literal text.</li>
<li><code>setting-search-whole-words</code> — match text on word boundaries. <code>setting-search-case</code> — compare text exactly as typed. <code>setting-search-exhaustive</code> — the slow, quadratic search below.</li>
<li>One checkbox per family: <code>setting-search-family-domain</code>, <code>setting-search-family-folder</code>, <code>setting-search-family-title</code>, <code>setting-search-family-tag</code>, <code>setting-search-family-type</code>, <code>setting-search-family-url</code>, <code>setting-search-family-added</code>, <code>setting-search-family-has</code>, <code>setting-search-family-is</code>, <code>setting-search-family-exclude</code>, <code>setting-search-family-regex</code>.</li>
</ul>
<h3>Appearance and reading</h3>
<ul>
<li><code>setting-theme</code> (light, dark, auto), <code>setting-density</code> (comfortable, compact), <code>setting-columns</code> (all, name-location, name-added, name-only), <code>setting-sidebar-width</code>, <code>setting-hide-root</code>, <code>setting-startup-folder</code>.</li>
<li><code>setting-stats-sort</code> (count, rdnn, recent, oldest, rate), <code>setting-burst-gap</code>, <code>setting-burst-min</code>.</li>
</ul>
<h3>Open Tabs and cleaning</h3>
<ul>
<li><code>setting-open-tabs-skip-saved</code>, <code>setting-open-tabs-chain-folders</code>.</li>
<li><code>setting-clean-urls</code>, <code>setting-reddit-chrome</code>, <code>setting-youtube-suffix</code>, <code>setting-google-suffix</code>.</li>
<li><code>setting-refresh-dupes</code> — recompute duplicate statistics after a delete.</li>
<li><code>setting-merge-policy</code> — skip, prefer-newer, overwrite, keep-both.</li>
<li><code>setting-obsidian-note</code> — where notes are appended.</li>
</ul>
<h3>The other surfaces</h3>
<ul>
<li><strong>URL cleaning rules</strong> — the JSON editor, Load current, Save, Reset to built-ins, Export/Import JSON, and a Test box.</li>
<li><strong>Stored data</strong> — every storage key with its size, and per-key clearing.</li>
<li><strong>Live write outbox</strong> (live only) — retry failed writes, clear finished ones.</li>
<li><strong>Scheduled jobs</strong> (live only) — the tidy, tracker-strip, duplicate-report and dead-link-sweep with their hourly, daily or weekly cadence, and the last and next runs.</li>
</ul>
`
    },
    {
        id: 'keyboard',
        title: 'Keyboard and the command palette',
        html: `
<h3>Anywhere</h3>
<ul>
<li><code>ctrl</code>/<code>cmd</code>+<code>k</code> — the command palette: every view, every import/export and trash action, every scan, and every folder and bookmark in one filtered list. The arrows move, Enter runs, Escape closes, and it caps at 60 matches.</li>
<li><code>ctrl</code>/<code>cmd</code>+<code>z</code> undo; add <code>shift</code> to redo. <code>ctrl</code>/<code>cmd</code>+<code>s</code> exports.</li>
<li><code>/</code> — jump to the search box and switch to the Bookmarks view.</li>
<li><code>Escape</code> — close the filter panel first, then the topmost dialog.</li>
</ul>
<h3>In the library list</h3>
<ul>
<li><code>j</code> and <code>k</code>, or the arrow keys — move the selection down and up. <code>Home</code> and <code>End</code> jump to the ends.</li>
<li><code>Enter</code> — open the selected bookmark, or the menu target when a menu is open.</li>
<li><code>Delete</code> or <code>Backspace</code> — delete the selection through the preview.</li>
<li><code>alt</code>+<code>ArrowUp</code> / <code>alt</code>+<code>ArrowDown</code> — move the selected bookmark up or down inside its folder.</li>
<li><code>shift</code>+click selects a range; <code>ctrl</code>/<code>cmd</code>+click adds or removes one row.</li>
</ul>
<h3>With the pointer</h3>
<p>Every row has its own menu button, so actions sit next to the row rather than only under the right mouse button. Hovering a tab shows its window and timestamps; a menu opens upward when a row is near the bottom of a list, and the gap between a trigger and its menu is bridged so the pointer can travel into it.</p>
`
    },
    {
        id: 'limits',
        title: 'What this app does not do',
        html: `
<h3>Things the browser will not provide</h3>
<ul>
<li><strong>Tags.</strong> The bookmarks API does not expose per-bookmark tags and this app does not store its own, so <code>tag:</code> only matches imported JSON that carries a <code>tags</code> field. There is no tag editor.</li>
<li><strong>Size.</strong> Bookmarks carry no byte size, so there is no <code>size:</code> operator. <code>type:</code> covers the useful part of that idea.</li>
<li><strong>Browsing history.</strong> Statistics are built from bookmark dates only. The app never reads your history, and it makes no network requests except the link checker you start.</li>
<li><strong>Sync.</strong> There is no backup schedule or cloud sync: export is the backup, and the live outbox is about not losing a write, not about replicating your library.</li>
</ul>
<h3>Scope of the promise</h3>
<ul>
<li>The live extension targets Firefox; the JSON editor is a plain page and works anywhere.</li>
<li>Cross-browser behaviour is not guaranteed in detail — the API differences that matter are handled, but there is no parity matrix claiming identical behaviour on every browser.</li>
<li>Anything deferred is listed in the project's own notes rather than promised here: multi-library or per-folder scoping of the whole app, and scheduled sync are the known ones.</li>
</ul>
`
    },
    {
        id: 'files',
        title: 'Files, the live extension and CSP',
        html: `
<h3>What is in the folder</h3>
<ul>
<li><code>bookmark-editor-v1.0.html</code>, <code>bookmark-editor-v1.0.css</code>, <code>bookmark-editor-v1.0.js</code> — the page you are looking at.</li>
<li><code>js/bookmark-lib.js</code> — the library model: URL keys, the rules engine, path and title helpers, tree walking.</li>
<li><code>js/statistics.js</code> — everything the Statistics view computes.</li>
<li><code>js/open-tabs.js</code> — the Open Tabs view.</li>
<li><code>js/repairs.js</code> — the repair and cleanup scans.</li>
<li><code>js/dupe-cleanup.js</code> — duplicate detection and the cleanup policies.</li>
<li><code>js/bookmarks-live.js</code> — the live extension's own I/O: reading the browser's tree, writing back, the outbox.</li>
<li><code>js/background.js</code>, <code>manifest.json</code> — the extension's background menu, omnibox and the embedded editor.</li>
<li><code>js/link-check.js</code> — the HTTP status checker and the title fetcher.</li>
<li><code>js/reddit-actions.js</code> — the Reddit-specific repairs.</li>
<li><code>js/docs.js</code> — this manual, as data; <code>self-test.html</code> is the standalone test page.</li>
<li><code>js/self-tests.js</code> — the built-in tests.</li>
</ul>
<h3>Why the interface is built this way</h3>
<p>The extension runs under a strict content-security policy: no inline scripts, no inline event handlers, no remote
code. Every control is therefore wired by attribute (<code>data-call</code>) to a function that exists in a loaded
script, which is also why the whole interface can be driven from a test harness without a browser.</p>
<h3>Keeping the copies in step</h3>
<p>Fifteen files are byte-identical between the two builds, including the editor itself and both stylesheets. Only
<code>js/bookmarks-live.js</code> differs, and it is the live copy only: it re-declares the twelve functions that write
to the browser (import, export, move, reorder, undo, the status line), and because it loads
immediately after the editor its versions win there. The JSON in-memory behaviour is the shared default. Two files
where only a sentence or a date scale differs — <code>js/statistics.js</code> and <code>js/reddit-actions.js</code> —
branch on which copy they are in rather than existing twice.</p>
<p>So when something looks wrong in one copy and not the other, the answer is in <code>js/bookmarks-live.js</code> or
in the HTML's script list, and nowhere else.</p>
`
    }
];

let docsFilterTimer = 0;


// One topic at a time: the nav on the left lists every section, the body on the right shows the
// chosen one, and clicking a topic opens it. The previous version had a copy of an old manual
// spliced inside its own nav template, which is what left this view showing a wall of text.
let docsCurrentId = '';

function renderDocumentation() {
    const nav = document.getElementById('docs-nav');
    const body = document.getElementById('docs-body');
    if (!nav || !body) return;
    const query = String((document.getElementById('docs-search') || {}).value || '').trim();
    const needle = query.toLowerCase();
    const matches = section => !needle
        || `${section.title} ${section.html}`.toLowerCase().replace(/<[^>]+>/g, ' ').includes(needle);
    const visible = APP_DOC.filter(matches);
    // A hash wins on entry (the command palette and links elsewhere use them), otherwise keep the
    // topic that is already open, otherwise open the first.
    const hash = String(typeof location !== 'undefined' && location && location.hash || '').replace(/^#docs-/, '');
    if (hash && APP_DOC.some(section => section.id === hash)) docsCurrentId = hash;
    if (!visible.some(section => section.id === docsCurrentId)) docsCurrentId = visible.length ? visible[0].id : '';
    nav.innerHTML = APP_DOC.map(section => {
        const hidden = matches(section) ? '' : ' hidden';
        const current = section.id === docsCurrentId;
        return `<a class="docs-nav-link${current ? ' is-current' : ''}${hidden}" data-docs-id="${escapeHtml(section.id)}" href="#docs-${escapeHtml(section.id)}"${current ? ' aria-current="true"' : ''}>${escapeHtml(section.title)}</a>`;
    }).join('');
    const current = visible.find(section => section.id === docsCurrentId);
    body.innerHTML = current
        ? `<section class="docs-section" id="docs-${escapeHtml(current.id)}"><h2>${escapeHtml(current.title)}</h2>${current.html}</section>`
        : '<p class="stats-empty">Nothing in the manual matches that search.</p>';
    // Highlighting needs a real DOM: TreeWalker and mark elements, both absent in a test harness.
    if (query && typeof highlightDocumentation === 'function') {
        try {
            highlightDocumentation(nav, needle);
            if (current) highlightDocumentation(body, needle);
        } catch (err) {
            // No TreeWalker here: the text still matches, just without the marks.
        }
    }
}

function highlightDocumentation(root, query) {
    if (!root || !query) return;
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pattern, 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
        const text = node.nodeValue;
        if (!text || !text.toLowerCase().includes(query)) return;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let match;
        while ((match = re.exec(text))) {
            if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
            const mark = document.createElement('mark');
            mark.className = 'docs-hit';
            mark.textContent = match[0];
            frag.appendChild(mark);
            last = match.index + match[0].length;
            if (!match[0]) re.lastIndex += 1;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    });
}

function filterDocumentation() {
    clearTimeout(docsFilterTimer);
    docsFilterTimer = setTimeout(renderDocumentation, 80);
}

// Clicking a topic opens it: the nav chooses, the body shows the choice.
function jumpDocumentation(event) {
    const link = event.target.closest && event.target.closest('.docs-nav-link');
    if (!link) return;
    event.preventDefault();
    const id = link.getAttribute('data-docs-id') || link.getAttribute('href').replace(/^#docs-/, '');
    if (!id) return;
    docsCurrentId = id;
    renderDocumentation();
    const body = document.getElementById('docs-body');
    if (body && typeof body.scrollTo === 'function') body.scrollTo({ top: 0, block: 'start' });
    else if (body) body.scrollTop = 0;
    return false;
}

(function bindDocumentation() {
    const init = () => {
        renderDocumentation();
        document.getElementById('docs-nav')?.addEventListener('click', jumpDocumentation);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
