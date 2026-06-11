import { describe, it, expect } from 'vitest';
import {
  getEvaluatorSystemPrompt,
  buildEvaluatorPrompt,
  buildFixPrompt,
} from '../prompts';
import type { EvaluationContext, EvaluationResult } from '../types';

// ========================================================================
// getEvaluatorSystemPrompt
// ========================================================================

describe('getEvaluatorSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = getEvaluatorSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('mentions all 5 dimensions', () => {
    const prompt = getEvaluatorSystemPrompt();
    // Dimensions should appear as bullet list items
    expect(prompt).toMatch(/- \*\*Completeness\*\*/);
    expect(prompt).toMatch(/- \*\*Visual Polish\*\*/);
    expect(prompt).toMatch(/- \*\*Interactivity\*\*/);
    expect(prompt).toMatch(/- \*\*Accessibility\*\*/);
    expect(prompt).toMatch(/- \*\*Code Quality\*\*/);
  });

  it('references the evaluate_score tool', () => {
    const prompt = getEvaluatorSystemPrompt();
    expect(prompt).toContain('evaluate_score');
  });

  it('includes scoring guidelines with threshold ranges', () => {
    const prompt = getEvaluatorSystemPrompt();
    // Should have ranges defined (not just random mentions of numbers)
    expect(prompt).toMatch(/90-100.*Excellent/i);
    expect(prompt).toMatch(/70-89.*Good/i);
    expect(prompt).toMatch(/50-69.*Needs work/i);
  });

  it('defines severity levels for issues', () => {
    const prompt = getEvaluatorSystemPrompt();
    expect(prompt).toMatch(/Critical.*missing core features|broken/i);
    expect(prompt).toMatch(/Major.*accessibility|layout/i);
    expect(prompt).toMatch(/Minor.*style|naming/i);
  });
});

// ========================================================================
// buildEvaluatorPrompt
// ========================================================================

describe('buildEvaluatorPrompt', () => {
  const baseContext: EvaluationContext = {
    sourceCode: 'export default function GeneratedComponent() { return <div>Hello</div>; }',
    compiledCode: 'import{jsx}from"react/jsx-runtime";export default function GeneratedComponent(){return jsx("div",{children:"Hello"})}',
    originalPrompt: 'A greeting component that says Hello',
    themeTokens: 'var(--ggui-color-primary-600, #0284c7)',
  };

  it('includes the original prompt in its own section', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    // Prompt should appear under a header, not just anywhere
    expect(prompt).toMatch(/### Original User Prompt\n.*A greeting component that says Hello/s);
  });

  it('wraps source code in a TSX fenced code block', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    // Source code must be in a tsx code fence
    expect(prompt).toMatch(/```tsx\n.*GeneratedComponent.*\n```/s);
  });

  it('wraps compiled code in a JavaScript fenced code block', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    expect(prompt).toMatch(/```javascript\n.*jsx-runtime.*\n```/s);
  });

  it('includes theme tokens', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    expect(prompt).toContain('--ggui-color-primary-600');
  });

  it('includes DESIGN.md section with content when provided', () => {
    const context: EvaluationContext = {
      ...baseContext,
      designContext: '# Design Language\n\nClean, minimal, professional.',
    };
    const prompt = buildEvaluatorPrompt(context);
    // DESIGN.md should appear as a section header with content inside
    expect(prompt).toMatch(/### DESIGN\.md\n.*Clean, minimal, professional\./s);
  });

  it('omits DESIGN.md section entirely when not provided', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    expect(prompt).not.toContain('DESIGN.md');
  });

  it('instructs to call evaluate_score at the end', () => {
    const prompt = buildEvaluatorPrompt(baseContext);
    // Instructions should appear after the code blocks
    const codeBlockEnd = prompt.lastIndexOf('```');
    const evalInstruction = prompt.indexOf('evaluate_score', codeBlockEnd);
    expect(evalInstruction).toBeGreaterThan(codeBlockEnd);
  });

  it('sections appear in logical order: prompt → context → code → instructions', () => {
    const context: EvaluationContext = {
      ...baseContext,
      designContext: '# Some design',
    };
    const prompt = buildEvaluatorPrompt(context);

    const promptIdx = prompt.indexOf('Original User Prompt');
    const designIdx = prompt.indexOf('### DESIGN.md');
    const sourceIdx = prompt.indexOf('### Source Code (TSX)');
    const compiledIdx = prompt.indexOf('### Compiled Code (JS)');
    const evalIdx = prompt.lastIndexOf('evaluate_score');

    expect(promptIdx).toBeLessThan(designIdx);
    expect(designIdx).toBeLessThan(sourceIdx);
    expect(sourceIdx).toBeLessThan(compiledIdx);
    expect(compiledIdx).toBeLessThan(evalIdx);
  });
});

