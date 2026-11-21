"""The web builder's Python side: fuse-mcp's own Session, run in the browser by Pyodide.

The page's worker mounts the content pack at a folder (read-only, files fetched on
demand) and calls the functions here. Nothing in fuse-mcp is changed; this module only
adapts it to the browser:

- py7zr (a native wheel) isn't available, and the pack holds each .sbsar's XML
  description in place of the archive, so substance catalogs read that directly;
- painted maps are capped at the pack's texture size (the desktop app paints at each
  material's own size, up to 2048);
- painting is cached by its inputs, so a slider change doesn't repaint every map;
- PNGs written for the preview are compressed lightly (they never leave the page).

Every function takes and returns JSON-friendly values; files (the preview's mesh and
maps, exports) are written to the in-memory filesystem and returned by path, for the
worker to read with FS.readFile.

The same module runs under CPython for tests (`python fuseweb_test.py`).
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import types
import zipfile
from pathlib import Path

VERSION = "1"

# --- adapting fuse-mcp ------------------------------------------------------------------

_state = {"fast_png": False, "max_texture": 1024}
PAINT_CACHE = 40


def _patch_py7zr() -> None:
    """substances.py imports py7zr at module level; give it a stand-in when it's missing."""
    try:
        import py7zr  # noqa: F401
        return
    except ImportError:
        pass
    fake = types.ModuleType("py7zr")
    fake_io = types.ModuleType("py7zr.io")

    class SevenZipFile:  # never used: _description is replaced below
        def __init__(self, *a, **k):
            raise RuntimeError("py7zr is not available in the browser")

    fake.SevenZipFile = SevenZipFile
    fake_io.BytesIOFactory = object
    fake.io = fake_io
    sys.modules["py7zr"] = fake
    sys.modules["py7zr.io"] = fake_io


def _patch_numpy_32bit() -> None:
    """Pyodide is 32-bit: numpy's repeat and bincount refuse int64 counts there ("Cannot cast
    array data from int64 to int32"), which fuse-mcp passes. Cast them to the native int."""
    import numpy as np
    if np.dtype(np.intp).itemsize == 8 or getattr(np.repeat, "_fuseweb", False):
        return
    own_repeat, own_bincount = np.repeat, np.bincount

    def native(a):
        a = np.asarray(a)
        return a.astype(np.intp) if a.dtype.kind in "iu" and a.dtype.itemsize > np.dtype(np.intp).itemsize else a

    def repeat(a, repeats, axis=None):
        return own_repeat(a, native(repeats), axis)

    def bincount(x, weights=None, minlength=0):
        return own_bincount(native(x), weights, int(minlength))

    repeat._fuseweb = bincount._fuseweb = True
    np.repeat, np.bincount = repeat, bincount


