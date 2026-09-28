/**
 * How an ops writer mirrors its durable row into the cache registry
 * (ggui#1497): under ONE id.
 *
 * `ggui_ops_register_blueprint` (with `createRegisterGeneratedBlueprint`,
 * which shares its core) and `ggui_ops_generate_blueprint` each put the
 * durable row first, then mirror it into the cache so the exact-key probe
 * finds it. The mirror used to mint an id of its own, so a render served
 * from that cache row recorded an id the writer's store never held. The
 * mirror now takes the writer's id (`mintId`), and what else it writes
 * depends on where re-mint reads:
 *
 * - The mirror's registry writes through to a durable store OTHER than the
 *   writer's (a server that keeps its re-mint store apart from the ops
 *   store): the full write-through runs, now under the shared id, so the
 *   store re-mint reads holds the row and the compiled body under the id
 *   the cache serves.
 * - It writes through to the writer's OWN store: the row is already there
 *   under this id, and the store refuses a second put of it, so the mirror
 *   skips the row but still puts the compiled body into its code store,
 *   where re-mint reads it.
 * - No durable store (a code store at most): nothing more is written; the
 *   writer's own store and body are what re-mint reads.
 *
 * The authored source still reaches a bound code store in every case
 * (ggui#1493). A dedup is unchanged: an exact key already bound returns its
 * existing id, and nothing more is written for it.
 */
import type { BlueprintStore } from "@ggui-ai/mcp-server-core";
import {
  registerBlueprint,
  type BlueprintRegistryDeps,
  type RegisterBlueprintInput,
  type RegisteredBlueprint,
} from "../renders/blueprint-registry.js";

export async function mirrorIntoCache(args: {
  /** The cache registry the writer mirrors into. */
  readonly cacheRegistry: BlueprintRegistryDeps;
  /** The store the writer already put the durable row in, under `blueprintId`. */
  readonly writerStore: BlueprintStore;
  readonly appId: string;
  /** The writer's durable row id: the cache row takes it. */
  readonly blueprintId: string;
  readonly input: RegisterBlueprintInput;
}): Promise<RegisteredBlueprint> {
  const durability = args.cacheRegistry.durability;
  const sharesWriterStore =
    durability?.blueprintStore !== undefined && durability.blueprintStore === args.writerStore;
  const deps: BlueprintRegistryDeps = sharesWriterStore
    ? {
        ...args.cacheRegistry,
        durability: durability.codeStore !== undefined ? { codeStore: durability.codeStore } : {},
      }
    : args.cacheRegistry;
  const registered = await registerBlueprint(deps, args.appId, args.input, {
    mintId: () => args.blueprintId,
  });
  const codeStore = durability?.codeStore;
  if (sharesWriterStore && !registered.deduped && codeStore !== undefined && args.input.componentCode.length > 0) {
    await codeStore.put(codeStore.hashOf(args.input.componentCode), args.input.componentCode);
  }
  return registered;
}
