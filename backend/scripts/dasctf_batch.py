#!/usr/bin/env python3
"""
DASCTF 批量刷题脚本 — 烛龙·玄枢 ZHULONG-X

流程：
  1. 从 DASCTF API 拉取未解题列表
  2. 逐题启动靶机（获取目标 URL）
  3. 调用后端 /api/ctf/tasks 创建 CTF 任务
  4. 调用 /api/ctf/tasks/{id}/solve 启动 agent 解题
  5. 等待解题完成，收集 flag
  6. （可选）手动去 DASCTF 提交 flag

用法：
  python3 scripts/dasctf_batch.py --token DASCTF_JWT [--category WEB] [--difficulty Easy] [--limit 10] [--concurrency 1]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib3
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

urllib3.disable_warnings()

DASCTF_BASE = "https://ctf2.dasctf.com/api/v1"
ZHULONGX_BASE = "http://127.0.0.1:8000/api"
PRACTICE_GROUND_ID = "b9bbb32f-f186-458f-b90b-12440c0f6aea"

CATEGORY_MAP = {
    "WEB": "web",
    "CRYPTO": "crypto",
    "MISC": "misc",
    "PWN": "pwn",
    "REVERSE": "reverse",
}


class DasCTFClient:
    def __init__(self, token: str):
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def list_challenges(
        self,
        page: int = 1,
        page_size: int = 50,
        category: Optional[str] = None,
        difficulty: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        all_challenges = []
        target_cat = category.upper() if category else None
        max_pages = 5
        for p in range(1, max_pages + 1):
            params = {
                "page": p,
                "page_size": page_size,
                "sort_by": "solve_count",
                "sort_order": "asc",
            }
            url = f"{DASCTF_BASE}/practice/{PRACTICE_GROUND_ID}/challenges/"
            try:
                r = requests.get(url, params=params, headers=self.headers, timeout=30, verify=False)
                r.raise_for_status()
                data = r.json()["data"]
                page_challenges = data.get("data", [])
                if not page_challenges:
                    break
                all_challenges.extend(page_challenges)
                if target_cat and len([c for c in all_challenges if c["category"] == target_cat]) >= 20:
                    break
            except requests.exceptions.RequestException as e:
                print(f"  [!] page {p} request failed: {e}")
                break
        challenges = all_challenges
        if category:
            challenges = [c for c in challenges if c["category"] == category.upper()]
        if difficulty:
            challenges = [c for c in challenges if c["difficulty"] == difficulty]
        unsolved = [c for c in challenges if not c.get("is_solved")]
        return unsolved

    def start_target(self, challenge_id: str) -> Dict[str, Any]:
        url = f"{DASCTF_BASE}/practice/{PRACTICE_GROUND_ID}/challenges/{challenge_id}/target/"
        r = requests.post(url, params={"is_private": False}, headers=self.headers, timeout=30, verify=False)
        if r.status_code == 409:
            return self.get_target(challenge_id)
        r.raise_for_status()
        return r.json()["data"]

    def get_target(self, challenge_id: str) -> Dict[str, Any]:
        url = f"{DASCTF_BASE}/practice/{PRACTICE_GROUND_ID}/challenges/{challenge_id}/target/"
        r = requests.get(url, headers=self.headers, timeout=10, verify=False)
        r.raise_for_status()
        return r.json()["data"]

    def get_challenge_detail(self, challenge_id: str) -> Dict[str, Any]:
        url = f"{DASCTF_BASE}/practice/{PRACTICE_GROUND_ID}/challenges/{challenge_id}/"
        r = requests.get(url, headers=self.headers, timeout=10, verify=False)
        r.raise_for_status()
        return r.json()["data"]

    def get_challenge_files(self, challenge_id: str) -> List[Dict[str, Any]]:
        detail = self.get_challenge_detail(challenge_id)
        return detail.get("files", []) or []

    def download_file(self, file_url: str, dest_dir: str) -> Optional[str]:
        try:
            r = requests.get(file_url, headers=self.headers, timeout=30, verify=False, stream=True)
            r.raise_for_status()
            cd = r.headers.get("content-disposition", "")
            fname = "attachment"
            if "filename=" in cd:
                fname = cd.split("filename=")[-1].strip('"').strip("'")
            elif "filename*=" in cd:
                fname = cd.split("filename*=")[-1].strip('"').strip("'")
                if fname.startswith("UTF-8''"):
                    import urllib.parse
                    fname = urllib.parse.unquote(fname[7:])
            path = os.path.join(dest_dir, fname)
            with open(path, "wb") as f:
                for chunk in r.iter_content(8192):
                    f.write(chunk)
            return path
        except Exception as e:
            print(f"  [!] download failed: {e}")
            return None


class ZhulongXClient:
    def __init__(self, base_url: str = ZHULONGX_BASE):
        self.base_url = base_url

    def create_task(self, title: str, description: str, category: str, target_url: Optional[str] = None) -> str:
        payload = {
            "title": title,
            "description": description,
            "category": category,
            "authorized": True,
            "allow_network": True,
            "max_time_sec": 600,
        }
        if target_url:
            payload["description"] += f"\n\n靶机地址: {target_url}"
        r = requests.post(f"{self.base_url}/ctf/tasks", json=payload, timeout=15)
        r.raise_for_status()
        data = r.json()
        return data.get("task_id", data.get("id", ""))

    def upload_attachment(self, task_id: str, file_path: str) -> bool:
        try:
            with open(file_path, "rb") as f:
                files = {"file": (os.path.basename(file_path), f)}
                r = requests.post(
                    f"{self.base_url}/ctf/tasks/{task_id}/attachments",
                    files=files,
                    timeout=60,
                )
                return r.status_code == 200
        except Exception as e:
            print(f"  [!] upload failed: {e}")
            return False

    def start_solve(self, task_id: str) -> bool:
        r = requests.post(
            f"{self.base_url}/ctf/tasks/{task_id}/solve",
            json={"mode": "auto", "max_rounds": 0, "max_time_sec": 600},
            timeout=15,
        )
        return r.status_code == 200

    def get_task(self, task_id: str) -> Dict[str, Any]:
        r = requests.get(f"{self.base_url}/ctf/tasks/{task_id}", timeout=10)
        r.raise_for_status()
        return r.json()

    def stop_task(self, task_id: str) -> bool:
        try:
            r = requests.post(f"{self.base_url}/ctf/tasks/{task_id}/stop", timeout=10)
            return r.status_code == 200
        except Exception:
            return False

    def wait_for_solve(self, task_id: str, timeout: int = 600, poll: int = 8) -> Optional[str]:
        start = time.time()
        while time.time() - start < timeout:
            task = self.get_task(task_id)
            state = task.get("state", task.get("status", ""))
            flag = task.get("flag", task.get("best_flag", ""))
            is_running = task.get("is_running", False)
            terminal = ("DONE", "done", "FAILED", "failed", "HUMAN_REQUIRED", "human_required")
            if state in terminal:
                return flag
            if not is_running and state not in terminal:
                return flag
            time.sleep(poll)
        self.stop_task(task_id)
        return None

    def get_events(self, task_id: str) -> List[Dict[str, Any]]:
        r = requests.get(f"{self.base_url}/ctf/tasks/{task_id}/events", timeout=10)
        r.raise_for_status()
        return r.json() if r.json() else []


def solve_one(
    das: DasCTFClient,
    zx: ZhulongXClient,
    challenge: Dict[str, Any],
    download_dir: str,
    max_retries: int = 3,
) -> Optional[str]:
    cid = challenge["id"]
    name = challenge["name"]
    category = challenge.get("category", "UNKNOWN")
    difficulty = challenge.get("difficulty", "Unknown")
    description = challenge.get("description", "")

    print(f"\n{'='*60}")
    print(f"题目: [{category}] {name} ({difficulty})")
    print(f"ID: {cid}")

    target_url = ""
    print(f"  [1] 启动靶机...")
    try:
        target = das.start_target(cid)
        target_url = target.get("access_url", "")
        print(f"  靶机: {target_url}")
    except Exception as e:
        print(f"  [!] 启动靶机失败: {e}")

    print(f"  [2] 下载附件...")
    attachments = []
    files = das.get_challenge_files(cid)
    if files:
        task_dir = os.path.join(download_dir, cid)
        os.makedirs(task_dir, exist_ok=True)
        for f_info in files:
            f_url = f_info.get("url", f_info.get("download_url", ""))
            if f_url:
                saved = das.download_file(f_url, task_dir)
                if saved:
                    attachments.append(saved)
                    print(f"  下载: {os.path.basename(saved)}")

    cat_lower = CATEGORY_MAP.get(category, "web")
    full_desc = description if description else f"DASCTF 题目: {name}"
    if target_url:
        full_desc += f"\n\n靶机地址: {target_url}\n请用 curl 或 http_request 访问靶机地址进行测试。"

    last_evidence = ""
    for attempt in range(1, max_retries + 1):
        attempt_desc = full_desc
        if last_evidence:
            attempt_desc += f"\n\n--- 上次尝试失败的证据（请避免重复这些路径）---\n{last_evidence[:2000]}"

        if attempt > 1:
            print(f"\n  === 重试 #{attempt}/{max_retries} ===")
            attempt_desc += f"\n\n这是第 {attempt} 次尝试，请尝试不同的攻击路径。"

        print(f"  [3] 创建烛龙任务 (attempt {attempt})...")
        task_id = zx.create_task(
            title=f"[DASCTF] {name}" + (f" (retry {attempt})" if attempt > 1 else ""),
            description=attempt_desc,
            category=cat_lower,
            target_url=target_url,
        )
        print(f"  任务ID: {task_id}")

        for att in attachments:
            zx.upload_attachment(task_id, att)

        print(f"  [4] 启动 agent 解题...")
        if not zx.start_solve(task_id):
            print(f"  [!] 启动解题失败")
            continue

        print(f"  等待解题完成...")
        flag = zx.wait_for_solve(task_id, timeout=600 + (attempt - 1) * 120, poll=8)
        if flag:
            print(f"  FLAG: {flag}")
            return flag

        task = zx.get_task(task_id)
        state = task.get("state", "unknown")
        error = task.get("error", "")
        shell_history = task.get("shell_history", [])
        events = task.get("evidence", [])
        last_evidence = f"State: {state}\nError: {error}\n"
        if shell_history:
            cmds = [s.get("command", "")[:100] for s in shell_history[-10:]]
            last_evidence += f"Commands tried: {cmds}"
        if events:
            for e in events[-5:]:
                last_evidence += f"\n{e.get('step','')}: {e.get('output_summary','')[:200]}"

        print(f"  解题结束: {state} — {error[:80]}")

    print(f"  所有 {max_retries} 次尝试均未获得 flag")
    return None


def main():
    parser = argparse.ArgumentParser(description="DASCTF 批量刷题")
    parser.add_argument("--token", required=True, help="DASCTF JWT token")
    parser.add_argument("--category", default=None, help="题目类别: WEB/CRYPTO/MISC/PWN/REVERSE")
    parser.add_argument("--difficulty", default=None, help="难度: Easy/Medium/Hard")
    parser.add_argument("--limit", type=int, default=10, help="最大解题数")
    parser.add_argument("--concurrency", type=int, default=1, help="并发数(暂仅支持1)")
    parser.add_argument("--download-dir", default="/tmp/dasctf_downloads", help="附件下载目录")
    parser.add_argument("--page-size", type=int, default=50, help="每页拉取题数")
    parser.add_argument("--zhulongx-url", default=ZHULONGX_BASE, help="烛龙后端地址")
    parser.add_argument("--challenge-id", default=None, help="直接指定 DASCTF 题目 ID（跳过列表拉取）")
    parser.add_argument("--max-retries", type=int, default=3, help="每题最大重试次数")
    args = parser.parse_args()

    das = DasCTFClient(args.token)
    zx = ZhulongXClient(args.zhulongx_url)
    os.makedirs(args.download_dir, exist_ok=True)

    print("烛龙·玄枢 DASCTF 批量刷题")
    print(f"类别: {args.category or '全部'} | 难度: {args.difficulty or '全部'} | 上限: {args.limit}")

    if args.challenge_id:
        print(f"\n直接指定题目: {args.challenge_id}")
        detail = das.get_challenge_detail(args.challenge_id)
        challenges = [detail]
    else:
        print("\n拉取题目列表...")
        challenges = das.list_challenges(
            page=1, page_size=args.page_size,
            category=args.category, difficulty=args.difficulty,
        )
        print(f"找到 {len(challenges)} 道未解题")

    if not challenges:
        print("无未解题，退出")
        return

    challenges = challenges[:args.limit]

    results = []
    for i, ch in enumerate(challenges):
        print(f"\n--- [{i+1}/{len(challenges)}] ---")
        flag = solve_one(das, zx, ch, args.download_dir, max_retries=args.max_retries)
        results.append({
            "name": ch["name"],
            "category": ch["category"],
            "difficulty": ch.get("difficulty", ""),
            "id": ch["id"],
            "flag": flag,
            "solved": flag is not None,
        })

    print(f"\n{'='*60}")
    print("批量刷题结果汇总")
    print(f"{'='*60}")
    solved = [r for r in results if r["solved"]]
    print(f"总计: {len(results)} | 成功: {len(solved)} | 失败: {len(results) - len(solved)}")
    print()
    for r in results:
        status = "OK" if r["solved"] else "FAIL"
        print(f"  [{status}] [{r['category']}] {r['name']}: {r['flag'] or 'N/A'}")

    result_file = os.path.join(args.download_dir, "batch_results.json")
    with open(result_file, "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\n结果已保存: {result_file}")


if __name__ == "__main__":
    main()
