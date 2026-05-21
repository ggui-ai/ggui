/**
 * `wired-action-dispatch` fixture sub-module.
 *
 * Exercises the full `wiredActionRouter` dispatch contract — every
 * `ContractErrorCode` failure path + the happy path:
 *   - `wired-action-success` — wired action dispatches → tool
 *     executes → observability event fires.
 *   - `wired-action-tool-not-found` — `TOOL_NOT_FOUND` error code
 *     emits on `_ggui:contract-error`.
 *   - `wired-action-tool-threw` — `TOOL_THREW` with sanitized
 *     `causedBy` in payload.
 *   - `wired-action-tool-timeout` — `TOOL_TIMEOUT` after router's
 *     configured timeout.
 *
 * `wired-action-success` + `wired-action-tool-threw` drive against
 * the current harness; the other two are `ConformanceHost`-gated.
 */
import wiredActionSuccess from './wired-action-success.json' with { type: 'json' };
import wiredActionToolNotFound from './wired-action-tool-not-found.json' with { type: 'json' };
import wiredActionToolThrew from './wired-action-tool-threw.json' with { type: 'json' };
import wiredActionToolTimeout from './wired-action-tool-timeout.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting the wired-action-dispatch contract (Contract
 *  #3 — defined failure modes on `wiredActionRouter`). */
export const wiredActionDispatchFixtures: readonly TestCase[] = [
  wiredActionSuccess as TestCase,
  wiredActionToolNotFound as TestCase,
  wiredActionToolThrew as TestCase,
  wiredActionToolTimeout as TestCase,
];
