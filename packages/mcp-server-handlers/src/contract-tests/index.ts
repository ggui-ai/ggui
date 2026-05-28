/**
 * Cross-implementation contract test suites for
 * `@ggui-ai/mcp-server-handlers` factories.
 *
 * Portable test batteries that any conforming handler deployment
 * plugs into to prove wire-shape + recoverability invariants.
 *
 * **Post-Phase-B (flatten-render-identity) status.** The legacy
 * push-handler contract battery (exercising the pre-rename push
 * handler, with vessel+stack identity) has been deleted; the
 * replacement render handler — `createGguiRenderHandler` (flat
 * render identity) — does not yet have a portable contract suite.
 * Per-deps unit tests in `../renders/*.test.ts` cover the
 * behavioural invariants while the render-handler contract battery
 * is being authored. Cloud pod adapters that previously consumed the
 * push-handler suite need to be re-wired against the upcoming
 * `runRenderHandlerContract` once it lands.
 */
export {};
