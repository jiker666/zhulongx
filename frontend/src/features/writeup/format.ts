import type { ManualTaskSnapshot, RunState } from "../../types/api";

interface WriteupInput {
  task: string;
  report?: string;
  submission?: string;
  metadata?: Record<string, string>;
  finishedAt?: string;
}

function yamlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ").trim()}"`;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

function titleFrom(input: WriteupInput): string {
  const explicit = input.metadata?.challengeName ?? input.metadata?.title;
  if (explicit?.trim()) return explicit.trim();
  const reportHeading = input.report?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (reportHeading && !/^wp\b/i.test(reportHeading)) return reportHeading;
  const task = input.task.trim();
  const namedChallenge = task.match(/(?:exercise|challenge|任务|题目)\s*["“']([^"”']+)["”']/i)?.[1];
  if (namedChallenge?.trim()) return namedChallenge.trim();
  const bracketed = firstNonEmptyLine(task)?.match(/^\[[^\]]+\]\s*(.+)$/)?.[1];
  if (bracketed?.trim()) return bracketed.trim();
  const inlineBracketed = firstNonEmptyLine(task)?.match(/(\[[^\]]+\]\s*.+)$/)?.[1];
  if (inlineBracketed?.trim()) return inlineBracketed.trim();
  const firstLine = firstNonEmptyLine(task)?.replace(/^[-*]\s+/, "");
  if (firstLine && firstLine.length <= 100 && !/^authorized\b/i.test(firstLine)) return firstLine;
  const category = input.metadata?.category?.trim();
  return category ? `${category} Challenge` : "XuanShu Challenge";
}

function categoryFrom(input: WriteupInput): string {
  const category = input.metadata?.category?.trim().toLowerCase();
  if (!category) return "misc";
  const aliases: Record<string, string> = { re: "reverse", reversing: "reverse", pwnable: "pwn", pentest: "web" };
  const normalized = aliases[category] ?? category;
  return new Set(["web", "pwn", "crypto", "reverse", "forensics", "osint", "malware", "misc"]).has(normalized) ? normalized : "misc";
}

function ctfFrom(input: WriteupInput): string {
  const source = input.metadata?.ctf ?? input.metadata?.source;
  if (!source?.trim()) return "Unspecified CTF";
  return source.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateFrom(value: string | undefined): string {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function difficultyFrom(input: WriteupInput): string {
  const value = `${input.metadata?.difficulty ?? ""} ${input.task} ${input.report ?? ""}`.match(/\b(easy|medium|hard)\b/i)?.[1];
  return value?.toLowerCase() ?? "medium";
}

function pointsFrom(input: WriteupInput): string {
  if (input.metadata?.points?.trim() && /^\d+$/.test(input.metadata.points.trim())) return input.metadata.points.trim();
  const value = `${input.metadata?.points ?? ""} ${input.task} ${input.report ?? ""}`.match(/\b(?:points?|score)\s*[:=：]?\s*(\d+)\b/i)?.[1];
  return value ?? "0";
}

function flagFormat(submission: string | undefined): string {
  if (!submission) return "flag{...}";
  const open = submission.indexOf("{");
  return open > 0 ? `${submission.slice(0, open)}{...}` : "flag{...}";
}

function withoutReportMetadata(report: string, submission: string | undefined): string {
  let value = report.trim();
  value = value.replace(/^---[\s\S]*?---\s*/m, "");
  if (submission) {
    const escaped = submission.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`\\s*(?:FLAG|最终答案|Final Answer)\\s*:\\s*${escaped}`, "gim"), "");
  }
  value = value.replace(/^\s*(?:FLAG|最终答案|Final Answer)\s*:\s*.*$/gim, "");
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function sectionBody(report: string, names: string[]): string | undefined {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const lines = report.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase();
    return heading ? wanted.has(heading) : false;
  });
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join("\n").trim() || undefined;
}

function conciseSummary(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 1_200) return compact;
  const sentences = compact.split(/(?<=[.!?。！？])\s+/).filter(Boolean).slice(0, 2).join(" ");
  return (sentences || compact.slice(0, 1_200)).slice(0, 1_200);
}

function summaryFrom(input: WriteupInput, cleanReport: string): string {
  const section = sectionBody(cleanReport, ["Summary", "摘要", "结论摘要"]);
  if (section) return conciseSummary(section.replace(/\n```[\s\S]*?```/g, ""));
  const paragraph = cleanReport
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && !item.startsWith("```") && !/^\d+[.)]\s/.test(item));
  if (paragraph) return conciseSummary(paragraph);
  if (input.submission) return "The run completed with a recorded final result and the verification evidence shown below.";
  return "The run did not record a final submission. See the bounded report for the observed blocker and remaining verification gap.";
}

