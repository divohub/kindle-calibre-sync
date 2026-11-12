#!/usr/bin/env python3
"""
Kindle My Clippings Parser
Extracts highlights, notes, and bookmarks with support for RU and EN locales.
"""

import re
import hashlib
from dataclasses import dataclass, field
from typing import List, Optional, Dict


@dataclass
class Clipping:
    title: str
    author: str
    entry_type: str  # 'highlight', 'note', 'bookmark'
    page: Optional[int]
    location_start: int
    location_end: int
    date_str: str
    text: str
    ref_id: str
    note: Optional[str] = None


def normalize_title_author(raw_title_line: str):
    """
    Extracts title and author from line 1 of a clipping.
    Format is typically: 'Book Title (Author Name)'
    """
    raw = raw_title_line.strip().lstrip("\ufeff")
    # Check for author in trailing parenthesis
    match = re.search(r"^(.*?)\s*\(([^()]+)\)\s*$", raw)
    if match:
        title = match.group(1).strip()
        author = match.group(2).strip()
    else:
        title = raw
        author = ""
    return title, author


def parse_metadata_line(meta_line: str):
    """
    Parses metadata line for type, page, location, and date.
    Examples:
    – Ваш выделенный отрывок на странице 200 | Место 3059–3064 | Добавлено: ...
    – Ваша заметка на странице 317 | Место 4860 | Добавлено: ...
    – Your Highlight on page 200 | location 3059-3064 | Added on ...
    """
    meta = meta_line.strip().lstrip("–-").strip()
    lower_meta = meta.lower()

    if "выделенный" in lower_meta or "highlight" in lower_meta:
        entry_type = "highlight"
    elif "заметка" in lower_meta or "note" in lower_meta:
        entry_type = "note"
    elif "закладка" in lower_meta or "bookmark" in lower_meta:
        entry_type = "bookmark"
    else:
        entry_type = "highlight"

    # Extract page
    page_match = re.search(r"(?:странице|page)\s*(\d+)", meta, re.IGNORECASE)
    page = int(page_match.group(1)) if page_match else None

    # Extract location
    loc_match = re.search(r"(?:место|location)\s*(\d+)(?:[–-](\d+))?", meta, re.IGNORECASE)
    if loc_match:
        loc_start = int(loc_match.group(1))
        loc_end = int(loc_match.group(2)) if loc_match.group(2) else loc_start
    else:
        loc_start = 0
        loc_end = 0

    # Extract date part
    date_part = ""
    if "добавлено:" in lower_meta:
        date_part = meta.split("обавлено:", 1)[1].strip()
    elif "added on" in lower_meta:
        date_part = meta.split("dded on", 1)[1].strip()

    return entry_type, page, loc_start, loc_end, date_part


def parse_clippings(file_path: str) -> Dict[str, List[Clipping]]:
    """
    Parses a My Clippings.txt file and returns a dict mapping book_title -> list of Clippings.
    Notes are linked to corresponding highlights when locations match or follow immediately.
    """
    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        content = f.read()

    raw_blocks = content.split("==========")
    books: Dict[str, List[Clipping]] = {}

    for block in raw_blocks:
        lines = [line.strip() for line in block.strip().splitlines() if line.strip()]
        if len(lines) < 2:
            continue

        raw_title_line = lines[0]
        meta_line = lines[1]
        text = "\n".join(lines[2:]).strip() if len(lines) > 2 else ""

        title, author = normalize_title_author(raw_title_line)
        entry_type, page, loc_start, loc_end, date_str = parse_metadata_line(meta_line)

        if not text and entry_type != "bookmark":
            continue

        # Deterministic 5-digit ref ID matching obsidian-kindle-plugin style
        ref_hash = int(hashlib.md5(f"{title}:{loc_start}:{text}".encode("utf-8")).hexdigest()[:6], 16)
        ref_id = str(ref_hash % 90000 + 10000)

        clipping = Clipping(
            title=title,
            author=author,
            entry_type=entry_type,
            page=page,
            location_start=loc_start,
            location_end=loc_end,
            date_str=date_str,
            text=text,
            ref_id=ref_id,
        )

        if title not in books:
            books[title] = []
        books[title].append(clipping)

    # Post-process: associate notes with matching highlights (both before and after)
    result: Dict[str, List[Clipping]] = {}
    for title, clist in books.items():
        highlights = [c for c in clist if c.entry_type == "highlight"]
        notes = [c for c in clist if c.entry_type == "note"]

        unmatched_notes = []
        for n in notes:
            matched = False
            for h in highlights:
                if (
                    (h.location_start <= n.location_start <= h.location_end + 5)
                    or abs(h.location_start - n.location_start) <= 5
                    or abs(h.location_end - n.location_start) <= 5
                ):
                    h.note = (h.note + "\n" + n.text) if h.note else n.text
                    matched = True
                    break
            if not matched:
                unmatched_notes.append(n)

        # Result is highlights plus only truly orphan notes
        result[title] = highlights + unmatched_notes


    return result


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "/home/divo/My Clippings.txt"
    parsed = parse_clippings(path)
    print(f"Parsed {len(parsed)} books from {path}.")
    for b_title, items in list(parsed.items())[:3]:
        print(f" - {b_title}: {len(items)} items")
