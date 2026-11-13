# Kindle Calibre Sync

Plug-and-play bridge for syncing Kindle highlights and notes directly into Calibre and Obsidian, with a built-in side-by-side EPUB reader.

![Kindle Calibre Sync Demo](assets/demo.png)

## Quick Start (Plug & Play)

No Python, terminal setup, or external scripts required.

1. **Install & enable the plugin**:
   - Open Obsidian **Settings → Community plugins → Browse**, search for **Kindle Calibre Sync**, install, and enable it.
   - *(Or install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) by adding `divohub/kindle-calibre-sync`.)*
2. **Have Calibre ready**:
   - Make sure **Calibre** is installed and your EPUB books are in your Calibre Library (usually `~/Calibre Library` — auto-detected from Calibre's config).
3. **Sync & Read**:
   - Plug in your Kindle via USB and click the book icon in Obsidian's left ribbon (or run **Sync highlights with Calibre**).
   - If your Kindle isn't plugged in, Obsidian prompts you to pick a local `My Clippings.txt` file directly.
   - Click any `[location](calibre://...)` link in your book notes to open the EPUB side-by-side at the exact quote.

---

## What Happens Automatically

1. **Zero-Config Detection**:
   - **Kindle USB**: Scans mount points across Linux (`/run/media`, `/media`, `/mnt`), macOS (`/Volumes`), and Windows (`D:`–`Z:`) for `documents/My Clippings.txt` (or opens a file picker modal if not attached).
   - **Calibre Library**: Auto-detects your library folder from Calibre's `global.py.json` or default paths (`~/Calibre Library`, `~/Documents/Calibre Library`).
   - **Highlights Folder**: Auto-detects an existing folder containing Kindle frontmatter (`kindle-title` / `kindle-bookId`) or creates `Kindle Highlights/` inside your vault.
2. **Native Calibre SQLite Injection**:
   - Matches books in Calibre's `metadata.db` by title and author (fuzzy matching).
   - Unpacks EPUB chapters in memory and calculates exact **EPUB CFI** coordinates.
   - Injects highlights and personal notes directly into Calibre's `annotations` and `annotations_dirtied` tables using bundled SQLite WASM (`sql.js-fts5`).
3. **Obsidian Notes & Side-by-Side Reader**:
   - Compatible with `obsidian-kindle-plugin` markdown format (frontmatter, `^ref-XXXXX`, `*Note*: ...`).
   - Converts empty `[loc]()` links into deep-links `[loc](calibre://view-book/...)` and safely appends only new highlights without duplicates.
   - Clicking any location number opens the embedded `ePub.js` reader beside your note, scrolls to the exact sentence, and highlights it in warm amber (with all other book highlights shown in soft yellow).
   - Supports Light, Dark, and Sepia themes, font scaling (`A-` / `A+`), arrow-key navigation, and an optional **Open in Calibre** toolbar button.
4. **On-Demand EPUB Conversion**:
   - If a matched book in Calibre only has `.fb2`, `.azw3`, or `.mobi`, clicking its link converts it to `.epub` automatically via `ebook-convert` (if Calibre CLI tools are available).

---

## Settings

All paths are optional — leave them blank for automatic detection:

- **Calibre library path**: Override path to the folder containing `metadata.db`.
- **Highlights folder**: Vault folder where book notes are stored.
- **Fallback clippings file path**: Optional local `My Clippings.txt` used when Kindle USB isn't connected.
- **Inject highlights into Calibre**: Toggle writing annotations directly into Calibre's `metadata.db`.
- **Open reader side-by-side**: Toggle intercepting `calibre://view-book/` links in the embedded EPUB reader vs forwarding to the OS handler.

---

## Optional: Standalone Python CLI (`--watch` daemon)

For headless or automated background syncing without Obsidian open, the repository still includes the legacy Python CLI scripts (`kindle_sync.py`, `clippings_parser.py`, `calibre_adapter.py`, `obsidian_exporter.py`).

```bash
pip install -r requirements.txt
python3 kindle_sync.py --watch
```

Example `config.json` (used only by the Python CLI):

```json
{
  "vault_path": "/path/to/your/ObsidianVault",
  "highlights_folder": "Kindle Highlights",
  "calibre_library_path": "~/Calibre Library",
  "calibre_library_id": "Calibre_Library",
  "clippings_file_relpath": "documents/My Clippings.txt",
  "inject_calibre_annotations": true
}
```
