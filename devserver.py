"""Static dev server that refuses to let the browser cache anything.

`python -m http.server` sends Last-Modified but no Cache-Control. With no
explicit directive, browsers fall back to *heuristic* caching — roughly 10% of
the file's age — so a file that was already a few hours old when the page loaded
can be served from cache for many minutes after you edit it. The result is
editing app.js, reloading, and seeing no change.

`no-store` removes the guesswork. Development only: in production you want the
opposite.

    python devserver.py [port]
"""

import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5177


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


# Threading is not optional here. A plain single-threaded TCPServer blocks on the
# first idle socket a browser preconnects, and the whole server wedges — which is
# exactly why the stdlib's own `python -m http.server` uses this class.
class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Browsers abort in-flight image requests constantly (every time the smoke
        # overlay swaps frames). That isn't worth a traceback.
        if not isinstance(
            sys.exc_info()[1],
            (ConnectionAbortedError, ConnectionResetError, BrokenPipeError),
        ):
            super().handle_error(request, client_address)


if __name__ == "__main__":
    with Server(("", PORT), NoCacheHandler) as httpd:
        print(f"serving http://localhost:{PORT} with caching disabled")
        httpd.serve_forever()
