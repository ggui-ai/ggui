/**
 * Real-LLM calibration suite for the similarity-only rerank judge.
 *
 * This is the fast regression gate that would have caught the
 * optional-superset bug BEFORE the 8-minute container e2e: a cached
 * weather `{city!, temp}` blueprint vs a request `{city!, temp,
 * humidity?}` (humidity `required:false`) was wrongly DECLINED by the
 * old coverage-gate judge. The new similarity-only judge MATCHes it —
 * added/omitted fields are reported to the agent, never declined.
 *
 * Philosophy under test (post Task A1): MATCH = same task + same broad
 * UI shape; supersets/subsets/paraphrases/cosmetic-variance all match.
 * NO-MATCH only for different task, different UI shape, or a conflicting
 * load-bearing fixed VALUE.
 *
 * **Gating (No-Silent-Block).** This suite only gates regressions when
 * run in a tier that provides `ANTHROPIC_API_KEY`. Absent a key it
 * SKIPS cleanly (does not fail). Wiring it into a key-bearing CI tier
 * is a separate follow-up — until that lands, this suite is a manual /
 * keyed-tier gate, not an automatic one.
 *
 * Cost: ~7 pairs × one Haiku 4.5 call each ≈ $0.01, ≈ 12s.
 *
 * The (query, candidate) summaries are derived from REAL `DataContract`
 * fixtures via `summarizeContract`, NOT hand-authored strings — so the
 * summaries are production-faithful AND exercise the A2 `!`
 * required-marker. (The legacy `rerank-eval/pairs.ts` uses a stale
 * `interaction=...` prefix `summarizeContract` never emits — those
 * encode the OLD coverage-gate philosophy and are out of scope here.)
 */
import { describe, it, expect } from 'vitest';
import { summarizeContract, type DataContract } from '@ggui-ai/protocol';
import {
  rerankCandidates,
  type RerankCandidate,
  type RerankQuery,
} from './llm-rerank.js';
import type { LLMCaller, ToolSchema } from './llm-caller.js';

// Mirrors the matcher's DEFAULT_JUDGE_THRESHOLD — a MATCH must clear
// this confidence; a NO-MATCH must land below it (or return null).
const JUDGE_THRESHOLD = 0.5; // mirrors matcher DEFAULT_JUDGE_THRESHOLD

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL = 'claude-haiku-4-5';

// One Haiku call ≈ 1–2s; allow generous headroom for cold connections.
const CALL_TIMEOUT_MS = 30_000;

// ─── Real Anthropic LLMCaller (key-gated) ──────────────────────────
//
// Built INSIDE this file — the CLI's builder (`run-probe-cli.ts`) has
// module-level token counters + a `main()`, neither of which we want
// in a test process. The key is read from `process.env` ONLY (never a
// secret file) and is never printed.

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

function buildAnthropicLlmCaller(apiKey: string): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error('calibration: text-mode not used — use callStructured');
    },
    async callStructured<T>(
      systemPrompt: string,
      userMessage: string,
      tool: ToolSchema,
      maxTokens?: number,
    ): Promise<T> {
      const body = {
        model: HAIKU_MODEL,
        max_tokens: maxTokens ?? 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        tools: [
          {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          },
        ],
        tool_choice: { type: 'tool', name: tool.name },
      };
      const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as AnthropicResponse;
      if (!res.ok) {
        const errType = json.error?.type ?? 'unknown';
        const errMsg = json.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`anthropic ${errType}: ${errMsg}`);
      }
      const toolBlock = json.content?.find((b) => b.type === 'tool_use');
      if (!toolBlock || toolBlock.input === undefined) {
        throw new Error(
          `anthropic: no tool_use block in response (stop_reason=${json.stop_reason ?? 'unknown'})`,
        );
      }
      return toolBlock.input as T;
    },
  };
}

// ─── Contract fixtures (real DataContracts → summarizeContract) ─────

/** Weather card with city + temp, optionally + humidity. */
function weatherContract(opts: {
  readonly humidity?: boolean;
}): DataContract {
  const properties: NonNullable<DataContract['propsSpec']>['properties'] = {
    city: { schema: { type: 'string' }, required: true },
    temp: { schema: { type: 'number' } },
  };
  if (opts.humidity) {
    properties['humidity'] = { schema: { type: 'number' }, required: false };
  }
  return { propsSpec: { properties } };
}

/** Weather card with city + temp + humidity (the richer cached shape). */
function weatherWithHumidityContract(): DataContract {
  return {
    propsSpec: {
      properties: {
        city: { schema: { type: 'string' }, required: true },
        temp: { schema: { type: 'number' } },
        humidity: { schema: { type: 'number' } },
      },
    },
  };
}

