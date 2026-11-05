#!/usr/bin/env python3
"""Race/TOCTOU one-shot harness skeleton(公开方法论模板,与具体靶标无关).

复制到 attack/<题号>/ 下,填 setup / attempt / verify 三个函数即可用。
设计要点(实战教训内化):
- Barrier 同步起跑:N 线程同一瞬间打同一窗口,不是 for 循环顺序并发;
- 一轮内自洽:每轮 setup() 现场重建前置(登录/构造对象),不依赖上一轮残留;
- 一次脚本跑完全部轮次:dump 前置 → race → 验增量 → 失败自动加码重试;
- 线程各自持独立 Session(共享同一份 cookie 快照),避免连接池串行化把窗口磨没;
- 目标可能被平台轮换:所有结果当场打印落盘,不写跨进程状态。
"""
import threading, time, sys, requests
from concurrent.futures import ThreadPoolExecutor

CONFIG = dict(
    base="http://TARGET",   # 目标基址
    threads=16,             # 起跑线程数(窗口越窄加越大,32/64 一档一档试)
    rounds=8,               # 总轮数(每轮自动重置场景再 race)
    timeout=8,
    creds=("user", "pass"), # setup() 用;从台账/题面取
)

def log(msg): print(msg, flush=True)

def new_session() -> requests.Session:
    """每线程独立 Session,共享 cookie 快照(由 setup 阶段采集)。"""
    s = requests.Session()
    for k, v in SHARED_COOKIES.items():
        s.cookies.set(k, v)
    s.headers.update(SHARED_HEADERS)
    return s

SHARED_COOKIES, SHARED_HEADERS = {}, {}

def setup() -> None:
    """每轮开始前:登录/构造前置对象。失败抛异常=整轮放弃。"""
    raise NotImplementedError("填:拿到会话/构造好竞争对象,把 cookie 写进 SHARED_COOKIES")

def attempt(s: requests.Session, i: int) -> object:
    """第 i 号线程的攻击请求(全部线程 barrier 后同时打)。返回可判胜特征。"""
    raise NotImplementedError("填:一发攻击请求")

def verify(s: requests.Session) -> bool:
    """赛后验证:flag/越权对象/余额增量到手与否。"""
    raise NotImplementedError("填:验证增量")

def one_round(no: int) -> bool:
    SHARED_COOKIES.clear(); SHARED_HEADERS.clear()
    setup()
    barrier = threading.Barrier(CONFIG["threads"])
    results = [None] * CONFIG["threads"]
    def worker(i):
        s = new_session()
        barrier.wait()
        try: results[i] = attempt(s, i)
        except Exception as e: results[i] = f"ERR {e}"
    ts = [threading.Thread(target=worker, args=(i,)) for i in range(CONFIG["threads"])]
    t0 = time.time()
    [t.start() for t in ts]; [t.join() for t in ts]
    ok = verify(new_session())
    log(f"round {no}: win={ok} elapsed={time.time()-t0:.1f}s sample={results[:3]}")
    return ok

if __name__ == "__main__":
    for r in range(1, CONFIG["rounds"] + 1):
        if one_round(r):
            log(f"WIN at round {r}"); sys.exit(0)
        time.sleep(1)
    log("no win — 提高 threads/换窗口语义后重试,或写台账转面")
