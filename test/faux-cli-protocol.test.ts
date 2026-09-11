import { describe, expect, it } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { assistantStep, registerFauxCli, successResult, textBlock, toolUseBlock } from "./faux-cli.js";

// Protocol contract test: pins the stream-json stdio contract between the SDK
// and the bundled CLI shape that test/fixtures/faux-claude-cli.mjs emulates.
// If an SDK upgrade changes the protocol, this fails explicitly so the faux
// CLI gets fixed before every orchestration test silently breaks.
describe("faux CLI protocol contract", () => {
  it("drives a full SDK round trip: init, in-process MCP tool call, and result", { timeout: 30_000 }, async () => {
    const faux = await registerFauxCli([
      assistantStep([toolUseBlock("toolu_echo", "mcp__xuanshu__echo", { value: "contract" })]),
      assistantStep([textBlock("Tool executed.")]),
      successResult("Tool executed."),
    ]);
    const toolCalls: Array<{ id: string; args: unknown }> = [];
    const server = createSdkMcpServer({
      name: "xuanshu",
      version: "1.0.0",
      alwaysLoad: true,
      tools: [{
        name: "echo",
        description: "Echo a value",
        inputSchema: { value: z.string() },
        handler: async (args: unknown, extra: unknown) => {
          const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
          toolCalls.push({ id: String(meta?.["claudecode/toolUseId"] ?? "missing"), args });
          return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
        },
      }],
    });
    const messages: Array<Record<string, unknown>> = [];
    try {
      const q = query({
        prompt: "Run the echo tool.",
        options: {
          pathToClaudeCodeExecutable: faux.executablePath,
          settingSources: [],
          permissionMode: "dontAsk",
          tools: [],
          allowedTools: ["mcp__xuanshu__*"],
          mcpServers: { xuanshu: server },
          systemPrompt: "You are a test agent.",
          includePartialMessages: false,
          persistSession: false,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
            ANTHROPIC_AUTH_TOKEN: "faux-placeholder",
            ANTHROPIC_MODEL: "faux-model",
            ANTHROPIC_DEFAULT_OPUS_MODEL: "faux-model",
            ANTHROPIC_DEFAULT_SONNET_MODEL: "faux-model",
            ANTHROPIC_DEFAULT_HAIKU_MODEL: "faux-model",
            XUANSHU_FAUX_CLI_SCRIPT: faux.scriptPath,
            XUANSHU_FAUX_CLI_LOG: faux.logPath,
          } as Record<string, string>,
        },
      });
      for await (const message of q) {
        messages.push(message as unknown as Record<string, unknown>);
      }
      q.close();
    } finally {
      await faux.cleanup();
    }

    const init = messages.find((message) => message.type === "system" && message.subtype === "init");
    expect(init).toBeDefined();
    expect(init!.tools).toContain("mcp__xuanshu__echo");
    const toolUse = messages.find((message) => message.type === "assistant"
      && (message.message as { content?: Array<{ type?: string }> }).content?.some((block) => block.type === "tool_use"));
    expect(toolUse).toBeDefined();
    // The in-process MCP tool really executed with the scripted tool_use id.
    expect(toolCalls).toEqual([{ id: "toolu_echo", args: { value: "contract" } }]);
    const toolResult = messages.find((message) => message.type === "user"
      && (message.message as { content?: Array<{ type?: string; content?: unknown }> }).content?.some((block) => block.type === "tool_result"));
    expect(toolResult).toBeDefined();
    const result = messages.filter((message) => message.type === "result").at(-1);
    expect(result).toMatchObject({ subtype: "success", result: "Tool executed." });
  });
});
