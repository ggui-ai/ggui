// packages/ui-gen/src/classifier/infer-tooling.ts
//
// tooling axis — derived purely from contract presence of
// `agentCapabilities.tools` / `clientCapabilities.libraries`.
// Describes the *direction* of tool usage present on the contract:
// wired = UI references an agent tool, client = UI declares a
// browser-capability gadget hook.

import type { AxisSource, ToolingShape } from "./axes";
import type { ContractSignals } from "./inspect";

export function inferTooling(
  s: ContractSignals,
): { value: ToolingShape; source: AxisSource } {
  const hasAgent = s.agentTools.length > 0;
  const hasClient = s.clientCapabilities.length > 0;
  if (hasAgent && hasClient) return { value: "both", source: "contract" };
  // "wired" / "client" axis-shape names are retained for backward
  // compatibility with downstream classifiers — the underlying signal is
  // now "the contract declares agent-side tools" (wired) vs "the
  // contract declares client-side capabilities" (client).
  if (hasAgent) return { value: "wired", source: "contract" };
  if (hasClient) return { value: "client", source: "contract" };
  return { value: "none", source: "default" };
}
