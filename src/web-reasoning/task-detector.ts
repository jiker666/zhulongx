import type { NormalizedTask } from "../types.js";
import type { WebTaskClassification, WebTaskDetectionReason } from "./types.js";

const WEB_ATTACHMENT = /\.(html?|css|js|mjs|ts|tsx|php|jsp|aspx?|har|ya?ml|json)$/i;
const WEB_FIELD = /\b(endpoint|baseurl|request|response|cookie|header|browser|http\s+method|swagger|openapi|login|logout|submit|checkout|order|account|dashboard|transaction|transfer|purchase|sell|buy)\b/i;
const URL = /https?:\/\//i;

export function detectWebTask(task: NormalizedTask): WebTaskClassification {
  const metadata = task.metadata;
  const explicit = (metadata.category ?? "").trim().toLowerCase();
  const reasons: WebTaskDetectionReason[] = [];
  if (explicit && ["web", "web_security", "web-ctf"].includes(explicit)) {
    reasons.push({ signal: "explicit_metadata", detail: `category=${explicit}`, weight: 1 });
    return { isWeb: true, confidence: 1, reasons, source: "explicit_metadata" };
  }
  if (explicit && ["crypto", "pwn", "reverse", "forensics", "misc", "osint"].includes(explicit)) {
    return { isWeb: false, confidence: 0, reasons: [{ signal: "explicit_non_web", detail: `category=${explicit}`, weight: 1 }], source: "none" };
  }
  const text = `${task.task} ${Object.values(metadata).join(" ")}`;
  if (URL.test(text)) reasons.push({ signal: "url", detail: "An HTTP(S) URL is present", weight: 0.65 });
  if (WEB_FIELD.test(text)) reasons.push({ signal: "description", detail: "Structured Web task terminology is present", weight: 0.2 });
  const attachments = task.attachments.filter((attachment) => WEB_ATTACHMENT.test(attachment.source) || WEB_ATTACHMENT.test(attachment.summary));
  if (attachments.length > 0) reasons.push({ signal: "attachment", detail: `${attachments.length} Web-like attachment(s)`, weight: 0.25 });
  if (metadata.benchmark?.toLowerCase().includes("web") || metadata.source?.toLowerCase().includes("xbow")) reasons.push({ signal: "benchmark", detail: "Web benchmark metadata is present", weight: 0.65 });
  const confidence = Math.min(1, reasons.reduce((sum, reason) => sum + reason.weight, 0));
  const isWeb = confidence >= 0.6 && reasons.some((reason) => reason.signal === "url" || reason.signal === "benchmark" || reason.signal === "explicit_metadata");
  return { isWeb, confidence, reasons, source: reasons.length === 0 ? "none" : reasons.length === 1 ? (reasons[0]?.signal === "url" ? "url" : reasons[0]?.signal === "attachment" ? "attachment" : "description") : "combined" };
}
