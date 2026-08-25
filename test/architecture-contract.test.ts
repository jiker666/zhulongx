import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BUILTIN_TOOL_DESCRIPTORS } from "../src/tool-catalog.js";

const NEW_CORE_MODULES = [
  "agent-store", "agent-worker", "connector", "context-projection", "deep-research",
  "evaluation-ledger", "executor", "external-tools", "knowledge-store", "memory",
  "model-routing", "permissions", "profiles", "provider-errors", "run-recovery",
  "runtime-events", "session-trajectory", "tool-catalog", "workflow-worker", "workflow",
];

const LOWER_LAYERS = [
  "agent-store", "connector", "context-projection", "deep-research", "evaluation-ledger",
  "executor", "knowledge-store", "memory", "model-routing", "permissions",
  "provider-errors", "runtime-events", "tool-catalog", "workflow",
  "session-trajectory",
];

const FORBIDDEN_HIGHER_LAYER_IMPORTS = new Set([
  "cli", "dashboard", "manual-jobs", "run-manager", "runtime", "server",
]);

function localImports(source: string): string[] {
  return [...source.matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)].map((match) => match[1]!);
}

describe("architecture contracts", () => {
  it("keeps new core modules bounded and lower layers independent of HTTP/UI composition", async () => {
    for (const module of NEW_CORE_MODULES) {
      const source = await readFile(`src/${module}.ts`, "utf8");
      expect(source.split("\n").length, `${module}.ts must remain below 1000 lines`).toBeLessThan(1_000);
      if (LOWER_LAYERS.includes(module)) {
        expect(localImports(source).filter((dependency) => FORBIDDEN_HIGHER_LAYER_IMPORTS.has(dependency)), `${module}.ts has a reverse dependency`).toEqual([]);
      }
    }
  });

  it("requires every built-in tool to declare side effects and belong to the default profile", async () => {
    const config = await loadConfig("config/default.yaml");
    const allowed = new Set(config.profile?.toolAllowlist ?? []);
    for (const descriptor of BUILTIN_TOOL_DESCRIPTORS.values()) {
      expect(descriptor.sideEffects.length, `${descriptor.name} must document side effects`).toBeGreaterThan(0);
      expect(allowed.has(descriptor.name), `${descriptor.name} must be explicitly selected by the default profile`).toBe(true);
      if (descriptor.effect === "network" && ["http_request", "web_collect_baseline", "browser", "tcp_open"].includes(descriptor.name)) {
        expect(descriptor.networkTargetFields?.length, `${descriptor.name} must expose a policy-checkable target`).toBeGreaterThan(0);
      }
    }
  });
});
