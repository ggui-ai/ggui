import { describe, it, expect } from 'vitest';
import { tryRender, generateSampleProps } from './render-check';
import * as esbuild from 'esbuild';
import type { PropsSpec } from '@ggui-ai/protocol';

describe('tryRender — render smoke test', () => {
  async function compile(code: string) {
    const result = await esbuild.transform(code, {
      loader: 'tsx',
      target: 'es2020',
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'react',
      sourcefile: 'Component.tsx',
    });
    return result.code;
  }

  it('passes for valid component with defaults', async () => {
    const source = `
      import React from 'react';
      interface Props { name?: string; }
      export default function Hello({ name = "World" }: Props) {
        return <div>Hello {name}</div>;
      }
    `;
    const compiled = await compile(source);
    const error = await tryRender(compiled, source);
    expect(error).toBeNull();
  });

  it('catches undefined.toLowerCase()', async () => {
    const source = `
      import React from 'react';
      interface Props { value?: string; }
      export default function Broken({ value }: Props) {
        return <div>{value.toLowerCase()}</div>;
      }
    `;
    const compiled = await compile(source);
    const error = await tryRender(compiled, source);
    expect(error).toBeTruthy();
    expect(error).toContain('undefined');
  });

  it('passes for component using design primitives', async () => {
    const source = `
      import React from 'react';
      import { Card, Text, Button } from '@ggui-ai/design/primitives';
      interface Props { title?: string; }
      export default function Hello({ title = "Hi" }: Props) {
        return <Card><Text>{title}</Text><Button>Click</Button></Card>;
      }
    `;
    const compiled = await compile(source);
    const error = await tryRender(compiled, source);
    expect(error).toBeNull();
  });

  it('renders with sample props from contract', async () => {
    const source = `
      import React from 'react';
      interface Props { city: string; temperature: number; }
      export default function Weather({ city, temperature }: Props) {
        return <div>{city}: {temperature}°C</div>;
      }
    `;
    const compiled = await compile(source);

    const spec: PropsSpec = {
      properties: {
        city: { schema: { type: 'string' }, required: true, example: 'Tokyo' },
        temperature: { schema: { type: 'number' }, required: true, example: 22 },
      },
    };

    // With sample props — should pass (no undefined access)
    const sampleProps = generateSampleProps(spec);
    expect(sampleProps).toEqual({ city: 'Tokyo', temperature: 22 });

    const error = await tryRender(compiled, source, sampleProps);
    expect(error).toBeNull();
  });

  it('catches error with sample props when prop is accessed without guard', async () => {
    const source = `
      import React from 'react';
      interface Props { items: Array<{ name: string }>; }
      export default function List({ items }: Props) {
        return <div>{items.map(i => <span key={i.name}>{i.name}</span>)}</div>;
      }
    `;
    const compiled = await compile(source);

    // Without sample props — items is undefined, .map() crashes
    const error = await tryRender(compiled, source);
    expect(error).toBeTruthy();
    expect(error).toContain('undefined');

    // With sample props from contract — should pass
    const spec: PropsSpec = {
      properties: {
        items: {
          schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
          required: true,
          example: [{ name: 'Item 1' }],
        },
      },
    };
    const sampleProps = generateSampleProps(spec);
    const errorWithProps = await tryRender(compiled, source, sampleProps);
    expect(errorWithProps).toBeNull();
  });
});

describe('generateSampleProps', () => {
  it('uses example values when available', () => {
    const spec: PropsSpec = {
      properties: {
        city: { schema: { type: 'string' }, example: 'Tokyo' },
        temp: { schema: { type: 'number' }, example: 22 },
      },
    };
    expect(generateSampleProps(spec)).toEqual({ city: 'Tokyo', temp: 22 });
  });

  it('uses default values as fallback', () => {
    const spec: PropsSpec = {
      properties: {
        name: { schema: { type: 'string' }, default: 'World' },
      },
    };
    expect(generateSampleProps(spec)).toEqual({ name: 'World' });
  });

  it('synthesizes from schema when no example or default', () => {
    const spec: PropsSpec = {
      properties: {
        name: { schema: { type: 'string' } },
        count: { schema: { type: 'number' } },
        active: { schema: { type: 'boolean' } },
        tags: { schema: { type: 'array', items: { type: 'string' } } },
      },
    };
    const result = generateSampleProps(spec);
    expect(typeof result.name).toBe('string');
    expect(typeof result.count).toBe('number');
    expect(typeof result.active).toBe('boolean');
    expect(Array.isArray(result.tags)).toBe(true);
  });
});
