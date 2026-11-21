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

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(WEB))).serve_forever()
