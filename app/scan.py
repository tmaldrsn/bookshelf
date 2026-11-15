"""Identify books in a photo with Claude's vision model."""

from __future__ import annotations

import base64
import io
import os
from typing import Literal

import anthropic
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

MODEL = os.environ.get("BOOKSHELF_MODEL", "claude-opus-5-5")
MAX_EDGE = 2576  # long edge in px; spines need resolution, the API downsizes anything bigger

_client: anthropic.AsyncAnthropic | None = None


def client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic()
    return _client


class DetectedBook(BaseModel):
    title: str = Field(description="Full title as best you can tell, properly capitalised")
    authors: list[str] = Field(description="Author names, empty if not visible or not known")
    isbn: str = Field(description="ISBN if printed/visible (e.g. under a barcode), otherwise empty string")
    edition_notes: str = Field(
        description="Visible special-edition details: publisher series (e.g. Folio Society, Penguin "
                    "Clothbound Classics), collector's/anniversary/illustrated/deluxe edition, sprayed "
                    "or stencilled edges, box set, signed, first edition markings. Empty if none.")
    format: Literal["Hardcover", "Paperback", "Mass market", "Box set", "Unknown"]
    suggested_tags: list[str] = Field(description="1-3 short lowercase genre tags, e.g. fantasy, sci-fi, history")
    visible_text: str = Field(description="The raw text you could read on the spine/cover")
    confidence: Literal["high", "medium", "low"]


class ScanResult(BaseModel):
    books: list[DetectedBook]


SHELF_PROMPT = """This is a photo of a bookshelf (or a stack of books). Identify every book you can see, \
reading the spines left to right, top shelf to bottom shelf.

- Use your knowledge to turn partial spine text into the real, full title and author \
(e.g. spine "TOLKIEN  THE HOBBIT" -> title "The Hobbit", authors ["J.R.R. Tolkien"]).
- Include books even if you can only read part of the spine, but mark those confidence "low".
- Do not invent books you cannot see. Skip non-book objects.
- Note visible special-edition details (publisher imprint series, decorative editions, etc.)."""

COVER_PROMPT = """This is a photo of a single book's cover, spine, or back (possibly in a bookstore). \
Identify the book. If an ISBN is printed (often above or below the barcode), read it carefully \
digit by digit. Note any visible special-edition details. Return exactly one book unless the \
photo clearly shows several."""


def prepare_image(data: bytes) -> tuple[str, str]:
    """Rotate per EXIF, downscale, re-encode as JPEG. Returns (base64, media_type)."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_EDGE, MAX_EDGE))
    quality = 88
    while True:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality)
        # API limit is 5 MB of base64 per image (~3.7 MB raw).
        if buf.tell() < 3_600_000 or quality <= 50:
            break
        quality -= 10
    return base64.standard_b64encode(buf.getvalue()).decode(), "image/jpeg"


class ScanError(Exception):
    pass


async def identify(image_bytes: bytes, mode: Literal["shelf", "cover"] = "shelf") -> list[DetectedBook]:
    try:
        b64, media_type = prepare_image(image_bytes)
    except Exception as e:
        raise ScanError(f"Could not read that image: {e}") from e

    try:
        response = await client().beta.messages.parse(
            model=MODEL,
            max_tokens=16000,
            output_config={"effort": "medium"},
            # If a safety classifier ever declines, retry on a fallback model automatically.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": SHELF_PROMPT if mode == "shelf" else COVER_PROMPT},
                ],
            }],
            output_format=ScanResult,
        )
    except anthropic.AuthenticationError as e:
        raise ScanError("Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY in .env.") from e
    except anthropic.RateLimitError as e:
        raise ScanError("Rate limited by the Anthropic API. Try again in a minute.") from e
    except anthropic.BadRequestError as e:
        raise ScanError(f"The API rejected the request: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ScanError("Could not reach the Anthropic API. Check the server's internet connection.") from e
    except anthropic.APIStatusError as e:
        raise ScanError(f"Anthropic API error ({e.status_code}). Try again.") from e

    if response.stop_reason == "refusal":
        raise ScanError("The model declined to process this image.")
    if response.stop_reason == "max_tokens":
        raise ScanError("Too many books in one photo. Try photographing one shelf at a time.")
    parsed = response.parsed_output
    if parsed is None:
        raise ScanError("Could not understand the model's response. Try again.")
    return parsed.books
