/**
 * `@ggui-ai/protocol-reference-server` — minimal reference
 * implementation of the ggui protocol.
 *
 * **Role**: empirical proof of the protocol's vendor-neutral
 * separation. If an independent, from-scratch implementation passes
 * `@ggui-ai/protocol-conformance`, the protocol's vendor-neutrality
 * claim is grounded — not an aspiration.
 *
 * **Non-goals**:
 *   - Not a production server.
 *   - Not intended for agent use.
 *   - Deliberately does NOT depend on `@ggui-ai/mcp-server*` — the
 *     whole point of this package is to prove those aren't needed.
 */
export const REFERENCE_SERVER_VERSION = '0.1.0';

// Public surface for embedding the reference server in an external
// runner — used to drive the `@ggui-ai/protocol-conformance` kit
// through the reference WS server from inside a browser-based test
// harness.
//
// Embedding contract:
//   - Caller owns lifecycle: `new ReferenceServer({port: 0}); await
//     server.start(); … await server.stop()`.
//   - `createReferenceConformanceHost({serverInstance})` returns the
//     `ConformanceHost` to pass into `runConformance({host})`.
//   - Throws on unimplemented directives — kit maps them to SKIP.
export { ReferenceServer } from './server.js';
export type { ReferenceServerOptions } from './server.js';
// Deployment-level identity-default app id (SPEC §12.2: a subscribe
// MAY omit `appId`; this no-auth server resolves every caller to this
// deployment-wide tenant). Exported so external runners can assert
// the bound default without restating the literal.
export { DEPLOYMENT_DEFAULT_APP_ID } from './render.js';
export {
  createReferenceConformanceHost,
  type CreateReferenceConformanceHostInput,
} from './conformance-host.js';
