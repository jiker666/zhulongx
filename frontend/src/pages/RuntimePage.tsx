import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, GitBranch, Inbox, LockKeyhole, Network, Workflow } from "lucide-react";
import { getRuntimeAgents, getRuntimeWorkflows } from "../api/runtime";
import { Badge, Card, EmptyState, ErrorState, LoadingState } from "../components/ui";
import type { RuntimeAgent, RuntimeMailboxMessage, RuntimeTask, RuntimeTaskResult, RuntimeWorkflow, RuntimeWorkflowEvent, RuntimeWorkflowNode } from "../types/api";

const agentStatusLabels: Record<string, string> = { initializing: "初始化", idle: "空闲", running: "运行中", interrupted: "已中断", error: "错误", closed: "已关闭" };
const taskStatusLabels: Record<string, string> = { queued: "排队", starting: "启动中", running: "运行中", waiting: "等待", succeeded: "成功", failed: "失败", cancelled: "已取消" };
const workflowStatusLabels: Record<string, string> = { queued: "排队", running: "运行中", succeeded: "成功", failed: "失败", cancelled: "已取消" };
const effectLabels: Record<string, string> = { pure_readonly: "只读", workspace_read: "读工作区", workspace_write: "写工作区", network: "网络", unknown: "未知" };

function tone(status: string): string {
  if (["running", "starting"].includes(status)) return "running";
  if (["succeeded", "idle"].includes(status)) return "success";
  if (["failed", "error", "cancelled", "interrupted"].includes(status)) return "danger";
  if (["queued", "waiting", "initializing"].includes(status)) return "warning";
  return "neutral";
}

function relativeTime(value: string): string {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - date) / 1_000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

function RuntimeHud({ agents, tasks, workflows, messages }: { agents: RuntimeAgent[]; tasks: RuntimeTask[]; workflows: RuntimeWorkflow[]; messages: number }) {
  const activeAgents = agents.filter((agent) => agent.status === "running").length;
  const activeTasks = tasks.filter((task) => ["starting", "running", "waiting"].includes(task.status)).length;
  const activeNodes = workflows.flatMap((workflow) => workflow.nodes).filter((node) => node.status === "running").length;
  return <section className="runtime-hud"><div><span>AGENTS</span><strong>{agents.length}</strong><small>{activeAgents} active</small></div><div><span>TASKS</span><strong>{tasks.length}</strong><small>{activeTasks} active</small></div><div><span>WORKFLOWS</span><strong>{workflows.length}</strong><small>{activeNodes} running nodes</small></div><div><span>MAILBOX</span><strong>{messages}</strong><small>unread messages</small></div><div><span>POLICY</span><strong>BOUND</strong><small>operator scope enforced</small></div></section>;
}

function AgentTopology({ agents, tasks }: { agents: RuntimeAgent[]; tasks: RuntimeTask[] }) {
  const taskByAgent = useMemo(() => new Map(agents.map((agent) => [agent.id, tasks.filter((task) => task.agentId === agent.id)])), [agents, tasks]);
  return <Card className="runtime-panel"><div className="panel-heading"><div><span className="section-label">PERSISTENT AGENTS</span><h2>Agent topology</h2></div><Bot size={17} /></div>{agents.length ? <div className="runtime-agent-list">{agents.map((agent) => { const owned = taskByAgent.get(agent.id) ?? []; return <article className="runtime-agent-row" key={agent.id}><div className="runtime-agent-mark"><Bot size={16} /><span className={`runtime-status-dot runtime-dot-${agent.status}`} /></div><div className="runtime-agent-main"><strong>{agent.profileId}</strong><small className="mono">{agent.id.slice(0, 12)}… · {agent.purpose} · depth {agent.depth}</small><small>{agent.path}</small></div><div className="runtime-agent-tasks"><span>TASKS</span><strong>{owned.length}</strong><small>{owned.filter((task) => !["succeeded", "failed", "cancelled"].includes(task.status)).length} open</small></div><Badge tone={tone(agent.status)}>{agentStatusLabels[agent.status] ?? agent.status}</Badge></article>; })}</div> : <EmptyState title="暂无 Persistent Agent" description="Agent Store 当前没有创建可观测节点。" />}</Card>;
}

