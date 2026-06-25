import http.server
import socketserver
import threading
import zipfile
from pathlib import Path

from app.tools.java_code_audit import JavaCodeAuditTool
from app.tools.js_interface_extractor import JSInterfaceExtractorTool
from app.tools.log_analyzer import LogAnalyzerTool


JAVA_CONTROLLER = """
package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/api/order")
public class OrderController {
    @GetMapping("/{orderId}")
    public String detail(@PathVariable Long orderId) {
        return "ok";
    }
}
"""


def test_java_code_audit_reads_zip_without_extractall(tmp_path: Path):
    archive = tmp_path / "java.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../evil.java", JAVA_CONTROLLER)
        zf.writestr("src/main/java/OrderController.java", JAVA_CONTROLLER)

    result = JavaCodeAuditTool().run({"file_path": str(archive)})

    assert result["success"] is True
    assert result["details"]["high_risk_count"] >= 1
    assert not (tmp_path.parent / "evil.java").exists()


def test_log_analyzer_supports_common_json_and_spring_logs(tmp_path: Path):
    log_file = tmp_path / "access.log"
    log_file.write_text(
        "\n".join([
            '1.1.1.1 - - [01/Jan/2026:10:00:00 +0800] "GET /admin HTTP/1.1" 403 12 "-" "sqlmap"',
            '{"ip":"2.2.2.2","path":"/api/users","status":500,"user_agent":"curl/8.0","timestamp":"2026-01-01T10:01:00"}',
            "2026-01-01 10:02:00 WARN app GET /actuator 404",
        ]),
        encoding="utf-8",
    )

    result = LogAnalyzerTool().run({"file_path": str(log_file)})

    assert result["success"] is True
    assert result["details"]["parsed_lines"] == 3
    assert result["details"]["status_5xx_count"] == 1
    assert result["details"]["suspicious_count"] >= 2
    assert result["details"]["suspicious_user_agent_count"] >= 2


def test_js_extractor_file_and_url(tmp_path: Path):
    js_file = tmp_path / "app.js"
    js_file.write_text("fetch('/api/users'); axios.get('/v1/orders');", encoding="utf-8")
    file_result = JSInterfaceExtractorTool().run({"file_path": str(js_file)})
    assert "/api/users" in file_result["details"]["api_paths"]
    assert "/v1/orders" in file_result["details"]["api_paths"]

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/app.js":
                body = b"axios.post('/graphql'); fetch('/api/session')"
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            body = b'<html><script src="/app.js"></script></html>'
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            return

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url_result = JSInterfaceExtractorTool().run({"target": f"http://127.0.0.1:{server.server_address[1]}"})
        server.shutdown()

    assert url_result["success"] is True
    assert "/graphql" in url_result["details"]["api_paths"]
    assert "/api/session" in url_result["details"]["api_paths"]
