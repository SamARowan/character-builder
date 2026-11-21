"""Checks fuseweb against a content pack under CPython, and the pack's fitting against the full
install's.

    F:\\REA\\fuse-mcp\\.venv\\Scripts\\python fuseweb_test.py [pack.fpk] [--keep DIR]

Unpacks the pack to a folder (as the browser's worker mounts it), drives the same calls the
page makes, and builds the same character from the original install to compare cloth fits.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def unpack(fpk: Path, dest: Path) -> dict:
    with open(fpk, "rb") as fh:
        head = fh.read(24)
        assert head[:4] == b"FPK1", head[:4]
        at, n = struct.unpack_from("<QQ", head, 8)
        fh.seek(at)
        index = json.loads(fh.read(n))
        for path, off, stored, size, codec in index["files"]:
            fh.seek(off)
            blob = fh.read(stored)
            data = zlib.decompress(blob) if codec == "deflate" else blob
            assert len(data) == size, path
            p = dest / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
    return index["manifest"]


def timed(label, fn, *a, **k):
    t = time.time()
    out = fn(*a, **k)
    print(f"  {label}: {time.time() - t:.2f} s")
    return out


def main() -> None:
    fpk = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else \
        HERE.parent / "dist-content" / "fuse-content.fpk"
    keep = sys.argv[sys.argv.index("--keep") + 1] if "--keep" in sys.argv else None
    root = Path(keep) if keep else Path(tempfile.mkdtemp(prefix="fuseweb_root_"))
    if not (root / "manifest.json").is_file():
        manifest = timed("unpack", unpack, fpk, root)
        (root / "manifest.json").write_text(json.dumps(manifest))
    manifest = json.loads((root / "manifest.json").read_text())

    import fuseweb as fw
    print("init", timed("init", fw.init, str(root), json.dumps(manifest)))
    bodies = fw.body_types()
    print(len(bodies), "body types:", [b["id"] for b in bodies])
    assert all(b["thumbnail"] for b in bodies[:5])
    lib = fw.cloths(made_for="MaleFitA")
    print(len(lib["cloths"]), "MaleFitA cloths;", len(lib["categories"]), "categories")
    pick = [next(c["id"] for c in lib["cloths"] if c["id"].startswith(p)) for p in ("Top_", "Bottom_", "Shoes_", "Hair_")]
    timed("new", fw.new, "MaleFitA", pick, "Test Man")
    s = fw.sliders("bicep")
    print("sliders 'bicep':", [x["id"] for x in s])
    timed("set_blendshapes", fw.set_blendshapes, {s[0]["id"]: 0.7})
    pv = timed("preview (cold)", fw.preview)
    print("  sections", len(pv["sections"]), "warnings", pv["warnings"])
    timed("set_blendshapes", fw.set_blendshapes, {s[0]["id"]: 0.2})
    pv = timed("preview (warm, slider change)", fw.preview)
    sub = fw.substance(pick[0])
    print("top materials:", [(m["slot"], m["filestem"], bool(m["thumbnail"])) for m in sub["materials"]])
    col = next(i for m in sub["materials"] for i in m["inputs"] if i.get("type") == "float3" or "olor" in i["name"])
    slot = next(m for m in sub["materials"] if col in m["inputs"])
    fw.set_substance_inputs(pick[0], {f"{slot['slot']}/{col['name']}": [0.8, 0.1, 0.1]})
    pv = timed("preview (colour change)", fw.preview)
    mats = fw.materials()
    print(len(mats), "materials in the catalog")
    fw.undo()
    print("undo ->", fw.info()["can_redo"])
    text = fw.project_json()
    fw.open_project(text)
    assert fw.info()["cloths"] and json.loads(text)["format"] == "fuse-character-project"
    for fmt in ("glb", "fbx"):
        r = timed(f"export {fmt}", fw.export, fmt)
        print("  ", r["name"], f"{r['size'] / 1e6:.1f} MB", r.get("joints"), r.get("warnings"))
    print("fuse:", Path(fw.fuse_file()).stat().st_size, "bytes")

    # The pack's slimmed bindings against the full install's, on the same character.
    from fuse_mcp.core import Workspace
    from fuse_mcp.character import build_character
    full = Workspace()
    doc = fw._session.doc
    a = build_character(doc, fw._ws.library)
    b = build_character(doc, full.library)
    for oa, ob in zip(a.objects, b.objects):
        e = np.linalg.norm(oa.positions - ob.positions, axis=1) * 10
        print(f"  fit {oa.name[:40]:40s} mean {e.mean():.2f} mm  p99 {np.percentile(e, 99):.2f}  max {e.max():.2f}")
    print("OK")


if __name__ == "__main__":
    main()
