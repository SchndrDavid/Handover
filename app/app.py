"""
Handover — lehký souborový manažer v prohlížeči nad jednou složkou.

Nic mimo ROOT se nedá přečíst ani zapsat: každá cesta z požadavku projde
resolve() a musí zůstat uvnitř ROOT. Symlinky ven se tím rozbijí taky.
"""

import mimetypes
import os
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

ROOT = Path(os.environ.get("HANDOVER_ROOT", "/data")).resolve()
STATIC = Path(__file__).parent / "index.html"
READONLY = os.environ.get("HANDOVER_READONLY", "").lower() in ("1", "true", "yes")

ROOT.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Handover")

BAD = set('/\\:*?"<>|')


def resolve(rel: str) -> Path:
    """Přeloží cestu z požadavku na skutečnou cestu uvnitř ROOT."""
    rel = (rel or "").strip().lstrip("/")
    path = (ROOT / rel).resolve()
    if path != ROOT and ROOT not in path.parents:
        raise HTTPException(403, "Mimo povolenou složku")
    return path


def rel_of(path: Path) -> str:
    return "" if path == ROOT else str(path.relative_to(ROOT))


def check_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or set(name) & BAD:
        raise HTTPException(400, "Neplatný název")
    return name[:180]


def guard() -> None:
    if READONLY:
        raise HTTPException(403, "Složka je jen pro čtení")


def unique(path: Path) -> Path:
    if not path.exists():
        return path
    stem, ext = path.stem, path.suffix
    for i in range(2, 9999):
        cand = path.with_name(f"{stem}-{i}{ext}")
        if not cand.exists():
            return cand
    raise HTTPException(507, "Moc kolizí názvů")


def describe(path: Path) -> dict:
    st = path.stat()
    is_dir = path.is_dir()
    return {
        "name": path.name,
        "path": rel_of(path),
        "dir": is_dir,
        "size": None if is_dir else st.st_size,
        "modified": st.st_mtime,
        "mime": None if is_dir else (mimetypes.guess_type(path.name)[0] or ""),
    }


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(STATIC.read_text("utf-8"))


@app.get("/api/config")
def config():
    usage = shutil.disk_usage(ROOT)
    return {
        "root": ROOT.name or "/",
        "readonly": READONLY,
        "disk": {"free": usage.free, "total": usage.total},
    }


@app.get("/api/list")
def listing(path: str = ""):
    target = resolve(path)
    if not target.is_dir():
        raise HTTPException(404, "Složka tu není")
    entries = []
    for child in target.iterdir():
        if child.name.startswith("."):
            continue
        try:
            entries.append(describe(child))
        except OSError:
            continue
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    crumbs, walk = [], target
    while walk != ROOT:
        crumbs.append({"name": walk.name, "path": rel_of(walk)})
        walk = walk.parent
    crumbs.reverse()
    return {"path": rel_of(target), "crumbs": crumbs, "entries": entries}


@app.get("/api/tree")
def tree(path: str = "", depth: int = 1):
    """Jen podsložky — pro postranní panel."""
    target = resolve(path)
    out = []
    for child in sorted(target.iterdir(), key=lambda c: c.name.lower()):
        if child.is_dir() and not child.name.startswith("."):
            node = {"name": child.name, "path": rel_of(child), "children": []}
            if depth > 1:
                node["children"] = tree(node["path"], depth - 1)
            out.append(node)
    return out


@app.get("/api/du")
def du(path: str):
    target = resolve(path)
    if not target.is_dir():
        raise HTTPException(400, "Není to složka")
    return {"size": dir_size(target)}


@app.get("/api/search")
def search(q: str, path: str = ""):
    target = resolve(path)
    needle = q.strip().lower()
    if len(needle) < 2:
        return {"entries": []}
    hits = []
    for child in target.rglob("*"):
        if child.name.startswith(".") or needle not in child.name.lower():
            continue
        try:
            hits.append(describe(child))
        except OSError:
            continue
        if len(hits) >= 300:
            break
    hits.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    return {"entries": hits}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), path: str = Form("")):
    guard()
    target = resolve(path)
    if not target.is_dir():
        raise HTTPException(400, "Cíl není složka")
    saved = []
    for up in files:
        # Prohlížeč u nahrané složky posílá relativní cestu — zachovej ji.
        parts = [p for p in (up.filename or "soubor").replace("\\", "/").split("/") if p not in ("", ".", "..")]
        dest_dir = target.joinpath(*parts[:-1]) if len(parts) > 1 else target
        resolve(rel_of(dest_dir.resolve()) if dest_dir.exists() else str(dest_dir.relative_to(ROOT)))
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = unique(dest_dir / check_name(parts[-1]))
        with dest.open("wb") as fh:
            while chunk := await up.read(1024 * 1024):
                fh.write(chunk)
        saved.append(rel_of(dest))
    return {"saved": saved}


@app.post("/api/mkdir")
def mkdir(payload: dict):
    guard()
    parent = resolve(payload.get("path", ""))
    dest = unique(parent / check_name(payload.get("name", "")))
    dest.mkdir(parents=True)
    return describe(dest)


@app.post("/api/textfile")
def textfile(payload: dict):
    guard()
    parent = resolve(payload.get("path", ""))
    name = check_name(payload.get("name") or f"poznámka-{int(time.time())}.txt")
    if "." not in name:
        name += ".txt"
    dest = resolve(str((parent / name).relative_to(ROOT)))
    dest.write_text(payload.get("content") or "", "utf-8")
    return describe(dest)


@app.post("/api/rename")
def rename(payload: dict):
    guard()
    src = resolve(payload.get("path", ""))
    if src == ROOT:
        raise HTTPException(400, "Kořen přejmenovat nejde")
    dest = src.with_name(check_name(payload.get("name", "")))
    if dest.exists():
        raise HTTPException(409, "Takový název už tu je")
    src.rename(dest)
    return describe(dest)


@app.post("/api/move")
def move(payload: dict):
    guard()
    dest_dir = resolve(payload.get("dest", ""))
    if not dest_dir.is_dir():
        raise HTTPException(400, "Cíl není složka")
    moved = []
    for rel in payload.get("paths", []):
        src = resolve(rel)
        if src == ROOT or src == dest_dir or src in dest_dir.parents:
            continue
        target = unique(dest_dir / src.name)
        shutil.move(str(src), str(target))
        moved.append(rel_of(target))
    return {"moved": moved}


@app.post("/api/delete")
def delete(payload: dict):
    guard()
    removed = []
    for rel in payload.get("paths", []):
        target = resolve(rel)
        if target == ROOT:
            continue
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)
        removed.append(rel)
    return {"deleted": removed}


@app.get("/f/{path:path}")
def serve(path: str, dl: int = 0):
    target = resolve(path)
    if not target.is_file():
        raise HTTPException(404, "Soubor tu není")
    return FileResponse(
        target,
        filename=target.name if dl else None,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
    )


@app.get("/api/text/{path:path}")
def read_text(path: str):
    target = resolve(path)
    if not target.is_file():
        raise HTTPException(404, "Soubor tu není")
    if target.stat().st_size > 512_000:
        raise HTTPException(413, "Soubor je moc velký na náhled")
    try:
        return {"content": target.read_text("utf-8")}
    except UnicodeDecodeError:
        raise HTTPException(415, "Není to text")
