/**
 * mcp-mounts unit tests — collision rules + compose ordering.
 *
 * Focused on `composeHandlersWithMounts`; end-to-end wire proof
 * (real `/mcp` surface boots with mount tools visible to an MCP
 * Client) lives in `./server.test.ts` via the mount-integration
 * test added alongside this seam.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SharedHandler } from '@ggui-ai/mcp-server-handlers';
import {
  composeHandlersWithMounts,
  validateMcpServices,
  validateServicePath,
  type McpServerMount,
  type McpService,
} from './mcp-mounts.js';

const noopHandler = async () => ({ ok: true }) as Record<string, unknown>;

/**
 * Build a valid mount handler with a non-empty `outputSchema`. The
 * compose-time guardrail (see `composeHandlersWithMounts`) rejects
 * empty `outputSchema: {}` for mounted handlers, so every test
 * helper that constructs a mount-side handler MUST declare at least
 * one field here. Tests for the guardrail itself use
 * {@link handlerWithEmptyOutputSchema}.
 */
function handler(name: string): SharedHandler<
  Record<string, z.ZodTypeAny>,
  Record<string, z.ZodTypeAny>
> {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    outputSchema: { ok: z.literal(true) },
    handler: noopHandler,
  };
}

/** Construct a mount handler with the banned empty outputSchema —
 *  used to prove the guardrail fires. */
function handlerWithEmptyOutputSchema(
  name: string,
): SharedHandler<Record<string, z.ZodTypeAny>, Record<string, z.ZodTypeAny>> {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    outputSchema: {},
    handler: noopHandler,
  };
}

