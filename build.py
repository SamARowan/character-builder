"""Bundle the builder's Python into the page: web/py.zip (fuse-mcp's core plus fuseweb.py), and
stamp the service worker's cache name so phones pick up a new version.

    python build.py [--core F:\\REA\\fuse-mcp\\src\\fuse_mcp]

Only the modules the browser runs go in: no MCP server, GUI, Substance renderer or capture code.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORE = ["__init__", "assembly", "cage", "character", "collide", "core", "export", "fbx", "gltf", "install",
        "library", "mesh", "project", "rig", "scene", "schema", "session", "substances", "textures"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", default=r"F:\REA\fuse-mcp\src\fuse_mcp")
    args = ap.parse_args()
    core = Path(args.core)
    out = HERE / "web" / "py.zip"
    files = [(core / f"{m}.py", f"fuse_mcp/{m}.py") for m in CORE]
    files += [(f, f"fuse_mcp/proto/descriptors/{f.name}") for f in sorted((core / "proto" / "descriptors").glob("*.pb"))]
    files.append((HERE / "py" / "fuseweb.py", "fuseweb.py"))
    # The body substance's hair and makeup masks (pack/bake_body_masks.py): Adobe's, so only in py.zip.enc.
    files += [(f, f"body_masks/{f.name}") for f in sorted((HERE / "py" / "body_masks").glob("*.png"))]
    digest = hashlib.sha1()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, name in files:
            data = src.read_bytes()
            digest.update(name.encode() + data)
            zi = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
    # With a password set, the site carries the Python only encrypted (py.zip itself is git-ignored).
    if (HERE / "secret" / "password.txt").exists():
        subprocess.run(["node", str(HERE / "pack" / "encrypt.mjs"), "py"], check=True)
    # The service worker's cache name follows everything it serves (the pack parts aren't cached).
    web = HERE / "web"
    for f in sorted(web.rglob("*")):
        rel = f.relative_to(web).as_posix()
        if f.is_file() and f.name not in ("sw.js", "py.zip") and not rel.startswith("pack/"):
            digest.update(rel.encode() + f.read_bytes())
    version = digest.hexdigest()[:10]
    sw = web / "sw.js"
    sw.write_text(re.sub(r'const VERSION = "[^"]*";', f'const VERSION = "{version}";', sw.read_text()))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB, {len(files)} files); version {version}")


if __name__ == "__main__":
    main()
