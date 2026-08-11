import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("Docker sandbox wiring", () => {
  it("keeps the CTF sandbox sidecar offline with split input/work/socket mounts", async () => {
    const compose = parse(await readFile("docker-compose.yml", "utf8")) as {
      services: Record<string, { network_mode?: string; volumes?: string[] }>;
    };

    expect(compose.services["ctf-sandbox"]?.network_mode).toBe("none");
    expect(compose.services["ctf-sandbox"]?.volumes).toContain("./workspace:/workspace/input:ro");
    expect(compose.services["ctf-sandbox"]?.volumes).toContain("xuanshu-work:/workspace/work");
    expect(compose.services["ctf-sandbox"]?.volumes).toContain("xuanshu-sockets:/run/xuanshu");
    expect(compose.services.xuanshu?.volumes).toContain("xuanshu-sockets:/run/xuanshu");
  });

  it("hardens the local sidecar and exposes only a loopback control port", async () => {
    const launcher = await readFile("tools/ctf/run-local-sandbox.sh", "utf8");

    expect(launcher).toContain("docker network create --internal");
    expect(launcher).toContain("--publish 127.0.0.1:7320:7320");
    expect(launcher).toContain("--read-only");
    expect(launcher).toContain("--cap-drop ALL");
    expect(launcher).toContain("--security-opt no-new-privileges");
    expect(launcher).toContain("--pids-limit 256");
  });

  it("installs, declares, and smoke-checks the core Crypto/Misc profile", async () => {
    const [installer, manifestSource, requirements, verifier, dockerfile] = await Promise.all([
      readFile("tools/ctf/install-apt-core.sh", "utf8"),
      readFile("tools/ctf/capabilities.json", "utf8"),
      readFile("tools/ctf/requirements-core.txt", "utf8"),
      readFile("tools/ctf/verify-core-tools.sh", "utf8"),
      readFile("Dockerfile.ctf-sandbox", "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      profiles: {
        core: {
          apt: string[];
          commands: { crypto: string[]; misc: string[] };
          pythonModules: string[];
        };
      };
    };
    const expectedApt = [
      "gifsicle",
      "gmp-ecm",
      "libsox-fmt-all",
      "minimodem",
      "multimon-ng",
      "outguess",
      "pari-gp",
      "pngcheck",
      "sox",
      "steghide",
      "stegsnow",
      "tesseract-ocr",
    ];
    const expectedRequirements = [
      "cysignals==1.12.5",
      "mmh3==5.2.1",
      "ortools==9.15.6755",
      "pickora==1.0.1",
      "tqdm==4.70.0",
    ];

    for (const dependency of expectedApt) {
      expect(installer).toContain(`${dependency} \\`);
      expect(manifest.profiles.core.apt).toContain(dependency);
    }
    for (const dependency of expectedRequirements) expect(requirements).toContain(dependency);
    expect(manifest.profiles.core.commands.crypto).toEqual(expect.arrayContaining(["ecm", "gp", "z3"]));
    expect(manifest.profiles.core.commands.misc).toEqual(
      expect.arrayContaining(["pickora", "sox", "steghide", "tesseract"]),
    );
    expect(manifest.profiles.core.pythonModules).toEqual(
      expect.arrayContaining(["cysignals", "fpylll", "mmh3", "ortools", "pickora"]),
    );
    expect(verifier).toContain('export PATH="/opt/ctf-venv/bin:${PATH}"');
    expect(verifier).toContain("LLL.reduction(matrix)");
    expect(verifier).toContain("cp_model.CpModel()");
    expect(dockerfile).toContain("verify-core-tools.sh");
  });

  it("keeps the opt-in heavy profile pinned and smoke-checked", async () => {
    const [installer, manifestSource, requirements, verifier, dockerfile] = await Promise.all([
      readFile("tools/ctf/install-heavy.sh", "utf8"),
      readFile("tools/ctf/capabilities.json", "utf8"),
      readFile("tools/ctf/requirements-heavy.txt", "utf8"),
      readFile("tools/ctf/verify-heavy-tools.sh", "utf8"),
      readFile("Dockerfile.ctf-sandbox", "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      profiles: {
        heavy: {
          commands: string[];
          sources: Array<{ name: string; commit: string; license: string }>;
          manual: string[];
        };
      };
    };
    const commits = Object.fromEntries(manifest.profiles.heavy.sources.map((source) => [source.name, source.commit]));

    expect(manifest.profiles.heavy.commands).toEqual(
      expect.arrayContaining(["RsaCtfTool", "cado-nfs", "flatter", "r2", "sage", "stegseek"]),
    );
    expect(manifest.profiles.heavy.manual).toContain("Ghidra");
    expect(manifest.profiles.heavy.manual).not.toContain("SageMath");
    expect(manifest.profiles.heavy.sources.every((source) => /^[a-f0-9]{40}$/.test(source.commit))).toBe(true);
    expect(manifest.profiles.heavy.sources.every((source) => source.license.length > 0)).toBe(true);
    for (const commit of Object.values(commits)) expect(installer).toContain(commit);
    expect(installer).toContain("fetch_pinned_repo");
    expect(installer).toContain("sagemath");
    expect(installer).toContain("--no-deps /opt/RsaCtfTool");
    expect(installer).toContain("https://download.pytorch.org/whl/cpu");
    expect(installer).toContain("torch==2.9.0");
    expect(installer).toContain("/usr/share/doc/xuanshu-heavy/stegseek-COPYING");
    expect(requirements).toContain("r2pipe==1.9.8");
    expect(verifier).toContain("sage -c");
    expect(verifier).toContain("RsaCtfTool --help");
    expect(verifier).toContain("cado-nfs --help");
    expect(verifier).toContain("stegseek --version");
    expect(verifier).toContain("/opt/cado-nfs/COPYING");
    expect(dockerfile).toContain('INSTALL_HEAVY" = "true"');
    expect(dockerfile).toContain("verify-heavy-tools.sh");
  });
});
