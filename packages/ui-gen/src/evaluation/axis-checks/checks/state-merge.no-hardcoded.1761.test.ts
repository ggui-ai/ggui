// ggui#1761 — `state.merge.no_hardcoded_entities` named no prop in its repair line: it read
// "Seed state from props.{entityProp}", an unfilled placeholder. A model that kept a literal
// fallback list (a column default beside `props.columns`) was told to remove "the literal
// array" and seed from a prop the line never named, and one nightly cell spent 30 turns on it.
import { describe, expect, it } from 'vitest';
import type { DataContract, JsonSchema } from '@ggui-ai/protocol';
import { STATE_MERGE_CHECKS } from './state-merge.js';
import type { AxisCheckInput } from '../types.js';
import type { Classification } from '../../../classifier/axes.js';

const str: JsonSchema = { type: 'string' };
const item = (extra: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties: { id: str, ...extra },
});
const contract: DataContract = {
  propsSpec: {
    properties: {
      tasks: { schema: { type: 'array', items: item({ title: str, column: str }) }, required: true },
      columns: { schema: { type: 'array', items: item({ name: str }) }, required: true },
    },
  },
  actionSpec: {
    taskUpdate: { label: 'Task updated', schema: { type: 'object', properties: { taskId: { type: 'string' }, data: { type: 'object' } } }, example: { taskId: '1', data: {} } },
  },
  streamSpec: {
    taskChanged: { schema: { type: 'object', properties: { action: { type: 'string' }, task: item({ title: str }) } } },
  },
};

const classification: Classification = {
  vector: { render: 'static', state: 'merge', writes: 'submit', writeTrigger: 'click', realtime: 'merge', fetch: 'none', layout: 'single', tooling: 'none', choice: 'none' },
  provenance: { render: 'default', state: 'default', writes: 'default', writeTrigger: 'default', realtime: 'default', fetch: 'default', layout: 'default', tooling: 'default', choice: 'default' },
  riskTier: 'medium',
};

const check = STATE_MERGE_CHECKS.find((c) => c.id === 'state.merge.no_hardcoded_entities');
const run = (sourceCode: string) => {
  if (check === undefined) throw new Error('state.merge.no_hardcoded_entities is not registered');
  const input: AxisCheckInput = { sourceCode, compiledCode: 'built', originalPrompt: '', classification, contract };
  return check.run(input);
};

describe('state.merge.no_hardcoded_entities (ggui#1761)', () => {
  it('a literal fallback list fires, and the repair names the props the data comes from', () => {
    const issues = run(
      "const DEFAULT_COLUMNS = [{ id: 'todo', name: 'To Do' }, { id: 'done', name: 'Done' }];\nconst columns = props.columns ?? DEFAULT_COLUMNS;",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.fix).toContain('props.tasks / props.columns');
    expect(issues[0]?.fix).toContain('?? []');
    expect(issues[0]?.fix).not.toContain('{entityProp}');
  });

  it('reading the props, with an empty fallback, is silent', () => {
    expect(run('const columns = props.columns ?? [];\nconst [tasks, setTasks] = useState(props.tasks ?? []);')).toEqual([]);
  });

  it('a literal inside a comment is silent', () => {
    expect(run("// e.g. [{ id: 'todo' }, { id: 'done' }]\nconst columns = props.columns ?? [];")).toEqual([]);
  });
});
