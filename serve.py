#!/usr/bin/env python3
"""Dev server with HTTP caching disabled.

Plain `python3 -m http.server` sends no Cache-Control header, so browsers
heuristically cache the ES modules — after every edit the game kept running
stale code until a hard refresh (sometimes two). This handler forces
revalidation on every request, so a normal reload always gets fresh modules.
"""
import http.server
import os


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    # PORT env override lets a second checkout (e.g. a git worktree) serve
    # alongside the default instance; everything else keeps using 8642.
    port = int(os.environ.get('PORT', 8642))
    # THREADED, and it must stay that way. http.server.test() builds a
    # single-threaded HTTPServer that handles exactly one connection at a time,
    # which was survivable while the page was the only client — but a Web
    # Worker (src/minimap-worker.js) is a SECOND independent requester, and
    # with HTTP keep-alive one client holding its connection open starves
    # every other request. In practice the server simply stopped answering
    # mid-session and the page hung on an import that never resolved.
    # ThreadingHTTPServer is the same handler with a thread per connection.
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler) as httpd:
        print(f'Serving on http://127.0.0.1:{port}/  (Ctrl-C to stop)')
        httpd.serve_forever()
