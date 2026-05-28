/**
 * `assertContractNoRetiredFields` — hard-reject gate against retired
 * top-level `DataContract` field names.
 *
 * The contract schema is `.passthrough()` at the type-system level so
 * forward-compat additions don't crash old parsers — but specific
 * names (`libraries`, `dispatch`, `wiredTools`, `clientTools`,
 * `broadcast`, `capabilities`) have known replacements in the current
 * protocol. Silent pass-through would let an LLM-authored or copy-
 * pasted contract carrying retired fields succeed at parse time and
 * fail much later (or worse, succeed by ignoring the field).
 *
 * The retired-field vocabulary lives in `@ggui-ai/protocol`'s
 * `RETIRED_CONTRACT_FIELDS`; this gate raises a fatal error at every
 * push + handshake seam so the same vocabulary cannot leak in two
 * different ways. `checkRetiredContractFields` in `hygiene-rules.ts`
 * is the AUTHOR-TIME warning surface; this gate is the SERVER-TIME
 * reject. Both consult the same map.
 */
import {
  RETIRED_CONTRACT_FIELDS,
  type DataContract,
} from '@ggui-ai/protocol';

export class ContractRetiredFieldError extends Error {
  readonly retiredFields: readonly string[];
  constructor(retired: readonly string[]) {
    const list = retired
      .map((name) => `'${name}' → use ${RETIRED_CONTRACT_FIELDS[name]}`)
      .join('; ');
    super(
      `contract carries retired top-level field(s): ${list}. Pre-launch posture rejects these instead of silently dropping; migrate to the listed replacements and retry.`,
    );
    this.name = 'ContractRetiredFieldError';
    this.retiredFields = retired;
  }
}

/**
 * Throws {@link ContractRetiredFieldError} when the contract carries
 * one or more retired field names at the top level. Pure check; no
 * mutation. Returns `void` on success.
 */
export function assertContractNoRetiredFields(contract: DataContract): void {
  const raw = contract as unknown as Record<string, unknown>;
  const retired: string[] = [];
  for (const key of Object.keys(RETIRED_CONTRACT_FIELDS)) {
    if (raw[key] !== undefined) retired.push(key);
  }
  if (retired.length > 0) {
    throw new ContractRetiredFieldError(retired);
  }
}
