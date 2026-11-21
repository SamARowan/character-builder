"""A local server for testing: the page at /, and (for the tests only) the content pack at
/local-pack/fuse-content.fpk. Localhost counts as a secure context, so OPFS and the service worker work.

    python serve.py [port]
"""

import http.server
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB, PACK = ROOT / "web", ROOT / "dist-content"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript",
                      ".js": "text/javascript", ".wasm": "application/wasm",
                      ".webmanifest": "application/manifest+json"}

    def translate_path(self, path):
        if path.startswith("/local-pack/"):
            return str(PACK / path[len("/local-pack/"):].split("?")[0])
        return super().translate_path(path)

    def send_head(self):
        # Byte ranges, as GitHub Pages serves them (the page streams the pack this way).
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not rng.startswith("bytes=") or not Path(path).is_file():
            return super().send_head()
        size = Path(path).stat().st_size
        a, _, b = rng[6:].partition("-")
        start = int(a) if a else size - int(b)
        end = min(int(b), size - 1) if a and b else size - 1
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._range_left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        self._range_left = None
        while left > 0:
            buf = source.read(min(left, 1 << 20))
            if not buf:
                break
            outputfile.write(buf)
            left -= len(buf)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(WEB))).serve_forever()
