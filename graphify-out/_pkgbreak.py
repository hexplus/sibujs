import json
from pathlib import Path
from collections import Counter

d = json.loads(Path("graphify-out/.graphify_detect.json").read_text(encoding="utf-8"))
root = d.get("scan_root").replace("\\", "/")
seg2 = Counter()   # packages/<pkg>
seg3 = Counter()   # packages/<pkg>/<sub>
allf = []
for cat in ("code", "document", "paper", "image", "video"):
    allf += d["files"].get(cat, [])
for f in allf:
    p = f.replace("\\", "/")
    if "/graphify-out/" in p:
        continue
    rel = p[len(root):].lstrip("/") if p.startswith(root) else p
    parts = rel.split("/")
    if len(parts) >= 2 and parts[0] == "packages":
        seg2[parts[1]] += 1
        if len(parts) >= 3:
            seg3[f"packages/{parts[1]}/{parts[2]}"] += 1
print("== packages/<pkg> ==")
for name, n in seg2.most_common():
    print(f"{n:5d}  {name}")
print("== packages/<pkg>/<sub> (top 12) ==")
for name, n in seg3.most_common(12):
    print(f"{n:5d}  {name}")
