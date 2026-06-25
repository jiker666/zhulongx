"""
LogAnalyzerTool - analyze access/error logs for anomalies.
"""
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List

from app.tools.base import BaseTool

SUSPICIOUS_PATHS = [
    "/admin", "/login", "/wp-admin", "/phpmyadmin", "/.env",
    "/actuator", "/console", "/manager", "/.git", "/config",
    "/shell", "/cmd", "/exec", "/passwd",
]

# Common log format: IP - - [date] "METHOD path HTTP/x.x" status size
LOG_PATTERN = re.compile(
    r'(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)\s+\S+"\s+(\d{3})\s+(\d+|-)'
)
COMBINED_PATTERN = re.compile(
    r'(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)\s+\S+"\s+(\d{3})\s+(\d+|-)\s+"[^"]*"\s+"([^"]*)"'
)
SPRING_PATTERN = re.compile(
    r'(?P<time>\d{4}-\d{2}-\d{2}[ T]\d{2}:[\d:.]+).*?(?P<method>GET|POST|PUT|DELETE|PATCH)\s+(?P<path>/\S+).*?(?P<status>[1-5]\d{2})',
    re.IGNORECASE,
)
SUSPICIOUS_UA_KEYWORDS = ["sqlmap", "acunetix", "nikto", "nessus", "masscan", "nmap", "dirbuster", "gobuster", "python-requests", "curl"]


def _time_bucket(raw: str) -> str:
    if not raw:
        return "unknown"
    if len(raw) >= 13 and raw[2] == "/" and ":" in raw:
        return raw[:13]
    if len(raw) >= 13:
        return raw[:13].replace("T", " ")
    return raw[:13] or "unknown"


def _parse_json_line(line: str) -> Dict[str, Any]:
    try:
        obj = json.loads(line)
    except Exception:
        return {}
    ip = obj.get("ip") or obj.get("client_ip") or obj.get("remote_addr") or obj.get("remoteAddress")
    path = obj.get("path") or obj.get("uri") or obj.get("request_uri") or obj.get("url")
    status = obj.get("status") or obj.get("status_code") or obj.get("code")
    method = obj.get("method") or obj.get("http_method") or ""
    ua = obj.get("user_agent") or obj.get("ua") or obj.get("User-Agent") or ""
    ts = obj.get("time") or obj.get("timestamp") or obj.get("date") or ""
    if not (ip and path and status):
        return {}
    return {"ip": str(ip), "path": str(path), "status": str(status), "method": str(method), "ua": str(ua), "time": str(ts), "format": "json_line"}


def _parse_log_line(line: str) -> Dict[str, Any]:
    m = COMBINED_PATTERN.match(line)
    if m:
        ip, date, method, path, status, size, ua = m.groups()
        return {"ip": ip, "path": path, "status": status, "method": method, "ua": ua, "time": date, "format": "nginx_combined"}
    m = LOG_PATTERN.match(line)
    if m:
        ip, date, method, path, status, _size = m.groups()
        return {"ip": ip, "path": path, "status": status, "method": method, "ua": "", "time": date, "format": "nginx_common"}
    parsed_json = _parse_json_line(line)
    if parsed_json:
        return parsed_json
    m = SPRING_PATTERN.search(line)
    if m:
        return {
            "ip": "unknown",
            "path": m.group("path"),
            "status": m.group("status"),
            "method": m.group("method").upper(),
            "ua": "",
            "time": m.group("time"),
            "format": "spring_boot",
        }
    return {}


