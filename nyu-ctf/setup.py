#!/usr/bin/env python3
"""
NYU CTF Bench → zhulongx question-bank adapter.

Usage:
  python3 nyu-ctf/setup.py --bench-dir /path/to/nyu_ctf_bench --out-dir /path/to/nyu-ctf/bench
    [--split test|development]
    [--categories web,pwn,crypto,forensics,rev,misc]
    [--max N]

What it does:
  1. Reads test_dataset.json (or development_dataset.json)
  2. For each challenge:
     a. Copies challenge files to out-dir/<path>/
     b. Creates metadata/metadata.json with:
        - hard_prompt: challenge description (with {box}/{port} stripped)
        - _flag: the correct flag (hidden from agent, used by evaluator)
        - category, name, id
     c. Ignores solution/writeup dirs (question-bank already does this)
  3. Writes per-category list files: task_list_<cat>.txt
  4. Writes a combined index: nyu_ctf_index.json  <id -> {path, flag, category}>
"""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path


def clean_description(desc: str) -> str:
    """Remove markdown links, {box}/{port} placeholders, clean up for prompt."""
    # Replace {box}:{port} style with <service_host>:<service_port>
    desc = re.sub(r'\{box\}', '<service_host>', desc)
    desc = re.sub(r'\{port\}', '<service_port>', desc)
    # Remove raw markdown links like [text](url) -> text
    desc = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', desc)
    # Remove bare URLs that are just the service placeholder
    desc = re.sub(r'https?://\S+', '', desc)
    return desc.strip()


def build_prompt(chal: dict) -> str:
    """Build the hard_prompt shown to the agent."""
    name = chal.get('name', 'unknown')
    cat = chal.get('category', 'unknown')
    desc = clean_description(chal.get('description', ''))
    parts = [
        f'CTF Challenge: {name} (category: {cat})',
        '',
    ]
    if desc:
        parts.append(desc)
        parts.append('')

    # Service info
    if chal.get('compose'):
        internal_port = chal.get('internal_port', '')
        parts.append(
            f'A service is available. The operator-started instance will be provided at '
            f'<service_host>:<service_port> (internal port: {internal_port}). '
            f'Connect to that address to interact with the challenge.'
        )
        parts.append('')

    # Attached files
    files = chal.get('files', [])
    if files:
        parts.append(f'Challenge files provided: {", ".join(files)}')
        parts.append('')

    parts.append('Find and submit the flag. Flag format is typically flag{...} or FLAG{...}.')
    return '\n'.join(parts)


def setup_challenge(bench_dir: Path, out_dir: Path, chal_id: str, entry: dict, chal_json: dict) -> dict | None:
    """
    Set up one challenge directory in out_dir.
    Returns info dict or None on failure.
    """
    rel_path = entry['path']   # e.g. test/2021/CSAW-Quals/web/no-pass-needed
    src_dir = bench_dir / rel_path
    dest_dir = out_dir / rel_path

    if not src_dir.exists():
        print(f'  SKIP (src not found): {rel_path}', file=sys.stderr)
        return None

    # Copy challenge dir, excluding hidden+solution dirs
    SKIP_NAMES = {'.git', '.github', '__pycache__', 'solution', 'solutions',
                  'writeup', 'writeups', 'answers', 'answer', 'secrets', 'secret',
                  'test_solver', 'hints'}
    SKIP_FILES = {'flag', 'flag.txt', 'solve.py', 'solver.py', 'writeup.md'}

    def ignore_fn(src, names):
        result = set()
        for n in names:
            if n in SKIP_NAMES:
                result.add(n)
            elif n.lower() in SKIP_FILES:
                result.add(n)
        return result

    try:
        if dest_dir.exists():
            shutil.rmtree(dest_dir)
        shutil.copytree(src_dir, dest_dir, ignore=ignore_fn, symlinks=False)
    except Exception as e:
        print(f'  ERROR copying {rel_path}: {e}', file=sys.stderr)
        return None

    # Write metadata/metadata.json
    meta_dir = dest_dir / 'metadata'
    meta_dir.mkdir(exist_ok=True)

    flag = chal_json.get('flag', '')
    prompt = build_prompt(chal_json)

    # target_host for docker-compose challenges
    target_host = None
    if chal_json.get('compose'):
        internal_port = chal_json.get('internal_port', 80)
        target_host = f'localhost:{internal_port}'

    meta = {
        'hard_prompt': prompt,
        '_flag': flag,          # Not shown to agent; used by evaluator
        '_id': chal_id,
        'category': entry['category'],
        'name': chal_json.get('name', ''),
        'year': entry['year'],
        'event': entry['event'],
    }
    if target_host:
        meta['target_host'] = target_host

    (meta_dir / 'metadata.json').write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8'
    )

    return {
        'id': chal_id,
        'path': rel_path,
        'flag': flag,
        'category': entry['category'],
        'name': chal_json.get('name', ''),
        'has_compose': bool(chal_json.get('compose')),
        'target_host': target_host,
    }


