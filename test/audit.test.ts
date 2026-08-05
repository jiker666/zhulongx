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
});
