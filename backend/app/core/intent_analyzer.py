"""
Task intent analysis for rule-based autonomous task understanding.
"""
from pathlib import Path
from typing import Any, Dict, List

from app.tools.file_parser import FileParserTool


UPLOAD_HINTS = ("/storage/uploads/", "\\storage\\uploads\\", "backend/app/storage/uploads", "app/storage/uploads")


def looks_like_uploaded_path(value: str) -> bool:
    raw = value or ""
    if any(h in raw for h in UPLOAD_HINTS):
        return True
    suffix = Path(raw).suffix.lower()
    return bool(raw and suffix in {".zip", ".java", ".log", ".txt", ".js", ".json"} and Path(raw).exists())


class TaskIntentAnalyzer:
    def analyze(
        self,
        task_type: str,
        description: str,
        target: str,
        uploaded_file: str = "",
    ) -> Dict[str, Any]:
        desc = (description or "").lower()
        target = target or ""
        uploaded_file = uploaded_file or ""
        evidence: List[str] = []
        modalities: List[str] = []
        parser_result: Dict[str, Any] = {}

        if target.startswith(("http://", "https://")) or "." in target:
            modalities.append("url")
            evidence.append(f"目标包含 URL/域名: {target}")

        if uploaded_file:
            modalities.append("file")
            suffix = Path(uploaded_file).suffix.lower()
            if suffix == ".zip":
                modalities.append("archive")
            evidence.append(f"存在上传文件: {Path(uploaded_file).name}")
            parser_result = FileParserTool().run({"file_path": uploaded_file})
            if parser_result.get("success"):
                details = parser_result.get("details", {})
                if details.get("project_type"):
                    evidence.append(f"文件解析识别为 {details.get('project_type')}")
                for key_file in details.get("key_files", [])[:8]:
                    evidence.append(f"关键文件: {key_file}")

        recommended = ""
        confidence = 0.55
        if task_type and task_type != "auto":
            recommended = task_type
            confidence = 0.85
            evidence.append(f"用户显式选择任务类型: {task_type}")
        elif any(kw in desc for kw in ["java", "代码", "越权", "controller", "audit", "审计"]):
            recommended = "code_audit"
            confidence = 0.8
        elif any(kw in desc for kw in ["log", "日志", "access", "应急", "incident"]):
            recommended = "log_analysis"
            confidence = 0.8
        elif any(kw in desc for kw in ["reverse", "逆向", "apk", "binary", "二进制"]):
            recommended = "reverse_helper"
            confidence = 0.72

        project_type = parser_result.get("details", {}).get("project_type", "")
        suffix = Path(uploaded_file).suffix.lower() if uploaded_file else ""
        if not recommended:
            if project_type in {"java_project", "mixed_project"} or suffix == ".java":
                recommended = "code_audit"
                confidence = 0.82
            elif project_type == "log_files" or suffix in {".log", ".txt"}:
                recommended = "log_analysis"
                confidence = 0.82
            elif project_type in {"frontend_project", "api_docs"} or suffix in {".js", ".ts", ".tsx", ".html", ".json"}:
                recommended = "reverse_helper"
                confidence = 0.7
            elif target:
                recommended = "web_scan"
                confidence = 0.75
            else:
                recommended = "web_scan"
                confidence = 0.5

        constraints = [
            "仅执行只读分析",
            "不进行爆破、漏洞利用、写入、登录尝试或破坏性操作",
        ]
        if "url" in modalities:
            constraints.append("外部网络访问需通过 SSRF 防护和超时限制")
        if "file" in modalities:
            constraints.append("仅分析用户上传文件，不读取无关本地路径")

        return {
            "intent_type": recommended,
            "input_modalities": modalities or ["text"],
            "target_summary": target or (Path(uploaded_file).name if uploaded_file else "未提供显式目标"),
            "confidence": confidence,
            "evidence": evidence,
            "recommended_scenario": recommended,
            "constraints": constraints,
            "safety_scope": {
                "allowed": ["read_only_analysis", "fingerprint", "limited_probe", "log_analysis", "code_audit"],
                "denied": ["bruteforce", "exploit", "getshell", "reverse_shell", "persistence", "data_theft", "destructive_action"],
            },
            "file_analysis": parser_result.get("details", {}) if parser_result else {},
        }
