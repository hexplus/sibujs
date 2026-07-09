import json
import re
from pathlib import Path
from graphify.build import build_from_json
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate

extraction = json.loads(Path("graphify-out/.graphify_extract.json").read_text(encoding="utf-8"))
detection = json.loads(Path("graphify-out/.graphify_detect.json").read_text(encoding="utf-8"))
analysis = json.loads(Path("graphify-out/.graphify_analysis.json").read_text(encoding="utf-8"))

G = build_from_json(extraction, root=".", directed=False)
communities = {int(k): v for k, v in analysis["communities"].items()}
cohesion = {int(k): v for k, v in analysis["cohesion"].items()}
tokens = {"input": 0, "output": 0}

label_of = {n["id"]: n.get("label", n["id"]) for n in extraction["nodes"]}

NAMES = {
    0: "Rendering & Lifecycle",
    1: "Signals & Reactivity Core",
    2: "Islands & Attribute Binding",
    3: "Testing Utilities",
    4: "Data Fetching",
    5: "Element Factories",
    6: "UI Library Adapters",
    7: "Motion & Animation",
    8: "State Library Adapters",
    9: "Router & SSR",
    10: "DevTools Profiler",
    11: "Compiled Performance",
    12: "Scheduler & Concurrency",
}


def short(lbl: str) -> str:
    return re.sub(r"^[a-z]: ", "", lbl).split("/")[-1]


labels = {}
for cid, members in communities.items():
    mm = members if isinstance(members, list) else [members]
    if cid in NAMES:
        labels[cid] = NAMES[cid]
    elif len(mm) == 1:
        labels[cid] = short(label_of.get(mm[0], str(mm[0])))
    else:
        labels[cid] = f"Community {cid}"

questions = suggest_questions(G, communities, labels)
report = generate(
    G, communities, cohesion, labels, analysis["gods"], analysis["surprises"],
    detection, tokens, ".", suggested_questions=questions,
)
Path("graphify-out/GRAPH_REPORT.md").write_text(report, encoding="utf-8")
Path("graphify-out/.graphify_labels.json").write_text(
    json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding="utf-8"
)
print("Report regenerated with", len([c for c in communities if len(communities[c]) >= 2]), "named communities")
