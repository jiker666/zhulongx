import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { sanitizeSecrets } from "./sanitize.js";
import { validateExternalToolDescriptor, type ToolDescriptor } from "./tool-catalog.js";

export interface ExternalToolRegistration {
  descriptor: ToolDescriptor;
  tool: AgentTool<any, any>;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 12)).toString("utf8")}\n[truncated]`;
}

export function adaptExternalTool(registration: ExternalToolRegistration, maxOutputBytes: number): ExternalToolRegistration {
  const descriptor = validateExternalToolDescriptor(registration.descriptor);
  if (registration.tool.name !== descriptor.name) throw new Error("External tool descriptor and implementation names must match");
  const implementation = registration.tool;
  return {
    descriptor,
    tool: {
      ...implementation,
      executionMode: descriptor.executionMode === "serial" ? "sequential" : "parallel",
      async execute(id, params, signal, onUpdate) {
        signal?.throwIfAborted();
        const result = await implementation.execute(id, params, signal, onUpdate);
        signal?.throwIfAborted();
        const content = result.content.map((item): TextContent | ImageContent => {
          if (item.type === "text") return { ...item, text: boundedText(item.text, maxOutputBytes) };
          const approximateBytes = Math.floor(item.data.length * 3 / 4);
          if (approximateBytes > maxOutputBytes) return { type: "text", text: `[external image omitted: ${item.mimeType}, ${approximateBytes} bytes]` };
          return item;
        });
        return { ...result, content, details: sanitizeSecrets(result.details) };
      },
    },
  };
}
