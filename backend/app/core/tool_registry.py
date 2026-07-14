"""
ToolRegistry - register and query tools.
Round 2: sync_to_db() writes registry to tools table on startup.
"""
import logging
import json
from typing import Dict, List, Optional

from app.tools.base import BaseTool
from app.tools.file_parser import FileParserTool
from app.tools.http_fingerprint import HttpFingerprintTool
from app.tools.directory_probe import DirectoryProbeTool
from app.tools.js_interface_extractor import JSInterfaceExtractorTool
from app.tools.java_code_audit import JavaCodeAuditTool
from app.tools.log_analyzer import LogAnalyzerTool
from app.tools.artifact_triage import ArtifactTriageTool
from app.tools.http_replay import HttpReplayTool
from app.tools.api_runner import APIRunnerTool
from app.tools.manual_action import ManualActionStep
from app.tools.filesystem import ListDirTool, ReadFileTool, WriteFileTool, GrepTool
from app.tools.shell import RunShellTool
from app.tools.python_runner import RunPythonTool
from app.tools.archive import ExtractArchiveTool
from app.tools.flag_submit import SubmitFlagTool
from app.tools.worker import WorkerHealthTool, WorkerCommandRunTool, WorkerCommandStatusTool, WorkerCommandCancelTool, WorkerTaskCancelTool, TerminalCreateTool, TerminalSendTool, TerminalReadTool, TerminalExpectTool, TerminalCloseTool

logger = logging.getLogger(__name__)


class ToolRegistry:
    _instance: Optional["ToolRegistry"] = None
    _tools: Dict[str, BaseTool] = {}

    def __new__(cls) -> "ToolRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._tools = {}
            cls._instance._register_defaults()
        return cls._instance

    def _register_defaults(self) -> None:
        default_tools = [
            FileParserTool(),
            HttpFingerprintTool(),
            DirectoryProbeTool(),
            JSInterfaceExtractorTool(),
            JavaCodeAuditTool(),
            LogAnalyzerTool(),
            ArtifactTriageTool(),
            HttpReplayTool(),
            APIRunnerTool(),
            ManualActionStep(),
            ListDirTool(),
            ReadFileTool(),
            WriteFileTool(),
            GrepTool(),
            RunShellTool(),
            RunPythonTool(),
            ExtractArchiveTool(),
            SubmitFlagTool(),
            WorkerHealthTool(), WorkerCommandRunTool(), WorkerCommandStatusTool(), WorkerCommandCancelTool(), WorkerTaskCancelTool(), TerminalCreateTool(), TerminalSendTool(), TerminalReadTool(), TerminalExpectTool(), TerminalCloseTool(),
        ]
        for tool in default_tools:
            self.register(tool)

    def register(self, tool: BaseTool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[BaseTool]:
        t = self._tools.get(name)
        if t and not getattr(t, "enabled", True):
            return None
        if t and not self.is_enabled(name):
            return None
        return t

    def is_enabled(self, name: str) -> bool:
        try:
            from app.database import SessionLocal
            from app.models.tool import Tool as ToolModel
            db = SessionLocal()
            try:
                entry = db.query(ToolModel).filter(ToolModel.name == name).first()
                return bool(entry.enabled) if entry else True
            finally:
                db.close()
        except Exception:
            return True

    @staticmethod
    def _as_json(value) -> str:
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)

    def list_tools(self) -> List[Dict]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "category": t.category,
                "enabled": getattr(t, "enabled", True) and self.is_enabled(t.name),
                "input_schema": self._as_json(getattr(t, "input_schema", {})),
                "output_schema": self._as_json(getattr(t, "output_schema", {})),
                "permissions": self._as_json(getattr(t, "permissions", [])),
                "risk_level": getattr(t, "risk_level", "low"),
                "timeout_seconds": getattr(t, "timeout_seconds", 30),
                "tags": self._as_json(getattr(t, "tags", [])),
            }
            for t in self._tools.values()
        ]

    def all_names(self) -> List[str]:
        """Return names of all ENABLED tools."""
        return [name for name, t in self._tools.items() if getattr(t, "enabled", True) and self.is_enabled(name)]

    def sync_to_db(self) -> None:
        """Sync registered tools to the tools table."""
        try:
            from app.database import SessionLocal
            from app.models.tool import Tool as ToolModel
            db = SessionLocal()
            for tool_info in self.list_tools():
                existing = db.query(ToolModel).filter(ToolModel.name == tool_info["name"]).first()
                if existing:
                    existing.description = tool_info["description"]
                    existing.category = tool_info["category"]
                    existing.input_schema = tool_info["input_schema"]
                    existing.output_schema = tool_info["output_schema"]
                    existing.permissions = tool_info["permissions"]
                    existing.risk_level = tool_info["risk_level"]
                    existing.timeout_seconds = tool_info["timeout_seconds"]
                    existing.tags = tool_info["tags"]
                else:
                    db.add(ToolModel(**tool_info))
            db.commit()
            db.close()
            logger.info(f"ToolRegistry synced {len(self._tools)} tools to DB")
        except Exception as e:
            logger.warning(f"ToolRegistry sync_to_db failed: {e}")


# Global singleton
tool_registry = ToolRegistry()
