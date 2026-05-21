/**
 * Tests for the programmatic contract validators. Three blocks:
 *
 *   1. `validateContractStructure` — counter / toggle / form / save
 *      cases pin the heuristic's behavior on known patterns.
 *   2. Verb-list self-test — meta-check that pins the mutator-verb
 *      list against contracts that SHOULD and SHOULD NOT flag, so a
 *      future edit to `MUTATOR_VERBS` lights up the regression.
 *   3. `validateContractNovelty` — InMemoryVectorStore + a stub
 *      embedder, both above-threshold and below-threshold cases.
 */
import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import type {
  EmbeddingProvider,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import {
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  validateActionsVsContext,
  validateContractCoherence,
  validateContractStructure,
  validateContractNovelty,
  formatValidationFindings,
} from './contract-validators.js';

const EMPTY_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

describe('validateContractStructure — load-bearing counter case', () => {
  it('flags increment + count (single slot, empty remainder)', () => {
    const contract: DataContract = {
      actionSpec: {
        increment: { label: 'Increment', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toBeDefined();
    if (!finding) return;
    expect(finding.kind).toBe('redundant-action');
    expect(finding.severity).toBe('warn');
    expect(finding.actionName).toBe('increment');
    expect(finding.slotName).toBe('count');
    expect(finding.hint).toMatch(/empty payload/);
    expect(finding.hint).toMatch(/count/);
  });

  it('flags every redundant action in a counter with multiple verbs', () => {
    const contract: DataContract = {
      actionSpec: {
        increment: { label: 'Increment', schema: EMPTY_PAYLOAD_SCHEMA  },
        decrement: { label: 'Decrement', schema: EMPTY_PAYLOAD_SCHEMA  },
        reset: { label: 'Reset', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings.map((f) => f.actionName).sort()).toEqual([
      'decrement',
      'increment',
      'reset',
    ]);
    for (const f of findings) {
      expect(f.slotName).toBe('count');
    }
  });
});

describe('validateContractStructure — remainder/slot matching', () => {
  it('flags toggle + isOpen via remainder containment', () => {
    const contract: DataContract = {
      actionSpec: {
        toggleIsOpen: { label: 'Toggle', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        isOpen: { schema: { type: 'boolean' }, default: false },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.actionName).toBe('toggleIsOpen');
    expect(findings[0]?.slotName).toBe('isOpen');
  });

  it('flags addItem + items (remainder contains slot or vice versa)', () => {
    const contract: DataContract = {
      actionSpec: {
        addItem: { label: 'Add', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        items: { schema: { type: 'array' }, default: [] },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.slotName).toBe('items');
  });

  it('does NOT flag when remainder and slot share no substring', () => {
    const contract: DataContract = {
      actionSpec: {
        setTheme: { label: 'Theme', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
        items: { schema: { type: 'array' }, default: [] },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });
});

describe('validateContractStructure — non-mutator legitimate patterns', () => {
  it('does NOT flag submit + formData (submit is not a mutator verb)', () => {
    const contract: DataContract = {
      actionSpec: {
        submit: { label: 'Submit', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        formData: {
          schema: { type: 'object' },
          default: {},
        },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag actions with declared payload fields', () => {
    const contract: DataContract = {
      actionSpec: {
        addItem: {
          label: 'Add',
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      contextSpec: {
        items: { schema: { type: 'array' }, default: [] },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag save action with no matching slot', () => {
    const contract: DataContract = {
      actionSpec: {
        save: { label: 'Save', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        draft: { schema: { type: 'string' }, default: '' },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag empty contextSpec (no slots = no mutation target)', () => {
    const contract: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag bare verb action against multi-slot contextSpec', () => {
    // Bare `increment` against two slots is ambiguous — heuristic
    // declines (single-slot rule) to avoid false-positives.
    const contract: DataContract = {
      actionSpec: {
        increment: { label: 'Inc', schema: EMPTY_PAYLOAD_SCHEMA  },
      },
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
        score: { schema: { type: 'number' }, default: 0 },
      },
    };
    const { findings } = validateContractStructure(contract);
    expect(findings).toHaveLength(0);
  });
});

describe('validateContractStructure — verb-list self-test', () => {
  // Each fixture is a (contract, expected) pair. SHOULD-flag fixtures
  // pin verbs that genuinely indicate mutation. SHOULD-NOT-flag
  // fixtures pin verbs deliberately kept OUT of the list (submit,
  // save, cancel, confirm) and patterns the heuristic must not
  // false-positive on (declared payload, no slot match).
  const SHOULD_FLAG: ReadonlyArray<{
    name: string;
    contract: DataContract;
  }> = [
    {
      name: 'increment + count',
      contract: {
        actionSpec: { increment: { label: 'I', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { count: { schema: { type: 'number' } } },
      },
    },
    {
      name: 'decrement + count',
      contract: {
        actionSpec: { decrement: { label: 'D', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { count: { schema: { type: 'number' } } },
      },
    },
    {
      name: 'reset + count',
      contract: {
        actionSpec: { reset: { label: 'R', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { count: { schema: { type: 'number' } } },
      },
    },
    {
      name: 'setName + name',
      contract: {
        actionSpec: { setName: { label: 'N', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { name: { schema: { type: 'string' } } },
      },
    },
    {
      name: 'toggle + isOpen (single slot)',
      contract: {
        actionSpec: { toggle: { label: 'T', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { isOpen: { schema: { type: 'boolean' } } },
      },
    },
    {
      name: 'flipFlag + flag',
      contract: {
        actionSpec: { flipFlag: { label: 'F', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { flag: { schema: { type: 'boolean' } } },
      },
    },
    {
      name: 'clearList + list',
      contract: {
        actionSpec: {
          clearList: { label: 'C', schema: EMPTY_PAYLOAD_SCHEMA  },
        },
        contextSpec: { list: { schema: { type: 'array' } } },
      },
    },
    {
      name: 'appendItem + items (substring overlap)',
      contract: {
        actionSpec: {
          appendItem: { label: 'A', schema: EMPTY_PAYLOAD_SCHEMA  },
        },
        contextSpec: { items: { schema: { type: 'array' } } },
      },
    },
    {
      name: 'updateDraft + draft',
      contract: {
        actionSpec: {
          updateDraft: { label: 'U', schema: EMPTY_PAYLOAD_SCHEMA  },
        },
        contextSpec: { draft: { schema: { type: 'string' } } },
      },
    },
    {
      name: 'changeColor + color',
      contract: {
        actionSpec: {
          changeColor: { label: 'Ch', schema: EMPTY_PAYLOAD_SCHEMA  },
        },
        contextSpec: { color: { schema: { type: 'string' } } },
      },
    },
  ];

  const SHOULD_NOT_FLAG: ReadonlyArray<{
    name: string;
    contract: DataContract;
  }> = [
    {
      name: 'submit + formData (submit deliberately not a mutator verb)',
      contract: {
        actionSpec: { submit: { label: 'S', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { formData: { schema: { type: 'object' } } },
      },
    },
    {
      name: 'save + draft (save deliberately not a mutator verb)',
      contract: {
        actionSpec: { save: { label: 'S', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { draft: { schema: { type: 'string' } } },
      },
    },
    {
      name: 'cancel + draft (cancel deliberately not a mutator verb)',
      contract: {
        actionSpec: { cancel: { label: 'C', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { draft: { schema: { type: 'string' } } },
      },
    },
    {
      name: 'confirm + selection (confirm deliberately not a mutator verb)',
      contract: {
        actionSpec: { confirm: { label: 'C', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: { selection: { schema: { type: 'string' } } },
      },
    },
    {
      name: 'incrementCount + score (no name overlap)',
      contract: {
        actionSpec: {
          incrementCount: { label: 'I', schema: EMPTY_PAYLOAD_SCHEMA  },
        },
        contextSpec: { score: { schema: { type: 'number' } } },
      },
    },
    {
      name: 'addItem with declared payload (not empty payload)',
      contract: {
        actionSpec: {
          addItem: {
            label: 'A',
            schema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        },
        contextSpec: { items: { schema: { type: 'array' } } },
      },
    },
    {
      name: 'increment with bare action against multi-slot contextSpec',
      contract: {
        actionSpec: { increment: { label: 'I', schema: EMPTY_PAYLOAD_SCHEMA  } },
        contextSpec: {
          count: { schema: { type: 'number' } },
          score: { schema: { type: 'number' } },
        },
      },
    },
  ];

  for (const fixture of SHOULD_FLAG) {
    it(`flags: ${fixture.name}`, () => {
      const { findings } = validateContractStructure(fixture.contract);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]?.kind).toBe('redundant-action');
    });
  }

  for (const fixture of SHOULD_NOT_FLAG) {
    it(`does not flag: ${fixture.name}`, () => {
      const { findings } = validateContractStructure(fixture.contract);
      expect(findings).toHaveLength(0);
    });
  }
});

describe('validateContractNovelty — InMemoryVectorStore + MockEmbeddingProvider', () => {
  it('flags novel contract when scope is empty', async () => {
    const deps = {
      embedding: new MockEmbeddingProvider(),
      vectorStore: new InMemoryVectorStore(),
      scope: 'shared',
    };
    const contract: DataContract = {
      actionSpec: { submit: { label: 'S', schema: EMPTY_PAYLOAD_SCHEMA  } },
      contextSpec: { draft: { schema: { type: 'string' } } },
    };
    const { findings } = await validateContractNovelty(contract, deps);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('novel-shape');
    expect(findings[0]?.cosine).toBeUndefined();
    expect(findings[0]?.hint).toMatch(/no neighbors/i);
  });

  it('does NOT flag when nearest neighbor is identical (distance 0)', async () => {
    const embedder = new MockEmbeddingProvider();
    const store = new InMemoryVectorStore();
    const contract: DataContract = {
      actionSpec: { submit: { label: 'S', schema: EMPTY_PAYLOAD_SCHEMA  } },
      contextSpec: { draft: { schema: { type: 'string' } } },
    };
    // Pre-register the SAME contract — embedding is deterministic on
    // the same input, so the nearest neighbor will be identical.
    const { summarizeContract } = await import('@ggui-ai/protocol');
    const summary = summarizeContract(contract);
    const vector = await embedder.embed(summary);
    await store.putVector('shared', { key: 'preexisting', vector, metadata: {} });

    const { findings } = await validateContractNovelty(
      contract,
      { embedding: embedder, vectorStore: store, scope: 'shared' },
      { thresholdCosine: 0.5 },
    );
    expect(findings).toHaveLength(0);
  });

  it('flags novel contract when distance exceeds threshold', async () => {
    const embedder: EmbeddingProvider = {
      id: 'orth',
      dimensions: 4,
      async embed(text: string): Promise<number[]> {
        // Map a small set of inputs to orthogonal unit vectors so we
        // get full distance control without depending on the mock's
        // hashing surface area.
        if (text.includes('counter')) return [1, 0, 0, 0];
        if (text.includes('weather')) return [0, 1, 0, 0];
        return [0, 0, 1, 0];
      },
    };
    const store: VectorStore = new InMemoryVectorStore();
    await store.putVector('shared', {
      key: 'counter-blueprint',
      vector: [1, 0, 0, 0],
      metadata: { intent: 'counter widget' },
    });

    // Query is orthogonal to the only registered vector ⇒ cosine 0,
    // distance 1 ⇒ above any reasonable threshold.
    const queryContract: DataContract = {
      contextSpec: { temp: { schema: { type: 'number' } } },
    };
    // Force the embedder to return [0,1,0,0] for our summary by
    // putting "weather" in the synthesized summary's input. The
    // structural summary doesn't include this token directly, so we
    // shadow with a stub embedder that consults the contract's
    // interaction mode instead — done above via the if/else chain.
    const { findings } = await validateContractNovelty(
      queryContract,
      { embedding: embedder, vectorStore: store, scope: 'shared' },
      { thresholdCosine: 0.5 },
    );
    // Whatever vector the embedder returned for the queryContract's
    // summary, it's not [1,0,0,0], so cosine to the registered vector
    // is 0 (orthogonal) ⇒ distance 1 ⇒ above 0.5.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('novel-shape');
    expect(typeof findings[0]?.cosine).toBe('number');
  });

  it('respects custom thresholdCosine', async () => {
    const embedder: EmbeddingProvider = {
      id: 'sim',
      dimensions: 2,
      // Both inputs map to nearly-the-same vector ⇒ cosine ~ 1.
      async embed(): Promise<number[]> {
        return [1, 0];
      },
    };
    const store: VectorStore = new InMemoryVectorStore();
    await store.putVector('shared', {
      key: 'twin',
      vector: [1, 0],
      metadata: {},
    });

    const contract: DataContract = {
      actionSpec: { submit: { label: 'S', schema: EMPTY_PAYLOAD_SCHEMA  } },
    };
    // Distance 0 < threshold 0.01 ⇒ no flag.
    const tight = await validateContractNovelty(
      contract,
      { embedding: embedder, vectorStore: store, scope: 'shared' },
      { thresholdCosine: 0.01 },
    );
    expect(tight.findings).toHaveLength(0);

    // Distance 0 < threshold 0.5 ⇒ still no flag.
    const loose = await validateContractNovelty(
      contract,
      { embedding: embedder, vectorStore: store, scope: 'shared' },
      { thresholdCosine: 0.5 },
    );
    expect(loose.findings).toHaveLength(0);
  });
});

describe('formatValidationFindings', () => {
  it('returns empty string for empty findings', () => {
    expect(formatValidationFindings({ findings: [] })).toBe('');
  });

  it('joins multiple findings with severity prefix', () => {
    const formatted = formatValidationFindings({
      findings: [
        {
          kind: 'redundant-action',
          severity: 'warn',
          actionName: 'increment',
          slotName: 'count',
          hint: 'A',
        },
        {
          kind: 'novel-shape',
          severity: 'warn',
          hint: 'B',
        },
      ],
    });
    expect(formatted).toContain('[warn:redundant-action] A');
    expect(formatted).toContain('[warn:novel-shape] B');
    expect(formatted).toContain(' | ');
  });
});

// =============================================================================
// validateActionsVsContext — KK loose self-check
// =============================================================================

describe('validateActionsVsContext', () => {
  describe('name collision across specs', () => {
    it('flags a key present in both actionSpec and contextSpec', () => {
      const contract: DataContract = {
        actionSpec: {
          submit: {
            label: 'Submit',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
        contextSpec: {
          submit: { schema: { type: 'boolean' }, default: false },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const collision = findings.find(
        (f) => f.kind === 'actions-vs-context-name-collision',
      );
      expect(collision).toBeDefined();
      expect(collision?.severity).toBe('warn');
      expect(collision?.actionName).toBe('submit');
      expect(collision?.slotName).toBe('submit');
    });

    it('does not flag when keys are distinct', () => {
      const contract: DataContract = {
        actionSpec: {
          submit: {
            label: 'Submit',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
        contextSpec: {
          rating: { schema: { type: 'number' }, default: 0 },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const collision = findings.find(
        (f) => f.kind === 'actions-vs-context-name-collision',
      );
      expect(collision).toBeUndefined();
    });
  });

  describe('state-y name in actionSpec', () => {
    it.each([
      'autosave',
      'onChange',
      'draftChanged',
      'typingIndicator',
      'inputChange',
      'onFocus',
      'onBlur',
    ])('flags actionSpec entry "%s" as state-y', (name) => {
      const contract: DataContract = {
        actionSpec: {
          [name]: {
            label: name,
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const stateLike = findings.find(
        (f) => f.kind === 'action-name-looks-state-y' && f.actionName === name,
      );
      expect(stateLike).toBeDefined();
      expect(stateLike?.severity).toBe('warn');
    });

    it('does not flag canonical event names (submit/cancel/send)', () => {
      const contract: DataContract = {
        actionSpec: {
          submit: {
            label: 'Submit',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
          cancel: {
            label: 'Cancel',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const stateLike = findings.filter(
        (f) => f.kind === 'action-name-looks-state-y',
      );
      expect(stateLike).toEqual([]);
    });
  });

  describe('action-y name in contextSpec', () => {
    it.each([
      'submit',
      'send',
      'confirm',
      'cancel',
      'next',
      'done',
      'apply',
      'delete',
    ])('flags contextSpec entry "%s" as action-y', (name) => {
      const contract: DataContract = {
        contextSpec: {
          [name]: { schema: { type: 'boolean' }, default: false },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const actionLike = findings.find(
        (f) => f.kind === 'context-name-looks-action-y' && f.slotName === name,
      );
      expect(actionLike).toBeDefined();
      expect(actionLike?.severity).toBe('warn');
    });

    it('does not flag canonical state names (count, draft, rating)', () => {
      const contract: DataContract = {
        contextSpec: {
          count: { schema: { type: 'number' }, default: 0 },
          draftText: { schema: { type: 'string' }, default: '' },
          rating: { schema: { type: 'number' }, default: 0 },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const actionLike = findings.filter(
        (f) => f.kind === 'context-name-looks-action-y',
      );
      expect(actionLike).toEqual([]);
    });
  });

  describe('clean contracts', () => {
    it('returns no findings for a typical form contract', () => {
      const contract: DataContract = {
        actionSpec: {
          submit: {
            label: 'Submit',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
        contextSpec: {
          rating: { schema: { type: 'number' }, default: 0 },
          comment: { schema: { type: 'string' }, default: '' },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      expect(findings).toEqual([]);
    });

    it('returns no findings for a display-only contract (propsSpec only)', () => {
      const contract: DataContract = {
        propsSpec: {
          properties: {
            city: { schema: { type: 'string' }, required: true },
          },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      expect(findings).toEqual([]);
    });

    it('returns no findings for a broadcast-only contract (streamSpec only)', () => {
      const contract: DataContract = {
        streamSpec: {
          ticks: {
            schema: {
              type: 'object',
              properties: { price: { type: 'number' } },
            },
          },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      expect(findings).toEqual([]);
    });
  });

  describe('loose / advisory severity', () => {
    it('every finding is severity: warn — never error', () => {
      const contract: DataContract = {
        actionSpec: {
          autosave: {
            label: 'Auto-save',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
          shared: {
            label: 'Shared',
            schema: EMPTY_PAYLOAD_SCHEMA,
          },
        },
        contextSpec: {
          submit: { schema: { type: 'boolean' }, default: false },
          shared: { schema: { type: 'string' }, default: '' },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.severity).toBe('warn');
      }
    });
  });

  describe('contextSpec ↔ propsSpec name collision (SPEC §2.10)', () => {
    it('flags a contextSpec slot that collides with a propsSpec property — as ERROR', () => {
      const contract: DataContract = {
        propsSpec: {
          properties: { title: { schema: { type: 'string' }, required: true } },
        },
        contextSpec: {
          title: { schema: { type: 'string' }, default: '' },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      const collision = findings.find(
        (f) => f.kind === 'context-props-name-collision',
      );
      expect(collision).toBeDefined();
      expect(collision?.severity).toBe('error');
      expect(collision?.slotName).toBe('title');
    });

    it('does NOT flag when contextSpec and propsSpec keys are disjoint', () => {
      const contract: DataContract = {
        propsSpec: {
          properties: { title: { schema: { type: 'string' }, required: true } },
        },
        contextSpec: {
          draft: { schema: { type: 'string' }, default: '' },
        },
      };
      const { findings } = validateActionsVsContext(contract);
      expect(
        findings.some((f) => f.kind === 'context-props-name-collision'),
      ).toBe(false);
    });
  });
});

// =============================================================================
// validateContractCoherence — intent-aware degenerate-contract detector
// =============================================================================

describe('validateContractCoherence', () => {
  const EMPTY_ACTION = {
    label: 'Do it',
    schema: { type: 'object', properties: {}, additionalProperties: false },
  } as const;

  it('flags a data-bearing intent that produced an actionSpec-only contract', () => {
    // The flow-checkout [16] flake: a checkout flow synthesized as just
    // a finish action, no data surface.
    const contract: DataContract = { actionSpec: { finish: EMPTY_ACTION } };
    const { findings } = validateContractCoherence(
      contract,
      'a checkout flow with shipping, payment, and review steps',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('incoherent-no-data-surface');
    expect(findings[0]!.severity).toBe('error');
  });

  it('flags an article view synthesized as a share action with no propsSpec', () => {
    // The misc-share-button flake.
    const contract: DataContract = { actionSpec: { share: EMPTY_ACTION } };
    const { findings } = validateContractCoherence(
      contract,
      'an article view with a share button',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('incoherent-no-data-surface');
  });

  it('does NOT flag when the data-bearing contract has a contextSpec', () => {
    const contract: DataContract = {
      actionSpec: { finish: EMPTY_ACTION },
      contextSpec: { step: { schema: { type: 'number' }, default: 0 } },
    };
    const { findings } = validateContractCoherence(
      contract,
      'a checkout flow with shipping and payment',
    );
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag a pure-decision modal (no data-surface intent keyword)', () => {
    // `{actionSpec:{confirm,cancel}}` with no surface is the ONE
    // legitimate no-surface shape — the intent matches no data keyword.
    const contract: DataContract = {
      actionSpec: { confirm: EMPTY_ACTION, cancel: EMPTY_ACTION },
    };
    const { findings } = validateContractCoherence(
      contract,
      'a delete-confirmation modal with confirm and cancel actions',
    );
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag when the contract has a propsSpec surface', () => {
    const contract: DataContract = {
      actionSpec: { share: EMPTY_ACTION },
      propsSpec: {
        properties: { title: { schema: { type: 'string' }, required: true } },
      },
    };
    const { findings } = validateContractCoherence(
      contract,
      'an article view with a share button',
    );
    expect(findings).toHaveLength(0);
  });
});
