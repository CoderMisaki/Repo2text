# Repo2Text Ultra

Client-side GitHub / Codeberg / archive extractor. Source never leaves the browser.

Open over **http(s)** (Web Workers cannot load from `file://`):

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Features

- GitHub & Codeberg URL extraction (branch-aware)
- ZIP / TAR / TAR.GZ / TGZ / GZ (7z & RAR are detected and rejected clearly)
- Drag & drop, progress, cancel (`✕ Batalkan`)
- History of repository URLs only (not source)
- Copy all / copy pure code / save `.txt`
- Custom scrollbar, toast, safety modal for huge clipboard payloads
- Configurable generated-folder skip and nested-archive extraction

## Architecture

```
UI  →  Job Manager  →  Archive Worker | Adaptive Fetch
                 ↓
           Chunk Store  →  Virtual viewer / TXT export
```

- Heavy parsing and decompression run in a Web Worker (`js/worker.js`)
- Main thread only updates UI, progress, and the virtualized viewer
- No artificial upload-size ceiling; archive-bomb and memory-pressure guards abort safely
- Output order is path-sorted even when files finish out of order
- Source bytes are not reformatted (whitespace, Unicode, CRLF/LF preserved)

Enable internal metrics: `localStorage.setItem('r2tDebug','1')`.

## Frontend security

The app is static and stays in the browser. Hardening includes:

- Strict Content-Security-Policy (`script-src 'self'`, no inline JS)
- HTTPS-only GitHub/Codeberg host allowlist (rejects `github.evil.com`, credentials, `javascript:`)
- Fetch allowlist + `credentials: 'omit'`
- Path sanitization (traversal, null bytes, encoded `..`)
- Safe JSON parse (drops `__proto__` / `constructor`)
- History URLs re-validated on read
- Clickjacking frame-bust
- SVG treated as binary (scriptable format)
