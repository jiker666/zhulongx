import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <NavLink to="/runs" className="brand" aria-label="玄枢任务大厅">
            <span className="brand-mark" aria-hidden="true">玄</span>
            <span className="brand-copy">
              <strong>玄枢</strong>
              <small>XUANSHU</small>
            </span>
          </NavLink>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <div className="nav-caption">工作区</div>
          <NavLink to="/runs" className="nav-link">
            <span>任务大厅</span>
            <small>运行与审计</small>
          </NavLink>
          <NavLink to="/experiences" className="nav-link">
            <span>经验库</span>
            <small>已验证策略</small>
          </NavLink>
        </nav>

        <div className="sidebar-note">
          <span className="sidebar-note-title"><span className="status-dot" />策略引擎在线</span>
          <small>所有动作均受授权范围约束</small>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <span className="product-label">Autonomous Security Reasoning Runtime</span>
          <span className="topbar-status"><span className="status-dot" />Policy Engine</span>
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
