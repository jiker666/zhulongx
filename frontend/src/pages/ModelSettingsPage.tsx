import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, KeyRound, Save, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { configureModelSettings, clearModelSettings, getModelSettings, type ModelSettingsInput } from "../api/model-settings";
import { Badge, Button, Card, ErrorState, LoadingState } from "../components/ui";

const DEFAULTS: ModelSettingsInput = {
  provider: "anthropic",
  name: "DeepSeek V4 Flash",
  modelId: "deepseek-v4-flash",
  baseUrl: "https://api.anthropic.com",
  apiKey: "",
  appKey: "",
  appKeyHeader: "AppKey",
  reasoning: true,
};

const sourceLabels = { session: "当前会话", environment: "环境变量", missing: "未配置" } as const;

export function ModelSettingsPage() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ModelSettingsInput>(DEFAULTS);
  const [message, setMessage] = useState("");
  const settings = useQuery({ queryKey: ["model-settings"], queryFn: ({ signal }) => getModelSettings(signal) });
  const save = useMutation({
    mutationFn: () => configureModelSettings({ ...form, apiKey: form.apiKey.trim(), ...(form.appKey?.trim() ? { appKey: form.appKey.trim() } : {}) }),
    onSuccess: () => { setMessage("模型连接已更新，仅保存在当前 API 进程内存中。"); setForm((current) => ({ ...current, apiKey: "", appKey: "" })); void queryClient.invalidateQueries({ queryKey: ["model-settings"] }); },
  });
  const clear = useMutation({
    mutationFn: () => clearModelSettings(),
    onSuccess: () => { setMessage("已清除页面配置，运行时将回退到环境变量配置。"); void queryClient.invalidateQueries({ queryKey: ["model-settings"] }); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setMessage(""); save.mutate(); };
  const current = settings.data?.model;

  if (settings.isPending) return <LoadingState label="正在读取模型连接状态…" />;
  if (settings.isError) return <ErrorState message={settings.error.message} onRetry={() => void settings.refetch()} />;

  return (
    <div className="page model-settings-page">
      <div className="page-heading">
        <div><div className="eyebrow">MODEL / OPERATOR CONFIGURATION</div><h1>模型设置</h1><p>配置 Anthropic 协议模型端点。密钥只在当前 API 进程内存中使用，不写入仓库、浏览器存储或运行材料。</p></div>
        <div className="model-settings-status"><Badge tone={current?.configured ? "success" : "danger"}>{current?.configured ? "已连接" : "未配置"}</Badge><span>{current ? sourceLabels[current.source] : "—"}</span></div>
      </div>

      <div className="model-settings-grid">
        <Card className="model-settings-card">
          <div className="panel-heading"><div><span className="section-label">ACTIVE MODEL</span><h2>当前运行配置</h2></div><Settings2 size={18} aria-hidden="true" /></div>
          {current && <dl className="model-facts"><div><dt>Provider</dt><dd>{current.provider}</dd></div><div><dt>Model</dt><dd>{current.name} <code>{current.id}</code></dd></div><div><dt>Endpoint</dt><dd>{current.baseUrl}</dd></div><div><dt>推理</dt><dd>{current.reasoning ? "启用" : "明确关闭"}</dd></div><div><dt>AppKey</dt><dd>{current.appKeyHeaderConfigured ? "已配置自定义请求头" : "未配置"}</dd></div></dl>}
          <div className="model-security-note"><ShieldCheck size={15} aria-hidden="true" /><span>配置仅驻留 API 进程内存。API 重启后会回退到 `config/default.yaml` 和环境变量。</span></div>
          <Button className="button secondary" type="button" loading={clear.isPending} onClick={() => clear.mutate()} disabled={!current?.source || current.source !== "session"}><Trash2 size={15} aria-hidden="true" />清除页面配置</Button>
        </Card>

        <form className="surface-panel model-settings-card" onSubmit={submit}>
          <div className="panel-heading"><div><span className="section-label">TEMPORARY SESSION</span><h2>设置 Anthropic 协议端点</h2></div><KeyRound size={18} aria-hidden="true" /></div>
          <div className="settings-field-grid">
            <label><span className="field-label">Provider</span><input value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })} required maxLength={100} /></label>
            <label><span className="field-label">显示名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={200} /></label>
            <label className="settings-field-wide"><span className="field-label">Model ID / Endpoint ID</span><input value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} required maxLength={200} /></label>
            <label className="settings-field-wide"><span className="field-label">Base URL</span><input type="url" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} required maxLength={500} /></label>
            <label className="settings-checkbox"><input type="checkbox" checked={form.reasoning === true} onChange={(event) => setForm({ ...form, reasoning: event.target.checked })} /><span className="field-label">模型支持推理控制</span></label>
            <label><span className="field-label">AppKey 请求头</span><input value={form.appKeyHeader} onChange={(event) => setForm({ ...form, appKeyHeader: event.target.value })} placeholder="AppKey" maxLength={64} /></label>
            <label className="settings-field-wide"><span className="field-label">API Key</span><input type="password" autoComplete="off" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="仅本次提交使用，不会回填" required maxLength={1000} /></label>
            <label className="settings-field-wide"><span className="field-label">AppKey（可选）</span><input type="password" autoComplete="off" value={form.appKey} onChange={(event) => setForm({ ...form, appKey: event.target.value })} placeholder="需要网关 AppKey 时填写" maxLength={1000} /></label>
          </div>
          {save.error && <div className="inline-error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{save.error.message}</div>}
          {message && <div className="inline-success" role="status"><CheckCircle2 size={14} aria-hidden="true" />{message}</div>}
          <div className="model-settings-footer"><small>推荐使用本地回环 API；不要把密钥复制到任务文本或截图中。</small><Button className="button" type="submit" loading={save.isPending}><Save size={15} aria-hidden="true" />保存临时配置</Button></div>
        </form>
      </div>
    </div>
  );
}
