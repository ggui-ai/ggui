import { describe, it, expect } from 'vitest';
import { compileUi, validateUi, classifyUiSource, contentHash, UiValidationError } from './ui-compiler.js';
import type { UiManifest } from '@ggui-ai/project-config';

const MINIMAL_MANIFEST: UiManifest = {
  id: 'test-component',
  name: 'Test Component',
  contract: {},
};

const VALID_SANDBOXED = `
import { useState } from 'react';
import { Container, Text, Button } from '@ggui-ai/design/primitives';

interface Props { title: string; onSubmit: (data: { clicked: boolean }) => void }

export default function TestComponent({ title, onSubmit }: Props) {
  const [clicked, setClicked] = useState(false);
  return (
    <Container>
      <Text>{title}</Text>
      <Button aria-label="Click me" onClick={() => { setClicked(true); onSubmit({ clicked: true }); }}>
        Click
      </Button>
    </Container>
  );
}
`;

const VALID_FULLSTACK = `
import { useState } from 'react';
import { Container, Text } from '@ggui-ai/design/primitives';
import { useAction } from '@ggui-ai/wire';

export default function FullstackComponent() {
  const submit = useAction('submit');
  return <Container><Text>Fullstack</Text></Container>;
}
`;

const INVALID_EVAL = `
import { Container } from '@ggui-ai/design/primitives';
export default function Bad() {
  eval('alert("xss")');
  return <Container>bad</Container>;
}
`;

const INVALID_NO_EXPORT = `
import { Container } from '@ggui-ai/design/primitives';
function NoExport() {
  return <Container>no export</Container>;
}
`;

describe('classifyUiSource', () => {
  it('classifies pure design imports as sandboxed', () => {
    expect(classifyUiSource(VALID_SANDBOXED)).toBe('sandboxed');
  });

  it('classifies @ggui-ai/wire imports as fullstack', () => {
    expect(classifyUiSource(VALID_FULLSTACK)).toBe('fullstack');
  });

  it('classifies @app/components imports as fullstack', () => {
    const src = `import { MyWidget } from '@app/components';\nexport default function F() { return <MyWidget />; }`;
    expect(classifyUiSource(src)).toBe('fullstack');
  });
});

describe('contentHash', () => {
  it('produces consistent 16-char hex hash', () => {
    const hash = contentHash('console.log("hello");');
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('different input produces different hash', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('validateUi', () => {
  it('passes valid sandboxed component', () => {
    const result = validateUi(VALID_SANDBOXED);
    expect(result.valid).toBe(true);
    expect(result.uiClass).toBe('sandboxed');
  });

  it('rejects eval()', () => {
    const result = validateUi(INVALID_EVAL);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'security')).toBe(true);
  });

  it('rejects missing default export', () => {
    const result = validateUi(INVALID_NO_EXPORT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'structure')).toBe(true);
  });
});

describe('compileUi', () => {
  it('compiles valid sandboxed component', async () => {
    const result = await compileUi(VALID_SANDBOXED, MINIMAL_MANIFEST);
    expect(result.compiledCode).toBeTruthy();
    expect(result.contentHash).toMatch(/^[a-f0-9]{16}$/);
    expect(result.uiClass).toBe('sandboxed');
    expect(result.validation.valid).toBe(true);
  });

  it('throws UiValidationError for invalid code', async () => {
    await expect(compileUi(INVALID_EVAL, MINIMAL_MANIFEST)).rejects.toThrow(UiValidationError);
  });

  it('produces deterministic hash for same source', async () => {
    const r1 = await compileUi(VALID_SANDBOXED, MINIMAL_MANIFEST);
    const r2 = await compileUi(VALID_SANDBOXED, MINIMAL_MANIFEST);
    expect(r1.contentHash).toBe(r2.contentHash);
  });
});
