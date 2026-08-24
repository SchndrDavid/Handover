#!/usr/bin/env python3
"""
Generate the sample files the GitHub Pages demo browses.

The demo's in-memory filesystem is *metadata only* — the actual bytes behind
/f/<path> are these real static files, so previews, video playback and
downloads work in the demo without a service worker or any other trickery.

Everything here is generated, nothing is copied from anywhere:

    python3 scripts/make-sample-data.py
    python3 scripts/build-demo.py

Requires Pillow. ffmpeg is optional — the video sample is skipped without it.
"""

import json
import mimetypes
import math
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("error: Pillow required — pip install pillow", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "f"

W, H = 1280, 800


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(path: Path, top, bottom, blobs):
    """Vertical gradient with a few soft radial blobs over it."""
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)
    for y in range(H):
        draw.line([(0, y), (W, y)], fill=lerp(top, bottom, y / (H - 1)))

    overlay = Image.new("RGB", (W, H))
    od = ImageDraw.Draw(overlay)
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    for cx, cy, r, colour, strength in blobs:
        steps = 60
        for i in range(steps, 0, -1):
            rr = r * i / steps
            fade = round(255 * strength * (1 - i / steps) ** 2)
            box = [cx - rr, cy - rr, cx + rr, cy + rr]
            od.ellipse(box, fill=colour)
            md.ellipse(box, fill=fade)
    img = Image.composite(overlay, img, mask)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, quality=88, optimize=True)
    print(f"  {path.relative_to(OUT)}  {path.stat().st_size // 1024} kB")


def rings(path: Path):
    """Concentric interference pattern — cheap and looks deliberate."""
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            a = math.hypot(x - 340, y - 300) / 26
            b = math.hypot(x - 950, y - 520) / 31
            v = (math.sin(a) + math.sin(b)) / 2
            t = (v + 1) / 2
            px[x, y] = lerp((18, 22, 38), (120, 190, 255), t)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, quality=88, optimize=True)
    print(f"  {path.relative_to(OUT)}  {path.stat().st_size // 1024} kB")


def video(path: Path) -> bool:
    if not shutil.which("ffmpeg"):
        print("  (ffmpeg missing — skipping video sample)")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "gradients=s=640x360:d=6:speed=0.12",
        "-t", "6", "-pix_fmt", "yuv420p", "-c:v", "libx264",
        "-crf", "34", "-movflags", "+faststart", str(path),
    ]
    if subprocess.run(cmd).returncode != 0:
        print("  (ffmpeg failed — skipping video sample)")
        return False
    print(f"  {path.relative_to(OUT)}  {path.stat().st_size // 1024} kB")
    return True


def text(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"  {path.relative_to(OUT)}  {path.stat().st_size} B")


def archive(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(
            {"created": "2026-08-18T22:41:00Z", "entries": 3, "tool": "handover"},
            indent=2))
        z.writestr("notes.txt", "Sample archive. Handover does not open archives.\n")
        z.writestr("old/changelog.txt", "0.1  first working upload\n0.2  folder support\n")
    print(f"  {path.relative_to(OUT)}  {path.stat().st_size} B")


WELCOME = """\
# Welcome to the Handover demo

Everything you see here runs in your browser. There is no server behind this
page — `docs/demo.js` intercepts the app's API calls and answers from a
filesystem held in memory.

Things worth trying:

- Drop a file anywhere on the page. It gets added to the listing and you can
  preview it. It never leaves your machine.
- Right-click an item for rename, delete, download and "copy link".
- Drag a selection onto a folder in the sidebar to move it.
- Search finds files recursively from wherever you are.
- Reload the page and everything resets to this starting state.

The frontend here is byte-for-byte the one that runs in the real container.
Only the backend is faked.
"""

