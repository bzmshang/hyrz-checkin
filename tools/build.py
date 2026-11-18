#!/usr/bin/env python3
"""Compose standalone Loon scripts without a network or runtime dependencies."""
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[1]
parts = ('src/runner.js', 'src/rewards.js')
# Declarations in rewards.js are hoisted. Keep the strict directive before both units.
body = '\n'.join((root / f).read_text(encoding='utf-8').rstrip() for f in parts) + '\n'
target = root / 'hyrz-sign.js'
if sys.argv[1:] == ['--check']:
    if target.read_text(encoding='utf-8') != body:
        sys.exit('hyrz-sign.js is stale: run python3 tools/build.py')
elif not sys.argv[1:]:
    target.write_text(body, encoding='utf-8')
else:
    sys.exit('usage: python3 tools/build.py [--check]')
