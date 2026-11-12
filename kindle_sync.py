#!/usr/bin/env python3
"""
Kindle <-> Calibre <-> Obsidian Synchronization Bridge

Workflow:
1. Detects connected Kindle USB device (or uses local My Clippings.txt).
2. Parses highlights, notes, and locations.
3. Matches books in Calibre library.
4. Searches EPUB files for exact text, calculates EPUB CFIs.
5. Injects native highlights and notes into Calibre SQLite database.
6. Generates/updates notes in Obsidian with live calibre:// deep-links.
"""

import os
import glob
import json
import time
import argparse
from typing import Optional, Dict

from clippings_parser import parse_clippings, Clipping
from calibre_adapter import CalibreAdapter, CalibreBook
from obsidian_exporter import ObsidianExporter


def load_config(config_path: str = "config.json") -> dict:
    if not os.path.isabs(config_path):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.join(script_dir, config_path)

    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def detect_kindle_clippings(config: dict) -> Optional[str]:
    """
    Scans USB mount points for Kindle 'documents/My Clippings.txt'.
    """
    patterns = config.get("kindle_mount_patterns", [
        "/run/media/*/*",
        "/media/*/*",
        "/Volumes/*"
    ])
    rel_path = config.get("clippings_file_relpath", "documents/My Clippings.txt")

    for pat in patterns:
        for mount in glob.glob(pat):
            candidate = os.path.join(mount, rel_path)
            if os.path.isfile(candidate):
                return candidate

    return None


def run_sync(clippings_path: Optional[str] = None, dry_run: bool = False,
             target_book: Optional[str] = None, config_path: str = "config.json"):
    config = load_config(config_path)

    # 1. Locate My Clippings.txt
    if not clippings_path:
        detected = detect_kindle_clippings(config)
        if detected:
            print(f"[+] Detected connected Kindle: {detected}")
            clippings_path = detected
        else:
            fallback = config.get("clippings_fallback_path", "")
            if fallback and os.path.isfile(fallback):
                print(f"[*] Kindle not connected. Using local file: {fallback}")
                clippings_path = fallback
            else:
                print("[-] Kindle not found and local My Clippings.txt is missing.")
                print("    Connect Kindle via USB or specify path using --clippings <path>")
                return

    # 2. Parse clippings
    print(f"[*] Parsing highlights from {clippings_path}...")
    books_clippings = parse_clippings(clippings_path)
    total_books = len(books_clippings)
    total_clips = sum(len(c) for c in books_clippings.values())
    print(f"[+] Recognized: {total_books} books, {total_clips} highlights/notes.")

    # 3. Setup Calibre & Obsidian adapters
    calibre_path = config.get("calibre_library_path", os.path.expanduser("~/Calibre Library"))
    calibre_id = config.get("calibre_library_id", "Calibre_Library")
    vault_path = config.get("vault_path", "")
    highlights_folder = config.get("highlights_folder", "30 - Source Material")
    inject_annots = config.get("inject_calibre_annotations", True)

    try:
        calibre = CalibreAdapter(calibre_path, calibre_id)
        print(f"[+] Connected to Calibre library: {calibre_path}")
        index_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books_index.json")
        calibre.export_books_index(index_file)
    except Exception as e:
        print(f"[-] Failed to connect to Calibre ({calibre_path}): {e}")
        calibre = None

    if not vault_path or not os.path.isdir(vault_path):
        print(f"[-] Obsidian vault path not found: {vault_path}")
        return

    exporter = ObsidianExporter(vault_path, highlights_folder)
    print(f"[+] Obsidian notes folder: {os.path.join(vault_path, highlights_folder)}")

    # 4. Process each book
    matched_books_count = 0
    injected_annots_count = 0
    cfi_found_count = 0

    for title, clippings in books_clippings.items():
        if target_book and target_book.lower() not in title.lower():
            continue

        author = clippings[0].author if clippings else ""
        calibre_book: Optional[CalibreBook] = None
        calibre_links: Dict[str, str] = {}

        if calibre:
            calibre_book = calibre.find_book(title, author)

        if calibre_book:
            matched_books_count += 1
            print(f"\n[Book] '{title}' -> Calibre ID {calibre_book.book_id} ('{calibre_book.title}')")

            for clip in clippings:
                cfi_info = None
                if "EPUB" in calibre_book.formats:
                    cfi_info = calibre.find_text_cfi(calibre_book, clip.text)

                if cfi_info:
                    cfi_found_count += 1

                link = calibre.build_deep_link(calibre_book, clip.text, cfi_info)
                calibre_links[clip.ref_id] = link

                if inject_annots and not dry_run:
                    fmt = "EPUB" if "EPUB" in calibre_book.formats else (calibre_book.formats[0] if calibre_book.formats else "EPUB")
                    calibre.inject_annotation(
                        book_id=calibre_book.book_id,
                        book_format=fmt,
                        highlight_text=clip.text,
                        cfi_info=cfi_info,
                        note=clip.note
                    )
                    injected_annots_count += 1
        else:
            print(f"\n[Book] '{title}' (not found in Calibre, deep-links built by title)")

        # Export / update in Obsidian
        if not dry_run:
            book_id_str = str(calibre_book.book_id) if calibre_book else None
            note_path, updated_num = exporter.export_or_update_book(
                title=title,
                author=author,
                clippings=clippings,
                calibre_links=calibre_links,
                book_id=book_id_str,
                alternate_title=calibre_book.title if calibre_book else None
            )
            print(f"  -> Obsidian: {os.path.basename(note_path)} ({updated_num} highlights synced)")
        else:
            print(f"  [DRY-RUN] Skipping Obsidian write for '{title}'")

        if calibre:
            index_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "books_index.json")
            calibre.export_books_index(index_file)

    print("\n" + "=" * 50)
    print("Sync complete:")
    print(f" - Source books: {len(books_clippings)}")
    print(f" - Matched in Calibre: {matched_books_count}")
    print(f" - Exact EPUB CFIs computed: {cfi_found_count}")
    if inject_annots and not dry_run:
        print(f" - Annotations added to Calibre: {injected_annots_count}")
    print("=" * 50)


