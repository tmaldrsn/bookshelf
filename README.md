# Bookshelf

A phone-friendly app for tracking the books you and your partner own.

- **Search first.** The home screen is a search box: type a title, author or ISBN and instantly see ✓ "You own this" or ✗ "Not in your library". Typos are tolerated ("hobit" finds *The Hobbit*).
- **Scan barcodes (no API key needed).** The Scan tab reads a book's ISBN barcode with the phone camera, looks it up on Google Books / Open Library, and tells you straight away whether you already own it. If you don't, add it in one tap (owner, location, edition details, tags are remembered between scans). You can also type the ISBN.
- **Optional: scan a whole shelf from a photo.** If you set `ANTHROPIC_API_KEY`, a "Scan a whole shelf" link appears on the Scan tab: Claude reads the spines in a photo and you review and add them in bulk. Without a key this feature is hidden and nothing else changes.
- **Special editions & tags.** Free-text edition details, format, owner, shelf location, and custom tags. Claude also notes visible edition details (e.g. sprayed edges, Folio Society) when it can see them.
- Data lives in one SQLite file (`data/bookshelf.db`) plus cached covers in `data/covers/`. Export to CSV from the Library page.

## Setup

```bash
uv sync
cp .env.example .env     # then add your ANTHROPIC_API_KEY (optional)
uv run bookshelf
```

Open http://localhost:8765. Everything except shelf-photo scanning works without an API key.

### Use it from your phone (Tailscale)

1. In `.env` set `BOOKSHELF_HOST=0.0.0.0` (or your Tailscale IP) and restart.
2. On the phone, open `http://<this-pc-tailscale-name>:8765`.
3. **The camera only works over HTTPS** (or localhost), and so does "Add to Home Screen". Easiest: `tailscale serve --bg 8765`, then use the `https://<machine>.<tailnet>.ts.net` URL it prints.

**Security:** the app has no login. Only expose it on your tailnet (never port-forward it to the internet).

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Optional: shelf-photo scanning (Claude vision) |
| `BOOKSHELF_OWNERS` | Owner dropdown, e.g. `Tom,Sam,Shared` |
| `BOOKSHELF_HOST` / `BOOKSHELF_PORT` | Where to listen (default `127.0.0.1:8765`) |
| `BOOKSHELF_MODEL` | Override the Claude model (default `claude-opus-5-5`) |
| `GOOGLE_BOOKS_API_KEY` | Optional; Google Books throttles anonymous use, Open Library is the fallback |

Each shelf-photo scan (only if enabled) is one Claude request with one image, a few cents.

## Backup

Copy the `data/` folder.

## Layout

- `app/main.py`: FastAPI routes
- `app/db.py`: SQLite + FTS5 search, ISBN helpers
- `app/scan.py`: optional Claude vision shelf scan (structured output)
- `app/lookup.py`: Google Books / Open Library lookup, cover caching
- `app/static/`: the phone UI (vanilla JS, no build step, installable PWA); `vendor/zxing.min.js` is the barcode fallback for browsers without a built-in detector (iPhone Safari)
