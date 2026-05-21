// packages/ui-gen/src/classifier/inspect.ts
//
// Contract inspection — extracts raw signals that axis inference consumes.
// Pure function, no prompt / blueprint inputs.

import type {
  ClientCapabilitiesSpec,
  StreamChannelEntry,
} from "@ggui-ai/protocol";
import type { StreamEventKind } from "./axes";

export type ClassifierInput = {
  propsSpec?: unknown;
  /**
   * Flat `Record<actionName, ActionEntry>`. Mirrors
   * {@link DataContract.actionSpec} exactly — the classifier accepts
   * the same shape callers pass through the push path.
   */
  actionSpec?: unknown;
  /**
   * Flat `Record<channelName, StreamChannelEntry>`. Mirrors
   * {@link DataContract.streamSpec}.
   */
  streamSpec?: unknown;
  agentCapabilities?: unknown;
  /**
   * Mirrors {@link DataContract.clientCapabilities}. Typed (not
   * `unknown`) so the gadget-name walk reads `gadgets` without a cast.
   */
  clientCapabilities?: ClientCapabilitiesSpec;
} | undefined;

// =============================================================================
// Shared walk helpers
// =============================================================================

interface SchemaShape {
  type?: string;
  enum?: unknown[];
  items?: SchemaShape & { properties?: Record<string, unknown> };
  properties?: Record<string, unknown>;
  schema?: SchemaShape;
}

function resolveSchema(node: unknown): SchemaShape | undefined {
  if (!node || typeof node !== "object") return undefined;
  const n = node as SchemaShape;
  return n.schema ?? n;
}

function propType(p: unknown): string | undefined {
  const s = resolveSchema(p);
  return s?.type;
}

function itemShape(p: unknown): SchemaShape | undefined {
  const s = resolveSchema(p);
  return s?.items;
}

function propertiesOf(p: unknown): Record<string, unknown> | undefined {
  const s = resolveSchema(p);
  return s?.properties;
}

// =============================================================================
// Id-field detection — find the entity's identity key
// =============================================================================

const ID_FIELD_CANDIDATES = ["id", "uuid", "symbol", "key", "slug", "code"];

function inferIdField(itemProps: Record<string, unknown> | undefined): string {
  if (!itemProps) return "id";
  for (const cand of ID_FIELD_CANDIDATES) {
    if (cand in itemProps) return cand;
  }
  // No dedicated ID candidate — use 'id' as the expected field. Avoid the
  // "first string" fallback because it creates spurious matches (e.g.,
  // messages.sender matching a typing-presence event's sender field).
  return "id";
}

// =============================================================================
// Entity-list + singleton-with-id detection
// =============================================================================

export interface EntityList {
  /** Prop name, plural (e.g., "tasks") */
  name: string;
  /** Singular stem for Id-suffix matching (e.g., "task") */
  singular: string;
  /** Identity field on each item */
  idField: string;
  /** Keys present on each item */
  itemKeys: string[];
}

export interface SingletonEntity {
  /** Prop name (e.g., "ride", "flight", "product") */
  name: string;
  /** Keys present on the singleton */
  keys: string[];
}

