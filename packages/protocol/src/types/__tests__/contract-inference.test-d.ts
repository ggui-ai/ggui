// Compile-time type tests for contract inference.
// This file should compile with zero errors — that IS the test.
// Run: pnpm exec tsc --noEmit (from protocol package)

import { defineContract } from '../contract-inference';
import type {
  SchemaToType,
  InferProps,
  InferActionNames,
  InferActionPayload,
  InferStreamNames,
  InferStreamPayload,
  InferContextNames,
  InferContextValue,
  InferAgentToolNames,
  InferGadgetNames,
  TypedAction,
  TypedStreamEvent,
  ContractTypeMap,
  PropsOf,
  ActionNames,
  ActionPayload,
} from '../contract-inference';

// =============================================================================
// Helper: compile-time assertion (errors if T is not exactly Expected)
// =============================================================================
type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// =============================================================================
// 1. SchemaToType — primitive mappings
// =============================================================================

type _S1 = Expect<Equal<SchemaToType<{ readonly type: 'string' }>, string>>;
type _S2 = Expect<Equal<SchemaToType<{ readonly type: 'number' }>, number>>;
type _S3 = Expect<Equal<SchemaToType<{ readonly type: 'integer' }>, number>>;
type _S4 = Expect<Equal<SchemaToType<{ readonly type: 'boolean' }>, boolean>>;
type _S5 = Expect<Equal<SchemaToType<{ readonly type: 'null' }>, null>>;

// =============================================================================
// 2. SchemaToType — array
// =============================================================================

type _SA = Expect<Equal<
  SchemaToType<{ readonly type: 'array'; readonly items: { readonly type: 'string' } }>,
  string[]
>>;

type _SAO = Expect<Equal<
  SchemaToType<{
    readonly type: 'array';
    readonly items: {
      readonly type: 'object';
      readonly properties: { readonly id: { readonly type: 'number' } };
      readonly required: readonly ['id'];
    };
  }>,
  { id: number }[]
>>;

// =============================================================================
// 3. SchemaToType — object
// =============================================================================

type _SO = Expect<Equal<
  SchemaToType<{ readonly type: 'object'; readonly properties: {
    readonly name: { readonly type: 'string' };
    readonly age: { readonly type: 'number' };
    readonly active: { readonly type: 'boolean' };
  }; readonly required: readonly ['name', 'age', 'active'] }>,
  { name: string; age: number; active: boolean }
>>;

// Object without properties → JsonObject
type _SOD = Expect<Equal<
  SchemaToType<{ readonly type: 'object' }>,
  import('../data-contract').JsonObject
>>;

// =============================================================================
// 4. SchemaToType — enum and const
// =============================================================================

type _SE = Expect<Equal<
  SchemaToType<{ readonly type: 'string'; readonly enum: readonly ['red', 'green', 'blue'] }>,
  'red' | 'green' | 'blue'
>>;

type _SC = Expect<Equal<
  SchemaToType<{ readonly const: 42 }>,
  42
>>;

// =============================================================================
// 5. Nested objects
// =============================================================================

type _SN = Expect<Equal<
  SchemaToType<{ readonly type: 'object'; readonly properties: {
    readonly address: { readonly type: 'object'; readonly properties: {
      readonly street: { readonly type: 'string' };
      readonly zip: { readonly type: 'number' };
    }; readonly required: readonly ['street', 'zip'] };
  }; readonly required: readonly ['address'] }>,
  { address: { street: string; zip: number } }
>>;

// =============================================================================
// 6. Full defineContract + inference
// =============================================================================

