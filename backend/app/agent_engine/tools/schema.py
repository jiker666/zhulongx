from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class SchemaIssue:
    path: str
    message: str


class ArgumentsValidationError(ValueError):
    def __init__(self, issues: list[SchemaIssue]) -> None:
        self.issues = issues
        super().__init__("; ".join(f"{item.path}: {item.message}" for item in issues))


_TYPES = {
    "object": lambda value: isinstance(value, Mapping),
    "array": lambda value: isinstance(value, (list, tuple)),
    "string": lambda value: isinstance(value, str),
    "integer": lambda value: isinstance(value, int) and not isinstance(value, bool),
    "number": lambda value: isinstance(value, (int, float)) and not isinstance(value, bool),
    "boolean": lambda value: isinstance(value, bool),
    "null": lambda value: value is None,
}


def validate_arguments(schema: Mapping[str, Any], value: Any) -> None:
    """Validate the JSON Schema subset used by registered v3 tools."""

    issues: list[SchemaIssue] = []
    _validate(schema, value, "$", issues)
    if issues:
        raise ArgumentsValidationError(issues)


def _validate(schema: Mapping[str, Any], value: Any, path: str, issues: list[SchemaIssue]) -> None:
    expected = schema.get("type")
    if expected:
        allowed = [expected] if isinstance(expected, str) else list(expected)
        if not any(_TYPES.get(item, lambda _: False)(value) for item in allowed):
            issues.append(SchemaIssue(path, f"expected type {allowed}"))
            return
    if "enum" in schema and value not in schema["enum"]:
        issues.append(SchemaIssue(path, f"value is not one of {schema['enum']}"))
    if isinstance(value, Mapping):
        properties = schema.get("properties", {})
        for required in schema.get("required", []):
            if required not in value:
                issues.append(SchemaIssue(f"{path}.{required}", "required property is missing"))
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    issues.append(SchemaIssue(f"{path}.{key}", "additional property is not allowed"))
        for key, item in value.items():
            if key in properties:
                _validate(properties[key], item, f"{path}.{key}", issues)
    if isinstance(value, (list, tuple)) and "items" in schema:
        for index, item in enumerate(value):
            _validate(schema["items"], item, f"{path}[{index}]", issues)
    if isinstance(value, str):
        if len(value) < int(schema.get("minLength", 0)):
            issues.append(SchemaIssue(path, "string is shorter than minLength"))
        if "maxLength" in schema and len(value) > int(schema["maxLength"]):
            issues.append(SchemaIssue(path, "string is longer than maxLength"))
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            issues.append(SchemaIssue(path, "number is less than minimum"))
        if "maximum" in schema and value > schema["maximum"]:
            issues.append(SchemaIssue(path, "number is greater than maximum"))
