from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import time
from typing import Any, Mapping
from urllib.parse import urlsplit

import httpx

from app.agent_engine.policy.scope import NetworkScope, NetworkScopeError, NetworkTarget
from app.agent_engine.tools.types import ToolContext, ToolResult


class HttpRequestExecutor:
    def __init__(
        self,
        *,
        scope: NetworkScope | None = None,
        transport: httpx.BaseTransport | None = None,
        max_body_chars: int = 20_000,
    ) -> None:
        self.scope = scope or NetworkScope()
        self.transport = transport
        self.max_body_chars = max_body_chars

    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        url = str(arguments["url"])
        try:
            target = self.scope.validate(url, context.request.network_policy, dict(context.request.authorization))
        except NetworkScopeError as exc:
            return ToolResult(False, "network target denied", error=str(exc), metadata={"code": "scope_denied"})
        method = str(arguments.get("method", "GET")).upper()
        timeout = min(float(arguments.get("timeout_seconds", 10)), 20.0)
        headers = {str(key): str(value) for key, value in dict(arguments.get("headers", {})).items()}
        body = arguments.get("body")
        if self.transport is None:
            return self._request_pinned(context, target, method, headers, body, timeout)
        client = httpx.Client(
            timeout=httpx.Timeout(timeout),
            transport=self.transport,
            follow_redirects=False,
        )
        unregister = context.abort_token.register(client.close)
        try:
            response = client.request(
                method,
                target.url,
                headers=headers,
                content=body,
            )
        except httpx.TimeoutException:
            return ToolResult(False, "HTTP request timed out", error="timeout")
        except httpx.HTTPError as exc:
            return ToolResult(False, "HTTP request failed", error=type(exc).__name__)
        finally:
            unregister()
            client.close()
        body = response.text[: self.max_body_chars]
        return ToolResult(
            True,
            f"HTTP {response.status_code}",
            output=body,
            metadata={
                "status_code": response.status_code,
                "url": target.url,
                "resolved_addresses": list(target.addresses),
                "connected_address": target.addresses[0],
                "headers": dict(response.headers),
            },
        )

    def _request_pinned(
        self,
        context: ToolContext,
        target: NetworkTarget,
        method: str,
        headers: dict[str, str],
        body: object,
        timeout: float,
    ) -> ToolResult:
        parsed = urlsplit(target.url)
        request_target = parsed.path or "/"
        if parsed.query:
            request_target += "?" + parsed.query
        headers = {key: value for key, value in headers.items() if key.lower() not in {"host", "connection"}}
        default_port = 443 if parsed.scheme == "https" else 80
        display_host = f"[{target.host}]" if ":" in target.host else target.host
        headers["Host"] = display_host if target.port == default_port else f"{display_host}:{target.port}"
        headers["Connection"] = "close"
        payload = None if body is None else str(body).encode("utf-8")
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        active: dict[str, socket.socket | None] = {"socket": None}

        def close_active() -> None:
            sock = active.get("socket")
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass

        unregister = context.abort_token.register(close_active)
        try:
            for address in target.addresses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return ToolResult(False, "HTTP request timed out", error="timeout")
                raw_socket: socket.socket | None = None
                connection: http.client.HTTPConnection | None = None
                try:
                    literal = ipaddress.ip_address(address)
                    family = socket.AF_INET6 if literal.version == 6 else socket.AF_INET
                    raw_socket = socket.socket(family, socket.SOCK_STREAM)
                    active["socket"] = raw_socket
                    raw_socket.settimeout(remaining)
                    destination = (address, target.port, 0, 0) if family == socket.AF_INET6 else (address, target.port)
                    raw_socket.connect(destination)
                    connected: socket.socket = raw_socket
                    if parsed.scheme == "https":
                        connected = ssl.create_default_context().wrap_socket(raw_socket, server_hostname=target.host)
                        active["socket"] = connected
                    connection = http.client.HTTPConnection(target.host, target.port, timeout=remaining)
                    connection.sock = connected
                    connection.request(method, request_target, body=payload, headers=headers)
                    response = connection.getresponse()
                    raw_body = response.read(self.max_body_chars * 4 + 1)
                    charset = response.headers.get_content_charset() or "utf-8"
                    text = raw_body.decode(charset, errors="replace")[: self.max_body_chars]
                    return ToolResult(
                        True,
                        f"HTTP {response.status}",
                        output=text,
                        metadata={
                            "status_code": response.status,
                            "url": target.url,
                            "resolved_addresses": list(target.addresses),
                            "connected_address": address,
                            "headers": dict(response.headers.items()),
                        },
                    )
                except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
                    last_error = exc
                    if context.abort_token.is_aborted:
                        return ToolResult(False, "HTTP request aborted", error="aborted")
                finally:
                    if connection is not None:
                        connection.close()
                    elif raw_socket is not None:
                        raw_socket.close()
                    active["socket"] = None
        finally:
            unregister()
            close_active()
        if isinstance(last_error, (socket.timeout, TimeoutError)):
            return ToolResult(False, "HTTP request timed out", error="timeout")
        return ToolResult(
            False,
            "HTTP request failed",
            error=type(last_error).__name__ if last_error is not None else "connection_failed",
        )
