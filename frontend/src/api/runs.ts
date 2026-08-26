import { request } from "./client";
import type { RunReview, RunSnapshot, RunState, RunSummary, RunTrace } from "../types/api";
export const getRuns = (signal?: AbortSignal) => request<{ runs: RunSummary[] }>("/v1/runs", { signal });
export const getRun = (id: string, signal?: AbortSignal) => request<RunSnapshot>(`/v1/runs/${encodeURIComponent(id)}`, { signal });
export const getRunTrace = (id: string, signal?: AbortSignal) => request<RunTrace>(`/v1/runs/${encodeURIComponent(id)}/trace`, { signal });
export const generateRunWriteup = (id: string, signal?: AbortSignal) => request<{ writeup: string; state: RunState }>(`/v1/runs/${encodeURIComponent(id)}/writeup`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: "{}" });
export const continueRun = (id: string, mode: "fork" | "resume", input: { boundarySequence?: number; instruction?: string } = {}, signal?: AbortSignal) => request<{ id: string; status: string; statusUrl: string }>(`/v1/runs/${encodeURIComponent(id)}/${mode}`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
export const reviewRunEvent = (id: string, input: Omit<RunReview, "id" | "createdAt">, signal?: AbortSignal) => request<RunReview>(`/v1/runs/${encodeURIComponent(id)}/reviews`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
