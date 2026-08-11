import { Link } from "react-router-dom";
export function NotFoundPage() { return <div className="state-panel page-not-found"><strong>页面不存在</strong><span>请返回系统总览继续浏览。</span><Link className="button secondary" to="/overview">返回系统总览</Link></div> }
