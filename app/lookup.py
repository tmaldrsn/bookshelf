"""Book metadata lookup (Google Books + Open Library) and cover caching."""

from __future__ import annotations

import asyncio
import io
import os
import re
import uuid

import httpx
from PIL import Image, ImageOps

from . import db

GOOGLE_KEY = os.environ.get("GOOGLE_BOOKS_API_KEY", "")
HEADERS = {"User-Agent": "bookshelf-home-library/1.0"}
TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, headers=HEADERS, follow_redirects=True)


# ---------- Google Books ----------

def _from_google(item: dict) -> dict:
    v = item.get("volumeInfo", {})
    ids = {i.get("type"): i.get("identifier", "") for i in v.get("industryIdentifiers", [])}
    images = v.get("imageLinks", {})
    cover = images.get("thumbnail") or images.get("smallThumbnail") or ""
    if cover:
        # Bigger image, https, no page-curl effect.
        cover = cover.replace("http://", "https://").replace("&edge=curl", "").replace("zoom=1", "zoom=2")
    return {
        "title": v.get("title", ""),
        "subtitle": v.get("subtitle", ""),
        "authors": ", ".join(v.get("authors", [])),
        "isbn13": ids.get("ISBN_13", ""),
        "isbn10": ids.get("ISBN_10", ""),
        "publisher": v.get("publisher", ""),
        "published_year": (v.get("publishedDate") or "")[:4],
        "page_count": v.get("pageCount"),
        "description": re.sub(r"<[^>]+>", "", v.get("description", "")),
        "categories": v.get("categories", []),
        "cover_url": cover,
        "source": "Google Books",
    }


async def google_search(client: httpx.AsyncClient, query: str, limit: int = 5) -> list[dict]:
    params = {"q": query, "maxResults": limit, "printType": "books"}
    if GOOGLE_KEY:
        params["key"] = GOOGLE_KEY
    try:
        r = await client.get("https://www.googleapis.com/books/v1/volumes", params=params)
        r.raise_for_status()
        return [_from_google(i) for i in r.json().get("items", [])]
    except (httpx.HTTPError, ValueError):
        return []


# ---------- Open Library ----------

OL_FIELDS = ("key,title,subtitle,author_name,isbn,first_publish_year,publisher,cover_i,"
             "number_of_pages_median,subject")


def _from_openlibrary(doc: dict, prefer_isbn: str = "") -> dict:
    isbns = doc.get("isbn", []) or []
    i13 = prefer_isbn if len(prefer_isbn) == 13 else next((i for i in isbns if len(i) == 13), "")
    i10 = prefer_isbn if len(prefer_isbn) == 10 else next((i for i in isbns if len(i) == 10), "")
    cover = f"https://covers.openlibrary.org/b/id/{doc['cover_i']}-L.jpg" if doc.get("cover_i") else ""
    return {
        "title": doc.get("title", ""),
        "subtitle": doc.get("subtitle", ""),
        "authors": ", ".join(doc.get("author_name", [])[:3]),
        "isbn13": i13,
        "isbn10": i10,
        "publisher": (doc.get("publisher") or [""])[0],
        "published_year": str(doc.get("first_publish_year") or ""),
        "page_count": doc.get("number_of_pages_median"),
        "description": "",
        "categories": (doc.get("subject") or [])[:5],
        "cover_url": cover,
        "source": "Open Library",
    }


async def openlibrary_search(client: httpx.AsyncClient, *, title: str = "", author: str = "",
                             isbn: str = "", q: str = "", limit: int = 5) -> list[dict]:
    params: dict = {"limit": limit, "fields": OL_FIELDS}
    if isbn:
        params["isbn"] = isbn
    elif q:
        params["q"] = q
    else:
        params["title"] = title
        if author:
            params["author"] = author
    try:
        r = await client.get("https://openlibrary.org/search.json", params=params)
        r.raise_for_status()
        return [_from_openlibrary(d, isbn) for d in r.json().get("docs", [])]
    except (httpx.HTTPError, ValueError):
        return []


# ---------- combined lookups ----------

def _merge(primary: dict, secondary: dict | None) -> dict:
    """Fill blanks in primary from secondary."""
    if not secondary:
        return primary
    out = dict(primary)
    for k, v in secondary.items():
        if not out.get(k) and v:
            out[k] = v
    return out


def _title_close(a: str, b: str) -> bool:
    wa, wb = set(re.findall(r"\w+", a.lower())), set(re.findall(r"\w+", b.lower()))
    if not wa or not wb:
        return False
    return len(wa & wb) / min(len(wa), len(wb)) >= 0.6


