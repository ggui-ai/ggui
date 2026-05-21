// packages/ui-gen/src/classifier/infer-realtime.ts

import type { AxisSource, RealtimeShape, StreamEventKind } from "./axes";
import type { ContractSignals } from "./inspect";
import { inferStreamKindFromSchema } from "./inspect";

export function inferRealtime(
  s: ContractSignals,
): {
  value: RealtimeShape;
  streamKinds?: Record<string, StreamEventKind>;
  source: AxisSource;
} {
  if (s.streams.length === 0) {
    return { value: "none", source: "contract" };
  }

  const kinds: Record<string, StreamEventKind> = {};
  for (const stream of s.streams) {
    kinds[stream.name] = inferStreamKindFromSchema(
      stream.schema,
      s.entityLists,
      s.singletons,
    );
  }

  const distinct = new Set(Object.values(kinds));

  if (distinct.size === 1) {
    const only = [...distinct][0];
    // 'other' as the only kind is too vague — surface it as 'mixed' w/ kinds
    // so downstream can still reason, rather than pretending we know.
    if (only === "other") {
      return { value: "mixed", streamKinds: kinds, source: "contract" };
    }
    return { value: only as RealtimeShape, source: "contract" };
  }

  return { value: "mixed", streamKinds: kinds, source: "contract" };
}
