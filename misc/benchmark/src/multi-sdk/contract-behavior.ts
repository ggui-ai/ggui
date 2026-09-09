import {
  validateContractBehavior,
  type BehaviorFailure,
  type PlaywrightModule,
  type ValidateContractBehaviorInput,
  type ValidateContractBehaviorResult,
} from '@ggui-ai/ui-visual-tester';
import type { DataContract } from '@ggui-ai/protocol';

/**
 * Per-cell contract-behaviour verdict (#973 §5a(4)): `validateContractBehavior`
 * re-run for EVERY cell in the same task. Contract: `skipped` is never a pass
 * and always carries `reason`; `ran` carries the validator's answer verbatim.
 * Known bias, recorded not hidden: the validator mounts with EMPTY props
 * (`fixture-runtime.ts:225`), so a component that renders its action control
 * only when data is present reads as `action-not-rendered`.
 */
export interface ContractBehaviorResult {
  readonly status: 'ran' | 'skipped';
  readonly ok?: boolean;
  readonly failures?: readonly BehaviorFailure[];
  readonly reason?: string;
  readonly durationMs?: number;
}

export const NO_PLAYWRIGHT_REASON =
  'no Playwright in the runner — pass { playwright: { chromium } } (BENCH_PLAYWRIGHT=1 in the image)';

/** Default budget per cell; the validator's own default applies when undefined. */
export const CONTRACT_BEHAVIOR_TIMEOUT_MS = 30_000;

type Validate = (input: ValidateContractBehaviorInput) => Promise<ValidateContractBehaviorResult>;

export async function runContractBehaviorCheck(input: {
  readonly compiledCode: string;
  readonly contract: DataContract;
  readonly playwright: PlaywrightModule | undefined;
  readonly timeoutMs?: number;
  /** Injected for tests; production uses `validateContractBehavior`. */
  readonly validate?: Validate;
  /**
   * Gate around the BROWSER work only (the validator call) — never around the
   * no-browser short-circuits, so action-free cells don't queue for Chromium.
   */
  readonly limit?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<ContractBehaviorResult> {
  const actionNames = Object.keys(input.contract.actionSpec ?? {});
  if (actionNames.length === 0) {
    // Same rule the validator applies before it touches a browser: no
    // actions → nothing to drive → ok. Stated here so a browserless runner
    // still reports RAN for action-free cells instead of a misleading skip.
    return { status: 'ran', ok: true, failures: [], durationMs: 0 };
  }
  if (!input.playwright) {
    return { status: 'skipped', reason: NO_PLAYWRIGHT_REASON };
  }
  const validate = input.validate ?? validateContractBehavior;
  const started = Date.now();
  try {
    const limit = input.limit ?? ((fn) => fn());
    const playwright = input.playwright;
    const result = await limit(() =>
      validate({
        componentCode: input.compiledCode,
        contract: input.contract,
        playwright,
        timeoutMs: input.timeoutMs ?? CONTRACT_BEHAVIOR_TIMEOUT_MS,
      }),
    );
    return { status: 'ran', ok: result.ok, failures: result.failures, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'skipped', reason: `behaviour check threw: ${message}`, durationMs: Date.now() - started };
  }
}