const _weatherContract = defineContract({
  propsSpec: { properties: {
    // `required: true` on each PropEntry. The inference honors these
    // flags; the explicit annotation matches the asserted shape
    // (`{ city: string; temperature: number; unit: 'C' | 'F' }`).
    city: { schema: { type: 'string' }, required: true },
    temperature: { schema: { type: 'number' }, required: true },
    unit: { schema: { type: 'string', enum: ['C', 'F'] }, required: true },
  }},
  actionSpec: {
    refresh: { label: 'Refresh' },
    changeUnit: {
      label: 'Change Unit',
      schema: {
        type: 'object',
        properties: { unit: { type: 'string' } },
        required: ['unit'],
      },
    },
  },
  streamSpec: {
    weatherUpdate: {
      schema: {
        type: 'object',
        properties: {
          temp: { type: 'number' },
          conditions: { type: 'string' },
        },
        required: ['temp', 'conditions'],
      },
    },
    alert: { schema: { type: 'string' } },
  },
  agentCapabilities: { tools: {
    getForecast: {
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'number' } },
        required: ['days'],
      },
      outputSchema: {
        type: 'object',
        properties: { forecast: { type: 'array', items: { type: 'string' } } },
        required: ['forecast'],
      },
    },
  }},
  clientCapabilities: { gadgets: {
    '@ggui-ai/gadgets': { useGeolocation: {} },
  }},
} as const);

type W = typeof _weatherContract;

// Props
type _P = Expect<Equal<InferProps<W>, {
  city: string;
  temperature: number;
  unit: 'C' | 'F';
}>>;

// Action names
type _AN = Expect<Equal<InferActionNames<W>, 'refresh' | 'changeUnit'>>;

// Action payloads
type _AP1 = Expect<Equal<InferActionPayload<W, 'refresh'>, void>>;
type _AP2 = Expect<Equal<InferActionPayload<W, 'changeUnit'>, { unit: string }>>;

// Stream names
type _SN2 = Expect<Equal<InferStreamNames<W>, 'weatherUpdate' | 'alert'>>;

// Stream payloads
type _SP1 = Expect<Equal<InferStreamPayload<W, 'weatherUpdate'>, { temp: number; conditions: string }>>;
type _SP2 = Expect<Equal<InferStreamPayload<W, 'alert'>, string>>;

// Agent tool names — catalog enumeration only. Per-tool input/output
// inference (InferAgentToolInput / InferAgentToolOutput) retired
// 2026-05-11 alongside useWiredTool; agentTools is a catalog the AGENT
// invokes, not a component-side hook surface.
type _ATN = Expect<Equal<InferAgentToolNames<W>, 'getForecast'>>;

// Client capability EXPORT names — the union of every export name
// across every declared package; declarations only, no input/output
// types.
type _CTN = Expect<Equal<InferGadgetNames<W>, 'useGeolocation'>>;

// TypedAction union
type _TA = Expect<Equal<TypedAction<W>,
  | { name: 'refresh'; data: void }
  | { name: 'changeUnit'; data: { unit: string } }
>>;

// TypedStreamEvent union — canonical post-rewrite shape
// ({channel, payload, complete?, stackItemId?} per channel)
type _TSE = Expect<Equal<TypedStreamEvent<W>,
  | { channel: 'weatherUpdate'; payload: { temp: number; conditions: string }; complete?: boolean; stackItemId?: string }
  | { channel: 'alert'; payload: string; complete?: boolean; stackItemId?: string }
>>;

// =============================================================================
// 7. Manual ContractTypeMap path
// =============================================================================

interface MyManualContract extends ContractTypeMap {
  props: { city: string; temp: number };
  actions: { refresh: null; changeUnit: { unit: 'C' | 'F' } };
  streams: { update: { temp: number } };
}

type _MP = Expect<Equal<PropsOf<MyManualContract>, { city: string; temp: number }>>;
type _MAN = Expect<Equal<ActionNames<MyManualContract>, 'refresh' | 'changeUnit'>>;
type _MAP = Expect<Equal<ActionPayload<MyManualContract, 'changeUnit'>, { unit: 'C' | 'F' }>>;

// =============================================================================
// 8. Edge cases
// =============================================================================

// Empty contract — Post-Item-3b, name fallback is `never`, props still
// falls back to JsonObject (props fallback is not part of the 3b scope).
const _emptyContract = defineContract({} as const);
type E = typeof _emptyContract;
type _EN = Expect<Equal<InferActionNames<E>, never>>; // Item 3b: was `string`, tightened to `never`.
type _EP = Expect<Equal<InferProps<E>, import('../data-contract').JsonObject>>;