/** Weather card with city only (the subset request). */
function weatherCityOnlyContract(): DataContract {
  return {
    propsSpec: { properties: { city: { schema: { type: 'string' }, required: true } } },
  };
}

/** A live note panel — topic select + note textarea (paraphrase pair). */
function notepadContract(): DataContract {
  return {
    contextSpec: {
      note: { schema: { type: 'string' } },
      topic: { schema: { type: 'string', enum: ['idea', 'task', 'bug'] } },
    },
  };
}

/** A metrics dashboard with three numeric tiles (cosmetic-variance pair). */
function dashboardContract(): DataContract {
  return {
    propsSpec: {
      properties: {
        revenue: { schema: { type: 'number' }, required: true },
        signups: { schema: { type: 'number' }, required: true },
        churn: { schema: { type: 'number' }, required: true },
      },
    },
  };
}

/** A todo list — items array + add/toggle actions (different-task pair). */
function todoContract(): DataContract {
  return {
    propsSpec: {
      properties: {
        items: {
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, text: { type: 'string' } },
            },
          },
          required: true,
        },
      },
    },
    actionSpec: {
      addItem: { label: 'Add', schema: { type: 'object', properties: { text: { type: 'string' } } } },
      toggleItem: { label: 'Toggle', schema: { type: 'object', properties: { id: { type: 'string' } } } },
    },
  };
}

/**
 * A calendar grid — same contract shape for both January and March; the
 * pinned month lives in the INTENT, not the summary (so the summaries
 * are byte-identical and only the intent disambiguates).
 */
function calendarContract(): DataContract {
  return {
    propsSpec: {
      properties: {
        days: {
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: { date: { type: 'string' }, label: { type: 'string' } },
            },
          },
          required: true,
        },
      },
    },
    actionSpec: {
      selectDay: { label: 'Select day', schema: { type: 'object', properties: { date: { type: 'string' } } } },
    },
  };
}

// ─── Labeled pairs ──────────────────────────────────────────────────
//
// Each pair = ONE judge call. `expectedMatchId` is the id the judge
// should pick for a MATCH; `null` means NO-MATCH (matchId null OR
// confidence below threshold).

interface CalibrationPair {
  readonly name: string;
  readonly category:
    | 'optional-superset'
    | 'paraphrase'
    | 'subset'
    | 'cosmetic-variance'
    | 'different-task'
    | 'different-ui-shape'
    | 'conflicting-fixed-value';
  readonly query: RerankQuery;
  readonly candidates: readonly RerankCandidate[];
  /** The id the judge MUST pick, or `null` for NO-MATCH. */
  readonly expectedMatchId: string | null;
}

const MATCH_PAIRS: readonly CalibrationPair[] = [
  // regression anchor: the e2e tempC case. Cached weather {city!, temp}
  // vs request {city!, temp, humidity?} (humidity required:false). The
  // optional superset MUST match — this is the exact bug.
  {
    name: 'optional-superset (regression anchor: the e2e tempC case)',
    category: 'optional-superset',
    query: {
      intent: 'Weather card showing city, temperature, and humidity',
      contractSummary: summarizeContract(weatherContract({ humidity: true })),
    },
    candidates: [
      {
        id: 'bp-weather-base',
        cachedIntent: 'Weather card showing city and temperature',
        cachedContractSummary: summarizeContract(weatherContract({})),
        cosine: 0.93,
      },
      {
        id: 'bp-todo',
        cachedIntent: 'Todo list with add and toggle',
        cachedContractSummary: summarizeContract(todoContract()),
        cosine: 0.31,
      },
    ],
    expectedMatchId: 'bp-weather-base',
  },
  // paraphrase: identical contract, reworded intent.
  {
    name: 'paraphrase (same contract, reworded intent)',
    category: 'paraphrase',
    query: {
      intent: 'Notepad with a topic dropdown and a note field',
      contractSummary: summarizeContract(notepadContract()),
    },
    candidates: [
      {
        id: 'bp-notepad',
        cachedIntent: 'Live note panel — topic enum + textarea',
        cachedContractSummary: summarizeContract(notepadContract()),
        cosine: 0.95,
      },
    ],
    expectedMatchId: 'bp-notepad',
  },
  // subset: request asks for FEWER fields than the cached blueprint offers.
  {
    name: 'subset (request fewer fields than cached blueprint offers)',
    category: 'subset',
    query: {
      intent: 'Weather card showing the city name',
      contractSummary: summarizeContract(weatherCityOnlyContract()),
    },
    candidates: [
      {
        id: 'bp-weather-rich',
        cachedIntent: 'Weather card showing city, temperature, and humidity',
        cachedContractSummary: summarizeContract(weatherWithHumidityContract()),
        cosine: 0.9,
      },
    ],
    expectedMatchId: 'bp-weather-rich',
  },
  // cosmetic-variance: identical contract, intent differs only in style.
  {
    name: 'cosmetic-variance (same props, intent differs only in visual style)',
    category: 'cosmetic-variance',
    query: {
      intent: 'Metrics dashboard in a sleek dark mode with revenue, signups, and churn',
      contractSummary: summarizeContract(dashboardContract()),
    },
    candidates: [
      {
        id: 'bp-dashboard',
        cachedIntent: 'Bright ornate metrics dashboard — revenue, signups, churn tiles',
        cachedContractSummary: summarizeContract(dashboardContract()),
        cosine: 0.94,
      },
    ],
    expectedMatchId: 'bp-dashboard',
  },
];

