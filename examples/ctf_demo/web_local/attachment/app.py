"""
Mini Flask Target - 烛龙·玄枢 本地 Web 靶场 demo。

仅监听 127.0.0.1，仅用于教学/CTF。
启动：
    python3 app.py
    # 或由 orchestrator 自动启动：HOST=127.0.0.1 PORT=5001 python3 app.py
访问：
    http://127.0.0.1:PORT/
    http://127.0.0.1:PORT/api/profile?user=admin
    http://127.0.0.1:PORT/source
"""
import os
from flask import Flask, jsonify, request, abort

app = Flask(__name__)

USERS = {
    "guest":  {"user": "guest",  "role": "viewer",   "secret": "(none)"},
    "admin":  {"user": "admin",  "role": "admin",    "secret": "flag{w3b_s0urce_l34k_cl4ss1c}"},
}


@app.route("/")
def index():
    # 故意暴露源码路径（源码泄漏题）
    return """
    <h1>ZHULONG-X Mini Target</h1>
    <p>Endpoints:</p>
    <ul>
        <li><code>GET /api/profile?user=NAME</code></li>
        <li><code>GET /source</code> (源码泄漏)</li>
    </ul>
    """


@app.route("/api/profile")
def profile():
    user = request.args.get("user", "guest")
    info = USERS.get(user)
    if not info:
        abort(404)
    # 对外屏蔽 secret 字段（除非有 admin token）
    token = request.headers.get("X-Admin-Token")
    show_secret = (token == "zhulongx-admin-token")
    if not show_secret:
        return jsonify({k: v for k, v in info.items() if k != "secret"})
    return jsonify(info)


@app.route("/source")
def source():
    # 故意暴露源码（web 题经典考点）
    with open(__file__, "r", encoding="utf-8") as f:
        return f.read(), 200, {"Content-Type": "text/plain"}


if __name__ == "__main__":
    # ⚠️ 仅绑定 127.0.0.1，不暴露到外网
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=False)
