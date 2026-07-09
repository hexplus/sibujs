import json
import re
from pathlib import Path

ex = json.loads(Path("graphify-out/.graphify_extract.json").read_text(encoding="utf-8"))


def norm(path_no_ext: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", path_no_ext.lower()).strip("_")


def mod_id_from_src(src: str) -> str:
    s = src.replace("\\", "/")
    s = re.sub(r"\.(ts|tsx|js|jsx|mjs|cjs)$", "", s)
    return norm(s)


def label_from_src(src: str) -> str:
    s = src.replace("\\", "/")
    s = re.sub(r"\.(ts|tsx|js|jsx|mjs|cjs)$", "", s)
    m = re.match(r"packages/([^/]+)/src/(.+)", s)
    return f"{m.group(1)}: {m.group(2)}" if m else s


def pkg_of(src: str) -> str:
    m = re.match(r"packages/([^/]+)/", src.replace("\\", "/"))
    return m.group(1) if m else "?"


# symbol id -> module id, and collect module metadata from source_files
sym2mod = {}
mods = {}  # module_id -> node dict
for n in ex["nodes"]:
    src = n.get("source_file", "")
    if not src:
        continue
    mid = mod_id_from_src(src)
    sym2mod[n["id"]] = mid
    if mid not in mods:
        mods[mid] = {
            "id": mid,
            "label": label_from_src(src),
            "file_type": "code",
            "source_file": src,
            "package": pkg_of(src),
            "_origin": "ast",
        }


def resolve(endpoint: str) -> str:
    # symbol endpoint -> its module; else assume already a module id
    return sym2mod.get(endpoint, endpoint)


# collapse edges to module granularity, drop self-loops, dedup with weight sum
agg = {}
for e in ex["edges"]:
    s = resolve(e["source"])
    t = resolve(e["target"])
    if s == t:
        continue
    # ensure endpoint module nodes exist (edge-only modules e.g. barrels/externals)
    for m in (s, t):
        if m not in mods:
            lbl = re.sub(r"^packages_([a-z0-9]+)_src_", r"\1: ", m).replace("_", "/")
            pk = m.split("_")[1] if m.startswith("packages_") else "?"
            mods[m] = {"id": m, "label": lbl, "file_type": "code", "source_file": "", "package": pk, "_origin": "ast"}
    key = (s, t)
    if key in agg:
        agg[key]["weight"] += float(e.get("weight", 1.0))
    else:
        agg[key] = {
            "source": s,
            "target": t,
            "relation": e.get("relation", "imports"),
            "confidence": "EXTRACTED",
            "source_file": e.get("source_file", ""),
            "weight": float(e.get("weight", 1.0)),
        }

out = {
    "nodes": list(mods.values()),
    "edges": list(agg.values()),
    "hyperedges": [],
    "input_tokens": 0,
    "output_tokens": 0,
}
Path("graphify-out/.graphify_extract.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
print("module nodes:", len(out["nodes"]), "module edges:", len(out["edges"]))
# connectivity sanity: how many nodes have >=1 edge
deg = {}
for e in out["edges"]:
    deg[e["source"]] = deg.get(e["source"], 0) + 1
    deg[e["target"]] = deg.get(e["target"], 0) + 1
print("nodes with >=1 edge:", len(deg), "/", len(out["nodes"]))