// Contract with only props — no actionSpec → `never` under Item 3b.
// `required: true` on the prop preserves the original test intent
// under honored-required behavior.
const _propsOnly = defineContract({
  propsSpec: { properties: { name: { schema: { type: 'string' }, required: true } } },
} as const);
type PO = typeof _propsOnly;
type _PON = Expect<Equal<InferActionNames<PO>, never>>; // Item 3b: was `string`, tightened to `never`.
type _POP = Expect<Equal<InferProps<PO>, { name: string }>>;

// =============================================================================
// 9. 0de89beb regression guards + fallback locks (Item 3a → Item 3b)
// =============================================================================
//
// Item 3b flipped the NAME fallbacks for `InferActionNames` /
// `InferStreamNames` from `string` → `never`, and retains `unknown`
// on the payload fallback. `InferAgentToolNames` /
// `InferClientToolNames` intentionally STAY on `string` fallback —
// the scope is narrow to action + stream names.
//
// Two protections in this section:
//
//  (a) POSITIVE guards for the 0de89beb regression class. That bug had the
//      conditional types pattern-matching the pre-flatten wrapper shape
//      (`{actions:{actions:…}}`) while the real shape was flat (`actionSpec`).
//      Every call silently fell through to the fallback branch, degrading
//      `InferActionNames`/`InferStreamNames` to broad `string` (pre-3b) /
//      `never` (post-3b) and `InferActionPayload`/`InferStreamPayload` to
//      `unknown`. Section 6 already pins the two-member-union case; this
//      section adds single-member-union coverage (critical because
//      `Extract<keyof {a}, string>` collapsing to `'a'` vs the fallback
//      is the precise symptom a regression would re-introduce) plus
//      every missing Infer* branch.
//
//  (b) NEGATIVE guards that LOCK the POST-3b fallback behavior. Each
//      fallback resolution is asserted against its exact current type.
//      Any future change that regresses back (e.g., `never → string` for
//      the absent-spec case) will fail these assertions, forcing the
//      regression to be an intentional, routed change rather than silent
//      drift. Post-3b variants:
//
//        - absent `actionSpec` / `streamSpec` entirely → fallback branch
//          fires → `never` (names) / `unknown` (payloads).
//        - absent `wiredTools` / `clientTools` entirely → fallback branch
//          fires → `string` (names) / `unknown` (payloads) [3b-out-of-scope].
//        - present-but-empty `actionSpec: {}` / `streamSpec: {}` /
//          `agentCapabilities: {tools:{}}` / `clientTools: {tools:{}}` → first
//          conditional branch matches; `Extract<keyof {}, string> = never`
//          → names = `never`, payload lookups = `never` via the inner
//          `N extends keyof A` branch.
//
//      Both variants assert ACTUAL current types.

// ── 9.1 Single-action → literal 'submit' (NOT broad string) ─────────────────
// If the conditional regresses, this collapses to `string` and the assertion
// flips — the precise 0de89beb shape in its single-member form.
const _singleAction = defineContract({
  actionSpec: { submit: { label: 'Submit' } },
} as const);
type SA = typeof _singleAction;
type _SA_Name = Expect<Equal<InferActionNames<SA>, 'submit'>>;
type _SA_Payload = Expect<Equal<InferActionPayload<SA, 'submit'>, void>>;
// Non-key lookup on present actionSpec → `never` (middle branch).
type _SA_NonKey = Expect<Equal<InferActionPayload<SA, 'nonexistent'>, never>>;

// ── 9.2 Single-action with schema — payload path fires ─────────────────────
const _singleActionSchema = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
} as const);
type SAS = typeof _singleActionSchema;
type _SAS_Name = Expect<Equal<InferActionNames<SAS>, 'save'>>;
type _SAS_Payload = Expect<Equal<InferActionPayload<SAS, 'save'>, { id: string }>>;

