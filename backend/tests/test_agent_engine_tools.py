import http.server
import io
import socket
import tarfile
import threading
import zipfile

import httpx

from app.agent_engine.abort import AbortToken
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.policy.scope import NetworkScope
from app.agent_engine.state import NetworkPolicy, RunRequest
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.builtin.http import HttpRequestExecutor
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.types import ToolCall, ToolContext


def _context(tmp_path, *, allow_process=False):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = RunRequest(
        task_id="task_tools",
        title="tools",
        objective="test registry execution",
        workspace=str(workspace),
        authorization={"authorized": True, "allow_process": allow_process},
    )
    return workspace, ToolContext(
        run_id="run_tools",
        request=request,
        workspace=workspace,
        abort_token=AbortToken(),
        sandbox=LocalTestSandbox(workspace),
    )


def test_builtin_registry_schema_and_executor_share_definition():
    registry = build_builtin_registry()
    assert len(registry.definitions()) == 27
    names = {definition.name for definition in registry.definitions()}
    assert {
        "worker.health",
        "worker.command.run",
        "worker.task.cancel",
        "terminal.create",
        "terminal.expect",
        "terminal.close",
    } <= names
    assert {item["function"]["name"] for item in registry.schemas()} == {
        definition.name for definition in registry.definitions()
    }
    assert all(definition.executor is not None for definition in registry.definitions())
    assert {
        "list_dir", "read_file", "write_file", "grep", "run_shell", "run_python", "submit_candidate",
        "record_evidence", "record_fact", "record_hypothesis", "refute_hypothesis", "revise_plan", "complete_task",
    }.issubset(
        {definition.name for definition in registry.definitions()}
    )


def test_invalid_arguments_return_structured_failure(tmp_path):
    workspace, context = _context(tmp_path)
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    execution = service.execute(ToolCall("call_1", "read_file", {}), context)

    assert execution.result.success is False
    assert execution.result.metadata["code"] == "invalid_arguments"
    assert execution.result_event.type == EventType.TOOL_FAILED.value


def test_unknown_tool_returns_structured_failure(tmp_path):
    workspace, context = _context(tmp_path)
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    execution = service.execute(ToolCall("call_unknown", "not_registered", {}), context)

    assert execution.result.metadata["code"] == "unknown_tool"


def test_process_tool_is_denied_before_execution(tmp_path):
    workspace, context = _context(tmp_path, allow_process=False)
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    execution = service.execute(ToolCall("call_shell", "run_shell", {"command": "echo should-not-run"}), context)

    assert execution.result.metadata["code"] == "policy_denied"
    assert EventType.POLICY_DENIED.value in [event.type for event in events.read("run_tools")]


def test_v2_read_file_rejects_symlink_escape(tmp_path):
    workspace, context = _context(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside", encoding="utf-8")
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    execution = service.execute(ToolCall("call_read", "read_file", {"path": "escape/secret.txt"}), context)

    assert execution.result.success is False
    assert execution.result.error == "path_escape"


def test_http_request_default_network_deny_happens_before_dns(tmp_path):
    workspace, context = _context(tmp_path)
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    execution = service.execute(
        ToolCall("call_http", "http_request", {"url": "https://example.com/"}),
        context,
    )

    assert execution.result.metadata["code"] == "policy_denied"


def test_http_request_allowlist_and_dns_validation(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = RunRequest(
        task_id="task_http",
        title="http",
        objective="request an authorized endpoint",
        workspace=str(workspace),
        authorization={"authorized": True, "allow_process": False},
        network_policy=NetworkPolicy(mode="allowlist", allowed_hosts=("example.com",), allowed_ports=(443,)),
    )
    context = ToolContext(
        run_id="run_http",
        request=request,
        workspace=workspace,
        abort_token=AbortToken(),
        sandbox=LocalTestSandbox(workspace),
    )
    scope = NetworkScope(resolver=lambda host, port: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port)),
    ])
    http_executor = HttpRequestExecutor(
        scope=scope,
        transport=httpx.MockTransport(lambda request: httpx.Response(200, text="authorized response")),
    )
    events = AppendOnlyEventStore()
    service = ToolExecutionService(
        build_builtin_registry(http_executor=http_executor),
        PolicyEngine(),
        events,
    )

    execution = service.execute(
        ToolCall("call_http_ok", "http_request", {"url": "https://example.com/path"}),
        context,
    )

    assert execution.result.success is True
    assert execution.result.output == "authorized response"
    assert execution.result.metadata["resolved_addresses"] == ["93.184.216.34"]