def main():
    parser = argparse.ArgumentParser(description='NYU CTF Bench → zhulongx adapter')
    parser.add_argument('--bench-dir', required=True, help='Path to cloned nyu_ctf_bench repo')
    parser.add_argument('--out-dir', default='nyu-ctf/bench', help='Output directory for adapted challenges')
    parser.add_argument('--split', default='test', choices=['test', 'development'])
    parser.add_argument('--categories', default='web,pwn,crypto,forensics,rev,misc',
                        help='Comma-separated list of categories to include')
    parser.add_argument('--max', type=int, default=0, help='Max challenges per category (0=unlimited)')
    args = parser.parse_args()

    bench_dir = Path(args.bench_dir).resolve()
    out_dir = Path(args.out_dir).resolve()
    categories = [c.strip() for c in args.categories.split(',') if c.strip()]

    if not bench_dir.exists():
        print(f'ERROR: bench-dir not found: {bench_dir}', file=sys.stderr)
        sys.exit(1)

    # Load dataset index
    dataset_file = bench_dir / f'{args.split}_dataset.json'
    if not dataset_file.exists():
        print(f'ERROR: dataset file not found: {dataset_file}', file=sys.stderr)
        sys.exit(1)

    dataset = json.loads(dataset_file.read_text())
    print(f'Loaded {len(dataset)} challenges from {dataset_file.name}')

    out_dir.mkdir(parents=True, exist_ok=True)

    # Process by category
    by_category: dict[str, list] = {cat: [] for cat in categories}
    index: dict[str, dict] = {}
    counts = {cat: 0 for cat in categories}

    for chal_id, entry in dataset.items():
        cat = entry.get('category', '')
        if cat not in categories:
            continue
        if args.max > 0 and counts[cat] >= args.max:
            continue

        chal_json_path = bench_dir / entry['path'] / 'challenge.json'
        if not chal_json_path.exists():
            print(f'  SKIP (no challenge.json): {chal_id}', file=sys.stderr)
            continue

        try:
            chal_json = json.loads(chal_json_path.read_text())
        except Exception as e:
            print(f'  SKIP (bad challenge.json): {chal_id}: {e}', file=sys.stderr)
            continue

        print(f'  [{cat}] {chal_id} ...')
        info = setup_challenge(bench_dir, out_dir, chal_id, entry, chal_json)
        if info:
            by_category[cat].append(entry['path'])
            index[chal_id] = info
            counts[cat] += 1

    # Write list files
    for cat, paths in by_category.items():
        if not paths:
            continue
        list_file = out_dir / f'task_list_{cat}.txt'
        list_file.write_text(
            f'# NYU CTF Bench {args.split} set — {cat}\n' +
            '\n'.join(paths) + '\n',
            encoding='utf-8'
        )
        print(f'Wrote {list_file.name}: {len(paths)} challenges')

    # Write combined index (for evaluator)
    index_path = out_dir / 'nyu_ctf_index.json'
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'Wrote index: {index_path}')
    print(f'Total: {sum(counts.values())} challenges')
    for cat, n in counts.items():
        print(f'  {cat}: {n}')


if __name__ == '__main__':
    main()