function solutionFrom(cleanReport: string, summary: string): string {
  const section = sectionBody(cleanReport, ["Solution", "Approach", "思路", "解题思路", "解决方案"]);
  let body = section ?? cleanReport.trim();
  body = body.replace(/^##\s+(?:Summary|摘要|结论摘要)\s*$[\s\S]*?(?=^##\s+|\s*$)/im, "").trim();
  body = body.replace(/^##\s+(?:Verification|验证|Flag|最终答案)\s*$[\s\S]*?(?=^##\s+|\s*$)/gim, "").trim();
  if (!section && summary && body.startsWith(summary)) {
    const remainder = body.slice(summary.length).trim();
    if (remainder.length > 80) body = remainder;
  }
  if (!body) body = "The public run report did not include additional solution notes.";
  if (!/^###\s+Step\s+\d+/im.test(body) && !/^\s*\d+[.)]\s+/m.test(body)) {
    body = `### Step 1: Follow the verified path\n\n${body}`;
  }
  if (!/```[\w-]*\n[\s\S]*?```/.test(body)) {
    body += "\n\n### Reproducibility\n\nNo complete solving script was persisted in the public run report, so this write-up does not fabricate commands or payloads. The result below is copied from the structured submission and bounded verification records.";
  }
  return body.slice(0, 12_000).trim();
}

export function renderWriteup(input: WriteupInput): string {
  const report = input.report?.trim() ?? "";
  const cleanReport = withoutReportMetadata(report, input.submission);
  const title = titleFrom(input);
  const summary = summaryFrom(input, cleanReport);
  const solution = solutionFrom(cleanReport, summary);
  const submission = input.submission?.trim();
  const metadata = input.metadata ?? {};
  return [
    "---",
    `title: ${yamlString(title)}`,
    `ctf: ${yamlString(ctfFrom(input))}`,
    `date: ${dateFrom(input.finishedAt)}`,
    `category: ${categoryFrom(input)}`,
    `difficulty: ${difficultyFrom(input)}`,
    `points: ${pointsFrom(input)}`,
    `flag_format: ${yamlString(flagFormat(submission))}`,
    `author: ${yamlString(metadata.author ?? "ZhuLong XuanShu")}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Solution",
    "",
    solution,
    "",
    "## Flag",
    "",
    "```",
    submission || "FLAG_NOT_OBTAINED",
    "```",
    "",
  ].join("\n");
}

export function renderRunWriteup(state: RunState, report = state.summary): string {
  const verification = state.verification?.filter((item) => item.trim()).slice(0, 8) ?? [];
  const reportWithVerification = verification.length > 0 && !/\bverification\b|验证/i.test(report ?? "")
    ? `${report ?? ""}\n\n### Verification\n${verification.map((item) => `- ${item}`).join("\n")}`
    : report;
  return renderWriteup({ task: state.task.task, report: reportWithVerification, submission: state.submission, metadata: state.task.metadata, finishedAt: state.finishedAt ?? state.updatedAt });
}

export function renderTaskWriteup(task: ManualTaskSnapshot): string | undefined {
  if (!task.writeup?.trim()) return undefined;
  return renderWriteup({ task: task.task, report: task.writeup, submission: task.submission });
}