function singularize(name: string): string {
  if (name.endsWith("ies")) return name.slice(0, -3) + "y";
  if (name.endsWith("ses")) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

// =============================================================================
// Recursive arr<obj> scan (for hasArrObjAnywhere)
// =============================================================================

function walkForArrObj(node: unknown, depth = 0): boolean {
  if (depth > 8 || !node || typeof node !== "object") return false;
  const s = resolveSchema(node);
  if (!s) return false;
  const t = s.type;
  const items = s.items;
  if (t === "array" && items?.type === "object") return true;
  const props = s.properties;
  if (props) {
    for (const v of Object.values(props)) {
      if (walkForArrObj(v, depth + 1)) return true;
    }
  }
  if (items && typeof items === "object") {
    const itemProps = items.properties;
    if (itemProps) {
      for (const v of Object.values(itemProps)) {
        if (walkForArrObj(v, depth + 1)) return true;
      }
    }
  }
  return false;
}

// =============================================================================
// Geo-coord detection (any prop at any depth has lat/lng pair)
// =============================================================================

function hasGeoCoordsRecursive(node: unknown, depth = 0): boolean {
  if (depth > 8 || !node || typeof node !== "object") return false;
  const s = resolveSchema(node);
  if (!s) return false;
  const props = s.properties;
  if (props) {
    const keys = Object.keys(props);
    const lowered = keys.map((k) => k.toLowerCase());
    const hasLat = lowered.includes("lat") || lowered.includes("latitude");
    const hasLng =
      lowered.includes("lng") ||
      lowered.includes("lon") ||
      lowered.includes("longitude");
    if (hasLat && hasLng) return true;
    for (const v of Object.values(props)) {
      if (hasGeoCoordsRecursive(v, depth + 1)) return true;
    }
  }
  if (s.items) {
    if (hasGeoCoordsRecursive(s.items, depth + 1)) return true;
  }
  return false;
}

// =============================================================================
// ActionEntry and payload analysis
// =============================================================================

export interface ActionEntryInfo {
  name: string;
  tool?: string;
  example?: Record<string, unknown>;
  /** Top-level keys in example whose value is scalar (string/number/boolean). */
  scalarKeys: string[];
  /** All top-level keys in the example. */
  allKeys: string[];
  /** Entity lists referenced by id-key match (taskId ↔ tasks). */
  referencedEntities: string[];
}

function scalarKeyCount(obj: unknown): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") keys.push(k);
  }
  return keys;
}

function allTopLevelKeys(obj: unknown): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>);
}

function referencedEntitiesForPayload(
  keys: string[],
  entityLists: EntityList[],
  singletons: SingletonEntity[],
): string[] {
  const hits = new Set<string>();
  for (const key of keys) {
    // direct id/key/index match → ambiguous, skip unless entity has id
    // id-suffix match: "taskId" → "task"
    if (/Id$/.test(key) && key.length > 2) {
      const stem = key.slice(0, -2).toLowerCase();
      for (const e of entityLists) {
        if (e.singular.toLowerCase() === stem) hits.add(e.name);
      }
      // Singleton with name matching the stem
      for (const s of singletons) {
        if (s.name.toLowerCase() === stem) hits.add(`__singleton:${s.name}`);
      }
    }
  }
  return [...hits];
}

// =============================================================================
// Stream-event kind inference
// =============================================================================

function isFullEntity(
  eventKeys: string[],
  entity: EntityList,
): boolean {
  // Consider "full entity" when all entity item keys are present in event schema
  return entity.itemKeys.every((k) => eventKeys.includes(k));
}

export function inferStreamKindFromSchema(
  eventSchema: SchemaShape | undefined,
  entityLists: EntityList[],
  singletons: SingletonEntity[],
): StreamEventKind {
  const eventProps = eventSchema?.properties ?? {};
  const eventKeys = Object.keys(eventProps);
  const hasBool = Object.values(eventProps).some(
    (v) => propType(v) === "boolean",
  );
  const hasUserKey = eventKeys.some((k) =>
    /sender|user|author|actor|from/i.test(k),
  );

  // Rule 1: presence — small payload with boolean + user-identifier
  // (fires BEFORE entity-list match because typing events superficially
  // share a key name with messages.sender).
  if (hasBool && hasUserKey && eventKeys.length <= 3) return "presence";

  // Rule 2: nested object with id → merge (kanban taskChanged.task.id)
  for (const v of Object.values(eventProps)) {
    const s = resolveSchema(v);
    if (s?.type === "object" && s.properties && "id" in s.properties) {
      return "merge";
    }
  }

  // Rule 3: full entity → append (event payload matches entity item schema)
  for (const entity of entityLists) {
    if (isFullEntity(eventKeys, entity)) return "append";
  }

  // Rule 4: entity-list idField or id-suffix match → merge
  for (const entity of entityLists) {
    const directMatch = eventKeys.includes(entity.idField);
    const suffixMatch = eventKeys.some((k) => {
      if (!/Id$/.test(k) || k.length <= 2) return false;
      return k.slice(0, -2).toLowerCase() === entity.singular.toLowerCase();
    });
    if (directMatch || suffixMatch) return "merge";
  }

  // Rule 5: singleton match — id-suffix OR field-overlap (≥ 2 fields)
  for (const singleton of singletons) {
    const suffixMatch = eventKeys.some((k) => {
      if (!/Id$/.test(k) || k.length <= 2) return false;
      return k.slice(0, -2).toLowerCase() === singleton.name.toLowerCase();
    });
    if (suffixMatch) return "merge";
    const overlapCount = eventKeys.filter((k) => singleton.keys.includes(k)).length;
    if (overlapCount >= 2) return "merge";
  }

  // Rule 6: enum field (no entity target) → status
  for (const v of Object.values(eventProps)) {
    const s = resolveSchema(v);
    if (Array.isArray(s?.enum) && s.enum.length > 0) return "status";
  }

  return "other";
}

