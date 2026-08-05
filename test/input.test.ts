import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTask, renderTaskContext } from "../src/input.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task input normalization", () => {
  it("normalizes structured files and directory manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-input-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "nested"), { recursive: true });
    const jsonPath = join(workspace, "task.json");
    await writeFile(jsonPath, JSON.stringify({ target: "local", action: "inspect" }), "utf8");
    await writeFile(join(workspace, "nested", "note.txt"), "evidence", "utf8");

    const task = await normalizeTask({ task: "分析输入", attachments: [jsonPath, workspace] });
    expect(task.attachments[0]?.kind).toBe("structured");
    expect(task.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(task.attachments[1]?.entries).toContain("nested/note.txt");
    expect(renderTaskContext(task)).toContain('"target":"local"');
  });

  it("uses file magic instead of a misleading .zip extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-input-magic-"));
    roots.push(root);
    const disguised = join(root, "audio.zip");
    await writeFile(disguised, Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01]));
    const task = await normalizeTask({ task: "识别附件", attachments: [disguised] });
    expect(task.attachments[0]?.kind).toBe("binary");
  });
});
