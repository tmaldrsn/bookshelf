"""Bookshelf: a small home-library app. Run with `uv run bookshelf`."""

from __future__ import annotations

import asyncio
import csv
import io
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import db, lookup  # noqa: E402

STATIC = Path(__file__).resolve().parent / "static"
OWNERS = [o.strip() for o in os.environ.get("BOOKSHELF_OWNERS", "Me,Spouse,Shared").split(",") if o.strip()]
FORMATS = ["Hardcover", "Paperback", "Mass market", "Box set", "Ebook", "Audiobook"]
MAX_UPLOAD = 25 * 1024 * 1024

db.init()
app = FastAPI(title="Bookshelf")


class BookIn(BaseModel):
    title: str | None = None
    subtitle: str | None = None
    authors: str | None = None
    isbn13: str | None = None
    isbn10: str | None = None
    publisher: str | None = None
    published_year: str | None = None
    series: str | None = None
    series_number: str | None = None
    edition: str | None = None
    format: str | None = None
    page_count: int | None = None
    description: str | None = None
    owner: str | None = None
    location: str | None = None
    tags: list[str] | None = None
    notes: str | None = None
    cover_url: str | None = None
    copies: int | None = None


async def _with_cover(data: dict, existing: dict | None = None) -> dict:
    """Download a remote cover_url into the local cache when it changed."""
    url = data.get("cover_url")
    if url and url.startswith("http") and (not existing or existing.get("cover_url") != url
                                           or not existing.get("cover_file")):
        name = await lookup.download_cover(url)
        if name:
            data["cover_file"] = name
            if existing and existing.get("cover_file"):
                lookup.delete_cover(existing["cover_file"])
    return data


async def _read_upload(file: UploadFile) -> bytes:
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Image too large (25 MB max)")
    if not data:
        raise HTTPException(400, "Empty upload")
    return data


# ---------- books ----------

@app.get("/api/config")
def config():
    facets = db.facets()
    facets["owners"] = list(dict.fromkeys([*OWNERS, *facets["owners"]]))
    return {"formats": FORMATS, "count": db.count_books(), **facets}


@app.get("/api/search")
def search(q: str = "", limit: int = 25):
    return db.search(q, min(limit, 100))


@app.get("/api/books")
def list_books(owner: str = "", tag: str = "", location: str = "", sort: str = "recent",
               limit: int = 500, offset: int = 0):
    return db.list_books(owner, tag, location, sort, min(limit, 2000), offset)


@app.post("/api/books", status_code=201)
async def create_book(book: BookIn):
    data = book.model_dump(exclude_none=True)
    if not data.get("title"):
        raise HTTPException(422, "Title is required")
    return db.create_book(await _with_cover(data))


@app.post("/api/books/bulk", status_code=201)
async def create_books(books: list[BookIn]):
    items = [b.model_dump(exclude_none=True) for b in books if b.title]
    items = await asyncio.gather(*(_with_cover(d) for d in items))
    return [db.create_book(d) for d in items]


@app.get("/api/books/{book_id}")
def get_book(book_id: int):
    book = db.get_book(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    return book


@app.put("/api/books/{book_id}")
async def update_book(book_id: int, book: BookIn):
    existing = db.get_book(book_id)
    if not existing:
        raise HTTPException(404, "Book not found")
    data = book.model_dump(exclude_unset=True)
    if "title" in data and not (data["title"] or "").strip():
        raise HTTPException(422, "Title is required")
    return db.update_book(book_id, await _with_cover(data, existing))


@app.delete("/api/books/{book_id}")
def delete_book(book_id: int):
    book = db.delete_book(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    lookup.delete_cover(book.get("cover_file", ""))
    return {"deleted": book_id}


@app.post("/api/books/{book_id}/cover")
async def upload_cover(book_id: int, image: UploadFile = File(...)):
    existing = db.get_book(book_id)
    if not existing:
        raise HTTPException(404, "Book not found")
    try:
        name = await asyncio.to_thread(lookup.save_uploaded_cover, await _read_upload(image))
    except Exception as e:
        raise HTTPException(400, f"Could not read image: {e}") from e
    lookup.delete_cover(existing.get("cover_file", ""))
    return db.update_book(book_id, {"cover_file": name, "cover_url": ""})


# ---------- metadata lookup ----------

@app.get("/api/isbn/{isbn}")
async def by_isbn(isbn: str):
    """Barcode flow: is this ISBN valid, do we own it, and what is it?"""
    clean = db.clean_isbn(isbn)
    if not db.valid_isbn(clean):
        raise HTTPException(422, "That doesn't look like a valid ISBN")
    i13, i10 = db.normalize_isbns(clean, None)
    meta = await lookup.lookup_isbn(clean)
    book = meta or {"title": "", "authors": "", "isbn13": i13, "isbn10": i10, "cover_url": "", "source": ""}
    book.setdefault("categories", [])
    existing = db.find_existing(book["title"], book["authors"], i13, i10)
    return {"book": book, "found": bool(meta), "existing": existing}


@app.get("/api/lookup")
async def lookup_books(q: str):
    q = q.strip()
    if not q:
        return []
    return await lookup.lookup_query(q)


# ---------- export ----------

@app.get("/api/export.csv")
def export_csv():
    books = db.list_books(sort="title", limit=1_000_000)
    cols = ["id", *[f for f in db.FIELDS if f != "cover_file"], "created_at"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    for b in books:
        w.writerow([",".join(b[c]) if c == "tags" else (b[c] if b[c] is not None else "") for c in cols])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=bookshelf.csv"})


# ---------- static ----------

db.COVERS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/covers", StaticFiles(directory=db.COVERS_DIR), name="covers")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript")


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    return FileResponse(STATIC / "index.html")


def run() -> None:
    import uvicorn

    host = os.environ.get("BOOKSHELF_HOST", "127.0.0.1")
    port = int(os.environ.get("BOOKSHELF_PORT", "8765"))
    uvicorn.run("app.main:app", host=host, port=port)
