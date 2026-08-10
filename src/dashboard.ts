export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>玄枢 · 智能安全作战舱</title></head>
<body style="margin:0;background:#07100f;color:#e8f4ef;font:16px system-ui,sans-serif">
  <main style="max-width:720px;margin:12vh auto;padding:32px">
    <h1>玄枢 · 智能安全作战舱</h1>
    <p>前端生产资源尚未构建。请在 <code>frontend</code> 目录运行 <code>npm run build</code>，或使用 <code>npm run dev</code> 启动开发服务器。</p>
    <p><a href="/health" style="color:#43d6aa">检查服务健康状态</a></p>
  </main>
</body></html>`;
}
