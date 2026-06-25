from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        routes = {
            "/": (200, "text/html", b'<html><title>CyberPilot Mock</title><script src="/app.js"></script></html>'),
            "/robots.txt": (200, "text/plain", b"User-agent: *\nDisallow: /admin\n"),
            "/.well-known/security.txt": (200, "text/plain", b"Contact: security@example.test\n"),
            "/app.js": (200, "application/javascript", b"fetch('/api/health'); axios.get('/v1/users');"),
        }
        status, content_type, body = routes.get(self.path, (404, "text/plain", b"not found"))
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 18080), Handler)
    print("Mock server: http://127.0.0.1:18080")
    server.serve_forever()
