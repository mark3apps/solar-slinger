#!/usr/bin/env python3
"""Dev server with HTTP caching disabled.

Plain `python3 -m http.server` sends no Cache-Control header, so browsers
heuristically cache the ES modules — after every edit the game kept running
stale code until a hard refresh (sometimes two). This handler forces
revalidation on every request, so a normal reload always gets fresh modules.
"""
import http.server


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(HandlerClass=NoCacheHandler, port=8642, bind='127.0.0.1')
