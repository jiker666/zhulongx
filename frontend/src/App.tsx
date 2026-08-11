import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { ExperiencesPage } from "./pages/ExperiencesPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
export function App() { return <Routes><Route element={<AppShell />}><Route index element={<Navigate to="/runs" replace />} /><Route path="runs" element={<RunsPage />} /><Route path="runs/:runId" element={<RunDetailPage />} /><Route path="experiences" element={<ExperiencesPage />} /><Route path="*" element={<NotFoundPage />} /></Route></Routes> }
