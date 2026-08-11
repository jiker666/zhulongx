import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleStop, Copy, Database, ExternalLink, FileText, Paperclip, Play, Send, Upload, Users, X } from "lucide-react";
import { Link } from "react-router-dom";
import { getManualJobs, getQuestionBank, startManualJob, startQuestionBankJob, stopManualJob, uploadManualFiles } from "../api/operations";
import { Badge, Button, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";
import type { ManualJobSnapshot, ManualTaskStatus } from "../types/api";

const activeStatuses = new Set(["queued", "running", "stopping"]);
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

function JobResult({ job }: { job: ManualJobSnapshot }) {
  const [copied, setCopied] = useState<string>();
  const progress = job.total ? Math.round(((job.completed + job.skipped + job.failed) / job.total) * 100) : 0;
  const copy = async (value: string, key: string) => { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(undefined), 1_200); };
  return (
    <article className="surface-panel manual-job-panel">
      <div className="manual-job-header">
        <div><span className="section-label">BATCH / {job.id.slice(0, 8)}</span><h3>{jobStatusLabels[job.status] ?? job.status}</h3><p>{formatDateTime(job.createdAt)} · 并发 {job.concurrency} · 每题 {job.raceAgents} Agent{job.writeup ? " · 生成 WP" : ""}</p></div>
        <div className="job-progress-value"><strong>{job.completed + job.skipped + job.failed}</strong><span>/{job.total}</span></div>
      </div>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="manual-task-list">
        {job.tasks.map((task) => {
          const key = `${job.id}-${task.index}`;
          return <div className="manual-task-row" key={key}><span className="manual-task-index">{String(task.index + 1).padStart(2, "0")}</span><span className="manual-task-copy"><strong>{task.task}</strong><small>{task.race ? `${task.race.agentCount} Agent 竞速${task.race.winnerAgent === undefined ? "" : ` · Agent ${task.race.winnerAgent + 1} 胜出`}` : task.run ? `${task.run.turns} 回合 · ${task.run.toolCalls} 工具调用` : "等待运行"}</small>{task.error && <em>{task.error}</em>}{task.flag && <span className="flag-result"><span>FLAG</span><code>{task.flag}</code><IconButton className="icon-button" label="复制 FLAG" onClick={() => void copy(task.flag!, `${key}-flag`)}>{copied === `${key}-flag` ? <Check size={15} /> : <Copy size={15} />}</IconButton></span>}{task.writeup && <details className="writeup-result"><summary><FileText size={14} />解题报告</summary><div className="writeup-toolbar"><IconButton className="icon-button bordered" label="复制解题报告" onClick={() => void copy(task.writeup!, `${key}-wp`)}>{copied === `${key}-wp` ? <Check size={15} /> : <Copy size={15} />}</IconButton></div><pre>{task.writeup}</pre></details>}</span><span className="manual-task-actions"><Badge tone={taskTone(task.status)}>{taskStatusLabels[task.status]}</Badge>{task.runId && <Link className="icon-link" to={`/runs/${task.runId}`} title="查看运行轨迹" aria-label="查看运行轨迹"><ExternalLink size={15} /></Link>}</span></div>;
        })}
      </div>
    </article>
  );
}

