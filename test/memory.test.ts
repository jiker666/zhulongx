import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function store() { const root = await mkdtemp(join(tmpdir(), "xuan-memory-")); roots.push(root); return new MemoryStore(root); }

describe("MemoryStore", () => {
  it("separates user notes and sourced project synthesis", async () => {
    const value = await store();
    await value.add({ scope: "user", scopeId: "u1", kind: "note", content: "Prefer concise reports", ttlMs: 10_000 });
    const project = await value.add({ scope: "project", scopeId: "p1", kind: "synthesized", content: "The project uses npm run check", sourceSessionIds: ["run-1"], confidence: "medium", ttlMs: 10_000 });
    expect(await value.list({ userId: "u1" })).toHaveLength(1);
    expect(await value.list({ projectId: "p1" })).toMatchObject([{ id: project.id, userConfirmed: false, sourceSessionIds: ["run-1"] }]);
    const context = await value.context({ userId: "u1", projectId: "p1" });
    expect(context).toContain("UNTRUSTED LONG-TERM REFERENCE"); expect(context).toContain("current operator request");
  });

  it("rejects sensitive candidates and never persists their value", async () => {
    const value = await store();
    await expect(value.add({ scope: "user", scopeId: "u1", kind: "note", content: "Authorization: Bearer secret-value-123", ttlMs: 10_000 })).rejects.toThrow("sensitive");
    await value.add({ scope: "user", scopeId: "u1", kind: "note", content: "Use deterministic tests", ttlMs: 10_000 });
    expect(await readFile(value.path, "utf8")).not.toContain("secret-value-123");
  });

  it("expires, confirms, disables and clears records", async () => {
    const value = await store();
    const expired = await value.add({ scope: "project", scopeId: "p1", kind: "synthesized", content: "old", sourceSessionIds: ["run-old"], ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5)); expect(await value.list({ projectId: "p1" })).toEqual([]);
    const active = await value.add({ scope: "project", scopeId: "p1", kind: "synthesized", content: "current", sourceSessionIds: ["run-new"], ttlMs: 10_000 });
    expect(await value.update(active.id, { userConfirmed: true, confidence: "high" })).toMatchObject({ userConfirmed: true, confidence: "high" });
    await value.update(active.id, { status: "disabled" }); expect(await value.list({ projectId: "p1" })).toEqual([]);
    expect(await value.clear({ scope: "project", scopeId: "p1" })).toBe(2);
    expect(expired.id).not.toBe(active.id);
  });
});
