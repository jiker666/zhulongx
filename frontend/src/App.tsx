import { Component, lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { Sidebar } from './components/layout'
import { ObsidianBackground } from './components/visual'
import { ErrorState, LoadingState } from './components/ui'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const CtfHub = lazy(() => import('./pages/CtfHub'))
const CtfTaskDetail = lazy(() => import('./pages/CtfTaskDetail'))
const Benchmark = lazy(() => import('./pages/Benchmark'))
const CreateTask = lazy(() => import('./pages/CreateTask'))
const TaskList = lazy(() => import('./pages/TaskList'))
const TaskDetail = lazy(() => import('./pages/TaskDetail'))
const ToolCenter = lazy(() => import('./pages/ToolCenter'))
const ReportView = lazy(() => import('./pages/ReportView'))
const FinalOps = lazy(() => import('./pages/FinalOps'))
const SettingsPage = lazy(() => import('./pages/Settings'))

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error?: Error }> {
  state = { hasError: false, error: undefined as Error | undefined }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8">
          <ErrorState
            title="页面异常"
            detail={this.state.error?.message || '未知错误'}
            onRetry={() => { this.setState({ hasError: false, error: undefined }); window.location.reload() }}
          />
        </div>
      )
    }
    return this.props.children
  }
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <div className="text-6xl font-bold text-ember-500/40">404</div>
      <p className="text-gray-500 text-sm">此路径未在作战地图中标记</p>
      <Link to="/" className="text-ember-400 text-sm hover:underline">返回作战总览</Link>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      <div className="flex min-h-screen text-slate-100">
        <ObsidianBackground />
        <Sidebar />
        <main id="main-content" tabIndex={-1} className="relative z-10 min-w-0 flex-1 md:ml-64 min-h-screen p-4 md:p-6 lg:p-8">
          <ErrorBoundary>
            <Suspense fallback={<LoadingState message="加载作战视图" />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/ctf" element={<CtfHub />} />
                <Route path="/ctf/:taskId" element={<CtfTaskDetail />} />
                <Route path="/benchmark" element={<Benchmark />} />
                <Route path="/tasks/new" element={<CreateTask />} />
                <Route path="/tasks" element={<TaskList />} />
                <Route path="/tasks/:id" element={<TaskDetail />} />
                <Route path="/tasks/:id/report" element={<ReportView />} />
                <Route path="/tools" element={<ToolCenter />} />
                <Route path="/finalops" element={<FinalOps />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  )
}
