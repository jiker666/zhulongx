import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Target,
  Crosshair,
  BarChart3,
  Wrench,
  Settings,
  Flame,
} from 'lucide-react'
import Dashboard from './pages/Dashboard'
import CtfHub from './pages/CtfHub'
import CtfTaskDetail from './pages/CtfTaskDetail'
import Benchmark from './pages/Benchmark'
import CreateTask from './pages/CreateTask'
import TaskList from './pages/TaskList'
import TaskDetail from './pages/TaskDetail'
import ToolCenter from './pages/ToolCenter'
import ReportView from './pages/ReportView'
import SettingsPage from './pages/Settings'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: '作战大屏' },
  { to: '/ctf', icon: Target, label: 'CTF 作战' },
  { to: '/benchmark', icon: BarChart3, label: '能力评测' },
  { to: '/tasks/new', icon: Crosshair, label: '创建任务' },
  { to: '/tasks', icon: Flame, label: '任务列表' },
  { to: '/tools', icon: Wrench, label: '工具中心' },
  { to: '/settings', icon: Settings, label: '系统设置' },
]

function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-gradient-to-b from-[#0a0e1a] via-[#0d1426] to-[#0a0e1a] border-r border-amber-500/20 flex flex-col z-10">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-amber-500/20">
        <div className="relative">
          <div className="absolute inset-0 blur-md bg-amber-500/40 rounded-full" />
          <Flame className="relative text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.5)]" size={26} />
        </div>
        <div>
          <div className="font-bold text-white text-base tracking-wide">烛龙·玄枢</div>
          <div className="text-[10px] text-amber-300/70 tracking-[0.2em] uppercase">ZHULONG-X</div>
        </div>
      </div>

      {/* Tagline */}
      <div className="px-5 py-2 border-b border-[#1f2937]">
        <div className="text-xs text-gray-400 italic">烛照隐微 · 枢决攻防</div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-amber-500/15 to-transparent text-amber-300 font-medium border-l-2 border-amber-400'
                  : 'text-gray-400 hover:bg-[#1f2937]/60 hover:text-gray-200'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-[#1f2937]">
        <div className="text-[10px] text-gray-600 leading-tight">
          ⚠️ 仅用于授权 CTF / 靶场 / 教学
          <br />
          严禁未授权攻击真实目标
        </div>
      </div>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-[#0a0e1a] text-gray-100">
        <Sidebar />
        <main className="flex-1 ml-64 min-h-screen">
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
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
