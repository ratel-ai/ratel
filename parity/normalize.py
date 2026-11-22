import json, re, sys
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TS = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z")
FIXED = {"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"}
TIMING = {"durationMs", "ms", "duration_ms"}
def norm(path):
    ids = {}
    def sub_id(m):
        v = m.group(0)
        if v in FIXED: return v
        return ids.setdefault(v, f"<id{len(ids)+1}>")
    def walk(x):
        if isinstance(x, dict): return {k: ("<ms>" if k in TIMING and isinstance(v, (int, float)) else walk(v)) for k, v in x.items()}
        if isinstance(x, list): return [walk(v) for v in x]
        if isinstance(x, str): return TS.sub("<ts>", UUID.sub(sub_id, x))
        return x
    return walk(json.load(open(path)))
a, b = norm(sys.argv[1]), norm(sys.argv[2])
for name, v in (("ratel-cloud", a), ("ratel", b)):
    open(f"{name}.normalized.json", "w").write(json.dumps(v, indent=2, sort_keys=True) + "\n")
print("calls:", len(a), len(b), "tools:", sorted({c["tool"] for c in a}))
print("IDENTICAL" if a == b else "DIFFERENT")
