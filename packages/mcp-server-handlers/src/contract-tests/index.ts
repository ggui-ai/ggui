/**
 * Cross-implementation contract test suites for
 * `@ggui-ai/mcp-server-handlers` factories.
 *
 * Portable test batteries that any conforming push-handler / handshake-
 * handler / etc. deployment plugs into to prove wire-shape +
 * recoverability invariants. Subpath import:
 *
 *   ```ts
 *   import { runPushHandlerContract } from
 *     '@ggui-ai/mcp-server-handlers/contract-tests';
 *   ```
 *
 * The in-memory invocation lives in `./push-handler.contract.test.ts`
 * and runs in the standard test surface. Cloud and other
 * adapter-backed deployments invoke the same suite from their own
 * test files against their adapter-backed deps.
 */
export {
  runPushHandlerContract,
  type PushHandlerContractFactory,
} from './push-handler.contract.js';
