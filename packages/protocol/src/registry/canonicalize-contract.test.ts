import { describe, it, expect } from 'vitest';
import {
  canonicalizeContracts,
  canonicalizeValue,
  canonicalizeVariance,
} from './canonicalize-contract.js';
import { blueprintKey } from './blueprint-key.js';
import type { DataContract } from '../types/data-contract.js';
import type { BlueprintVariance } from '../types/blueprint.js';

describe('canonicalizeContracts', () => {
  it('produces stable output for empty / undefined / {}', () => {
    expect(canonicalizeContracts(undefined)).toBe('{}');
    expect(canonicalizeContracts({})).toBe('{}');
  });

  it('is order-insensitive at the top level', () => {
    const a: DataContract = {
      contextSpec: { topic: { schema: { type: 'string' } } },
    };
    const b: DataContract = {
      contextSpec: { topic: { schema: { type: 'string' } } },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });

  it('is order-insensitive in nested slot maps', () => {
    const a: DataContract = {
      contextSpec: {
        topic: { schema: { type: 'string' }, default: 'Bug' },
        noteText: { schema: { type: 'string' }, default: '' },
      },
    };
    const b: DataContract = {
      contextSpec: {
        noteText: { schema: { type: 'string' }, default: '' },
        topic: { schema: { type: 'string' }, default: 'Bug' },
      },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });

  it('strips description fields from the canonical form', () => {
    const withDesc: DataContract = {
      contextSpec: {
        noteText: {
          schema: { type: 'string' },
          default: '',
          description: 'Live mirror of the textarea — agent observes typing.',
        },
      },
    };
    const withoutDesc: DataContract = {
      contextSpec: {
        noteText: { schema: { type: 'string' }, default: '' },
      },
    };
    expect(canonicalizeContracts(withDesc)).toBe(
      canonicalizeContracts(withoutDesc),
    );
  });

  it('strips description nested at every level', () => {
    const a: DataContract = {
      propsSpec: {
        description: 'top-level props doc',
        properties: {
          rating: {
            schema: { type: 'number', description: 'schema-level doc' },
            description: 'entry-level doc',
            required: true,
          },
        },
      },
    };
    const b: DataContract = {
      propsSpec: {
        properties: {
          rating: { schema: { type: 'number' }, required: true },
        },
      },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });

  it('does NOT strip a gadget package literally named "usage"/"description"', () => {
    // Regression: STRIPPED_KEYS was applied depth-blind, so a gadget
    // package whose npm name is `usage` (npm allows it) was deleted
    // from the canonical form — distinct contracts collapsed onto one
    // blueprint cache key. The strip must key on string VALUES, not on
    // map keys.
    const usesFoo: DataContract = {
      clientCapabilities: { gadgets: { usage: { useFoo: {} } } },
    };
    const usesBar: DataContract = {
      clientCapabilities: { gadgets: { usage: { useBar: {} } } },
    };
    // The `usage` package survives → the differing export names
    // produce distinct canonical strings (distinct cache keys).
    expect(canonicalizeContracts(usesFoo)).not.toBe(
      canonicalizeContracts(usesBar),
    );
    expect(canonicalizeContracts(usesFoo)).toContain('usage');
    expect(canonicalizeContracts(usesFoo)).toContain('useFoo');

    // Same for a package named `description`.
    const descPkg: DataContract = {
      clientCapabilities: { gadgets: { description: { useX: {} } } },
    };
    expect(canonicalizeContracts(descPkg)).toContain('description');
  });

  it('still strips a string-valued usage field inside a gadget export-use', () => {
    // The intent-prose override on a GadgetExportUse IS still stripped:
    // it is string-valued, so it does not pollute the cache key.
    const withProse: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/widgets': {
            useThing: { usage: 'Mount when the intent names a thing.' },
          },
        },
      },
    };
    const withoutProse: DataContract = {
      clientCapabilities: {
        gadgets: { '@acme/widgets': { useThing: {} } },
      },
    };
    expect(canonicalizeContracts(withProse)).toBe(
      canonicalizeContracts(withoutProse),
    );
  });

  it('preserves load-bearing differences in default values', () => {
    const jan: DataContract = {
      propsSpec: {
        properties: {
          month: {
            schema: { type: 'string', enum: ['Jan', 'Feb', 'Mar'] },
            default: 'Jan',
          },
        },
      },
    };
    const mar: DataContract = {
      propsSpec: {
        properties: {
          month: {
            schema: { type: 'string', enum: ['Jan', 'Feb', 'Mar'] },
            default: 'Mar',
          },
        },
      },
    };
    expect(canonicalizeContracts(jan)).not.toBe(canonicalizeContracts(mar));
  });

  it('preserves enum array order — order can be load-bearing for selects', () => {
    const a: DataContract = {
      contextSpec: {
        topic: {
          schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
          default: 'Bug',
        },
      },
    };
    const b: DataContract = {
      contextSpec: {
        topic: {
          schema: { type: 'string', enum: ['Question', 'Feature', 'Bug'] },
          default: 'Bug',
        },
      },
    };
    expect(canonicalizeContracts(a)).not.toBe(canonicalizeContracts(b));
  });

  it('different slot names produce different canonical strings', () => {
    const a: DataContract = {
      contextSpec: { noteText: { schema: { type: 'string' } } },
    };
    const b: DataContract = {
      contextSpec: { text: { schema: { type: 'string' } } },
    };
    expect(canonicalizeContracts(a)).not.toBe(canonicalizeContracts(b));
  });

  it('different action names produce different canonical strings', () => {
    const a: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
    };
    const b: DataContract = {
      actionSpec: { send: { label: 'Submit' } },
    };
    expect(canonicalizeContracts(a)).not.toBe(canonicalizeContracts(b));
  });

  it('canonicalizeValue: drops undefined fields, keeps null', () => {
    const result = canonicalizeValue({
      keep: 'a',
      drop: undefined,
      nullable: null,
    });
    expect(result).toEqual({ keep: 'a', nullable: null });
  });

  it('canonicalizeValue: arrays preserve order through canonicalization', () => {
    const result = canonicalizeValue([
      { z: 1, a: 2 },
      { y: 3 },
    ]);
    // Each object's keys get sorted, but the array order itself stays.
    expect(result).toEqual([{ a: 2, z: 1 }, { y: 3 }]);
  });

  it('functions / symbols / bigint collapse to absent (not JSON-safe)', () => {
    const result = canonicalizeValue({
      keep: 1,
      fn: () => 'x',
      sym: Symbol('s'),
    });
    expect(result).toEqual({ keep: 1 });
  });

  it('serverInfo.name IS identity — different server names → different hash (kills the bare-name collision)', () => {
    const todoist: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: '@todoist/mcp', version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          },
        },
      },
    };
    const googleTasks: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: '@google/tasks-mcp', version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          },
        },
      },
    };
    // Byte-identical bare name + inputSchema, DIFFERENT owning server → MUST NOT
    // collide onto one blueprint cache key.
    expect(blueprintKey(todoist)).not.toBe(blueprintKey(googleTasks));
  });

  it('serverInfo.version does NOT affect the canonical hash (metadata, not identity)', () => {
    const v1: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: '@x/todo', version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object', properties: {} } },
          },
        },
      },
    };
    const v2: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: '@x/todo', version: '9.9.9' },
            toolInfo: { inputSchema: { type: 'object', properties: {} } },
          },
        },
      },
    };
    // A version bump alone must not invalidate a registered blueprint.
    expect(blueprintKey(v1)).toBe(blueprintKey(v2));
  });

  it('an authored serverInfo.name is a DISTINCT identity from an omitted serverInfo', () => {
    const bare: DataContract = {
      agentCapabilities: {
        tools: { todo_add: { toolInfo: { inputSchema: { type: 'object', properties: {} } } } },
      },
    };
    const named: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: {
            serverInfo: { name: '@x/todo', version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object', properties: {} } },
          },
        },
      },
    };
    // Naming the server is more specific than omitting it → different key.
    expect(blueprintKey(bare)).not.toBe(blueprintKey(named));
  });

  it('serverInfo.name survives the strip while version is removed (combined)', () => {
    const a: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: { serverInfo: { name: '@x/todo', version: '1.0.0' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } },
        },
      },
    };
    const b: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: { serverInfo: { name: '@y/todo', version: '1.0.0' }, toolInfo: { inputSchema: { type: 'object', properties: {} } } },
        },
      },
    };
    expect(blueprintKey(a)).not.toBe(blueprintKey(b));
  });

  it('tool-name set change DOES change the canonical hash', () => {
    const oneTool: DataContract = {
      agentCapabilities: {
        tools: { todo_add: { toolInfo: { inputSchema: { type: 'object', properties: {} } } } },
      },
    };
    const twoTools: DataContract = {
      agentCapabilities: {
        tools: {
          todo_add: { toolInfo: { inputSchema: { type: 'object', properties: {} } } },
          todo_remove: { toolInfo: { inputSchema: { type: 'object', properties: {} } } },
        },
      },
    };
    expect(blueprintKey(oneTool)).not.toBe(blueprintKey(twoTools));
  });
});

