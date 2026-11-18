"""Back up the Bookshelf data: a consistent SQLite snapshot plus covers/imports, zipped.

    uv run python -m app.backup                 # create a backup and prune old ones
    uv run python -m app.backup --keep 30       # keep the 30 newest (default 14)
    uv run python -m app.backup --dest D:\\bk   # write somewhere else (e.g. another drive / cloud folder)
    uv run python -m app.backup --restore FILE  # restore a backup (stop the app first)

Safe to run while the app is running (uses SQLite's online backup API).
Destination defaults to $BOOKSHELF_BACKUP_DIR, else data/backups.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from app import db  # noqa: E402  (after load_dotenv so BOOKSHELF_DATA_DIR is honored)

PREFIX = "bookshelf-backup-"
DIRS = ("covers", "imports")


def default_dest() -> Path:
    return Path(os.environ.get("BOOKSHELF_BACKUP_DIR") or db.DATA_DIR / "backups")


def create_backup(dest: Path, keep: int) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = dest / f"{PREFIX}{stamp}.zip"
    tmp_out = out.with_suffix(".zip.part")

    with tempfile.TemporaryDirectory() as td:
        snap = Path(td) / "bookshelf.db"
        src = sqlite3.connect(db.DB_PATH, timeout=30)
        dst = sqlite3.connect(snap)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()

        with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snap, "bookshelf.db")
            for name in DIRS:
                base = db.DATA_DIR / name
                if not base.is_dir():
                    continue
                for f in base.rglob("*"):
                    if f.is_file():
                        z.write(f, f.relative_to(db.DATA_DIR).as_posix())

    # verify before keeping
    with zipfile.ZipFile(tmp_out) as z:
        if z.testzip() is not None:
            tmp_out.unlink()
            raise RuntimeError("backup zip failed integrity check")
    tmp_out.replace(out)

    for old in sorted(dest.glob(f"{PREFIX}*.zip"))[:-keep] if keep > 0 else []:
        old.unlink()
    return out


def restore(archive: Path) -> None:
    if not archive.is_file():
        sys.exit(f"No such backup: {archive}")
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    # keep what's there, just in case
    if db.DB_PATH.exists():
        safety = db.DB_PATH.with_name(f"bookshelf.db.before-restore-{datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(db.DB_PATH, safety)
        print(f"Existing database saved as {safety}")
    for ext in ("-wal", "-shm"):
        Path(str(db.DB_PATH) + ext).unlink(missing_ok=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            target = (db.DATA_DIR / member).resolve()
            if db.DATA_DIR.resolve() not in target.parents:
                sys.exit(f"Refusing unsafe path in archive: {member}")
        z.extractall(db.DATA_DIR)
    print(f"Restored {archive} into {db.DATA_DIR}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dest", type=Path, default=None)
    p.add_argument("--keep", type=int, default=14, help="backups to keep (0 = keep all)")
    p.add_argument("--restore", type=Path, metavar="ARCHIVE")
    args = p.parse_args()

    if args.restore:
        restore(args.restore)
        return
    out = create_backup(args.dest or default_dest(), args.keep)
    print(f"Backup written: {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
