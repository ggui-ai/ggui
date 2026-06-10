/**
 * Unit tests for the F4 schema compat checker wired at render-time
 * + blueprint-registration. Covers every policy-flag branch, the
 * action → tool inputSchema direction, and every finding-reason
 * bucket (`tool-not-found`, `schema-mismatch`).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonSchema } from '@ggui-ai/protocol';
import {
  checkRenderSchemaCompat,
  SchemaCompatError,
  type ToolSchemaRef,
} from './schema-compat.js';

// ── Fixtures ──────────────────────────────────────────────────────

/** A well-aligned tool registry: `submit_task` accepts any string
 *  `title` + optional string `note` (plain strings keep the fixtures
 *  inside P0 algorithm scope — enums are flagged as P1-unsupported
 *  and surface `unsupported` violations). */
const submitTaskTool: ToolSchemaRef = {
  name: 'submit_task',
  inputSchema: {
    title: z.string(),
    note: z.string().optional(),
  },
};

const registry: ToolSchemaRef[] = [submitTaskTool];

// ── 'off' mode ────────────────────────────────────────────────────

describe('checkRenderSchemaCompat — off mode', () => {
  it('returns compatible report without running any check', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          bogus: {
            label: 'bogus',
            nextStep: 'does_not_exist',
            schema: { type: 'string' } satisfies JsonSchema,
          },
        },
      },
      registry,
      'off',
      'test:off',
    );
    expect(report.compatible).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

// ── action ref compat (action.schema ⊆ tool.inputSchema) ─────────

describe('checkRenderSchemaCompat — actionSpec direction', () => {
  it('compat: action schema is a subset of the tool inputSchema', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          createTask: {
            label: 'Create task',
            nextStep: 'submit_task',
            schema: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title'],
              additionalProperties: false,
            } satisfies JsonSchema,
          },
        },
      },
      registry,
      'reject',
      'test:action-compat',
    );
    expect(report.compatible).toBe(true);
  });

  it('incompat: action schema adds a field the tool does not accept', () => {
    const render = {
      actionSpec: {
        createTask: {
          label: 'Create task',
          nextStep: 'submit_task',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              badExtra: { type: 'string' },
            },
            required: ['title'],
            additionalProperties: false,
          } satisfies JsonSchema,
        },
      },
    };
    // 'warn' mode returns report without throwing
    const report = checkRenderSchemaCompat(
      render,
      registry,
      'warn',
      'test:action-incompat',
    );
    expect(report.compatible).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.kind).toBe('action');
    expect(report.findings[0]?.specName).toBe('createTask');
    expect(report.findings[0]?.toolName).toBe('submit_task');
    expect(report.findings[0]?.reason).toBe('schema-mismatch');
    expect(report.findings[0]?.violations.length).toBeGreaterThan(0);
  });

  it('reject mode throws SchemaCompatError with the full report attached', () => {
    const render = {
      actionSpec: {
        createTask: {
          label: 'Create task',
          nextStep: 'submit_task',
          schema: {
            type: 'object',
            properties: { title: { type: 'number' } }, // wrong type
            required: ['title'],
          } satisfies JsonSchema,
        },
      },
    };
    try {
      checkRenderSchemaCompat(
        render,
        registry,
        'reject',
        'test:action-reject',
      );
      throw new Error('expected SchemaCompatError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaCompatError);
      const compatErr = err as SchemaCompatError;
      expect(compatErr.report.compatible).toBe(false);
      expect(compatErr.report.findings[0]?.reason).toBe('schema-mismatch');
      expect(compatErr.message).toContain('SCHEMA_MISMATCH_ERROR');
      expect(compatErr.message).toContain('test:action-reject');
    }
  });

  it('flags tool-not-found when the action refs an unregistered tool', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          createTask: {
            label: 'Create task',
            nextStep: 'nonexistent',
            schema: { type: 'string' } satisfies JsonSchema,
          },
        },
      },
      registry,
      'warn',
      'test:action-missing',
    );
    expect(report.compatible).toBe(false);
    expect(report.findings[0]?.reason).toBe('tool-not-found');
    expect(report.findings[0]?.violations).toEqual([]);
  });

  it('reject mode does NOT throw for an action nextStep tool-not-found (advisory)', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          createTask: {
            label: 'Create',
            nextStep: 'nonexistent',
            schema: { type: 'object', properties: {} },
          },
        },
      },
      registry,
      'reject',
      'test',
    );
    expect(report.compatible).toBe(false);
    expect(report.findings[0]?.reason).toBe('tool-not-found');
    expect(report.findings[0]?.severity).toBe('warn');
  });

  it('reject mode STILL throws for an action schema-mismatch', () => {
    // Reuse the wrong-type fixture shape: action declares `title` as a
    // number but `submit_task.inputSchema` requires a string → a
    // schema-mismatch finding (error severity) under reject mode.
    const render = {
      actionSpec: {
        createTask: {
          label: 'Create task',
          nextStep: 'submit_task',
          schema: {
            type: 'object',
            properties: { title: { type: 'number' } }, // wrong type
            required: ['title'],
          } satisfies JsonSchema,
        },
      },
    };
    expect(() =>
      checkRenderSchemaCompat(
        render,
        registry,
        'reject',
        'test:action-mismatch-throws',
      ),
    ).toThrow(SchemaCompatError);
  });

  it('void action (no schema) + tool with required fields → flagged as mismatch (wire sends empty object)', () => {
    // submit_task.inputSchema requires `title`; void action sends
    // nothing ⇒ the wire would deliver {} to a tool that rejects
    // missing title. Flag it honestly.
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          trigger: {
            label: 'Trigger',
            nextStep: 'submit_task',
            // no schema
          },
        },
      },
      registry,
      'warn',
      'test:void-action-mismatch',
    );
    expect(report.compatible).toBe(false);
    expect(report.findings[0]?.reason).toBe('schema-mismatch');
    // Violation names the missing required field.
    expect(
      report.findings[0]?.violations.some((v) =>
        v.reason === 'missing-required',
      ),
    ).toBe(true);
  });

  it('void action + tool with no required fields → compatible', () => {
    // Unconstrained tool — void action sending {} satisfies the
    // tool's empty-required-set, so no violation.
    const noRequiredTool: ToolSchemaRef = {
      name: 'noop_tool',
      inputSchema: {},
    };
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          trigger: {
            label: 'Trigger',
            nextStep: 'noop_tool',
            // no schema
          },
        },
      },
      [noRequiredTool],
      'reject',
      'test:void-action-compat',
    );
    expect(report.compatible).toBe(true);
  });

  it('skips actions that declare no nextStep hint (nothing to check against)', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          agentRouted: {
            label: 'Agent',
            schema: {
              type: 'object',
              properties: { q: { type: 'string' } },
            } satisfies JsonSchema,
          },
        },
      },
      registry,
      'reject',
      'test:no-tool-ref',
    );
    expect(report.compatible).toBe(true);
  });
});


