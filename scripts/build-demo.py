#!/usr/bin/env python3
"""
Build the GitHub Pages demo from the production frontend.

There is deliberately no second copy of index.html in this repo. The demo is
app/index.html with one <script> tag injected before </body>; demo.js then
intercepts fetch() and answers from an in-memory filesystem. If the UI changes,
rerun this and the demo follows.

    python3 scripts/build-demo.py
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "app" / "index.html"
OUT = ROOT / "docs" / "index.html"

BANNER = """
<!-- ==========================================================================
     GENERATED FILE — do not edit.
     Source: app/index.html  |  Regenerate: python3 scripts/build-demo.py
     ========================================================================== -->
"""

INJECT = '<script src="sample-seed.js"></script>\n<script src="demo.js"></script>\n'


def main() -> int:
    if not SRC.exists():
        print(f"error: {SRC} not found", file=sys.stderr)
        return 1

    html = SRC.read_text(encoding="utf-8")

    if "demo.js" in html:
        print("error: source already references demo.js — wrong file?", file=sys.stderr)
        return 1

    # Inject before the closing body tag; fall back to appending.
    lowered = html.lower()
    idx = lowered.rfind("</body>")
    if idx == -1:
        print("warning: no </body> found, appending to end of document")
        html = html + INJECT
    else:
        html = html[:idx] + INJECT + html[idx:]

    # Banner goes after the doctype so the file still starts correctly.
    idx = lowered.find(">")
    if lowered.startswith("<!doctype") and idx != -1:
        html = html[: idx + 1] + BANNER + html[idx + 1 :]
    else:
        html = BANNER + html

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(html):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
