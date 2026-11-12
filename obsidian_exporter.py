#!/usr/bin/env python3
"""
Obsidian Exporter
Syncs clippings into Obsidian notes following the exact obsidian-kindle-plugin template.
Updates existing notes by injecting Calibre deep-links into [loc]() and appending new highlights.
"""

import os
import re
from typing import List, Optional, Tuple, Dict
from clippings_parser import Clipping


def sanitize_filename(name: str) -> str:
    """Removes illegal filesystem characters."""
    return re.sub(r'[\\/*?:"<>|]', "", name).strip()


def get_note_filename(title: str, author: str) -> str:
    """
    Constructs note filename matching 'Author-Title.md' convention.
    """
    clean_title = sanitize_filename(title)
    if author:
        # Get author surname or main name
        author_parts = author.replace(",", " ").split()
        surname = author_parts[0] if author_parts else author
        return f"{sanitize_filename(surname)}-{clean_title}.md"
    return f"{clean_title}.md"


class ObsidianExporter:
    def __init__(self, vault_path: str, highlights_folder: str = "30 - Source Material"):
        self.vault_path = os.path.abspath(vault_path)
        self.folder_path = os.path.join(self.vault_path, highlights_folder)
        os.makedirs(self.folder_path, exist_ok=True)

    def find_existing_note_path(self, title: str, author: str = "", alternate_title: Optional[str] = None) -> Optional[str]:
        """
        Looks for an existing note by frontmatter title or filename similarity.
        Prioritizes exact matches across all files before falling back to substring.
        """
        titles = [t for t in [title, alternate_title] if t]
        clean_titles = [re.sub(r"[^\w\s]", "", t.lower()).strip() for t in titles]

        # Generate possible filenames
        possible_fnames = set()
        for t in titles:
            possible_fnames.add(get_note_filename(t, "").lower())
            if author:
                parts = author.replace(",", " ").split()
                if parts:
                    for p in [parts[0], parts[-1]]:
                        possible_fnames.add(f"{sanitize_filename(p)}-{sanitize_filename(t)}.md".lower())

        files = [f for f in os.listdir(self.folder_path) if f.endswith(".md")]

        # Pass 1: Exact filename match
        for fname in files:
            if fname.lower() in possible_fnames:
                return os.path.join(self.folder_path, fname)

        # Pass 2: Exact frontmatter kindle-title match
        for fname in files:
            fpath = os.path.join(self.folder_path, fname)
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    header = "".join([f.readline() for _ in range(15)])
                fm_match = re.search(r"kindle-title:\s*(.+)", header, re.IGNORECASE)
                if fm_match:
                    fm_title = re.sub(r"[^\w\s]", "", fm_match.group(1).lower()).strip()
                    if fm_title in clean_titles:
                        return fpath
            except Exception:
                continue

        # Pass 3: Title as whole word in filename
        for ct in clean_titles:
            for fname in files:
                words = re.sub(r"[^\w\s]", " ", fname.lower()).split()
                if ct in words:
                    return os.path.join(self.folder_path, fname)

        # Pass 4: Substring match (only for titles with at least 4 characters)
        for ct in clean_titles:
            if len(ct) < 4:
                continue
            for fname in files:
                clean_fn = re.sub(r"[^\w\s]", "", fname.lower()).strip()
                if ct in clean_fn:
                    return os.path.join(self.folder_path, fname)

        return None

    def export_or_update_book(self, title: str, author: str, clippings: List[Clipping],
                              calibre_links: Dict[str, str], book_id: Optional[str] = None,
                              alternate_title: Optional[str] = None) -> Tuple[str, int]:
        """
        Creates or updates an Obsidian note with highlights and Calibre links.
        Returns: (file_path, updated_count)
        """
        note_path = self.find_existing_note_path(title, author, alternate_title)
        is_new = note_path is None

        if is_new:
            fname = get_note_filename(title, author)
            note_path = os.path.join(self.folder_path, fname)
            content = self._render_new_note(title, author, clippings, calibre_links, book_id)
            with open(note_path, "w", encoding="utf-8") as f:
                f.write(content)
            return note_path, len(clippings)
        else:
            updated_count = self._update_existing_note(note_path, clippings, calibre_links)
            return note_path, updated_count

    def _render_highlight_block(self, clip: Clipping, link: str) -> str:
        loc_str = f"[{clip.location_start}]({link})" if link else f"[{clip.location_start}]()"
        block = f"{clip.text} — location: {loc_str} ^ref-{clip.ref_id}"
        if clip.note:
            block += f"\n\n*Note*: {clip.note}"
        return block

    def _render_new_note(self, title: str, author: str, clippings: List[Clipping],
                         calibre_links: Dict[str, str], book_id: Optional[str] = None) -> str:
        b_id = book_id or str(hash(title) % 100000)
        author_display = author or "Unknown"

        lines = [
            "---",
            f"kindle-bookId: '{b_id}'",
            f"kindle-title: {title}",
            f"kindle-author: '{author_display}'",
            f"kindle-highlightsCount: {len(clippings)}",
            "---",
            f"# {title}",
            "## Metadata",
            f"* Author: [[{author_display}]]",
            "",
            "## Highlights"
        ]

        for clip in clippings:
            link = calibre_links.get(clip.ref_id, "")
            lines.append(self._render_highlight_block(clip, link))
            lines.append("")
            lines.append("---")

        return "\n".join(lines) + "\n"

    def _update_existing_note(self, note_path: str, clippings: List[Clipping],
                              calibre_links: Dict[str, str]) -> int:
        with open(note_path, "r", encoding="utf-8") as f:
            content = f.read()

        updated_count = 0
        new_blocks = []

        # Find existing ref IDs in content
        existing_refs = set(re.findall(r"\^ref-(\w+)", content))

        def replace_link(match):
            nonlocal updated_count
            prefix = match.group(1)
            loc = match.group(2)
            existing_link = match.group(3)
            ref_id = match.group(4)

            # Find clipping matching ref_id or location
            target_link = calibre_links.get(ref_id)
            if not target_link:
                for c in clippings:
                    if str(c.location_start) == loc and c.ref_id in calibre_links:
                        target_link = calibre_links[c.ref_id]
                        break

            if target_link and target_link != existing_link:
                updated_count += 1
                return f"{prefix}[{loc}]({target_link}) ^ref-{ref_id}"
            return match.group(0)

        # Regex for 'location: [123](...) ^ref-456'
        content = re.sub(
            r"(location:\s*)\[(\d+)\]\((.*?)\)\s*\^ref-(\w+)",
            replace_link,
            content
        )

        # Append any clippings not in existing_refs
        for clip in clippings:
            if clip.ref_id not in existing_refs:
                # Also check by text substring to avoid double-adding if ref format differed
                clean_snippet = clip.text[:40]
                if clean_snippet not in content:
                    link = calibre_links.get(clip.ref_id, "")
                    new_blocks.append(self._render_highlight_block(clip, link))
                    updated_count += 1

        if new_blocks:
            if not content.endswith("\n"):
                content += "\n"
            for b in new_blocks:
                content += f"\n{b}\n\n---\n"

        # Update count in frontmatter
        total_refs = len(set(re.findall(r"\^ref-(\w+)", content)))
        content = re.sub(
            r"kindle-highlightsCount:\s*\d+",
            f"kindle-highlightsCount: {total_refs}",
            content
        )

        with open(note_path, "w", encoding="utf-8") as f:
            f.write(content)

        return updated_count


if __name__ == "__main__":
    exporter = ObsidianExporter("/home/divo/Documents/obsidiane-private")
    path = exporter.find_existing_note_path("Ubik", "Philip K. Dick")
    print("Found existing Ubik note:", path)
