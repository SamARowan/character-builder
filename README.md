# Character Builder (web)

The Fuse character builder (`F:\REA\fuse-mcp`) as a web page that runs entirely on a phone or
laptop, offline: pick a body, shape it, dress it, colour it, and export GLB / FBX / OBJ.

It's fuse-mcp's own Python, unchanged, running in the browser under Pyodide (WebAssembly).
`py/fuseweb.py` adapts it: the pack's file layout, painted textures capped at 1024 px, a paint
cache so slider changes don't repaint, and a few 32-bit numpy fixes.

## The password

The site is public (GitHub Pages), so nothing secret is on it in the clear. The builder's Python
(`py.zip`) and Adobe's content pack are published **only encrypted**: AES-256 (GCM for `py.zip`, CTR for
the pack so any piece of it decrypts on its own), with the key made from the password by PBKDF2-SHA256
(600,000 rounds). Without the password the files are noise.
The page itself (UI, Pyodide, three.js) is open.

- The password is in `secret/password.txt`. It's git-ignored and never published. To change it, edit
  that file and run `node pack/encrypt.mjs all`. Every device then asks again.
- A device asks once, then keeps the derived key in its browser storage (as raw bytes: the streamed pack is
  decrypted by `web/aes.js`, synchronously, which WebCrypto can't do).
  To lock that device again, open **Characters → Content pack → Forget the password here**.
- `web/secure.json` holds the salt, a check value for wrong passwords, and the layout of the
  encrypted files. It holds no keys.

| File on the site | What |
|---|---|
| `web/py.zip.enc` | the builder's Python (fuse-mcp core + `fuseweb.py`) |
| `web/pack/fuse-content.NN.bin` | the content pack, 11 parts of up to 44 MiB (GitHub's limit is 100 MB per file) |

The pack is **streamed**: nothing is downloaded up front. Each file the builder reads is fetched with a range request
the first time (64 KB chunks, neighbours merged, thumbnails fetched in parallel as they scroll into view), decrypted
on the device and kept in the browser's private storage (OPFS), so it works offline from then on. A dressed
character costs about 40 MB the first time. **Characters → Content pack → Clear the downloaded parts** empties that
cache. A plain `.fpk` loaded with **Use a pack file instead** takes over from the stream.

Characters are saved on the device (IndexedDB). For the home PC: the download button in the top bar saves the
character as `.json`, and **Characters → Save all to one file** makes a `.zip` of them all. The desktop builder
opens a `.json` with File → Open (rendering at 2048, full Substance); the page opens both again.

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
python test\serve.py         # http://localhost:8765, with byte ranges (also the plain pack at /local-pack/)
cd test && npm i playwright-core@1.49.1
node smoke.mjs               # the worker alone
node stream.mjs              # unlock, build and dress from the streamed pack (prints what each step fetched); save files
node lock.mjs                # the password, staying unlocked, forgetting it
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
2. Enter the password. The builder starts straight away and fetches what it needs as you go (online the first
   time each piece is used).
   - On iPhone, Safari can clear the storage of sites that aren't used for weeks. Installing the page
     to the Home Screen avoids that. The page also asks the browser to keep its storage.
3. **Export** uses the share sheet on phones: save to Files, or send it anywhere.

## Files

- `pack/make_pack.py` makes the content pack. The format is in its docstring.
- `py/fuseweb.py` is the Python API the page calls. `py/fuseweb_test.py` is its test.
- `web/worker.js` runs Pyodide. It mounts the pack lazily at `/content`; reads go to the stream (`StreamPack`) or a
  local `.fpk` (`LocalPack`). `web/aes.js` is the synchronous AES-CTR they decrypt with.
- `web/app.js`, `index.html` and `style.css` are the page: a three.js viewer and the Body / Clothes / Colours /
  Export / Characters panels.
- `web/sw.js` is the offline cache. `web/vendor/` holds Pyodide 0.29.0 (with numpy, Pillow and protobuf), three.js r170
  and fflate.
