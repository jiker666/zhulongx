import { memo, useState, useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import {
  LayoutDashboard, Target, BarChart3, Crosshair, List, Wrench, Settings, Menu, X, Flag,
} from 'lucide-react'
import ZhulongLogo from '../brand/ZhulongLogo'
import BrandWordmark from '../brand/BrandWordmark'

const NAV = [
  { to: '/',          icon: LayoutDashboard, label: '作战总览' },
  { to: '/ctf',       icon: Target,          label: 'CTF 擂台' },
  { to: '/benchmark', icon: BarChart3,       label: '能力评测' },
  { to: '/tasks/new', icon: Crosshair,       label: '任务编排' },
  { to: '/tasks',     icon: List,            label: '任务列表' },
  { to: '/tools',     icon: Wrench,          label: '工具矩阵' },
  { to: '/finalops',  icon: Flag,            label: 'FinalOps' },
  { to: '/settings',  icon: Settings,        label: '系统设置' },
]

const Sidebar = memo(function Sidebar() {
  const [open, setOpen] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open])

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="打开导航菜单"
        aria-expanded={open}
        className="fixed top-4 left-4 z-30 md:hidden p-2 rounded-xl bg-obsidian-800/80 border border-obsidian-500/40 text-slate-400 hover:text-white"
      >
        <Menu size={20} />
      </button>
      {open && <div className="fixed inset-0 bg-black/60 z-30 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside
        ref={asideRef}
        role="navigation"
        aria-label="主导航"
        className={clsx(
          'fixed top-0 left-0 h-full w-64 bg-obsidian-900/95 backdrop-blur-md border-r border-obsidian-500/30 flex flex-col z-40 transition-transform duration-300',
          'md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-3 px-5 py-5 border-b border-obsidian-500/30">
          <ZhulongLogo size={32} glowing />
          <BrandWordmark />
          <button onClick={() => setOpen(false)} aria-label="关闭导航菜单" className="ml-auto md:hidden text-slate-400 hover:text-white"><X size={18} /></button>
        </div>
        <div className="px-5 py-2.5 border-b border-obsidian-500/20">
          <p className="text-xs text-slate-500 italic tracking-wide">烛照隐微 · 枢决攻防</p>
        </div>
        <nav className="flex-1 py-4 px-3 space-y-1">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to} to={to} end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) => clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all',
                isActive
                  ? 'bg-ember-500/10 text-ember-300 font-medium border-l-2 border-ember-400'
                  : 'text-slate-400 hover:bg-obsidian-700/40 hover:text-white',
              )}
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-obsidian-500/20">
          <p className="text-xs text-slate-600 leading-relaxed">
            仅用于授权 CTF / 靶场 / 教学<br/>严禁未授权攻击真实目标
          </p>
        </div>
      </aside>
    </>
  )
})

export default Sidebar