// ── 9.3 Single-stream → literal 'tick' (NOT broad string) ──────────────────
const _singleStream = defineContract({
  streamSpec: { tick: { schema: { type: 'number' } } },
} as const);
type SS = typeof _singleStream;
type _SS_Name = Expect<Equal<InferStreamNames<SS>, 'tick'>>;
type _SS_Payload = Expect<Equal<InferStreamPayload<SS, 'tick'>, number>>;
// Non-key lookup on present streamSpec → `never`.
type _SS_NonKey = Expect<Equal<InferStreamPayload<SS, 'nonexistent'>, never>>;

// ── 9.4 Single wired tool — literal name + schema / no-schema branches ─────
const _singleWired = defineContract({
  agentCapabilities: {
    tools: {
      ping: {
        inputSchema: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          required: ['ms'],
        },
        outputSchema: {
          type: 'object',
          properties: { pong: { type: 'boolean' } },
          required: ['pong'],
        },
      },
    },
  },
} as const);
type SW = typeof _singleWired;
type _SW_Name = Expect<Equal<InferAgentToolNames<SW>, 'ping'>>;

// Per-tool input/output inference retired 2026-05-11 with `useWiredTool`.
// agentTools is a catalog the AGENT invokes; component-side payload
// types are no longer modeled (the component never invokes).

// Agent tool with no schemas — the catalog still enumerates the name.
const _wiredNoSchemas = defineContract({
  agentCapabilities: { tools: { fireAndForget: {} } },
} as const);
type WNS = typeof _wiredNoSchemas;
type _WNS_Name = Expect<Equal<InferAgentToolNames<WNS>, 'fireAndForget'>>;

// ── 9.5 Single gadget export — literal export-name (declaration only) ──
const _singleClient = defineContract({
  clientCapabilities: {
    gadgets: {
      '@ggui-ai/gadgets': { useGeolocation: {} },
    },
  },
} as const);
type SCT = typeof _singleClient;
type _SCT_Name = Expect<Equal<InferGadgetNames<SCT>, 'useGeolocation'>>;
// Gadget values flow through the runtime hook, not the contract type.

// ── 9.6 Fallback lock — actionSpec ABSENT (fallback branch fires) ──────────
// Whole-contract-empty form: `T` has no `actionSpec` key → `InferActionNames`
// resolves via the fallback `: never` branch (post-Item-3b). Pre-3b this
// was `: string`; the flip is intentional so `useAction('nonExistent')`
// against an empty contract is a compile error.
const _actionsAbsent = defineContract({} as const);
type AA = typeof _actionsAbsent;
type _AA_Name = Expect<Equal<InferActionNames<AA>, never>>;
// Payload on absent spec → fallback branch → `unknown` (still `unknown`
// post-3b; payload fallback is NOT part of the 3b scope).
type _AA_Payload = Expect<Equal<InferActionPayload<AA, 'anything'>, unknown>>;

// ── 9.7 Fallback lock — actionSpec PRESENT-BUT-EMPTY ───────────────────────
// `actionSpec: {}` MATCHES the first conditional branch; `keyof {} = never`,
// so `Extract<keyof {}, string> = never`. This is the boundary case the
// brief's prose conflated with the absent case — locking both variants
// independently is what keeps future silent drift visible.
const _actionsEmpty = defineContract({ actionSpec: {} } as const);
type AE = typeof _actionsEmpty;
type _AE_Name = Expect<Equal<InferActionNames<AE>, never>>;
// Payload lookup on present-empty spec → inner branch `N extends keyof A` is
// `never`, so the middle-conditional result is `never` (not `unknown`).
type _AE_Payload = Expect<Equal<InferActionPayload<AE, 'anything'>, never>>;

