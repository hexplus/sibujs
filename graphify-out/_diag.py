import json
from pathlib import Path

ex = json.loads(Path("graphify-out/.graphify_extract.json").read_text(encoding="utf-8"))
nodes = ex["nodes"]
edges = ex["edges"]
node_ids = {n["id"] for n in nodes}
print("nodes:", len(nodes), "edges:", len(edges))
print("\nsample node ids:")
for n in nodes[:5]:
    print("  ", repr(n["id"]), "| type:", n.get("type"), "| src:", n.get("source_file"))
print("\nsample edges:")
for e in edges[:8]:
    s, t = e.get("source"), e.get("target")
    print("  ", repr(s), "->", repr(t), "| s_in:", s in node_ids, "t_in:", t in node_ids)
missing = sum(1 for e in edges if e.get("source") not in node_ids or e.get("target") not in node_ids)
print("\nedges with a missing endpoint:", missing, "/", len(edges))
# what do missing endpoints look like?
miss_ids = set()
for e in edges:
    for x in (e.get("source"), e.get("target")):
        if x not in node_ids:
            miss_ids.add(x)
print("distinct missing endpoint ids:", len(miss_ids))
for m in list(miss_ids)[:10]:
    print("   miss:", repr(m))