def watch_mode(poll_interval: int = 5, config_path: str = "config.json"):
    """
    Watches for Kindle USB connection and triggers sync automatically.
    """
    config = load_config(config_path)
    print(f"[*] Watching for Kindle USB connection (interval {poll_interval}s)...")
    last_clippings_mtime = None

    while True:
        clippings_file = detect_kindle_clippings(config)
        if clippings_file and os.path.exists(clippings_file):
            current_mtime = os.path.getmtime(clippings_file)
            if last_clippings_mtime is None or current_mtime > last_clippings_mtime:
                print(f"\n[!] Detected Kindle: {clippings_file}")
                run_sync(clippings_path=clippings_file, config_path=config_path)
                last_clippings_mtime = current_mtime
        time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(description="Kindle <-> Calibre <-> Obsidian Highlight Bridge")
    parser.add_argument("--clippings", "-c", help="Path to My Clippings.txt (if Kindle not connected)")
    parser.add_argument("--dry-run", action="store_true", help="Simulation only without modifying files or Calibre")
    parser.add_argument("--book", "-b", help="Sync only the book matching this title")
    parser.add_argument("--watch", "-w", action="store_true", help="Run background watcher for Kindle USB connections")
    parser.add_argument("--config", default="config.json", help="Path to config.json")
    parser.add_argument("--get-epub", help="Get EPUB path by Calibre book_id")
    parser.add_argument("--export-index", action="store_true", help="Export books_index.json")

    args = parser.parse_args()

    if args.get_epub or args.export_index:
        cfg = load_config(args.config)
        calibre_path = cfg.get("calibre_library_path", os.path.expanduser("~/Calibre Library"))
        calibre = CalibreAdapter(calibre_path)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        idx = calibre.export_books_index(os.path.join(script_dir, "books_index.json"))
        if args.get_epub:
            info = idx.get(str(args.get_epub))
            if info:
                print(info["epub_path"])
            else:
                print(f"Book ID {args.get_epub} not found", file=sys.stderr)
        return

    if args.watch:
        watch_mode(config_path=args.config)
    else:
        run_sync(
            clippings_path=args.clippings,
            dry_run=args.dry_run,
            target_book=args.book,
            config_path=args.config
        )


if __name__ == "__main__":
    main()
