// ggui#1790 — collectStateKeys reads the initial-state shapes idiomatic React uses, so
// state.payload.covers_submit stops reporting every key missing on a form that holds them all.
import { describe, expect, it } from 'vitest';
import { collectStateKeys } from './helpers.js';

const KEYS = ['name', 'email', 'followUpDate', 'satisfaction', 'features', 'comments'];
const BODY = "name: '', email: '', followUpDate: '', satisfaction: 0, features: [] as string[], comments: ''";
const missing = (src: string): string[] => KEYS.filter((k) => !collectStateKeys(src).has(k));

describe('collectStateKeys (ggui#1790)', () => {
  it.each([
    ['destructured slots', KEYS.map((k) => `const [${k}, set_${k}] = useState('');`).join('\n')],
    ['an inline object', `const [form, setForm] = useState({ ${BODY} });`],
    ['a typed inline object', `const [form, setForm] = useState<SurveyForm>({ ${BODY} });`],
    ['a multiline inline object', `const [form, setForm] = useState<SurveyForm>({\n  ${BODY.split(', ').join(',\n  ')},\n});`],
    // The three the scan used to miss: each reported all six keys missing.
    ['a named initial constant (the survey-form loop)', `const INITIAL: SurveyState = { ${BODY} };\nconst [data, setData] = useState<SurveyState>(INITIAL);`],
    ['a lazy initializer', `const [form, setForm] = useState<SurveyForm>(() => ({ ${BODY} }));`],
    ['a lazy initializer returning a constant', `const INITIAL = { ${BODY} };\nconst [form, setForm] = useState(() => INITIAL);`],
    ['useReducer with an inline initial state', `const [state, dispatch] = useReducer(reducer, { ${BODY} });`],
    ['useReducer with a named initial state', `const INITIAL = { ${BODY} };\nconst [state, dispatch] = useReducer(reducer, INITIAL);`],
  ])('covers every key with %s', (_label, src) => {
    expect(missing(src)).toEqual([]);
  });

  it('control: a key the initial state genuinely lacks is still reported missing', () => {
    const src = `const INITIAL: SurveyState = { name: '', email: '', followUpDate: '', satisfaction: 0, features: [] };\nconst [data, setData] = useState<SurveyState>(INITIAL);`;
    expect(missing(src)).toEqual(['comments']);
  });

  it('reads top-level keys only: a nested object or a brace inside a string adds nothing and ends nothing early', () => {
    const src = `const INITIAL = { name: '}', meta: { comments: 'x' }, email: '' };\nconst [data, setData] = useState(INITIAL);`;
    const keys = collectStateKeys(src);
    expect(keys.has('name')).toBe(true);
    expect(keys.has('email')).toBe(true);
    expect(keys.has('meta')).toBe(true);
  });

  it('an identifier with no object-literal declaration in the file contributes no keys', () => {
    expect(missing(`const [data, setData] = useState(loadFromProps(props));`)).toEqual(KEYS);
  });
});
