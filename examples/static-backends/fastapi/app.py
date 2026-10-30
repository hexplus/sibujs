"""FastAPI serving a SibuJS app pre-rendered at build time.

    pip install fastapi uvicorn httpx
    SIBU_FIXTURE_API=http://127.0.0.1:8000 npx vite build -c fixtures/ssr-app/vite.config.ts
    DIST=fixtures/ssr-app/dist uvicorn examples.static-backends.fastapi.app:app

URL -> file mapping (what `prerender.server` writes, trailingSlash "always"):

    /                     dist/index.html
    /cotizar, /cotizar/   dist/cotizar/index.html
    /producto/taza/       dist/producto/taza/index.html
    /admin/               dist/admin/index.html   (render: "client": shell + head)
    unknown URL           dist/404.html with status 404
    redirects             dist/redirects.json      (answered here with 301/302)
    /assets/*             hashed client bundle, cached forever

Set SIBU_SIDECAR=http://127.0.0.1:3001 to render HTML per request through the
Node sidecar instead (examples/static-backends/sidecar), falling back to the
pre-rendered files when it is down.
"""

import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response

DIST = Path(os.environ.get("DIST", "dist")).resolve()
SIDECAR = os.environ.get("SIBU_SIDECAR")
REDIRECTS = {}
if (DIST / "redirects.json").exists():
    REDIRECTS = {r["from"]: r for r in json.loads((DIST / "redirects.json").read_text("utf-8"))}

app = FastAPI()

CATALOG = [
    {"id": "taza", "name": "Taza personalizada", "price": 12, "image": "/img/taza.png", "color": "#d94f30"},
    {"id": "gorra", "name": "Gorra bordada", "price": 18, "image": "/img/gorra.png", "color": "#2a6fdb"},
]


@app.get("/api/catalog")
def catalog():
    return CATALOG


@app.get("/api/catalog/{product_id}")
def product(product_id: str):
    for item in CATALOG:
        if item["id"] == product_id:
            return item
    return JSONResponse({"error": "not found"}, status_code=404)


def _inside_dist(path: Path) -> bool:
    try:
        path.resolve().relative_to(DIST)
        return True
    except ValueError:
        return False


async def _from_sidecar(request: Request):
    import httpx

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(SIDECAR + request.url.path, params=request.query_params, follow_redirects=False)
    except httpx.HTTPError:
        return None  # fall back to the pre-rendered file
    headers = {k: v for k, v in r.headers.items() if k in ("cache-control", "location", "content-type")}
    return Response(r.content, status_code=r.status_code, headers=headers)


@app.get("/{full_path:path}")
async def page(full_path: str, request: Request):
    path = "/" + full_path
    if path in REDIRECTS:
        r = REDIRECTS[path]
        return RedirectResponse(r["to"], status_code=r["status"])

    # Static assets: the hashed bundle never changes under its name.
    asset = DIST / full_path
    if full_path and asset.is_file() and _inside_dist(asset):
        headers = {"cache-control": "public, max-age=31536000, immutable"} if full_path.startswith("assets/") else {}
        return FileResponse(asset, headers=headers)

    if SIDECAR:
        rendered = await _from_sidecar(request)
        if rendered is not None:
            return rendered

    # A pre-rendered page: re-validated on every request so a rebuild shows at once.
    index = DIST / full_path / "index.html"
    if _inside_dist(index) and index.is_file():
        return FileResponse(index, headers={"cache-control": "no-cache"})

    return HTMLResponse((DIST / "404.html").read_text("utf-8"), status_code=404)
