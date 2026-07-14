from __future__ import annotations

import base64
import json
import re

from app.agent_engine.providers.base import AssistantTurn, ModelProvider, ProviderToolCall


FLAG_RE = re.compile(r"flag\{[^}\r\n]+\}")
RESULT_RE = re.compile(r"RESULT_B64=([A-Za-z0-9+/=]+)")

CTF_ANALYZER = r'''
import base64
import codecs
import pathlib
import re
import urllib.parse

flag = re.compile(r"flag\{[^}\r\n]+\}")

def variants(value):
    yield value
    yield value[::-1]
    yield codecs.decode(value, "rot_13")
    yield urllib.parse.unquote(value)
    compact = "".join(value.split())
    for decoder in (
        lambda s: bytes.fromhex(s).decode("utf-8"),
        lambda s: base64.b64decode(s, validate=True).decode("utf-8"),
        lambda s: base64.b32decode(s).decode("utf-8"),
    ):
        try:
            yield decoder(compact)
        except Exception:
            pass

seen = set()
queue = []
for path in pathlib.Path(".").rglob("*"):
    if path.is_file() and ".agent_" not in str(path):
        queue.append(path.read_text(encoding="utf-8", errors="replace"))
for _ in range(4):
    next_queue = []
    for value in queue:
        if value in seen:
            continue
        seen.add(value)
        match = flag.search(value)
        if match:
            print(match.group(0))
            raise SystemExit(0)
        next_queue.extend(variants(value))
        next_queue.extend(re.findall(r"[A-Za-z0-9_{}%+=/-]{8,}", value))
    queue = next_queue
raise SystemExit(2)
'''

VULN_ANALYZER = r'''
import base64
import json
import pathlib

documents = []
for path in pathlib.Path(".").rglob("*"):
    if path.is_file() and ".agent_" not in str(path):
        documents.append((str(path), path.read_text(encoding="utf-8", errors="replace")))
joined = "\n".join(text for _, text in documents)
if "subprocess" in joined and "shell=True" in joined:
    finding = "command_injection"
    impact = "Attacker-controlled input reaches a shell command."
    remediation = "Avoid shell=True and pass a fixed argv list after validation."
elif "SELECT" in joined and ("+ user" in joined or "+ request" in joined or "f\"SELECT" in joined):
    finding = "sql_injection"
    impact = "Untrusted input changes the SQL query structure."
    remediation = "Use a parameterized query and bind user input."
elif ("open(BASE /" in joined or "read_text(BASE /" in joined) and "resolve()" not in joined:
    finding = "path_traversal"
    impact = "A user-controlled path can escape the intended data directory."
    remediation = "Resolve the candidate path and enforce containment below the data root."
else:
    finding = "unknown"
    impact = "No supported vulnerable data flow was confirmed."
    remediation = "Perform manual review."
result = {
    "finding": finding,
    "impact": impact,
    "evidence": ", ".join(path for path, _ in documents),
    "remediation": remediation,
}
encoded = base64.b64encode(json.dumps(result, sort_keys=True).encode()).decode()
print("RESULT_B64=" + encoded)
'''

REVERSE_FORENSICS_ANALYZER = r'''
import base64
import json
import pathlib
import re

documents = []
for path in pathlib.Path(".").rglob("*"):
    if path.is_file() and ".agent_" not in str(path):
        documents.append((str(path), path.read_text(encoding="utf-8", errors="replace")))
joined = "\n".join(text for _, text in documents)
patterns = (
    (r"SECRET_HEX=([0-9a-fA-F]+)", lambda value: "recovered:" + bytes.fromhex(value).decode()),
    (r"SECRET_B64=([A-Za-z0-9+/=]+)", lambda value: "recovered:" + base64.b64decode(value).decode()),
    (r"SECRET_REVERSED=([^\s]+)", lambda value: "recovered:" + value[::-1]),
    (r"IOC_IP=([^\s]+)", lambda value: "ioc_ip:" + value),
    (r"EXFIL_DOMAIN=([^\s]+)", lambda value: "exfil_domain:" + value),
    (r"DELETED_FILE=([^\s]+)", lambda value: "deleted_file:" + value),
)
conclusion = "unknown"
reproduction = "No supported marker was recovered."
for pattern, decoder in patterns:
    match = re.search(pattern, joined)
    if match:
        conclusion = decoder(match.group(1))
        reproduction = "Locate the evidence marker and apply its declared decoding operation."
        break
result = {
    "conclusion": conclusion,
    "evidence": ", ".join(path for path, _ in documents),
    "reproduction": reproduction,
}
encoded = base64.b64encode(json.dumps(result, sort_keys=True).encode()).decode()
print("RESULT_B64=" + encoded)
'''

