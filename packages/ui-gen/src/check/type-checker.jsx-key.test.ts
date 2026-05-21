import { describe, it, expect } from 'vitest';
import { typecheck } from './type-checker';

/**
 * Regression guard for the classic-JSX / `@types/react` v19 `key` bug.
 *
 * v19 removed the GLOBAL `JSX` namespace (it is `React.JSX` now). The
 * generated-code type-checker runs in classic JSX mode, which resolves
 * intrinsic elements + the `key`/`ref` carve-out through the global
 * `JSX` — so it silently lost both: `<div>` degraded to `any` and every
 * keyed component (`<Card key={…}>`, even a model-defined one) failed a
 * false TS2322. The light model "recovered" by swapping the design
 * primitive for a raw `<div>`, abandoning the design system. Fixed by a
 * self-contained global `JSX` shim in the synthetic prefix.
 */
describe('type-checker — JSX key carve-out (@types/react v19 regression)', () => {
  it('accepts `key` on a model-defined component in a .map()', async () => {
    const code = `
interface FooProps { label: string; }
function Foo({ label }: FooProps) { return <span>{label}</span>; }
interface Props { items?: string[] }
export default function GeneratedComponent(props: Props) {
  return <div>{(props.items ?? []).map((it) => <Foo key={it} label={it} />)}</div>;
}
`;
    const result = await typecheck(code);
    expect(result.errors).toEqual([]);
  });

  it('accepts `key` on a design primitive in a .map()', async () => {
    const code = `
import { Stack } from '@ggui-ai/design/primitives';
interface Props { items?: string[] }
export default function GeneratedComponent(props: Props) {
  return <div>{(props.items ?? []).map((it) => <Stack key={it}>{it}</Stack>)}</div>;
}
`;
    const result = await typecheck(code);
    expect(result.errors).toEqual([]);
  });

  it('still flags a bad prop value on a design component', async () => {
    const code = `
import { Button } from '@ggui-ai/design/primitives';
export default function GeneratedComponent() {
  return <Button variant={123}>x</Button>;
}
`;
    const result = await typecheck(code);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('still flags a null-deref runtime-crash class', async () => {
    const code = `
interface Props { user?: { name: string } }
export default function GeneratedComponent(props: Props) {
  return <div>{props.user.name}</div>;
}
`;
    const result = await typecheck(code);
    expect(result.errors.some((e) => e.code === 18047 || e.code === 18048)).toBe(true);
  });
});
