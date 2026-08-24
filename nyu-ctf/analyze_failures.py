#!/usr/bin/env python3
"""
NYU CTF Bench wrong-question analyzer.

Reads evaluate.py output (results.json) + run audit logs,
generates a structured failure report with patterns,
and writes improvement suggestions back to arena-wrong-questions compatible format.

Usage:
  python3 nyu-ctf/analyze_failures.py
    --results nyu-ctf/results.json
    --runs-dir .xuan-shu/runs
    --output nyu-ctf/failure_report.md
"""

import argparse
import json
import re
import sys
from pathlib import Path
from collections import defaultdict


FAILURE_PATTERNS = [
    # (regex on audit events / summary text, pattern name, description)
    (r'0 run_command', 'no_tools', 'Agent made 0 run_command calls — never used shell tools'),
    (r'finish_task.*blocked', 'gave_up', 'Agent gave up (finish_task blocked) without finding flag'),
    (r'flag\{[^}]+\}.*blocked', 'flag_seen_not_submitted', 'Flag was in response but agent called blocked instead of submitting'),
    (r'WEB_ACTION_POLICY_REJECTED.*[2-9]\d|WEB_ACTION_POLICY_REJECTED.*[1-9]\d\d', 'policy_blocked', 'Many policy rejections — sandbox blocked required tools'),
    (r'SIGTERM|timedOut.*true', 'timeout', 'Command timed out'),
    (r'ImportError|ModuleNotFoundError', 'import_error', 'Python import error (likely stdlib name collision)'),
    (r'enum\.py|re\.py|os\.py|sys\.py', 'stdlib_collision', 'Script file named same as stdlib module'),
    (r'500.*all.*inputs|all.*500', 'login_500', 'Login endpoint returns 500 for all inputs'),
    (r'no.*session.*cookie|cookie.*not.*found', 'no_cookie', 'Could not obtain session cookie'),
    (r'fetch failed|connection.*refused|timeout.*http', 'network_error', 'Network errors (service unreachable)'),
    (r'brute.forc|wordlist|rockyou|flask-unsign', 'attempted_brute', 'Attempted brute-force / flask-unsign'),
    (r'\.git|static.*app\.py|proc/self/environ', 'source_leak', 'Tried source code leak paths'),
    (r'docker|compose|container', 'docker_issue', 'Docker/compose related issue'),
]


def load_audit(runs_dir: Path, run_id: str) -> list[dict]:
    audit_path = runs_dir / run_id / 'audit.jsonl'
    if not audit_path.exists():
        return []
    events = []
    for line in audit_path.read_text().splitlines():
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    return events