class LogAnalyzerTool(BaseTool):
    name = "LogAnalyzerTool"
    description = "分析 access.log/error.log，统计 Top IP、Top Path、识别 4xx/5xx 和可疑路径"
    category = "log"
    input_schema = {
        "type": "object",
        "properties": {"file_path": {"type": "string", "description": "日志文件路径"}, "content": {"type": "string"}},
    }
    output_schema = {
        "type": "object",
        "properties": {
            "top_ips": {"type": "array", "items": {"type": "object"}},
            "top_paths": {"type": "array", "items": {"type": "object"}},
            "time_windows": {"type": "array", "items": {"type": "object"}},
            "suspicious_user_agents": {"type": "array", "items": {"type": "object"}},
        },
    }
    permissions = ["local_file_read"]
    risk_level = "low"
    timeout_seconds = 20
    tags = ["log", "incident_response", "forensics"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        file_path: str = context.get("file_path", "")
        content: str = context.get("content", "")

        if file_path and not content:
            try:
                content = Path(file_path).read_text(encoding="utf-8", errors="ignore")
            except Exception as e:
                return {
                    "success": False,
                    "summary": f"读取日志文件失败: {e}",
                    "details": {},
                    "evidence": [],
                }

        if not content:
            # Demo mode
            content = """192.168.1.100 - - [01/Jan/2024:10:00:00 +0800] "GET / HTTP/1.1" 200 1234
192.168.1.200 - - [01/Jan/2024:10:01:00 +0800] "GET /admin HTTP/1.1" 403 512
10.0.0.1 - - [01/Jan/2024:10:02:00 +0800] "GET /.env HTTP/1.1" 404 0
192.168.1.100 - - [01/Jan/2024:10:03:00 +0800] "POST /login HTTP/1.1" 401 128
10.0.0.2 - - [01/Jan/2024:10:04:00 +0800] "GET /wp-admin HTTP/1.1" 404 0
"""

        lines = content.splitlines()
        ip_counter: Counter = Counter()
        path_counter: Counter = Counter()
        ua_counter: Counter = Counter()
        format_counter: Counter = Counter()
        time_counter: Counter = Counter()
        status_4xx: List[str] = []
        status_5xx: List[str] = []
        suspicious: List[str] = []
        suspicious_uas: List[str] = []

        total_lines = 0
        parsed_lines = 0

        for line in lines:
            total_lines += 1
            parsed = _parse_log_line(line)
            if not parsed:
                continue
            parsed_lines += 1
            ip = parsed["ip"]
            path = parsed["path"]
            status = parsed["status"]
            ua = parsed.get("ua", "")
            ip_counter[ip] += 1
            path_counter[path] += 1
            format_counter[parsed.get("format", "unknown")] += 1
            time_counter[_time_bucket(parsed.get("time", ""))] += 1
            if ua:
                ua_counter[ua] += 1

            if status.startswith("4"):
                status_4xx.append(f"[{status}] {ip} -> {path}")
            elif status.startswith("5"):
                status_5xx.append(f"[{status}] {ip} -> {path}")

            path_lower = path.lower()
            for sp in SUSPICIOUS_PATHS:
                if path_lower.startswith(sp.lower()):
                    suspicious.append(f"{ip} 访问可疑路径 {path} [{status}]")
                    break
            ua_lower = ua.lower()
            if any(kw in ua_lower for kw in SUSPICIOUS_UA_KEYWORDS):
                suspicious_uas.append(f"{ip} 使用可疑 UA {ua[:80]} 访问 {path} [{status}]")

        top_ips = ip_counter.most_common(10)
        top_paths = path_counter.most_common(10)
        top_uas = ua_counter.most_common(10)
        time_windows = time_counter.most_common(20)

        evidence = []
        for entry in suspicious[:10]:
            evidence.append(entry)
        for entry in suspicious_uas[:10]:
            evidence.append(entry)
        for entry in status_4xx[:5]:
            evidence.append(entry)
        for entry in status_5xx[:5]:
            evidence.append(entry)

        return {
            "success": True,
            "summary": f"解析 {parsed_lines}/{total_lines} 条日志，发现 {len(status_4xx)} 个 4xx，{len(status_5xx)} 个 5xx，{len(suspicious)} 个可疑路径访问，{len(suspicious_uas)} 个可疑 UA",
            "details": {
                "total_lines": total_lines,
                "parsed_lines": parsed_lines,
                "formats": [{"format": fmt, "count": c} for fmt, c in format_counter.most_common()],
                "top_ips": [{"ip": ip, "count": c} for ip, c in top_ips],
                "top_paths": [{"path": p, "count": c} for p, c in top_paths],
                "top_user_agents": [{"user_agent": ua, "count": c} for ua, c in top_uas],
                "time_windows": [{"window": w, "count": c} for w, c in time_windows],
                "status_4xx_count": len(status_4xx),
                "status_5xx_count": len(status_5xx),
                "suspicious_count": len(suspicious),
                "suspicious_user_agent_count": len(suspicious_uas),
                "status_4xx_samples": status_4xx[:10],
                "status_5xx_samples": status_5xx[:10],
                "suspicious_samples": suspicious[:10],
                "suspicious_user_agent_samples": suspicious_uas[:10],
            },
            "evidence": evidence,
        }
