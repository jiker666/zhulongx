"""
Web Local Source Leak + Parameter Bypass Target - 烛龙·玄枢 本地 Web 靶场。

仅监听 127.0.0.1，仅用于教学/CTF。
启动：HOST=127.0.0.1 PORT=5001 python3 app.py
"""
import os
from flask import Flask, jsonify, request, abort

app = Flask(__name__)

USERS = {
    "guest":  {"user": "guest",  "role": "viewer",   "secret": "(none)"},
    "admin":  {"user": "admin",  "role": "admin",    "secret": "flag{web_source_leak_bypass_admin}"},
}


@app.route("/")
def index():
    return """
    <h1>ZHULONG-X Web Target</h1>
    <p>Endpoints:</p>
    <ul>
        <li><code>GET /api/login?user=NAME</code> (需要 X-Admin-Token header for admin)</li>
        <li><code>GET /source</code> (源码泄漏)</li>
    </ul>
    """


@app.route("/api/login")
def login():
    user = request.args.get("user", "guest")
    info = USERS.get(user)
    if not info:
        abort(404)
    # admin 需要 X-Admin-Token
    token = request.headers.get("X-Admin-Token")
    if user == "admin" and token != "zhulongx-admin-bypass":
        return jsonify({"error": "admin requires X-Admin-Token: zhulongx-admin-bypass"}), 403
    # token 正确则返回完整信息
    return jsonify(info)


@app.route("/source")
def source():
    # 故意暴露源码（web 题经典考点）
    with open(__file__, "r", encoding="utf-8") as f:
        return f.read(), 200, {"Content-Type": "text/plain"}


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=False)
