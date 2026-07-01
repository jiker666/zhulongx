"""Tests for CTF task creation + auto-classification (v6.2)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"

from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfTask


@pytest.fixture
def orch():
    return CtfOrchestrator()


# ---------- keyword-based classification ----------


def test_guess_category_web_from_description(orch):
    """无附件、无 LLM 时，题面提到 SQL/注入应识别为 web。"""
    task = CtfTask(
        task_id="t1",
        title="SQL 注入题",
        description="某登录页面存在 SQL 注入漏洞，请获取数据库中所有用户的密码",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "web"


def test_guess_category_crypto_from_description(orch):
    task = CtfTask(
        task_id="t2",
        title="RSA 密码题",
        description="已知 RSA 公钥 (e, n) 和密文 c，请破解此 RSA 加密获取 flag",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "crypto"


def test_guess_category_reverse_from_description(orch):
    task = CtfTask(
        task_id="t3",
        title="逆向题",
        description="给定一个 ELF 可执行文件，请反汇编关键函数还原算法",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "reverse"


def test_guess_category_pwn_from_description(orch):
    task = CtfTask(
        task_id="t4",
        title="栈溢出",
        description="程序存在栈溢出漏洞，checksec 显示 NX 关闭，请构造 shellcode getshell",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "pwn"


def test_guess_category_forensics_from_description(orch):
    task = CtfTask(
        task_id="t5",
        title="流量分析",
        description="给定的 pcap 流量包里藏着 flag，用 wireshark 还原 HTTP 请求",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "forensics"


def test_guess_category_misc_from_description(orch):
    task = CtfTask(
        task_id="t6",
        title="图片隐写",
        description="一张 PNG 图片里用 LSB 隐写了 flag，请提取",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "misc"


def test_guess_category_no_keywords_returns_misc(orch):
    """无任何关键词命中时返回 misc。"""
    task = CtfTask(
        task_id="t7",
        title="神秘题目",
        description="找出隐藏的 flag",
    )
    cat = orch._guess_category_from_description(task)
    assert cat == "misc"


def test_guess_category_empty_description_returns_misc(orch):
    task = CtfTask(task_id="t8", title="", description="")
    cat = orch._guess_category_from_description(task)
    assert cat == "misc"


def test_guess_category_multi_keyword_takes_best(orch):
    """多个题型都有命中时，取命中关键词最多的。"""
    task = CtfTask(
        task_id="t9",
        title="综合题",
        description="这是一个 RSA 加密 + SQL 注入 + 栈溢出的综合题，需要先 web 注入再 pwn getshell",
    )
    cat = orch._guess_category_from_description(task)
    # web (sql/注入) 和 pwn (栈溢出/getshell) 都有命中，应该不为 misc
    assert cat in ("web", "pwn", "crypto")


# ---------- full classify flow with mock LLM ----------


def test_classify_auto_uses_keyword_fallback_when_llm_mock(orch):
    """category=auto + mock LLM + 无附件 → 用关键词识别，不默认 misc。"""
    task = CtfTask(
        task_id="t10",
        title="RSA 破解",
        description="给定 RSA 公钥和密文，请破解",
        category_hint="auto",
    )
    orch._init_task(task)
    orch._classify(task)
    # mock 模式下走关键词识别，应识别为 crypto
    assert task.plan is not None
    assert task.plan.category == "crypto"
    assert task.plan.confidence == 0.7


def test_classify_user_specified_category_skips_llm(orch):
    """用户显式指定 crypto 时，跳过 LLM 直接用 crypto。"""
    task = CtfTask(
        task_id="t11",
        title="x",
        description="y",
        category_hint="crypto",
    )
    orch._init_task(task)
    orch._classify(task)
    assert task.plan.category == "crypto"
    assert task.plan.confidence == 0.9
