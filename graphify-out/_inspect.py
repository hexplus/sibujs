import json
from pathlib import Path
from collections import defaultdict

a = json.loads(Path("graphify-out/.graphify_analysis.json").read_text(encoding="utf-8"))
ex = json.loads(Path("graphify-out/.graphify_extract.json").read_text(encoding="utf-8"))
label = {n["id"]: n.get("label", n["id"]) for n in ex["nodes"]}

comms = a["communities"]  # community_id -> [node_ids]
members = {c: (m if isinstance(m, list) else [m]) for c, m in comms.items()}
big = {c: m for c, m in members.items() if len(m) >= 2}
print(f"communities total {len(members)}; non-singleton {len(big)}")
print("\n== NON-SINGLETON COMMUNITIES ==")
for c, m in sorted(big.items(), key=lambda x: -len(x[1])):
    names = [label.get(x, x) for x in m]
    print(f"\n[community {c}] ({len(m)} modules):")
    for nm in sorted(names):
        print("   ", nm)

print("\n== GOD NODES ==")
for g in a["gods"][:12]:
    if isinstance(g, dict):
        gid = g.get("id") or g.get("node")
        print("  ", label.get(gid, gid), "|", {k: v for k, v in g.items() if k not in ("id", "node")})
    else:
        print("  ", label.get(g, g))
