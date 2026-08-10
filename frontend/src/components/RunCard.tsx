import { Link } from "react-router-dom";
import { Badge, Card } from "./ui";
import type { RunSummary } from "../types/api";

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  blocked: "等待验证",
  failed: "失败",
  aborted: "已中止",
};

const phaseLabels: Record<string, string> = {
  intake: "接收",
  planning: "规划",
  exploration: "探索",
  analysis: "分析",
  verification: "验证",
  reporting: "报告",
  done: "完成",
};

function getTaskTitle(task: string, taskType: string): string {
  if (taskType.startsWith("Web CTF")) return "Web CTF 靶场挑战";
  if (taskType.startsWith("Reverse")) return "Reverse 逆向分析挑战";
  if (taskType.startsWith("Pwn")) return "Pwn 二进制利用挑战";
  if (taskType.startsWith("Crypto")) return "Crypto 密码学挑战";
  if (taskType.startsWith("Forensics")) return "Forensics 取证分析挑战";
  if (taskType.startsWith("Misc")) return "Misc 综合挑战";
  const firstLine = task.split(/\r?\n/)[0]?.trim();
  if (!firstLine) return "未命名安全任务";
  return firstLine.length > 68 ? `${firstLine.slice(0, 68)}…` : firstLine;
}

function getTarget(task: string): string | undefined {
  const match = task.match(/https?:\/\/[^\s,，)）]+/i);
  return match?.[0]?.replace(/[./]+$/, "");
}

export function getTaskType(run: RunSummary): string {
  const category = run.category?.trim().toLowerCase();
  if (category === "web" || category === "web ctf" || category?.includes("web")) return "Web CTF";
  if (category?.includes("reverse")) return "Reverse 逆向";
  if (category?.includes("pwn") || category?.includes("binary")) return "Pwn 二进制";
  if (category?.includes("crypto")) return "Crypto 密码学";
  if (category?.includes("forensic")) return "Forensics 取证";
  if (category?.includes("misc")) return "Misc 杂项";
  const task = run.task.toLowerCase();
  if (/web\s*ctf|ctf\s*web|https?:\/\//.test(task)) return "Web CTF";
  if (/reverse|逆向/.test(task)) return "Reverse 逆向";
  if (/pwn|二进制|栈溢出/.test(task)) return "Pwn 二进制";
  if (/crypto|密码|加密/.test(task)) return "Crypto 密码学";
  if (/forensic|取证/.test(task)) return "Forensics 取证";
  if (/misc|杂项/.test(task)) return "Misc 杂项";
  return "通用安全分析";
}

function shortId(id: string): string {
  return id.split("-").slice(0, 2).join("-");
}

export function RunCard({ run }: { run: RunSummary }) {
  const target = getTarget(run.task);
  const taskType = getTaskType(run);
  const status = statusLabels[run.status] ?? run.status;

  return (
    <Card className={`run-card run-card-${run.status}`}>
      <div className="run-card-top">
        <div className="run-status-line">
          <span className="run-status-pulse" aria-hidden="true" />
          <Badge tone={run.status}>{status}</Badge>
        </div>
        <span className="run-date">{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
      </div>

      <div className="run-card-identity">
        <span className="run-card-label">RUN / {shortId(run.id)}</span>
        <span className="run-card-category"><span>题型</span>{taskType}</span>
      </div>
      <h2 title={run.task}>{getTaskTitle(run.task, taskType)}</h2>

      {target ? (
        <div className="run-target" title={target}>
          <span className="run-target-icon" aria-hidden="true">↗</span>
          <span>{target}</span>
        </div>
      ) : (
        <p className="run-description">进入详情查看完整任务描述与外显决策轨迹。</p>
      )}

      <div className="run-metrics" aria-label="任务指标">
        <div><span>阶段</span><strong>{phaseLabels[run.phase] ?? run.phase}</strong></div>
        <div><span>回合</span><strong>{run.turns}</strong></div>
        <div><span>工具调用</span><strong>{run.toolCalls}</strong></div>
        <div><span>经验</span><strong>{run.lessons}</strong></div>
      </div>

      <div className="run-card-footer">
        <span className="run-id" title={run.id}>{run.id}</span>
        <Link className="button secondary run-detail-button" to={`/runs/${run.id}`}>
          查看详情 <span aria-hidden="true">→</span>
        </Link>
      </div>
    </Card>
  );
}
