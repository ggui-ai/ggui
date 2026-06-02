/**
 * Tests for the pure `blueprint-fulfillability` reuse precondition.
 *
 * The decide-time gate only proposes a cached blueprint for reuse when the
 * REQUESTING agent can actually fulfill it: its declared
 * `agentCapabilities.tools` (a set keyed by bare toolName) must SUPERSET the
 * blueprint's REQUIRED tools (its `actionSpec[*].nextStep` +
 * `streamSpec[*].source.tool`), and for the shared tools the agent's current
 * `toolInfo.inputSchema` must still satisfy what the blueprint recorded
 * (v1 = required-field subset). Version is NOT part of identity — a version
 * bump with an unchanged schema must still reuse.
 *
 * Pure — no store, no LLM. All fixtures use the NESTED `AgentToolEntry` shape
 * (`{ toolInfo: { inputSchema: {...} } }`).
 */
import type { AgentCapabilitiesSpec, DataContract } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import { isFulfillable, requiredTools } from './blueprint-fulfillability.js';

/** Build an `agentCapabilities.tools` catalog from bare-name → required-field list. */
function tools(
  spec: Record<string, { required?: string[] }>,
): AgentCapabilitiesSpec['tools'] {
  const out: AgentCapabilitiesSpec['tools'] = {};
  for (const [name, { required }] of Object.entries(spec)) {
    out[name] = {
      toolInfo: {
        inputSchema: {
          type: 'object',
          properties: {},
          ...(required ? { required } : {}),
        },
      },
    };
  }
  return out;
}

describe('requiredTools', () => {
  it('unions actionSpec[*].nextStep + streamSpec[*].source.tool', () => {
    const contract: DataContract = {
      actionSpec: {
        add: { label: 'Add', nextStep: 'todo_add' },
        // An action without a nextStep contributes no required tool.
        cancel: { label: 'Cancel' },
      },
      streamSpec: {
        list: {
          schema: { type: 'object' },
          source: { tool: 'todo_list' },
        },
      },
    };
    expect([...requiredTools(contract)].sort()).toEqual(['todo_add', 'todo_list']);
  });

  it('includes the legacy streamSpec[*].tool refresh hint', () => {
    const contract: DataContract = {
      streamSpec: {
        items: { schema: { type: 'object' }, tool: 'items_list' },
      },
    };
    expect(requiredTools(contract)).toEqual(['items_list']);
  });

  it('returns [] for a contract with no action/stream tool refs', () => {
    const contract: DataContract = { propsSpec: { properties: {} } };
    expect(requiredTools(contract)).toEqual([]);
  });
});

describe('isFulfillable', () => {
  const REQUIRES_TODO_ADD: DataContract = {
    actionSpec: { add: { label: 'Add', nextStep: 'todo_add' } },
    agentCapabilities: {
      tools: {
        todo_add: {
          toolInfo: {
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
      },
    },
  };

  it('ok when the agent caps SUPERSET the required tools', () => {
    const result = isFulfillable(
      REQUIRES_TODO_ADD,
      tools({ todo_add: { required: ['text'] }, todo_list: {} }),
    );
    expect(result).toEqual({ ok: true, missingTools: [], schemaConflicts: [] });
  });

  it('declines (missingTools) when a required tool is absent from agent caps', () => {
    const contract: DataContract = {
      actionSpec: {
        add: { label: 'Add', nextStep: 'todo_add' },
        del: { label: 'Delete', nextStep: 'todo_delete' },
      },
    };
    const result = isFulfillable(contract, tools({ todo_add: {} }));
    expect(result.ok).toBe(false);
    expect(result.missingTools).toEqual(['todo_delete']);
    expect(result.schemaConflicts).toEqual([]);
  });

  it('declines (schemaConflicts) when the agent dropped a field the blueprint recorded as required', () => {
    // Blueprint recorded inputSchema.required = ['text']; agent's CURRENT
    // tool no longer requires 'text' (required-subset violated).
    const result = isFulfillable(
      REQUIRES_TODO_ADD,
      tools({ todo_add: { required: [] } }),
    );
    expect(result.ok).toBe(false);
    expect(result.missingTools).toEqual([]);
    expect(result.schemaConflicts).toEqual(['todo_add']);
  });

  it('ok when the agent ADDED an optional field (required set still covers the blueprint)', () => {
    // Agent now requires ['text','tags'] — still a superset of the
    // blueprint's ['text'], so optional-add is compatible.
    const result = isFulfillable(
      REQUIRES_TODO_ADD,
      tools({ todo_add: { required: ['text', 'tags'] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.schemaConflicts).toEqual([]);
  });
});
