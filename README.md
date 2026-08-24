# Handover

A self-hosted file drop for moving things between your own devices. Upload from
your phone, pick it up on your laptop, no cloud account in the middle.

---

## Why

Getting a file from a phone to a desktop on the same network is solved in theory
and awkward in practice: AirDrop only talks to Apple, SMB shares are painful on
iOS, and messaging yourself is lossy and rate-limited. Handover is one page that
writes into a folder on a server you already run.

There is no database. Every item is a plain file in one directory, so the folder
stays useful without the app — drop things in over SFTP or Samba and they appear
on the next refresh.

## Features

- Drag-and-drop upload with progress, including whole folders (structure kept)
- Browse, create folders, rename, move by dragging onto the sidebar tree, delete
- Inline preview for images, video, audio, PDF and text
- Recursive search from wherever you are
- Quick text notes written straight into the current folder
- Directory size on demand, grid and list layouts, copy-link
- Read-only mode for a download-only instance

## Running it

```bash
cp .env.example .env      # optional, the defaults are sane
docker compose up -d
```

Open `http://localhost:8100`.

| Variable            | Default  | Meaning                                 |
|---------------------|----------|-----------------------------------------|
| `DATA_DIR`          | `./data` | Host directory to serve                 |
| `HANDOVER_READONLY` | `false`  | Disable upload, rename, move and delete |
| `HANDOVER_PORT`     | `8100`   | Port on the host                        |
| `PUID` / `PGID`     | `1000`   | Owner of files the app writes           |

## Design notes

**Paths.** Every path from a request goes through `resolve()` and has to land
inside `ROOT` or it is a 403. Symlinks pointing outside break as a consequence,
which is the behaviour I wanted.

**Subpath hosting.** The frontend reads its API prefix from
`window.location.pathname` at load time. Hardcoded `/api/…` breaks the moment
the app is served under something like `/handover/`, and behind a reverse proxy
that is the normal case rather than the exception.

**Ownership.** The container runs as a regular uid, not root, so files it writes
stay editable from outside without a `chown` afterwards.

**Uploads.** Browsers send folder uploads with the relative path in the filename
field. The backend rebuilds the structure instead of flattening it, and resolves
name collisions with a `-2` suffix rather than overwriting.

**No build step.** The frontend is a single HTML file with inline CSS and JS and
no dependencies. The image is `python:3.12-slim` plus FastAPI and Uvicorn.

## License

MIT — see [LICENSE](LICENSE).
