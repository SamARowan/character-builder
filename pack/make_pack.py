"""Make the web builder's content pack from the Fuse installs on this PC.

    F:\\REA\\fuse-mcp\\.venv\\Scripts\\python make_pack.py [out.fpk] [--max-texture 1024]

The pack holds what the builder reads when it paints textures (it never runs
the Substance renderer), slimmed for a phone:

- metadata, meshes, part templates and clothing cages: as they are, deflated;
- cloth bindings (Data.dat, 3.2 GB in Fuse CC): each cloth vertex keeps its 32
  largest cage weights and the rest are lumped onto the nearest of 256 cage
  vertices spread over the body (farthest point sampling). Same MVCM format,
  about a twentieth of the size; fitting moves by well under a millimetre on
  average (see README);
- the maps the painter reads, at most --max-texture a side: masks as PNG
  (nearest, so slot colours stay exact), hair strands as PNG (alpha), AO and
  normal maps as JPEG. The builder opens images by content, so names keep .png;
- each .sbsar replaced by its XML description (the inputs the colour panel
  shows); the Substance images are left out.

Format (little-endian): b"FPK1", u32 version 1, u64 index offset, u64 index
length, the blobs, then the index: UTF-8 JSON {"manifest": {...}, "files":
[[path, offset, stored size, size, codec], ...]}, codec "store" or "deflate"
(zlib). Paths are "<install>/Data/...". Never publish a pack: it is Adobe's
content.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

KEEP, COARSE = 32, 256


# --- what to pack ----------------------------------------------------------------------

def plan(data: Path) -> list[tuple[Path, str]]:
    """(file, how) for one install's Data folder."""
    out = []
    domains = data / "Domains"
    for f in sorted(domains.rglob("*")):
        if not f.is_file():
            continue
        n, low = f.name, f.name.lower()
        if low.endswith(".txt"):
            out.append((f, "deflate"))
        elif low.endswith(".mbp"):
            out.append((f, "deflate"))
        elif n == "Data.dat":
            out.append((f, "binding"))
        elif n == "Thumbnail.png":
            out.append((f, "store"))
        elif low.endswith("_mask.png"):
            out.append((f, "mask"))
        elif low.endswith("_detaildiff.png"):
            out.append((f, "rgba"))
        elif low.endswith(("_ao.png", "_nm.png", "_stdnm.png", "_agednm.png")):
            out.append((f, "jpeg"))
    subs = data / "Substances"
    if subs.is_dir():
        out += [(f, "sbsar") for f in sorted(subs.glob("*.sbsar"))]
        out += [(f, "store") for f in sorted((subs / "Thumbnails").glob("*.png"))]
    return out


# --- converters (run in worker processes) -----------------------------------------------

def _fit(im: Image.Image, size: int, resample) -> Image.Image:
    if max(im.size) > size:
        s = size / max(im.size)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), resample)
    return im


def _png(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=False, compress_level=9)
    return buf.getvalue()


_CAGE_CACHE: dict = {}


def _coarse(cage_path: Path):
    """For a clothing cage: (rest positions, for each cage vertex the nearest of COARSE
    farthest-point samples, as a cage vertex id)."""
    if cage_path not in _CAGE_CACHE:
        from fuse_mcp.cage import read_cage
        p = read_cage(cage_path)
        idx = [0]
        d = np.linalg.norm(p - p[0], axis=1)
        for _ in range(COARSE - 1):
            i = int(d.argmax())
            idx.append(i)
            d = np.minimum(d, np.linalg.norm(p - p[i], axis=1))
        c = np.array(idx)
        near = np.empty(len(p), np.int64)
        for s in range(0, len(p), 4096):
            q = p[s:s + 4096]
            near[s:s + 4096] = c[np.argmin(((q[:, None, :] - p[c][None]) ** 2).sum(-1), 1)]
        _CAGE_CACHE[cage_path] = near
    return _CAGE_CACHE[cage_path]


def slim_binding(data_dat: Path, cage_path: Path) -> bytes:
    from fuse_mcp.cage import read_binding
    b = read_binding.__wrapped__(data_dat)   # uncached: a big dense binding is ~150 MB in memory
    near = _coarse(cage_path)
    cnt = np.bincount(b.rows, minlength=b.nverts)
    order = np.lexsort((-np.abs(b.weights), b.rows))
    r, c, w = b.rows[order], b.cols[order], b.weights[order]
    start = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    rank = np.arange(len(r)) - np.repeat(start, cnt)
    cols = np.where(rank < KEEP, c, near[c])
    key = r * b.ncage + cols
    u, inv = np.unique(key, return_inverse=True)
    ww = np.bincount(inv, w)
    rows, cols = u // b.ncage, u % b.ncage
    counts = np.bincount(rows, minlength=b.nverts)
    out = io.BytesIO()
    out.write(b"MVCM" + struct.pack("<IQQH", 0, 1, b.nverts, b.ncage))
    ent = np.empty(len(u), np.dtype([("i", "<u2"), ("w", "<f4")]))
    ent["i"], ent["w"] = cols, ww
    pos = 0
    for n in counts:
        out.write(struct.pack("<H", int(n)))
        out.write(ent[pos:pos + n].tobytes())
        pos += n
    return out.getvalue()