// ── 9.8 Fallback lock — streamSpec ABSENT + PRESENT-EMPTY ──────────────────
// ABSENT → Post-Item-3b, fallback → `never` (was `string` pre-3b).
// PRESENT-EMPTY branch (further down) is unchanged — still `never`.
const _streamsAbsent = defineContract({} as const);
type SAb = typeof _streamsAbsent;
type _SAb_Name = Expect<Equal<InferStreamNames<SAb>, never>>;
type _SAb_Payload = Expect<Equal<InferStreamPayload<SAb, 'anything'>, unknown>>;

const _streamsEmpty = defineContract({ streamSpec: {} } as const);
type SE = typeof _streamsEmpty;
type _SE_Name = Expect<Equal<InferStreamNames<SE>, never>>;
type _SE_Payload = Expect<Equal<InferStreamPayload<SE, 'anything'>, never>>;

// ── 9.9 Fallback lock — agentCapabilities absent + present-empty ─────────
// Tool names stay on `string` fallback when agentCapabilities is absent —
// Item 3b scope is narrow to `InferActionNames` / `InferStreamNames`.
// A future slice MAY widen the 3b tightening to the catalog namespaces;
// until then this assertion pins the DIVERGENCE as intentional (not
// silent drift).
type _WAb_Name = Expect<Equal<InferAgentToolNames<AA>, string>>;

// agentCapabilities present but tools map empty → names = `never`.
const _wiredEmpty = defineContract({
  agentCapabilities: { tools: {} },
} as const);
type WE = typeof _wiredEmpty;
type _WE_Name = Expect<Equal<InferAgentToolNames<WE>, never>>;

// clientCapabilities absent → names = `string` (fallback branch).
type _CAb_Name = Expect<Equal<InferGadgetNames<AA>, string>>;

// clientCapabilities present but capabilities map empty → names = `never`.
const _clientEmpty = defineContract({
  clientCapabilities: { gadgets: {} },
} as const);
type CE = typeof _clientEmpty;
type _CE_Name = Expect<Equal<InferGadgetNames<CE>, never>>;

// =============================================================================
// 10. contextSpec inference
// =============================================================================
//
// Mirrors the actionSpec / streamSpec inference assertions:
//   - present spec → literal-union names + schema-narrowed values
//   - present-empty spec → `never` names + `never` values (inner branch)
//   - absent spec → `never` names + `unknown` values (fallback branch,
//     parallel to the post-3b actionSpec / streamSpec posture)

// ── 10.1 Multi-slot contract → literal name union + per-slot value ─────────
const _contextContract = defineContract({
  contextSpec: {
    currentStep: { schema: { type: 'number' } },
    draft: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
    tab: { schema: { type: 'string', enum: ['inbox', 'sent', 'drafts'] } },
  },
} as const);
type CState = typeof _contextContract;
type _CState_Name = Expect<Equal<
  InferContextNames<CState>,
  'currentStep' | 'draft' | 'tab'
>>;
type _CState_V1 = Expect<Equal<InferContextValue<CState, 'currentStep'>, number>>;
type _CState_V2 = Expect<Equal<
  InferContextValue<CState, 'draft'>,
  { title: string; body: string }
>>;
type _CState_V3 = Expect<Equal<
  InferContextValue<CState, 'tab'>,
  'inbox' | 'sent' | 'drafts'
>>;

// ── 10.2 Single-slot — literal name (NOT broad string) ──────────────────────
// Same regression-class guard as actionSpec / streamSpec single-member.
const _singleContext = defineContract({
  contextSpec: { hover: { schema: { type: 'boolean' } } },
} as const);
type CSS = typeof _singleContext;
type _CSS_Name = Expect<Equal<InferContextNames<CSS>, 'hover'>>;
type _CSS_Value = Expect<Equal<InferContextValue<CSS, 'hover'>, boolean>>;
// Non-key lookup on present contextSpec → `never`.
type _CSS_NonKey = Expect<Equal<InferContextValue<CSS, 'nonexistent'>, never>>;

