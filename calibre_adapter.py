#!/usr/bin/env python3
"""
Calibre Adapter
Handles matching books in Calibre SQLite DB, computing EPUB CFI,
injecting highlights into Calibre's annotations table, and building deep-links.
"""

import os
import re
import uuid
import json
import sqlite3
import zipfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, List, Dict, Tuple
from lxml import etree


@dataclass
class CalibreBook:
    book_id: int
    title: str
    authors: str
    path: str
    formats: List[str]


@dataclass
class CfiInfo:
    start_cfi: str
    end_cfi: str
    spine_index: int
    spine_name: str
    full_cfi: str


def clean_text_for_search(text: str) -> str:
    """Normalize whitespace and quotes for reliable string matching."""
    text = re.sub(r"[\s\xa0\xad]+", " ", text).strip()
    text = text.replace("«", "\"").replace("»", "\"").replace("“", "\"").replace("”", "\"")
    text = text.replace("–", "-").replace("—", "-")
    return text


class CalibreAdapter:
    def __init__(self, library_path: str, library_id: str = "Calibre_Library"):
        self.library_path = os.path.abspath(library_path)
        self.library_id = library_id
        self.db_path = os.path.join(self.library_path, "metadata.db")
        if not os.path.exists(self.db_path):
            raise FileNotFoundError(f"Calibre metadata.db not found at: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        return conn

    def get_all_books(self) -> List[CalibreBook]:
        """Loads all books and their formats from Calibre DB."""
        with self._get_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT b.id, b.title, b.path, b.author_sort,
                       GROUP_CONCAT(d.format) as formats
                FROM books b
                LEFT JOIN data d ON b.id = d.book
                GROUP BY b.id
            """)
            books = []
            for row in cur.fetchall():
                fmts = [f.upper() for f in (row["formats"] or "").split(",") if f]
                books.append(CalibreBook(
                    book_id=row["id"],
                    title=row["title"],
                    authors=row["author_sort"] or "",
                    path=row["path"],
                    formats=fmts
                ))
            return books

    def export_books_index(self, output_path: str = "books_index.json") -> dict:
        """Exports a JSON index of book_id -> epub_path and highlights for Obsidian plugin."""
        books = self.get_all_books()
        index = {}

        # Fetch all annotations
        annots_by_book = {}
        try:
            with self._get_connection() as conn:
                cur = conn.cursor()
                cur.execute("SELECT book, annot_data FROM annotations WHERE format = 'EPUB'")
                for r in cur.fetchall():
                    b_id = str(r["book"])
                    try:
                        data = json.loads(r["annot_data"])
                        start_cfi = data.get("start_cfi", "")
                        end_cfi = data.get("end_cfi", "")
                        spine_idx = data.get("spine_index", 0)
                        spine_step = 2 * (spine_idx + 1)

                        clean_start = start_cfi[2:] if start_cfi.startswith("/2/") else start_cfi
                        clean_end = end_cfi[2:] if end_cfi.startswith("/2/") else end_cfi
                        range_cfi = f"epubcfi(/6/{spine_step}!,{clean_start},{clean_end})"
                        point_cfi = f"epubcfi(/{spine_step}{start_cfi})"

                        if b_id not in annots_by_book:
                            annots_by_book[b_id] = []
                        annots_by_book[b_id].append({
                            "text": data.get("highlighted_text", ""),
                            "range_cfi": range_cfi,
                            "point_cfi": point_cfi,
                            "spine_index": spine_idx,
                            "start_cfi": start_cfi,
                            "end_cfi": end_cfi,
                        })
                    except Exception:
                        continue
        except Exception:
            pass

        for b in books:
            if "EPUB" in b.formats:
                epub_dir = os.path.join(self.library_path, b.path)
                if os.path.isdir(epub_dir):
                    epubs = [f for f in os.listdir(epub_dir) if f.lower().endswith(".epub")]
                    if epubs:
                        b_str_id = str(b.book_id)
                        index[b_str_id] = {
                            "id": b.book_id,
                            "title": b.title,
                            "authors": b.authors,
                            "epub_path": os.path.join(epub_dir, epubs[0]),
                            "highlights": annots_by_book.get(b_str_id, [])
                        }
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=2)
        return index


    def find_book(self, title: str, author: str = "") -> Optional[CalibreBook]:
        """
        Fuzzy matches a book title & author from clippings with Calibre books.
        """
        all_books = self.get_all_books()
        clean_target_title = re.sub(r"[^\w\s]", "", title.lower()).strip()
        clean_target_author = re.sub(r"[^\w\s]", "", author.lower()).strip()

        best_match = None
        best_score = 0

        for b in all_books:
            b_clean_title = re.sub(r"[^\w\s]", "", b.title.lower()).strip()
            b_clean_author = re.sub(r"[^\w\s]", "", b.authors.lower()).strip()

            score = 0
            if clean_target_title == b_clean_title:
                score += 100
            elif clean_target_title in b_clean_title or b_clean_title in clean_target_title:
                score += 60

            if clean_target_author and b_clean_author:
                if clean_target_author in b_clean_author or b_clean_author in clean_target_author:
                    score += 30

            if score > best_score and score >= 60:
                best_score = score
                best_match = b

        return best_match

    def _calculate_cfi_for_element(self, doc_root, text_node, offset: int) -> str:
        """
        Generates standard EPUB CFI path relative to document root.
        Starts with /2 for <html>.
        Formula: /2/step_child/.../text_step:offset
        """
        is_tail = getattr(text_node, "is_tail", False)
        if is_tail:
            prev_el = text_node.getparent()
            parent = prev_el.getparent() if prev_el is not None else None
        else:
            parent = text_node.getparent()

        if parent is None:
            return f"/2/1:{offset}"

        direct_tns = parent.xpath("text()")
        t_idx = 0
        for i, d in enumerate(direct_tns):
            if d.getparent() == text_node.getparent() and getattr(d, "is_tail", False) == is_tail and str(d) == str(text_node):
                t_idx = i
                break

        text_step = 2 * t_idx + 1
        el = parent

        cfi = f"/{text_step}:{offset}"
        while el is not None:
            pel = el.getparent()
            if pel is None:
                break
            try:
                el_idx = list(pel.iterchildren("*")).index(el)
                step = 2 * (el_idx + 1)
                cfi = f"/{step}" + cfi
            except ValueError:
                break
            el = pel

        return "/2" + cfi

    def find_text_cfi(self, book: CalibreBook, highlight_text: str) -> Optional[CfiInfo]:
        """
        Searches for highlight text inside the book's EPUB across text nodes and returns CFI coordinates.
        """
        if "EPUB" not in book.formats:
            return None

        epub_folder = os.path.join(self.library_path, book.path)
        if not os.path.isdir(epub_folder):
            return None
        epub_files = [f for f in os.listdir(epub_folder) if f.lower().endswith(".epub")]
        if not epub_files:
            return None

        epub_path = os.path.join(epub_folder, epub_files[0])
        clean_target = "".join(c.lower() for c in highlight_text if c.isalnum())
        if not clean_target:
            return None
        prefix = clean_target[:45] if len(clean_target) > 45 else clean_target

        try:
            with zipfile.ZipFile(epub_path, "r") as z:
                container_data = z.read("META-INF/container.xml")
                container = etree.fromstring(container_data)
                opf_path = container.xpath("//*[local-name()='rootfile']/@full-path")[0]
                opf_dir = opf_path.rsplit("/", 1)[0] if "/" in opf_path else ""

                opf_data = z.read(opf_path)
                opf = etree.fromstring(opf_data)
                manifest = {el.get("id"): el.get("href") for el in opf.xpath("//*[local-name()='item']")}
                spine = [el.get("idref") for el in opf.xpath("//*[local-name()='itemref']")]
                parser = etree.XMLParser(recover=True)

                for spine_idx, item_id in enumerate(spine):
                    href = manifest.get(item_id)
                    if not href:
                        continue
                    file_path = f"{opf_dir}/{href}" if opf_dir else href
                    try:
                        raw_content = z.read(file_path)
                    except KeyError:
                        continue

                    doc = etree.fromstring(raw_content, parser=parser)
                    text_nodes = doc.xpath("//*[local-name()='body']//text()")
                    if not text_nodes:
                        text_nodes = doc.xpath("//text()")
                    if not text_nodes:
                        continue

                    norm_chars = []
                    norm_map = []
                    for tn in text_nodes:
                        txt = str(tn)
                        for ci, ch in enumerate(txt):
                            if ch.isalnum():
                                norm_chars.append(ch.lower())
                                norm_map.append((tn, ci))

                    if not norm_map:
                        continue

                    norm_doc = "".join(norm_chars)
                    match_idx = norm_doc.find(clean_target)
                    match_len = len(clean_target)
                    if match_idx < 0 and len(prefix) >= 15:
                        match_idx = norm_doc.find(prefix)
                        if match_idx >= 0:
                            match_len = min(len(clean_target), len(norm_doc) - match_idx)

                    if match_idx >= 0:
                        start_node, start_offset = norm_map[match_idx]
                        end_idx = min(len(norm_map) - 1, match_idx + match_len - 1)
                        end_node, end_char_idx = norm_map[end_idx]
                        end_offset = min(len(str(end_node)), end_char_idx + 1)

                        # Include leading quote/bracket if present
                        if start_offset > 0 and highlight_text and not highlight_text[0].isalnum():
                            if str(start_node)[start_offset - 1] == highlight_text[0]:
                                start_offset -= 1

                        # Include trailing punctuation/quote if present
                        if end_offset < len(str(end_node)) and highlight_text and not highlight_text[-1].isalnum():
                            if str(end_node)[end_offset] == highlight_text[-1]:
                                end_offset += 1

                        start_cfi = self._calculate_cfi_for_element(doc, start_node, start_offset)
                        end_cfi = self._calculate_cfi_for_element(doc, end_node, end_offset)

                        spine_step = 2 * (spine_idx + 1)
                        full_cfi = f"epubcfi(/{spine_step}{start_cfi})"

                        return CfiInfo(
                            start_cfi=start_cfi,
                            end_cfi=end_cfi,
                            spine_index=spine_idx,
                            spine_name=file_path,
                            full_cfi=full_cfi
                        )
        except Exception:
            pass

        return None


    def inject_annotation(self, book_id: int, book_format: str, highlight_text: str,
                          cfi_info: Optional[CfiInfo] = None, note: Optional[str] = None,
                          color: str = "yellow") -> str:
        """
        Inserts a native highlight annotation into Calibre's metadata.db.
        Returns the generated annotation UUID.
        """
        annot_uuid = str(uuid.uuid4())
        now_ts = datetime.now(timezone.utc).timestamp()
        now_iso = datetime.now(timezone.utc).isoformat()

        start_cfi = cfi_info.start_cfi if cfi_info else "/2/4/2/1:0"
        end_cfi = cfi_info.end_cfi if cfi_info else "/2/4/2/1:100"
        spine_index = cfi_info.spine_index if cfi_info else 0
        spine_name = cfi_info.spine_name if cfi_info else ""

        annot_data = {
            "format_version": 1,
            "uuid": annot_uuid,
            "type": "highlight",
            "timestamp": now_iso,
            "highlighted_text": highlight_text,
            "start_cfi": start_cfi,
            "end_cfi": end_cfi,
            "spine_index": spine_index,
            "spine_name": spine_name,
            "style": {
                "which": color,
                "type": "builtin",
                "kind": "color"
            }
        }
        if note:
            annot_data["notes"] = note

        searchable_text = highlight_text
        if note:
            searchable_text += "\n\x1f\n" + note

        with self._get_connection() as conn:
            cur = conn.cursor()
            if len(highlight_text) >= 25:
                cur.execute("""
                    SELECT annot_id FROM annotations
                    WHERE book = ? AND format = ? AND (searchable_text = ? OR searchable_text LIKE ?)
                """, (book_id, book_format.upper(), searchable_text, highlight_text[:60] + "%"))
            else:
                cur.execute("""
                    SELECT annot_id FROM annotations
                    WHERE book = ? AND format = ? AND searchable_text = ?
                """, (book_id, book_format.upper(), searchable_text))
            row = cur.fetchone()

            if row:
                if cfi_info:
                    cur.execute("""
                        UPDATE annotations
                        SET annot_data = ?, searchable_text = ?
                        WHERE book = ? AND format = ? AND annot_id = ?
                    """, (json.dumps(annot_data, ensure_ascii=False), searchable_text, book_id, book_format.upper(), row["annot_id"]))
                    cur.execute("INSERT OR IGNORE INTO annotations_dirtied (book) VALUES (?)", (book_id,))
                    conn.commit()
                return row["annot_id"]

            cur.execute("""
                INSERT OR REPLACE INTO annotations (
                    book, format, user_type, user, timestamp, annot_id, annot_type, annot_data, searchable_text
                ) VALUES (?, ?, 'local', 'viewer', ?, ?, 'highlight', ?, ?)
            """, (
                book_id,
                book_format.upper(),
                now_ts,
                annot_uuid,
                json.dumps(annot_data, ensure_ascii=False),
                searchable_text
            ))
            cur.execute("INSERT OR IGNORE INTO annotations_dirtied (book) VALUES (?)", (book_id,))
            conn.commit()

        return annot_uuid

    def build_deep_link(self, book: CalibreBook, highlight_text: str, cfi_info: Optional[CfiInfo] = None) -> str:
        """
        Builds a calibre://view-book URI.
        Uses CFI when available, else search query.
        """
        fmt = "EPUB" if "EPUB" in book.formats else (book.formats[0] if book.formats else "EPUB")
        base_url = f"calibre://view-book/{self.library_id}/{book.book_id}/{fmt}"

        if cfi_info and cfi_info.full_cfi:
            encoded_cfi = urllib.parse.quote(cfi_info.full_cfi, safe="()").replace(")", "%29")
            return f"{base_url}?open_at={encoded_cfi}"
        else:
            snippet = clean_text_for_search(highlight_text)
            if len(snippet) > 60:
                snippet = snippet[:60]
            encoded_query = urllib.parse.quote(f"search:{snippet}")
            return f"{base_url}?open_at={encoded_query}"


if __name__ == "__main__":
    adapter = CalibreAdapter("/home/divo/Calibre Library")
    print(f"Loaded {len(adapter.get_all_books())} books from Calibre.")
    ubik = adapter.find_book("Ubik", "Dick")
    if ubik:
        print(f"Found: {ubik.title} (ID {ubik.book_id}, formats: {ubik.formats})")
        test_txt = "Plato"
        cfi = adapter.find_text_cfi(ubik, test_txt)
        if cfi:
            print("CFI found:", cfi.full_cfi)
            link = adapter.build_deep_link(ubik, test_txt, cfi)
            print("Link:", link)
        else:
            print("Fallback link:", adapter.build_deep_link(ubik, test_txt))
