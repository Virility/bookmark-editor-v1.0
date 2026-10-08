# Live bookmark editor (Firefox / Chrome extension)

Edits the real bookmark library via `bookmarks.getTree` / `update` / `move` / `create` / `remove`.

1. Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on**
2. Choose this folder’s `manifest.json`
3. Click the toolbar button (or open the sidebar)

After that first load, the add-on watches its own files and calls `runtime.reload()` when they change. You should not need to click Reload in `about:debugging` for later code edits. Library → **Reload add-on** still forces it. `Reload from this browser` only re-reads bookmarks, not code.

`dateAdded` cannot be written through the WebExtensions API; that repair is scan-only here. Use the `json/` app for JSON date fixes.

On a **webpage**, right-click a link → **Bookmark link** (Other Bookmarks; skipped if that URL is already bookmarked, including youtu.be vs watch — a dialog lists the folder path and title; click the path to open the library at that bookmark; YouTube watch titles get ` - YouTube`) or **Send link to Obsidian** (`linkUrl`, title from the link text). Right-click the page → **Send page to Obsidian**. Select text → **Send text to Obsidian** (each line a `-` list item; leading `>` quotes become tabs; a selected URL becomes **Send link to Obsidian**), **Send text under page link**, or **Send page link under text**:

```
- [tab title](url)
	- selected text
```

```
- selected text
	- [tab title](url)
```

On Reddit pages only, **Send Reddit text to Obsidian** drops `permalink embedsave reportreply` rows, `[–]` username lines, and `N points … ago` lines, then sends the leftover comment body the same way as Send text.

**Send as Google search to Obsidian** turns each non-empty selected line into a Google search markdown link:

```
- [query - Google Search](https://www.google.com/search?q=query)
```

YouTube watch / youtu.be / embed URLs are stored as `https://www.youtube.com/watch?v=ID` with other query params stripped. Watch-video titles and channel handle links (`youtube.com/@name`) get ` - YouTube` if it is missing (an existing suffix is kept as that spelling). Shorts stay. Google search titles get ` - Google Search` the same way. Google search URLs keep `q` (and `tbm` / `udm` / `start` when they matter); `/url` and `/imgres` unwrap to the destination. `javascript:`, `about:`, and extension URLs are skipped.

Right-click a page or a **browser tab** → **Show in Library** (only when that page is bookmarked) opens the library on that bookmark, or **Find domain in By domain** (only when you have bookmarks on that site but not this page) opens Statistics → By domain on that site’s row.

Right-click a **browser tab** and choose **Send to Obsidian** to append every **selected** tab in that window (Shift/Ctrl multi-select) as `- [title](url)` lines on today’s note, left to right. One selected tab is still one line. **Send to Obsidian and close tab** does the same append, then closes those tabs. The Obsidian handoff tab stays open. **Send window to Obsidian** appends every tab in that window.

After any **… and delete bookmark** (or Search chain delete), a notification and an **Undo delete** menu item appear for 5 minutes; either one puts the bookmarks back where they were. The toolbar icon shows **★** when the current page is already bookmarked.

**Actions → Link check** finds dead links (404/410, unreachable, timed out) and renames bookmarks whose title is just the URL to the page’s real title. It fetches each page, so it only works in this add-on. Right-click a bookmark row in the editor and choose **Check link** to check just that one.

Right-click a bookmark or folder in the **Library**, **bookmarks toolbar**, bookmarks menu, or sidebar:

- **Show in Library** — opens this add-on’s library and highlights that bookmark or folder
- **Nest in new folder…** — asks for a folder name, then creates that folder where the entry was and moves the entry into it. Firefox only passes the right-clicked entry, so to nest several at once use **Nest in new folder...** in this add-on’s row menu (it uses the multi-selection and is undoable)
- **Send to Obsidian** on a link — appends `- [title](url)` to today’s note (keeps the bookmark)
- **Send folder to Obsidian** on a folder — appends an indented list, including the folder name and nested folders (keeps the bookmarks)
- **Send Search chain to Obsidian and delete** — only on a link that is part of a Search chain (a search URL plus results saved within 2 minutes). Appends the search link first, then the other bookmarks one tab in, then **deletes those bookmarks**. Does not appear on ordinary links.

```
- Folder
	- [link](url)
	- Nested
		- [deeper](url)
```

Nested levels use one tab per depth. Single links stay flush left.

Sends append to one dated file per day (`YYYY-MM-DD.md` in the vault root) with [Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) (`obsidian://adv-uri`, `mode=append`). Enable that community plugin and keep it updated (v1.44+). Core `obsidian://new` cannot append.

The Statistics → **Search chains** table (and the chain detail panel) has the same **Send Search chain to Obsidian and delete** button.