// ── Multi-entry handling ─────────────────────────────────────────

describe('checkRenderSchemaCompat — multi-entry handling', () => {
  it('reports every failing action in a single report', () => {
    const report = checkRenderSchemaCompat(
      {
        actionSpec: {
          bad: {
            label: 'bad',
            nextStep: 'submit_task',
            schema: {
              type: 'object',
              properties: { title: { type: 'number' } }, // wrong type
            } satisfies JsonSchema,
          },
          ghost: {
            label: 'ghost',
            nextStep: 'ghost_tool',
            schema: { type: 'object' } satisfies JsonSchema,
          },
        },
      },
      registry,
      'warn',
      'test:multi',
    );
    expect(report.compatible).toBe(false);
    expect(report.findings).toHaveLength(2);
    const reasons = report.findings.map((f) => f.reason).sort();
    expect(reasons).toEqual(['schema-mismatch', 'tool-not-found']);
  });

  it('no actionSpec = always compatible', () => {
    const report = checkRenderSchemaCompat(
      {},
      registry,
      'reject',
      'test:empty',
    );
    expect(report.compatible).toBe(true);
    expect(report.findings).toEqual([]);
  });
});

// ── Error-message quality ─────────────────────────────────────────

describe('SchemaCompatError — message formatting', () => {
  it('includes context and names every finding', () => {
    const render = {
      actionSpec: {
        createTask: {
          label: 'Create',
          nextStep: 'submit_task',
          schema: {
            type: 'object',
            properties: { title: { type: 'number' } },
          } satisfies JsonSchema,
        },
        feed: {
          label: 'Feed',
          nextStep: 'ghost_tool',
          schema: {
            type: 'object',
            properties: { title: { type: 'number' } },
          } satisfies JsonSchema,
        },
      },
    };
    try {
      checkRenderSchemaCompat(
        render,
        registry,
        'reject',
        'test:ctx',
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaCompatError);
      const message = (err as SchemaCompatError).message;
      expect(message).toContain('test:ctx');
      expect(message).toContain('SCHEMA_MISMATCH_ERROR');
      expect(message).toContain('createTask');
      expect(message).toContain('feed');
      expect(message).toContain('ghost_tool');
    }
  });
});
