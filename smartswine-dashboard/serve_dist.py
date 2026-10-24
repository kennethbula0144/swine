from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


DIST_DIR = Path(__file__).resolve().parent / "dist"


class SPARequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST_DIR), **kwargs)

    def translate_path(self, path):
        requested_path = Path(super().translate_path(path))
        if requested_path.exists():
            return str(requested_path)
        return str(DIST_DIR / "index.html")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 5173), SPARequestHandler)
    print("Smart Swine dashboard: http://127.0.0.1:5173/")
    server.serve_forever()