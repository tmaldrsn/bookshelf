"""SQLite storage with an FTS5 index for fast, typo-tolerant title/author search."""

from __future__ import annotations

import difflib
import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.environ.get("BOOKSHELF_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
COVERS_DIR = DATA_DIR / "covers"
DB_PATH = DATA_DIR / "bookshelf.db"

# Columns the API reads/writes (besides id and timestamps).
FIELDS = [
    "title", "subtitle", "authors", "isbn13", "isbn10", "publisher", "published_year",
    "series", "series_number", "edition", "format", "page_count", "description",
    "owner", "location", "tags", "notes", "cover_url", "cover_file", "copies", "read_at",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    subtitle       TEXT NOT NULL DEFAULT '',
    authors        TEXT NOT NULL DEFAULT '',
    isbn13         TEXT NOT NULL DEFAULT '',
    isbn10         TEXT NOT NULL DEFAULT '',
    publisher      TEXT NOT NULL DEFAULT '',
    published_year TEXT NOT NULL DEFAULT '',
    series         TEXT NOT NULL DEFAULT '',
    series_number  TEXT NOT NULL DEFAULT '',
    edition        TEXT NOT NULL DEFAULT '',   -- special edition details
    format         TEXT NOT NULL DEFAULT '',
    page_count     INTEGER,
    description    TEXT NOT NULL DEFAULT '',
    owner          TEXT NOT NULL DEFAULT '',
    location       TEXT NOT NULL DEFAULT '',
    tags           TEXT NOT NULL DEFAULT '',   -- comma separated
    notes          TEXT NOT NULL DEFAULT '',
    cover_url      TEXT NOT NULL DEFAULT '',   -- where the cover came from
    cover_file     TEXT NOT NULL DEFAULT '',   -- cached file in data/covers
    copies         INTEGER NOT NULL DEFAULT 1,
    read_at        TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD finished reading; '' = unread
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_books_isbn13 ON books(isbn13);
CREATE INDEX IF NOT EXISTS idx_books_isbn10 ON books(isbn10);

-- Standalone FTS index keyed by book id; kept in sync from Python.
CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
    title, subtitle, authors, series, isbn, tags, publisher, edition, notes,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""

# bm25 weights, same order as the FTS columns above.
FTS_WEIGHTS = "10.0, 3.0, 6.0, 4.0, 10.0, 2.0, 1.0, 1.0, 1.0"


def init() -> None:
    COVERS_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Lightweight migration for databases created before a column existed.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(books)")}
        if "read_at" not in cols:
            conn.execute("ALTER TABLE books ADD COLUMN read_at TEXT NOT NULL DEFAULT ''")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---------- ISBN helpers ----------

def clean_isbn(value: str | None) -> str:
    return re.sub(r"[^0-9Xx]", "", value or "").upper()


def isbn10_to_13(isbn10: str) -> str:
    core = "978" + isbn10[:9]
    total = sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(core))
    return core + str((10 - total % 10) % 10)


def isbn13_to_10(isbn13: str) -> str:
    if not isbn13.startswith("978"):
        return ""
    core = isbn13[3:12]
    total = sum((10 - i) * int(d) for i, d in enumerate(core))
    check = (11 - total % 11) % 11
    return core + ("X" if check == 10 else str(check))


def valid_isbn(isbn: str) -> bool:
    """Checksum validation for a cleaned ISBN-10 or ISBN-13."""
    if len(isbn) == 13 and isbn.isdigit():
        total = sum((1 if i % 2 == 0 else 3) * int(d) for i, d in enumerate(isbn[:12]))
        return (10 - total % 10) % 10 == int(isbn[12])
    if len(isbn) == 10 and isbn[:9].isdigit() and (isbn[9].isdigit() or isbn[9] == "X"):
        total = sum((10 - i) * int(d) for i, d in enumerate(isbn[:9]))
        total += 10 if isbn[9] == "X" else int(isbn[9])
        return total % 11 == 0
    return False


def normalize_isbns(isbn13: str | None, isbn10: str | None) -> tuple[str, str]:
    i13, i10 = clean_isbn(isbn13), clean_isbn(isbn10)
    # Accept either kind in either field.
    if len(i13) == 10 and not i10:
        i10, i13 = i13, ""
    if len(i10) == 13 and not i13:
        i13, i10 = i10, ""
    if len(i10) == 10 and not i13 and i10[:9].isdigit():
        i13 = isbn10_to_13(i10)
    if len(i13) == 13 and not i10 and i13.isdigit():
        i10 = isbn13_to_10(i13)
    return i13, i10


# ---------- row <-> dict ----------

def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = [t for t in (d.get("tags") or "").split(",") if t]
    d["cover"] = f"/covers/{d['cover_file']}" if d.get("cover_file") else (d.get("cover_url") or "")
    return d


def _prepare(data: dict) -> dict:
    out = {k: data[k] for k in FIELDS if k in data}
    if "tags" in out:
        tags = out["tags"]
        if isinstance(tags, str):
            tags = tags.split(",")
        seen, clean = set(), []
        for t in tags:
            t = t.strip().lower()
            if t and t not in seen:
                seen.add(t)
                clean.append(t)
        out["tags"] = ",".join(clean)
    if "isbn13" in out or "isbn10" in out:
        out["isbn13"], out["isbn10"] = normalize_isbns(out.get("isbn13"), out.get("isbn10"))
    for k, v in list(out.items()):
        if v is None and k not in ("page_count",):
            out[k] = ""
        elif isinstance(v, str):
            out[k] = v.strip()
    return out


def _sync_fts(conn: sqlite3.Connection, book_id: int) -> None:
    conn.execute("DELETE FROM books_fts WHERE rowid = ?", (book_id,))
    row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if not row:
        return
    conn.execute(
        "INSERT INTO books_fts(rowid, title, subtitle, authors, series, isbn, tags, publisher, edition, notes)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            book_id, row["title"], row["subtitle"], row["authors"], row["series"],
            f"{row['isbn13']} {row['isbn10']}", row["tags"].replace(",", " "),
            row["publisher"], row["edition"], row["notes"],
        ),
    )