async def openlibrary_edition(client: httpx.AsyncClient, isbn: str) -> dict | None:
    """Exact-edition record (publisher, pages, year, cover) for one ISBN."""
    try:
        r = await client.get(f"https://openlibrary.org/isbn/{isbn}.json")
        if r.status_code != 200:
            return None
        e = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    year = re.search(r"\d{4}", e.get("publish_date", "") or "")
    covers = [c for c in e.get("covers", []) if c and c > 0]
    return {
        "title": e.get("title", ""),
        "subtitle": e.get("subtitle", ""),
        "publisher": (e.get("publishers") or [""])[0],
        "published_year": year.group(0) if year else "",
        "page_count": e.get("number_of_pages"),
        "cover_url": f"https://covers.openlibrary.org/b/id/{covers[0]}-L.jpg" if covers else "",
        "source": "Open Library",
    }


async def lookup_isbn(isbn: str) -> dict | None:
    isbn = db.clean_isbn(isbn)
    if len(isbn) not in (10, 13):
        return None
    async with _client() as client:
        g, o, ed = await asyncio.gather(
            google_search(client, f"isbn:{isbn}", 1),
            openlibrary_search(client, isbn=isbn, limit=1),
            openlibrary_edition(client, isbn),
        )
    # Google Books is edition-accurate; else prefer the exact Open Library edition over the work-level search hit.
    best = g[0] if g else None
    if not best:
        best = _merge(ed, o[0]) if ed and o else (ed or (o[0] if o else None))
    else:
        best = _merge(best, ed)
        best = _merge(best, o[0] if o else None)
    if not best:
        return None
    # Make sure the scanned ISBN wins over whatever edition the API picked.
    best["isbn13"], best["isbn10"] = db.normalize_isbns(isbn, None)
    return best


async def lookup_title(title: str, author: str = "", limit: int = 5) -> list[dict]:
    query = f'intitle:"{title}"' + (f' inauthor:"{author}"' if author else "")
    async with _client() as client:
        g, o = await asyncio.gather(
            google_search(client, query, limit),
            openlibrary_search(client, title=title, author=author, limit=limit),
        )
        if not g and not o and author:
            # Spine text can mangle author names; retry with the title only.
            g = await google_search(client, f'intitle:"{title}"', limit)
    results = []
    for item in g:
        twin = next((x for x in o if _title_close(x["title"], item["title"])), None)
        results.append(_merge(item, twin))
    for item in o:
        if not any(_title_close(item["title"], r["title"]) and item["authors"][:10] == r["authors"][:10]
                   for r in results):
            results.append(item)
    return results[:limit]


async def lookup_query(q: str, limit: int = 8) -> list[dict]:
    """Free-text lookup for the manual 'add a book' form."""
    clean = db.clean_isbn(q)
    if len(clean) in (10, 13) and re.fullmatch(r"[0-9Xx\-\s]+", q.strip()):
        hit = await lookup_isbn(clean)
        return [hit] if hit else []
    async with _client() as client:
        g, o = await asyncio.gather(google_search(client, q, limit), openlibrary_search(client, q=q, limit=limit))
    results = list(g)
    for item in o:
        if not any(_title_close(item["title"], r["title"]) for r in results):
            results.append(item)
    return results[:limit]


async def enrich(title: str, authors: list[str], isbn: str = "") -> dict | None:
    """Best metadata match for a book Claude spotted in a photo."""
    if isbn:
        hit = await lookup_isbn(isbn)
        if hit:
            return hit
    author = authors[0] if authors else ""
    results = await lookup_title(title, author, limit=5)
    if not results:
        return None
    # Prefer a result whose title really matches and that has an ISBN and cover.
    def score(r: dict) -> float:
        s = 2.0 if _title_close(r["title"], title) else 0.0
        if author and author.split()[-1].lower() in r["authors"].lower():
            s += 1.5
        s += 0.5 if r.get("isbn13") else 0
        s += 0.3 if r.get("cover_url") else 0
        return s
    return max(results, key=score)


# ---------- covers ----------

def _save_cover_bytes(data: bytes) -> str:
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    if img.width < 20 or img.height < 20:
        raise ValueError("image too small (probably a placeholder)")
    img.thumbnail((800, 1200))
    name = f"{uuid.uuid4().hex}.jpg"
    img.save(db.COVERS_DIR / name, "JPEG", quality=85)
    return name


async def download_cover(url: str) -> str:
    """Fetch a remote cover and cache it locally. Returns the filename or ''."""
    if not url.startswith(("http://", "https://")):
        return ""
    if "covers.openlibrary.org" in url and "default=false" not in url:
        url += ("&" if "?" in url else "?") + "default=false"
    try:
        async with _client() as client:
            r = await client.get(url)
            r.raise_for_status()
        return await asyncio.to_thread(_save_cover_bytes, r.content)
    except Exception:
        return ""


def save_uploaded_cover(data: bytes) -> str:
    return _save_cover_bytes(data)


def delete_cover(name: str) -> None:
    if name and "/" not in name and "\\" not in name:
        (db.COVERS_DIR / name).unlink(missing_ok=True)
