"""
Authorization scope guard for all outbound HTTP(S) access.

Default mode remains conservative: public HTTP(S) targets only, no private,
loopback, link-local, file/gopher/ftp, or other non-HTTP schemes.
Competition mode allows private/internal targets only when they match explicit
CIDR/domain/port scope settings and the matching private class is enabled.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import ipaddress
import socket
import threading
from typing import Iterable, List, Optional, Set, Tuple
from urllib.parse import urlparse

from app.config import settings


DENIED_SCHEMES = {"file", "gopher", "ftp", "dict", "ldap", "sftp"}
HTTP_SCHEMES = {"http", "https"}


@dataclass
class ScopeDecision:
    allowed: bool
    normalized_url: str
    reason: str
    host: str = ""
    port: int = 0
    resolved_ips: List[str] = None
    matched_scope: str = ""
    competition_mode: bool = False

    def to_dict(self) -> dict:
        data = asdict(self)
        data["resolved_ips"] = self.resolved_ips or []
        return data


def normalize_http_url(raw_url: str) -> str:
    url = (raw_url or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    return url


def _split(raw: str) -> List[str]:
    items: List[str] = []
    for chunk in (raw or "").replace("\n", ",").replace(";", ",").split(","):
        value = chunk.strip()
        if value:
            items.append(value)
    return items


def _default_port(scheme: str) -> int:
    return 443 if scheme == "https" else 80


def _is_localhost_name(host: str) -> bool:
    h = (host or "").strip().lower().rstrip(".")
    return h in {"localhost", "localhost.localdomain"} or h.endswith(".localhost")


def _ip_kind(ip: str) -> str:
    parsed = ipaddress.ip_address(ip)
    if parsed.is_loopback:
        return "localhost"
    if parsed.is_link_local:
        return "link_local"
    if parsed.is_private:
        return "private"
    if parsed.is_multicast or parsed.is_reserved or parsed.is_unspecified:
        return "reserved"
    return "public"


def _is_sensitive_ip(ip: str) -> bool:
    return _ip_kind(ip) != "public"


def _parse_networks(raw: str) -> List[ipaddress._BaseNetwork]:
    networks: List[ipaddress._BaseNetwork] = []
    for item in _split(raw):
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError:
            continue
    return networks


def _parse_ports(raw: str) -> Set[int]:
    ports: Set[int] = set()
    for item in _split(raw):
        if "-" in item:
            start, end = item.split("-", 1)
            try:
                a, b = int(start), int(end)
            except ValueError:
                continue
            if 0 < a <= b <= 65535 and b - a <= 1024:
                ports.update(range(a, b + 1))
            continue
        try:
            port = int(item)
        except ValueError:
            continue
        if 0 < port <= 65535:
            ports.add(port)
    return ports


def _match_domain(host: str, patterns: Iterable[str]) -> Optional[str]:
    host_l = (host or "").lower().rstrip(".")
    for pattern in patterns:
        p = pattern.lower().strip().rstrip(".")
        if not p:
            continue
        if p.startswith("*."):
            suffix = p[1:]
            if host_l.endswith(suffix):
                return pattern
        if host_l == p or host_l.endswith("." + p):
            return pattern
    return None


def _resolve_host(host: str) -> List[str]:
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return []
    ips = []
    for info in infos:
        ip = info[4][0]
        if ip not in ips:
            ips.append(ip)
    return ips


class RequestBudget:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._task_counts: dict[int, int] = {}
        self._target_counts: dict[str, int] = {}

    def check_and_record(self, task_id: Optional[int], target_key: str) -> Tuple[bool, str]:
        max_task = max(int(settings.MAX_REQUESTS_PER_TASK or 0), 0)
        max_target = max(int(settings.MAX_REQUESTS_PER_TARGET or 0), 0)
        with self._lock:
            if task_id is not None and max_task:
                current = self._task_counts.get(task_id, 0)
                if current >= max_task:
                    return False, f"任务请求次数超过上限: {max_task}"
            if target_key and max_target:
                current = self._target_counts.get(target_key, 0)
                if current >= max_target:
                    return False, f"目标请求次数超过上限: {max_target}"
            if task_id is not None:
                self._task_counts[task_id] = self._task_counts.get(task_id, 0) + 1
            if target_key:
                self._target_counts[target_key] = self._target_counts.get(target_key, 0) + 1
        return True, ""

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "tasks": dict(self._task_counts),
                "targets": dict(self._target_counts),
            }


class ScopeGuard:
    def __init__(self) -> None:
        self.budget = RequestBudget()

    def _scope_config(self) -> dict:
        return {
            "competition_mode": bool(settings.COMPETITION_MODE),
            "cidrs": _split(settings.SCOPE_CIDRS),
            "domains": _split(settings.SCOPE_DOMAINS),
            "ports": sorted(_parse_ports(settings.SCOPE_PORTS)),
            "allow_localhost": bool(settings.SCOPE_ALLOW_LOCALHOST),
            "allow_private_ips": bool(settings.SCOPE_ALLOW_PRIVATE_IPS),
            "max_requests_per_task": settings.MAX_REQUESTS_PER_TASK,
            "max_requests_per_target": settings.MAX_REQUESTS_PER_TARGET,
            "default_http_timeout": settings.DEFAULT_HTTP_TIMEOUT,
        }

    def summary(self) -> dict:
        cfg = self._scope_config()
        cfg["configured"] = bool(cfg["cidrs"] or cfg["domains"])
        cfg["budget_counts"] = self.budget.snapshot()
        return cfg

    def validate_url(self, raw_url: str) -> ScopeDecision:
        url = normalize_http_url(raw_url)
        parsed = urlparse(url)
        scheme = (parsed.scheme or "").lower()
        host = parsed.hostname or ""
        port = parsed.port or _default_port(scheme)

        if scheme in DENIED_SCHEMES or scheme not in HTTP_SCHEMES:
            return ScopeDecision(False, url, f"禁止访问非 HTTP(S) 协议: {scheme or '(空)'}", host, port, [], competition_mode=settings.COMPETITION_MODE)
        if not host:
            return ScopeDecision(False, url, "目标 URL 缺少主机名", host, port, [], competition_mode=settings.COMPETITION_MODE)

        resolved_ips = _resolve_host(host)
        if not resolved_ips and not _is_localhost_name(host):
            return ScopeDecision(False, url, f"无法解析目标主机: {host}", host, port, [], competition_mode=settings.COMPETITION_MODE)

        localhost_name = _is_localhost_name(host)
        sensitive_ips = []
        for ip in resolved_ips:
            try:
                if _is_sensitive_ip(ip):
                    sensitive_ips.append(ip)
            except ValueError:
                continue

        if settings.DEV_ALLOW_PRIVATE_TARGETS and not settings.COMPETITION_MODE:
            return ScopeDecision(True, url, "legacy DEV_ALLOW_PRIVATE_TARGETS enabled", host, port, resolved_ips, "legacy_dev", settings.COMPETITION_MODE)

        if not settings.COMPETITION_MODE:
            if localhost_name:
                return ScopeDecision(False, url, f"默认禁止访问本机地址: {host}", host, port, resolved_ips, competition_mode=False)
            if sensitive_ips:
                return ScopeDecision(False, url, f"默认禁止访问内网/本机地址: {', '.join(sensitive_ips)}", host, port, resolved_ips, competition_mode=False)
            return ScopeDecision(True, url, "public HTTP(S) target allowed in safe mode", host, port, resolved_ips, "public", False)

        networks = _parse_networks(settings.SCOPE_CIDRS)
        domains = _split(settings.SCOPE_DOMAINS)
        ports = _parse_ports(settings.SCOPE_PORTS)

        if ports and port not in ports:
            return ScopeDecision(False, url, f"端口 {port} 不在 SCOPE_PORTS 授权范围内", host, port, resolved_ips, competition_mode=True)

        matched: Optional[str] = None
        domain_match = _match_domain(host, domains)
        if domain_match:
            matched = f"domain:{domain_match}"

        for ip in resolved_ips:
            try:
                parsed_ip = ipaddress.ip_address(ip)
            except ValueError:
                continue
            for network in networks:
                if parsed_ip in network:
                    matched = f"cidr:{network}"
                    break
            if matched and matched.startswith("cidr:"):
                break

        if not matched:
            return ScopeDecision(False, url, "目标未命中 SCOPE_CIDRS 或 SCOPE_DOMAINS 授权范围", host, port, resolved_ips, competition_mode=True)

        if localhost_name or any(_ip_kind(ip) == "localhost" for ip in resolved_ips if ip):
            if not settings.SCOPE_ALLOW_LOCALHOST:
                return ScopeDecision(False, url, "目标为 localhost/127.0.0.0/8，但 SCOPE_ALLOW_LOCALHOST=false", host, port, resolved_ips, matched, True)

        private_hits = [ip for ip in resolved_ips if ip and _ip_kind(ip) in {"private", "link_local", "reserved"}]
        if private_hits and not settings.SCOPE_ALLOW_PRIVATE_IPS:
            return ScopeDecision(False, url, "目标解析到 private/link-local/reserved IP，但 SCOPE_ALLOW_PRIVATE_IPS=false", host, port, resolved_ips, matched, True)

        return ScopeDecision(True, url, "目标命中 competition scope", host, port, resolved_ips, matched, True)

    def validate_and_record(self, raw_url: str, task_id: Optional[int] = None) -> ScopeDecision:
        decision = self.validate_url(raw_url)
        if not decision.allowed:
            return decision
        target_key = f"{decision.host}:{decision.port}"
        ok, reason = self.budget.check_and_record(task_id, target_key)
        if not ok:
            return ScopeDecision(False, decision.normalized_url, reason, decision.host, decision.port, decision.resolved_ips or [], decision.matched_scope, decision.competition_mode)
        return decision


scope_guard = ScopeGuard()
