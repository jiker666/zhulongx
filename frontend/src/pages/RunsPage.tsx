import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ChevronLeft, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { getRuns } from "../api/runs";
import { Button, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import { getTaskType, RunCard } from "../components/RunCard";

type RunFilter = "all" | "running" | "completed" | "attention";
type RunSort = "newest" | "oldest" | "turns" | "tools";

const filterLabels: Record<RunFilter, string> = {
  all: "全部任务",
  running: "正在运行",
  completed: "已完成",
  attention: "需要关注",
};
const pageSize = 12;

export function RunsPage() {
  const [filter, setFilter] = useState<RunFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<RunSort>("newest");
  const [pageNumber, setPageNumber] = useState(1);
  const query = useQuery({ queryKey: ["runs"], queryFn: ({ signal }) => getRuns(signal), refetchInterval: (state) => state.state.data?.runs.some((run) => run.status === "running" || run.status === "queued") ? 5_000 : state.state.data?.runs.some((run) => run.indexPending) ? 2_000 : false });
  const runs = query.data?.runs ?? [];
  const running = runs.filter((run) => run.status === "running" || run.status === "queued").length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const attention = runs.filter((run) => ["blocked", "failed", "aborted"].includes(run.status)).length;
  const typeCount = new Set(runs.map(getTaskType)).size;
  const filteredRuns = useMemo(() => runs.filter((run) => {
    if (filter === "all") return true;
    if (filter === "running") return run.status === "running" || run.status === "queued";
    if (filter === "completed") return run.status === "completed";
    return ["blocked", "failed", "aborted"].includes(run.status);
  }).filter((run) => {
    const query = search.trim().toLowerCase();
    return !query || run.task.toLowerCase().includes(query) || run.id.toLowerCase().includes(query) || run.category?.toLowerCase().includes(query);
  }).sort((left, right) => {
    if (sort === "oldest") return left.createdAt.localeCompare(right.createdAt);
    if (sort === "turns") return right.turns - left.turns || right.createdAt.localeCompare(left.createdAt);
    if (sort === "tools") return right.toolCalls - left.toolCalls || right.createdAt.localeCompare(left.createdAt);
    return right.createdAt.localeCompare(left.createdAt);
  }), [filter, runs, search, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredRuns.length / pageSize));
  const visibleRuns = filteredRuns.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
  useEffect(() => setPageNumber(1), [filter, search, sort]);
  useEffect(() => { if (pageNumber > totalPages) setPageNumber(totalPages); }, [pageNumber, totalPages]);

  return (
    <div className="page runs-page">
      <section className="runs-hero" aria-labelledby="runs-title">
        <div className="runs-hero-copy">
          <div className="eyebrow">AUDIT / RUN REGISTRY</div>
          <h1 id="runs-title">运行审计</h1>
          <p>查看每一次受授权的安全分析，以及它留下的决策、证据与审计记录。</p>
          <div className="runs-signal-line"><span />AUDIT STREAM <b>●</b> POLICY ENGINE ONLINE</div>
        </div>
        <div className="runs-hero-status">
          <span className="section-label">当前运行</span>
          <strong>{running.toString().padStart(2, "0")}</strong>
          <span>个任务正在运行</span>
        </div>
      </section>

      <section className="runs-overview" aria-label="任务概览">
        <div className="overview-item overview-active"><span>活跃任务</span><strong>{running}</strong><small>LIVE NOW</small></div>
        <div className="overview-item"><span>已完成</span><strong>{completed}</strong><small>VERIFIED</small></div>
        <div className="overview-item"><span>题型覆盖</span><strong>{typeCount}</strong><small>PROFILES</small></div>
        <div className={`overview-item ${attention ? "overview-attention" : ""}`}><span>需要关注</span><strong>{attention}</strong><small>ATTENTION</small></div>
      </section>

      <div className="runs-toolbar">
        <div className="runs-toolbar-main">
          <div className="run-filters" role="tablist" aria-label="任务筛选">
            {(Object.keys(filterLabels) as RunFilter[]).map((value) => (
              <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
                {filterLabels[value]}
                <span>{value === "all" ? runs.length : value === "running" ? running : value === "completed" ? completed : attention}</span>
              </button>
            ))}
          </div>
          <div className="run-toolbar-controls"><label className="run-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务或 Run ID" aria-label="搜索运行" />{search && <button type="button" aria-label="清空运行搜索" title="清空搜索" onClick={() => setSearch("")}><X size={14} aria-hidden="true" /></button>}</label><label className="run-sort"><ArrowUpDown size={14} aria-hidden="true" /><select aria-label="排序运行" value={sort} onChange={(event) => setSort(event.target.value as RunSort)}><option value="newest">最近创建</option><option value="oldest">最早创建</option><option value="turns">回合最多</option><option value="tools">调用最多</option></select></label></div>
        </div>
        <IconButton className="icon-button bordered" label="刷新运行数据" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={17} className={query.isFetching ? "spinning" : ""} aria-hidden="true" /></IconButton>
      </div>

      <div className="run-results-summary" aria-live="polite"><span>当前显示 <strong>{visibleRuns.length}</strong> / {filteredRuns.length} 条</span>{query.isFetching && <span className="syncing">正在同步活动运行…</span>}</div>

      {query.isPending ? <LoadingState /> : query.isError ? <ErrorState message={query.error.message} onRetry={() => void query.refetch()} /> : visibleRuns.length === 0 ? <EmptyState title="当前视图没有任务" description="切换筛选条件，或等待新的授权运行记录进入任务大厅。" /> : <div className="run-grid">{visibleRuns.map((run) => <RunCard key={run.id} run={run} />)}</div>}
      {filteredRuns.length > pageSize && <div className="pagination"><span>第 {pageNumber} / {totalPages} 页 · {filteredRuns.length} 条</span><div><Button className="icon-button bordered" aria-label="上一页" disabled={pageNumber === 1} onClick={() => setPageNumber((value) => value - 1)}><ChevronLeft size={17} /></Button><Button className="icon-button bordered" aria-label="下一页" disabled={pageNumber === totalPages} onClick={() => setPageNumber((value) => value + 1)}><ChevronRight size={17} /></Button></div></div>}
    </div>
  );
}
