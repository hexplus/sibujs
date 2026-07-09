import json
from pathlib import Path
from collections import Counter

d = json.loads(Path("graphify-out/.graphify_detect.json").read_text(encoding="utf-8"))
root = d.get("scan_root").replace("\\", "/")
c = Counter()
allf = []
for cat in ("code", "document", "paper", "image", "video"):
    allf += d["files"].get(cat, [])
for f in allf:
    p = f.replace("\\", "/")
    if "/graphify-out/" in p:
        continue
    rel = p[len(root):].lstrip("/") if p.startswith(root) else p
    parts = rel.split("/")
    top = parts[0] if len(parts) > 1 else "(root)"
    c[top] += 1
for name, n in c.most_common(15):
    print(f"{n:5d}  {name}")
