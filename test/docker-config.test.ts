import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("Docker sandbox wiring", () => {
  it("builds and serves the production frontend from the API image", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const packageManifest = JSON.parse(await readFile("package.json", "utf8")) as { dependencies?: Record<string, string> };
    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS frontend-build");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("COPY --from=frontend-build /app/frontend/dist ./frontend/dist");
    expect(packageManifest.dependencies?.typescript).toBe("5.9.3");

    const compose = parse(await readFile("docker-compose.yml", "utf8")) as {
      services: Record<string, { depends_on?: Record<string, { condition?: string }>; ports?: string[] }>;
    };
    expect(compose.services.xuanshu?.depends_on?.["ctf-sandbox"]?.condition).toBe("service_healthy");
    expect(compose.services.xuanshu?.ports).toContain("127.0.0.1:${XUANSHU_PORT:-7318}:7318");
  });

  it("provides cross-platform one-click launchers with health checks", async () => {
    const [unixLauncher, windowsLauncher] = await Promise.all([
      readFile("start.command", "utf8"),
      readFile("start.bat", "utf8"),
    ]);
    expect(unixLauncher).toContain("$COMPOSE up -d --build");
    expect(unixLauncher).toContain('COMPOSE="docker-compose"');
    expect(unixLauncher).toContain('HEALTH_URL="${WEB_URL}health"');
    expect(unixLauncher).toContain("open \"$WEB_URL\"");
    expect(windowsLauncher).toContain("%COMPOSE% up -d --build");
    expect(windowsLauncher).toContain('set "COMPOSE=docker-compose"');
    expect(windowsLauncher).toContain("Invoke-WebRequest");
    expect(windowsLauncher).toContain("start \"\" \"%WEB_URL%\"");
    expect(await readFile("docs/docker-deployment.md", "utf8")).toContain("network_mode: none");
  });

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
      "gap",
      "gifsicle",
      "gmp-ecm",
      "libsox-fmt-all",
      "minimodem",
      "multimon-ng",
      "outguess",
      "pari-gp",
      "patchelf",
      "pngcheck",
      "scalpel",
      "sox",
      "steghide",
      "stegsnow",
      "tesseract-ocr",
    ];
    const expectedRequirements = [
      "cysignals==1.12.5",
      "mmh3==5.2.1",
      "ortools==9.15.6755",
      "pycosat==0.6.6",
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
      expect.arrayContaining(["cysignals", "fpylll", "mmh3", "numpy", "ortools", "pickora", "pycosat"]),
    );
    expect(verifier).toContain('export PATH="/opt/ctf-venv/bin:${PATH}"');
    expect(verifier).toContain("LLL.reduction(matrix)");
    expect(verifier).toContain("pycosat.solve");
    expect(await readFile("tools/ctf/install-local-python-core.sh", "utf8")).toContain("--target \"$SITE_PACKAGES\"");
    expect(verifier).toContain("cp_model.CpModel()");
    expect(verifier).toContain("Size(SymmetricGroup(3))");
    expect(verifier).toContain("patchelf --version");
    expect(verifier).toContain("scalpel -V");
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
          operatorManaged: Array<{ name: string; commit: string; license: string; reason: string }>;
        };
      };
    };
    const commits = Object.fromEntries(manifest.profiles.heavy.sources.map((source) => [source.name, source.commit]));

    expect(manifest.profiles.heavy.commands).toEqual(
      expect.arrayContaining(["RsaCtfTool", "cado-nfs", "flatter", "r2", "sage", "stegseek"]),
    );
    expect(manifest.profiles.heavy.manual).toContain("Ghidra");
    expect(manifest.profiles.heavy.manual).toEqual(expect.arrayContaining(["jadx", "UPX"]));
    expect(manifest.profiles.heavy.manual).not.toContain("SageMath");
    expect(manifest.profiles.heavy.operatorManaged).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "crypto-attacks", commit: "d42a3df980bf029f682f218fa2893ed2d6af98d8", license: "MIT" }),
      expect.objectContaining({ name: "cuso", commit: "unresolved", license: "unverified" }),
    ]));
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
