import { useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleStop, Copy, Database, Download, ExternalLink, FileText, Paperclip, Play, Send, Upload, Users, X } from "lucide-react";
import { Link } from "react-router-dom";
import { getManualJobs, getQuestionBank, startManualJob, startQuestionBankJob, stopManualJob, uploadManualFiles } from "../api/operations";
import { Badge, Button, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";
import { renderTaskWriteup } from "../features/writeup/format";
import type { ManualJobSnapshot, ManualTaskStatus } from "../types/api";

const activeStatuses = new Set(["queued", "running", "stopping"]);
const terminalTaskStatuses = new Set<ManualTaskStatus>(["completed", "blocked", "skipped", "failed", "aborted"]);
const jobStatusLabels: Record<string, string> = { queued: "排队中", running: "运行中", stopping: "正在停止", completed: "已完成", aborted: "已中止" };
const taskStatusLabels: Record<ManualTaskStatus, string> = { queued: "排队", running: "运行", completed: "完成", blocked: "受阻", skipped: "跳过", failed: "失败", aborted: "中止" };

function parseTasks(value: string): string[] {
  return value.split(/^\s*---\s*$/m).map((task) => task.trim()).filter(Boolean);
}

function taskTone(status: ManualTaskStatus): string {
  if (status === "completed") return "completed";
  if (status === "running" || status === "queued") return "running";
  if (status === "blocked" || status === "skipped") return "blocked";
  return "failed";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function boundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function mergeFiles(current: File[], selected: File[]): File[] {
  const seen = new Set<string>();
  return [...current, ...selected].filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

function downloadWriteup(writeup: string, jobId: string, taskIndex: number): void {
  const blob = new Blob([writeup], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `xuan-shu-${safeFilePart(jobId)}-task-${String(taskIndex + 1).padStart(2, "0")}-wp.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function JobResult({ job, onStop, stopping }: { job: ManualJobSnapshot; onStop: (id: string) => void; stopping: boolean }) {
  const [copied, setCopied] = useState<string>();
  const settled = job.tasks.filter((task) => terminalTaskStatuses.has(task.status)).length;
  const progress = job.total ? Math.round((settled / job.total) * 100) : 0;
  const active = activeStatuses.has(job.status);
  const copy = async (value: string, key: string) => { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(undefined), 1_200); };
  return (
    <article className="surface-panel manual-job-panel">
      <div className="manual-job-header">
        <div><span className="section-label">BATCH / {job.id.slice(0, 8)}</span><h3>{jobStatusLabels[job.status] ?? job.status}</h3><p>{formatDateTime(job.createdAt)} · 并发 {job.concurrency} · 每项 {job.raceAgents} Agent{job.writeup ? " · 生成报告" : ""}</p></div>
        <div className="manual-job-operations"><div className="job-progress-value"><strong>{settled}</strong><span>/{job.total}</span></div>{active && <Button className="button danger-button compact-action" loading={stopping} onClick={() => onStop(job.id)}><CircleStop size={14} aria-hidden="true" />停止</Button>}</div>
      </div>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="manual-task-list">
        {job.tasks.map((task) => {
          const key = `${job.id}-${task.index}`;
          const formattedWriteup = renderTaskWriteup(task);
          return <div className="manual-task-row" key={key}><span className="manual-task-index">{String(task.index + 1).padStart(2, "0")}</span><span className="manual-task-copy"><strong>{task.task}</strong><small>{task.race ? `${task.race.agentCount} Agent 竞速${task.race.winnerAgent === undefined ? "" : ` · Agent ${task.race.winnerAgent + 1} 胜出`}` : task.run ? `${task.run.turns} 回合 · ${task.run.toolCalls} 工具调用` : "等待运行"}</small>{task.error && <em>{task.error}</em>}{task.submission && <span className="submission-result"><span>结果</span><code>{task.submission}</code><IconButton className="icon-button" label="复制结果" onClick={() => void copy(task.submission!, `${key}-submission`)}>{copied === `${key}-submission` ? <Check size={15} /> : <Copy size={15} />}</IconButton></span>}{formattedWriteup && <details className="writeup-result"><summary><FileText size={14} />任务报告</summary><div className="writeup-toolbar"><IconButton className="icon-button bordered" label="复制任务报告" onClick={() => void copy(formattedWriteup, `${key}-report`)}>{copied === `${key}-report` ? <Check size={15} /> : <Copy size={15} />}</IconButton><Button className="button secondary compact-action" type="button" onClick={() => downloadWriteup(formattedWriteup, job.id, task.index)}><Download size={14} aria-hidden="true" />下载 WP</Button></div><pre>{formattedWriteup}</pre></details>}</span><span className="manual-task-actions"><Badge tone={taskTone(task.status)}>{taskStatusLabels[task.status]}</Badge>{task.runId && <Link className="icon-link" to={`/runs/${task.runId}`} title="查看运行轨迹" aria-label="查看运行轨迹"><ExternalLink size={15} /></Link>}</span></div>;
        })}
      </div>
    </article>
  );
}

export function WorkbenchPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const submissionController = useRef<AbortController | undefined>(undefined);
  const [taskText, setTaskText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [concurrency, setConcurrency] = useState(1);
  const [raceAgents, setRaceAgents] = useState(1);
  const [writeup, setWriteup] = useState(true);
  const [formError, setFormError] = useState("");

  const jobs = useQuery({ queryKey: ["manual-jobs"], queryFn: ({ signal }) => getManualJobs(signal), refetchInterval: (query) => (query.state.data?.jobs.some((job) => activeStatuses.has(job.status)) ? 2_000 : 8_000) });
  const bank = useQuery({ queryKey: ["question-bank"], queryFn: ({ signal }) => getQuestionBank(signal), refetchInterval: 8_000 });
  const activeJobs = jobs.data?.jobs.filter((job) => activeStatuses.has(job.status)) ?? [];
  const parsedTasks = useMemo(() => parseTasks(taskText), [taskText]);
  const totalFileBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const submissionIssue = !parsedTasks.length ? "请输入至少一项任务" : parsedTasks.length > 20 ? "单批最多 20 项任务" : files.length > 20 ? "单批最多 20 个附件" : files.some((file) => file.size > 100 * 1024 * 1024) ? "存在超过 100 MiB 的附件" : totalFileBytes > 200 * 1024 * 1024 ? "附件总量不能超过 200 MiB" : "";

  const submitJob = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      submissionController.current = controller;
      const tasks = parsedTasks;
      if (!tasks.length) throw new Error("请先输入至少一项任务");
      if (tasks.length > 20) throw new Error("单批最多提交 20 项任务");
      if (files.length > 20) throw new Error("单批最多上传 20 个附件");
      if (files.some((file) => file.size > 100 * 1024 * 1024)) throw new Error("单个附件不能超过 100 MiB");
      if (files.reduce((sum, file) => sum + file.size, 0) > 200 * 1024 * 1024) throw new Error("附件总量不能超过 200 MiB");
      const upload = files.length ? await uploadManualFiles(files, controller.signal) : undefined;
      return await startManualJob({ tasks, concurrency, raceAgents, writeup, ...(upload ? { uploadId: upload.id } : {}) }, controller.signal);
    },
    onSuccess: () => { setTaskText(""); setFiles([]); if (fileInput.current) fileInput.current.value = ""; setFormError(""); void queryClient.invalidateQueries({ queryKey: ["manual-jobs"] }); },
    onError: (error) => setFormError(error.message),
    onSettled: () => { submissionController.current = undefined; },
  });
  const stop = useMutation({ mutationFn: (id: string) => stopManualJob(id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["manual-jobs"] }) });
  const startBank = useMutation({ mutationFn: () => startQuestionBankJob(writeup), onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["manual-jobs"] }); void queryClient.invalidateQueries({ queryKey: ["question-bank"] }); } });

  const submit = (event: FormEvent) => { event.preventDefault(); setFormError(""); submitJob.mutate(); };
  const questionBank = bank.data?.questionBank;
  const solvedCount = questionBank?.solvedCount ?? 0;
  const pendingCount = questionBank?.pendingCount ?? questionBank?.count ?? 0;
  const progress = questionBank?.count ? Math.round((solvedCount / questionBank.count) * 100) : 0;

  if (jobs.isPending && bank.isPending) return <LoadingState label="正在读取任务工作台…" />;
  if (jobs.isError) return <ErrorState message={jobs.error.message} onRetry={() => void jobs.refetch()} />;

  return (
    <div className="page workbench-page">
      <div className="page-heading">
        <div><div className="eyebrow">HUMAN + AGENT</div><h1>任务工作台</h1><p>组织安全任务、附件、并发批次与 operator 配置的本地任务集。</p></div>
        <div className="heading-actions"><span className={`active-job-count ${activeJobs.length ? "active" : ""}`}><Users size={15} aria-hidden="true" />{activeJobs.length ? `${activeJobs.length} 个活动批次` : "当前无活动批次"}</span></div>
      </div>

      <div className="workbench-grid">
        <form className="surface-panel task-composer" onSubmit={submit}>
          <div className="panel-heading"><div><span className="section-label">TASK INTAKE</span><h2>提交安全任务</h2></div><span className={`task-count ${parsedTasks.length > 20 ? "over-limit" : ""}`}>{parsedTasks.length}/20</span></div>
          <textarea value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="输入开放式安全任务；多项任务之间用单独一行 --- 分隔" aria-label="任务内容" />
          <div className="attachment-zone">
            <div><Paperclip size={17} aria-hidden="true" /><span><strong>任务附件</strong><small>{files.length ? `${files.length} 个文件 · ${formatBytes(totalFileBytes)}` : "文本、压缩包、接口文档、图片或二进制材料"}</small></span></div>
            <label className="button secondary file-button"><Upload size={15} aria-hidden="true" />添加文件<input ref={fileInput} type="file" multiple onChange={(event) => { setFiles((current) => mergeFiles(current, [...event.target.files ?? []])); event.target.value = ""; }} /></label>
          </div>
          {files.length > 0 && <div className="file-chip-list">{files.map((file, index) => <span key={`${file.name}-${file.size}-${index}`}>{file.name}<small>{formatBytes(file.size)}</small><button type="button" aria-label={`移除 ${file.name}`} title={`移除 ${file.name}`} onClick={() => setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>}
          <div className="composer-settings">
            <label><span className="field-label">批次并发</span><input type="number" min={1} max={8} value={concurrency} onChange={(event) => setConcurrency(boundedInteger(event.target.value, concurrency, 1, 8))} /></label>
            <label><span className="field-label">每项 Agent</span><input type="number" min={1} max={8} value={raceAgents} onChange={(event) => setRaceAgents(boundedInteger(event.target.value, raceAgents, 1, 8))} /></label>
            <label className="toggle-control"><span><strong>生成报告</strong><small>输出可复核结论</small></span><input type="checkbox" checked={writeup} onChange={(event) => setWriteup(event.target.checked)} /></label>
            <div className="submit-control">{submitJob.isPending ? <Button className="button danger-button" type="button" onClick={() => submissionController.current?.abort()}><CircleStop size={15} aria-hidden="true" />取消提交</Button> : <Button className="button submit-task-button" type="submit" disabled={Boolean(submissionIssue)} disabledReason={submissionIssue}><Send size={16} aria-hidden="true" />提交任务</Button>}</div>
          </div>
          <div className={`composer-validation ${submissionIssue && taskText.trim() ? "invalid" : ""}`}>{submissionIssue && taskText.trim() ? submissionIssue : `${parsedTasks.length || 0} 项任务 · ${files.length} 个附件 · 最大 8 并发`}</div>
          {formError && <div className="inline-error">{formError}</div>}
        </form>

        <section className="surface-panel question-bank-panel">
          <div className="panel-heading"><div><span className="section-label">LOCAL CORPUS</span><h2>本地任务集</h2></div><Database size={19} aria-hidden="true" /></div>
          {bank.isError ? <ErrorState message={bank.error.message} onRetry={() => void bank.refetch()} /> : questionBank ? <>
            <div className="bank-summary"><div><strong>{solvedCount}<span>/{questionBank.count}</span></strong><small>已完成</small></div><div className="bank-progress-copy"><span>{progress}%</span><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><small>{pendingCount} 项待处理</small></div></div>
            <Button className="button question-bank-action" disabled={!questionBank.configured || pendingCount === 0 || activeJobs.length > 0} loading={startBank.isPending} onClick={() => startBank.mutate()} disabledReason={!questionBank.configured ? questionBank.error ?? "任务集未配置" : pendingCount === 0 ? "任务集已全部完成" : activeJobs.length > 0 ? "已有批次正在运行" : undefined}>{pendingCount ? <><Play size={16} aria-hidden="true" />处理未完成任务</> : <><Check size={16} aria-hidden="true" />已全部完成</>}</Button>
            {startBank.error && <div className="inline-error">{startBank.error.message}</div>}
            <div className="question-list">{questionBank.questions?.map((question) => <div className="question-row" key={question.id}><span className={`question-status-mark ${question.status}`} aria-hidden="true" /><span><strong>{question.title}</strong><small>{question.category.toUpperCase()} · {question.attachmentCount} 个附件{question.instanceAvailable ? " · 可启动实例" : ""}</small></span><Badge tone={question.status === "solved" ? "completed" : "neutral"}>{question.status === "solved" ? "已完成" : "待处理"}</Badge></div>)}</div>
          </> : <LoadingState />}
        </section>
      </div>

      <section className="batch-section">
        <div className="section-heading-row"><div><span className="section-label">BATCH HISTORY</span><h2>批量作业</h2></div><span>{jobs.data?.jobs.length ?? 0} 个批次</span></div>
        {jobs.data?.jobs.length ? <div className="manual-job-list">{jobs.data.jobs.map((job) => <JobResult key={job.id} job={job} onStop={(id) => stop.mutate(id)} stopping={stop.isPending && stop.variables === job.id} />)}</div> : <EmptyState title="尚无批量作业" description="提交任务或启动本地任务集后，执行状态会显示在这里。" />}
        {stop.error && <div className="inline-error" role="alert">{stop.error.message}</div>}
      </section>
    </div>
  );
}
