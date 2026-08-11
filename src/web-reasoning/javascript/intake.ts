import { createHash } from "node:crypto";
import type { JavaScriptAnalysisInput } from "./types.js";

export function createJavaScriptInput(input: Omit<JavaScriptAnalysisInput, "contentHash">): JavaScriptAnalysisInput { return { ...input, content: input.content.slice(0, input.maxBytes), contentHash: createHash("sha256").update(input.content.slice(0, input.maxBytes)).digest("hex") }; }
export function isJavaScriptLike(mediaType = "", source = ""): boolean { return /javascript|typescript|ecmascript|jsx/i.test(mediaType) || /\.(?:m?js|cjs|ts|tsx|jsx)$/i.test(source); }