def sbsar_xml(sbsar: Path) -> bytes:
    import py7zr
    from py7zr.io import BytesIOFactory
    factory = BytesIOFactory(16 * 1024 * 1024)
    with py7zr.SevenZipFile(sbsar) as z:
        names = [n for n in z.getnames() if n.endswith(".xml")]
        z.extract(targets=names, factory=factory)
    buf = factory.get(names[0])
    buf.seek(0)
    return buf.read()


def convert(job) -> tuple[str, bytes, int, str]:
    """(pack path, stored bytes, size, codec)."""
    f, how, rel, max_tex, cage = job
    if how == "store":
        raw = f.read_bytes()
        return rel, raw, len(raw), "store"
    if how == "deflate":
        raw = f.read_bytes()
        return rel, zlib.compress(raw, 6), len(raw), "deflate"
    if how == "binding":
        raw = slim_binding(f, Path(cage)) if cage else f.read_bytes()
        return rel, zlib.compress(raw, 6), len(raw), "deflate"
    if how == "sbsar":
        raw = sbsar_xml(f)
        return rel, zlib.compress(raw, 9), len(raw), "deflate"
    im = Image.open(f)
    if how == "mask":
        raw = _png(_fit(im.convert("RGB"), max_tex, Image.NEAREST))
    elif how == "rgba":
        raw = _png(_fit(im.convert("RGBA"), max_tex, Image.LANCZOS))
    else:  # jpeg: AO (grey) and normal maps
        grey = f.name.lower().endswith("_ao.png")
        im = _fit(im.convert("L" if grey else "RGB"), max_tex, Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88 if grey else 92)
        raw = buf.getvalue()
    return rel, raw, len(raw), "store"


# --- main ------------------------------------------------------------------------------

def _install_name(root: Path) -> str:
    return "".join(ch for ch in root.name if ch.isalnum()) or "Install"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", default=str(Path(__file__).resolve().parent.parent / "dist-content" / "fuse-content.fpk"))
    ap.add_argument("--max-texture", type=int, default=1024)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    ap.add_argument("--only", default="", help="debug: only files whose path contains this")
    args = ap.parse_args()

    from fuse_mcp.core import workspace
    ws = workspace()
    installs = [ws.install, *ws.extras]
    names = {inst.root: _install_name(inst.root) for inst in installs}
    lib = ws.library

    # Each cloth's binding is slimmed over the cage it was authored on.
    cage_of: dict[Path, str] = {}
    for cid, c in lib.cloths.items():
        if c["kind"] != "cloth" or not c["installed"]:
            continue
        try:
            dat, cage = lib.cloth_binding(cid)
        except (FileNotFoundError, KeyError):
            continue
        cage_of[dat] = str(cage)

    jobs = []
    for inst in installs:
        for f, how in plan(inst.data):
            rel = f"{names[inst.root]}/Data/{f.relative_to(inst.data).as_posix()}"
            if args.only and args.only not in rel:
                continue
            jobs.append((f, how, rel, args.max_texture, cage_of.get(f)))
    # Big jobs first so the pool finishes together.
    jobs.sort(key=lambda j: -j[0].stat().st_size)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    index, total_in = [], sum(j[0].stat().st_size for j in jobs)
    with open(out, "wb") as fh, ProcessPoolExecutor(args.workers) as pool:
        fh.write(b"FPK1" + struct.pack("<IQQ", 1, 0, 0))
        for k, (rel, blob, size, codec) in enumerate(pool.map(convert, jobs, chunksize=1), 1):
            index.append([rel, fh.tell(), len(blob), size, codec])
            fh.write(blob)
            if k % 50 == 0 or k == len(jobs):
                print(f"{k}/{len(jobs)} files, {fh.tell() / 1e6:.0f} MB, {time.time() - t0:.0f} s", flush=True)
        manifest = {
            "format": "fuse-web-pack", "version": 1, "created": time.strftime("%Y-%m-%d %H:%M"),
            "library": names[ws.install.root], "extras": [names[e.root] for e in ws.extras],
            "max_texture": args.max_texture, "binding": {"keep": KEEP, "coarse": COARSE},
        }
        body = json.dumps({"manifest": manifest, "files": sorted(index)}, separators=(",", ":")).encode()
        at = fh.tell()
        fh.write(body)
        fh.seek(8)
        fh.write(struct.pack("<QQ", at, len(body)))
    size = out.stat().st_size
    print(f"wrote {out}: {len(index)} files, {size / 1e6:.0f} MB from {total_in / 1e6:.0f} MB in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