INCIDENT_ANALYZER = r'''
import base64
import json
import pathlib
import re

text = "\n".join(
    path.read_text(encoding="utf-8", errors="replace")
    for path in pathlib.Path(".").rglob("*")
    if path.is_file() and ".agent_" not in str(path)
)
timeline = re.findall(r"^EVENT=(.+)$", text, re.MULTILINE)
iocs = re.findall(r"^IOC=(.+)$", text, re.MULTILINE)
actions = re.findall(r"^ACTION=(.+)$", text, re.MULTILINE)
root = re.search(r"^ROOT_CAUSE=(.+)$", text, re.MULTILINE)
result = {
    "timeline": timeline or ["No timeline recovered"],
    "iocs": iocs or ["No IOC recovered"],
    "root_cause": root.group(1) if root else "unknown",
    "actions": actions or ["Escalate for manual containment"],
}
encoded = base64.b64encode(json.dumps(result, sort_keys=True).encode()).decode()
print("RESULT_B64=" + encoded)
'''


class BenchmarkMockProvider(ModelProvider):
    """Deterministic five-scenario strategy for harness verification only."""

    def __init__(self, scenario: str, *, target_url: str = "") -> None:
        self.scenario = scenario
        self.target_url = target_url
        self.turn = 0

    def complete(self, messages, tools, *, timeout_seconds, abort_token):
        abort_token.raise_if_aborted()
        self.turn += 1
        if self.turn == 1:
            if self.scenario == "pentest":
                return AssistantTurn(
                    text="Request the explicitly scoped local target and inspect its response.",
                    tool_calls=(ProviderToolCall("http_1", "http_request", {"url": self.target_url}),),
                    finish_reason="tool_calls",
                )
            analyzer = {
                "ctf": CTF_ANALYZER,
                "vuln_analysis": VULN_ANALYZER,
                "reverse_forensics": REVERSE_FORENSICS_ANALYZER,
                "incident_response": INCIDENT_ANALYZER,
            }[self.scenario]
            return AssistantTurn(
                text="Run the bounded offline scenario analyzer over workspace evidence.",
                tool_calls=(ProviderToolCall("analyze_1", "run_python", {"code": analyzer, "timeout_seconds": 10}),),
                finish_reason="tool_calls",
            )

        serialized = str(messages)
        if self.scenario == "ctf":
            candidates = FLAG_RE.findall(serialized)
            candidate = candidates[-1] if candidates else ""
        elif self.scenario == "pentest":
            match = re.search(r"VULN:([a-z_]+)", serialized)
            finding = match.group(1) if match else "unknown"
            candidate = json.dumps({
                "finding": finding,
                "scope": self.target_url,
                "evidence": f"Scoped response contained marker VULN:{finding}",
                "remediation": "Apply server-side authorization and output controls for the confirmed route.",
            }, sort_keys=True)
        else:
            matches = RESULT_RE.findall(serialized)
            candidate = base64.b64decode(matches[-1]).decode() if matches else ""
        if candidate:
            return AssistantTurn(
                text="Submit the tool-derived result for hidden evaluator validation.",
                tool_calls=(ProviderToolCall("candidate_1", "submit_candidate", {"candidate": candidate}),),
                finish_reason="tool_calls",
            )
        return AssistantTurn(
            text="No result was reproduced.",
            tool_calls=(ProviderToolCall("human_1", "ask_human", {"question": "Mock analyzer found no result"}),),
            finish_reason="tool_calls",
        )
