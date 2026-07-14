import { Component, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { Sidebar } from './components/layout'
import { ObsidianBackground } from './components/visual'
import { ErrorState } from './components/ui'
import Dashboard from './pages/Dashboard'
import CtfHub from './pages/CtfHub'
import CtfTaskDetail from './pages/CtfTaskDetail'
import Benchmark from './pages/Benchmark'
import CreateTask from './pages/CreateTask'
import TaskList from './pages/TaskList'
import TaskDetail from './pages/TaskDetail'
import ToolCenter from './pages/ToolCenter'
import ReportView from './pages/ReportView'
import FinalOps from './pages/FinalOps'
import SettingsPage from './pages/Settings'

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
          </ErrorBoundary>
        </main>
      </div>
    </BrowserRouter>
  )
}
