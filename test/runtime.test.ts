import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
  type FauxProviderRegistration,
} from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../src/audit.js";
import { createModel, XuanShuRuntime } from "../src/runtime.js";
import { readAuditRecords } from "../src/trace.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];
const registrations: FauxProviderRegistration[] = [];

afterEach(async () => {
  while (registrations.length > 0) registrations.pop()?.unregister();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("XuanShuRuntime", () => {
  it("preserves xhigh reasoning for Responses-compatible models", () => {
    const config = testConfig("/tmp/xuan-responses-model");
    config.model.api = "openai-responses";
    config.model.reasoning = true;

    const model = createModel(config.model);

    expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(getSupportedThinkingLevels(model)).toContain("xhigh");
  });

  it("sends Responses requests to the configured base URL with storage disabled", async () => {
    const config = testConfig("/tmp/xuan-responses-payload");
    config.model = {
      ...config.model,
      provider: "test-openai",
      id: "test-responses-model",
      api: "openai-responses",
      baseUrl: "https://gateway.example.invalid",
      reasoning: true,
    };
    const model = createModel(config.model) as Model<"openai-responses">;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const captureFetch: typeof fetch = async (input, init) => {
      requestUrl = input instanceof Request ? input.url : String(input);
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      requestBody = JSON.parse(String(body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ error: { message: "captured by unit test" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };

    const message = await streamOpenAIResponses(
      model,
      {
        systemPrompt: "Reply with pong.",
        messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
        tools: [],
      },
      {
        apiKey: "unit-test-only",
        reasoning: "xhigh",
        fetch: captureFetch,
        maxRetries: 0,
      },
    ).result();

    expect(message.stopReason).toBe("error");
    expect(requestUrl).toBe("https://gateway.example.invalid/responses");
    expect(requestBody).toMatchObject({
      model: "test-responses-model",
      stream: true,
      store: false,
      reasoning: { effort: "xhigh", summary: "auto" },
    });
  });

  it("runs a deterministic plan-observe-reflect-report loop on Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-runtime-"));
    roots.push(root);
    const config = testConfig(root);
    await mkdir(config.scope.workspaceRoot, { recursive: true });
    await writeFile(join(config.scope.workspaceRoot, "sample.txt"), "service=demo\nstatus=healthy\n", "utf8");

    const faux = registerFauxProvider();
    registrations.push(faux);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "submit_plan",
          {
            goal: "Inspect the supplied workspace without assumptions",
            assumptions: ["The workspace is authorized"],
            hypotheses: ["The sample contains useful service metadata"],
            steps: [
              {
                id: "inspect",
                objective: "Triage the supplied artifact",
                successCriteria: ["Artifact properties observed"],
                tools: ["inspect_artifact"],
              },
            ],
          },
          { id: "plan-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("inspect_artifact", { source: "workspace", path: "sample.txt" }, { id: "inspect-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall(
          "checkpoint",
          {
            observations: ["sample.txt exists"],
            assessment: "The input is available for bounded inspection",
            planChanges: [],
            nextAction: "Record the verified operational observation",
            hypotheses: [{
              hypothesis: "The sample contains useful service metadata",
              status: "supported",
              evidence: ["inspect_artifact recovered printable service metadata"],
            }],
          },
          { id: "checkpoint-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "record_finding",
          {
            title: "Sample evidence discovered",
            severity: "info",
            confidence: 0.95,
            description: "The authorized workspace contains sample.txt.",
            evidence: ["list_files returned sample.txt"],
            remediation: "No remediation required",
          },
          { id: "finding-1" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          "finish_task",
          {
            status: "completed",
            summary: "已完成授权工作区的证据驱动检查。",
            evidence: ["sample.txt"],
            remainingRisks: ["未执行网络操作"],
            nextSteps: [],
            confidence: 0.95,
            verification: ["list_files independently confirmed sample.txt"],
            independentlyVerified: true,
          },
          { id: "finish-1" },
        ),
        { stopReason: "toolUse" },
      ),
    ]);

    const runtime = new XuanShuRuntime(config, { streamFn: streamSimple, model: faux.getModel() });
    const state = await runtime.run({ task: "独立检查工作区并给出有证据的结论" });

    expect(state.status).toBe("completed");
    expect(state.plan?.steps).toHaveLength(1);
    expect(state.findings).toHaveLength(1);
    expect(state.lessons).toEqual([]);
    expect(state.hypotheses).toMatchObject([{
      statement: "The sample contains useful service metadata",
      status: "supported",
    }]);
    expect(state.scratchRoot).toBe(join(config.runtime.scratchRoot, "runs", state.id));
    expect(state.sandboxNamespace).toBe(state.id);
    expect(state.toolCalls).toBe(5);
    expect(state.summary).toContain("证据驱动检查");
    const auditPath = join(config.runtime.artifactRoot, state.id, "audit.jsonl");
    expect(await verifyAuditChain(auditPath)).toMatchObject({
      valid: true,
    });
    expect(JSON.stringify(await readAuditRecords(auditPath))).toContain("printableRatio");
  });
});