// ── 10.3 Slot WITHOUT schema (defensive) → `unknown` value ──────────────────
// `ContextEntry.schema` is required at the runtime contract layer
// (push-time validator rejects schemaless slots). Pin the inference
// fallback against a hand-built shape to verify the conditional's
// `S[N] extends { schema: ... }` branch falls through to `unknown`
// rather than blowing up — defensive lock, not a real authoring path.
type _ManualNoSchemaContract = {
  readonly intent: 'test';
  readonly contextSpec: {
    readonly stale: { readonly description: 'no schema' };
  };
};
type _CHNS_Value = Expect<Equal<
  InferContextValue<_ManualNoSchemaContract, 'stale'>,
  unknown
>>;

// ── 10.4 Fallback lock — contextSpec ABSENT → never names + unknown values ──
type _CAbsent_Name = Expect<Equal<InferContextNames<AA>, never>>;
type _CAbsent_Value = Expect<Equal<InferContextValue<AA, 'anything'>, unknown>>;

// ── 10.5 Fallback lock — contextSpec PRESENT-BUT-EMPTY → never both ─────────
const _ctxEmpty = defineContract({
  contextSpec: {},
} as const);
type CHE = typeof _ctxEmpty;
type _CHE_Name = Expect<Equal<InferContextNames<CHE>, never>>;
type _CHE_Value = Expect<Equal<InferContextValue<CHE, 'anything'>, never>>;

// =============================================================================
// 11. JSON Schema `required` array honor
// =============================================================================
//
// An earlier `SchemaToType` object case treated EVERY property as
// required regardless of whether the schema declared a
// `required: string[]` array. Same bug at the props level: every
// `PropEntry` was required regardless of `entry.required`. This section
// pins the corrected behavior for every spec surface that uses
// `SchemaToType` on an object schema (action / stream / context /
// wired-tool req+res / client-tool args+res) plus the props-level
// `required: boolean` honor on `InferProps`.
//
// Per JSON Schema draft-07: properties NOT listed in `required` are
// OPTIONAL. The pre-8.6 implementation matched no JSON Schema
// interpretation; the fix is the canonical interpretation.

// ── 11a — actionSpec object schema with required: ['title'] ────────────────
const _withRequired = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['title'],
      },
    },
  },
} as const);
type _SavePayload = InferActionPayload<typeof _withRequired, 'save'>;
type _Save_RequiredKey = Expect<Equal<_SavePayload, {
  title: string;
  tags?: string[];
}>>;

// ── 11b — actionSpec object schema with NO required → all optional ──────────
const _noRequired = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const);
type _SavePayloadAllOptional = InferActionPayload<typeof _noRequired, 'save'>;
type _AllOpt = Expect<Equal<_SavePayloadAllOptional, {
  title?: string;
  tags?: string[];
}>>;

// ── 11c — actionSpec object schema with required: [] (empty array) ─────────
const _emptyRequired = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: [],
      },
    },
  },
} as const);
type _EmptyReqPayload = InferActionPayload<typeof _emptyRequired, 'save'>;
type _EmptyReq = Expect<Equal<_EmptyReqPayload, { title?: string }>>;

// ── 11d — InferProps with mixed required/optional PropEntry flags ──────────
const _propsMixed = defineContract({
  propsSpec: {
    properties: {
      city: { schema: { type: 'string' }, required: true },
      temp: { schema: { type: 'number' } },
      humidity: { schema: { type: 'number' }, required: false },
    },
  },
} as const);
type _PropsMixed = InferProps<typeof _propsMixed>;
type _Props_Mixed = Expect<Equal<_PropsMixed, {
  city: string;
  temp?: number;
  humidity?: number;
}>>;

// ── 11e — InferProps with NO required flags → all optional ──────────────────
const _propsNoRequired = defineContract({
  propsSpec: {
    properties: {
      city: { schema: { type: 'string' } },
      temp: { schema: { type: 'number' } },
    },
  },
} as const);
type _PropsAllOpt = InferProps<typeof _propsNoRequired>;
type _Props_AllOpt = Expect<Equal<_PropsAllOpt, {
  city?: string;
  temp?: number;
}>>;

