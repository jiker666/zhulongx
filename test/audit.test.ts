import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain, verifyAuditChain } from "../src/audit.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AuditChain", () => {
  it("detects tampering in an append-only run log", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-audit-"));
    roots.push(root);
    const path = join(root, "audit.jsonl");
    const audit = new AuditChain(path, "run-1");
    await audit.append("run.started", { task: "inspect" });
    await audit.append("tool.result", { ok: true });
    expect(await verifyAuditChain(path)).toEqual({ valid: true, records: 2 });

    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace('"ok":true', '"ok":false'), "utf8");
    const tampered = await verifyAuditChain(path);
    expect(tampered.valid).toBe(false);
    expect(tampered.error).toContain("hash mismatch");
  });

  it("redacts secrets at the audit persistence boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-audit-redaction-"));
    roots.push(root);
    const path = join(root, "audit.jsonl");
    const audit = new AuditChain(path, "run-redacted");
    await audit.append("decision.checkpoint", {
      observation: "Authorization: Bearer audit-sensitive-value\nraw sk-abcdefghijklmnopqrstuvwx",
      nested: { cookie: "session=audit-sensitive-cookie" },
    });

    const content = await readFile(path, "utf8");
    expect(content).not.toContain("audit-sensitive-value");
    expect(content).not.toContain("audit-sensitive-cookie");
    expect(content).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(content).toContain("[redacted]");
    expect(await verifyAuditChain(path)).toEqual({ valid: true, records: 1 });
  });
});
