import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ loading, disabledReason, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; disabledReason?: string }) {
  const isDisabled = disabled || loading;
  return <button {...props} disabled={isDisabled} title={isDisabled ? disabledReason : props.title}>{loading ? "处理中…" : children}</button>;
}
export function IconButton({ label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) { return <Button {...props} aria-label={label} title={props.title ?? label}>{props.children}</Button>; }
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function LoadingState({ label = "正在读取任务状态…" }: { label?: string }) { return <div className="state-panel"><span className="spinner" aria-hidden="true" />{label}</div>; }
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="state-panel error-state"><strong>数据加载失败</strong><span>{message}</span><Button className="button secondary" onClick={onRetry}>重新加载</Button></div>; }
export function EmptyState({ title = "暂无任务记录", description = "当前服务没有可展示的运行数据。" }: { title?: string; description?: string }) { return <div className="state-panel"><strong>{title}</strong><span>{description}</span></div>; }