// ── 11f — streamSpec object schema with required ────────────────────────────
const _streamWithRequired = defineContract({
  streamSpec: {
    update: {
      schema: {
        type: 'object',
        properties: {
          temp: { type: 'number' },
          conditions: { type: 'string' },
        },
        required: ['temp'],
      },
    },
  },
} as const);
type _StreamPayload = InferStreamPayload<typeof _streamWithRequired, 'update'>;
type _Stream_Req = Expect<Equal<_StreamPayload, {
  temp: number;
  conditions?: string;
}>>;

// ── 11g — contextSpec object schema with required ───────────────────────────
const _contextWithRequired = defineContract({
  contextSpec: {
    draft: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
} as const);
type _CtxValue = InferContextValue<typeof _contextWithRequired, 'draft'>;
type _Ctx_Req = Expect<Equal<_CtxValue, {
  title: string;
  body?: string;
}>>;

// ── 11h — agentTools catalog (input/output type inference retired) ─────────
// Per-tool input/output inference (InferAgentToolInput / InferAgentToolOutput)
// retired 2026-05-11 alongside `useWiredTool`. agentTools is a catalog the
// AGENT invokes — the component never imports per-tool payload types.
// The catalog's name-enumeration test stays in section 9 above; this
// section's required-honor regression guards (which only tested the
// retired Input/Output helpers) are no longer applicable.

// ── 11i — clientCapabilities export declaration ─────────────────────────────
// Slice GG.8.8: wire-side `clientCapabilities.gadgets` is package-keyed —
// `Record<package, Record<exportName, { description?, usage? }>>`. There is
// no `exports` wrapper; a package entry IS its export map. The export name
// is the inner map key; its grammar discriminates kind. No `version`, no
// transport metadata, no `required` flag on the wire.
const _clientWithRequired = defineContract({
  clientCapabilities: {
    gadgets: {
      '@my-org/picker': { usePicker: {} },
    },
  },
} as const);
type _ClientName = InferGadgetNames<typeof _clientWithRequired>;
type _Client_Name = Expect<Equal<_ClientName, 'usePicker'>>;

// ── 11i.2 — InferGadgetNames over MULTIPLE packages + a component export ──
// F6: `InferGadgetNames` is the union of every export name across every
// declared package — both hook keys and component keys. A two-package
// contract where one package ships a component export and a hook export
// must infer the flat union of all three export names. Pins that the
// package-keyed two-level wire map is walked correctly by the inference.
const _multiPkgGadgets = defineContract({
  clientCapabilities: {
    gadgets: {
      '@a/x': { useFoo: {} },
      '@b/y': { Bar: {}, useBaz: {} },
    },
  },
} as const);
type _MultiPkgGadgetNames = InferGadgetNames<typeof _multiPkgGadgets>;
type _MultiPkg_Name = Expect<
  Equal<_MultiPkgGadgetNames, 'useFoo' | 'Bar' | 'useBaz'>
>;

// ── 11j — Nested object honor — inner schema's required is independent ─────
// The fix is recursive: an outer object with required: ['outer'] composes
// with an inner object schema that declares its own required: ['inner'].
const _nested = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: {
          author: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['author'],
      },
    },
  },
} as const);
type _NestedPayload = InferActionPayload<typeof _nested, 'save'>;
type _Nested = Expect<Equal<_NestedPayload, {
  author: { name: string; email?: string };
  tags?: string[];
}>>;

// ── 11k — required as readonly tuple (`as const`) — supported via the
//        `readonly (infer R)[]` extraction in `RequiredKeysOf<S>`. Locked
//        explicitly because authors using `as const` get a readonly tuple
//        type for `required`, not a mutable string[].
const _withConstRequired = defineContract({
  actionSpec: {
    save: {
      label: 'Save',
      schema: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
  },
} as const);
type _ConstReqPayload = InferActionPayload<typeof _withConstRequired, 'save'>;
type _ConstReq = Expect<Equal<_ConstReqPayload, { a: string; b: number }>>;

export {};