// =============================================================================
// agentCapabilities.tools inspection
// =============================================================================

/**
 * Per-tool projection of the contract's `agentCapabilities.tools`
 * catalog. Also reused for `clientCapabilities.libraries` entries
 * (always with empty `requestKeys`) — libraries are pure declaration.
 */
export interface AgentToolInfo {
  name: string;
  requestKeys: string[];
}

// =============================================================================
// Top-level inspect
// =============================================================================

export interface ContractSignals {
  actions: ActionEntryInfo[];
  streams: Array<{ name: string; schema?: SchemaShape }>;
  /** Projection of `contract.agentCapabilities.tools`. The agent
   *  invokes these — they are NOT component hooks; recorded here for
   *  fetch-axis classification. */
  agentTools: AgentToolInfo[];
  /**
   * Binding names declared in `clientCapabilities.libraries`. The
   * `requestKeys` field is always empty — libraries are
   * declaration-only.
   */
  clientCapabilities: AgentToolInfo[];
  /** Top-level arr<obj> props with inferred idField. */
  entityLists: EntityList[];
  /** Top-level object props with an id field (singleton entities). */
  singletons: SingletonEntity[];
  hasArrObjAnywhere: boolean;
  hasGeoCoords: boolean;
  /**
   * Any action payload references an entity-id matching an arr<obj> prop.
   * NOTE: singleton id-refs are excluded — they don't count as per-item.
   */
  entityListIdInPayload: boolean;
  /** Any action payload references an id-suffix key matching a singleton prop. */
  singletonIdInPayload: boolean;
  /** Any single action payload references keys matching ≥ 2 different entity lists. */
  crossEntityAction: boolean;
  /** Any action payload has ≥ 3 scalar keys at top level. */
  multiFieldSubmit: boolean;
  /** Count of top-level scalar-typed props (string/number/boolean). */
  topLevelScalarCount: number;
  /** Any entity list's items carry 2D grid coordinates (row+col or x+y). */
  entitiesHaveGridPositions: boolean;
}

