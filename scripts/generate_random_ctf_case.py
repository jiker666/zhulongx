#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import codecs
import gzip
import json
import random
import secrets
import shutil
import string
import urllib.parse
import zlib
from pathlib import Path
from typing import Any, Dict, List, Tuple


ROOT = Path(__file__).resolve().parents[1]
GENERATED_ROOT = ROOT / "ctf_cases" / "generated"


def _token(rng: random.Random, length: int) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(rng.choice(alphabet) for _ in range(length))


def _mostly_printable(data: bytes) -> bool:
    if not data:
        return False
    printable = sum(1 for b in data if b in b"\n\r\t" or 32 <= b < 127)
    return printable / len(data) > 0.9


def _apply_layer(data: bytes, layer: str, rng: random.Random) -> Tuple[bytes, List[str]]:
    text = data.decode("utf-8", errors="ignore")
    if layer == "base64":
        return base64.b64encode(data), ["base64"]
    if layer == "hex":
        return data.hex().encode("ascii"), ["hex"]
    if layer == "rot13" and _mostly_printable(data):
        return codecs.decode(text, "rot_13").encode("utf-8"), ["rot13"]
    if layer == "url" and _mostly_printable(data):
        return urllib.parse.quote(text, safe="").encode("ascii"), ["url"]
    if layer == "xor":
        key = rng.randint(1, 255)
        xored = bytes(b ^ key for b in data)
        return xored.hex().encode("ascii"), [f"xor_single_byte_0x{key:02x}", "hex"]
    if layer == "gzip":
        return base64.b64encode(gzip.compress(data)), ["gzip", "base64"]
    if layer == "zlib":
        return base64.b64encode(zlib.compress(data)), ["zlib", "base64"]
    return base64.b64encode(data), ["base64"]


def encode_flag(flag: str, rng: random.Random, min_layers: int = 2, max_layers: int = 5) -> Tuple[str, List[str]]:
    target_layers = rng.randint(min_layers, max_layers)
    allowed = ["base64", "hex", "rot13", "url", "xor", "gzip", "zlib"]
    data = flag.encode("utf-8")
    chain: List[str] = []
    attempts = 0
    while len(chain) < target_layers and attempts < 40:
        attempts += 1
        layer = rng.choice(allowed)
        encoded, added = _apply_layer(data, layer, rng)
        if len(chain) + len(added) > max_layers:
            continue
        data = encoded
        chain.extend(added)
    while len(chain) < min_layers:
        data = base64.b64encode(data)
        chain.append("base64")
    return data.decode("ascii", errors="ignore"), chain


def generate_case(output_root: Path | None = None, seed: int | None = None) -> Dict[str, Any]:
    rng = random.Random(seed if seed is not None else secrets.randbits(64))
    root = output_root or GENERATED_ROOT
    root.mkdir(parents=True, exist_ok=True)
    base_case_id = f"random_case_{_token(rng, 10)}"
    case_id = base_case_id
    case_dir = root / case_id
    counter = 1
    while case_dir.exists():
        case_id = f"{base_case_id}_{counter}"
        case_dir = root / case_id
        counter += 1
    case_dir.mkdir(parents=True, exist_ok=False)
    (case_dir / "attachments").mkdir()
    (case_dir / "evaluator").mkdir()

    flag = f"flag{{{_token(rng, rng.randint(16, 24))}}}"
    payload, chain = encode_flag(flag, rng)
    fake_flags = [
        f"flag{{decoy_{_token(rng, 8)}}}",
        f"flag{{sample_{_token(rng, 8)}}}",
        f"CTF{{not_the_answer_{_token(rng, 5)}}}",
    ]
    puzzle = "\n".join([
        "Randomized blind-solve payload.",
        f"noise={_token(rng, 32)}",
        f"decoy={fake_flags[0]}",
        f"payload={payload}",
        f"hint=encoding depth {len(chain)}; validate through Evidence, not title memory.",
        f"more_noise={_token(rng, 40)}",
    ]) + "\n"
    (case_dir / "attachments" / "puzzle.txt").write_text(puzzle, encoding="utf-8")
    (case_dir / "README.md").write_text(
        "\n".join([
            f"# {case_id}",
            "",
            "Decode the payload in attachments/puzzle.txt and submit the real flag.",
            f"Do not trust decoys such as `{fake_flags[1]}`.",
            "",
        ]),
        encoding="utf-8",
    )
    challenge = {
        "id": case_id,
        "title": "Randomized Blind Misc Case",
        "category": "misc",
        "description": "Randomized local CTF case for Blind Solve Mode. Decode current attachment evidence only.",
        "flag_format": "flag{...}",
        "attachments": ["attachments/puzzle.txt"],
        "author_notes": "Generated case. No writeup or historical matching allowed.",
    }
    (case_dir / "challenge.json").write_text(json.dumps(challenge, ensure_ascii=False, indent=2), encoding="utf-8")
    (case_dir / "scope.env.example").write_text(
        "\n".join([
            "COMPETITION_MODE=false",
            "SCOPE_CIDRS=",
            "SCOPE_DOMAINS=",
            "SCOPE_PORTS=",
            "",
        ]),
        encoding="utf-8",
    )
    (case_dir / "evaluator" / "expected_answer.txt").write_text(flag + "\n", encoding="utf-8")
    (case_dir / "evaluator" / "metadata.json").write_text(json.dumps({"flag": flag, "chain": chain}, indent=2), encoding="utf-8")

    latest = root / "latest"
    if latest.exists() or latest.is_symlink():
        if latest.is_symlink() or latest.is_file():
            latest.unlink()
        else:
            shutil.rmtree(latest)
    latest.symlink_to(case_dir.name, target_is_directory=True)
    return {"case_id": case_id, "case_dir": str(case_dir), "latest": str(latest), "flag": flag, "chain": chain}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()
    result = generate_case(seed=args.seed)
    printable = dict(result)
    printable["flag"] = "(stored in evaluator/expected_answer.txt)"
    print(json.dumps(printable, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