describe('composeHandlersWithMounts', () => {
  it('returns base handlers unchanged when mounts is undefined', () => {
    const base = [handler('ggui_push'), handler('ggui_render_blueprint')];
    const out = composeHandlersWithMounts(base, undefined);
    expect(out).toBe(base);
  });

  it('returns base handlers unchanged when mounts is empty', () => {
    const base = [handler('ggui_push')];
    const out = composeHandlersWithMounts(base, []);
    expect(out).toBe(base);
  });

  it('appends mount handlers after the base list, preserving order', () => {
    const base = [handler('ggui_push'), handler('ggui_render_blueprint')];
    const mount: McpServerMount = {
      name: 'tasks',
      handlers: [
        handler('tasks_list'),
        handler('tasks_create'),
        handler('tasks_complete'),
      ],
    };
    const out = composeHandlersWithMounts(base, [mount]);
    expect(out.map((h) => h.name)).toEqual([
      'ggui_push',
      'ggui_render_blueprint',
      'tasks_list',
      'tasks_create',
      'tasks_complete',
    ]);
  });

  it('aggregates multiple mounts left-to-right', () => {
    const base = [handler('ggui_push')];
    const out = composeHandlersWithMounts(base, [
      { name: 'tasks', handlers: [handler('tasks_list')] },
      { name: 'notes', handlers: [handler('notes_list')] },
    ]);
    expect(out.map((h) => h.name)).toEqual([
      'ggui_push',
      'tasks_list',
      'notes_list',
    ]);
  });

  it('throws when a mount tool collides with a ggui-native tool', () => {
    const base = [handler('ggui_push')];
    expect(() =>
      composeHandlersWithMounts(base, [
        { name: 'tasks', handlers: [handler('ggui_push')] },
      ]),
    ).toThrow(
      /mount "tasks" registers tool "ggui_push" which collides with a ggui-native tool/,
    );
  });

  it('throws when two mounts register the same tool name', () => {
    const base = [handler('ggui_push')];
    expect(() =>
      composeHandlersWithMounts(base, [
        { name: 'tasks', handlers: [handler('list')] },
        { name: 'notes', handlers: [handler('list')] },
      ]),
    ).toThrow(
      /mount "notes" registers tool "list" which collides with mount "tasks"/,
    );
  });

  it('throws when a mount entry has an empty name', () => {
    expect(() =>
      composeHandlersWithMounts([handler('ggui_push')], [
        { name: '', handlers: [handler('tasks_list')] },
      ]),
    ).toThrow(
      /every `mcpMounts` entry must carry a non-empty string `name`/,
    );
  });

  it('accepts a mount with zero handlers (no-op)', () => {
    const base = [handler('ggui_push')];
    const out = composeHandlersWithMounts(base, [
      { name: 'tasks', handlers: [] },
    ]);
    expect(out.map((h) => h.name)).toEqual(['ggui_push']);
  });

  // ────────────────────────────────────────────────────────────────
  // outputSchema guardrail — Slice 6.2 carry-forward.
  //
  // Surfaced during Slice 6 CLI work: an operator mount that declares
  // `outputSchema: {}` passes every other composition check and boots
  // fine, but at tools/call time the MCP SDK strips structuredContent
  // against the empty schema → the handler returns `{ items: [...] }`
  // and the wire answer is `{}`. Operators see "success" responses
  // with missing data and no diagnostic.
  //
  // The guardrail fires at compose time so the failure carries the
  // mount + tool name. Scope is mounted handlers only; ggui-native
  // handlers are repo-owned and already correctly shaped.
  // ────────────────────────────────────────────────────────────────
  it('throws when a mount handler declares an empty outputSchema (silent-structuredContent-strip footgun)', () => {
    expect(() =>
      composeHandlersWithMounts(
        [handler('ggui_push')],
        [
          {
            name: 'tasks',
            handlers: [handlerWithEmptyOutputSchema('tasks_list')],
          },
        ],
      ),
    ).toThrow(
      /mount "tasks" handler "tasks_list" declares an empty `outputSchema`/,
    );
  });

  it('error message points at the specific mount + tool + remediation', () => {
    // The whole point of firing this at compose time is the operator
    // gets a clear fix. Pin the key phrases the message carries.
    try {
      composeHandlersWithMounts(
        [handler('ggui_push')],
        [
          {
            name: 'notes',
            handlers: [handlerWithEmptyOutputSchema('notes_search')],
          },
        ],
      );
      expect.fail('expected composeHandlersWithMounts to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('mount "notes"');
      expect(message).toContain('"notes_search"');
      expect(message).toContain('silently strips `structuredContent`');
      // Remediation hint with a concrete example.
      expect(message).toContain('Declare the fields');
    }
  });

  it('leaves ggui-native handlers alone even if they have an empty outputSchema (scope: mounts only)', () => {
    // Synthetic contrast: a ggui-native handler with an empty schema
    // composes fine — the guardrail fires on mount-side entries only.
    // This documents the asymmetry so a future change doesn't
    // accidentally widen the check to native handlers and break boot.
    const base = [handlerWithEmptyOutputSchema('ggui_internal')];
    const out = composeHandlersWithMounts(base, [
      { name: 'tasks', handlers: [handler('tasks_list')] },
    ]);
    expect(out.map((h) => h.name)).toEqual([
      'ggui_internal',
      'tasks_list',
    ]);
  });

  it('returned list is a fresh array when mounts contribute handlers (callers never mutate the input)', () => {
    const base = [handler('ggui_push')];
    const out = composeHandlersWithMounts(base, [
      { name: 'tasks', handlers: [handler('tasks_list')] },
    ]);
    expect(out).not.toBe(base);
    expect(base).toHaveLength(1);
  });
});

/**
 * Variant of {@link handler} that sets an explicit `audience` tag.
 * Used to prove the service-handler guardrail in
 * `validateMcpServices` fires (services bypass audience filtering, so
 * an explicit tag is silently meaningless).
 */
function handlerWithAudience(
  name: string,
  audience: ReadonlyArray<'agent' | 'runtime' | 'protocol' | 'ops'>,
): SharedHandler<Record<string, z.ZodTypeAny>, Record<string, z.ZodTypeAny>> {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    outputSchema: { ok: z.literal(true) },
    audience,
    handler: noopHandler,
  };
}

describe('validateServicePath', () => {
  it('accepts well-formed single-segment paths', () => {
    expect(validateServicePath('/docs')).toBe('/docs');
  });

  it('accepts nested paths', () => {
    expect(validateServicePath('/playground/todos')).toBe('/playground/todos');
    expect(validateServicePath('/a/b/c/d')).toBe('/a/b/c/d');
  });

  it('accepts dashes and underscores in segments', () => {
    expect(
      validateServicePath('/playground/the-million-dollar-homepage'),
    ).toBe('/playground/the-million-dollar-homepage');
    expect(validateServicePath('/snake_case_path')).toBe('/snake_case_path');
  });

  it('rejects paths without a leading slash', () => {
    expect(() => validateServicePath('docs')).toThrow(/malformed/);
    expect(() => validateServicePath('playground/todos')).toThrow(/malformed/);
  });

  it('rejects paths with trailing slashes', () => {
    expect(() => validateServicePath('/docs/')).toThrow(
      /must not end with "\/"/,
    );
  });

  it('rejects paths containing whitespace', () => {
    expect(() => validateServicePath('/foo bar')).toThrow(/malformed/);
  });

  it('rejects paths containing dots (no path traversal, no extension games)', () => {
    expect(() => validateServicePath('/foo.bar')).toThrow(/malformed/);
    expect(() => validateServicePath('/foo/../bar')).toThrow(/malformed/);
  });

  it('rejects the canonical reserved built-in routes', () => {
    for (const reserved of [
      '/',
      '/mcp',
      '/protocol',
      '/ops',
      '/ws',
      '/health',
      '/.well-known',
      '/oauth',
      '/_ggui',
      '/ggui',
    ]) {
      expect(() => validateServicePath(reserved)).toThrow(
        /reserved built-in route|malformed/,
      );
    }
  });
});

