// core/src/adapters/tools.test.ts
//
// Integration tests for `createGeneratorTools` — drive the handlers for
// `self_check` and `compile_component` end-to-end so that regressions
// in the tool payload shape or error wiring surface without needing a
// live SDK.
//
// Relocated from `core/src/tools/type-checker.test.ts` as part of
// the OSS tier-0 CHECK migration. The
// companion unit tests for `typecheck` itself moved to
// `packages/ui-gen/src/check/type-checker.test.ts` alongside the
// migrated module; this file keeps the handler-level coverage in core
// where `createGeneratorTools` lives.

import { describe, it, expect } from 'vitest';
import { createGeneratorTools } from './tools';

describe('createGeneratorTools — E2E through tool handlers', () => {
  it('self_check reports type errors from tsc', async () => {
    const tools = createGeneratorTools();
    const selfCheck = tools.find(t => t.name === 'self_check')!;
    const result = await selfCheck.handler({
      code: `
        import React from 'react';
        import { Nonexistent } from '@ggui-ai/design/primitives';
        interface Props {}
        export default function GeneratedComponent({}: Props) {
          return <div/>;
        }
      `,
    });
    expect(result.isError).toBe(true);
    // Should mention the type error (ts2305 — module has no exported member)
    expect(result.content[0].text).toMatch(/ts230[457]/);
  });

  it('self_check passes valid typed code', async () => {
    const tools = createGeneratorTools();
    const selfCheck = tools.find(t => t.name === 'self_check')!;
    const result = await selfCheck.handler({
      code: `
        import React, { useState } from 'react';
        import { Card, Text, Button } from '@ggui-ai/design/primitives';
        interface Props { title?: string; }
        export default function GeneratedComponent({ title = "Hello" }: Props) {
          const [count, setCount] = useState(0);
          return (
            <Card>
              <Text>{title}: {count}</Text>
              <Button onClick={() => setCount(count + 1)}>+1</Button>
            </Card>
          );
        }
      `,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('All checks passed');
  });

  it('compile_component blocks on type errors', async () => {
    const tools = createGeneratorTools();
    const compile = tools.find(t => t.name === 'compile_component')!;
    const result = await compile.handler({
      code: `
        import React from 'react';
        import { FakeComponent } from '@ggui-ai/design/primitives';
        interface Props { label?: string; }
        export default function GeneratedComponent({ label = "Go" }: Props) {
          return <FakeComponent>{label}</FakeComponent>;
        }
      `,
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
  });

  it('compile_component succeeds with valid typed code', async () => {
    const tools = createGeneratorTools();
    const compile = tools.find(t => t.name === 'compile_component')!;
    const result = await compile.handler({
      code: `
        import React, { useState } from 'react';
        import { Card, Text, Button } from '@ggui-ai/design/primitives';
        interface Props { title?: string; }
        export default function GeneratedComponent({ title = "Hello" }: Props) {
          const [count, setCount] = useState(0);
          return (
            <Card>
              <Text>{title}: {count}</Text>
              <Button onClick={() => setCount(count + 1)}>+1</Button>
            </Card>
          );
        }
      `,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.compiledCode).toBeTruthy();
  });
});
