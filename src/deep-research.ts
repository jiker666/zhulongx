import type { PolicyEngine } from "./policy.js";
import type { RunState } from "./types.js";
import { KnowledgeStore, type KnowledgeDocument, type KnowledgeTrust } from "./knowledge-store.js";

export interface ResearchFetchResult {
  url: string;
  title: string;
  mediaType: string;
  source: string;
  markdown?: string;
  citations?: string[];
}

export interface ScopedResearchFetcher {
  readonly policyControlled: true;
  fetch(url: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<ResearchFetchResult>;
}

export interface ResearchAuditEvent { type: "research.policy" | "research.fetched" | "research.ingested" | "research.failed"; url: string; allowed?: boolean; reason?: string; docId?: string; }
export interface DeepResearchLimits { maxDocuments: number; concurrency: number; maxBytesPerDocument: number; maxTotalBytes: number; }
const DEFAULT_LIMITS: DeepResearchLimits = { maxDocuments: 8, concurrency: 3, maxBytesPerDocument: 256_000, maxTotalBytes: 1_000_000 };

function simpleSummary(value: string, max = 4_000): string { return value.replace(/\s+/g, " ").trim().slice(0, max); }
function codeSnippets(value: string): string[] { return [...value.matchAll(/```[^\n]*\n([\s\S]{1,4000}?)```/g)].slice(0, 12).map((match) => match[1]!.trim()); }
function keyParameters(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter((line) => /(?:parameter|option|argument|version|requires?|input|output|complexity|modulus|dimension)/i.test(line)).slice(0, 24); }

export class DeepResearchOrchestrator {
  readonly limits: DeepResearchLimits;
  constructor(private readonly policy: PolicyEngine, private readonly state: RunState, private readonly fetcher: ScopedResearchFetcher, private readonly store: KnowledgeStore, options: Partial<DeepResearchLimits> = {}, private readonly onEvent?: (event: ResearchAuditEvent) => void | Promise<void>) {
    if (fetcher.policyControlled !== true) throw new Error("Research fetcher must be policy controlled");
    this.limits = { ...DEFAULT_LIMITS, ...options };
    if (!Number.isInteger(this.limits.concurrency) || this.limits.concurrency < 1 || this.limits.concurrency > 8) throw new Error("Research concurrency must be between 1 and 8");
  }

  async ingest(urls: string[], input: { trust?: KnowledgeTrust; signal?: AbortSignal } = {}): Promise<{ documents: KnowledgeDocument[]; failures: Array<{ url: string; reason: string }> }> {
    const unique = [...new Set(urls)].slice(0, this.limits.maxDocuments); if (urls.length > this.limits.maxDocuments) throw new Error("Research document budget exceeded");
    let next = 0; let totalBytes = 0; const documents: KnowledgeDocument[] = []; const failures: Array<{ url: string; reason: string }> = [];
    const worker = async () => {
      while (next < unique.length) {
        input.signal?.throwIfAborted(); const url = unique[next++]!;
        const decision = this.policy.evaluate("http_request", { method: "GET", url }, this.state); await this.onEvent?.({ type: "research.policy", url, allowed: decision.allowed, reason: decision.reason });
        if (!decision.allowed) { failures.push({ url, reason: decision.reason }); continue; }
        this.policy.recordAllowed("http_request", decision, this.state);
        try {
          const result = await this.fetcher.fetch(url, { maxBytes: this.limits.maxBytesPerDocument, ...(input.signal ? { signal: input.signal } : {}) });
          const bytes = Buffer.byteLength(result.source); if (bytes > this.limits.maxBytesPerDocument || totalBytes + bytes > this.limits.maxTotalBytes) throw new Error("Research response byte budget exceeded"); totalBytes += bytes;
          await this.onEvent?.({ type: "research.fetched", url });
          const document = await this.store.ingest({ sourceUrl: result.url, title: result.title, mediaType: result.mediaType, trust: input.trust ?? "untrusted", source: result.source, ...(result.markdown ? { markdown: result.markdown } : {}), summary: simpleSummary(result.markdown ?? result.source), keyParameters: keyParameters(result.markdown ?? result.source), codeSnippets: codeSnippets(result.markdown ?? result.source), ...(result.citations ? { citations: result.citations } : {}) });
          documents.push(document); await this.onEvent?.({ type: "research.ingested", url, docId: document.docId });
        } catch (error) { const reason = error instanceof Error ? error.message : String(error); failures.push({ url, reason }); await this.onEvent?.({ type: "research.failed", url, reason }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.concurrency, unique.length) }, () => worker()));
    return { documents, failures };
  }
}
