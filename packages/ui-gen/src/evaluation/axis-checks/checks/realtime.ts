// packages/ui-gen/src/evaluation/axis-checks/checks/realtime.ts
//
// Checks gated on realtime != none. Ported from mode-checks/collection.ts
// (stream-handler-per-event, stream-merges-by-id).

import type { EvalIssue } from "../../types-public.js";
import type { AxisCheck, AxisCheckInput } from "../types.js";
import {
  getEntityCollections,
  getMutatedEntityCollections,
  getStreamEventNames,
  mkIssue,
} from "../helpers.js";

const REALTIME_ACTIVE = ["merge", "append", "status", "presence", "mixed"] as const;

function runStreamHandlerPerEvent(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const eventNames = getStreamEventNames(input.contract);
  const issues: EvalIssue[] = [];
  for (const name of eventNames) {
    const re = new RegExp(`useStream(?:<[^>]*>)?\\s*\\(\\s*['"\`]${name}['"\`]`);
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "realtime.stream_handler_per_event",
        `Stream event "${name}" declared in the contract has no useStream('${name}') call.`,
        `Add \`const ${name} = useStream<...>('${name}');\` and handle ${name}.latest in a useEffect.`,
      ),
    );
  }
  return issues;
}

function runStreamMergesById(input: AxisCheckInput): EvalIssue[] {
  if (input.compiledCode === null) return [];
  const src = input.sourceCode;
  const eventNames = getStreamEventNames(input.contract);
  const all = getEntityCollections(input.contract);
  const entities = getMutatedEntityCollections(input.contract, all);
  if (eventNames.length === 0 || entities.length === 0) return [];
  const issues: EvalIssue[] = [];
  const idFields = new Set(entities.map((e) => e.idField));
  for (const idField of idFields) {
    const re = new RegExp(`\\.${idField}\\b`);
    if (re.test(src)) continue;
    issues.push(
      mkIssue(
        "realtime.merge.stream_merges_by_id",
        `Entity id field "${idField}" is never referenced in the source — stream merge likely does not key by id.`,
        `In the stream handler, merge by id: setItems(prev => prev.map(x => x.${idField} === update.${idField} ? {...x, ...update} : x)).`,
        "warn",
      ),
    );
  }
  return issues;
}

export const REALTIME_CHECKS: readonly AxisCheck[] = [
  {
    id: "realtime.stream_handler_per_event",
    axis: "realtime",
    values: REALTIME_ACTIVE,
    run: runStreamHandlerPerEvent,
  },
  {
    id: "realtime.merge.stream_merges_by_id",
    axis: "realtime",
    values: ["merge", "mixed"],
    run: runStreamMergesById,
  },
];
