/**
 * Anthropic model-family rules — which Claude models refuse which
 * request parameters — shared by every caller that builds an Anthropic
 * request: the generation harness's router (`@ggui-ai/ui-gen`), the
 * negotiator's structured call (`@ggui-ai/mcp-server`), and the
 * negotiator/probe tooling. One module instead of a copy per caller:
 * a model the API starts refusing a parameter for is added here once.
 * The families are regexes today — themselves a second list of models
 * beside the registry — and ggui#1268 moves the forced-tool fact onto
 * the registry rows.
 *
 * Lives in protocol beside `llm-route.ts` because model facts live
 * here: the registry rows (`llm.ts`), the allowlists and the
 * Bedrock/OpenRouter shape validators (`llm-route.ts`). Pure string
 * predicates; no SDK, no I/O.
 *
 * **The model lists GROW, and that is the contract.** Each predicate
 * answers "does Anthropic refuse this parameter on this model?", and
 * Anthropic adds models that refuse things. A predicate starting to
 * return `true` for a model id it returned `false` for (a newly listed
 * model, or a newly recognised spelling of one) is an ADDITIVE change
 * under VERSION-POLICY, not a breaking one: callers already handle both
 * answers for every id. What is frozen is the signatures (`string` in,
 * `boolean`/`string` out) and the direction of each answer. Never
 * snapshot a predicate's output as a fixed list.
 *
 * The two directions are not equally safe. Widening (`true` for more
 * ids) is the SAFE direction: a wrong `true` degrades to the permissive
 * request (sampling params omitted, `tool_choice: auto`). Narrowing
 * (`true` → `false`) is the UNSAFE direction: a wrong `false` sends a
 * parameter the API rejects with a 400 — so a narrowing needs the
 * vendor's page quoted on the issue, not only a test. For
 * `normalizeAnthropicModelId`, which returns a string, the matching
 * rule is that a newly recognised spelling maps to the SAME bare id,
 * never a different one.
 */

/**
 * Strip every routing spelling down to the bare Claude API id so the
 * family predicates below see one form: `anthropic/claude-x`,
 * `anthropic.claude-x`, `us.anthropic.claude-x[-vN:M]` and the bare
 * `claude-x` all normalize to `claude-x…`. ARNs are left as-is (they
 * name a profile, not a family) and match no predicate.
 */
export function normalizeAnthropicModelId(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
}

/**
 * Models that reject non-default sampling parameters with HTTP 400:
 * Opus 4.7 and everything after it (Fable 5, Fable 5.1, Opus 5,
 * Sonnet 5). Haiku 4.5 (`claude-haiku-4-5*`) still accepts them.
 * Strings per ggui#706 (platform.claude.com, verified 2026-09-02).
 */
export function anthropicRejectsSamplingParams(model: string): boolean {
  return /^claude-(?:opus-4-7|opus-5|sonnet-5|fable-5)(?:-|$)/.test(
    normalizeAnthropicModelId(model)
  );
}

/**
 * Models that reject a FORCED tool choice (`tool_choice: any` / a named
 * tool) with HTTP 400: Claude Fable 5.1 (ggui#706). `auto` is accepted.
 */
export function anthropicRejectsForcedToolChoice(model: string): boolean {
  return /^claude-fable-5-1(?:-|$)/.test(normalizeAnthropicModelId(model));
}
