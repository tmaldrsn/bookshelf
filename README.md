# Bookshelf

A phone-friendly app for tracking the books you and your partner own, so you can check your inventory while shopping.

- **Search first.** The home screen is a search box: type a title, author or ISBN and instantly see ✓ "You own this" or ✗ "Not in your library". Typos are tolerated ("hobit" finds *The Hobbit*).
- **Bulk import from a file.** Parse your shelf photos into a JSON or CSV file and load it with the importer (see below). Duplicates are skipped.
- **Barcode scan to update records.** Scan a book's ISBN barcode and the app matches it to a record you already imported, then fills in the ISBN, publisher, year, pages and cover for *your* edition. Books that still need this are flagged on the home screen and under **Library → Needs ISBN**.
- **Check in the store.** The same scan tells you whether you own a book, and warns if you own a different edition of it. If you don't own it, you can add it on the spot.
- **Special editions & tags.** Free-text edition details, format, owner, shelf location, and custom tags.
- Data lives in one SQLite file (`data/bookshelf.db`) plus cached covers in `data/covers/`. Export to CSV from the Library page. No API keys are required.

## Setup

```bash
uv sync
cp .env.example .env     # optional: owners, port, Google Books key
uv run bookshelf
```

Open http://localhost:8765.

## Importing books

```bash
uv run python -m app.importer books.json --dry-run          # preview, changes nothing
uv run python -m app.importer books.json --enrich --owner Me
```

The file is a JSON list (or a CSV with a header row). Only `title` is required; other columns:
`authors`, `isbn`, `publisher`, `published_year`, `series`, `series_number`, `edition`, `format`,
`page_count`, `description`, `owner`, `location`, `tags` (comma/semicolon separated), `notes`, `cover_url`, `copies`.

```json
[
  {"title": "The Hobbit", "authors": "J.R.R. Tolkien", "edition": "Anniversary hardcover",
   "format": "Hardcover", "tags": "fantasy; classic", "location": "Study, top shelf"},
  {"title": "Dune", "authors": "Frank Herbert", "owner": "Spouse"}
]
```

- Rows already in the library (same ISBN, or same title and author) are skipped, so re-running a file is safe.
- `--enrich` looks details up online. **With an ISBN** it fills everything. **With only a title** it fills just the description and cover, and deliberately leaves ISBN, publisher and year blank, because a title search can return a different edition from the one you own. Scan the barcode later to fill those in.
- `--owner` / `--location` set defaults for rows that don't specify them.

### How barcode updates behave

Scanning a barcode **overwrites** the edition-specific fields on the matched record (ISBN, publisher, year, pages, cover from the web) and **only fills blanks** elsewhere (subtitle, authors, description). Your owner, location, tags, notes, edition details and any cover you uploaded yourself are never changed. To target a specific book, open it and tap **Scan barcode**.

## Use it from your phone (Tailscale)

The camera only works over **HTTPS** (or localhost). Keep the app bound to `127.0.0.1` (the default) and let Tailscale front it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\tailscale-serve.ps1
```

That gives the app its own hostname (a Tailscale Service, `svc:books`). One-time admin-console setup: tag this machine, define `svc:books` on port 443, and grant your devices access. For a quick start without Services, use `tailscale serve --bg --https=8443 http://localhost:8765` and open `https://<machine>.<tailnet>.ts.net:8443`.

**Security:** the app has no login. Only expose it on your tailnet (never use `tailscale funnel` or port-forward it).

### Start automatically at login

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1          # install
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove  # uninstall
```

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `BOOKSHELF_OWNERS` | Owner dropdown, e.g. `Tom,Sam,Shared` |
| `BOOKSHELF_HOST` / `BOOKSHELF_PORT` | Where to listen (default `127.0.0.1:8765`) |
| `BOOKSHELF_DATA_DIR` | Where the database and covers live (default `./data`) |
| `GOOGLE_BOOKS_API_KEY` | Optional; Google Books throttles anonymous use, Open Library is the fallback |

## Backup

Copy the `data/` folder.

## Layout

- `app/main.py`: FastAPI routes
- `app/db.py`: SQLite + FTS5 search, ISBN helpers, scan matching
- `app/lookup.py`: Google Books / Open Library lookup, cover caching
- `app/importer.py`: bulk import CLI
- `app/static/`: the phone UI (vanilla JS, no build step, installable PWA); `vendor/zxing.min.js` is the barcode fallback for browsers without a built-in detector (iPhone Safari)
- `scripts/`: Windows autostart and Tailscale helpers
