import { request } from "./client";
import type { Experience } from "../types/api";
export const getExperiences = (signal?: AbortSignal) => request<{ experiences: Experience[] }>("/v1/experiences", { signal });
