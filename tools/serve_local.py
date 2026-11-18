#!/usr/bin/env python3
"""Serve exactly three public release assets on this device for up to one hour."""
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[1]
names = ('hyrz-localhost.plugin', 'hyrz-sign.js', 'hyrz-sniff.js')
files = {'/' + name: (root / name).read_bytes() for name in names}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def serve(self, body):
        path = self.path.partition('?')[0]
        data = files.get(path)
        if data is None or self.headers.get('Host') not in ('127.0.0.1:18916', 'localhost:18916'):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/javascript; charset=utf-8' if path.endswith('.js') else 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self):
        self.serve(True)

    def do_HEAD(self):
        self.serve(False)

if __name__ == '__main__':
    with HTTPServer(('127.0.0.1', 18916), Handler) as server:
        server.timeout = 2
        end = time.monotonic() + 3600
        while time.monotonic() < end:
            server.handle_request()