def _patch(max_texture: int) -> None:
    _patch_py7zr()
    _patch_numpy_32bit()
    import xml.etree.ElementTree as ET

    from PIL import Image

    from fuse_mcp import character, substances, textures

    _state["max_texture"] = max_texture
    # Scalp hair, brows, beards and makeup: masks baked from the body substance (pack/bake_body_masks.py).
    masks = Path(__file__).resolve().parent / "body_masks"
    if masks.is_dir():
        textures.BODY_MASKS = masks

    # The pack's .sbsar files are their XML descriptions.
    def _description(sbsar: Path):
        data = Path(sbsar).read_bytes()
        if data[:6] == b"7z\xbc\xaf\x27\x1c":
            raise ValueError(f"{sbsar}: a real .sbsar; the web pack stores its XML description")
        return ET.fromstring(data)

    substances._description = _description

    own_size = character._texture_size
    character._texture_size = lambda s: min(own_size(s) or max_texture, max_texture)

    # PNG writes: light compression for the preview's maps.
    if not getattr(Image.Image.save, "_fuseweb", False):
        save = Image.Image.save

        def fast_save(self, fp, format=None, **params):
            name = str(getattr(fp, "name", fp) if not isinstance(fp, (str, os.PathLike)) else fp)
            if _state["fast_png"] and "compress_level" not in params and (
                    (format or "").upper() == "PNG" or name.lower().endswith(".png")):
                params["compress_level"] = 1
            return save(self, fp, format, **params)

        fast_save._fuseweb = True
        Image.Image.save = fast_save

    # Painting cached by everything that goes into it.
    paint_cache = Path(tempfile.gettempdir()) / "fuseweb_paint"

    def _prune():
        """Keep the newest PAINT_CACHE sets of maps (the cache lives in the page's memory)."""
        sets = sorted((p for p in paint_cache.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime)
        for p in sets[:-PAINT_CACHE]:
            shutil.rmtree(p, ignore_errors=True)

    def _remember(kind, key_parts, out_dir: Path, name: str, paint):
        h = hashlib.sha1(repr((kind, key_parts)).encode()).hexdigest()[:16]
        folder = paint_cache / h
        meta = folder / "maps.json"
        if meta.is_file():
            os.utime(meta)
            os.utime(folder)
            saved = json.loads(meta.read_text())
            mat = textures.MaterialMaps(name, notes=saved["notes"])
            out_dir.mkdir(parents=True, exist_ok=True)
            for attr, file in saved["maps"].items():
                new = file.replace(saved["name"], name, 1)
                shutil.copyfile(folder / file, out_dir / new)
                setattr(mat, attr, new)
            mat.cache_key = h
            return mat
        fast, _state["fast_png"] = _state["fast_png"], True   # cached maps are re-encoded on export
        try:
            mat = paint()
        finally:
            _state["fast_png"] = fast
        folder.mkdir(parents=True, exist_ok=True)
        maps = {}
        for attr in ("base_color", "normal", "opacity", "roughness", "metallic", "ambient_occlusion"):
            file = getattr(mat, attr)
            if file:
                shutil.copyfile(out_dir / file, folder / file)
                maps[attr] = file
        meta.write_text(json.dumps({"name": name, "maps": maps, "notes": mat.notes}))
        mat.cache_key = h
        _prune()
        return mat

    own_cloth, own_body = textures.cloth_maps, textures.body_maps

    def cloth_maps(folder, prefix, substance, catalog, out_dir, name, size=None):
        return _remember("cloth", (str(folder), prefix, substance.SerializeToString(), size), Path(out_dir), name,
                         lambda: own_cloth(folder, prefix, substance, catalog, out_dir, name, size))

    def body_maps(folder, body, substance, meshes, out_dir, name, size=None):
        # The meshes only decide which UV islands are eyes and lashes: fixed per body type and part set.
        parts = tuple(sorted(m.name for m in meshes))
        return _remember("body", (str(folder), body, substance.SerializeToString(), size, parts), Path(out_dir),
                         name, lambda: own_body(folder, body, substance, meshes, out_dir, name, size))

    character.cloth_maps, character.body_maps = cloth_maps, body_maps


# --- the workspace from a pack ------------------------------------------------------------

_session = None
_ws = None
_root: Path | None = None
_manifest: dict = {}


def init(root: str, manifest_json: str) -> dict:
    """Open the content mounted at `root` (the pack's paths below it)."""
    global _session, _ws, _root, _manifest
    _manifest = json.loads(manifest_json)
    _patch(int(_manifest.get("max_texture", 1024)))
    os.environ["LOCALAPPDATA"] = str(Path(tempfile.gettempdir()) / "no-annex")
    from fuse_mcp.core import Workspace, use_workspace
    from fuse_mcp.install import FuseInstall
    from fuse_mcp.session import Session

    _root = Path(root)

    def install(name):
        r = _root / name
        return FuseInstall(r, r / "Fuse.exe")

    ws = Workspace.__new__(Workspace)
    ws.install = install(_manifest["library"])
    ws.runtime = ws.install
    ws.extras = [install(n) for n in _manifest.get("extras", [])]
    _ws = use_workspace(ws)
    _session = Session(ws)
    return status()


def status() -> dict:
    lib = _ws.library
    return {"version": VERSION, "manifest": _manifest, "body_types": len(lib.body_types),
            "cloths": sum(1 for c in lib.cloths.values() if c["installed"]),
            "open": _session.project is not None if _session else False}


def _thumb(path: Path | None) -> str | None:
    return str(path) if path is not None and path.is_file() else None


def body_types() -> list[dict]:
    lib = _ws.library
    out = []
    for b in lib.body_types.values():
        parts = [p for p in b["parts"] if p in lib.parts]
        if not parts or not all(lib.parts[p]["installed"] for p in parts):
            continue   # Fuse Basic lists body types whose parts it doesn't ship
        try:
            thumb = _thumb(lib.thumbnail(b["id"]))
        except (KeyError, FileNotFoundError):
            thumb = None
        out.append({"id": b["id"], "display_name": b["display_name"], "thumbnail": thumb})
    return sorted(out, key=lambda b: b["display_name"].lower())


def cloths(query: str = "", category: str = "", made_for: str = "") -> dict:
    lib = _ws.library
    found = lib.search_cloths(query, category, True, made_for)
    for c in found:
        try:
            c["thumbnail"] = _thumb(lib.thumbnail(c["id"]))
        except (KeyError, FileNotFoundError):
            c["thumbnail"] = None
    cats = sorted({c["category"] for c in lib.cloths.values() if c["installed"] and c["category"]})
    return {"cloths": sorted(found, key=lambda c: (c["category"], c["display_name"].lower())), "categories": cats}


def materials() -> list[dict]:
    """Every material a cloth slot can take, with its swatch."""
    cat = _ws.catalog
    return [{"filestem": n, "thumbnail": _thumb(cat.thumbnail(n))} for n in cat.names()]


# --- editing (fuse-mcp's Session) --------------------------------------------------------------

def new(body_type: str, cloth_ids: list | None = None, name: str | None = None) -> dict:
    info = _session.new(body_type, list(cloth_ids or []), name or None)
    _session.project.export.update({"render": 0, "rig": "ue"})
    return info


def open_project(text: str) -> dict:
    from fuse_mcp.project import Project
    proj = Project.from_dict(json.loads(text))
    proj.export["render"] = 0
    return _session._reset(proj)


def open_fuse(path: str, name: str = "") -> dict:
    """Open a Fuse .fuse file the page wrote to `path`."""
    from fuse_mcp.assembly import FuseDocument
    from fuse_mcp.project import Project
    proj = Project(FuseDocument.from_bytes(Path(path).read_bytes()), name or Path(path).stem or "Character")
    proj.export.update({"render": 0, "rig": "ue"})
    return _session._reset(proj)


def project_json() -> str:
    """The character as a fuse-mcp project, the file the desktop builder opens (File > Open).
    The web paints its textures (render 0); the file asks for full Substance renders, so the PC
    builds the character at full quality. Opening it here sets render 0 again."""
    from fuse_mcp.project import FULL_DETAIL
    _session.dirty = False
    d = _session.project.to_dict()
    d.setdefault("export", {})["render"] = FULL_DETAIL
    return json.dumps(d, indent=1)


def fuse_file() -> str:
    """The assembly as a .fuse file; returns its path."""
    out = Path(tempfile.gettempdir()) / "fuseweb_out" / f"{_safe(_session.project.name)}.fuse"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(_session.doc.to_bytes())
    return str(out)


def info() -> dict:
    return _session.info()


def sliders(query: str = "") -> list[dict]:
    return _session.sliders(query)


def set_blendshapes(weights: dict) -> dict:
    _session.set_blendshapes({k: float(v) for k, v in weights.items()})
    return info()


def reset_blendshapes(part: str = "") -> dict:
    _session.reset_blendshapes(part)
    return info()


def add_cloth(cloth_id: str) -> dict:
    _session.add_cloth(cloth_id)
    return info()


def remove_cloth(cloth_id: str) -> dict:
    _session.remove_cloth(cloth_id)
    return info()


def substance(target: str = "body") -> dict:
    view = _session.substance(target)
    for m in view["materials"]:
        m["thumbnail"] = _thumb(_ws.catalog.thumbnail(m["filestem"]))
    return view


def set_substance_inputs(target: str, values: dict) -> dict:
    return _session.set_substance_inputs(target, values)


def set_material(target: str, slot: int, filestem: str) -> dict:
    return _session.set_material(target, int(slot), filestem)


def undo() -> dict:
    _session.undo()
    return info()


def redo() -> dict:
    _session.redo()
    return info()


def set_name(name: str) -> dict:
    _session.set_name(name)
    return info()


# --- preview and export ------------------------------------------------------------------------

def preview() -> dict:
    """The character as draw sections (Y-up cm) and painted base colours. Returns
    {bin, sections: [{object, material, offset, vertices, indices, texture, key}], bounds,
    warnings}; offsets are into the file `bin` (float32 position/normal/uv, then uint32
    indices, per section)."""
    from fuse_mcp.scene import prepare_scene
    import numpy as np
    from PIL import Image
    _state["fast_png"] = True
    try:
        char = _session.build(textures=True)
    finally:
        _state["fast_png"] = False
    scene = prepare_scene(char)
    folder = Path(tempfile.gettempdir()) / "fuseweb_preview"
    folder.mkdir(parents=True, exist_ok=True)
    keys = {m.name: getattr(m, "cache_key", None) or f"{m.name}-{id(m)}" for m in char.materials}
    # One PNG per painted set of maps, kept while it's in use: the page caches textures by key.
    for old in folder.glob("*.png"):
        if old.stem.removesuffix("_n") not in keys.values():
            old.unlink()
    textures, normals = {}, {}
    for name, image in scene.images.items():
        p = folder / f"{keys.get(name, name)}.png"
        if not p.exists():
            Image.fromarray(image[::-1]).save(p, compress_level=1)
        textures[name] = str(p)
    # Normal maps (Age blends the body's two): the viewer lights with them.
    for m in char.materials:
        if m.normal and char.texture_dir:
            p = folder / f"{keys[m.name]}_n.png"
            if not p.exists():
                shutil.copyfile(Path(char.texture_dir) / m.normal, p)
            normals[m.name] = str(p)
    sections, chunks, offset = [], [], 0
    for o in scene.objects:
        by_material: dict[str, list] = {}
        for first, count, material, _ in o.ranges:
            by_material.setdefault(material, []).append(o.indices[first:first + count])
        for material, parts in by_material.items():
            used, tris = np.unique(np.concatenate(parts), return_inverse=True)
            data = [np.ascontiguousarray(o.vertices[used], np.float32).tobytes(), tris.astype(np.uint32).tobytes()]
            sections.append({"object": o.name, "material": material, "offset": offset, "vertices": len(used),
                             "indices": len(tris), "texture": textures.get(material),
                             "normal": normals.get(material),
                             "key": keys.get(material), "hair": material.startswith(("Hair_", "Beard_",
                                                                                      "Eyebrow", "Eyelash"))})
            chunks += data
            offset += sum(len(d) for d in data)
    file = folder / "mesh.bin"
    file.write_bytes(b"".join(chunks))
    return {"bin": str(file), "sections": sections, "bounds": scene.bounds.tolist(), "warnings": char.warnings,
            "opacity": {m.name: bool(m.opacity) for m in char.materials}}


def _safe(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_ " else "_" for ch in name).strip() or "Character"


def export(fmt: str = "glb", rig: str = "ue", include_cloths: bool = True, scale: float = 1.0) -> dict:
    """Export the character with painted textures. GLB is one file; FBX and OBJ come zipped with
    their textures. Returns {path, name, ...export result}."""
    fmt = fmt.lower()
    name = _safe(_session.project.name)
    out_dir = Path(tempfile.mkdtemp(prefix="fuseweb_export_"))
    output = out_dir / f"{name}.{fmt}"
    rig = None if rig in ("", "none", None) or fmt == "obj" else rig
    result = _session.export(output, rig=rig, textures=True, render=0, include_cloths=bool(include_cloths),
                             scale=float(scale))
    if fmt == "glb":
        final = output
    else:
        final = out_dir.parent / f"{name}_{fmt}.zip"
        with zipfile.ZipFile(final, "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(out_dir.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(out_dir).as_posix())
        shutil.rmtree(out_dir, ignore_errors=True)
    result = {k: v for k, v in result.items() if k not in ("path", "materials", "textures")}
    return {"path": str(final), "name": final.name, "size": final.stat().st_size, **result}


# --- the worker's entry point ------------------------------------------------------------------

_API = {f.__name__: f for f in (init, status, body_types, cloths, materials, new, open_project, open_fuse,
                                 project_json, fuse_file, info, sliders, set_blendshapes, reset_blendshapes,
                                 add_cloth, remove_cloth, substance, set_substance_inputs, set_material, undo,
                                 redo, set_name, preview, export)}


def call(name: str, args_json: str) -> str:
    """Run one API function: JSON args in, JSON {ok, result} or {ok: false, error} out."""
    import traceback
    try:
        fn = _API[name]
        args = json.loads(args_json or "[]")
        result = fn(**args) if isinstance(args, dict) else fn(*args)
        return json.dumps({"ok": True, "result": result})
    except Exception as e:  # noqa: BLE001 - reported to the page
        return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()})
