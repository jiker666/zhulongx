from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Callable, Iterable
from urllib.parse import urlparse

from app.agent_engine.state import NetworkPolicy


class NetworkScopeError(ValueError):
    pass


@dataclass(frozen=True)
class NetworkTarget:
    url: str
    host: str
    port: int
    addresses: tuple[str, ...]


Resolver = Callable[[str, int], Iterable[tuple]]


class NetworkScope:
    def __init__(self, resolver: Resolver | None = None) -> None:
        self.resolver = resolver or socket.getaddrinfo

    def validate(self, url: str, policy: NetworkPolicy, authorization: dict[str, object]) -> NetworkTarget:
        if policy.mode != "allowlist":
            raise NetworkScopeError("network policy is deny")
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise NetworkScopeError("only absolute HTTP(S) URLs are allowed")
        if parsed.username or parsed.password:
            raise NetworkScopeError("URL credentials are not allowed")
        host = parsed.hostname.rstrip(".").lower()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if policy.allowed_ports and port not in policy.allowed_ports:
            raise NetworkScopeError("target port is outside the allowlist")

        networks = []
        exact_hosts = set()
        for entry in policy.allowed_hosts:
            try:
                networks.append(ipaddress.ip_network(entry, strict=False))
            except ValueError:
                exact_hosts.add(entry.rstrip(".").lower())
        try:
            literal = ipaddress.ip_address(host)
            addresses = (literal,)
        except ValueError:
            if host not in exact_hosts:
                raise NetworkScopeError("target host is outside the allowlist")
            try:
                answers = self.resolver(host, port)
            except OSError as exc:
                raise NetworkScopeError("DNS resolution failed") from exc
            addresses = tuple(sorted({ipaddress.ip_address(item[4][0]) for item in answers}, key=str))
            if not addresses:
                raise NetworkScopeError("DNS returned no addresses")

        allow_private = bool(authorization.get("allow_private_network", False))
        allow_metadata = bool(authorization.get("allow_metadata_service", False))
        metadata = ipaddress.ip_address("169.254.169.254")
        for address in addresses:
            if address == metadata and not allow_metadata:
                raise NetworkScopeError("metadata service is denied")
            if (address.is_loopback or address.is_private or address.is_link_local or address.is_reserved) and not allow_private:
                raise NetworkScopeError("private, local, or reserved address is denied")
            if host not in exact_hosts and not any(address in network for network in networks):
                raise NetworkScopeError("resolved address is outside the CIDR allowlist")
        return NetworkTarget(url=url, host=host, port=port, addresses=tuple(str(item) for item in addresses))