NOTES = """\
Notes on running this thing
===========================

Runs as a single container on any box that has Docker. The data directory is
a bind mount, which means the folder stays useful without the app — copy files
in over SFTP or a Samba share and they show up on the next refresh.

Points that took a while to get right:

  Path handling
      Every path from a request goes through resolve() and has to stay inside
      ROOT. Symlinks that point outside break as a side effect, which is the
      behaviour I wanted.

  Subpath hosting
      The frontend reads its API prefix off window.location.pathname at load
      time. Absolute /api/... paths break the moment the app is served under
      something like /handover/, and reverse proxies make that common.

  File ownership
      The container runs as a normal uid, not root. Files it writes stay
      editable from outside the container without a chown afterwards.

  Uploads
      Folder uploads arrive with the relative path in the filename field. The
      backend recreates the structure instead of flattening it.
"""

COMPOSE = """\
name: handover

services:
  handover:
    build: ./app
    container_name: handover
    restart: unless-stopped
    ports:
      - "8100:8100"
    environment:
      HANDOVER_ROOT: /data
      HANDOVER_READONLY: "false"
    volumes:
      - ./data:/data
    user: "1000:1000"
"""

TODO = """\
# Todo

- [x] folder upload keeps its structure
- [x] recursive search
- [x] read-only mode
- [x] derive API prefix at runtime so subpath hosting works
- [ ] resumable uploads for anything over a gigabyte
- [ ] optional thumbnail cache instead of loading full images in the grid
- [ ] share links with an expiry
"""

LOG = """\
[2026-08-18 21:04:12] INFO   started, root=/data readonly=False
[2026-08-18 21:04:12] INFO   disk 412.7 GB free of 916.9 GB
[2026-08-18 21:07:33] INFO   upload  3 files -> Photos/
[2026-08-18 21:07:34] INFO   upload  finished in 1.9s
[2026-08-18 22:15:02] INFO   move    2 items -> Archive/
[2026-08-18 22:41:00] INFO   mkdir   Archive/2026-08
[2026-08-19 08:12:44] WARN   rejected path traversal: ../../etc/passwd
[2026-08-19 08:12:44] INFO   403 returned to 100.64.0.7
"""


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    print("generating sample data in docs/f/")

    gradient(OUT / "Photos" / "dawn.jpg", (255, 176, 92), (58, 40, 92),
             [(320, 200, 260, (255, 220, 150), 0.9), (980, 640, 340, (120, 70, 160), 0.7)])
    gradient(OUT / "Photos" / "dusk.jpg", (26, 32, 64), (10, 12, 24),
             [(900, 220, 300, (90, 140, 255), 0.8), (260, 620, 280, (200, 90, 180), 0.6)])
    rings(OUT / "Photos" / "interference.jpg")

    video(OUT / "Photos" / "timelapse.mp4")

    text(OUT / "welcome.md", WELCOME)
    text(OUT / "Documents" / "notes.txt", NOTES)
    text(OUT / "Documents" / "docker-compose.yml", COMPOSE)
    text(OUT / "Documents" / "todo.md", TODO)
    text(OUT / "Documents" / "handover.log", LOG)
    archive(OUT / "Archive" / "backup-2026-08.zip")
    text(OUT / "Archive" / "2026-08" / "changelog.txt",
         "0.1  first working upload\n0.2  folder support\n0.3  search\n")

    # Seed the demo reads its filesystem from, so the two can never disagree.
    #
    # This is emitted as a .js assignment rather than .json on purpose: the app
    # fires its first /api/list before any fetch of ours could resolve, so the
    # tree has to exist synchronously by the time demo.js runs.
    base = 1755500000  # arbitrary fixed epoch so the demo isn't dated "just now"
    manifest = []
    for i, p in enumerate(sorted(OUT.rglob("*"))):
        rel = p.relative_to(OUT).as_posix()
        node = {
            "path": rel,
            "dir": p.is_dir(),
            "modified": base - i * 7331,
        }
        if not p.is_dir():
            node["size"] = p.stat().st_size
            node["mime"] = mimetypes.guess_type(p.name)[0] or ""
        manifest.append(node)

    body = json.dumps(manifest, indent=2, ensure_ascii=False)
    (ROOT / "docs" / "sample-seed.js").write_text(
        "/* GENERATED — scripts/make-sample-data.py. Do not edit. */\n"
        f"window.__HANDOVER_SEED = {body};\n",
        encoding="utf-8")
    print(f"wrote docs/sample-seed.js ({len(manifest)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
