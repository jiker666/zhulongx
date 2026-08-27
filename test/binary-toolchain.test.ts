import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parsePeHeaders } from "../src/tools.js";

const REQUIRED_PROGRAMS = [
  "addr2line",
  "c++filt",
  "gdb-multiarch",
  "jadx",
  "objcopy",
  "pwn",
  "r2",
  "rabin2",
  "rafind2",
  "ragg2",
  "rax2",
];

describe("RE/PWN binary toolchain", () => {
  it("parses bounded PE headers and maps the entry-point RVA to raw bytes", () => {
    const bytes = Buffer.alloc(0x400);
    const peOffset = 0x80;
    const coffOffset = peOffset + 4;
    const optionalOffset = coffOffset + 20;
    const sectionOffset = optionalOffset + 0xf0;
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(peOffset, 0x3c);
    bytes.write("PE\0\0", peOffset, "ascii");
    bytes.writeUInt16LE(0x8664, coffOffset);
    bytes.writeUInt16LE(1, coffOffset + 2);
    bytes.writeUInt32LE(0x12345678, coffOffset + 4);
    bytes.writeUInt16LE(0xf0, coffOffset + 16);
    bytes.writeUInt16LE(0x2022, coffOffset + 18);
    bytes.writeUInt16LE(0x20b, optionalOffset);
    bytes.writeUInt32LE(0x1010, optionalOffset + 16);
    bytes.writeBigUInt64LE(0x140000000n, optionalOffset + 24);
    bytes.writeUInt32LE(0x1000, optionalOffset + 32);
    bytes.writeUInt32LE(0x200, optionalOffset + 36);
    bytes.writeUInt32LE(0x3000, optionalOffset + 56);
    bytes.writeUInt32LE(0x400, optionalOffset + 60);
    bytes.writeUInt16LE(3, optionalOffset + 68);
    bytes.writeUInt32LE(16, optionalOffset + 108);
    bytes.writeUInt32LE(0x2000, optionalOffset + 112 + 8);
    bytes.writeUInt32LE(0x80, optionalOffset + 112 + 12);
    bytes.write(".text", sectionOffset, "ascii");
    bytes.writeUInt32LE(0x100, sectionOffset + 8);
    bytes.writeUInt32LE(0x1000, sectionOffset + 12);
    bytes.writeUInt32LE(0x200, sectionOffset + 16);
    bytes.writeUInt32LE(0x200, sectionOffset + 20);
    bytes.writeUInt32LE(0x60000020, sectionOffset + 36);

    expect(parsePeHeaders(bytes)).toMatchObject({
      format: "pe",
      architecture: "PE32+",
      machineName: "x86_64",
      numberOfSections: 1,
      entryPointRva: "0x1010",
      entryPointFileOffset: 0x210,
      sections: [{ name: ".text", rawPointer: 0x200, rawEnd: 0x400 }],
      dataDirectories: { import: { rva: 0x2000, size: 0x80 } },
    });
  });

  it("does not invent PE structure for malformed or truncated DOS inputs", () => {
    const bytes = Buffer.alloc(64);
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x200, 0x3c);
    expect(parsePeHeaders(bytes)).toMatchObject({ format: "dos", validPeSignature: false, peHeaderOffset: 0x200 });
    expect(parsePeHeaders(Buffer.from("not-a-pe"))).toBeUndefined();
  });

  it("pins and verifies Radare2 and JADX before installing them", async () => {
    const [radare, jadx, sandboxDockerfile] = await Promise.all([
      readFile("tools/ctf/install-radare2.sh", "utf8"),
      readFile("tools/ctf/install-jadx.sh", "utf8"),
      readFile("Dockerfile.ctf-sandbox", "utf8"),
    ]);

    expect(radare).toContain("RADARE2_VERSION=6.2.0");
    expect(radare).toContain("radare2/releases/download/${RADARE2_VERSION}");
    expect(radare).toContain("sha256sum --check --status");
    expect(radare).toContain("dpkg --print-architecture");
    expect(jadx).toContain("JADX_VERSION=1.5.5");
    expect(jadx).toContain("skylot/jadx/releases/download/v${JADX_VERSION}");
    expect(jadx).toContain("sha256sum --check --status");
    expect(sandboxDockerfile).toContain("install-radare2.sh");
    expect(sandboxDockerfile).toContain("install-jadx.sh");
  });

  it("declares only reviewed binary tools through the manifest and operator configs", async () => {
    const manifest = JSON.parse(await readFile("tools/ctf/capabilities.json", "utf8")) as {
      profiles: {
        core: {
          binutilsCommands: string[];
          bundled: Record<string, { version: string; programs: string[] }>;
          commands: { pwn: string[]; reverse: string[] };
        };
      };
    };

    expect(manifest.profiles.core.binutilsCommands).toEqual(
      expect.arrayContaining(["addr2line", "c++filt", "objcopy"]),
    );
    expect(manifest.profiles.core.bundled.radare2).toMatchObject({
      version: "6.2.0",
      programs: ["r2", "rabin2", "rafind2", "ragg2", "rax2"],
    });
    expect(manifest.profiles.core.bundled.jadx).toMatchObject({ version: "1.5.5", programs: ["jadx"] });
    expect(manifest.profiles.core.bundled.pwntools).toMatchObject({ version: "4.15.0", programs: ["pwn"] });
    expect(manifest.profiles.core.commands.pwn).toContain("gdb-multiarch");
    expect(manifest.profiles.core.commands.reverse).toEqual(expect.arrayContaining(REQUIRED_PROGRAMS.filter((program) => program !== "pwn")));

    for (const path of [
      "config/default.yaml",
      "config/container.yaml",
    ]) {
      const config = parse(await readFile(path, "utf8")) as { scope: { allowedPrograms: string[] } };
      expect(config.scope.allowedPrograms, path).toEqual(expect.arrayContaining(REQUIRED_PROGRAMS));
    }
  });

  it("documents offline routing and keeps remote interaction on scoped TCP", async () => {
    const [guide, prompt, verifier] = await Promise.all([
      readFile("docs/binary-toolchain.md", "utf8"),
      readFile("src/system-prompt.ts", "utf8"),
      readFile("tools/ctf/verify-core-tools.sh", "utf8"),
    ]);

    expect(guide).toContain("structured `run_command`");
    expect(guide).toContain("network-isolated");
    expect(prompt).toContain("PolicyEngine");
    expect(prompt).toContain("attachments");
    expect(verifier).toContain("gdb-multiarch --version");
    expect(verifier).toContain("jadx --version");
  });
});
