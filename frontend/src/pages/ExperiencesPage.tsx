import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Power, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { getExperiences, updateExperience } from "../api/experiences";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import type { Experience } from "../types/api";

export function ExperiencesPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | Experience["status"]>("all");
  const [category, setCategory] = useState("all");
  const [editingId, setEditingId] = useState<string>();
  const [reviewNote, setReviewNote] = useState("");
  const query = useQuery({ queryKey: ["experiences"], queryFn: ({ signal }) => getExperiences(signal) });
  const update = useMutation({
    mutationFn: ({ record, status: nextStatus, note }: { record: Experience; status: Experience["status"]; note: string }) => updateExperience(record.id, { status: nextStatus, reviewNote: note }),
    onSuccess: () => { setEditingId(undefined); setReviewNote(""); void queryClient.invalidateQueries({ queryKey: ["experiences"] }); },
  });
  const records = query.data?.experiences ?? [];
  const active = records.filter((record) => record.status === "active").length;
  const categories = [...new Set(records.map((record) => record.category ?? "未分类"))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const filtered = useMemo(() => records.filter((record) => {
    const term = search.trim().toLowerCase();
    if (status !== "all" && record.status !== status) return false;
    if (category !== "all" && (record.category ?? "未分类") !== category) return false;
    return !term || record.title.toLowerCase().includes(term) || record.strategy.some((step) => step.toLowerCase().includes(term));
  }).sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || left.title.localeCompare(right.title, "zh-CN")), [category, records, search, status]);
  const beginReview = (record: Experience) => { setEditingId(record.id); setReviewNote(""); update.reset(); };
  if (query.isPending) return <LoadingState label="正在读取经验库…" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  return (
    <div className="page experiences-page">
      <div className="page-heading">
        <div><div className="eyebrow">VALIDATED EXPERIENCE</div><h1>经验库</h1><p>管理经过操作员或独立验证器确认的通用策略。</p></div>
        <div className="heading-actions"><span className="experience-count"><ShieldCheck size={16} aria-hidden="true" /><strong>{active}</strong> 条启用</span><IconButton className="icon-button bordered" label="刷新经验库" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={17} className={query.isFetching ? "spinning" : ""} /></IconButton></div>
      </div>
      {records.length > 0 && <div className="experience-toolbar"><label className="experience-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索经验标题或策略" aria-label="搜索经验" />{search && <button type="button" aria-label="清空经验搜索" onClick={() => setSearch("")}><X size={14} /></button>}</label><select aria-label="筛选经验状态" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">全部状态</option><option value="active">已启用</option><option value="disabled">已停用</option></select><select aria-label="筛选经验分类" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select><span>{filtered.length} / {records.length}</span></div>}
      {filtered.length ? <div className="experience-grid">{filtered.map((record) => <Card key={record.id} className={record.status === "disabled" ? "experience-card disabled" : "experience-card"}><div className="run-card-top"><Badge tone={record.status === "active" ? "success" : "neutral"}>{record.status === "active" ? "已启用" : "已停用"}</Badge><span className="run-date">{record.category ?? "未分类"}</span></div><h2>{record.title}</h2><ul className="strategy-list">{record.strategy.map((step) => <li key={step}>{step}</li>)}</ul>{editingId === record.id ? <div className="experience-review"><label htmlFor={`experience-review-${record.id}`}>变更依据</label><textarea id={`experience-review-${record.id}`} autoFocus value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder={`说明为什么要${record.status === "active" ? "停用" : "启用"}该策略`} /><div><Button className="button secondary" onClick={() => { setEditingId(undefined); setReviewNote(""); update.reset(); }}><X size={15} aria-hidden="true" />取消</Button><Button className="button" disabled={!reviewNote.trim()} loading={update.isPending} onClick={() => update.mutate({ record, status: record.status === "active" ? "disabled" : "active", note: reviewNote.trim() })}><Check size={15} aria-hidden="true" />确认变更</Button></div>{update.error && <span className="review-error" role="alert">{update.error.message}</span>}</div> : <div className="experience-actions"><Button className="button secondary" onClick={() => beginReview(record)}><Power size={15} aria-hidden="true" />{record.status === "active" ? "停用策略" : "启用策略"}</Button></div>}</Card>)}</div> : records.length ? <EmptyState title="没有匹配的经验" description="调整搜索词或筛选条件后重试。" /> : <EmptyState title="经验库暂无记录" description="服务端还没有可展示的验证经验。" />}
    </div>
  );
}
