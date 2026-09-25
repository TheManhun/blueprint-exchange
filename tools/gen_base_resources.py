import zipfile, os, json
G = r"F:\SteamLibrary\steamapps\common\Transport Fever 2\res"
out = {"construction": [], "street": [], "track": [], "bridge": [], "tunnel": [], "model": []}
z = zipfile.ZipFile(os.path.join(G, "construction", "construction.zip"))
out["construction"] = sorted(n for n in z.namelist() if n.endswith(".con") and not n.startswith("building/"))
def walk(d):
    r = []
    for root, _, files in os.walk(d):
        for f in files:
            r.append(os.path.relpath(os.path.join(root, f), d).replace(chr(92), "/"))
    return sorted(r)
for k in ("street", "track", "bridge", "tunnel"):
    out[k] = [p for p in walk(os.path.join(G, "config", k)) if p.endswith(".lua")]
zm = zipfile.ZipFile(os.path.join(G, "models", "model.zip"))
out["model"] = sorted(n[len("model/"):] for n in zm.namelist() if n.endswith(".mdl") and (n.startswith("model/railroad/") or n.startswith("model/street/")))
json.dump(out, open("base_resources.json", "w"))
print({k: len(v) for k, v in out.items()})
rows = []
for t, l in out.items():
    for p in l:
        assert "'" not in p
        rows.append("('%s','%s')" % (t, p))
open("base_seed.sql", "w").write("insert into public.bp_base_resources (resource_type, resource_path) values\n" + ",\n".join(rows) + "\non conflict do nothing;\n")
print(sum(len(r) for r in rows))
