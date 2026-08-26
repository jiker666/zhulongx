import { request } from "./client";
import type { EvaluationAttempt, EvaluationManifest, EvaluationReport } from "../types/api";

export const getEvaluationManifests = (signal?: AbortSignal) => request<{ manifests: EvaluationManifest[] }>("/v1/evaluations", { signal });
export const getEvaluation = (id: string, signal?: AbortSignal) => request<{ report: EvaluationReport; attempts: EvaluationAttempt[] }>(`/v1/evaluations/${encodeURIComponent(id)}`, { signal });
