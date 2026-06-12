#!/usr/bin/env python3
"""Exp 44 analyzer — parses exp44-n3-run{1,2,3}.log google cells and compares
against the Exp 43 google baseline (gate-n3-run{1,2,3}.log in the main workspace)."""
import re, statistics, glob, sys

CELL = re.compile(r"\[benchmark\] google-\d+ × ([a-z-]+): (\d+)ms, (\d+) calls, \$([\d.]+) \| (\d+)B compiled \| score: ([\d.]+)/100")
BREAK = re.compile(r"\[breakdown\] google-\d+ × ([a-z-]+) \| impl=(\d+) patch=(\d+) evalFix=(\d+) \| pass=(\d+) patchInvalid=(\d+) selfCheckFail=(\d+) diffFail=(\d+)")
ERRS = re.compile(r"malformed_tool_call|legacy Interactions API schema|No compiled code|FAILED|Error:|timed? ?out", re.I)

def collect(pattern, label):
    cells, breaks, errlines = [], [], []
    for f in sorted(glob.glob(pattern)):
        text = open(f).read()
        for m in CELL.finditer(text):
            cells.append(dict(run=f.split('run')[-1][0], commit=m[1], ms=int(m[2]), turns=int(m[3]), cost=float(m[4]), bytes=int(m[5]), score=float(m[6])))
        for m in BREAK.finditer(text):
            breaks.append(dict(commit=m[1], impl=int(m[2]), patch=int(m[3]), evalFix=int(m[4]), patchInvalid=int(m[6]), selfCheckFail=int(m[7]), diffFail=int(m[8])))
        for line in text.splitlines():
            if ERRS.search(line) and '[benchmark]' not in line and 'diffFail' not in line:
                errlines.append(f"{f}: {line.strip()[:160]}")
    return cells, breaks, errlines

def p(vals, q):
    s = sorted(vals); idx = max(0, min(len(s)-1, round(q*(len(s)-1))))
    return s[idx]

def report(cells, breaks, label):
    if not cells:
        print(f"{label}: NO CELLS"); return
    turns = [c['turns'] for c in cells]; scores = [c['score'] for c in cells]; ms = [c['ms'] for c in cells]
    print(f"== {label} (n={len(cells)}) ==")
    for c in cells: print(f"  run{c['run']} {c['commit']:<14} {c['ms']:>6}ms turns={c['turns']:>2} score={c['score']:>5} ${c['cost']:.4f} {c['bytes']}B")
    print(f"  turns: min={min(turns)} p50={p(turns,.5)} p90={p(turns,.9)} max={max(turns)} mean={statistics.mean(turns):.1f}")
    print(f"  score: mean={statistics.mean(scores):.1f} p50={p(scores,.5)} range={min(scores)}-{max(scores)} pass@70={sum(1 for s in scores if s>=70)}/{len(scores)}")
    print(f"  time : mean={statistics.mean(ms)/1000:.1f}s range={min(ms)/1000:.1f}-{max(ms)/1000:.1f}s")
    print(f"  cost : total=${sum(c['cost'] for c in cells):.4f}")
    if breaks:
        scf = [b['selfCheckFail'] for b in breaks]; pin = [b['patchInvalid'] for b in breaks]; dff = [b['diffFail'] for b in breaks]
        print(f"  breakdown: selfCheckFail per-cell {scf} | patchInvalid total={sum(pin)} | diffFail total={sum(dff)}")

c44, b44, e44 = collect('/workspaces/ggui-blueprint-prov/oss/misc/benchmark/tmp-bench-logs/exp44-n3-run*.log', 'exp44')
c43, b43, e43 = collect('/workspaces/ggui-workspace/oss/misc/benchmark/tmp-bench-logs/gate-n3-run*.log', 'exp43')
report(c44, b44, 'Exp 44 google (steps schema, genai 2.8.0)')
print()
report(c43, b43, 'Exp 43 google baseline (legacy schema, genai 1.45.0)')
print()
print('== Exp 44 error-class scan (legacy-400 / malformed / timeout) ==')
print('\n'.join(e44) if e44 else '  CLEAN — zero matches')
