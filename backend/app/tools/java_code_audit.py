"""
JavaCodeAuditTool - Enhanced Java horizontal privilege escalation (IDOR/BOLA) auditor.
Round 2: Full controller+method path extraction, enhanced auth patterns, evidence chain.
"""
import os
import re
import zipfile
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.tools.base import BaseTool

logger = logging.getLogger(__name__)

# --- Pattern definitions ---

HTTP_METHOD_ANNOTATIONS = {
    "@GetMapping": "GET",
    "@PostMapping": "POST",
    "@PutMapping": "PUT",
    "@DeleteMapping": "DELETE",
    "@PatchMapping": "PATCH",
    "@RequestMapping": "ANY",
}

HIGH_RISK_PARAMS = {
    "userid", "accountid", "orderid", "adminid", "tenantid",
    "companyid", "orgid", "customerid", "memberid", "ownerid",
    "advertiserid", "agentid", "authorizeruserid", "erpuserid",
    "id", "uid", "pid", "gid",
}

PARAM_ANNOTATIONS = ["@RequestParam", "@PathVariable", "@RequestBody",
                     "@ModelAttribute", "HttpServletRequest"]

# Strong auth evidence (ownership check / RBAC / ABAC)
STRONG_AUTH_PATTERNS = [
    r"@PreAuthorize", r"@PostAuthorize", r"@Secured", r"@RolesAllowed",
    r"@PermissionRequired", r"checkPermission", r"hasPermission",
    r"verifyPermission", r"validatePermission", r"assertPermission",
    r"checkOwner", r"isOwner\b", r"belongTo", r"belongsTo",
    r"checkAccount", r"checkUser", r"checkTenant",
    r"authService", r"permissionService", r"rbacService", r"abacService",
    r"@LoginRequired", r"@OAuthLoginRequired",
]

# Weak auth evidence (only login check, no ownership check)
WEAK_AUTH_PATTERNS = [
    r"getCurrentUser", r"currentUser", r"getLoginUser",
    r"loginUser", r"SecurityContextHolder", r"getAuthentication",
]

MAX_FILES = 200
MAX_FILE_SIZE_BYTES = 1024 * 1024  # 1 MB

PRIORITY_KEYWORDS = ["controller", "api", "web", "resource", "endpoint"]


def _is_safe_zip_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    parts = [p for p in normalized.split("/") if p]
    return bool(parts) and not normalized.startswith("/") and ".." not in parts


def _path_value(annotation: str) -> str:
    m = re.search(r'["\']([^"\']+)["\']', annotation)
    return m.group(1) if m else ""


def _extract_params_from_method(method_body: str) -> List[str]:
    """Extract parameter names from method signature."""
    params = []
    for ann in PARAM_ANNOTATIONS:
        for m in re.finditer(rf'{re.escape(ann)}[^)]*\)\s*\w+\s+(\w+)', method_body):
            params.append(m.group(1))
    # Also match plain type paramName patterns in method signature
    for m in re.finditer(r'\bString\s+(\w+)|\bLong\s+(\w+)|\bInteger\s+(\w+)|\blong\s+(\w+)|\bint\s+(\w+)', method_body.split("{")[0] if "{" in method_body else method_body):
        p = next(g for g in m.groups() if g)
        params.append(p)
    return list(dict.fromkeys(params))


def _is_high_risk_param(param: str) -> bool:
    return param.lower() in HIGH_RISK_PARAMS or any(
        param.lower().endswith(suffix) for suffix in ["id", "userid", "accountid"]
    )


def _check_auth(method_body: str) -> Tuple[str, List[str]]:
    """
    Returns (auth_level, found_patterns).
    auth_level: "strong" | "weak" | "none"
    """
    strong = [p for p in STRONG_AUTH_PATTERNS if re.search(p, method_body, re.IGNORECASE)]
    if strong:
        return "strong", strong
    weak = [p.replace(r"\b", "") for p in WEAK_AUTH_PATTERNS if re.search(p, method_body, re.IGNORECASE)]
    if weak:
        return "weak", weak
    return "none", []