// ========================================================================
// buildFixPrompt
// ========================================================================

describe('buildFixPrompt', () => {
  const failingResult: EvaluationResult = {
    passed: false,
    finalScore: 55,
    dimensions: {
      completeness: 40,
      visualPolish: 60,
      interactivity: 50,
      accessibility: 65,
      codeQuality: 60,
    },
    issues: [
      { dimension: 'completeness', description: 'Missing submit button', severity: 'critical', fix: 'Add a submit button' },
      { dimension: 'accessibility', description: 'No ARIA labels on inputs', severity: 'major', fix: 'Add aria-label attributes' },
      { dimension: 'codeQuality', description: 'Unused import', severity: 'minor', fix: 'Remove unused import' },
      { dimension: 'completeness', description: 'Missing email validation', severity: 'major', fix: 'Add email format validation' },
    ],
    critique: 'The component is incomplete and has accessibility issues.',
  };

  it('shows score and threshold in the header', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    expect(prompt).toMatch(/\*\*55\/100\*\*.*threshold: 70/s);
  });

  it('renders all dimension scores in a markdown table', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    // Verify it's actually a table (has header row with pipes)
    expect(prompt).toMatch(/\| Dimension \| Score \|/);
    expect(prompt).toMatch(/\|[-]+\|[-]+\|/);
    // Verify each dimension and score appears in a table row
    expect(prompt).toMatch(/\| Completeness \| 40 \|/);
    expect(prompt).toMatch(/\| Visual Polish \| 60 \|/);
    expect(prompt).toMatch(/\| Interactivity \| 50 \|/);
    expect(prompt).toMatch(/\| Accessibility \| 65 \|/);
    expect(prompt).toMatch(/\| Code Quality \| 60 \|/);
  });

  it('groups issues by severity with critical first', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');

    const criticalIdx = prompt.indexOf('Critical Issues');
    const majorIdx = prompt.indexOf('Major Issues');
    const minorIdx = prompt.indexOf('Minor Issues');

    expect(criticalIdx).toBeGreaterThan(-1);
    expect(majorIdx).toBeGreaterThan(-1);
    expect(minorIdx).toBeGreaterThan(-1);

    // Critical before major before minor
    expect(criticalIdx).toBeLessThan(majorIdx);
    expect(majorIdx).toBeLessThan(minorIdx);
  });

  it('includes issue descriptions and actionable fixes', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    // Each issue should have dimension tag, description, and fix
    expect(prompt).toMatch(/\[completeness\].*Missing submit button/i);
    expect(prompt).toContain('Fix: Add a submit button');
    expect(prompt).toMatch(/\[accessibility\].*No ARIA labels/i);
    expect(prompt).toContain('Fix: Add aria-label attributes');
  });

  it('includes critique when present', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    expect(prompt).toMatch(/### Overall Critique\n.*incomplete and has accessibility issues/s);
  });

  it('omits critique section entirely when not present', () => {
    const resultNoCritique: EvaluationResult = { ...failingResult, critique: undefined };
    const prompt = buildFixPrompt(resultNoCritique, 'A login form');
    expect(prompt).not.toContain('Overall Critique');
  });

  it('includes original prompt in a blockquote', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form with email and password');
    expect(prompt).toMatch(/> A login form with email and password/);
  });

  it('instructs to re-validate and re-compile after fixing', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    // Instructions should come after all issues
    const lastIssueIdx = Math.max(
      prompt.lastIndexOf('Minor Issues'),
      prompt.lastIndexOf('Major Issues'),
      prompt.lastIndexOf('Critical Issues')
    );
    const instructIdx = prompt.indexOf('### Instructions');
    expect(instructIdx).toBeGreaterThan(lastIssueIdx);
    expect(prompt).toMatch(/re-validate.*re-compile|validate.*compile/is);
  });

  it('omits severity sections with no issues', () => {
    const result: EvaluationResult = {
      passed: false,
      finalScore: 60,
      dimensions: {
        completeness: 60,
        visualPolish: 60,
        interactivity: 60,
        accessibility: 60,
        codeQuality: 60,
      },
      issues: [
        { dimension: 'accessibility', description: 'Low contrast', severity: 'major', fix: 'Increase contrast' },
      ],
    };

    const prompt = buildFixPrompt(result, 'A button');

    expect(prompt).not.toContain('Critical Issues');
    expect(prompt).toContain('Major Issues');
    expect(prompt).not.toContain('Minor Issues');
  });

  it('scores table appears before issues', () => {
    const prompt = buildFixPrompt(failingResult, 'A login form');
    const scoresIdx = prompt.indexOf('### Scores');
    const criticalIdx = prompt.indexOf('Critical Issues');
    expect(scoresIdx).toBeLessThan(criticalIdx);
  });
});
