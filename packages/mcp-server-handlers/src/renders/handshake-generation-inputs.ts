/**
 * The generation a `ggui_render` would start for a stored handshake, as
 * pure functions over the handshake record (ggui#1321).
 *
 * `ggui_render` derives its generator input from the record the handshake
 * stored, the agent's optional `override`, and three values it resolves on
 * the way (the App's gadgets, their `.d.ts` types, the render call's
 * `infra`). These functions ARE that derivation: the render calls them, so
 * a caller that starts the same generation earlier (for example as soon as
 * a handshake decides `create`, keyed by its `handshakeId`) derives the
 * same input by construction instead of by a second copy of the logic.
 *
 * What a caller cannot know before the render is named, not hidden:
 *   - `sessionId` is minted by the render, so it is never part of the
 *     derived input — the render adds it. The generator does not read it
 *     to produce the component.
 *   - `override` and `infra` arrive on the render call. A derivation made
 *     without them is the ACCEPT path with no infra hint; a render that
 *     sends either derives a different input.
 *   - The App's gadgets and their types are I/O. {@link appGadgetsForContract}
 *     and `fetchGadgetTypes` are the steps the render runs; a caller runs
 *     the same ones.
 */
import type { App, UiGenerateInput } from '@ggui-ai/mcp-server-core';
import {
  resolveAppGadgets,
  type BlueprintVariance,
  type DataContract,
  type GadgetDescriptor,
  type JsonObject,
} from '@ggui-ai/protocol';
import type { HandshakeRecord } from './handshake.js';
import { assertGadgetsRegistered, filterDescriptorsToContract } from './assert-gadgets.js';
import { assertPublicEnvSatisfied } from './assert-public-env.js';

/** The agent's PATCH over the agreed proposal, as `ggui_render` receives it. */
export interface HandshakeRenderOverride {
  readonly contract?: DataContract;
  readonly variance?: BlueprintVariance;
}

/**
 * What a render generates FOR: the intent, the effective contract, the
 * effective variance. A type literal rather than an interface so it keeps
 * the implicit index signature the render's preview kickoff takes.
 */
export type HandshakeGenerationStory = {
  readonly intent: string;
  readonly contract: DataContract;
  readonly variance?: BlueprintVariance;
};

/**
 * The effective story for a stored handshake. ACCEPT (no `override`) takes
 * the stored effective contract and the suggestion's projected variance;
 * an override replaces whichever of the two it carries.
 */
export function storyForHandshake(
  record: HandshakeRecord,
  override?: HandshakeRenderOverride,
): HandshakeGenerationStory {
  const variance = override?.variance ?? record.suggestion.blueprintMeta.variance;
  return {
    intent: record.input.intent,
    contract: override?.contract ?? record.effectiveContract,
    ...(variance !== undefined ? { variance } : {}),
  };
}

/**
 * Narrow-only guard so a story's `context` (typed `unknown` — the render's
 * story schema passes it through) reaches `UIGenerationRequest.context`
 * only as the plain object the generator contract takes.
 */
function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The generator's input without the credential pair and without the render's `sessionId`. */
export type HandshakeGenerationInput = Omit<UiGenerateInput, 'llm' | 'providerKey' | 'request'> & {
  readonly request: Omit<UiGenerateInput['request'], 'sessionId'>;
};

/** The values a render resolves before it generates. */
export interface HandshakeGenerationResolved {
  readonly blueprints: UiGenerateInput['blueprints'];
  /** {@link appGadgetsForContract}'s result, when the deployment binds an App store. */
  readonly appGadgets?: readonly GadgetDescriptor[];
  /** `fetchGadgetTypes(appGadgets)`'s result. */
  readonly gadgetTypes?: Readonly<Record<string, string>>;
  /** The render call's `infra`. */
  readonly infra?: UiGenerateInput['infra'];
}

/**
 * The generator input for a story and the values resolved for it. The
 * render adds its `sessionId` to `request`; nothing else is added.
 */
export function generatorInputForStory(
  story: {
    readonly intent: string;
    readonly context?: unknown;
    readonly contract?: DataContract;
    readonly variance?: BlueprintVariance;
  },
  resolved: HandshakeGenerationResolved,
): HandshakeGenerationInput {
  const context: JsonObject | undefined = isJsonObject(story.context) ? story.context : undefined;
  return {
    request: {
      prompt: story.intent,
      ...(context !== undefined ? { context } : {}),
    },
    blueprints: resolved.blueprints,
    ...(story.contract !== undefined ? { contract: story.contract } : {}),
    ...(story.variance !== undefined ? { variance: story.variance } : {}),
    ...(resolved.appGadgets !== undefined ? { appGadgets: resolved.appGadgets } : {}),
    ...(resolved.gadgetTypes !== undefined ? { gadgetTypes: resolved.gadgetTypes } : {}),
    ...(resolved.infra !== undefined ? { infra: resolved.infra } : {}),
  };
}

/**
 * The generator input a `ggui_render` of this handshake would hand its
 * generator, minus `sessionId`. Pure: every I/O-derived value comes in
 * through `resolved`.
 */
export function generationInputsForHandshake(
  record: HandshakeRecord,
  resolved: HandshakeGenerationResolved & { readonly override?: HandshakeRenderOverride },
): HandshakeGenerationInput {
  return generatorInputForStory(storyForHandshake(record, resolved.override), resolved);
}

/**
 * The App's gadgets a contract's generation receives: the App record's
 * gadgets, resolved, checked and filtered to the ones the contract uses.
 * Throws the render's own refusals — a contract naming a gadget the App
 * does not register, or a gadget whose public env the App does not
 * satisfy. A caller that gets a throw here would have had the render
 * refuse, so it has nothing to generate.
 */
export function appGadgetsForContract(
  contract: DataContract,
  appRecord: Pick<App, 'gadgets' | 'publicEnv'> | null | undefined,
): readonly GadgetDescriptor[] {
  const appGadgets = resolveAppGadgets(appRecord?.gadgets);
  assertGadgetsRegistered(contract, appGadgets);
  assertPublicEnvSatisfied(contract, appGadgets, appRecord?.publicEnv);
  return filterDescriptorsToContract(contract, appGadgets);
}
