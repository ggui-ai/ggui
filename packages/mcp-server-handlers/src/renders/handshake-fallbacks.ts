/**
 * The no-LLM answer to a dirty draft — shared by every path that used
 * to hand back the empty contract (ggui#523 item 3, "make `{}`
 * impossible"):
 *
 *   - `decide-handshake.ts`'s `buildCreateFallback` (no LLM for the
 *     provider / operational failure under the negotiator), and
 *   - `handshake.ts`'s no-negotiator default (OSS zero-config).
 *
 * Both now do the same thing: keep the conforming SUBSET of the draft
 * (`salvageConformingSubset` — every refused entry dropped and reported
 * as a finding) and propose that, `origin: 'synth'`; or, when nothing
 * usable survives, DECLINE — `action: 'declined'`, no contract, findings
 * loud, summary that teaches the fix. Between the two there is no path
 * on which the server proposes `{}` on the agent's behalf; a `{}` reaches
 * the wire only when the agent drafted a clean `{}` itself.
 *
 * Why not throw on the dirty draft: the handshake is the tool an agent
 * must call FIRST, and the MCP SDK already hard-fails schema-invalid
 * args before any handler runs — a second hard-fail here on a
 * shape-valid-but-contract-dirty draft revives the retry loop the
 * forgiving handshake exists to end. Declining is loud AND actionable:
 * the same envelope, `action: 'declined'`, no `nextStep`, and one
 * finding per offending path.
 */
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  dataContractSchema,
  lintContract,
  summarizeContract,
  type BlueprintVariance,
  type DataContract,
  type HandshakeSuggestion,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import { salvageConformingSubset } from '@ggui-ai/negotiator';
import type {
  HandshakeNegotiatorDeclined,
  HandshakeNegotiatorDecision,
  HandshakeNegotiatorResult,
} from './handshake.js';

/** ERROR findings from the deterministic gate, in the wire shape. */
export function errorFindingsOf(draftContract: unknown): SuggestionFinding[] {
  return lintContract(draftContract).errors.map((e) => ({
    code: e.code,
    severity: 'error',
    path: e.path,
    message: e.message,
  }));
}

/**
 * The declined answer. `contractHash` is the DRAFT's hash when the draft
 * parses at all (it never does here — declined drafts are dirty by
 * definition — so `blueprintKey(undefined)`, the same telemetry-only
 * value the handler already records for unparseable drafts).
 */
export function buildDeclined(args: {
  readonly draftContract: unknown;
  readonly findings: readonly SuggestionFinding[];
  readonly reason: string;
  readonly variance?: BlueprintVariance;
}): HandshakeNegotiatorDeclined {
  const paths = args.findings.map((f) => f.path);
  const summary =
    `DECLINED — nothing in this draft passes the contract gate, so there is no proposal ` +
    `and no ggui_render for this handshake. ${paths.length} finding(s) at: ${paths.join(', ')}. ` +
    `Fix them (each finding names its path and what the protocol wants there — every entry under ` +
    `propsSpec.properties / actionSpec / streamSpec / contextSpec is a WRAPPER with the JSON Schema in ` +
    `its \`schema:\` field) and call ggui_handshake again.`;
  const suggestion: HandshakeSuggestion = {
    origin: 'agent',
    rationale: args.reason,
    blueprintMeta: {
      contractHash: blueprintKey(dataContractSchema.safeParse(args.draftContract).data),
      variance: args.variance ?? {},
    },
    proposedContractSummary: summary,
    validationFindings: args.findings,
  };
  return {
    action: 'declined',
    reason: args.reason,
    suggestion,
    effectiveContract: null,
  };
}

/**
 * Salvage-or-decline for a draft that already failed the gate. `reason`
 * names WHY no repair ran (no LLM, degraded negotiator, no negotiator
 * bound); it is prefixed onto the rationale either way.
 */
export function buildSalvagedOrDeclined(args: {
  readonly draftContract: unknown;
  readonly reason: string;
  readonly variance?: BlueprintVariance;
}): HandshakeNegotiatorResult {
  const errorFindings = errorFindingsOf(args.draftContract);
  const salvaged = salvageConformingSubset(args.draftContract);
  if (salvaged === null) {
    return buildDeclined({
      draftContract: args.draftContract,
      findings: errorFindings,
      reason: `${args.reason} — and no entry of the draft passes the contract gate: declined.`,
      ...(args.variance !== undefined ? { variance: args.variance } : {}),
    });
  }
  const dropped = salvaged.dropped;
  const contract: DataContract = salvaged.contract;
  const droppedPaths = dropped.map((d) => d.path);
  const summary =
    `PARTIAL — the conforming subset of your draft; ${droppedPaths.length} ` +
    `entr${droppedPaths.length === 1 ? 'y' : 'ies'} the protocol refused ` +
    `${droppedPaths.length === 1 ? 'was' : 'were'} dropped (${droppedPaths.join(', ')}; ` +
    `see validationFindings for why). Render this to get the rest working now, and re-declare ` +
    `the dropped entries via ggui_render override or a corrected re-handshake. ` +
    `${summarizeContract(contract)}`;
  const suggestion: HandshakeSuggestion = {
    origin: 'synth',
    rationale: `${args.reason} — proposing the conforming subset of the draft (dropped: ${droppedPaths.join(', ')}).`,
    blueprintMeta: {
      contractHash: blueprintKey(contract),
      variance: args.variance ?? {},
    },
    proposedContractSummary: summary,
    validationFindings: [...errorFindings, ...dropped],
  };
  const decision: HandshakeNegotiatorDecision = {
    action: 'create',
    reason: suggestion.rationale,
    suggestion,
    effectiveContract: contract,
  };
  return decision;
}
