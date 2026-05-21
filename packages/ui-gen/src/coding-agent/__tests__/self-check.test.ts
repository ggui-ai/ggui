import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import {
  runCodingAgentSelfCheck,
  getSoftWarnings,
} from '../self-check';
import type { BuildResult } from '../types';

const CLEAN_CODE = `interface Props {
  name: string;
}

export default function MyComponent(props: Props) {
  return (
    <div style={{ color: 'var(--ggui-color-primary-600)' }}>
      <label aria-label="name">{props.name}</label>
    </div>
  );
}`;

const BUILD_OK: BuildResult = { success: true, compiledCode: 'compiled' };
const BUILD_FAIL: BuildResult = {
  success: false,
  errors: ['Unexpected token'],
};

describe('runCodingAgentSelfCheck', () => {
  it('passes with clean code and successful build', async () => {
    const result = await runCodingAgentSelfCheck(CLEAN_CODE, BUILD_OK);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails when build fails', async () => {
    const result = await runCodingAgentSelfCheck(CLEAN_CODE, BUILD_FAIL);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('builds_clean'))).toBe(
      true,
    );
  });

  it('detects eval() usage', async () => {
    const code = `export default function C(props) { eval("x"); return <div />; }`;
    const result = await runCodingAgentSelfCheck(code, BUILD_OK);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('eval'))).toBe(true);
  });

  it('detects fetch() usage', async () => {
    const code = `export default function C(props) { fetch("/api"); return <div />; }`;
    const result = await runCodingAgentSelfCheck(code, BUILD_OK);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes('fetch'))).toBe(true);
  });

  it('detects missing export default', async () => {
    const code = `function C(props) { return <div />; }`;
    const result = await runCodingAgentSelfCheck(code, BUILD_OK);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) =>
          v.includes('export') || v.includes('default') || v.includes('Export'),
      ),
    ).toBe(true);
  });

  it('detects hardcoded hex colors', async () => {
    const code = `export default function C(props) { return <div style={{ color: '#ff0000' }} />; }`;
    const result = await runCodingAgentSelfCheck(code, BUILD_OK);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some(
        (v) => v.includes('hex') || v.includes('color') || v.includes('Color'),
      ),
    ).toBe(true);
  });

  // ── Rule 14 — wire_preservation ──────────────────────────────────────
  describe('rule 14 — wire_preservation', () => {
    const CONTRACTS_WITH_SUBMIT: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
    };

    it('passes when code calls every contract-declared hook', async () => {
      const code = `interface Props { name: string; }
export default function C(props: Props) {
  const submit = useAction('submit');
  return (
    <div>
      <label aria-label="name">{props.name}</label>
      <button onClick={() => submit()}>go</button>
    </div>
  );
}`;
      const result = await runCodingAgentSelfCheck(
        code,
        BUILD_OK,
        CONTRACTS_WITH_SUBMIT,
      );
      // Note: may still have non-wire violations; the assertion we make
      // here is scoped to wire_preservation only.
      expect(
        result.violations.some((v) => v.startsWith('wire_preservation:')),
      ).toBe(false);
    });

    it('fails when a contract-declared hook is missing from the code', async () => {
      const code = `interface Props { name: string; }
export default function C(props: Props) {
  // submit was deleted — rule 14 should flag it
  return <div>{props.name}</div>;
}`;
      const result = await runCodingAgentSelfCheck(
        code,
        BUILD_OK,
        CONTRACTS_WITH_SUBMIT,
      );
      expect(result.passed).toBe(false);
      const wireViolation = result.violations.find((v) =>
        v.startsWith('wire_preservation:action:submit'),
      );
      expect(wireViolation).toBeDefined();
      expect(wireViolation).toContain("useAction('submit')");
    });

    it('variable rename still passes (wiring is the string literal)', async () => {
      const code = `interface Props { name: string; }
export default function C(props: Props) {
  const onSubmit = useAction('submit');
  return <button onClick={() => onSubmit()}>{props.name}</button>;
}`;
      const result = await runCodingAgentSelfCheck(
        code,
        BUILD_OK,
        CONTRACTS_WITH_SUBMIT,
      );
      expect(
        result.violations.some((v) => v.startsWith('wire_preservation:')),
      ).toBe(false);
    });

    it('does not fire when contract are not provided', async () => {
      const code = `interface Props { name: string; }
export default function C(props: Props) {
  return <div>{props.name}</div>;
}`;
      const result = await runCodingAgentSelfCheck(code, BUILD_OK /* no contract */);
      expect(
        result.violations.some((v) => v.startsWith('wire_preservation:')),
      ).toBe(false);
    });

    // ── Seal B: ESLint no-unused-vars catches abandoned hook bindings ──
    // Rule 14 catches DELETION (the hook call is gone). The
    // no-unused-vars rule wired into react-linter.ts catches the
    // ABANDONMENT case (hook call still present but its returned
    // binding is never consumed). Together they prove contract->code
    // completeness bidirectionally.
    it('no-unused-vars catches hook present but binding unused', async () => {
      const code = `interface Props { name: string; }
export default function C(props: Props) {
  // Hook call present — rule 14 is satisfied.
  // But the returned binding is never consumed — lint catches it.
  const submit = useAction('submit');
  return <div>{props.name}</div>;
}`;
      const result = await runCodingAgentSelfCheck(
        code,
        BUILD_OK,
        CONTRACTS_WITH_SUBMIT,
      );

      // Rule 14 should be satisfied (the hook call exists).
      expect(
        result.violations.some((v) => v.startsWith('wire_preservation:')),
      ).toBe(false);

      // But no-unused-vars should fail the attempt.
      expect(result.passed).toBe(false);
      expect(
        result.violations.some(
          (v) => v.includes('no-unused-vars') && v.includes('submit'),
        ),
      ).toBe(true);
    });
  });
});

describe('getSoftWarnings', () => {
  it('returns warning when no design tokens used', () => {
    const code = `export default function C() { return <div />; }`;
    const warnings = getSoftWarnings(code);
    expect(warnings.some((w) => w.includes('design_tokens'))).toBe(true);
  });

  it('returns warning when no aria labels present', () => {
    const code = `export default function C() { return <div />; }`;
    const warnings = getSoftWarnings(code);
    expect(warnings.some((w) => w.includes('aria_labels'))).toBe(true);
  });

  it('returns empty when both present', () => {
    const warnings = getSoftWarnings(CLEAN_CODE);
    expect(warnings).toEqual([]);
  });
});
