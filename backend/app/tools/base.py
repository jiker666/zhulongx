"""
BaseTool - all tools must inherit this class.
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List


class BaseTool(ABC):
    name: str = ""
    description: str = ""
    category: str = "general"
    enabled: bool = True
    input_schema: Dict[str, Any] = {}
    output_schema: Dict[str, Any] = {}
    permissions: List[str] = ["local_read"]
    risk_level: str = "low"
    timeout_seconds: int = 30
    tags: List[str] = []

    @abstractmethod
    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError

    def safe_run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self.run(context)
        except Exception as e:
            return {
                "success": False,
                "summary": f"工具执行失败: {str(e)}",
                "details": {"error": str(e)},
                "evidence": [],
            }