function TaskQueue({ tasks, results, messages }: { tasks: RuntimeTask[]; results: RuntimeTaskResult[]; messages: RuntimeMailboxMessage[] }) {
  const recentTasks = tasks.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 10);
  return <Card className="runtime-panel"><div className="panel-heading"><div><span className="section-label">TASK QUEUE / MAILBOX</span><h2>任务与消息</h2></div><Inbox size={17} /></div>{recentTasks.length ? <div className="runtime-task-list">{recentTasks.map((task) => <div className="runtime-task-row" key={task.id}><span className={`runtime-task-kind kind-${task.kind}`}>{task.kind.replace("_", " ")}</span><div><strong>{task.message}</strong><small className="mono">{task.id.slice(0, 12)}… · agent {task.agentId.slice(0, 8)} · lease {task.leaseGeneration}</small></div><span className="runtime-task-meta">{task.attempts} attempts<br />{relativeTime(task.updatedAt)}</span><Badge tone={tone(task.status)}>{taskStatusLabels[task.status] ?? task.status}</Badge></div>)}</div> : <EmptyState title="暂无 Agent Task" description="没有排队、运行或已结算的任务。" />}{messages.length > 0 && <div className="runtime-mailbox"><div className="runtime-subheading"><span>UNREAD MAILBOX</span><strong>{messages.length}</strong></div>{messages.slice(-5).reverse().map((message) => <div className="runtime-message" key={message.id}><span className="mono">agent {message.agentId.slice(0, 8)}</span><p>{message.text}</p><time>{relativeTime(message.createdAt)}</time></div>)}</div>}{results.length > 0 && <div className="runtime-results"><div className="runtime-subheading"><span>RECENT RESULTS</span><strong>{results.length}</strong></div>{results.slice(-5).reverse().map((result) => <div className="runtime-result" key={result.taskId}><Badge tone={tone(result.status)}>{result.status.toUpperCase()}</Badge><span>{result.summary}</span>{result.unread && <small>UNREAD</small>}</div>)}</div>}</Card>;
}

function nodeDepth(node: RuntimeWorkflowNode, nodes: RuntimeWorkflowNode[], memo = new Map<string, number>()): number {
  if (memo.has(node.id)) return memo.get(node.id)!;
  const dependencies = node.dependencies.map((dependency) => nodes.find((candidate) => candidate.id === dependency.nodeId)).filter((candidate): candidate is RuntimeWorkflowNode => Boolean(candidate));
  const depth = dependencies.length ? Math.min(5, Math.max(...dependencies.map((dependency) => nodeDepth(dependency, nodes, memo))) + 1) : 0;
  memo.set(node.id, depth); return depth;
}

function WorkflowGraph({ workflow }: { workflow: RuntimeWorkflow }) {
  const columns = useMemo(() => { const grouped = new Map<number, RuntimeWorkflowNode[]>(); const memo = new Map<string, number>(); for (const node of workflow.nodes) { const depth = nodeDepth(node, workflow.nodes, memo); grouped.set(depth, [...(grouped.get(depth) ?? []), node]); } return [...grouped.entries()].sort((left, right) => left[0] - right[0]); }, [workflow.nodes]);
  return <div className="runtime-workflow-graph" aria-label={`${workflow.name} workflow DAG`}>{columns.map(([depth, nodes]) => <div className="runtime-workflow-column" key={depth}><span className="runtime-column-label">STAGE {depth + 1}</span>{nodes.map((node) => <article className={`runtime-node runtime-node-${node.status}`} key={node.id}><div className="runtime-node-heading"><strong>{node.id}</strong><Badge tone={tone(node.status)}>{node.status.toUpperCase()}</Badge></div><p>{node.message}</p><div className="runtime-node-facts"><span>{node.kind}</span><span>{effectLabels[node.effect] ?? node.effect}</span><span>{node.attempts}/{node.maxAttempts} attempts</span></div>{node.dependencies.length > 0 && <small className="runtime-node-deps">← {node.dependencies.map((dependency) => `${dependency.nodeId} (${dependency.condition})`).join(", ")}</small>}{node.summary && <small className="runtime-node-summary">{node.summary}</small>}{node.error && <small className="runtime-node-error">{node.error}</small>}</article>)}</div>)}</div>;
}

