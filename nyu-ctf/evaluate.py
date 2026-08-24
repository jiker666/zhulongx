#!/usr/bin/env python3
"""
NYU CTF Bench evaluator.

Usage:
  python3 nyu-ctf/evaluate.py
    --bench-dir nyu-ctf/bench
    --runs-dir .xuan-shu/runs
    [--output nyu-ctf/results.json]

Reads each run's state.json, compares agent submission with the correct flag
from metadata/metadata.json, outputs accuracy per category and missed questions.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from collections import defaultdict


def normalize_flag(flag: str) -> str:
    """Normalize flag for comparison (strip whitespace, lowercase wrapper)."""
    flag = flag.strip()
    # Some flags might have extra whitespace or newlines inside
    flag = re.sub(r'\s+', '', flag)
    return flag


def flags_match(submitted: str, correct: str) -> bool:
    """Check if submitted flag matches correct flag."""
    if not submitted or not correct:
        return False
    # Exact match (case-sensitive)
    if submitted.strip() == correct.strip():
        return True
    # Normalize and compare
    if normalize_flag(submitted) == normalize_flag(correct):
        return True
    return False


def find_run_for_question(runs_dir: Path, question_path: str) -> dict | None:
    """Find the most recent run for a given question path (used as questionId)."""
    best = None
    best_time = ''
    for run_dir in runs_dir.iterdir():
        if not run_dir.is_dir():
            continue
        state_path = run_dir / 'state.json'
        if not state_path.exists():
            continue
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            continue
        meta = state.get('task', {}).get('metadata', {})
        # questionId in state is the relative path like test/2021/CSAW-Quals/web/no-pass-needed
        if meta.get('questionId') != question_path:
            continue
        t = state.get('finishedAt') or state.get('updatedAt') or ''
        if best is None or t > best_time:
            best = state
            best_time = t
    return best


def main():
    parser = argparse.ArgumentParser(description='NYU CTF Bench evaluator')
    parser.add_argument('--bench-dir', default='nyu-ctf/bench', help='Path to adapted bench dir')
    parser.add_argument('--runs-dir', default='.xuan-shu/runs', help='Path to runs dir')
    parser.add_argument('--output', default='nyu-ctf/results.json')
    args = parser.parse_args()

    bench_dir = Path(args.bench_dir).resolve()
    runs_dir = Path(args.runs_dir).resolve()

    # Load index
    index_path = bench_dir / 'nyu_ctf_index.json'
    if not index_path.exists():
        print(f'ERROR: index not found at {index_path}', file=sys.stderr)
        sys.exit(1)

    index = json.loads(index_path.read_text())
    print(f'Index: {len(index)} challenges')

    results = {}
    by_category = defaultdict(lambda: {'total': 0, 'solved': 0, 'failed': []})

    for chal_id, info in index.items():
        cat = info['category']
        correct_flag = info['flag']
        question_path = info['path']  # e.g. test/2021/CSAW-Quals/web/no-pass-needed
        by_category[cat]['total'] += 1

        state = find_run_for_question(runs_dir, question_path)
        if state is None:
            results[chal_id] = {
                'status': 'not_run',
                'category': cat,
                'name': info['name'],
                'correct_flag': correct_flag,
                'path': question_path,
            }
            by_category[cat]['failed'].append({'id': chal_id, 'reason': 'not_run'})
            continue

        submission = state.get('submission', '') or ''
        run_status = state.get('status', 'unknown')
        is_correct = flags_match(submission, correct_flag)
        run_id = state.get('id', '')

        result = {
            'status': run_status,
            'category': cat,
            'name': info['name'],
            'correct_flag': correct_flag,
            'submitted': submission,
            'correct': is_correct,
            'run_id': run_id,
            'path': question_path,
        }
        results[chal_id] = result

        if is_correct:
            by_category[cat]['solved'] += 1
        else:
            by_category[cat]['failed'].append({
                'id': chal_id,
                'name': info['name'],
                'run_status': run_status,
                'submitted': submission[:100] if submission else '(none)',
                'reason': 'wrong_flag' if submission else 'no_submission',
            })

    # Print summary
    total_solved = 0
    total_total = 0
    print('\n=== NYU CTF Bench Results ===\n')
    for cat in sorted(by_category.keys()):
        d = by_category[cat]
        n = d['total']
        s = d['solved']
        total_solved += s
        total_total += n
        pct = 100 * s / n if n > 0 else 0
        print(f'  {cat:12s}: {s:3d}/{n:3d} ({pct:.0f}%)')

    print(f'\n  {"TOTAL":12s}: {total_solved:3d}/{total_total:3d} ({100*total_solved/total_total:.0f}%)')

    print('\n=== Failed Challenges ===\n')
    for cat in sorted(by_category.keys()):
        fails = by_category[cat]['failed']
        if fails:
            print(f'[{cat}]')
            for f in fails:
                print(f"  - {f['id']}: {f.get('reason','?')} | submitted: {f.get('submitted','')[:60]}")

    # Write output
    output = {
        'summary': {cat: {'total': d['total'], 'solved': d['solved']} for cat, d in by_category.items()},
        'total': total_total,
        'total_solved': total_solved,
        'accuracy': total_solved / total_total if total_total > 0 else 0,
        'challenges': results,
    }
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False) + '\n')
    print(f'\nResults written to {out_path}')


if __name__ == '__main__':
    main()