def test_http_request_rejects_private_dns_answer_without_explicit_authorization(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = RunRequest(
        task_id="task_private_http",
        title="http",
        objective="reject private DNS",
        workspace=str(workspace),
        authorization={"authorized": True},
        network_policy=NetworkPolicy(mode="allowlist", allowed_hosts=("target.example",), allowed_ports=(80,)),
    )
    context = ToolContext(
        run_id="run_private_http",
        request=request,
        workspace=workspace,
        abort_token=AbortToken(),
        sandbox=LocalTestSandbox(workspace),
    )
    executor = HttpRequestExecutor(scope=NetworkScope(resolver=lambda host, port: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
    ]))
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(http_executor=executor), PolicyEngine(), events)

    execution = service.execute(
        ToolCall("call_private", "http_request", {"url": "http://target.example/"}),
        context,
    )

    assert execution.result.success is False
    assert execution.result.metadata["code"] == "scope_denied"


def test_http_request_connects_to_validated_address_without_second_dns_lookup(tmp_path, monkeypatch):
    received_hosts = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            received_hosts.append(self.headers["Host"])
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"pinned response")

        def log_message(self, _format, *_args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    workspace = tmp_path / "pinned"
    workspace.mkdir()
    request = RunRequest(
        task_id="task_pinned_http",
        title="http",
        objective="connect only to the validated address",
        workspace=str(workspace),
        authorization={"authorized": True, "allow_private_network": True},
        network_policy=NetworkPolicy(
            mode="allowlist",
            allowed_hosts=("rebind.test",),
            allowed_ports=(port,),
        ),
    )
    context = ToolContext(
        run_id="run_pinned_http",
        request=request,
        workspace=workspace,
        abort_token=AbortToken(),
        sandbox=LocalTestSandbox(workspace),
    )
    scope = NetworkScope(resolver=lambda host, resolved_port: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", resolved_port)),
    ])
    executor = HttpRequestExecutor(scope=scope)
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected second DNS lookup")),
    )

    try:
        result = executor.execute(context, {"url": f"http://rebind.test:{port}/pinned"})
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert result.success is True
    assert result.output == "pinned response"
    assert result.metadata["resolved_addresses"] == ["127.0.0.1"]
    assert result.metadata["connected_address"] == "127.0.0.1"
    assert received_hosts == [f"rebind.test:{port}"]


def test_v2_archive_rejects_zip_and_tar_traversal(tmp_path):
    workspace, context = _context(tmp_path)
    zip_path = workspace / "bad.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("../../zip_escape.txt", "bad")
        archive.writestr("safe.txt", "safe")
    tar_path = workspace / "bad.tar"
    with tarfile.open(tar_path, "w") as archive:
        member = tarfile.TarInfo("../../tar_escape.txt")
        payload = b"bad"
        member.size = len(payload)
        archive.addfile(member, io.BytesIO(payload))
    events = AppendOnlyEventStore()
    service = ToolExecutionService(build_builtin_registry(), PolicyEngine(), events)

    zip_result = service.execute(ToolCall("zip_call", "extract_archive", {"path": "bad.zip"}), context)
    tar_result = service.execute(ToolCall("tar_call", "extract_archive", {"path": "bad.tar"}), context)

    assert zip_result.result.metadata["rejected_members"] == ["../../zip_escape.txt"]
    assert tar_result.result.metadata["rejected_members"] == ["../../tar_escape.txt"]
    assert not (tmp_path / "zip_escape.txt").exists()
    assert not (tmp_path / "tar_escape.txt").exists()
