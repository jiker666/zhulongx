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
});
