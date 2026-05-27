/**
 * Cross-implementation contract test suites for
 * `@ggui-ai/mcp-server-handlers` factories.
 *
 * Portable test batteries that any conforming handler deployment
 * plugs into to prove wire-shape + recoverability invariants.
 *
 * **Post-Phase-B (flatten-render-identity) status.** The legacy
 * `runPushHandlerContract` battery exercised `createGguiPushHandler`
 * (vessel+stack identity model) — that handler is deleted; the
 * replacement `createGguiRenderHandler` (flat render identity)
 * does not yet have a portable contract suite. Per-deps unit tests in
 * `../session-mutations/*.test.ts` cover the behavioural invariants
 * while the render-handler contract battery is being authored. Cloud
 * pod adapters that previously consumed `runPushHandlerContract`
 * (`cloud/ggui-protocol-pod/deploy/src/tools/push-handler.contract.test.ts`)
 * need to be re-wired against the upcoming `runRenderHandlerContract`
 * once it lands.
 */
export {};
