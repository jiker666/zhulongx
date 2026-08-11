import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ManualUploadStore } from "../src/manual-uploads.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function uploadRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuan-manual-upload-"));
  roots.push(root);
  return root;
}

describe("ManualUploadStore", () => {
  it("streams binary files without changing their bytes and removes them on release", async () => {
    const root = await uploadRoot();
    const store = new ManualUploadStore(root);
    const bytes = Buffer.from([0, 255, 12, 13, 10, 128, 42]);

    const snapshot = await store.save(Readable.from(bytes), {
      fileName: "challenge.bin",
      contentLength: bytes.length,
    });
    const [path] = store.paths(snapshot.id);
    expect(path).toBeDefined();
    expect(await readFile(path!)).toEqual(bytes);
    expect(snapshot).toMatchObject({ files: [{ name: "challenge.bin", size: bytes.length }], totalBytes: bytes.length });

    store.claim(snapshot.id);
    await store.release(snapshot.id);
    await expect(access(path!)).rejects.toThrow();
    await store.close();
  });

  it("rejects unsafe names and enforces file, count, and aggregate limits", async () => {
    const root = await uploadRoot();
    const store = new ManualUploadStore(root, { maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4 });

    await expect(store.save(Readable.from("x"), { fileName: "../escape.txt" })).rejects.toThrow("safe leaf");
    await expect(store.save(Readable.from("12345"), { fileName: "large.bin" })).rejects.toThrow("exceeds 4 bytes");

    const first = await store.save(Readable.from("1234"), { fileName: "one.bin", contentLength: 4 });
    await expect(store.save(Readable.from("x"), { fileName: "two.bin", uploadId: first.id })).rejects.toThrow(
      "at most 1 files",
    );
    await store.close();
  });

  it("enforces the aggregate limit independently of the per-file limit", async () => {
    const root = await uploadRoot();
    const store = new ManualUploadStore(root, { maxFiles: 3, maxFileBytes: 4, maxTotalBytes: 5 });
    const first = await store.save(Readable.from("123"), { fileName: "one.bin" });

    await expect(store.save(Readable.from("456"), { fileName: "two.bin", uploadId: first.id })).rejects.toThrow(
      "batch exceeds 5 bytes",
    );
    await store.close();
  });
});
