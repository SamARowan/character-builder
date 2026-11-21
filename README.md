# Character Builder (web)

The Fuse character builder (`F:\REA\fuse-mcp`) as a web page that runs entirely on a phone or
laptop, offline: pick a body, shape it, dress it, colour it, and export GLB / FBX / OBJ.

It's fuse-mcp's own Python, unchanged, running in the browser under Pyodide (WebAssembly).
`py/fuseweb.py` adapts it: the pack's file layout, painted textures capped at 1024 px, a paint
cache so slider changes don't repaint, and a few 32-bit numpy fixes.

## The password

The site is public (GitHub Pages), so nothing secret is on it in the clear. The builder's Python
(`py.zip`) and Adobe's content pack are published **only encrypted**: AES-256-GCM, with the key made
from the password by PBKDF2-SHA256 (600,000 rounds). Without the password the files are noise.
The page itself (UI, Pyodide, three.js) is open.

- The password is in `secret/password.txt`. It's git-ignored and never published. To change it, edit
  that file and run `node pack/encrypt.mjs all`. Every device then asks again.
- A device asks once, then keeps the derived key in its browser as a non-extractable key.
  To lock that device again, open **Characters → Content pack → Forget the password here**.
- `web/secure.json` holds the salt, a check value for wrong passwords, and the layout of the
  encrypted files. It holds no keys.

| File on the site | What |
|---|---|
| `web/py.zip.enc` | the builder's Python (fuse-mcp core + `fuseweb.py`) |
| `web/pack/fuse-content.NN.bin` | the content pack, 11 parts of up to 46 MB (GitHub's limit is 100 MB per file) |

The pack downloads once per device (**Download the pack** on first start), is decrypted on the device, and stays in
the browser's private storage (OPFS). Characters are saved on the device too (IndexedDB), and can be exported as
`.json` or `.fuse`. A plain `.fpk` file can still be loaded with **Choose a pack file**.

## Making the pack

```
F:\REA\fuse-mcp\.venv\Scripts\python pack\make_pack.py
```

It reads the Fuse CC install and Fuse Basic extras, and takes about 1.5 minutes. The pack is 489 MB, down from 4.8 GB:
- **Cloth bindings** (3.2 GB): each cloth vertex keeps its 32 strongest cage weights, and the rest
  are lumped onto 256 cage points.
  - Fitting moves by 0.1–1 mm on average against the full install, and a few mm at most.
  - Worst seen: an Ops-Core helmet on a heavily reshaped body, 55 of its 2006 vertices more than 5 mm off, max 41 mm after the collision pass.
- **Maps**: at most 1024 px. Masks and hair are PNG; AO and normal maps are JPEG.
- **`.sbsar`**: each is replaced by its XML description. The Substance renderer isn't used, so textures
  are painted the way the desktop builder's "painted" mode does it.

## Building and testing the page

```
python build.py              # web/py.zip from fuse-mcp's core + fuseweb.py, encrypted to py.zip.enc; stamps sw.js
node pack\encrypt.mjs pack   # after a new pack: encrypt it into web\pack\
python test\serve.py         # http://localhost:8765 (also serves the plain pack at /local-pack/ for tests)
cd test && npm i playwright-core@1.49.1
node smoke.mjs               # the worker alone
node lock.mjs                # the password, downloading the pack from the site, staying unlocked
node ui.mjs both             # the page through its own controls, phone and laptop sizes; shots in test\shots
F:\REA\fuse-mcp\.venv\Scripts\python py\fuseweb_test.py   # the Python layer under CPython vs the full install
```

Run `build.py` after any change to `fuse-mcp`'s core or `py/fuseweb.py`.

Times in Chrome on this PC:

| Step | Time |
|---|---|
| Start Python | 5 s |
| First build | 3–6 s |
| Rebuild after a slider change | 1.6 s |
| GLB export | 8 s |

Expect a phone to take about 2–4 times as long.

## Hosting

The page needs **https**: the private storage and the offline worker don't work over plain http,
except on localhost. Any static host works. Everything under `web/` is served as it is.

On GitHub, `.github/workflows/pages.yml` publishes `web/` on every push to `main` (Settings → Pages →
Source: GitHub Actions). Every new pack adds about 490 MB to the repo's history, and GitHub wants
repos under a few GB and Pages sites under 1 GB, so push a new pack rarely.

## Using it on a phone

1. Open the page and **Add to Home Screen**. It then works offline as an app.
2. Enter the password, then **Download the pack** (489 MB, so use Wi-Fi).
   - On iPhone, Safari can clear the storage of sites that aren't used for weeks. Installing the page
     to the Home Screen avoids that. The page also asks the browser to keep its storage.
3. **Export** uses the share sheet on phones: save to Files, or send it anywhere.

## Files

- `pack/make_pack.py` makes the content pack. The format is in its docstring.
- `py/fuseweb.py` is the Python API the page calls. `py/fuseweb_test.py` is its test.
- `web/worker.js` runs Pyodide. It mounts the pack lazily at `/content`, so each read goes straight to OPFS.
- `web/app.js`, `index.html` and `style.css` are the page: a three.js viewer and the Body / Clothes / Colours /
  Export / Characters panels.
- `web/sw.js` is the offline cache. `web/vendor/` holds Pyodide 0.29.0 (with numpy, Pillow and protobuf), three.js r170
  and fflate.
