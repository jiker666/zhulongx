"""
FileParserTool - detect file type and structure.
"""
import zipfile
from pathlib import Path
from typing import Any, Dict, List

from app.tools.base import BaseTool

JAVA_INDICATORS = {"pom.xml", "build.gradle", "gradlew", ".java"}
FRONTEND_INDICATORS = {"package.json", "index.html", "webpack.config.js", "vite.config.js", ".vue", ".jsx", ".tsx"}
LOG_INDICATORS = {".log", "access.log", "error.log"}
BINARY_EXTENSIONS = {".class", ".jar", ".war", ".ear", ".exe", ".dll", ".so", ".bin", ".apk", ".ipa"}


class FileParserTool(BaseTool):
    name = "FileParserTool"
    description = "判断上传文件类型，对 zip 列出目录结构，识别项目类型"
    category = "file"
    input_schema = {
        "type": "object",
        "properties": {"file_path": {"type": "string", "description": "本地上传文件路径"}},
        "required": ["file_path"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "file_type": {"type": "string"},
            "project_type": {"type": "string"},
            "file_count": {"type": "integer"},
            "key_files": {"type": "array", "items": {"type": "string"}},
        },
    }
    permissions = ["local_file_read"]
    risk_level = "low"
    timeout_seconds = 15
    tags = ["file", "zip", "intent"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        file_path: str = context.get("file_path", "")

        if not file_path:
            return {
                "success": False,
                "summary": "未提供文件路径",
                "details": {},
                "evidence": [],
            }

        p = Path(file_path)
        if not p.exists():
            return {
                "success": False,
                "summary": f"文件不存在: {file_path}",
                "details": {},
                "evidence": [],
            }

        suffix = p.suffix.lower()
        file_size = p.stat().st_size

        if suffix == ".zip":
            return self._parse_zip(file_path, file_size)
        elif suffix in {".java", ".py", ".js", ".ts", ".html", ".css", ".json", ".md", ".xml", ".gradle"}:
            file_type = "source_code"
            content_preview = p.read_text(encoding="utf-8", errors="ignore")[:500]
            return {
                "success": True,
                "summary": f"源码文件 ({suffix}), 大小 {file_size} 字节",
                "details": {
                    "file_name": p.name,
                    "file_type": file_type,
                    "suffix": suffix,
                    "size": file_size,
                    "preview": content_preview,
                },
                "evidence": [f"源码文件: {p.name}"],
            }
        elif suffix in {".log", ".txt"}:
            file_type = "log"
            return {
                "success": True,
                "summary": f"日志/文本文件 ({suffix}), 大小 {file_size} 字节",
                "details": {
                    "file_name": p.name,
                    "file_type": file_type,
                    "suffix": suffix,
                    "size": file_size,
                },
                "evidence": [f"日志文件: {p.name}"],
            }
        elif suffix in BINARY_EXTENSIONS:
            return {
                "success": True,
                "summary": f"二进制文件 ({suffix}), 大小 {file_size} 字节，建议使用反编译工具处理",
                "details": {
                    "file_name": p.name,
                    "file_type": "binary",
                    "suffix": suffix,
                    "size": file_size,
                },
                "evidence": [f"二进制文件: {p.name}"],
            }
        else:
            return {
                "success": True,
                "summary": f"未知文件类型 ({suffix}), 大小 {file_size} 字节",
                "details": {
                    "file_name": p.name,
                    "file_type": "unknown",
                    "suffix": suffix,
                    "size": file_size,
                },
                "evidence": [],
            }

    def _parse_zip(self, file_path: str, file_size: int) -> Dict:
        try:
            with zipfile.ZipFile(file_path, "r") as zf:
                names: List[str] = zf.namelist()
                infos = zf.infolist()

            all_suffixes = {Path(n).suffix.lower() for n in names}
            file_names = [n for n in names if not n.endswith("/")]
            file_count = len(file_names)

            # Detect project type
            name_set = {Path(n).name.lower() for n in names}
            key_file_names = {
                "pom.xml", "build.gradle", "package.json", "openapi.yaml", "openapi.yml",
                "openapi.json", "swagger.yaml", "swagger.json", "access.log", "error.log",
            }
            key_files = [
                n for n in file_names
                if Path(n).name.lower() in key_file_names
                or n.lower().endswith("controller.java")
                or n.lower().endswith("resource.java")
                or n.lower().endswith("endpoint.java")
            ]
            has_java = any(s == ".java" for s in all_suffixes) or "pom.xml" in name_set or "build.gradle" in name_set
            has_frontend = "package.json" in name_set or ".vue" in all_suffixes or ".tsx" in all_suffixes or ".jsx" in all_suffixes
            has_logs = ".log" in all_suffixes or "access.log" in name_set or "error.log" in name_set
            has_api_docs = any(n in name_set for n in {"openapi.yaml", "openapi.yml", "openapi.json", "swagger.yaml", "swagger.json"})
            has_binary = any(s in all_suffixes for s in BINARY_EXTENSIONS)

            flags = [has_java, has_frontend, has_logs, has_api_docs, has_binary]
            if sum(bool(f) for f in flags) > 1:
                project_type = "mixed_project"
            elif has_java:
                project_type = "java_project"
            elif has_frontend:
                project_type = "frontend_project"
            elif has_logs:
                project_type = "log_files"
            elif has_api_docs:
                project_type = "api_docs"
            elif has_binary:
                project_type = "binary_files"
            else:
                project_type = "unknown"

            # Top-level dirs
            top_dirs = sorted({n.split("/")[0] for n in names if "/" in n})

            return {
                "success": True,
                "summary": f"ZIP 文件包含 {file_count} 个文件，识别为 {project_type}",
                "details": {
                    "file_name": Path(file_path).name,
                    "file_type": "zip",
                    "project_type": project_type,
                    "file_count": file_count,
                    "size": file_size,
                    "top_dirs": top_dirs[:20],
                    "suffixes": sorted(all_suffixes),
                    "file_list": file_names[:50],
                    "key_files": key_files[:50],
                    "total_uncompressed_size": sum(i.file_size for i in infos),
                    "skipped_reasons": [],
                },
                "evidence": [
                    f"ZIP 内 {file_count} 个文件",
                    f"项目类型: {project_type}",
                    f"关键文件: {key_files[:8]}",
                    f"顶层目录: {top_dirs[:5]}",
                ],
            }
        except Exception as e:
            return {
                "success": False,
                "summary": f"解析 ZIP 失败: {e}",
                "details": {},
                "evidence": [],
            }
