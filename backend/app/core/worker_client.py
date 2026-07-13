"""Typed async client for the isolated Linux Worker."""
from __future__ import annotations
import asyncio
import time
from typing import Any, Dict, Optional
import httpx
from pydantic import BaseModel, Field
from app.config import settings

class WorkerError(RuntimeError):
    def __init__(self, error_type: str, message: str, retryable: bool = False):
        super().__init__(message); self.error_type = error_type; self.retryable = retryable

class WorkerCapability(BaseModel):
    worker_id: str = "worker-base"; online: bool = False; platform: str = ""; architecture: str = ""
    supports_command: bool = False; supports_python: bool = False; supports_pty: bool = False; supports_cancel: bool = False; supports_process_group: bool = False; supports_gdb: bool = False
    max_sessions: int = 0; active_sessions: int = 0; version: str = ""; boot_id: str = ""; last_checked_at: float = Field(default_factory=time.time)

class WorkerClient:
    def __init__(self, base_url: Optional[str] = None):
        self.base_url = (base_url or settings.WORKER_BASE_URL).rstrip("/")
        self._failures = 0; self._opened_at = 0.0; self._lock = asyncio.Lock(); self._client: Optional[httpx.AsyncClient] = None
    async def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            # Worker traffic is local/container-internal. Do not route it via
            # host proxy variables, which can turn localhost calls into 400s.
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(settings.WORKER_READ_TIMEOUT, connect=settings.WORKER_CONNECT_TIMEOUT), trust_env=False)
        return self._client
    async def close(self) -> None:
        if self._client: await self._client.aclose(); self._client = None
    def _circuit_open(self) -> bool:
        return self._failures >= settings.WORKER_CIRCUIT_BREAKER_THRESHOLD and (time.time() - self._opened_at) < settings.WORKER_CIRCUIT_BREAKER_RESET_SECONDS
    async def request(self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None, json_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self._circuit_open(): raise WorkerError("TOOL_NOT_AVAILABLE", "worker circuit breaker open", True)
        last: Optional[Exception] = None
        for attempt in range(settings.WORKER_MAX_RETRIES + 1):
            try:
                response = await (await self._http()).request(method, self.base_url + path, params=params, json=json_body)
                if response.status_code >= 500: raise WorkerError("WORKER_UNAVAILABLE", f"worker HTTP {response.status_code}", True)
                if response.status_code >= 400: raise WorkerError("WORKER_PROTOCOL_ERROR", f"worker HTTP {response.status_code}")
                data = response.json()
                if not isinstance(data, dict): raise WorkerError("WORKER_PROTOCOL_ERROR", "worker response is not an object")
                self._failures = 0; return data
            except WorkerError as exc:
                last = exc
                if not exc.retryable or attempt >= settings.WORKER_MAX_RETRIES: break
            except (httpx.HTTPError, ValueError) as exc:
                last = exc
                if attempt >= settings.WORKER_MAX_RETRIES: break
                await asyncio.sleep(.05 * (attempt + 1))
        self._failures += 1; self._opened_at = time.time() if self._failures >= settings.WORKER_CIRCUIT_BREAKER_THRESHOLD else self._opened_at
        if isinstance(last, WorkerError): raise last
        raise WorkerError("TOOL_NOT_AVAILABLE", f"worker unavailable: {type(last).__name__}", True)
    async def health(self) -> Dict[str, Any]: return await self.request("GET", "/health")
    async def capabilities(self) -> WorkerCapability:
        data = await self.request("GET", "/capabilities"); return WorkerCapability.model_validate(data)
    async def create_pty_session(self, task_id: str, challenge_id: str, workspace: str, command: str = "/bin/sh", timeout: int = 60, competition_id: str = "") -> Dict[str, Any]: return await self.request("POST", "/sessions/pty", json_body={"task_id": task_id, "challenge_id": challenge_id, "competition_id": competition_id, "workspace": workspace, "command": command, "timeout": timeout})
    async def write_pty_session(self, task_id: str, session_id: str, data: str) -> Dict[str, Any]: return await self.request("POST", f"/sessions/{session_id}/write", json_body={"task_id": task_id, "data": data})
    async def read_pty_session(self, task_id: str, session_id: str, limit: int = 8192) -> Dict[str, Any]: return await self.request("GET", f"/sessions/{session_id}/read", params={"task_id": task_id, "limit": limit})
    async def expect_pty_session(self, task_id: str, session_id: str, pattern: str, *, regex: bool = False, timeout: float = 5, from_cursor: int = 0, max_bytes: int = 20000) -> Dict[str, Any]: return await self.request("POST", f"/sessions/{session_id}/expect", json_body={"task_id": task_id, "pattern": pattern, "regex": regex, "timeout": timeout, "from_cursor": from_cursor, "max_bytes": max_bytes})
    async def close_pty_session(self, task_id: str, session_id: str) -> Dict[str, Any]: return await self.request("DELETE", f"/sessions/{session_id}", params={"task_id": task_id})
    async def list_task_sessions(self, task_id: str) -> Dict[str, Any]: return await self.request("GET", f"/tasks/{task_id}/sessions")
    async def cancel_task(self, task_id: str) -> Dict[str, Any]: return await self.request("POST", f"/tasks/{task_id}/cancel")
    async def run_command(self, payload: Dict[str, Any]) -> Dict[str, Any]: return await self.request("POST", "/commands", json_body=payload)
    async def get_command(self, task_id: str, command_id: str) -> Dict[str, Any]: return await self.request("GET", f"/commands/{command_id}", params={"task_id": task_id})
    async def cancel_command(self, task_id: str, command_id: str) -> Dict[str, Any]: return await self.request("POST", f"/commands/{command_id}/cancel", params={"task_id": task_id})
    async def list_task_commands(self, task_id: str) -> Dict[str, Any]: return await self.request("GET", f"/tasks/{task_id}/commands")

    def sync(self, coro):
        try: asyncio.get_running_loop()
        except RuntimeError:
            # A compatibility caller may invoke sync repeatedly.  An httpx
            # AsyncClient is bound to its event loop, so close it before the
            # per-call loop disappears instead of retaining a stale transport.
            async def run_and_close():
                try: return await coro
                finally: await self.close()
            return asyncio.run(run_and_close())
        raise WorkerError("WORKER_PROTOCOL_ERROR", "synchronous gateway called from running event loop")
