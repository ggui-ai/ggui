// packages/ui-gen/src/classifier/classifier.ts
//
// Multi-axis classifier orchestrator. Composes per-axis inference and risk
// tier into a Classification. Pure function, no side effects.

import type {
  AxisProvenance,
  AxisVector,
  Classification,
} from "./axes";
import { inspect, type ClassifierInput } from "./inspect";
import { inferState } from "./infer-state";
import { inferWrites } from "./infer-writes";
import { inferRealtime } from "./infer-realtime";
import { inferFetch } from "./infer-fetch";
import { inferRender } from "./infer-render";
import { inferLayout } from "./infer-layout";
import { inferWriteTrigger } from "./infer-trigger";
import { inferTooling } from "./infer-tooling";
import { deriveRiskTier } from "./risk-tier";

export interface ClassifyInput {
  contract: ClassifierInput;
  prompt?: string;
  blueprint?: {
    mechanic?: string;
    layoutHint?: string;
  };
}

export function classifyAxes(input: ClassifyInput): Classification {
  const s = inspect(input.contract);
  const prompt = input.prompt ?? "";
  const blueprint = input.blueprint;

  const state = inferState(s, prompt);
  const writes = inferWrites(s);
  const realtime = inferRealtime(s);
  const fetch = inferFetch(s);
  const render = inferRender(s, prompt, blueprint);
  const layout = inferLayout(s, prompt, blueprint);
  const writeTrigger = inferWriteTrigger(s, prompt, blueprint);
  const tooling = inferTooling(s);

  const vector: AxisVector = {
    render: render.value,
    state: state.value,
    writes: writes.value,
    writeTrigger: writeTrigger.value,
    realtime: realtime.value,
    fetch: fetch.value,
    layout: layout.value,
    tooling: tooling.value,
  };
  if (realtime.streamKinds) {
    vector.streamKinds = realtime.streamKinds;
  }

  const provenance: AxisProvenance = {
    render: render.source,
    state: state.source,
    writes: writes.source,
    writeTrigger: writeTrigger.source,
    realtime: realtime.source,
    fetch: fetch.source,
    layout: layout.source,
    tooling: tooling.source,
  };

  const riskTier = deriveRiskTier(vector);

  return { vector, provenance, riskTier };
}
