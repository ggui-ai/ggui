/**
 * `domain-error` catalog — SPEC §7.9 Plane 2 on the `tools/call` wire
 * (ggui#880). The kit's FIRST `tools/call` driver.
 *
 * A Plane-2 failure (a missing session or handshake, props that do not
 * satisfy the contract, an undeclared channel) is a tool-execution error,
 * so it is a tool RESULT with `isError: true` — never a JSON-RPC error
 * frame — whose `content[0].text` LEADS with the registered slug:
 * `<code>: <detail>`. No `structuredContent`, no `_meta`. A raw MCP agent
 * branches on `text.startsWith(code + ': ')` and on nothing else.
 *
 * Vendor-neutral by construction: the kit imports no server. The adopter
 * supplies a {@link ToolCallDriver} that performs ONE `tools/call` against
 * its deployment and returns the raw result the MCP client received (or
 * `null` when the tool is not bound there — that case is SKIPPED, named).
 * The kit owns the scenarios and every assertion. Each case ships as raw
 * JSON under `./cases/`; the six here need no setup — an id nothing
 * minted is refused the same way on every deployment.
 *
 * The catalog exists for one receipt: before the slug led the text, every
 * first-party server failed every case on `slug-leads`.
 */
import type { JsonValue } from '@ggui-ai/protocol';
import amendUnknownSession from './cases/amend-unknown-session.json' with { type: 'json' };
import consumeUnknownSession from './cases/consume-unknown-session.json' with { type: 'json' };
import emitUnknownSession from './cases/emit-unknown-session.json' with { type: 'json' };
import getSessionUnknownSession from './cases/get-session-unknown-session.json' with { type: 'json' };
import renderUnknownHandshake from './cases/render-unknown-handshake.json' with { type: 'json' };
import updateUnknownSession from './cases/update-unknown-session.json' with { type: 'json' };

/** A JSON object — the `arguments` of one `tools/call`. */
export type ToolCallArgs = { readonly [key: string]: JsonValue };

/** One `tools/call` the adopter's driver performs verbatim. */
export interface ToolCallScenario {
  readonly tool: string;
  readonly args: ToolCallArgs;
}

/** One content block of a tool result, as the MCP client received it. */
export interface ToolCallContent {
  readonly type: string;
  readonly text?: string;
}

/**
 * The raw `tools/call` result as the MCP client received it. Authored here
 * rather than imported from an SDK so the driver is typed against the kit
 * alone; `structuredContent` and `_meta` are read only for presence.
 */
export interface RawToolCallResult {
  readonly isError?: boolean;
  readonly content: readonly ToolCallContent[];
  readonly structuredContent?: unknown;
  readonly _meta?: unknown;
}

/** External-boundary guard for a value an adopter's driver returned. */
export function isRawToolCallResult(value: unknown): value is RawToolCallResult {
  if (typeof value !== 'object' || value === null) return false;
  const content = Reflect.get(value, 'content');
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) return false;
    if (typeof Reflect.get(block, 'type') !== 'string') return false;
    const text = Reflect.get(block, 'text');
    if (text !== undefined && typeof text !== 'string') return false;
  }
  const isError = Reflect.get(value, 'isError');
  return isError === undefined || typeof isError === 'boolean';
}

/**
 * Performs one `tools/call` and returns the raw result — or `null` when
 * the deployment does not bind that tool. May be async: a live call is the
 * intended binding.
 */
export type ToolCallDriver = (
  scenario: ToolCallScenario,
) => RawToolCallResult | null | Promise<RawToolCallResult | null>;

/** One catalog case, authored as JSON under `./cases/`. */
export interface DomainErrorConformanceCase {
  /** Reported as `domain-error/<name>` by the runner. */
  readonly name: string;
  readonly description: string;
  readonly scenario: ToolCallScenario;
  /** The registered slug that must lead the result text. */
  readonly expect: { readonly code: string };
}

/** The catalog, in wire order: handshake first, then the session tools. */
export const domainErrorCases: readonly DomainErrorConformanceCase[] = [
  renderUnknownHandshake,
  consumeUnknownSession,
  getSessionUnknownSession,
  updateUnknownSession,
  amendUnknownSession,
  emitUnknownSession,
];

/** The criterion a case failed on — the first that did not hold. */
export type DomainErrorCriterion =
  | 'driver-threw'
  | 'isError'
  | 'content-text'
  | 'slug-leads'
  | 'no-structuredContent'
  | 'no-meta';

export interface DomainErrorMismatch {
  readonly name: string;
  readonly criterion: DomainErrorCriterion;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface DomainErrorSkip {
  readonly name: string;
  readonly reason: string;
}

export interface DomainErrorConformanceResult {
  readonly passed: readonly string[];
  readonly failed: readonly DomainErrorMismatch[];
  readonly skipped: readonly DomainErrorSkip[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Grade one raw result against a case; `undefined` = every criterion held. */
function grade(
  testCase: DomainErrorConformanceCase,
  result: RawToolCallResult,
): DomainErrorMismatch | undefined {
  const { name } = testCase;
  if (result.isError !== true) {
    return { name, criterion: 'isError', expected: true, actual: result.isError };
  }
  const first = result.content[0];
  if (first === undefined || first.type !== 'text' || typeof first.text !== 'string') {
    return { name, criterion: 'content-text', expected: 'content[0] of type text', actual: first };
  }
  const lead = `${testCase.expect.code}: `;
  if (!first.text.startsWith(lead)) {
    return { name, criterion: 'slug-leads', expected: `${lead}<detail>`, actual: first.text };
  }
  if (result.structuredContent !== undefined) {
    return {
      name,
      criterion: 'no-structuredContent',
      expected: undefined,
      actual: result.structuredContent,
    };
  }
  if (result._meta !== undefined) {
    return { name, criterion: 'no-meta', expected: undefined, actual: result._meta };
  }
  return undefined;
}

/**
 * Drive every case through `driver` and grade the raw results. A driver
 * that throws fails THAT case (`driver-threw`) and the rest are still
 * graded; a driver that returns `null` skips that case with the tool named.
 */
export async function runDomainErrorConformance(
  driver: ToolCallDriver,
): Promise<DomainErrorConformanceResult> {
  const passed: string[] = [];
  const failed: DomainErrorMismatch[] = [];
  const skipped: DomainErrorSkip[] = [];
  for (const testCase of domainErrorCases) {
    let result: RawToolCallResult | null;
    try {
      result = await driver(testCase.scenario);
    } catch (err) {
      failed.push({
        name: testCase.name,
        criterion: 'driver-threw',
        expected: 'a raw tools/call result',
        actual: errorText(err),
      });
      continue;
    }
    if (result === null) {
      skipped.push({
        name: testCase.name,
        reason: `the driver returned null — \`${testCase.scenario.tool}\` is not bound on this deployment`,
      });
      continue;
    }
    const mismatch = grade(testCase, result);
    if (mismatch === undefined) passed.push(testCase.name);
    else failed.push(mismatch);
  }
  return { passed, failed, skipped };
}
