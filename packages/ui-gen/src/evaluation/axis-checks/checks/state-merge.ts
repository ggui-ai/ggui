// packages/ui-gen/src/evaluation/axis-checks/checks/state-merge.ts
//
// Checks gated on state=merge: the component owns a live entity list
// reconciled from stream/action updates. Ported from
// mode-checks/collection.ts (§5a state-seeded, no-hardcoded-entities,
// derived-view-memoized).

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  cap,
  getEntityCollections,
  getMutatedEntityCollections,
  mkIssue,
} from "../helpers.js";

function runStateSeededFromProps(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const all = getEntityCollections(input.contract);
  const entities = getMutatedEntityCollections(input.contract, all);
  const issues: EvalIssue[] = [];
  for (const e of entities) {
    const re = new RegExp(
      `useState(?:<[^>]*>)?\\s*\\([\\s\\S]{0,400}?props\\.${e.name}\\b`,
    );
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "state.merge.seeded_from_props",
        `Entity collection "${e.name}" is not seeded from props — no useState initializer reads props.${e.name}.`,
        `Add \`const [${e.name}, set${cap(e.name)}] = useState(props.${e.name});\` so stream/action updates can merge into live state.`,
      ),
    );
  }
  return issues;
}

function runNoHardcodedEntities(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const all = getEntityCollections(input.contract);
  const entities = getMutatedEntityCollections(input.contract, all);
  if (entities.length === 0) return [];
  const uncommented = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const issues: EvalIssue[] = [];
  const idFields = [...new Set(entities.map((e) => e.idField))];
  for (const idField of idFields) {
    const re = new RegExp(
      `\\[\\s*\\{[^}]*\\b${idField}\\s*:[^}]*\\}\\s*,\\s*\\{[^}]*\\b${idField}\\s*:`,
      "g",
    );
    if (!re.test(uncommented)) continue;
    issues.push(
      mkIssue(
        "state.merge.no_hardcoded_entities",
        `Hardcoded entity array literal (multiple objects with "${idField}") in the component — entity data should come from state/props.`,
        `Remove the literal array. Seed state from props.{entityProp} and merge updates via stream.`,
      ),
    );
  }
  return issues;
}

function runDerivedViewMemoized(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const all = getEntityCollections(input.contract);
  const entities = getMutatedEntityCollections(input.contract, all);
  if (entities.length === 0) return [];
  const returnIdx = src.indexOf("return (");
  if (returnIdx < 0) return [];
  const renderBody = src.slice(returnIdx);
  const issues: EvalIssue[] = [];
  for (const e of entities) {
    const re = new RegExp(`\\b${e.name}\\s*\\.(filter|reduce|sort)\\s*\\(`);
    if (re.test(renderBody)) {
      issues.push(
        mkIssue(
          "state.merge.derived_view_memoized",
          `Derived view (${e.name}.filter/reduce/sort) computed inside the render body — should be wrapped in useMemo.`,
          `Extract to \`const ${e.name}Filtered = useMemo(() => ${e.name}.filter(...), [${e.name}, ...]);\` before the return.`,
          "warn",
        ),
      );
    }
  }
  return issues;
}

/**
 * `.map()` keyed by index → reorders and merges break React reconciliation.
 * Gated on any render that iterates (list/grid/timeline/master-detail) OR
 * state=merge (mutating list).
 */
function runMapKeyIsId(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const INDEX_NAMES = new Set(["index", "idx", "i", "j", "k", "n", "ix"]);
  const re = /key\s*=\s*\{\s*(\w+)\s*\}/g;
  const issues: EvalIssue[] = [];
  for (const m of src.matchAll(re)) {
    const key = m[1];
    if (!INDEX_NAMES.has(key)) continue;
    issues.push(
      mkIssue(
        "render.map_key_is_id",
        `Array key uses index variable "${key}" — reorders and stream merges will break React reconciliation.`,
        `Replace key={${key}} with key={item.id} (or item.symbol / whatever the entity id field is).`,
      ),
    );
  }
  return issues;
}

export const STATE_MERGE_CHECKS: readonly AxisCheck[] = [
  {
    id: "state.merge.seeded_from_props",
    axis: "state",
    values: ["merge"],
    run: runStateSeededFromProps,
  },
  {
    id: "state.merge.no_hardcoded_entities",
    axis: "state",
    values: ["merge"],
    run: runNoHardcodedEntities,
  },
  {
    id: "state.merge.derived_view_memoized",
    axis: "state",
    values: ["merge"],
    run: runDerivedViewMemoized,
  },
  // Map-key check: gated on any iterating render. state=merge always
  // implies iteration, so the render gate already covers it.
  {
    id: "render.map_key_is_id",
    axis: "render",
    values: ["list", "grid", "timeline", "master-detail"],
    run: runMapKeyIsId,
  },
];