def _analyze_java_file(filepath: str, content: str) -> List[Dict[str, Any]]:
    """Analyze a single Java file and return list of risk findings."""
    findings = []
    filename = os.path.basename(filepath)
    lines = content.split("\n")

    # Extract class-level path
    class_path = ""
    class_name = ""
    is_controller = False

    for line in lines[:50]:  # class-level annotations in first 50 lines
        if "@RestController" in line or "@Controller" in line:
            is_controller = True
        if "@RequestMapping" in line:
            m = re.search(r'["\']([^"\']+)["\']', line)
            if m:
                class_path = m.group(1)
        if "class " in line:
            m = re.search(r'class\s+(\w+)', line)
            if m:
                class_name = m.group(1)

    if not is_controller:
        return []

    # Find all method blocks
    content_joined = content.replace("\n", " ")
    # Match method with HTTP annotation
    method_pattern = re.compile(
        r'(@(?:GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*(?:\([^)]*\))?)'
        r'[^{;]{0,300}?(\w+)\s*\(([^)]*)\)\s*(?:throws[^{]*)?(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})',
        re.DOTALL
    )

    for m in method_pattern.finditer(content):
        annotation_full = m.group(1)
        method_name = m.group(2)
        params_str = m.group(3) + m.group(0)[:200]  # include surrounding context
        method_body = m.group(0)

        # Determine HTTP method and path
        http_method = "ANY"
        for ann, method in HTTP_METHOD_ANNOTATIONS.items():
            if ann.lower() in annotation_full.lower():
                http_method = method
                break

        method_path = _path_value(annotation_full)
        full_path = (class_path.rstrip("/") + "/" + method_path.lstrip("/")).rstrip("/") or "/"
        if not full_path.startswith("/"):
            full_path = "/" + full_path

        # Extract params
        all_params = _extract_params_from_method(params_str)
        risk_params = [p for p in all_params if _is_high_risk_param(p)]

        if not risk_params:
            continue  # Only report methods with high-risk params

        auth_level, auth_evidence = _check_auth(method_body)

        # Determine risk level
        if auth_level == "none":
            risk_level = "HIGH"
            reason = f"接口接收 {', '.join(risk_params)} 等资源ID参数，但未发现任何鉴权或资源归属校验。"
            suggestion = f"应根据当前登录用户校验资源归属关系，例如验证 {risk_params[0]}.owner == currentUser.id。"
        elif auth_level == "weak":
            risk_level = "MEDIUM"
            reason = f"接口接收 {', '.join(risk_params)} 等资源ID参数，仅发现登录态校验（{', '.join(auth_evidence[:2])}），未发现资源归属校验。"
            suggestion = f"仅验证登录不足以防止水平越权，应添加对 {risk_params[0]} 的归属校验（如 order.userId == currentUser.id）。"
        else:
            risk_level = "LOW"
            reason = f"接口接收 {', '.join(risk_params)} 等资源ID参数，发现权限校验逻辑（{', '.join(auth_evidence[:2])}）。"
            suggestion = "当前已有权限校验，建议定期审查校验逻辑是否完整覆盖所有分支。"

        findings.append({
            "risk_level": risk_level,
            "file": filename,
            "class_name": class_name,
            "method_name": method_name,
            "http_method": http_method,
            "path": full_path,
            "risk_params": risk_params,
            "auth_evidence": auth_evidence,
            "reason": reason,
            "suggestion": suggestion,
        })

    return findings


def _sort_files_by_priority(java_files: List[str]) -> List[str]:
    def priority(path: str) -> int:
        pl = path.lower()
        for i, kw in enumerate(PRIORITY_KEYWORDS):
            if kw in pl:
                return i
        return len(PRIORITY_KEYWORDS)
    return sorted(java_files, key=priority)


