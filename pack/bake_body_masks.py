"""Bake the body Substance's painted-on layers to masks for the web painter.

The web builder paints bodies without the Substance renderer (see fuse-mcp textures.body_maps), so it
has no scalp hair, brows, beards, moustaches, lashes or makeup. Those come from bitmaps inside
Mixamo_Body_Substance, laid out on the shared body UV atlas, so they're the same for every body.
Each option is rendered twice, base colour only, with its colour black and then white;
white - black is the layer's coverage (alpha).

    F:\\REA\\fuse-mcp\\.venv\\Scripts\\python pack\\bake_body_masks.py [--size 9] [--workers 10]

Writes py/body_masks/<layer>_<option>.png (8-bit grey), where layer is hair, eyebrows, beards,
mustaches, eyelashes, lipstick, blush, eyeshadow, mascara or nails (option 0 for makeup).
They are Adobe's, so they ship only inside the encrypted py.zip.
"""
from __future__ import annotations

import argparse
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "py" / "body_masks"

# layer -> (style input, option count or None for makeup, colour input, opacity input)
STYLES = {
    "hair": ("Hair", 36, "Hair_Color", None),
    "eyebrows": ("Eyebrows", 61, "Eyebrow_Color", None),
    "beards": ("Beards", 20, "Beards_Color", None),
    "mustaches": ("Mustaches", 20, "Mustache_Color", None),
    "eyelashes": ("Eyelashes", 3, "Eyelash_Color", None),
    "lipstick": (None, None, "Lipstick_Color", "Lipstick_Opacity"),
    "blush": (None, None, "Blush_Color", "Blush_Opacity"),
    "eyeshadow": (None, None, "Eyeshadow_Color", "Eyeshadow_Opacity"),
    "mascara": (None, None, "Mascara_Color", "Mascara_Opacity"),
    "nails": (None, None, "Nails_Color", "Nails_Opacity"),
}
# Everything else off, so each render holds one layer.
OFF = {"Hair": 0, "Eyebrows": 0, "Beards": 0, "Mustaches": 0, "Eyelashes": 0}

_SUB = None


def _substance():
    global _SUB
    if _SUB is None:
        from fuse_mcp.core import workspace
        from fuse_mcp.substance.sbsar import Substance
        _SUB = Substance(workspace().install.root / "Data/Substances/Mixamo_Body_Substance.sbsar")
    return _SUB


def bake(job):
    layer, option, log2 = job
    style, _, colour, opacity = STYLES[layer]
    s = _substance()
    vals = dict(OFF, **{"$outputsize": (log2, log2)})
    if style:
        vals[style] = option
    else:
        vals[opacity] = 1.0
    shots = []
    for c in (0.0, 1.0):
        vals[colour] = (c, c, c, 1.0)
        shots.append(s.render(vals, {}, outputs=["BaseColor"])["BaseColor"][..., :3])
    a = np.clip((shots[1] - shots[0]).mean(-1), 0, 1)
    return layer, option, (a * 255 + 0.5).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=9, help="log2 of the mask size")
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--only", default="", help="layer[:option], e.g. hair:7")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = []
    for layer, (style, count, _, _) in STYLES.items():
        for o in (range(1, count) if style else [0]):
            jobs.append((layer, o, args.size))
    if args.only:
        l, _, o = args.only.partition(":")
        jobs = [j for j in jobs if j[0] == l and (not o or j[1] == int(o))]
    t = time.time()
    empty = []
    with ProcessPoolExecutor(args.workers) as ex:
        for i, f in enumerate(as_completed([ex.submit(bake, j) for j in jobs])):
            layer, o, a = f.result()
            if a.max() < 8:
                empty.append(f"{layer}_{o}")
            Image.fromarray(a, "L").save(OUT / f"{layer}_{o}.png", optimize=True)
            print(f"{i + 1}/{len(jobs)} {layer}_{o}  max {a.max()}  {time.time() - t:.0f} s", flush=True)
    print("empty:", empty)


if __name__ == "__main__":
    main()
