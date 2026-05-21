/**
 * Node-side Playwright driver for `validateContractBehavior`.
 *
 * Spins up one headless Chromium browser per call, then iterates each
 * `actionSpec` entry: one fresh `BrowserContext` + `Page` per action
 * for isolation. Inside the page, the IIFE-bundled fixture runtime
 * (built by `scripts/build-fixture-bundle.mjs` → `fixture/fixture-runtime.js`)
 * mounts the component and runs the click-and-observe loop.
 *
 * The fixture is loaded via `addScriptTag({content: ...})` rather than
 * a file URL — works around CORS in headless launch, lets us cache
 * the bundle source on the Node side.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Browser as PlaywrightBrowser,
  Page as PlaywrightPage,
} from 'playwright-core';
import type { DataContract } from '@ggui-ai/protocol';
import type {
  BehaviorFailure,
  BehaviorFailureKind,
  PlaywrightModule,
  ValidateContractBehaviorInput,
  ValidateContractBehaviorResult,
} from './index.js';
import { PlaywrightNotAvailableError } from './index.js';

interface RunInput {
  readonly componentCode: string;
  readonly contract: DataContract;
  readonly actionName: string;
  readonly classification: ActionClassification;
  readonly settleMs: number;
  readonly waitMs: number;
}

/**
 * Per-action signal-classification, derived from the contract via
 * Option C (the actions-vs-context principle).
 *
 * - `agent-bound`   — `actionSpec[name].nextStep` is present. The
 *                     author has hinted that the agent should pick up
 *                     this action; success ⇔ a dispatch fired.
 * - `context-bound` — `nextStep` is absent. The action is observed
 *                     locally (the rest of the page reads via
 *                     `contextSpec`/local state) without agent routing;
 *                     success ⇔ DOM changed.
 *
 * The classification is computed up-front in Node and forwarded into
 * the page so the fixture's branch is deterministic.
 */
export type ActionClassification = 'agent-bound' | 'context-bound';

type RunOutcome =
  | { readonly status: 'render-failed'; readonly diagnostic: string }
  | { readonly status: 'action-not-rendered' }
  | { readonly status: 'action-no-effect'; readonly diagnostic: string }
  | {
      readonly status: 'ok';
      readonly dispatchFired: boolean;
      readonly domChanged: boolean;
    };

const DEFAULT_TIMEOUT_MS = 5000;
const SETTLE_MS = 200;

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(__dirname, '../fixture/fixture-runtime.js');

