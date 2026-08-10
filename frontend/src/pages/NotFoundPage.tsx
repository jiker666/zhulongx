import { Link } from "react-router-dom";
export function NotFoundPage() { return <div className="state-panel page-not-found"><strong>页面不存在</strong><span>请返回任务大厅继续浏览。</span><Link className="button secondary" to="/runs">返回任务大厅</Link></div> }
