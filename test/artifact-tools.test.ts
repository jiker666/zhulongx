import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractZipArchive, searchArtifact } from "../src/artifact-tools.js";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    data.copy(local, 30 + nameBytes.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

describe("artifact analysis helpers", () => {
  it("extracts bounded ZIP entries into scratch", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-artifact-"));
    try {
      const archive = join(root, "input.zip");
      const scratch = join(root, "scratch");
      await writeFile(archive, storedZip([["firmware/strings.txt", "admin=enabled"]]));

      const result = await extractZipArchive(archive, "workspace:input.zip", scratch, "extracted", 10, 1024);

      expect(result.entries).toEqual(["firmware/strings.txt"]);
      expect(await readFile(join(scratch, "extracted", "firmware", "strings.txt"), "utf8")).toBe("admin=enabled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects archive traversal and pre-existing scratch symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-artifact-"));
    try {
      const scratch = join(root, "scratch");
      const unsafeArchive = join(root, "unsafe.zip");
      const safeArchive = join(root, "safe.zip");
      await writeFile(unsafeArchive, storedZip([["../escape.txt", "nope"]]));
      await writeFile(safeArchive, storedZip([["inside.txt", "safe"]]));
      await expect(
        extractZipArchive(unsafeArchive, "workspace:unsafe.zip", scratch, "out", 10, 1024),
      ).rejects.toThrow(/invalid relative path|escapes extraction root/);
      await symlink(root, join(scratch, "linked"));
      await expect(
        extractZipArchive(safeArchive, "workspace:safe.zip", scratch, "linked", 10, 1024),
      ).rejects.toThrow(/regular directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("searches UTF-8 and hex patterns with bounded context", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-artifact-"));
    try {
      const path = join(root, "firmware.bin");
      await writeFile(path, Buffer.from([0x00, 0x41, 0x44, 0x4d, 0x49, 0x4e, 0x00, 0xff]));

      const text = await searchArtifact(root, "firmware.bin", "ADMIN", "utf8", 10, 2);
      const hex = await searchArtifact(root, "firmware.bin", "ff", "hex", 10, 1);

      expect(text.matches[0]?.offset).toBe(1);
      expect(text.matches[0]?.contextEncoding).toBe("base64");
      expect(hex.matches[0]?.offset).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors an already aborted operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-artifact-"));
    try {
      await writeFile(join(root, "firmware.bin"), "evidence");
      const controller = new AbortController();
      controller.abort();
      await expect(searchArtifact(root, "firmware.bin", "evidence", "utf8", 1, 0, controller.signal)).rejects.toThrow(/aborted/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
