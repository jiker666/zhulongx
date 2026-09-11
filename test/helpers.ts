import type { AppConfig } from "../src/types.js";

export function testConfig(root: string): AppConfig {
  return {
    model: {
      provider: "faux",
      id: "faux-1",
      name: "Faux Model",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnv: "XUANSHU_TEST_API_KEY",
      contextWindow: 32_000,
    },
    runtime: {
      thinkingLevel: "off",
      artifactRoot: `${root}/runs`,
      scratchRoot: `${root}/scratch`,
      maxTurns: 20,
      maxToolCalls: 30,
      maxRuntimeMs: 10_000,
      maxConcurrentSdkSessions: 4,
      modelMinIntervalMs: 0,
      modelRequestsPerMinute: 0,
      modelTokensPerMinute: 0,
      modelMaxRetryDelayMs: 120_000,
      maxActionsWithoutCheckpoint: 2,
      maxRepeatedAction: 2,
      maxOutputBytes: 16_384,
      maxImageBytes: 256 * 1024,
      maxImageObservations: 2,
      maxScratchFileBytes: 64 * 1024,
      finalizationReserveMs: 1000,
      commandTimeoutMs: 2000,
      httpTimeoutMs: 2000,
      maxHttpRequests: 3,
      maxTcpSessions: 2,
      maxTcpBytes: 16_384,
      sandbox: {
        socketPath: `${root}/sandbox.sock`,
        connectTimeoutMs: 500,
      },
    },
    scope: {
      mode: "observe",
      workspaceRoot: `${root}/workspace`,
      allowedHosts: [],
      allowedPrograms: ["file", "rg"],
    },
    server: { host: "127.0.0.1", port: 0, tokenEnv: "XUANSHU_TEST_SERVER_TOKEN" },
  };
}
