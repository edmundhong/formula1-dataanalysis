from http.server import BaseHTTPRequestHandler
import json
from pipeline.worker import authorized, run_job


class handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.reply(405, {"error": "method_not_allowed"})

    def do_POST(self):
        if not authorized(self.headers):
            return self.reply(401, {"error": "unauthorized"})
        # Dispatch has no session, URL, or executable supplied by callers.
        try:
            self.reply(200, run_job())
        except Exception:
            self.reply(503, {"error": "worker_unavailable"})
