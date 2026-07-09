import json
from pathlib import Path

p = Path("graphify-out/.graphify_detect.json")
d = json.loads(p.read_text(encoding="utf-8"))
root = d.get("scan_root").replace("\\", "/")

KEEP = ("packages/core/src/", "packages/sibujs/src/", "packages/labs/src/")


def keep(f: str) -> bool:
    q = f.replace("\\", "/")
    rel = q[len(root):].lstrip("/") if q.startswith(root) else q
    return rel.startswith(KEEP)


new_files = {}
total = 0
for cat, lst in d.get("files", {}).items():
    kept = [f for f in lst if keep(f)]
    new_files[cat] = kept
    total += len(kept)
d["files"] = new_files
d["total_files"] = total
# leave total_words as-is (approx); report is informational
counts = {k: len(v) for k, v in new_files.items() if v}
p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
print("filtered total_files", total)
print("counts", json.dumps(counts))