def summarize_run(state: dict, audit_events: list[dict]) -> dict:
    """Extract key stats from a run."""
    tool_counts = defaultdict(int)
    policy_rejected = 0
    for ev in audit_events:
        if ev.get('type') == 'tool.started':
            d = ev.get('data', {})
            if isinstance(d, dict):
                tool_counts[d.get('toolName', d.get('name', '?'))] += 1
        elif ev.get('type') == 'WEB_ACTION_POLICY_REJECTED':
            policy_rejected += 1

    summary_text = state.get('summary', '') or ''
    submission = state.get('submission', '') or ''
    status = state.get('status', '')
    turns = state.get('turnCount', 0)

    # Count http_request calls
    http_requests = sum(v for k, v in tool_counts.items() if 'http' in k.lower())
    run_commands = tool_counts.get('run_command', 0)
    knowledge_lookups = tool_counts.get('web_knowledge_lookup', 0)

    # Detect patterns
    full_text = summary_text + ' ' + submission + ' ' + ' '.join(
        str(ev) for ev in audit_events[-20:]
    )
    detected_patterns = []
    for pattern, name, desc in FAILURE_PATTERNS:
        if re.search(pattern, full_text, re.IGNORECASE):
            detected_patterns.append({'name': name, 'desc': desc})

    return {
        'status': status,
        'turns': turns,
        'tool_counts': dict(tool_counts),
        'http_requests': http_requests,
        'run_commands': run_commands,
        'knowledge_lookups': knowledge_lookups,
        'policy_rejected': policy_rejected,
        'submission': submission[:200] if submission else '',
        'summary_excerpt': summary_text[:500] if summary_text else '',
        'patterns': detected_patterns,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--results', default='nyu-ctf/results.json')
    parser.add_argument('--runs-dir', default='.xuan-shu/runs')
    parser.add_argument('--output', default='nyu-ctf/failure_report.md')
    args = parser.parse_args()

    results_path = Path(args.results)
    runs_dir = Path(args.runs_dir).resolve()
    output_path = Path(args.output)

    if not results_path.exists():
        print(f'ERROR: results not found: {results_path}')
        sys.exit(1)

    data = json.loads(results_path.read_text())
    challenges = data.get('challenges', {})

    # Collect failures
    failures = []
    for chal_id, info in challenges.items():
        if info.get('correct'):
            continue
        run_id = info.get('run_id', '')
        audit = load_audit(runs_dir, run_id) if run_id else []

        # Get state
        state = {}
        if run_id:
            state_path = runs_dir / run_id / 'state.json'
            if state_path.exists():
                try:
                    state = json.loads(state_path.read_text())
                except Exception:
                    pass

        run_summary = summarize_run(state, audit) if state else {}
        failures.append({
            'id': chal_id,
            'category': info.get('category', '?'),
            'name': info.get('name', '?'),
            'status': info.get('status', '?'),
            'submitted': info.get('submitted', ''),
            'correct_flag': info.get('correct_flag', ''),
            'run_id': run_id,
            'run_summary': run_summary,
        })

    # Group by category
    by_cat = defaultdict(list)
    for f in failures:
        by_cat[f['category']].append(f)

    # Pattern frequency
    pattern_freq = defaultdict(int)
    for f in failures:
        for p in f.get('run_summary', {}).get('patterns', []):
            pattern_freq[p['name']] += 1

    # Generate report
    lines = [
        '# NYU CTF Bench — Failure Analysis Report',
        '',
        f'Generated: {__import__("datetime").datetime.now().isoformat()}',
        '',
        f'Total failures: {len(failures)}',
        '',
        '## Pattern Summary',
        '',
        '| Pattern | Count | Description |',
        '|---------|-------|-------------|',
    ]
    for name, count in sorted(pattern_freq.items(), key=lambda x: -x[1]):
        desc = next((d for _, n, d in FAILURE_PATTERNS if n == name), name)
        lines.append(f'| `{name}` | {count} | {desc} |')

    lines += ['', '## Failures by Category', '']
    for cat in sorted(by_cat.keys()):
        cat_fails = by_cat[cat]
        lines.append(f'### {cat.upper()} ({len(cat_fails)} failures)')
        lines.append('')
        for f in cat_fails:
            rs = f.get('run_summary', {})
            patterns = ', '.join(p['name'] for p in rs.get('patterns', []))
            lines.append(f"**{f['id']}** (`{f['name']}`)")
            lines.append(f"- Status: {f['status']}")
            lines.append(f"- Submitted: `{(f['submitted'] or '(none)')[:80]}`")
            lines.append(f"- Correct: `{(f['correct_flag'] or '?')[:80]}`")
            if rs:
                lines.append(f"- Tools: http={rs.get('http_requests',0)}, run_cmd={rs.get('run_commands',0)}, turns={rs.get('turns',0)}")
                lines.append(f"- Policy rejected: {rs.get('policy_rejected',0)}")
            if patterns:
                lines.append(f"- Patterns: {patterns}")
            if rs.get('summary_excerpt'):
                lines.append(f"- Summary: {rs['summary_excerpt'][:200]}")
            lines.append('')

    lines += [
        '## Improvement Recommendations',
        '',
        '### Based on failure patterns:',
        '',
    ]

    recs = []
    if pattern_freq.get('no_tools', 0) > 2:
        recs.append('- **no_tools**: Agent relies on http_request loops instead of run_command scripts. '
                    'Strengthen exploit-agent rule: use run_command for any repetitive task (>3 similar calls).')
    if pattern_freq.get('flag_seen_not_submitted', 0) > 0:
        recs.append('- **flag_seen_not_submitted**: Flag was visible but not submitted. '
                    'Strengthen flagContract and add regex scan of all HTTP response bodies before calling finish_task(blocked).')
    if pattern_freq.get('import_error', 0) > 0 or pattern_freq.get('stdlib_collision', 0) > 0:
        recs.append('- **import_error/stdlib_collision**: Python scripts named after stdlib modules. '
                    'Add explicit rule: never name scripts enum.py, re.py, os.py, sys.py, etc.')
    if pattern_freq.get('login_500', 0) > 1:
        recs.append('- **login_500**: Login 500 on all inputs. '
                    'Strengthen recon: when login always returns 500, immediately pivot to source code leak.')
    if pattern_freq.get('policy_blocked', 0) > 2:
        recs.append('- **policy_blocked**: Sandbox blocking required tools. '
                    'Review allowedPrograms and readOnlyPaths in config.')
    if pattern_freq.get('docker_issue', 0) > 1:
        recs.append('- **docker_issue**: Docker/compose problems. '
                    'Ensure docker is running and compose files are valid before running batch.')
    if not recs:
        recs.append('- No dominant patterns detected. Review individual failures above.')

    lines.extend(recs)
    lines.append('')

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'Report written to {output_path}')
    print(f'Total failures analyzed: {len(failures)}')
    print('Top patterns:')
    for name, count in sorted(pattern_freq.items(), key=lambda x: -x[1])[:5]:
        print(f'  {name}: {count}')


if __name__ == '__main__':
    main()