# ---------- CRUD ----------

def create_book(data: dict) -> dict:
    fields = _prepare(data)
    if not fields.get("title"):
        raise ValueError("title is required")
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    with connect() as conn:
        cur = conn.execute(f"INSERT INTO books ({cols}) VALUES ({marks})", list(fields.values()))
        book_id = cur.lastrowid
        _sync_fts(conn, book_id)
        return row_to_dict(conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone())


def update_book(book_id: int, data: dict) -> dict | None:
    fields = _prepare(data)
    with connect() as conn:
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE books SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [*fields.values(), book_id],
            )
            _sync_fts(conn, book_id)
        row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return row_to_dict(row) if row else None


def get_book(book_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return row_to_dict(row) if row else None


def delete_book(book_id: int) -> dict | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
        conn.execute("DELETE FROM books_fts WHERE rowid = ?", (book_id,))
        return row_to_dict(row)


SORTS = {
    "recent": "created_at DESC, id DESC",
    "title": "title COLLATE NOCASE",
    "author": "authors COLLATE NOCASE, title COLLATE NOCASE",
    "read": "read_at DESC, title COLLATE NOCASE",
}


def list_books(owner: str = "", tag: str = "", location: str = "", sort: str = "recent",
               limit: int = 500, offset: int = 0, missing_isbn: bool = False,
               read: str = "") -> list[dict]:
    where, args = [], []
    if read == "read":
        where.append("read_at != ''")
    elif read == "unread":
        where.append("read_at = ''")
    if missing_isbn:
        where.append("isbn13 = '' AND isbn10 = ''")
    if owner:
        where.append("owner = ?")
        args.append(owner)
    if location:
        where.append("location = ?")
        args.append(location)
    if tag:
        where.append("(',' || tags || ',') LIKE ?")
        args.append(f"%,{tag.lower()},%")
    sql = "SELECT * FROM books"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {SORTS.get(sort, SORTS['recent'])} LIMIT ? OFFSET ?"
    with connect() as conn:
        return [row_to_dict(r) for r in conn.execute(sql, [*args, limit, offset])]


def count_books() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM books").fetchone()[0]


def count_missing_isbn() -> int:
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM books WHERE isbn13 = '' AND isbn10 = ''").fetchone()[0]


def search(q: str, limit: int = 25) -> list[dict]:
    """Prefix full-text search, ISBN lookup, then a fuzzy fallback for typos."""
    q = (q or "").strip()
    if not q:
        return []
    with connect() as conn:
        # Exact ISBN (with or without hyphens, 10 or 13 digits).
        digits = clean_isbn(q)
        if len(digits) in (10, 13) and re.fullmatch(r"[0-9Xx\-\s]+", q):
            i13, i10 = normalize_isbns(digits, None)
            rows = conn.execute(
                "SELECT * FROM books WHERE (isbn13 != '' AND isbn13 = ?) OR (isbn10 != '' AND isbn10 = ?)",
                (i13, i10),
            ).fetchall()
            if rows:
                return [row_to_dict(r) for r in rows]

        tokens = re.findall(r"\w+", q.lower())
        if tokens:
            match = " ".join(f'"{t}"*' for t in tokens)
            rows = conn.execute(
                f"SELECT b.* FROM books_fts f JOIN books b ON b.id = f.rowid"
                f" WHERE books_fts MATCH ? ORDER BY bm25(books_fts, {FTS_WEIGHTS}) LIMIT ?",
                (match, limit),
            ).fetchall()
            if rows:
                return [row_to_dict(r) for r in rows]

        # Fuzzy fallback: handles misspellings like "harry poter".
        return [row_to_dict(r) for r in _fuzzy(conn, q, limit)]


def _fuzzy(conn: sqlite3.Connection, q: str, limit: int) -> list[sqlite3.Row]:
    q = q.lower()
    scored = []
    for row in conn.execute("SELECT * FROM books"):
        best = 0.0
        for text in (row["title"], f"{row['title']} {row['subtitle']}", row["authors"], row["series"]):
            text = (text or "").lower()
            if not text:
                continue
            best = max(best, difflib.SequenceMatcher(None, q, text).ratio())
            # Compare against same-length windows of words so short queries can match long titles.
            words = text.split()
            n = max(1, len(q.split()))
            for i in range(max(1, len(words) - n + 1)):
                chunk = " ".join(words[i:i + n])
                best = max(best, difflib.SequenceMatcher(None, q, chunk).ratio())
        if best >= 0.72:
            scored.append((best, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[:limit]]


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", (text or "").lower())


def _main_title(title: str) -> str:
    """Title without a subtitle or edition suffix: 'Dune: Deluxe Edition' -> 'Dune'."""
    main = re.split(r"\s*[:(\[–—]|\s+-\s+", title or "", maxsplit=1)[0]
    return main if _words(main) else (title or "")


def find_existing(title: str, authors: str = "", isbn13: str = "", isbn10: str = "") -> list[dict]:
    """Books already in the library that look like this one (for duplicate warnings)."""
    i13, i10 = normalize_isbns(isbn13, isbn10)
    with connect() as conn:
        if i13 or i10:
            rows = conn.execute(
                "SELECT * FROM books WHERE (isbn13 != '' AND isbn13 = ?) OR (isbn10 != '' AND isbn10 = ?)",
                (i13, i10),
            ).fetchall()
            if rows:
                return [row_to_dict(r) for r in rows]
        # Match on the main title, so "Dune: Deluxe Edition" still finds "Dune".
        title_tokens = _words(_main_title(title))
        if not title_tokens:
            return []
        match = "title : (" + " ".join(f'"{t}"' for t in title_tokens) + ")"
        rows = conn.execute(
            "SELECT b.* FROM books_fts f JOIN books b ON b.id = f.rowid WHERE books_fts MATCH ? LIMIT 10",
            (match,),
        ).fetchall()
    # Require the title to match closely, and the author's surname if we know it.
    wanted_full = " ".join(_words(title))
    wanted_main = " ".join(title_tokens)
    surname = (re.findall(r"\w+", authors.lower()) or [""])[-1] if authors else ""
    out = []
    for r in rows:
        have_full = " ".join(_words(r["title"]))
        have_main = " ".join(_words(_main_title(r["title"])))
        same_main = wanted_main == have_main
        if not same_main and difflib.SequenceMatcher(None, wanted_full, have_full).ratio() < 0.8:
            continue
        if surname and r["authors"] and surname not in r["authors"].lower():
            continue
        out.append(row_to_dict(r))
    return out


def match_for_scan(title: str, authors: str, isbn13: str, isbn10: str) -> dict:
    """Sort what's in the library into: same ISBN, imported copies lacking an ISBN, and other editions."""
    i13, i10 = normalize_isbns(isbn13, isbn10)
    exact = []
    if i13 or i10:
        with connect() as conn:
            exact = [row_to_dict(r) for r in conn.execute(
                "SELECT * FROM books WHERE (isbn13 != '' AND isbn13 = ?) OR (isbn10 != '' AND isbn10 = ?)",
                (i13, i10))]
    seen = {b["id"] for b in exact}
    candidates, others = [], []
    if title:
        for b in find_existing(title, authors):
            if b["id"] in seen:
                continue
            (candidates if not b["isbn13"] and not b["isbn10"] else others).append(b)
    return {"exact": exact, "candidates": candidates, "other_editions": others}


def facets() -> dict:
    with connect() as conn:
        owners = [r[0] for r in conn.execute("SELECT DISTINCT owner FROM books WHERE owner != '' ORDER BY owner")]
        locations = [r[0] for r in conn.execute(
            "SELECT DISTINCT location FROM books WHERE location != '' ORDER BY location")]
        tag_counts: dict[str, int] = {}
        for (tags,) in conn.execute("SELECT tags FROM books WHERE tags != ''"):
            for t in tags.split(","):
                tag_counts[t] = tag_counts.get(t, 0) + 1
    tags = sorted(tag_counts, key=lambda t: (-tag_counts[t], t))
    return {"owners": owners, "locations": locations, "tags": tags}