export function WorkbenchPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [taskText, setTaskText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [concurrency, setConcurrency] = useState(1);
  const [raceAgents, setRaceAgents] = useState(1);
  const [writeup, setWriteup] = useState(true);
  const [formError, setFormError] = useState("");

  const jobs = useQuery({ queryKey: ["manual-jobs"], queryFn: ({ signal }) => getManualJobs(signal), refetchInterval: (query) => (query.state.data?.jobs.some((job) => activeStatuses.has(job.status)) ? 2_000 : 8_000) });
  const bank = useQuery({ queryKey: ["question-bank"], queryFn: ({ signal }) => getQuestionBank(signal), refetchInterval: 8_000 });
  const activeJob = jobs.data?.jobs.find((job) => activeStatuses.has(job.status));

  const submitJob = useMutation({
    mutationFn: async () => {
      const tasks = parseTasks(taskText);
      if (!tasks.length) throw new Error("请先输入至少一项任务");
      if (tasks.length > 20) throw new Error("单批最多提交 20 项任务");
      if (files.length > 20) throw new Error("单批最多上传 20 个附件");
      if (files.some((file) => file.size > 100 * 1024 * 1024)) throw new Error("单个附件不能超过 100 MiB");
      if (files.reduce((sum, file) => sum + file.size, 0) > 200 * 1024 * 1024) throw new Error("附件总量不能超过 200 MiB");
      const upload = files.length ? await uploadManualFiles(files) : undefined;
      return await startManualJob({ tasks, concurrency, raceAgents, writeup, ...(upload ? { uploadId: upload.id } : {}) });
    },
    onSuccess: () => { setTaskText(""); setFiles([]); if (fileInput.current) fileInput.current.value = ""; setFormError(""); void queryClient.invalidateQueries({ queryKey: ["manual-jobs"] }); },
    onError: (error) => setFormError(error.message),
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
        <div><div className="eyebrow">HUMAN + AGENT</div><h1>任务工作台</h1><p>组织手工任务、附件、并发批次与本地题库评测。</p></div>
        {activeJob && <Button className="button danger-button" onClick={() => stop.mutate(activeJob.id)} loading={stop.isPending}><CircleStop size={16} aria-hidden="true" />停止当前批次</Button>}
      </div>

      <div className="workbench-grid">
        <form className="surface-panel task-composer" onSubmit={submit}>
          <div className="panel-heading"><div><span className="section-label">TASK INTAKE</span><h2>提交安全任务</h2></div><span className="task-count">{parseTasks(taskText).length}/20</span></div>
          <textarea value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="输入开放式安全任务；多项任务之间用单独一行 --- 分隔" aria-label="任务内容" />
          <div className="attachment-zone">
            <div><Paperclip size={17} aria-hidden="true" /><span><strong>任务附件</strong><small>{files.length ? `${files.length} 个文件 · ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}` : "文本、压缩包、接口文档、图片或二进制材料"}</small></span></div>
            <label className="button secondary file-button"><Upload size={15} aria-hidden="true" />选择文件<input ref={fileInput} type="file" multiple onChange={(event) => setFiles([...event.target.files ?? []])} /></label>
          </div>
          {files.length > 0 && <div className="file-chip-list">{files.map((file, index) => <span key={`${file.name}-${file.size}-${index}`}>{file.name}<small>{formatBytes(file.size)}</small><button type="button" aria-label={`移除 ${file.name}`} title={`移除 ${file.name}`} onClick={() => setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>}
          <div className="composer-settings">
            <label><span className="field-label">批次并发</span><input type="number" min={1} max={8} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
            <label><span className="field-label">每题 Agent</span><input type="number" min={1} max={8} value={raceAgents} onChange={(event) => setRaceAgents(Number(event.target.value))} /></label>
            <label className="toggle-control"><span><strong>生成 WP</strong><small>输出可复核报告</small></span><input type="checkbox" checked={writeup} onChange={(event) => setWriteup(event.target.checked)} /></label>
            <Button className="button submit-task-button" type="submit" loading={submitJob.isPending}><Send size={16} aria-hidden="true" />提交解题</Button>
          </div>
          {formError && <div className="inline-error">{formError}</div>}
        </form>

        <section className="surface-panel question-bank-panel">
          <div className="panel-heading"><div><span className="section-label">BENCHMARK BANK</span><h2>本地题库</h2></div><Database size={19} aria-hidden="true" /></div>
          {bank.isError ? <ErrorState message={bank.error.message} onRetry={() => void bank.refetch()} /> : questionBank ? <>
            <div className="bank-summary"><div><strong>{solvedCount}<span>/{questionBank.count}</span></strong><small>已通过</small></div><div className="bank-progress-copy"><span>{progress}%</span><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><small>{pendingCount} 题待处理</small></div></div>
            <Button className="button question-bank-action" disabled={!questionBank.configured || pendingCount === 0 || Boolean(activeJob)} loading={startBank.isPending} onClick={() => startBank.mutate()} disabledReason={!questionBank.configured ? questionBank.error ?? "题库未配置" : pendingCount === 0 ? "题库已全部通过" : activeJob ? "已有批次正在运行" : undefined}>{pendingCount ? <><Play size={16} aria-hidden="true" />处理未完成题目</> : <><Check size={16} aria-hidden="true" />已全部通过</>}</Button>
            {startBank.error && <div className="inline-error">{startBank.error.message}</div>}
            <div className="question-list">{questionBank.questions?.map((question) => <div className="question-row" key={question.id}><span className={`question-status-mark ${question.status}`} aria-hidden="true" /><span><strong>{question.title}</strong><small>{question.category.toUpperCase()} · {question.attachmentCount} 个附件{question.instanceAvailable ? " · 可启动实例" : ""}</small></span><Badge tone={question.status === "solved" ? "completed" : "neutral"}>{question.status === "solved" ? "已通过" : "待处理"}</Badge></div>)}</div>
          </> : <LoadingState />}
        </section>
      </div>

      <section className="batch-section">
        <div className="section-heading-row"><div><span className="section-label">BATCH HISTORY</span><h2>批量作业</h2></div><span>{jobs.data?.jobs.length ?? 0} 个批次</span></div>
        {jobs.data?.jobs.length ? <div className="manual-job-list">{jobs.data.jobs.map((job) => <JobResult key={job.id} job={job} />)}</div> : <EmptyState title="尚无批量作业" description="提交任务或启动本地题库后，执行状态会显示在这里。" />}
      </section>
    </div>
  );
}
