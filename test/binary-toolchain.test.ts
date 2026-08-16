import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

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
  it("pins and verifies Radare2 and JADX before installing them", async () => {
    const [radare, jadx, sandboxDockerfile, tsecDockerfile] = await Promise.all([
      readFile("tools/ctf/install-radare2.sh", "utf8"),
      readFile("tools/ctf/install-jadx.sh", "utf8"),
      readFile("Dockerfile.ctf-sandbox", "utf8"),
      readFile("Dockerfile.tsec", "utf8"),
    ]);

    expect(radare).toContain("RADARE2_VERSION=6.2.0");
    expect(radare).toContain("radare2/releases/download/${RADARE2_VERSION}");
    expect(radare).toContain("sha256sum --check --status");
    expect(radare).toContain("dpkg --print-architecture");
    expect(jadx).toContain("JADX_VERSION=1.5.5");
    expect(jadx).toContain("skylot/jadx/releases/download/v${JADX_VERSION}");
    expect(jadx).toContain("sha256sum --check --status");
    for (const dockerfile of [sandboxDockerfile, tsecDockerfile]) {
      expect(dockerfile).toContain("install-radare2.sh");
      expect(dockerfile).toContain("install-jadx.sh");
    }
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
      "config/arena.yaml",
      "config/arena-container.yaml",
      "config/nss-wanqing.yaml",
      "config/tsec.yaml",
      "config/tsec-baidu-local.yaml",
      "config/tsec-hosted.yaml",
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
    expect(prompt).toContain("Use r2 for native disassembly/cross-references");
    expect(prompt).toContain("Use pwntools/pwn only for reproducible local harnesses");
    expect(prompt).toContain("extract_archive and search_artifact");
    expect(verifier).toContain("gdb-multiarch --version");
    expect(verifier).toContain("jadx --version");
  });
});
