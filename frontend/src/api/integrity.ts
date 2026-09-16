import { request } from "./client";
import type { CapabilityStats, DisclosureRecord } from "../types/api";

export interface DisclosureWindow { windowDays: number; total: number; items: DisclosureRecord[]; reasonLabels: Record<string, string> }

export const getDisclosures = (windowDays = 90, signal?: AbortSignal) =>
  request<DisclosureWindow>(`/v1/disclosures?windowDays=${encodeURIComponent(windowDays)}`, { signal });

export const getCapability = (signal?: AbortSignal) =>
  request<CapabilityStats>("/v1/capability", { signal });