describe('canonicalizeContracts — RFC 8785 (JCS) conformance', () => {
  // Pin behaviors that JCS specifies precisely but ad-hoc JSON
  // serialization gets wrong. External implementers using any JCS
  // library should produce the same bytes.

  it('emits no whitespace between tokens (JCS §3.2.1)', () => {
    const result = canonicalizeContracts({
      contextSpec: { x: { schema: { type: 'string' } } },
    });
    expect(result).not.toContain('  ');
    expect(result).not.toContain('\n');
    expect(result).not.toContain(': ');
    expect(result).not.toContain(', ');
  });

  it('sorts top-level keys alphabetically by code unit (JCS §3.2.3)', () => {
    const result = canonicalizeContracts({
      streamSpec: { tick: { schema: { type: 'string' } } },
      contextSpec: { x: { schema: { type: 'string' } } },
    });
    const streamSpecPos = result.indexOf('"streamSpec"');
    const contextSpecPos = result.indexOf('"contextSpec"');
    expect(contextSpecPos).toBeGreaterThan(-1);
    expect(streamSpecPos).toBeGreaterThan(-1);
    expect(contextSpecPos).toBeLessThan(streamSpecPos);
  });

  it('preserves array order (JCS §3.2.2)', () => {
    const result = canonicalizeContracts({
      contextSpec: {
        topic: {
          schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
          default: 'Bug',
        },
      },
    });
    const enumPos = result.indexOf('"enum":');
    const enumBlock = result.slice(enumPos, enumPos + 50);
    expect(enumBlock).toContain('"Bug","Feature","Question"');
  });

  it('NFC-normalizes string values (precomposed === decomposed)', () => {
    // RFC 8785 leaves Unicode normalization out of scope. We add NFC
    // ourselves so visually-identical labels hash identically across
    // keyboards / IMEs that emit different composition forms. Use
    // explicit \u escapes — JS source files in some editors silently
    // re-normalize literal accented characters.
    const precomposed = 'caf\u00e9'; // é as one code point
    const decomposed = 'cafe\u0301'; // e + combining acute (two code points)
    expect(precomposed).not.toBe(decomposed); // sanity: different bytes
    expect(precomposed.length).toBe(4);
    expect(decomposed.length).toBe(5);

    const a: DataContract = {
      contextSpec: {
        topic: { schema: { type: 'string' }, default: precomposed },
      },
    };
    const b: DataContract = {
      contextSpec: {
        topic: { schema: { type: 'string' }, default: decomposed },
      },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });

  it('NFC-normalizes object keys (precomposed key === decomposed key)', () => {
    const precomposed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';

    const a: DataContract = {
      contextSpec: {
        [precomposed]: { schema: { type: 'string' } },
      },
    };
    const b: DataContract = {
      contextSpec: {
        [decomposed]: { schema: { type: 'string' } },
      },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });

  it('produces stable output across paraphrased input shapes', () => {
    // Same semantic contract, different authoring shapes (key order,
    // description fields, top-level rearrangement). All must hash
    // identically under JCS.
    const a: DataContract = {
      actionSpec: {
        save: {
          label: 'Save',
          nextStep: 'save_note',
          description: 'Persist the note',
        },
      },
      contextSpec: {
        noteText: { schema: { type: 'string' }, default: '' },
      },
    };
    const b: DataContract = {
      contextSpec: {
        noteText: { default: '', schema: { type: 'string' } },
      },
      actionSpec: {
        save: { nextStep: 'save_note', label: 'Save' },
      },
    };
    expect(canonicalizeContracts(a)).toBe(canonicalizeContracts(b));
  });
});

describe('canonicalizeVariance', () => {
  it('self-normalizes undefined / {} / all-empty to one canonical form (D9)', () => {
    const sentinel = canonicalizeVariance(undefined);
    expect(canonicalizeVariance({})).toBe(sentinel);
    expect(canonicalizeVariance({ persona: '' })).toBe(sentinel);
    expect(
      canonicalizeVariance({
        persona: '',
        aesthetic: '',
        seedPrompt: '',
        context: {},
      }),
    ).toBe(sentinel);
  });

  it('is key-order insensitive', () => {
    const a: BlueprintVariance = { persona: 'minimalist', aesthetic: 'editorial' };
    const b: BlueprintVariance = { aesthetic: 'editorial', persona: 'minimalist' };
    expect(canonicalizeVariance(a)).toBe(canonicalizeVariance(b));
  });

  it('NFC-normalizes string values (precomposed === decomposed)', () => {
    const precomposed = 'caf\u00e9'; // \u00e9 as one code point
    const decomposed = 'cafe\u0301'; // e + combining acute (two code points)
    expect(precomposed).not.toBe(decomposed);
    expect(canonicalizeVariance({ persona: precomposed })).toBe(
      canonicalizeVariance({ persona: decomposed }),
    );
  });

  it('does NOT strip seedPrompt / context prose — variance prose is load-bearing', () => {
    // The inverse of the contract pipeline: a description-named field
    // here is signal, not noise. Differing seedPrompt MUST diverge.
    expect(canonicalizeVariance({ seedPrompt: 'calm pastel layout' })).not.toBe(
      canonicalizeVariance({ seedPrompt: 'busy data-dense layout' }),
    );
  });

  it('does NOT strip a string-valued field named "description"/"usage" inside context', () => {
    // Unlike canonicalizeContracts, variance never strips prose: a
    // context value keyed `description` is load-bearing variance signal.
    const withDesc = canonicalizeVariance({ context: { description: 'cozy' } });
    expect(withDesc).toContain('description');
    expect(withDesc).toContain('cozy');
    expect(canonicalizeVariance({ context: { description: 'cozy' } })).not.toBe(
      canonicalizeVariance({ context: { description: 'stark' } }),
    );
  });

  it('differing persona produces differing output', () => {
    expect(canonicalizeVariance({ persona: 'data-dense' })).not.toBe(
      canonicalizeVariance({ persona: 'minimalist' }),
    );
  });
});
