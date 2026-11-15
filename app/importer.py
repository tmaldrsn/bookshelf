"""Bulk import books from a JSON or CSV file.

    uv run python -m app.importer books.json [--enrich] [--dry-run] [--owner Me] [--location "Study"]

JSON: a list of objects. CSV: a header row. Recognised columns (all optional except title):
title, subtitle, authors (or author), isbn / isbn13 / isbn10, publisher, published_year (or year),
series, series_number, edition, format, page_count, description, owner, location, tags
(comma or semicolon separated), notes, cover_url, copies.

Rows already in the library (same ISBN, or the same title and author) are skipped.

--enrich looks each book up online to fill in blanks:
  * with an ISBN: everything (edition-accurate);
  * title only: just description and cover. ISBN, publisher and year are NOT guessed, because a
    title search can return a different edition than the one you own. Scan the barcode in the
    app later to fill those in for the real edition.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import sys
from pathlib import Path

from . import db, lookup

ALIASES = {
    "author": "authors", "isbn": "isbn13", "year": "published_year", "pages": "page_count",
    "isbn-13": "isbn13", "isbn_13": "isbn13", "book_#": "series_number", "shelf": "location",
    "edition_details": "edition", "tag": "tags", "genre": "tags", "publisher_name": "publisher", "edition_notes": "edition",
}
TEXT_FIELDS = [f for f in db.FIELDS if f not in ("page_count", "tags", "copies", "cover_file")]


def load_rows(path: Path) -> list[dict]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            data = data.get("books", [])
        rows = data
    else:
        with path.open(newline="", encoding="utf-8-sig") as f:
            rows = list(csv.DictReader(f))
    return [normalize_row(r) for r in rows if isinstance(r, dict)]


def normalize_row(raw: dict) -> dict:
    row: dict = {}
    for key, value in raw.items():
        k = ALIASES.get(key.strip().lower().replace(" ", "_"), key.strip().lower().replace(" ", "_"))
        if value is None or value == "":
            continue
        if k == "authors" and isinstance(value, list):
            value = ", ".join(value)
        if k == "tags" and isinstance(value, str):
            value = [t for t in re.split(r"[;,]", value) if t.strip()]
        if k in ("page_count", "copies"):
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
        row[k] = value
    return {k: v for k, v in row.items() if k in db.FIELDS}


def _surname(authors: str) -> str:
    words = re.findall(r"\w+", authors.lower())
    return words[-1] if words else ""


async def _enrich(row: dict) -> tuple[dict, str]:
    """Return (fields to fill in, note) for a row."""
    isbn = row.get("isbn13") or row.get("isbn10") or ""
    if isbn and db.valid_isbn(db.clean_isbn(isbn)):
        meta = await lookup.lookup_isbn(isbn)
        if not meta:
            return {}, "ISBN not found online"
        fill = {k: meta.get(k) for k in ("title", "subtitle", "authors", "isbn13", "isbn10", "publisher",
                                         "published_year", "page_count", "description", "cover_url")}
        return fill, f"matched by ISBN ({meta['source']})"

    authors = row.get("authors", "")
    meta = await lookup.enrich(row["title"], [a.strip() for a in authors.split(",") if a.strip()][:1])
    if not meta or not lookup._title_close(meta["title"], row["title"]):
        return {}, "no online match"
    if authors and _surname(authors) and _surname(authors) not in meta.get("authors", "").lower():
        return {}, "no online match (author differs)"
    fill = {k: meta.get(k) for k in ("description", "cover_url")}
    return fill, f"description/cover from title match ({meta['source']})"


async def import_rows(rows: list[dict], *, enrich: bool, dry_run: bool,
                      owner: str = "", location: str = "") -> dict:
    stats = {"added": 0, "skipped": 0, "enriched": 0, "unmatched": 0}
    sem = asyncio.Semaphore(4)

    for row in rows:
        if not row.get("title"):
            print("  ! skipped a row with no title")
            stats["skipped"] += 1
            continue
        row.setdefault("owner", owner) if owner else None
        row.setdefault("location", location) if location else None
        label = f"{row['title']}" + (f" — {row['authors']}" if row.get("authors") else "")

        dupes = db.find_existing(row["title"], row.get("authors", ""), row.get("isbn13", ""), row.get("isbn10", ""))
        if dupes and row.get("isbn13"):
            # A different ISBN means a different edition you also own, so only an ISBN match is a duplicate.
            i13, i10 = db.normalize_isbns(row.get("isbn13", ""), row.get("isbn10", ""))
            dupes = [d for d in dupes if (i13 and d["isbn13"] == i13) or (i10 and d["isbn10"] == i10)]
        if dupes:
            print(f"  = already have: {label}")
            stats["skipped"] += 1
            continue

        note = ""
        if enrich:
            async with sem:
                fill, note = await _enrich(row)
            for k, v in fill.items():
                if v and not row.get(k):
                    row[k] = v
            if fill:
                stats["enriched"] += 1
            else:
                stats["unmatched"] += 1
            # Filling in an ISBN can reveal a duplicate we couldn't see before.
            if row.get("isbn13") and db.find_existing(row["title"], row.get("authors", ""),
                                                      row.get("isbn13", ""), row.get("isbn10", "")):
                print(f"  = already have: {label}")
                stats["skipped"] += 1
                continue

        print(f"  + {label}" + (f"  [{note}]" if note else ""))
        stats["added"] += 1
        if dry_run:
            continue
        if row.get("cover_url", "").startswith("http"):
            name = await lookup.download_cover(row["cover_url"])
            if name:
                row["cover_file"] = name
        db.create_book(row)
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Import books from a JSON or CSV file")
    ap.add_argument("file", type=Path)
    ap.add_argument("--enrich", action="store_true", help="look up missing details online")
    ap.add_argument("--dry-run", action="store_true", help="show what would happen, change nothing")
    ap.add_argument("--owner", default="", help="default owner for rows without one")
    ap.add_argument("--location", default="", help="default location for rows without one")
    args = ap.parse_args(argv)

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    db.init()
    rows = load_rows(args.file)
    print(f"Read {len(rows)} rows from {args.file}" + (" (dry run)" if args.dry_run else ""))
    stats = asyncio.run(import_rows(rows, enrich=args.enrich, dry_run=args.dry_run,
                                    owner=args.owner, location=args.location))
    print(f"\nAdded {stats['added']}, skipped {stats['skipped']} duplicates"
          + (f", enriched {stats['enriched']}, no online match for {stats['unmatched']}" if args.enrich else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
