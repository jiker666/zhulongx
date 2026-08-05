import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer } from "../src/server.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.XUANSHU_TEST_SERVER_TOKEN;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("REST API", () => {
  it("exposes public health and protects run endpoints when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-server-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    process.env.XUANSHU_TEST_SERVER_TOKEN = "test-token";
    const running = await startApiServer(config);
    try {
      const health = await fetch(`${running.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: "zhulong-xuanshu" });

      const dashboard = await fetch(`${running.url}/`);
      expect(dashboard.status).toBe(200);
      const dashboardSource = await dashboard.text();
      expect(dashboardSource).toContain("决策审计台");
      const scriptStart = dashboardSource.lastIndexOf("<script>") + "<script>".length;
      const scriptEnd = dashboardSource.indexOf("</script>", scriptStart);
      expect(() => new Function(dashboardSource.slice(scriptStart, scriptEnd))).not.toThrow();

      const unauthorized = await fetch(`${running.url}/v1/runs/missing`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await running.close();
    }
  });
});
