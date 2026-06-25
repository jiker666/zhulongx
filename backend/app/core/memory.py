"""
Memory - stores task context and tool outputs.
"""
from typing import Any, Dict, List


class Memory:
    def __init__(self, task_id: int):
        self.task_id = task_id
        self._context: Dict[str, Any] = {}
        self._history: List[Dict[str, Any]] = []

    def set(self, key: str, value: Any) -> None:
        self._context[key] = value

    def get(self, key: str, default: Any = None) -> Any:
        return self._context.get(key, default)

    def add_step_result(self, step_index: int, tool_name: str, result: Dict[str, Any]) -> None:
        self._history.append({
            "step_index": step_index,
            "tool_name": tool_name,
            "result": result,
        })
        # Also update context with latest output
        self._context[f"step_{step_index}_output"] = result
        self._context["last_tool_output"] = result

    def get_context(self) -> Dict[str, Any]:
        return dict(self._context)

    def get_history(self) -> List[Dict[str, Any]]:
        return list(self._history)

    def summarize(self) -> str:
        parts = []
        for h in self._history:
            summary = h["result"].get("summary", "")
            parts.append(f"Step {h['step_index']} [{h['tool_name']}]: {summary}")
        return "\n".join(parts)
