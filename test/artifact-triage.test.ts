import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { renderTriageSection, triageAttachments, triageFile } from "../src/artifact-triage.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("deterministic artifact triage", () => {
  it("classifies ELF, text, zip, and encrypted-looking blobs without model calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-triage-"));
    roots.push(root);

    // Minimal ELF64 header: magic, class=2, data=1, e_type=2 at offset 16.
    const elf = Buffer.alloc(64, 0);
    elf.write("\x7fELF", 0, "latin1");
    elf[4] = 2; elf[5] = 1;
    elf.writeUInt16LE(2, 16);
    await writeFile(join(root, "authenticator"), elf);

    await writeFile(join(root, "README.txt"), "flag{demo}\nvisit https://meshgate.internal/login\n");
    await writeFile(join(root, "bundle.zip"), Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(64, 7)]));
    await writeFile(join(root, "blob.bin"), randomBytes(4096));

    const results = await triageAttachments([
      { path: join(root, "authenticator"), name: "authenticator" },
      { path: join(root, "README.txt"), name: "README.txt" },
      { path: join(root, "bundle.zip"), name: "bundle.zip" },
      { path: join(root, "blob.bin"), name: "blob.bin" },
    ]);
    const byName = new Map(results.map((item) => [item.name, item]));

    expect(byName.get("authenticator")?.type).toContain("ELF 64-bit");
    expect(byName.get("README.txt")?.type).toContain("text");
    expect(byName.get("README.txt")?.printableRatio).toBeGreaterThan(0.95);
    expect(byName.get("README.txt")?.notableStrings.join(" ")).toContain("flag{demo}");
    expect(byName.get("bundle.zip")?.type).toBe("zip archive");
    expect(byName.get("blob.bin")?.type).toBe("unrecognized binary data");
    expect(byName.get("blob.bin")?.entropy).toBeGreaterThan(7);
    expect(byName.get("blob.bin")?.headHex).toMatch(/^[0-9a-f]{16}$/);

    const rendered = renderTriageSection(results);
    expect(rendered).toContain("DETERMINISTIC ARTIFACT TRIAGE");
    expect(rendered).toContain("authenticator: 64B, ELF 64-bit");
    expect(rendered.length).toBeLessThan(6_500);

    // Missing files are skipped, not fatal.
    expect(await triageFile({ path: join(root, "nope.bin") })).toBeUndefined();
    expect(renderTriageSection([])).toBe("");
  });
});
