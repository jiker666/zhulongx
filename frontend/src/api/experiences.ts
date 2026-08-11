import { request } from "./client";
import type { Experience } from "../types/api";
export const getExperiences = (signal?: AbortSignal) => request<{ experiences: Experience[] }>("/v1/experiences", { signal });
export const updateExperience = (id: string, input: { status: Experience["status"]; reviewNote?: string }, signal?: AbortSignal) => request<Experience>(`/v1/experiences/${encodeURIComponent(id)}`, { method: "PATCH", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
