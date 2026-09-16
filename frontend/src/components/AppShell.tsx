import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, BookOpenCheck, GitBranch, Gauge, History, KeyRound, Library, ListTodo, Settings2, ShieldCheck, X } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { getServerToken, setServerToken } from "../api/client";
import { IconButton } from "./ui";

const navigationGroups: Array<{ caption: string; items: Array<{ to: string; label: string; detail: string; icon: typeof Gauge }> }> = [
  {
    caption: "运营",
    items: [
      { to: "/overview", label: "系统总览", detail: "运行与任务进度", icon: Gauge },
      { to: "/workbench", label: "任务工作台", detail: "提交与批量执行", icon: ListTodo },
      { to: "/campaigns", label: "自主编排", detail: "多 Agent 调查", icon: GitBranch },
      { to: "/runs", label: "运行审计", detail: "决策、证据与结论", icon: History },
    ],
  },
  {
    caption: "治理",
    items: [
      { to: "/experiences", label: "经验库", detail: "已验证策略", icon: Library },
      { to: "/capability", label: "能力与公示", detail: "维度统计与披露", icon: BarChart3 },
    ],
  },
  {
    caption: "配置",
    items: [
      { to: "/settings/model", label: "模型设置", detail: "端点与密钥", icon: Settings2 },
    ],
  },
];

export function AppShell() {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState(() => getServerToken());
  const [tokenError, setTokenError] = useState("");
  const tokenInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tokenConfigured = Boolean(getServerToken());

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const showToken = () => { setToken(getServerToken()); setTokenError("服务令牌无效或已过期，请重新连接控制面。"); setTokenOpen(true); };
    window.addEventListener("xuanshu:unauthorized", showToken);
    return () => window.removeEventListener("xuanshu:unauthorized", showToken);
  }, []);

  useEffect(() => {
    if (!tokenOpen) return;
    tokenInput.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setTokenOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tokenOpen]);

  useEffect(() => {
    if (!tokenOpen && trigger.current) { trigger.current.focus(); trigger.current = null; }
  }, [tokenOpen]);

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    const nextToken = token.trim();
    if (!nextToken) { setTokenError("请输入本次会话使用的服务令牌。"); tokenInput.current?.focus(); return; }
    setServerToken(nextToken);
    setToken(nextToken);
    setTokenError("");
    setTokenOpen(false);
    void queryClient.invalidateQueries();
  };

  const openTokenDialog = (event?: { currentTarget: EventTarget & HTMLElement }) => {
    trigger.current = event?.currentTarget ?? null;
    setToken(getServerToken());
    setTokenError("");
    setTokenOpen(true);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <NavLink to="/overview" className="brand" aria-label="玄枢系统总览">
            <span className="brand-mark" aria-hidden="true">玄</span>
            <span className="brand-copy">
              <strong>玄枢</strong>
              <small>XUANSHU</small>
            </span>
          </NavLink>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.caption}>
              <div className="nav-caption">{group.caption}</div>
              {group.items.map(({ to, label, detail, icon: Icon }) => (
                <NavLink key={to} to={to} className="nav-link">
                  <Icon className="nav-icon" size={17} strokeWidth={1.8} aria-hidden="true" />
                  <span className="nav-copy"><span>{label}</span><small>{detail}</small></span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="sidebar-note-title"><ShieldCheck size={15} aria-hidden="true" />策略护栏已启用</span>
          <small>主动能力由 operator scope 与预算共同约束</small>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <span className="product-label">玄枢 · 自主安全分析平台</span>
          <div className="topbar-actions">
            <span className="topbar-status"><span className="status-dot" />策略治理已启用</span>
            <IconButton className="topbar-icon-button" label={tokenConfigured ? "修改服务令牌" : "设置服务令牌"} onClick={(event) => openTokenDialog(event)}><KeyRound size={16} aria-hidden="true" /></IconButton>
          </div>
        </header>
        <main className="content"><Outlet /></main>
      </div>

      {tokenOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTokenOpen(false); }}>
          <form className="token-dialog" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title" onSubmit={submitToken}>
            <div className="dialog-header">
              <div><div className="eyebrow">ACCESS CONTROL</div><h2 id="token-dialog-title">服务令牌</h2></div>
              <IconButton className="icon-button" type="button" label="关闭" onClick={() => setTokenOpen(false)}><X size={17} aria-hidden="true" /></IconButton>
            </div>
            <label className="field-label" htmlFor="server-token">XUANSHU_SERVER_TOKEN</label>
            <input ref={tokenInput} id="server-token" type="password" autoComplete="current-password" value={token} onChange={(event) => { setToken(event.target.value); setTokenError(""); }} placeholder="输入服务令牌" aria-describedby="token-dialog-help token-dialog-error" />
            {tokenError && <div id="token-dialog-error" className="dialog-error" role="alert">{tokenError}</div>}
            <p id="token-dialog-help">令牌保存在本浏览器中（localStorage），不会写入运行材料。</p>
            <button className="button" type="submit">连接控制面</button>
          </form>
        </div>
      )}
    </div>
  );
}
