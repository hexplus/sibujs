import json
from pathlib import Path
from graphify.extract import collect_files, extract

detect = json.loads(Path("graphify-out/.graphify_detect.json").read_text(encoding="utf-8"))
code_files = []
for f in detect.get("files", {}).get("code", []):
    pf = Path(f)
    code_files.extend(collect_files(pf) if pf.is_dir() else [pf])

if code_files:
    result = extract(code_files, cache_root=Path("."))
    Path("graphify-out/.graphify_ast.json").write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f'AST: {len(result["nodes"])} nodes, {len(result["edges"])} edges')
else:
    Path("graphify-out/.graphify_ast.json").write_text(
        json.dumps({"nodes": [], "edges": [], "input_tokens": 0, "output_tokens": 0}),
        encoding="utf-8",
    )
    print("No code files")

# code-only corpus -> empty semantic file so Part C merge has its input
Path("graphify-out/.graphify_semantic.json").write_text(
    json.dumps({"nodes": [], "edges": [], "hyperedges": [], "input_tokens": 0, "output_tokens": 0}),
    encoding="utf-8",
)
