import { request } from "./client";
import type { RunSnapshot, RunSummary, RunTrace } from "../types/api";
export const getRuns = (signal?: AbortSignal) => request<{ runs: RunSummary[] }>("/v1/runs", { signal });
export const getRun = (id: string, signal?: AbortSignal) => request<RunSnapshot>(`/v1/runs/${encodeURIComponent(id)}`, { signal });
export const getRunTrace = (id: string, signal?: AbortSignal) => request<RunTrace>(`/v1/runs/${encodeURIComponent(id)}/trace`, { signal });
