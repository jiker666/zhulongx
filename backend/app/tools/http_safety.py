from typing import Tuple

from app.core.scope_guard import normalize_http_url, scope_guard


def validate_http_target(raw_url: str) -> Tuple[bool, str, str]:
    """
    Return (allowed, normalized_url, reason).
    Kept for tool compatibility; ScopeGuard owns the policy.
    """
    decision = scope_guard.validate_url(raw_url)
    return decision.allowed, decision.normalized_url, decision.reason
