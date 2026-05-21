#!/usr/bin/env python3
"""Per-(provider, commit) cohort comparison with Google quality filter.

Usage:
  python3 compare.py \
    --mode {display|form|collection|all} \
    --new <benchmark-*.json> [<benchmark-*.json>...] \
    --base <benchmark-*.json> [<benchmark-*.json>...]

Output columns: provider, commit, base_ms_avg, new_ms_avg, Δms, new spread
(min-max), avg turns, pass@≥50. Rows where all Google runs are filtered
(score<20 or error) are flagged.
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

MODE_COMMITS = {
    "display": {"weather-card", "product-page", "periodic-table", "stock-ticker"},
    "form": {"survey-form", "onboarding-wizard"},
    "collection": {"kanban-board", "chat-interface"},
}


def load(paths):
    rows = []
    for p in paths:
        with open(p) as f:
            data = json.load(f)
        for r in data["results"]:
            g = r.get("generation") or {}
            ev = r.get("evaluation") or {}
            rows.append({
                "provider": r["variant"]["sdkName"],
                "commit": r["commit"]["id"],
                "ms": g.get("generationTimeMs", 0),
                "turns": g.get("turnsUsed", 0),
                "score": (ev or {}).get("score", 0),
                "error": bool(r.get("error")),
            })
    return rows


def clean(rows, provider):
    """Google quality filter: drop runs where score<20 or error or ms=0."""
    if provider != "google":
        return [r for r in rows if r["ms"] > 0]
    return [r for r in rows if r["score"] >= 20 and not r["error"] and r["ms"] > 0]


def agg(rows):
    out = defaultdict(list)
    for r in rows:
        out[(r["provider"], r["commit"])].append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["display", "form", "collection", "all"], default="all")
    ap.add_argument("--new", nargs="+", required=True, help="New cohort JSON paths")
    ap.add_argument("--base", nargs="+", required=True, help="Baseline cohort JSON paths")
    args = ap.parse_args()

    commits = (
        MODE_COMMITS[args.mode] if args.mode != "all"
        else set().union(*MODE_COMMITS.values())
    )

    base = agg(load(args.base))
    new = agg(load(args.new))

    print(f"{'prov':8} {'commit':20} {'base':>8} {'new':>8} {'Δms':>8} {'spread':>14} {'turns':>11} {'p≥50':>6} {'note':>6}")
    print("-" * 95)

    all_cells = []
    for provider in ("claude", "google", "openai"):
        for commit in sorted(commits):
            key = (provider, commit)
            if key not in base or key not in new:
                continue
            b = clean(base[key], provider)
            n = clean(new[key], provider)
            if not b:
                print(f"{provider:8} {commit:20} {'[base filtered]':<48}")
                continue
            if not n:
                print(f"{provider:8} {commit:20} {'[new filtered - all low score]':<48}")
                continue
            base_ms = sum(x["ms"] for x in b) / len(b)
            new_ms = sum(x["ms"] for x in n) / len(n)
            mn, mx = min(x["ms"] for x in n) / 1000, max(x["ms"] for x in n) / 1000
            btur = sum(x["turns"] for x in b) / len(b)
            ntur = sum(x["turns"] for x in n) / len(n)
            p50 = f"{sum(1 for x in n if x['score']>=50)}/{len(n)}"
            note = ""
            if provider == "google" and (len(b) < len(base[key]) or len(n) < len(new[key])):
                note = "filt"
            all_cells.append((provider, commit, base_ms, new_ms, btur, ntur))
            print(f"{provider:8} {commit:20} {base_ms/1000:7.0f}s {new_ms/1000:7.0f}s {(new_ms-base_ms)/1000:+7.0f}s "
                  f"{mn:5.0f}-{mx:>3.0f}s {btur:5.2f}→{ntur:.2f} {p50:>6} {note:>6}")

    print("-" * 95)
    for provider in ("claude", "google", "openai"):
        cells = [c for c in all_cells if c[0] == provider]
        if not cells:
            continue
        bm = sum(c[2] for c in cells) / len(cells)
        nm = sum(c[3] for c in cells) / len(cells)
        pct = 100 * (nm - bm) / bm if bm else 0
        print(f"  {provider:8} blended {bm/1000:6.1f}s → {nm/1000:6.1f}s ({pct:+.1f}%)  [n_cells={len(cells)}]")

    if all_cells:
        bm = sum(c[2] for c in all_cells) / len(all_cells)
        nm = sum(c[3] for c in all_cells) / len(all_cells)
        pct = 100 * (nm - bm) / bm if bm else 0
        print(f"  OVERALL   blended {bm/1000:6.1f}s → {nm/1000:6.1f}s ({pct:+.1f}%)")


if __name__ == "__main__":
    main()
