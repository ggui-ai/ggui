#!/usr/bin/env node
/**
 * Live blueprint-reuse probe — exercises the resurrected handshake cache
 * path (find-similar → coverage guard → REAL LLM judge → atomic reuse)
 * end-to-end against a real Anthropic judge.
 *
 * Two scenarios:
 *   1. REUSE — register a "my todo items" blueprint, then match a
 *      DIFFERENTLY-authored todo contract for the same intent. Exact-key
 *      misses; the coverage guard passes (same action keyset); the real
 *      judge should accept → strategy 'semantic', reuse the cached one.
 *      This is the "my todo items twice → two blueprints" symptom, fixed.
 *   2. REJECT — register a 2-action counter, then match a 3-action
 *      counter. The coverage guard drops the subset BEFORE the judge →
 *      no-match (the 2026-05-09 missing-button bug stays fixed).
 *
 * Uses MockEmbeddingProvider + minCosineForRerank:-1 so retrieval always
 * reaches the judge (the embedder is audit-confirmed real in `ggui serve`;
 * what this probe proves live is the JUDGE decision through the new path).
 *
 * Usage: pnpm -F @ggui-ai/mcp-server-handlers cache-reuse-probe
 *   (reads ANTHROPIC_API_KEY or ~/.ggui/credentials.json)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import {
  InMemoryBlueprintIndex,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { LLMCaller, ToolSchema } from '@ggui-ai/negotiator';
import type { DataContract } from '@ggui-ai/protocol';
import { matchBlueprint } from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';

const SCOPE = 'probe-app';
const NO_COSINE_GATE = { minCosineForRerank: -1 };

function resolveKey(): string {
  const env = process.env['ANTHROPIC_API_KEY'];
  if (env) return env;
  const p = pathResolve(homedir(), '.ggui', 'credentials.json');
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
    apps?: { global?: { anthropic?: string } };
  };
  const k = parsed.apps?.global?.anthropic;
  if (!k) throw new Error(`no anthropic key (env or ${p})`);
  return k;
}

function anthropicJudge(apiKey: string): LLMCaller {
  return {
    async call(): Promise<string> {
      throw new Error('text mode unused');
    },
    async callStructured<T>(
      system: string,
      user: string,
      tool: ToolSchema,
    ): Promise<T> {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [
            {
              name: tool.name,
              description: tool.description,
              input_schema: tool.input_schema,
            },
          ],
          tool_choice: { type: 'tool', name: tool.name },
        }),
      });
      const json = (await res.json()) as {
        content?: { type: string; input?: unknown }[];
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(`anthropic: ${json.error?.message}`);
      const block = json.content?.find((b) => b.type === 'tool_use');
      return block?.input as T;
    },
  };
}

const TODO_CACHED: DataContract = {
  propsSpec: { properties: { todos: { required: true, schema: { type: 'array' } } } },
  actionSpec: {
    addTodo: { label: 'Add todo item' },
    toggleTodo: {
      label: 'Toggle',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
};
// Pure LABEL noise — identical surfaces + schemas, only relabeled.
const TODO_REQUEST_LABELS: DataContract = {
  propsSpec: { properties: { todos: { required: true, schema: { type: 'array' } } } },
  actionSpec: {
    addTodo: { label: 'Add a new todo item' },
    toggleTodo: {
      label: "Toggle a todo's done state",
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
};
// Real SCHEMA difference — toggle gains a `done` payload field.
const TODO_REQUEST_SCHEMA: DataContract = {
  propsSpec: { properties: { todos: { required: true, schema: { type: 'array' } } } },
  actionSpec: {
    addTodo: { label: 'Add a new todo item' },
    toggleTodo: {
      label: "Toggle a todo's done state",
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
      },
    },
  },
};
const COUNTER_2: DataContract = {
  contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  actionSpec: {
    increment: { label: 'Inc', schema: { type: 'object', properties: {}, additionalProperties: false } },
    reset: { label: 'Reset', schema: { type: 'object', properties: {}, additionalProperties: false } },
  },
};
const COUNTER_3: DataContract = {
  contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  actionSpec: {
    increment: { label: 'Inc', schema: { type: 'object', properties: {}, additionalProperties: false } },
    decrement: { label: 'Dec', schema: { type: 'object', properties: {}, additionalProperties: false } },
    reset: { label: 'Reset', schema: { type: 'object', properties: {}, additionalProperties: false } },
  },
};

async function main(): Promise<void> {
  const llm = anthropicJudge(resolveKey());

  // Scenario 1 — REUSE.
  const r1 = { embedding: new MockEmbeddingProvider(), vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
  await registerBlueprint(r1, SCOPE, {
    kind: 'template',
    contract: TODO_CACHED,
    intent: 'my todo items',
    componentCode: 'export default () => null;',
    source: { kind: 'user' },
  });
  const labelReuse = await matchBlueprint(
    { registry: r1, llm },
    SCOPE,
    { intent: 'my todo items', contract: TODO_REQUEST_LABELS },
    NO_COSINE_GATE,
  );
  process.stdout.write(
    `\n[1a] LABEL-noise reuse → strategy=${labelReuse.strategy}` +
      (labelReuse.strategy === 'semantic'
        ? ` ✅ reused ${labelReuse.blueprint.id} (judge ${labelReuse.judgeConfidence?.toFixed(2)})\n`
        : ` ❌ ${labelReuse.strategy} — ${labelReuse.reason.slice(0, 80)}\n`),
  );
  const schemaReuse = await matchBlueprint(
    { registry: r1, llm },
    SCOPE,
    { intent: 'my todo items', contract: TODO_REQUEST_SCHEMA },
    NO_COSINE_GATE,
  );
  process.stdout.write(
    `[1b] SCHEMA-diff (toggle id vs id+done) → strategy=${schemaReuse.strategy}` +
      (schemaReuse.strategy === 'semantic'
        ? ` reused ${schemaReuse.blueprint.id} (judge ${schemaReuse.judgeConfidence?.toFixed(2)})\n`
        : ` ${schemaReuse.strategy} — ${schemaReuse.reason.slice(0, 80)}\n`),
  );
  const reuse = labelReuse;

  // Scenario 2 — REJECT subset.
  const r2 = { embedding: new MockEmbeddingProvider(), vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
  await registerBlueprint(r2, SCOPE, {
    kind: 'template',
    contract: COUNTER_2,
    intent: 'a counter widget',
    componentCode: 'export default () => null;',
    source: { kind: 'user' },
  });
  const reject = await matchBlueprint(
    { registry: r2, llm },
    SCOPE,
    { intent: 'a counter widget', contract: COUNTER_3 },
    NO_COSINE_GATE,
  );
  process.stdout.write(
    `[2] REJECT 3-action counter vs cached 2-action → strategy=${reject.strategy}` +
      (reject.strategy === 'no-match'
        ? ` ✅ subset rejected by coverage guard\n`
        : ` ❌ served a subset! (${reject.strategy})\n`),
  );

  process.stdout.write(
    `\nVerdict: ${
      reuse.strategy === 'semantic' && reject.strategy === 'no-match'
        ? '✅ find-similar + judge + coverage all working — same intent reuses, subsets rejected.'
        : '❌ unexpected — inspect above.'
    }\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`cache-reuse-probe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
