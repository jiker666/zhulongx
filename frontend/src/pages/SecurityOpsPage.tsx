import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck } from "lucide-react";
import {
  deleteGuardRule, deleteNotifyChannel, getGuardAudit, getGuardRules, getNotifyChannels,
  getSecOpsAssets, getSecOpsExplorations, getSecOpsFindings, getSecOpsOverview, patchGuardRule,
  patchSecOpsFinding, patchSecOpsIntent, postGuardPending, postGuardRule, postNotifyChannel,
  postSecOpsFinding, postSecOpsIntent, postSecOpsRetest, postSecOpsSync, testNotifyChannel,
  type Finding, type FindingStatus, type GuardRule, type Intent, type IntentStatus, type Retest,
} from "../api/enterprise";
import { Button, Card, EmptyState, ErrorState, LoadingState } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";

const TABS = [
  { key: "overview", label: "总览" },
  { key: "assets", label: "资产图" },
  { key: "exploration", label: "探索与意图" },
  { key: "findings", label: "漏洞与复测" },
  { key: "guard", label: "审批护栏" },
  { key: "notify", label: "通知通道" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const findingStatusLabels: Record<string, string> = {
  pending: "待确认", in_progress: "处理中", confirmed: "已确认", resolved: "已处理",
  fixed: "已修复", false_positive: "误报", ignored: "已忽略", duplicate: "重复", risk_accepted: "风险接受",
};
const intentStatusLabels: Record<string, string> = {
  open: "待执行", running: "执行中", paused: "已暂停", done: "已完成", blocked: "受阻", deleted: "已删除",
};
const verdictLabels: Record<string, string> = { reproduced: "仍可复现", fixed: "已修复", inconclusive: "无法确认" };

function SeverityChip({ severity }: { severity: string }) {
  return <span className={`secops-severity secops-severity-${severity || "none"}`}>{severity || "未分级"}</span>;
}
function StatusChip({ status }: { status: string }) {
  const tone = ["fixed", "resolved", "done"].includes(status) ? "chip-verdict-contradicted" : ["confirmed", "running", "reproduced"].includes(status) ? "chip-verdict-reproduced" : "chip-muted";
  return <span className={`chip ${tone}`}>{findingStatusLabels[status] ?? intentStatusLabels[status] ?? verdictLabels[status] ?? status}</span>;
}

// ---------------------------------------------------------------- overview

function OverviewTab() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["secops", "overview"], queryFn: ({ signal }) => getSecOpsOverview(signal) });
  const sync = useMutation({ mutationFn: postSecOpsSync, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops"] }) });
  if (overview.isPending) return <LoadingState label="正在读取安全运营台账…" />;
  if (overview.isError) return <ErrorState message={overview.error.message} onRetry={() => void overview.refetch()} />;
  const { overview: stats, guard } = overview.data;
  const metrics: Array<[string, string | number, string]> = [
    ["资产总数", stats.assets.total, `${stats.assets.byType.root_domain ?? 0} 根域名 · ${stats.assets.byType.service ?? 0} 服务 · ${stats.assets.byType.endpoint ?? 0} 接口`],
    ["接口覆盖率", `${stats.assets.coverage}%`, `${stats.assets.testedEndpoints}/${stats.assets.endpoints} 接口已有实测证据`],
    ["漏洞总数", stats.findings.total, `${stats.findings.retests} 次独立复测`],
    ["开放意图", stats.explorations.openIntents, `${stats.explorations.total} 个探索目标`],
    ["已摄取运行", stats.ingestedRuns, `证据条目 ${stats.evidence}`],
    ["审批护栏", guard.rules, `${guard.pending} 条待审批`],
  ];
  return (
    <div className="secops-overview">
      <div className="secops-metric-grid">
        {metrics.map(([label, value, hint]) => (
          <Card key={label} className="secops-metric">
            <span className="section-label">{label}</span>
            <strong>{value}</strong>
            <small>{hint}</small>
          </Card>
        ))}
      </div>
      <div className="secops-overview-columns">
        <Card className="secops-panel">
          <div className="panel-heading"><div><span className="section-label">FINDINGS</span><h2>漏洞分布</h2></div>
            <Button className="button secondary secops-sync" loading={sync.isPending} onClick={() => sync.mutate()}><RefreshCw size={14} aria-hidden="true" />同步历史运行</Button>
          </div>
          {stats.findings.total === 0 ? <EmptyState title="暂无漏洞" description="运行完成后会自动把发现锚定到资产；也可在“漏洞与复测”手动录入。" /> : (
            <div className="secops-dist">
              <div><span className="panel-heading-copy">按危害</span>{Object.entries(stats.findings.bySeverity).map(([severity, count]) => (
                <span key={severity} className="secops-dist-row"><SeverityChip severity={severity} /> ×{count}</span>
              ))}</div>
              <div><span className="panel-heading-copy">按状态</span>{Object.entries(stats.findings.byStatus).map(([status, count]) => (
                <span key={status} className="secops-dist-row"><StatusChip status={status} /> ×{count}</span>
              ))}</div>
            </div>
          )}
        </Card>
        <Card className="secops-panel">
          <div className="panel-heading"><div><span className="section-label">COVERAGE</span><h2>资产覆盖</h2></div></div>
          <div className="capability-bar secops-coverage" role="img" aria-label={`接口覆盖率 ${stats.assets.coverage}%`}><i style={{ width: `${stats.assets.coverage}%` }} /></div>
          <p className="muted secops-hint">覆盖率 = 已有实测证据的接口 / 全部登记接口。未测资产在“资产图”中以灰色标注，是下一轮任务的天然输入。</p>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- assets

function AssetsTab() {
  const assets = useQuery({ queryKey: ["secops", "assets"], queryFn: ({ signal }) => getSecOpsAssets(signal) });
  if (assets.isPending) return <LoadingState label="正在读取资产图…" />;
  if (assets.isError) return <ErrorState message={assets.error.message} onRetry={() => void assets.refetch()} />;
  const { companies, assets: all } = assets.data;
  const services = all.filter((asset) => asset.type === "service");
  const endpoints = all.filter((asset) => asset.type === "endpoint");
  return (
    <div className="secops-asset-tree">
      {companies.length === 0 ? <EmptyState title="资产库为空" description="含授权目标的任务运行完成后，域名/服务/接口会自动登记为资产；也可用 API POST /v1/enterprise/assets 手动登记。" /> : companies.map((company) => {
        const owned = all.filter((asset) => asset.companyId === company.id);
        return (
          <Card key={company.id} className="secops-company">
            <div className="secops-company-head">
              <strong>{company.name}</strong>
              <span>{owned.length} 资产 · {owned.filter((asset) => asset.type === "endpoint" && asset.tested > 0).length}/{owned.filter((asset) => asset.type === "endpoint").length} 接口已测</span>
            </div>
            {owned.filter((asset) => asset.type === "root_domain").map((root) => (
              <div key={root.id} className="secops-asset-node secops-asset-root">
                <span>🌐 {root.key}</span>
                <small>发现于 {formatDateTime(root.firstSeenAt)} · {root.runIds.length} 次运行</small>
                {services.filter((service) => service.companyId === company.id && service.key.includes(root.key.split(".")[0] ?? root.key)).map((service) => (
                  <div key={service.id} className="secops-asset-node secops-asset-service">
                    <span>🧩 {service.key}{service.port ? ` :${service.port}` : ""}{service.title ? `（${service.title}）` : ""}</span>
                    {endpoints.filter((endpoint) => endpoint.key.startsWith(`${service.key}/`)).map((endpoint) => (
                      <div key={endpoint.id} className="secops-asset-node secops-asset-endpoint">
                        <span className={endpoint.tested > 0 ? "secops-tested" : "secops-untested"}>
                          <code>{endpoint.method ?? "GET"}</code> {endpoint.key.replace(service.key, "") || "/"}
                        </span>
                        <small>
                          {endpoint.tested > 0 ? <span className="chip chip-verdict-contradicted">已实测</span> : <span className="chip chip-muted">未测</span>}
                          {endpoint.findingCount > 0 && ` · ${endpoint.findingCount} 漏洞`}
                        </small>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- exploration

function ExplorationTab() {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["secops", "explorations"], queryFn: ({ signal }) => getSecOpsExplorations(signal) });
  const [text, setText] = useState("");
  const [priority, setPriority] = useState("5");
  const addIntent = useMutation({
    mutationFn: () => postSecOpsIntent({ text: text.trim(), priority: Number(priority) || 0 }),
    onSuccess: () => { setText(""); void queryClient.invalidateQueries({ queryKey: ["secops", "explorations"] }); },
  });
  const mutateIntent = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchSecOpsIntent>[1] }) => patchSecOpsIntent(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "explorations"] }),
  });
  if (data.isPending) return <LoadingState label="正在读取探索图谱…" />;
  if (data.isError) return <ErrorState message={data.error.message} onRetry={() => void data.refetch()} />;
  const { explorations, intents, facts } = data.data;
  const goals = new Map(explorations.map((exploration) => [exploration.id, exploration.goal]));
  const visible = intents.filter((intent) => intent.status !== "deleted").sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));
  const submit = (event: FormEvent) => { event.preventDefault(); if (text.trim()) addIntent.mutate(); };
  return (
    <div className="secops-exploration">
      <Card className="secops-panel secops-intents">
        <div className="panel-heading"><div><span className="section-label">SHARED TODO</span><h2>规划意图队列</h2></div>
          <span className="panel-count">{visible.filter((intent) => intent.status === "open").length} 待执行</span>
        </div>
        <form className="secops-form-row" onSubmit={submit}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="新的调查意图，例如：验证 /api/v1/user 的水平越权" aria-label="意图内容" />
          <input value={priority} onChange={(event) => setPriority(event.target.value)} type="number" aria-label="优先级" />
          <Button type="submit" loading={addIntent.isPending}>加入队列</Button>
        </form>
        {visible.length === 0 ? <EmptyState title="队列为空" description="运行产生的假设会自动进入这里；也可手动添加意图来指挥下一轮任务。" /> : (
          <ul className="secops-intent-list">
            {visible.map((intent) => <IntentRow key={intent.id} intent={intent} goal={goals.get(intent.explorationId) ?? ""} onMutate={(body) => mutateIntent.mutate({ id: intent.id, body })} />)}
          </ul>
        )}
      </Card>
      <Card className="secops-panel secops-facts">
        <div className="panel-heading"><div><span className="section-label">FACTS</span><h2>已验证事实</h2></div>
          <span className="panel-count">{facts.length}</span>
        </div>
        {facts.length === 0 ? <EmptyState title="暂无事实" description="运行结论与证据会以事实节点的形式挂到资产上，形成目标→意图→事实的探索谱系。" /> : (
          <ul className="secops-fact-list">
            {facts.slice().reverse().map((fact) => (
              <li key={fact.id}>
                <p>{fact.text}</p>
                <small>{goals.get(fact.explorationId) ?? ""} · {fact.assetIds.length} 资产锚点 · {formatDateTime(fact.createdAt)}{fact.runId ? ` · RUN ${fact.runId}` : ""}</small>
                {fact.evidence && <code className="secops-evidence">{fact.evidence}</code>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function IntentRow({ intent, goal, onMutate }: { intent: Intent; goal: string; onMutate: (body: Parameters<typeof patchSecOpsIntent>[1]) => void }) {
  const actions: Array<[string, () => void]> = [];
  if (intent.status === "open") { actions.push(["开始", () => onMutate({ status: "running" })]); }
  if (intent.status === "running") { actions.push(["暂停", () => onMutate({ status: "paused" })], ["完成", () => onMutate({ status: "done" })]); }
  if (intent.status === "paused") { actions.push(["恢复", () => onMutate({ status: "running" })]); }
  if (intent.status !== "deleted") { actions.push(["删除", () => onMutate({ status: "deleted", deleteReason: "人工移除" })]); }
  return (
    <li className={`secops-intent secops-intent-${intent.status}`}>
      <div className="secops-intent-head">
        <StatusChip status={intent.status} />
        <strong>{intent.text}</strong>
        <span className="secops-priority">P{intent.priority}</span>
      </div>
      <small>{goal}{intent.origin ? ` · 来源 ${intent.origin}` : ""} · {formatDateTime(intent.createdAt)}</small>
      {actions.length > 0 && (
        <div className="secops-actions">
          {actions.map(([label, run]) => <Button key={label} className="button secondary" onClick={run}>{label}</Button>)}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- findings

function FindingsTab() {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["secops", "findings"], queryFn: ({ signal }) => getSecOpsFindings(signal), refetchInterval: 10_000 });
  const [name, setName] = useState("");
  const [severity, setSeverity] = useState("high");
  const [summary, setSummary] = useState("");
  const addFinding = useMutation({
    mutationFn: () => postSecOpsFinding({ name: name.trim(), severity, summary: summary.trim() }),
    onSuccess: () => { setName(""); setSummary(""); void queryClient.invalidateQueries({ queryKey: ["secops", "findings"] }); void queryClient.invalidateQueries({ queryKey: ["secops", "overview"] }); },
  });
  const patchFinding = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { status?: FindingStatus } }) => patchSecOpsFinding(id, body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "findings"] }),
  });
  const retest = useMutation({
    mutationFn: (id: string) => postSecOpsRetest(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "findings"] }),
  });
  if (data.isPending) return <LoadingState label="正在读取漏洞台账…" />;
  if (data.isError) return <ErrorState message={data.error.message} onRetry={() => void data.refetch()} />;
  const { findings, retests } = data.data;
  const inFlight = new Set(retests.filter((item) => item.status === "pending" || item.status === "running").map((item) => item.findingId));
  const submit = (event: FormEvent) => { event.preventDefault(); if (name.trim()) addFinding.mutate(); };
  return (
    <div className="secops-findings">
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">FINDINGS</span><h2>漏洞台账</h2></div>
          <span className="panel-count">{findings.length}</span>
        </div>
        <form className="secops-form-row secops-form-add" onSubmit={submit}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="漏洞名称，例如：/api/admin 水平越权" aria-label="漏洞名称" />
          <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="危害等级">
            {["critical", "high", "medium", "low"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="复现步骤 / 证据（可选）" aria-label="摘要" />
          <Button type="submit" loading={addFinding.isPending}>登记漏洞</Button>
        </form>
        {findings.length === 0 ? <EmptyState title="暂无漏洞" description="运行中验证通过的发现会自动登记并推送通知；也可以在这里手动录入后发起复测。" /> : (
          <table className="secops-table">
            <thead><tr><th>漏洞</th><th>危害</th><th>状态</th><th>复测</th><th>更新时间</th></tr></thead>
            <tbody>
              {findings.slice().reverse().map((finding) => <FindingRow key={finding.id} finding={finding} inFlight={inFlight.has(finding.id)} onStatus={(status) => patchFinding.mutate({ id: finding.id, body: { status } })} onRetest={() => retest.mutate(finding.id)} />)}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">RETESTS</span><h2>复测记录</h2></div>
          <span className="panel-count">{retests.length}</span>
        </div>
        {retests.length === 0 ? <EmptyState title="暂无复测" description="对任意漏洞点击“发起复测”，会启动一个独立运行重新验证，结论自动回写漏洞状态。" /> : (
          <ul className="secops-retest-list">
            {retests.map((item) => {
              const finding = findings.find((entry) => entry.id === item.findingId);
              return (
                <li key={item.id}>
                  <div className="secops-retest-head">
                    <strong>{finding?.name ?? item.findingId}</strong>
                    {item.verdict ? <span className={`chip ${item.verdict === "fixed" ? "chip-verdict-contradicted" : item.verdict === "reproduced" ? "chip-verdict-reproduced" : "chip-muted"}`}>{verdictLabels[item.verdict]}</span> : <span className="chip chip-warn">{item.status === "running" ? "复测运行中" : item.status === "pending" ? "排队中" : item.status}</span>}
                  </div>
                  <small>{item.runId ? `RUN ${item.runId} · ` : ""}{formatDateTime(item.createdAt)}{item.error ? ` · ${item.error}` : ""}</small>
                  {item.summary && <p>{item.summary}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function FindingRow({ finding, inFlight, onStatus, onRetest }: { finding: Finding; inFlight: boolean; onStatus: (status: FindingStatus) => void; onRetest: () => void }) {
  return (
    <tr>
      <td>
        <strong>{finding.name}</strong>
        {finding.summary && <small className="secops-cell-sub">{finding.summary}</small>}
      </td>
      <td><SeverityChip severity={finding.severity} /></td>
      <td>
        <select className="secops-status-select" value={finding.status} onChange={(event) => onStatus(event.target.value as FindingStatus)} aria-label="状态流转">
          {Object.entries(findingStatusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select>
      </td>
      <td><Button className="button secondary" disabled={inFlight} disabledReason={inFlight ? "已有复测在运行" : undefined} onClick={onRetest}>{inFlight ? "复测中…" : "发起复测"}</Button></td>
      <td><small>{formatDateTime(finding.updatedAt)}</small></td>
    </tr>
  );
}

// ---------------------------------------------------------------- guard

function GuardTab() {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["secops", "guard"], queryFn: ({ signal }) => getGuardRules(signal), refetchInterval: 5_000 });
  const audit = useQuery({ queryKey: ["secops", "guard-audit"], queryFn: ({ signal }) => getGuardAudit(signal) });
  const [form, setForm] = useState({ name: "", pattern: "", matchTarget: "tool_input", matchType: "string", action: "ask", priority: "10", message: "" });
  const addRule = useMutation({
    mutationFn: () => postGuardRule({
      name: form.name.trim(), pattern: form.pattern, matchTarget: form.matchTarget as GuardRule["matchTarget"],
      matchType: form.matchType as GuardRule["matchType"], action: form.action as GuardRule["action"],
      priority: Number(form.priority) || 0, message: form.message, enabled: true,
    }),
    onSuccess: () => { setForm({ ...form, name: "", pattern: "", message: "" }); void queryClient.invalidateQueries({ queryKey: ["secops", "guard"] }); },
  });
  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "deny" }) => postGuardPending(id, decision),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "guard"] }),
  });
  const toggleRule = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => patchGuardRule(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "guard"] }),
  });
  const removeRule = useMutation({
    mutationFn: (id: string) => deleteGuardRule(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "guard"] }),
  });
  if (data.isPending) return <LoadingState label="正在读取审批护栏…" />;
  if (data.isError) return <ErrorState message={data.error.message} onRetry={() => void data.refetch()} />;
  const { rules, pending } = data.data;
  const submit = (event: FormEvent) => { event.preventDefault(); if (form.name.trim() && form.pattern.trim()) addRule.mutate(); };
  return (
    <div className="secops-guard">
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">ASK GATE</span><h2>待人工审批</h2></div>
          <span className="panel-count">{pending.length}</span>
        </div>
        {pending.length === 0 ? <EmptyState title="没有待审批调用" description="命中 ask 规则的工具调用会在这里挂起等待人工放行（5 分钟超时自动拒绝）。" /> : (
          <ul className="secops-pending-list">
            {pending.map((item) => (
              <li key={item.id} className="secops-pending">
                <div><strong>{item.toolName}</strong><code>{item.toolInputSummary}</code></div>
                <small>会话 {item.sessionId} · {formatDateTime(item.createdAt)} · 超时 {formatDateTime(item.expiresAt)}</small>
                <div className="secops-actions">
                  <Button onClick={() => resolve.mutate({ id: item.id, decision: "approve" })}>放行</Button>
                  <Button className="button secondary" onClick={() => resolve.mutate({ id: item.id, decision: "deny" })}>拒绝</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">INTERCEPT RULES</span><h2>护栏规则</h2></div>
          <span className="panel-count">{rules.length}</span>
        </div>
        <form className="secops-form-row secops-form-rule" onSubmit={submit}>
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="规则名" aria-label="规则名" />
          <select value={form.matchTarget} onChange={(event) => setForm({ ...form, matchTarget: event.target.value })} aria-label="匹配对象">
            <option value="tool_input">工具参数</option><option value="tool_name">工具名</option>
          </select>
          <select value={form.matchType} onChange={(event) => setForm({ ...form, matchType: event.target.value })} aria-label="匹配方式">
            <option value="string">包含</option><option value="regex">正则</option>
          </select>
          <input value={form.pattern} onChange={(event) => setForm({ ...form, pattern: event.target.value })} placeholder="匹配内容，如 nmap 或 DROP TABLE" aria-label="匹配内容" />
          <select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })} aria-label="动作">
            <option value="ask">人工审批</option><option value="deny">直接拒绝</option><option value="allow">直接放行</option>
          </select>
          <input value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} type="number" aria-label="优先级" />
          <input value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} placeholder="拒绝时给 Agent 的提示（可选）" aria-label="提示信息" />
          <Button type="submit" loading={addRule.isPending}>添加规则</Button>
        </form>
        {rules.length === 0 ? <EmptyState title="没有规则" description="未命中任何规则时走原有权限代理不变；规则按优先级首中即停。" /> : (
          <table className="secops-table">
            <thead><tr><th>规则</th><th>匹配</th><th>动作</th><th>优先级</th><th>启用</th><th /></tr></thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td><strong>{rule.name}</strong>{rule.message && <small className="secops-cell-sub">{rule.message}</small>}</td>
                  <td><code>{rule.matchTarget === "tool_name" ? "工具名" : "参数"} · {rule.pattern}</code></td>
                  <td><span className={`chip ${rule.action === "deny" ? "chip-verdict-reproduced" : rule.action === "ask" ? "chip-warn" : "chip-verdict-contradicted"}`}>{rule.action === "deny" ? "拒绝" : rule.action === "ask" ? "审批" : "放行"}</span></td>
                  <td>{rule.priority}</td>
                  <td><label className="secops-switch"><input type="checkbox" checked={rule.enabled} onChange={(event) => toggleRule.mutate({ id: rule.id, enabled: event.target.checked })} /><span /></label></td>
                  <td><Button className="button secondary" onClick={() => removeRule.mutate(rule.id)}>删除</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">AUDIT</span><h2>护栏审计</h2></div></div>
        {audit.data?.audit.length ? (
          <ul className="secops-audit-list">
            {audit.data.audit.slice(0, 30).map((entry) => (
              <li key={entry.id}>
                <span className={`chip ${entry.action === "deny" || entry.action === "ask-denied" ? "chip-verdict-reproduced" : entry.action === "ask" ? "chip-warn" : "chip-verdict-contradicted"}`}>{entry.action}</span>
                <span>{entry.toolName}</span>
                <small>会话 {entry.sessionId} · {formatDateTime(entry.at)}{entry.message ? ` · ${entry.message}` : ""}</small>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="暂无审计记录" description="每次规则命中都会落审计，无论放行、拒绝还是人工裁决。" />}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- notify

function NotifyTab() {
  const queryClient = useQueryClient();
  const data = useQuery({ queryKey: ["secops", "notify"], queryFn: ({ signal }) => getNotifyChannels(signal), refetchInterval: 10_000 });
  const [form, setForm] = useState({ name: "", kind: "feishu", webhook: "", secret: "", minSeverity: "low" });
  const addChannel = useMutation({
    mutationFn: () => postNotifyChannel({
      name: form.name.trim(), kind: form.kind,
      config: { ...(form.secret.trim() ? { secret: form.secret.trim() } : {}), ...(form.kind === "webhook" ? { url: form.webhook.trim() } : { webhook: form.webhook.trim() }) },
      minSeverity: form.minSeverity,
    }),
    onSuccess: () => { setForm({ ...form, name: "", webhook: "", secret: "" }); void queryClient.invalidateQueries({ queryKey: ["secops", "notify"] }); },
  });
  const removeChannel = useMutation({
    mutationFn: (id: string) => deleteNotifyChannel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "notify"] }),
  });
  const testChannel = useMutation({
    mutationFn: (id: string) => testNotifyChannel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["secops", "notify"] }),
  });
  if (data.isPending) return <LoadingState label="正在读取通知通道…" />;
  if (data.isError) return <ErrorState message={data.error.message} onRetry={() => void data.refetch()} />;
  const { channels, events, deliveries } = data.data;
  const submit = (event: FormEvent) => { event.preventDefault(); if (form.name.trim() && form.webhook.trim()) addChannel.mutate(); };
  const result = testChannel.data;
  return (
    <div className="secops-notify">
      <Card className="secops-panel">
        <div className="panel-heading"><div><span className="section-label">CHANNELS</span><h2>IM 通知通道</h2></div>
          <span className="panel-count">{channels.length}</span>
        </div>
        <form className="secops-form-row secops-form-channel" onSubmit={submit}>
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="通道名，如 安全值班群" aria-label="通道名" />
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} aria-label="平台">
            <option value="feishu">飞书</option><option value="wecom">企业微信</option><option value="dingtalk">钉钉</option><option value="webhook">通用 Webhook</option>
          </select>
          <input value={form.webhook} onChange={(event) => setForm({ ...form, webhook: event.target.value })} placeholder="Webhook 地址 https://…" aria-label="Webhook 地址" />
          {form.kind === "dingtalk" && <input value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} placeholder="加签密钥（可选）" aria-label="加签密钥" />}
          <select value={form.minSeverity} onChange={(event) => setForm({ ...form, minSeverity: event.target.value })} aria-label="最低推送等级">
            <option value="">全部</option><option value="low">low 以上</option><option value="medium">medium 以上</option><option value="high">high 以上</option><option value="critical">仅 critical</option>
          </select>
          <Button type="submit" loading={addChannel.isPending}>添加通道</Button>
        </form>
        {channels.length === 0 ? <EmptyState title="暂无通道" description="新漏洞、状态流转与复测结论会按等级过滤推送到启用的通道。" /> : (
          <table className="secops-table">
            <thead><tr><th>通道</th><th>推送等级</th><th>频率上限</th><th>操作</th></tr></thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td><strong>{channel.name}</strong><small className="secops-cell-sub">{channel.kind === "feishu" ? "飞书" : channel.kind === "wecom" ? "企业微信" : channel.kind === "dingtalk" ? "钉钉（自动加签）" : "Webhook"} · {String(channel.config.webhook ?? channel.config.url ?? "")}</small></td>
                  <td>{channel.minSeverity === "" ? "全部" : `≥ ${channel.minSeverity}`}</td>
                  <td>{channel.ratePerMin}/分钟</td>
                  <td className="secops-actions-cell">
                    <Button className="button secondary" loading={testChannel.isPending && testChannel.variables === channel.id} onClick={() => testChannel.mutate(channel.id)}>测试</Button>
                    <Button className="button secondary" onClick={() => removeChannel.mutate(channel.id)}>删除</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result && <p className={`secops-test-result ${result.delivered ? "secops-test-ok" : "secops-test-fail"}`}>{result.delivered ? "测试消息已送达。" : `测试失败：${result.error ?? "未知错误"}`}</p>}
      </Card>
      <div className="secops-notify-columns">
        <Card className="secops-panel">
          <div className="panel-heading"><div><span className="section-label">EVENTS</span><h2>事件流</h2></div>
            <span className="panel-count">{events.length}</span>
          </div>
          {events.length === 0 ? <EmptyState title="暂无事件" /> : (
            <ul className="secops-event-list">
              {events.map((event) => (
                <li key={event.id}>
                  <SeverityChip severity={event.severity} />
                  <div><p>{event.title}</p><small>{event.kind} · {formatDateTime(event.createdAt)}</small></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="secops-panel">
          <div className="panel-heading"><div><span className="section-label">DELIVERIES</span><h2>投递记录</h2></div>
            <span className="panel-count">{deliveries.length}</span>
          </div>
          {deliveries.length === 0 ? <EmptyState title="暂无投递" /> : (
            <ul className="secops-event-list">
              {deliveries.map((delivery) => {
                const channel = channels.find((item) => item.id === delivery.channelId);
                return (
                  <li key={delivery.id}>
                    <span className={`chip ${delivery.status === "delivered" ? "chip-verdict-contradicted" : delivery.status === "failed" ? "chip-verdict-reproduced" : "chip-warn"}`}>{delivery.status === "delivered" ? "已送达" : delivery.status === "failed" ? "失败" : "待投递"}</span>
                    <div><p>{channel?.name ?? delivery.channelId}</p><small>尝试 {delivery.attempts} 次 · {formatDateTime(delivery.deliveredAt ?? delivery.createdAt)}{delivery.lastError ? ` · ${delivery.lastError}` : ""}</small></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

const TAB_KEYS = new Set(TABS.map((item) => item.key));

export function SecurityOpsPage() {
  const [tab, setTab] = useState<TabKey>(() => {
    const hash = window.location.hash.slice(1) as TabKey;
    return TAB_KEYS.has(hash) ? hash : "overview";
  });
  const select = (key: TabKey) => { window.location.hash = key; setTab(key); };
  return (
    <div className="page secops-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">安全运营 · ENTERPRISE</div>
          <h1>资产 · 漏洞 · 审批 · 通知</h1>
          <p>任务运行自动沉淀资产图与探索谱系；漏洞经独立复测闭环流转，护栏规则在工具调用前拦截，结论实时推送 IM。</p>
        </div>
        <span className="heading-status"><ShieldCheck size={14} aria-hidden="true" /><span><strong>闭环</strong><small>发现 → 确认 → 修复 → 复测 → 关闭</small></span></span>
      </div>
      <nav className="secops-tabs" aria-label="安全运营分区">
        {TABS.map((item) => (
          <button key={item.key} className={`secops-tab ${tab === item.key ? "is-active" : ""}`} onClick={() => select(item.key)}>{item.label}</button>
        ))}
      </nav>
      {tab === "overview" && <OverviewTab />}
      {tab === "assets" && <AssetsTab />}
      {tab === "exploration" && <ExplorationTab />}
      {tab === "findings" && <FindingsTab />}
      {tab === "guard" && <GuardTab />}
      {tab === "notify" && <NotifyTab />}
    </div>
  );
}
