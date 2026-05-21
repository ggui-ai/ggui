/**
 * Generic blueprint-match hint surface used by the OSS user-request builder.
 *
 * Cloud's `BlueprintMatch` type carries fields specific to the platform
 * cache (S3 keys, blueprint hashes, controller bindings) that don't belong
 * in the OSS package. `BlueprintHint` is the projection of that match
 * shape that `buildUserRequest` actually reads — name, description, level,
 * props/slots/callbacks. Cloud's `generator.ts` maps its richer match
 * type onto this hint at the call site.
 */

import type { JsonObject } from '@ggui-ai/protocol';

export type BlueprintLevel =
  | 'primitive'
  | 'component'
  | 'composite'
  | 'blueprint';

export type BlueprintMatchConfidence = 'exact' | 'high' | 'partial' | 'none';

export interface BlueprintHint {
  readonly name: string;
  readonly level: BlueprintLevel;
  readonly description: string;
  readonly props: ReadonlyArray<{ readonly name: string }>;
  readonly slots: ReadonlyArray<string>;
  readonly callbacks: ReadonlyArray<string>;
}

export interface BlueprintHintMatch {
  readonly blueprint: BlueprintHint;
  readonly confidence: BlueprintMatchConfidence;
  readonly reasoning: string;
  readonly props?: JsonObject;
}
