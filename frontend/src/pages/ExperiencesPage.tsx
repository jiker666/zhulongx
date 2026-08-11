import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, RefreshCw, ShieldCheck } from "lucide-react";
import { getExperiences, updateExperience } from "../api/experiences";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import type { Experience } from "../types/api";

export function ExperiencesPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["experiences"], queryFn: ({ signal }) => getExperiences(signal) });
  const update = useMutation({
    mutationFn: ({ record, status }: { record: Experience; status: Experience["status"] }) => updateExperience(record.id, { status }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["experiences"] }),
  });
  if (query.isPending) return <LoadingState label="正在读取经验库…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const records = query.data?.experiences ?? [];
  const active = records.filter((record) => record.status === "active").length;
  return (
    <div className="page experiences-page">
      <div className="page-heading">
        <div><div className="eyebrow">VALIDATED EXPERIENCE</div><h1>经验库</h1><p>管理经过外部平台验真的通用策略。</p></div>
        <div className="heading-actions"><span className="experience-count"><ShieldCheck size={16} aria-hidden="true" /><strong>{active}</strong> 条启用</span><IconButton className="icon-button bordered" label="刷新经验库" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={17} className={query.isFetching ? "spinning" : ""} /></IconButton></div>
      </div>
      {records.length ? <div className="experience-grid">{records.map((record) => <Card key={record.id} className={record.status === "disabled" ? "experience-card disabled" : "experience-card"}><div className="run-card-top"><Badge tone={record.status === "active" ? "success" : "neutral"}>{record.status === "active" ? "已启用" : "已停用"}</Badge><span className="run-date">{record.category ?? "未分类"}</span></div><h2>{record.title}</h2><ul className="strategy-list">{record.strategy.map((step) => <li key={step}>{step}</li>)}</ul><div className="experience-actions"><Button className="button secondary" loading={update.isPending && update.variables?.record.id === record.id} onClick={() => update.mutate({ record, status: record.status === "active" ? "disabled" : "active" })}><Power size={15} aria-hidden="true" />{record.status === "active" ? "停用策略" : "启用策略"}</Button></div></Card>)}</div> : <EmptyState title="经验库暂无记录" description="服务端还没有可展示的验证经验。" />}
      {update.error && <div className="inline-error">{update.error.message}</div>}
    </div>
  );
}