class JavaCodeAuditTool(BaseTool):
    name = "JavaCodeAuditTool"
    description = "Java 源码水平越权审计：识别 Controller 层接口定义、提取资源 ID 参数、检查鉴权逻辑"
    category = "audit"
    enabled = True
    input_schema = {
        "type": "object",
        "properties": {"file_path": {"type": "string", "description": "Java 文件、源码目录或 ZIP 压缩包路径"}},
        "required": ["file_path"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "findings": {"type": "array", "items": {"type": "object"}},
            "high_risk_count": {"type": "integer"},
            "medium_risk_count": {"type": "integer"},
            "low_risk_count": {"type": "integer"},
        },
    }
    permissions = ["local_file_read"]
    risk_level = "low"
    timeout_seconds = 30
    tags = ["java", "code_audit", "idor", "bola"]

    def run(self, context: dict) -> dict:
        file_path = context.get("file_path", "")
        task_type = context.get("task_type", "")

        if not file_path:
            # No file provided - try demo samples
            for demo_candidate in [
                Path("./backend/app/storage/samples/java_auth_demo"),
                Path("/app/app/storage/samples/java_auth_demo"),
                Path("./app/storage/samples/java_auth_demo"),
            ]:
                if demo_candidate.exists():
                    return self._analyze_directory(str(demo_candidate), "demo")
            return {
                "success": False,
                "summary": "未提供文件路径，请上传 Java 文件或 ZIP 压缩包",
                "details": {},
                "evidence": [],
            }

        path = Path(file_path)
        if not path.exists():
            # Try demo samples - support both host and container paths
            for demo_candidate in [
                Path("./backend/app/storage/samples/java_auth_demo"),
                Path("/app/app/storage/samples/java_auth_demo"),
                Path("./app/storage/samples/java_auth_demo"),
            ]:
                if demo_candidate.exists():
                    return self._analyze_directory(str(demo_candidate), "demo")
            return {
                "success": False,
                "summary": f"文件不存在: {file_path}",
                "details": {},
                "evidence": [],
            }

        if path.suffix.lower() == ".zip":
            return self._analyze_zip(str(path))
        elif path.suffix.lower() == ".java":
            return self._analyze_single_java(str(path))
        elif path.is_dir():
            return self._analyze_directory(str(path), path.name)
        else:
            return {
                "success": False,
                "summary": f"不支持的文件类型: {path.suffix}",
                "details": {},
                "evidence": [],
            }

    def _analyze_single_java(self, filepath: str) -> dict:
        try:
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            findings = _analyze_java_file(filepath, content)
            return self._build_result(findings, 1, 0, [])
        except Exception as e:
            return {"success": False, "summary": f"分析失败: {e}", "details": {}, "evidence": []}

    def _analyze_directory(self, dirpath: str, label: str) -> dict:
        java_files = []
        for root, _, files in os.walk(dirpath):
            for fn in files:
                if fn.endswith(".java"):
                    java_files.append(os.path.join(root, fn))

        java_files = _sort_files_by_priority(java_files)
        skipped = []
        all_findings = []
        analyzed = 0

        for fp in java_files[:MAX_FILES]:
            sz = os.path.getsize(fp)
            if sz > MAX_FILE_SIZE_BYTES:
                skipped.append(f"{fp} (too large: {sz}B)")
                continue
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                findings = _analyze_java_file(fp, content)
                all_findings.extend(findings)
                analyzed += 1
            except Exception as e:
                skipped.append(f"{fp} ({e})")

        if len(java_files) > MAX_FILES:
            skipped.append(f"超过文件分析上限（{MAX_FILES}），剩余 {len(java_files) - MAX_FILES} 个文件未分析")

        return self._build_result(all_findings, analyzed, len(java_files), skipped)

    def _analyze_zip(self, zip_path: str) -> dict:
        skipped = []
        all_findings = []
        analyzed = 0
        java_names: List[str] = []
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                infos = []
                for i in zf.infolist():
                    if i.is_dir() or not i.filename.endswith(".java"):
                        continue
                    if not _is_safe_zip_member(i.filename):
                        skipped.append(f"{i.filename} (unsafe zip path)")
                        continue
                    infos.append(i)
                java_names = _sort_files_by_priority([i.filename for i in infos])
                info_map = {i.filename: i for i in infos}
                for name in java_names[:MAX_FILES]:
                    info = info_map[name]
                    if info.file_size > MAX_FILE_SIZE_BYTES:
                        skipped.append(f"{name} (too large: {info.file_size}B)")
                        continue
                    try:
                        content = zf.read(info).decode("utf-8", errors="ignore")
                        all_findings.extend(_analyze_java_file(name, content))
                        analyzed += 1
                    except Exception as e:
                        skipped.append(f"{name} ({e})")
                if len(java_names) > MAX_FILES:
                    skipped.append(f"超过文件分析上限（{MAX_FILES}），剩余 {len(java_names) - MAX_FILES} 个文件未分析")
            result = self._build_result(all_findings, analyzed, len(java_names), skipped)
        except Exception as e:
            result = {"success": False, "summary": f"ZIP 解析失败: {e}", "details": {}, "evidence": []}
        return result

    def _build_result(
        self,
        findings: List[Dict],
        analyzed: int,
        total: int,
        skipped: List[str],
    ) -> dict:
        high = [f for f in findings if f["risk_level"] == "HIGH"]
        medium = [f for f in findings if f["risk_level"] == "MEDIUM"]
        low = [f for f in findings if f["risk_level"] == "LOW"]

        summary_parts = [f"已分析 {analyzed} 个 Java 文件"]
        if total > analyzed:
            summary_parts.append(f"共 {total} 个")
        if high:
            summary_parts.append(f"发现 {len(high)} 个 HIGH 风险接口")
        if medium:
            summary_parts.append(f"{len(medium)} 个 MEDIUM 风险接口")
        if low:
            summary_parts.append(f"{len(low)} 个 LOW 风险接口")
        if not findings:
            summary_parts.append("未发现明显越权风险")

        evidence = []
        for f in findings:
            line = f"[{f['risk_level']}] {f['http_method']} {f['path']} ({f['file']}.{f['method_name']}) - {f['reason'][:60]}"
            evidence.append(line)

        return {
            "success": True,
            "summary": "；".join(summary_parts),
            "details": {
                "high_risk_count": len(high),
                "medium_risk_count": len(medium),
                "low_risk_count": len(low),
                "total_findings": len(findings),
                "analyzed_files": analyzed,
                "total_java_files": total,
                "skipped_files": skipped[:10],
                "findings": findings,
            },
            "evidence": evidence[:50],
        }

    def safe_run(self, context: dict) -> dict:
        try:
            return self.run(context)
        except Exception as e:
            logger.error(f"JavaCodeAuditTool error: {e}")
            return {
                "success": False,
                "summary": f"工具执行异常: {type(e).__name__}: {str(e)[:200]}",
                "details": {},
                "evidence": [],
            }
