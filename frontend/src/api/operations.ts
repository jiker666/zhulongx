import { apiURL, authorizedHeaders, request } from "./client";
import type {
  ManualJobSnapshot,
  ManualUploadSnapshot,
  QuestionBankSnapshot,
  AdaptiveCampaignSnapshot,
} from "../types/api";

const jsonHeaders = { "content-type": "application/json" };

export const getManualJobs = (signal?: AbortSignal) => request<{ jobs: ManualJobSnapshot[] }>("/v1/manual/jobs", { signal });
export const startManualJob = (input: { tasks: string[]; concurrency: number; raceAgents: number; writeup: boolean; uploadId?: string }, signal?: AbortSignal) => request<{ job: ManualJobSnapshot }>("/v1/manual/jobs", { method: "POST", signal, headers: jsonHeaders, body: JSON.stringify(input) });
export const stopManualJob = (id: string, signal?: AbortSignal) => request<{ job: ManualJobSnapshot }>(`/v1/manual/jobs/${encodeURIComponent(id)}/stop`, { method: "POST", signal, headers: jsonHeaders, body: "{}" });

export const getQuestionBank = (signal?: AbortSignal) => request<{ questionBank: QuestionBankSnapshot }>("/v1/question-bank", { signal });
export const startQuestionBankJob = (writeup: boolean, signal?: AbortSignal) => request<{ job: ManualJobSnapshot }>("/v1/question-bank/jobs", { method: "POST", signal, headers: jsonHeaders, body: JSON.stringify({ writeup }) });
export const getCampaigns = (signal?: AbortSignal) => request<{ campaigns: AdaptiveCampaignSnapshot[] }>("/v1/campaigns", { signal });
export const startCampaign = (input: { name?: string; tasks: string[]; concurrency: number; raceAgents: number }, signal?: AbortSignal) => request<{ campaign: AdaptiveCampaignSnapshot }>("/v1/campaigns", { method: "POST", signal, headers: jsonHeaders, body: JSON.stringify(input) });
export const stopCampaign = (id: string, signal?: AbortSignal) => request<{ campaign: AdaptiveCampaignSnapshot }>(`/v1/campaigns/${encodeURIComponent(id)}/stop`, { method: "POST", signal, headers: jsonHeaders, body: "{}" });

export async function uploadManualFiles(files: File[], signal?: AbortSignal): Promise<ManualUploadSnapshot> {
  let upload: ManualUploadSnapshot | undefined;
  for (const file of files) {
    const response = await fetch(apiURL("/v1/manual/uploads"), {
      method: "POST",
      signal,
      headers: {
        ...authorizedHeaders(),
        "x-file-name": encodeURIComponent(file.name),
        ...(upload ? { "x-upload-id": upload.id } : {}),
      },
      body: file,
    });
    const body = await response.json() as { upload?: ManualUploadSnapshot; error?: string };
    if (response.status === 401) window.dispatchEvent(new Event("xuanshu:unauthorized"));
    if (!response.ok || !body.upload) throw new Error(body.error ?? `附件上传失败（HTTP ${response.status}）`);
    upload = body.upload;
  }
  if (!upload) throw new Error("没有可上传的附件");
  return upload;
}