const NO_MATCH_PAIRS: readonly CalibrationPair[] = [
  // different-task: todo list vs weather card.
  {
    name: 'different-task (todo list vs weather card)',
    category: 'different-task',
    query: {
      intent: 'Todo list with add and toggle actions',
      contractSummary: summarizeContract(todoContract()),
    },
    candidates: [
      {
        id: 'bp-weather',
        cachedIntent: 'Weather card showing city and temperature',
        cachedContractSummary: summarizeContract(weatherContract({})),
        cosine: 0.34,
      },
    ],
    expectedMatchId: null,
  },
  // different-ui-shape: a flat list vs a calendar grid (different layout
  // pattern) even though both carry a date/label item array.
  {
    name: 'different-ui-shape (flat list vs calendar grid)',
    category: 'different-ui-shape',
    query: {
      intent: 'A flat scrollable list of upcoming events, one row per event',
      contractSummary: summarizeContract(calendarContract()),
    },
    candidates: [
      {
        id: 'bp-calendar-grid',
        cachedIntent: 'A month calendar GRID with one cell per day, days arranged in weeks',
        cachedContractSummary: summarizeContract(calendarContract()),
        cosine: 0.88,
      },
    ],
    expectedMatchId: null,
  },
  // conflicting-fixed-value: calendar pinned to March vs cached calendar
  // pinned to January. Same contract shape (summaries identical); the
  // load-bearing month lives in the intent.
  {
    name: 'conflicting-fixed-value (calendar-March vs cached calendar-January)',
    category: 'conflicting-fixed-value',
    query: {
      intent: 'A month calendar grid pinned to March 2026',
      contractSummary: summarizeContract(calendarContract()),
    },
    candidates: [
      {
        id: 'bp-calendar-jan',
        cachedIntent: 'A month calendar grid pinned to January 2026',
        cachedContractSummary: summarizeContract(calendarContract()),
        cosine: 0.91,
      },
    ],
    expectedMatchId: null,
  },
];

// ─── Suite (key-gated) ──────────────────────────────────────────────

const apiKey = process.env['ANTHROPIC_API_KEY'];

describe.skipIf(!apiKey)('llm-rerank calibration (real Haiku judge)', () => {
  // NOTE: vitest still runs this suite FACTORY during collection even
  // when `skipIf` will skip the tests — it only skips the test BODIES.
  // So this factory must NOT throw on a missing key. The caller is
  // constructed with `apiKey ?? ''`; since every `it` is skipped when
  // the key is absent, that empty-key caller is never invoked (and so
  // never hits the network). `?? ''` keeps the param typed `string`
  // without a non-null assertion.
  const llm = buildAnthropicLlmCaller(apiKey ?? '');

  describe('MATCH — same task + same broad UI shape', () => {
    for (const pair of MATCH_PAIRS) {
      it(
        `${pair.category}: ${pair.name}`,
        { retry: 2, timeout: CALL_TIMEOUT_MS },
        async () => {
          const decision = await rerankCandidates({ llm }, pair.query, pair.candidates);
          expect(decision.matchId).toBe(pair.expectedMatchId);
          expect(decision.confidence).toBeGreaterThanOrEqual(JUDGE_THRESHOLD);
        },
      );
    }
  });

  describe('NO-MATCH — different task / shape / conflicting fixed value', () => {
    for (const pair of NO_MATCH_PAIRS) {
      it(
        `${pair.category}: ${pair.name}`,
        { retry: 2, timeout: CALL_TIMEOUT_MS },
        async () => {
          const decision = await rerankCandidates({ llm }, pair.query, pair.candidates);
          // NO-MATCH = the judge returns null, OR it names a candidate
          // but below the hit threshold (caller treats that as no-match).
          const isNoMatch =
            decision.matchId === null || decision.confidence < JUDGE_THRESHOLD;
          expect(isNoMatch).toBe(true);
        },
      );
    }
  });
});
