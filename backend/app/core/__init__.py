"""Core package exports loaded lazily to avoid tool/core import cycles."""
__all__ = ["Planner", "Executor", "Memory", "Judge", "Reporter", "tool_registry"]

def __getattr__(name):
    modules = {
        "Planner": ("app.core.planner", "Planner"),
        "Executor": ("app.core.executor", "Executor"),
        "Memory": ("app.core.memory", "Memory"),
        "Judge": ("app.core.judge", "Judge"),
        "Reporter": ("app.core.reporter", "Reporter"),
        "tool_registry": ("app.core.tool_registry", "tool_registry"),
    }
    if name not in modules: raise AttributeError(name)
    import importlib
    value = getattr(importlib.import_module(modules[name][0]), modules[name][1])
    globals()[name] = value
    return value
