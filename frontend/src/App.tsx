import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { LoadingState } from "./components/ui";

const ExperiencesPage = lazy(() => import("./pages/ExperiencesPage").then((module) => ({ default: module.ExperiencesPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })));
const OverviewPage = lazy(() => import("./pages/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const RunDetailPage = lazy(() => import("./pages/RunDetailPage").then((module) => ({ default: module.RunDetailPage })));
const RunsPage = lazy(() => import("./pages/RunsPage").then((module) => ({ default: module.RunsPage })));
const WorkbenchPage = lazy(() => import("./pages/WorkbenchPage").then((module) => ({ default: module.WorkbenchPage })));
const CampaignPage = lazy(() => import("./pages/CampaignPage").then((module) => ({ default: module.CampaignPage })));
const CampaignDetailPage = lazy(() => import("./pages/CampaignDetailPage").then((module) => ({ default: module.CampaignDetailPage })));
const EvaluationLabPage = lazy(() => import("./pages/EvaluationLabPage").then((module) => ({ default: module.EvaluationLabPage })));
const RuntimePage = lazy(() => import("./pages/RuntimePage").then((module) => ({ default: module.RuntimePage })));

export function App() {
  return (
    <Suspense fallback={<LoadingState label="正在打开工作区…" />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="workbench" element={<WorkbenchPage />} />
          <Route path="campaigns" element={<CampaignPage />} />
          <Route path="campaigns/:campaignId" element={<CampaignDetailPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="experiences" element={<ExperiencesPage />} />
          <Route path="evaluations" element={<EvaluationLabPage />} />
          <Route path="runtime" element={<RuntimePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