function WorkflowSection({ workflows, events }: { workflows: RuntimeWorkflow[]; events: RuntimeWorkflowEvent[] }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = workflows.find((workflow) => workflow.id === (selectedId ?? workflows[0]?.id));
  return <Card className="runtime-panel runtime-workflows-panel"><div className="panel-heading"><div><span className="section-label">WORKFLOW DAG / EXECUTOR</span><h2>Workflow runtime</h2></div><Workflow size={17} /></div>{workflows.length ? <div className="runtime-workflow-layout"><div className="runtime-workflow-list">{workflows.map((workflow) => <button className={`runtime-workflow-item ${workflow.id === selected?.id ? "active" : ""}`} key={workflow.id} type="button" onClick={() => setSelectedId(workflow.id)}><div><strong>{workflow.name}</strong><small className="mono">{workflow.id.slice(0, 12)}…</small></div><span>{workflow.nodes.length} nodes</span><Badge tone={tone(workflow.status)}>{workflowStatusLabels[workflow.status] ?? workflow.status}</Badge></button>)}</div>{selected && <div className="runtime-workflow-detail"><div className="runtime-workflow-heading"><div><span className="mono">{selected.id}</span><h3>{selected.name}</h3></div><Badge tone={tone(selected.status)}>{workflowStatusLabels[selected.status] ?? selected.status}</Badge></div><div className="runtime-workflow-budget"><span>NETWORK NODES <b>{selected.usage.networkNodes}/{selected.budget.maxNetworkNodes}</b></span><span>REQUESTS <b>{selected.usage.networkRequests}/{selected.budget.maxNetworkRequests}</b></span><span>TOKENS <b>{selected.usage.tokens}/{selected.budget.maxTokens}</b></span><span>EFFECT LOCK <b><LockKeyhole size={12} /> ENFORCED</b></span></div><WorkflowGraph workflow={selected} /><div className="runtime-workflow-events"><div className="runtime-subheading"><span>WORKFLOW AUDIT</span><strong>{events.filter((event) => event.workflowId === selected.id).length}</strong></div>{events.filter((event) => event.workflowId === selected.id).slice(-8).reverse().map((event) => <div key={event.id}><Network size={12} /><span>{event.type}{event.nodeId ? ` · ${event.nodeId}` : ""}</span><small>{event.detail ?? "—"}</small></div>)}</div></div>}</div> : <EmptyState title="暂无 Workflow" description="Workflow Store 当前没有可展示的执行图。" />}</Card>;
}

export function RuntimePage() {
  const agents = useQuery({ queryKey: ["runtime-agents"], queryFn: ({ signal }) => getRuntimeAgents(signal), refetchInterval: 5_000 });
  const workflows = useQuery({ queryKey: ["runtime-workflows"], queryFn: ({ signal }) => getRuntimeWorkflows(signal), refetchInterval: 5_000 });
  if (agents.isPending || workflows.isPending) return <LoadingState label="正在读取 Persistent Agent 与 Workflow 状态…" />;
  if (agents.isError) return <ErrorState message={agents.error.message} onRetry={() => void agents.refetch()} />;
  if (workflows.isError) return <ErrorState message={workflows.error.message} onRetry={() => void workflows.refetch()} />;
  return <div className="page runtime-page"><div className="page-heading"><div><div className="eyebrow">RUNTIME / PERSISTENT ORCHESTRATION</div><h1>运行时控制面</h1><p>Agent、Mailbox、Lease 与 Workflow DAG 的真实状态投影。</p></div><div className="runtime-live-status"><Activity size={14} />READ ONLY OBSERVABILITY</div></div><RuntimeHud agents={agents.data.agents} tasks={agents.data.tasks} workflows={workflows.data.workflows} messages={agents.data.messages.filter((message) => !message.delivered).length} /><div className="runtime-grid"><AgentTopology agents={agents.data.agents} tasks={agents.data.tasks} /><TaskQueue tasks={agents.data.tasks} results={agents.data.results} messages={agents.data.messages.filter((message) => !message.delivered)} /></div><WorkflowSection workflows={workflows.data.workflows} events={workflows.data.events} /></div>;
}
