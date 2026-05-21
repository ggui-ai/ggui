#!/usr/bin/env python3
"""Turn-phase mix + PATCH_INVALID classification from bench logs.

Usage:
  python3 turn-breakdown.py <log> [<log>...]

Reports:
  - total turn outcomes (PATCH_INVALID / SELF_CHECK_FAIL / PASS) and phase
    mix (impl / patch / evalFix / scaffold / fill)
  - top PATCH_INVALID error classes (JSX tag mismatch, unescaped brace,
    TS-in-JS colon, extra brace, unmatched paren, unterminated regex, etc.)
  - normalized per-task counts (requires SUMMARY line count for baseline)
"""
import re
import sys
from collections import Counter


TURN_RE = re.compile(r"\[simple\] turn (\d+) \((\w+(?:-fix)?)\): (\w+)")
APPLY_ERR_RE = re.compile(r"\[coding-agent\] apply_changes: PATCH_INVALID.*?\|\s*(.+?)$")
SUMMARY_RE = re.compile(
    r"SUMMARY \| turns=\d+ impl=(\d+) patch=(\d+) evalFix=(\d+)"
    r"(?: scaffold=(\d+) fill=(\d+))? \| "
    r"pass=(\d+) patchInvalid=(\d+) selfCheckFail=(\d+)"
)


def classify_patch_error(err):
    if "closing" in err and "match opening" in err:
        return "JSX tag mismatch"
    if "not valid inside a JSX element" in err:
        return "JSX unescaped brace"
    if "Unterminated regular expression" in err:
        return "Unterminated regex"
    if "Unterminated string literal" in err:
        return "Unterminated string"
    if 'Expected ";" but found ":"' in err:
        return "TS-in-JS colon"
    if 'Expected "}" but found ":"' in err or 'Expected ":" but found' in err:
        return "Object literal malformed"
    if "has already been declared" in err:
        return "Duplicate declaration"
    if 'Unexpected "}"' in err:
        return "Extra brace"
    if 'Unexpected ")"' in err:
        return "Unmatched paren"
    if 'Unexpected ","' in err:
        return "Misplaced comma"
    if 'Unexpected "const"' in err or 'Unexpected "return"' in err:
        return "Statement outside function"
    if "Unexpected end of file" in err:
        return "Unexpected EOF"
    if 'Expected ">" but found "<"' in err:
        return "JSX tag unclosed"
    if "Expected identifier but found" in err:
        return "Reserved-as-name"
    return f"other: {err[:60]}"


def main():
    if len(sys.argv) < 2:
        print("Usage: turn-breakdown.py <log> [<log>...]", file=sys.stderr)
        sys.exit(1)

    turn_outcomes = Counter()
    phase_outcomes = Counter()
    patch_errors = Counter()
    task_count = 0
    summary_totals = Counter()

    for log_path in sys.argv[1:]:
        with open(log_path) as f:
            for line in f:
                m = TURN_RE.search(line)
                if m:
                    turn_outcomes[m.group(3)] += 1
                    phase_outcomes[f"{m.group(2)}/{m.group(3)}"] += 1
                    continue
                if "apply_changes: PATCH_INVALID" in line:
                    # Strip any hint=yes suffix added after the err text
                    parts = line.rstrip().split("|")
                    err = parts[-1].strip()
                    if err.startswith("hint="):
                        err = parts[-2].strip() if len(parts) > 1 else err
                    patch_errors[classify_patch_error(err)] += 1
                    continue
                m = SUMMARY_RE.search(line)
                if m:
                    task_count += 1
                    summary_totals["impl"] += int(m.group(1))
                    summary_totals["patch"] += int(m.group(2))
                    summary_totals["evalFix"] += int(m.group(3))
                    summary_totals["scaffold"] += int(m.group(4) or 0)
                    summary_totals["fill"] += int(m.group(5) or 0)
                    summary_totals["pass"] += int(m.group(6))
                    summary_totals["patchInvalid"] += int(m.group(7))
                    summary_totals["selfCheckFail"] += int(m.group(8))

    print(f"=== Aggregate across {len(sys.argv) - 1} log(s), {task_count} task summaries ===\n")

    total_turns = sum(turn_outcomes.values())
    if total_turns:
        print(f"Turn outcomes (total={total_turns}):")
        for k, v in turn_outcomes.most_common():
            print(f"  {k:18} {v:4} ({100*v/total_turns:.1f}%)")
        print()

    if phase_outcomes:
        print("Phase × outcome mix:")
        for k, v in phase_outcomes.most_common():
            print(f"  {k:22} {v:4}")
        print()

    if task_count and summary_totals:
        print(f"Per-task averages (n={task_count} tasks):")
        for k in ("impl", "patch", "evalFix", "scaffold", "fill", "pass", "patchInvalid", "selfCheckFail"):
            v = summary_totals[k]
            print(f"  {k:18} {v/task_count:.2f}/task")
        print()

    if patch_errors:
        print("PATCH_INVALID error classes (top 20):")
        total = sum(patch_errors.values())
        for k, v in patch_errors.most_common(20):
            print(f"  {v:4} ({100*v/total:.0f}%) {k}")


if __name__ == "__main__":
    main()