let bundleSourceCache: string | null = null;
async function loadBundleSource(): Promise<string> {
  if (bundleSourceCache !== null) return bundleSourceCache;
  const src = await readFile(BUNDLE_PATH, 'utf8');
  bundleSourceCache = src;
  return src;
}

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ggui-vt</title></head>
<body><div id="root"></div></body></html>`;

async function preparePage(browser: PlaywrightBrowser): Promise<PlaywrightPage> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
  const bundle = await loadBundleSource();
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __validateContractBehavior_run__?: unknown })
        .__validateContractBehavior_run__ === 'function',
    undefined,
    { timeout: 10_000 },
  );
  return page;
}

interface SerializedRunInput {
  readonly componentCode: string;
  readonly contractJson: string;
  readonly actionName: string;
  readonly classification: ActionClassification;
  readonly settleMs: number;
  readonly waitMs: number;
}

function parseRunOutcome(value: unknown): RunOutcome {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { status?: unknown }).status !== 'string'
  ) {
    return {
      status: 'render-failed',
      diagnostic: `fixture returned unparseable result: ${JSON.stringify(value)}`,
    };
  }
  const status = (value as { status: string }).status;
  switch (status) {
    case 'render-failed': {
      const diagnostic = (value as { diagnostic?: unknown }).diagnostic;
      return {
        status: 'render-failed',
        diagnostic: typeof diagnostic === 'string' ? diagnostic : 'unknown',
      };
    }
    case 'action-not-rendered':
      return { status: 'action-not-rendered' };
    case 'action-no-effect': {
      const diagnostic = (value as { diagnostic?: unknown }).diagnostic;
      return {
        status: 'action-no-effect',
        diagnostic: typeof diagnostic === 'string' ? diagnostic : 'no signal',
      };
    }
    case 'ok': {
      const dispatchFired =
        (value as { dispatchFired?: unknown }).dispatchFired === true;
      const domChanged = (value as { domChanged?: unknown }).domChanged === true;
      return { status: 'ok', dispatchFired, domChanged };
    }
    default:
      return {
        status: 'render-failed',
        diagnostic: `fixture returned unknown status: ${status}`,
      };
  }
}

async function runOne(page: PlaywrightPage, input: RunInput): Promise<RunOutcome> {
  const serialized: SerializedRunInput = {
    componentCode: input.componentCode,
    contractJson: JSON.stringify(input.contract),
    actionName: input.actionName,
    classification: input.classification,
    settleMs: input.settleMs,
    waitMs: input.waitMs,
  };
  const result: unknown = await page.evaluate(async (arg) => {
    const fn = (
      window as unknown as {
        __validateContractBehavior_run__?: (i: {
          readonly componentCode: string;
          readonly contract: unknown;
          readonly actionName: string;
          readonly classification: 'agent-bound' | 'context-bound';
          readonly settleMs: number;
          readonly waitMs: number;
        }) => Promise<unknown>;
      }
    ).__validateContractBehavior_run__;
    if (fn === undefined) {
      return { status: 'render-failed', diagnostic: 'fixture runtime not loaded' };
    }
    return await fn({
      componentCode: arg.componentCode,
      contract: JSON.parse(arg.contractJson) as unknown,
      actionName: arg.actionName,
      classification: arg.classification,
      settleMs: arg.settleMs,
      waitMs: arg.waitMs,
    });
  }, serialized);
  return parseRunOutcome(result);
}

function classify(
  actionName: string,
  outcome: RunOutcome,
): BehaviorFailure | null {
  switch (outcome.status) {
    case 'ok':
      return null;
    case 'render-failed':
      return {
        kind: 'render-failed' as BehaviorFailureKind,
        actionName,
        diagnostic: outcome.diagnostic,
      };
    case 'action-not-rendered':
      return {
        kind: 'action-not-rendered' as BehaviorFailureKind,
        actionName,
        diagnostic: `no button found matching actionSpec.${actionName}.label`,
      };
    case 'action-no-effect':
      return {
        kind: 'action-no-effect' as BehaviorFailureKind,
        actionName,
        diagnostic:
          `clicking actionSpec.${actionName} produced no required signal — ` +
          outcome.diagnostic,
      };
  }
}

/**
 * Per Option C: classify each action by the contract shape alone.
 *
 *   `nextStep` present → agent-bound (dispatch required)
 *   `nextStep` absent  → context-bound (DOM change required)
 *
 * The classification is deterministic and fully contract-derivable;
 * no source-AST inspection, no LLM call. When a contract evolves to
 * include `nextStep` mid-flight, the classification follows.
 */
export function classifyAction(
  contract: DataContract,
  actionName: string,
): ActionClassification {
  const entry = contract.actionSpec?.[actionName];
  if (entry && typeof entry.nextStep === 'string' && entry.nextStep.length > 0) {
    return 'agent-bound';
  }
  return 'context-bound';
}

function assertPlaywright(
  playwright: PlaywrightModule | undefined,
): asserts playwright is PlaywrightModule {
  if (
    playwright === undefined ||
    playwright === null ||
    typeof playwright !== 'object' ||
    typeof (playwright as { chromium?: unknown }).chromium !== 'object'
  ) {
    throw new PlaywrightNotAvailableError();
  }
}

export async function validateContractBehavior(
  input: ValidateContractBehaviorInput,
): Promise<ValidateContractBehaviorResult> {
  const actionSpec = input.contract.actionSpec;
  const actionNames = actionSpec ? Object.keys(actionSpec) : [];
  if (actionNames.length === 0) {
    return { ok: true, failures: [] };
  }

  assertPlaywright(input.playwright);

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: BehaviorFailure[] = [];

  let browser: PlaywrightBrowser | null = null;
  try {
    browser = await input.playwright.chromium.launch({ headless: true });
    for (const name of actionNames) {
      const page = await preparePage(browser);
      try {
        const classification = classifyAction(input.contract, name);
        const outcome = await runOne(page, {
          componentCode: input.componentCode,
          contract: input.contract,
          actionName: name,
          classification,
          settleMs: SETTLE_MS,
          waitMs: timeoutMs,
        });
        const f = classify(name, outcome);
        if (f !== null) failures.push(f);
      } finally {
        await page.context().close();
      }
    }
  } finally {
    if (browser !== null) await browser.close();
  }

  return { ok: failures.length === 0, failures };
}
