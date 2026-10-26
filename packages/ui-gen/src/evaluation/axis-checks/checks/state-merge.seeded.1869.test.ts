// ggui#1869 — `state.merge.seeded_from_props` is a FAIL, and it refused correct seeding:
// a nested generic on `useState`, `props?.`, a local alias, or destructured props. A FAIL
// may only refuse what correct code can always avoid. W29's first night ended a
// kanban cell on this signature after five repeats.
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


const check = STATE_MERGE_CHECKS.find((c) => c.id === 'state.merge.seeded_from_props');
const run = (sourceCode: string) => {
  if (check === undefined) throw new Error('state.merge.seeded_from_props is not registered');
  const input: AxisCheckInput = { sourceCode, compiledCode: 'built', originalPrompt: '', classification, contract };
  return check.run(input);
};

/** Both mutated collections seeded; `{tasks}` is the shape under test. */
const both = (tasks: string) => `${tasks}\nconst [columns, setColumns] = useState(props.columns ?? []);`;

describe('state.merge.seeded_from_props accepts every correct seeding shape (ggui#1869)', () => {
  const correct: Record<string, string> = {
    'the canonical form': 'const [tasks, setTasks] = useState(props.tasks);',
    'a nested generic': 'const [tasks, setTasks] = useState<Array<Task>>(props.tasks ?? []);',
    'a Record generic and a lazy initializer':
      'const [byColumn, setByColumn] = useState<Record<string, Task[]>>(() => group(props.tasks ?? []));',
    'an optional chain': 'const [tasks, setTasks] = useState(props?.tasks ?? []);',
    'a local alias': 'const seed = props.tasks ?? [];\nconst [tasks, setTasks] = useState(seed);',
    'destructured from props': 'const { tasks: initialTasks } = props;\nconst [tasks, setTasks] = useState(initialTasks ?? []);',
    'a destructured parameter':
      'export default function Component({ tasks: initial, columns }: Props) {\n  const [tasks, setTasks] = useState(initial ?? []);',
  };
  for (const [name, src] of Object.entries(correct)) {
    it(`${name} passes`, () => {
      expect(run(both(src)).filter((i) => i.description.includes('"tasks"'))).toEqual([]);
    });
  }

  it('a collection never seeded still fails, with the prop named', () => {
    const issues = run(both('const [tasks, setTasks] = useState<Task[]>([]);'));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.result).toBe('fail');
    expect(issues[0]?.description).toContain('"tasks"');
  });
  it('a prop read outside any useState does not count as seeding', () => {
    expect(run(both('const visible = (props.tasks ?? []).filter(isOpen);\nconst [tasks, setTasks] = useState<Task[]>([]);'))).toHaveLength(1);
  });
  it("a helper's destructured parameter is not the component's props", () => {
    expect(
      run(both('function sortTasks({ tasks }: Sorted) { return tasks; }\nconst tasks0: Task[] = [];\nconst [list, setList] = useState(tasks0);')),
    ).toHaveLength(1);
    expect(
      run(both('function sortTasks({ tasks }: Sorted) { return tasks; }\nconst [list, setList] = useState<Task[]>(() => sortTasks({ tasks: [] }));')),
    ).toHaveLength(1);
  });
  // The control is `"("`, not `")"`: a `")"` in the string passed before the string-skip fix too, so it
  // controlled nothing; an unmatched `(` is what stretched the old initializer over the later read.
  it('a `(` inside a string in the initializer does not stretch it over a later read', () => {
    expect(run(both('const [label, setLabel] = useState(() => fmt("("));\nconst visible = props.tasks ?? [];\nconst [tasks, setTasks] = useState<Task[]>([]);'))).toHaveLength(1);
  });
  it('an alias of a different prop does not count', () => {
    expect(run(both('const seed = props.columns ?? [];\nconst [tasks, setTasks] = useState(seed);'))).toHaveLength(1);
  });
  // The same reader decides both ids, so a collection kept in a generated context slot (no useState;
  // the hook takes no initial value) is seeded by an effect feeding its setter, or a fallback to the prop.
  it('a context slot seeded by an effect, or falling back to the prop, passes', () => {
    const slot = "const [tasks, setTasks] = useGguiContext<Task[]>('tasks'); // DO NOT EDIT\n";
    expect(run(both(slot + 'useEffect(() => { if (!tasks?.length) setTasks(props.tasks ?? []); }, [props.tasks]);'))).toEqual([]);
    expect(run(both(slot + 'const shown = tasks ?? props.tasks ?? [];'))).toEqual([]);
  });
  it('a context slot set from the prop only in a click handler still fails', () => {
    const slot = "const [tasks, setTasks] = useGguiContext<Task[]>('tasks'); // DO NOT EDIT\n";
    expect(run(both(slot + 'return <Button onClick={() => setTasks(props.tasks)}>Reset</Button>;'))).toHaveLength(1);
  });
});