describe('validateMcpServices', () => {
  it('returns an empty array when services is undefined', () => {
    expect(validateMcpServices(undefined)).toEqual([]);
  });

  it('returns the input list unchanged when valid', () => {
    const services: McpService[] = [
      { name: 'docs', path: '/docs', handlers: [handler('docs_search')] },
    ];
    expect(validateMcpServices(services)).toBe(services);
  });

  it('accepts multiple services with distinct paths', () => {
    const services: McpService[] = [
      { name: 'docs', path: '/docs', handlers: [handler('docs_search')] },
      {
        name: 'todos',
        path: '/playground/todos',
        handlers: [handler('todos_list')],
      },
    ];
    expect(validateMcpServices(services)).toBe(services);
  });

  it('accepts the SAME tool name across two services (services are isolated namespaces)', () => {
    const services: McpService[] = [
      { name: 'docs', path: '/docs', handlers: [handler('search')] },
      {
        name: 'todos',
        path: '/playground/todos',
        handlers: [handler('search')],
      },
    ];
    // No throw — cross-service collisions are allowed by design.
    expect(validateMcpServices(services)).toBe(services);
  });

  it('rejects an empty service name', () => {
    expect(() =>
      validateMcpServices([
        { name: '', path: '/docs', handlers: [handler('docs_search')] },
      ]),
    ).toThrow(/non-empty string `name`/);
  });

  it('rejects a malformed path with the service identity in the error', () => {
    expect(() =>
      validateMcpServices([
        { name: 'docs', path: 'docs', handlers: [handler('docs_search')] },
      ]),
    ).toThrow(/path "docs" is malformed/);
  });

  it('rejects a reserved path', () => {
    expect(() =>
      validateMcpServices([
        { name: 'shadow-ops', path: '/ops', handlers: [handler('any_tool')] },
      ]),
    ).toThrow(/reserved built-in route/);
  });

  it('rejects duplicate paths across services', () => {
    expect(() =>
      validateMcpServices([
        { name: 'a', path: '/docs', handlers: [handler('a_tool')] },
        { name: 'b', path: '/docs', handlers: [handler('b_tool')] },
      ]),
    ).toThrow(/declared by more than one service/);
  });

  it('rejects a service handler with an empty outputSchema', () => {
    expect(() =>
      validateMcpServices([
        {
          name: 'docs',
          path: '/docs',
          handlers: [handlerWithEmptyOutputSchema('docs_search')],
        },
      ]),
    ).toThrow(/silently strips `structuredContent`/);
  });

  it('rejects a service handler that sets `audience` (services bypass audience filtering)', () => {
    expect(() =>
      validateMcpServices([
        {
          name: 'docs',
          path: '/docs',
          handlers: [handlerWithAudience('docs_search', ['ops'])],
        },
      ]),
    ).toThrow(/Services bypass audience filtering/);
  });

  it('rejects duplicate tool names within a single service', () => {
    expect(() =>
      validateMcpServices([
        {
          name: 'docs',
          path: '/docs',
          handlers: [handler('search'), handler('search')],
        },
      ]),
    ).toThrow(/registers tool "search" twice/);
  });

  it('error message embeds service name + path for the reserved-path case', () => {
    try {
      validateMcpServices([
        { name: 'oops', path: '/mcp', handlers: [handler('x')] },
      ]);
      expect.fail('expected throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Reserved-path detection happens before the service-name embed,
      // but the path is still in the message so operators can find the
      // offender by grepping their config.
      expect(message).toContain('"/mcp"');
      expect(message).toContain('reserved');
    }
  });
});
