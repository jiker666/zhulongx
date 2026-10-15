#!/usr/bin/env python3
"""Generic rotating-captcha single-shot helper (R22).

When a captcha rotates every couple of minutes, an interactive
fetch -> look -> type loop is always stale by the time it submits. This
helper fetches the image and OCRs it in one process; call it from INSIDE
the same script that submits the answer, and keep fetch -> decode ->
submit within one run.

  python3 captcha-ocr.py URL [--psm 7] [--header "Name: value"] ... [--keep]

Prints one candidate per line (plain tesseract, then upscaled/grayscale/
threshold variants when Pillow is available) and the best alnum candidate
last as BEST=<code>. Files are temp and removed unless --keep.

Generic capability only: no target-specific logic lives here.
"""
import argparse
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path


def ocr(path: str, psm: int) -> str:
    proc = subprocess.run(
        ["tesseract", path, "stdout", "--psm", str(psm)],
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip()


def variants(src: str):
    """Upscale + grayscale + threshold passes; yields temp file paths."""
    try:
        from PIL import Image
    except ImportError:
        return
    try:
        im = Image.open(src).convert("L")
        im = im.resize((im.width * 3, im.height * 3))
        base = src + ".var"
        for cutoff in (140, 170, 110):
            dst = f"{base}.{cutoff}.png"
            im.point(lambda p, c=cutoff: 255 if p > c else 0).save(dst)
            yield dst
    except Exception:
        return


def alnum(text: str) -> str:
    return "".join(ch for ch in text if ch.isalnum())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("url", help="captcha image URL")
    ap.add_argument("--psm", type=int, default=7, help="tesseract page seg mode (7=single line)")
    ap.add_argument("--header", action="append", default=[],
                    help='extra request header, e.g. --header "Cookie: a=b" (repeatable)')
    ap.add_argument("--keep", action="store_true", help="keep temp image files")
    args = ap.parse_args()

    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0"}
    for h in args.header:
        name, _, value = h.partition(":")
        if not value:
            print(f"bad header (want 'Name: value'): {h}", file=sys.stderr)
            return 2
        headers[name.strip()] = value.strip()

    try:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            f.write(urllib.request.urlopen(urllib.request.Request(args.url, headers=headers), timeout=20).read())
            path = f.name
    except Exception as exc:
        print(f"fetch failed: {exc}", file=sys.stderr)
        return 1

    candidates = [ocr(path, args.psm)]
    made = list(variants(path))
    candidates += [ocr(v, args.psm) for v in made]
    best = max((alnum(c) for c in candidates), key=len, default="")
    for c in candidates:
        if c:
            print(c)
    print(f"BEST={best}")

    if not args.keep:
        Path(path).unlink(missing_ok=True)
        for v in made:
            Path(v).unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