export function inspect(contract: ClassifierInput): ContractSignals {
  const empty: ContractSignals = {
    actions: [],
    streams: [],
    agentTools: [],
    clientCapabilities: [],
    entityLists: [],
    singletons: [],
    hasArrObjAnywhere: false,
    hasGeoCoords: false,
    entityListIdInPayload: false,
    singletonIdInPayload: false,
    crossEntityAction: false,
    multiFieldSubmit: false,
    topLevelScalarCount: 0,
    entitiesHaveGridPositions: false,
  };
  if (!contract) return empty;

  const propsField = contract.propsSpec as
    | { properties?: Record<string, unknown> }
    | undefined;
  const propsProps = propsField?.properties ?? {};

  // Entity lists (top-level arr<obj>)
  const entityLists: EntityList[] = [];
  for (const [name, p] of Object.entries(propsProps)) {
    const t = propType(p);
    const items = itemShape(p);
    if (t === "array" && items?.type === "object") {
      const itemProps = items.properties ?? {};
      entityLists.push({
        name,
        singular: singularize(name),
        idField: inferIdField(itemProps),
        itemKeys: Object.keys(itemProps),
      });
    }
  }

  // Singleton entities (top-level object props with an identifiable id key)
  const singletons: SingletonEntity[] = [];
  for (const [name, p] of Object.entries(propsProps)) {
    const t = propType(p);
    if (t === "object") {
      const childProps = propertiesOf(p) ?? {};
      const keys = Object.keys(childProps);
      if (keys.length > 0) {
        singletons.push({ name, keys });
      }
    }
  }

  // Actions — flat `Record<name, ActionEntry>`.
  const actionsMap =
    (contract.actionSpec as Record<string, unknown> | undefined) ?? {};
  const actions: ActionEntryInfo[] = [];
  for (const [name, action] of Object.entries(actionsMap)) {
    const a = action as { example?: Record<string, unknown>; tool?: string };
    const scalarKeys = scalarKeyCount(a?.example);
    const allKeys = allTopLevelKeys(a?.example);
    const referencedEntities = referencedEntitiesForPayload(
      allKeys,
      entityLists,
      singletons,
    );
    actions.push({
      name,
      tool: a?.tool,
      example: a?.example,
      scalarKeys,
      allKeys,
      referencedEntities,
    });
  }

  // Streams — each declared channel on the live session plane. Flat
  // `Record<name, StreamChannelEntry>`. Uses the real protocol type
  // (not `Record<string, unknown>`) so the iteration walks typed
  // entries.
  const channelsMap: Record<string, StreamChannelEntry> =
    (contract.streamSpec as Record<string, StreamChannelEntry> | undefined) ??
    {};
  const streams: Array<{ name: string; schema?: SchemaShape }> = [];
  for (const [name, channel] of Object.entries(channelsMap)) {
    // `StreamChannelEntry.schema` is `JsonSchema`, which structurally
    // satisfies the local `SchemaShape` (JsonSchema is a superset).
    streams.push({ name, schema: channel.schema as SchemaShape });
  }

  // agentCapabilities.tools — the agent-side tool catalog
  const agentToolsMap =
    ((contract.agentCapabilities as { tools?: Record<string, unknown> } | undefined)
      ?.tools) ?? {};
  const agentTools: AgentToolInfo[] = [];
  for (const [name, tool] of Object.entries(agentToolsMap)) {
    const t = tool as { inputSchema?: SchemaShape };
    const req = t?.inputSchema?.properties ?? {};
    agentTools.push({ name, requestKeys: Object.keys(req) });
  }

  // clientCapabilities.gadgets — pure declaration; `requestKeys` is
  // always empty (gadgets don't carry an inputSchema).
  const gadgetsMap = contract.clientCapabilities?.gadgets ?? {};
  const clientCapabilities: AgentToolInfo[] = [];
  for (const name of Object.keys(gadgetsMap)) {
    clientCapabilities.push({ name, requestKeys: [] });
  }

  // Derived flags
  const hasArrObjAnywhere = walkForArrObj({ properties: propsProps });
  const hasGeoCoords = hasGeoCoordsRecursive({ properties: propsProps });

  const entityListNames = new Set(entityLists.map((e) => e.name));
  const entityListIdInPayload = actions.some((a) =>
    a.referencedEntities.some((r) => entityListNames.has(r)),
  );
  const singletonIdInPayload = actions.some((a) =>
    a.referencedEntities.some((r) => r.startsWith("__singleton:")),
  );
  const crossEntityAction = actions.some((a) => {
    const entityRefs = a.referencedEntities.filter((r) =>
      entityListNames.has(r),
    );
    return new Set(entityRefs).size >= 2;
  });
  const multiFieldSubmit = actions.some((a) => a.scalarKeys.length >= 3);

  // Top-level scalar prop count
  let topLevelScalarCount = 0;
  for (const v of Object.values(propsProps)) {
    const t = propType(v);
    if (t === "string" || t === "number" || t === "boolean") topLevelScalarCount++;
  }

  // Entity lists with 2D grid coordinates
  const entitiesHaveGridPositions = entityLists.some((e) => {
    const keys = e.itemKeys;
    return (
      (keys.includes("row") && keys.includes("col")) ||
      (keys.includes("x") && keys.includes("y") && keys.length > 2) ||
      (keys.includes("gridRow") && keys.includes("gridColumn"))
    );
  });

  return {
    actions,
    streams,
    agentTools,
    clientCapabilities,
    entityLists,
    singletons,
    hasArrObjAnywhere,
    hasGeoCoords,
    entityListIdInPayload,
    singletonIdInPayload,
    crossEntityAction,
    multiFieldSubmit,
    topLevelScalarCount,
    entitiesHaveGridPositions,
  };
}
