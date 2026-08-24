/* ===========================================================================
   Handover — browser-only demo backend.

   The frontend above this script is the production one, unmodified. Everything
   it needs from a server is answered here instead:

     - window.fetch is wrapped, and anything under <base>/api/ is routed to the
       in-memory filesystem below. Every other fetch passes through untouched.
     - window.XMLHttpRequest is wrapped for the same reason — uploads use XHR
       (the app wants progress events), so fetch alone would not cover them.
     - /f/<path> is not intercepted at all. The seeded files are real static
       files under docs/f/, so previews, video playback and downloads work the
       way they do in production. Files uploaded during the session exist only
       as blobs, so a MutationObserver swaps their URLs in the DOM.

   State lives in memory and resets on reload. Nothing is sent anywhere.
   =========================================================================== */

(() => {
  'use strict';

  /* Same derivation as the app — works at the domain root and under a subpath. */
  const BASE = location.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  const API = BASE + '/api/';
  const FILES = BASE + '/f/';

  const LATENCY = 45;          // ms, enough to exercise the app's loading paths
  const DISK_TOTAL = 916_922_286_080;
  let diskUsed = 504_233_598_976;

  /* ── filesystem ─────────────────────────────────────────────────────────
     Flat map, path -> node. The root is the empty string. Directories are not
     containers; children are found by scanning for a matching parent, which is
     fine at this size and keeps moves and renames to a single pass.          */

  const fs = new Map();
  const BAD = new Set('/\\:*?"<>|');
  const blobs = new Map();     // path -> File, for anything uploaded this session
  const urls = new Map();      // path -> object URL, created lazily

  fs.set('', { name: '', path: '', dir: true, modified: 1755500000 });

  for (const s of (window.__HANDOVER_SEED || [])) {
    fs.set(s.path, {
      name: s.path.split('/').pop(),
      path: s.path,
      dir: s.dir,
      size: s.dir ? null : s.size,
      modified: s.modified,
      mime: s.dir ? null : (s.mime || ''),
    });
  }

  const parentOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const join = (a, b) => (a && b) ? a + '/' + b : (a || b);

  function node(path) {
    const n = fs.get(path);
    if (!n) throw new Err(404, 'Není tu nic takového');
    return n;
  }

  function childrenOf(path) {
    const out = [];
    for (const n of fs.values()) {
      if (n.path !== '' && parentOf(n.path) === path) out.push(n);
    }
    return out.sort(byKind);
  }

  function descendantsOf(path) {
    const prefix = path ? path + '/' : '';
    return [...fs.values()].filter(n => n.path !== '' && n.path.startsWith(prefix));
  }

  /* Directories first, then case-insensitive by name — matches the backend. */
  const byKind = (a, b) =>
    (a.dir === b.dir ? 0 : a.dir ? -1 : 1) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'cs');

  function checkName(name) {
    name = (name || '').trim();
    if (!name || name === '.' || name === '..' || [...name].some(c => BAD.has(c))) {
      throw new Err(400, 'Neplatný název');
    }
    return name.slice(0, 180);
  }

  function unique(path) {
    if (!fs.has(path)) return path;
    const name = path.split('/').pop();
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const dir = parentOf(path);
    for (let i = 2; i < 9999; i++) {
      const cand = join(dir, `${stem}-${i}${ext}`);
      if (!fs.has(cand)) return cand;
    }
    throw new Err(507, 'Moc kolizí názvů');
  }

  function mkdirp(path) {
    if (!path || fs.has(path)) return;
    mkdirp(parentOf(path));
    fs.set(path, {
      name: path.split('/').pop(), path, dir: true,
      size: null, modified: Date.now() / 1000, mime: null,
    });
  }

  /* Rekey a node and everything under it. Used by both rename and move. */
  function relocate(from, to) {
    for (const n of [node(from), ...descendantsOf(from)]) {
      const dest = n.path === from ? to : to + n.path.slice(from.length);
      fs.delete(n.path);
      if (blobs.has(n.path)) { blobs.set(dest, blobs.get(n.path)); blobs.delete(n.path); }
      if (urls.has(n.path)) { urls.set(dest, urls.get(n.path)); urls.delete(n.path); }
      n.path = dest;
      n.name = dest.split('/').pop();
      fs.set(dest, n);
    }
  }

  function removeTree(path) {
    for (const n of [node(path), ...descendantsOf(path)]) {
      fs.delete(n.path);
      blobs.delete(n.path);
      const u = urls.get(n.path);
      if (u) { URL.revokeObjectURL(u); urls.delete(n.path); }
    }
  }

  const view = n => ({
    name: n.name, path: n.path, dir: n.dir,
    size: n.dir ? null : n.size, modified: n.modified,
    mime: n.dir ? null : (n.mime || ''),
  });

  function dirSize(path) {
    return descendantsOf(path).reduce((s, n) => s + (n.dir ? 0 : n.size || 0), 0);
  }

  /* ── routes ─────────────────────────────────────────────────────────────── */

  class Err extends Error {
    constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
  }

  const routes = {
    'GET config': () => ({
      root: 'demo',
      readonly: false,
      disk: { free: DISK_TOTAL - diskUsed, total: DISK_TOTAL },
    }),

    'GET list': ({ q }) => {
      const dir = node(q.get('path') || '');
      if (!dir.dir) throw new Err(404, 'Složka tu není');
      const crumbs = [];
      for (let p = dir.path; p; p = parentOf(p)) crumbs.unshift({ name: fs.get(p).name, path: p });
      return { path: dir.path, crumbs, entries: childrenOf(dir.path).map(view) };
    },

    'GET tree': ({ q }) => {
      const walk = (path, depth) => childrenOf(path)
        .filter(n => n.dir)
        .map(n => ({ name: n.name, path: n.path, children: depth > 1 ? walk(n.path, depth - 1) : [] }));
      return walk(q.get('path') || '', Number(q.get('depth') || 1));
    },

    'GET du': ({ q }) => {
      const dir = node(q.get('path') || '');
      if (!dir.dir) throw new Err(400, 'Není to složka');
      return { size: dirSize(dir.path) };
    },

    'GET search': ({ q }) => {
      const needle = (q.get('q') || '').trim().toLowerCase();
      if (needle.length < 2) return { entries: [] };
      const hits = descendantsOf(q.get('path') || '')
        .filter(n => n.name.toLowerCase().includes(needle))
        .slice(0, 300)
        .sort(byKind);
      return { entries: hits.map(view) };
    },

    'GET text': async ({ tail }) => {
      const n = node(tail);
      if (n.dir) throw new Err(404, 'Soubor tu není');
      if ((n.size || 0) > 512_000) throw new Err(413, 'Soubor je moc velký na náhled');
      const file = blobs.get(n.path);
      const text = file ? await file.text() : await realFetch(FILES + encodeURI(n.path)).then(r => r.text());
      // Crude but sufficient: a decoder would have replaced bad bytes silently.
      if (/\uFFFD/.test(text)) throw new Err(415, 'Není to text');
      return { content: text };
    },

    'POST mkdir': ({ body }) => {
      const parent = node(body.path || '');
      const path = unique(join(parent.path, checkName(body.name)));
      mkdirp(path);
      return view(node(path));
    },

    'POST textfile': ({ body }) => {
      const parent = node(body.path || '');
      let name = checkName(body.name || `poznámka-${Math.floor(Date.now() / 1000)}.txt`);
      if (!name.includes('.')) name += '.txt';
      const path = join(parent.path, name);
      const content = body.content || '';
      const file = new File([content], name, { type: 'text/plain' });
      fs.set(path, {
        name, path, dir: false, size: file.size,
        modified: Date.now() / 1000, mime: 'text/plain',
      });
      blobs.set(path, file);
      return view(node(path));
    },

    'POST rename': ({ body }) => {
      const src = node(body.path || '');
      if (src.path === '') throw new Err(400, 'Kořen přejmenovat nejde');
      const dest = join(parentOf(src.path), checkName(body.name));
      if (fs.has(dest)) throw new Err(409, 'Takový název už tu je');
      relocate(src.path, dest);
      return view(node(dest));
    },

    'POST move': ({ body }) => {
      const dir = node(body.dest || '');
      if (!dir.dir) throw new Err(400, 'Cíl není složka');
      const moved = [];
      for (const rel of body.paths || []) {
        const src = fs.get(rel);
        if (!src || src.path === '' || src.path === dir.path) continue;
        if (dir.path.startsWith(src.path + '/')) continue;   // no folder into itself
        const dest = unique(join(dir.path, src.name));
        relocate(src.path, dest);
        moved.push(dest);
      }
      return { moved };
    },

    'POST delete': ({ body }) => {
      const deleted = [];
      for (const rel of body.paths || []) {
        if (rel === '' || !fs.has(rel)) continue;
        diskUsed -= fs.get(rel).dir ? dirSize(rel) : (fs.get(rel).size || 0);
        removeTree(rel);
        deleted.push(rel);
      }
      return { deleted };
    },
  };

  async function route(url, init) {
    const rest = url.pathname.slice(API.length);
    const head = rest.split('/')[0];
    const tail = decodeURIComponent(rest.slice(head.length + 1));
    const method = (init?.method || 'GET').toUpperCase();
    const handler = routes[`${method} ${head}`];

    if (!handler) return json({ detail: 'Not Found' }, 404);

    let body = {};
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { /* leave empty */ }
    }

    await sleep(LATENCY);
    try {
      return json(await handler({ q: url.searchParams, tail, body }));
    } catch (e) {
      if (e instanceof Err) return json({ detail: e.detail }, e.status);
      console.error('[demo]', e);
      return json({ detail: 'Chyba v demu: ' + e.message }, 500);
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  /* ── fetch ──────────────────────────────────────────────────────────────── */

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (!url.pathname.startsWith(API)) return realFetch(input, init);
    return route(url, init || (input instanceof Request ? input : null));
  };

  /* ── upload (XHR, because the app wants progress events) ────────────────── */

  const RealXHR = window.XMLHttpRequest;

  class DemoXHR {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.readyState = 0;
      this.responseText = '';
      this._real = null;
    }
    open(method, url, ...rest) {
      const path = new URL(url, location.href).pathname;
      if (path === API + 'upload') { this._mine = true; return; }
      this._real = new RealXHR();
      this._real.open(method, url, ...rest);
    }
    setRequestHeader(...a) { this._real?.setRequestHeader(...a); }
    abort() { this._real?.abort(); this._aborted = true; }
    getAllResponseHeaders() { return this._real?.getAllResponseHeaders() ?? ''; }

    send(body) {
      if (!this._mine) {
        // Not ours — hand the listeners over and get out of the way.
        for (const k of ['onload', 'onerror', 'onprogress', 'onreadystatechange']) {
          if (this[k]) this._real[k] = this[k].bind(this._real);
        }
        if (this.upload.onprogress) this._real.upload.onprogress = this.upload.onprogress;
        return this._real.send(body);
      }
      this._upload(body).catch(e => {
        console.error('[demo]', e);
        this.status = 500;
        this.onerror?.(new ProgressEvent('error'));
      });
    }

    async _upload(fd) {
      const dest = fd.get('path') || '';
      const files = fd.getAll('files').filter(f => f instanceof File);
      const total = files.reduce((s, f) => s + f.size, 0);

      /* There is no network here, so progress is synthesised. It is not a lie
         about anything the user cares about — the bar exists to show the app
         wiring works, and instant completion would leave it untested. */
      const ticks = 12;
      for (let i = 1; i <= ticks; i++) {
        await sleep(340 / ticks);
        this.upload.onprogress?.(new ProgressEvent('progress', {
          lengthComputable: true, loaded: Math.round(total * i / ticks), total,
        }));
      }
      if (this._aborted) return;

      const saved = [];
      for (const f of files) {
        const parts = f.name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
        const dir = join(dest, parts.slice(0, -1).join('/'));
        mkdirp(dir);
        const path = unique(join(dir, checkName(parts.at(-1))));
        fs.set(path, {
          name: path.split('/').pop(), path, dir: false,
          size: f.size, modified: Date.now() / 1000,
          mime: f.type || guessMime(path),
        });
        blobs.set(path, f);
        diskUsed += f.size;
        saved.push(path);
      }

      this.status = 200;
      this.readyState = 4;
      this.responseText = JSON.stringify({ saved });
      this.onload?.(new ProgressEvent('load'));
    }
  }
  window.XMLHttpRequest = DemoXHR;

  const MIME = {
    txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv',
    json: 'application/json', yml: 'text/yaml', yaml: 'text/yaml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    zip: 'application/zip',
  };
  const guessMime = p => MIME[p.split('.').pop().toLowerCase()] || '';

  /* ── /f/ for session blobs ──────────────────────────────────────────────
     Seeded files resolve to real static files, so nothing to do there. Files
     the visitor added exist only in memory, and <img src>, <video src> and the
     download link never pass through fetch — so rewrite them in the DOM.     */

  function blobUrl(path) {
    if (!blobs.has(path)) return null;
    if (!urls.has(path)) urls.set(path, URL.createObjectURL(blobs.get(path)));
    return urls.get(path);
  }

  function relFromUrl(value) {
    if (!value) return null;
    let p;
    try { p = new URL(value, location.href).pathname; } catch { return null; }
    if (!p.startsWith(FILES)) return null;
    try { return decodeURIComponent(p.slice(FILES.length)); } catch { return null; }
  }

  function rewrite(el) {
    for (const attr of ['src', 'href']) {
      const rel = relFromUrl(el.getAttribute?.(attr));
      const url = rel && blobUrl(rel);
      if (!url) continue;
      el.setAttribute(attr, url);
      if (attr === 'href') el.setAttribute('download', rel.split('/').pop());
    }
  }

  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') rewrite(r.target);
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        rewrite(n);
        n.querySelectorAll?.('[src],[href]').forEach(rewrite);
      }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'],
  });

  /* ── badge ──────────────────────────────────────────────────────────────── */

  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('a');
    b.href = 'https://github.com/schndrdavid/handover';
    b.textContent = 'Demo — runs in your browser. Source on GitHub →';
    b.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:14px', 'transform:translateX(-50%)',
      'z-index:9999', 'padding:7px 14px', 'border-radius:999px',
      'font:500 12px/1 system-ui,sans-serif', 'letter-spacing:.01em',
      'color:#fff', 'text-decoration:none', 'white-space:nowrap',
      'background:rgba(20,22,30,.66)', 'backdrop-filter:blur(14px) saturate(160%)',
      '-webkit-backdrop-filter:blur(14px) saturate(160%)',
      'border:1px solid rgba(255,255,255,.16)',
      'box-shadow:0 6px 24px rgba(0,0,0,.28)',
    ].join(';');
    document.body.appendChild(b);
  });

  console.info('%cHandover demo', 'font-weight:600',
    '— the frontend is the production build; this file fakes the backend.');
})();
