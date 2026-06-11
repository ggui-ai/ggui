// packages/ui-gen/src/adapters/tools.ts
//
// SDK-agnostic tool definitions for UI generation.
// These use the same Zod schemas and handlers as the production MCP server
// but without Claude Agent SDK dependencies, making them portable across
// OpenAI, Google, and Anthropic SDKs.

import { z } from 'zod';
import * as esbuild from 'esbuild';
import { PRIMITIVES_DOCUMENTATION } from '../validation/index.js';
import {
  validateComponentDetailed,
  formatValidationResultForClaude,
} from '../validation/index.js';
import { DEFAULT_DESIGN_SYSTEM_DOCS } from '../design-system-docs.js';
import { isAllowedImport, describeAllowedImports } from '../validation/allowed-imports.js';
import type { ToolDefinition, ToolResult } from './types';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import { validateAllContracts } from '../check/index.js';
import { typecheck } from '../check/index.js';
import { lintReactHooks } from '../check/index.js';
import ts from 'typescript';
import { tryRender, generateSampleProps } from '../tools/render-check.js';

/**
 * Context for creating generator tools.
 * Allows passing app-specific component docs.
 */
export interface GeneratorToolsContext {
  /** App-specific design context (DESIGN.md content) */
  designContext?: string;
  /** App-specific reusable component documentation */
  componentContext?: string;
  /** Data contract for validation (props, stream, actions) */
  contract?: DataContract;
  /** Sample props for render smoke test (realistic data matching the contract) */
  sampleProps?: JsonObject;
}

/**
 * Create the SDK-agnostic tool definitions for UI generation.
 *
 * 6 tools matching the MCP server:
 * 1. get_primitives — available UI components
 * 2. get_design_system — CSS variable tokens
 * 3. get_app_components — app-specific reusable components
 * 4. validate_component — pre-compilation check
 * 5. self_check — typecheck + lint + render smoke test
 * 6. compile_component — TSX→JS via esbuild
 *
 * Each tool uses the exact same handlers as the production MCP server,
 * but wrapped in a provider-neutral format.
 */
export function createGeneratorTools(context: GeneratorToolsContext = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    // --- get_primitives ---
    {
      name: 'get_primitives',
      description:
        'Get the list of available ggui UI primitives (Container, Card, Stack, Button, Input, etc.) that can be used in components. Call this first to understand what components are available.',
      inputSchema: z.object({}),
      handler: async (): Promise<ToolResult> => ({
        content: [{ type: 'text', text: PRIMITIVES_DOCUMENTATION }],
      }),
    },

    // --- get_design_system ---
    {
      name: 'get_design_system',
      description:
        'Get the design system tokens and CSS variables for this app. Use these CSS variables (var(--ggui-*)) for colors, spacing, typography, etc.',
      inputSchema: z.object({}),
      handler: async (): Promise<ToolResult> => ({
        content: [{
          type: 'text',
          text: context.designContext
            ? `# App Theme Configuration\n\n${context.designContext}\n\n**IMPORTANT:** Always use CSS variables (var(--ggui-*)) for colors, spacing, etc.`
            : DEFAULT_DESIGN_SYSTEM_DOCS,
        }],
      }),
    },

    // --- get_app_components ---
    {
      name: 'get_app_components',
      description:
        'Get predefined reusable components specific to this app. These can be imported and used in your generated component.',
      inputSchema: z.object({}),
      handler: async (): Promise<ToolResult> => ({
        content: [{
          type: 'text',
          text: context.componentContext || 'No predefined components available for this app.',
        }],
      }),
    },

    // --- validate_component ---
    {
      name: 'validate_component',
      description:
        'Validate component code before compilation. Checks for security issues, syntax errors, and best practices. Returns detailed feedback.',
      inputSchema: z.object({
        code: z.string().describe('The TypeScript/TSX component code to validate'),
      }),
      handler: async (args): Promise<ToolResult> => {
        const result = validateComponentDetailed(args.code as string);
        return {
          content: [
            {
              type: 'text',
              text: formatValidationResultForClaude(result),
            },
          ],
          isError: !result.valid,
        };
      },
    },

    // --- self_check ---
    {
      name: 'self_check',
      description:
        'Run deterministic quality checks on your code BEFORE compiling. Catches common issues instantly (zero cost). Returns pass/fail per check with line numbers and fix instructions. Call this after writing code, fix any failures, then compile.',
      inputSchema: z.object({
        code: z.string().describe('The TypeScript/TSX component code to check'),
      }),
      handler: async (args): Promise<ToolResult> => {
        const code = args.code as string;
        const { issues, typeWarnings } = await runSelfChecks(code, context.contract);

        // Contract validation — check props, stream, actions conformance
        if (context.contract) {
          const contractIssues = validateAllContracts(code, context.contract);
          for (const ci of contractIssues) {
            issues.push({
              check: `contract:${ci.field}`,
              line: 0,
              message: `[${ci.severity}] ${ci.message}`,
              fix: ci.fix,
            });
          }
        }

        if (issues.length === 0) {
          const warningText = typeWarnings.length > 0
            ? `\n\nType warnings (non-blocking):\n${typeWarnings.map(w => `[${w.check}] ${w.line ? `Line ${w.line}: ` : ''}${w.message}`).join('\n')}`
            : '';
          return {
            content: [{ type: 'text', text: `All checks passed. Ready to compile.${warningText}` }],
          };
        }

        const report = issues.map((i) => `[${i.check}] ${i.line ? `Line ${i.line}: ` : ''}${i.message}\n  Fix: ${i.fix}`).join('\n\n');
        return {
          content: [{ type: 'text', text: `${issues.length} issue(s) found:\n\n${report}` }],
          isError: true,
        };
      },
    },

    // --- compile_component ---
    {
      name: 'compile_component',
      description:
        'Compile a TypeScript/TSX component to JavaScript using esbuild. Returns the compiled code ready for browser execution. On failure, returns detailed error context with line numbers and fix suggestions.',
      inputSchema: z.object({
        code: z.string().describe('The TypeScript/TSX component code to compile'),
        filename: z
          .string()
          .default('Component.tsx')
          .describe('Filename for error messages'),
      }),
      handler: async (args): Promise<ToolResult> => {
        const code = args.code as string;
        const filename = (args.filename as string) || 'Component.tsx';

        // Run self-checks first (catches hex colors, raw pixels, forbidden imports, etc.)
        const { issues: selfCheckIssues } = await runSelfChecks(code, context.contract);

        // Contract validation
        if (context.contract) {
          const contractIssues = validateAllContracts(code, context.contract);
          for (const ci of contractIssues) {
            selfCheckIssues.push({
              check: `contract:${ci.field}`,
              line: 0,
              message: `[${ci.severity}] ${ci.message}`,
              fix: ci.fix,
            });
          }
        }

        if (selfCheckIssues.length > 0) {
          const report = selfCheckIssues.map((i) => `[${i.check}] ${i.line ? `Line ${i.line}: ` : ''}${i.message}\n  Fix: ${i.fix}`).join('\n\n');
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: false,
                phase: 'self_check',
                error: `${selfCheckIssues.length} issue(s) found — fix these before recompiling:\n\n${report}`,
              }, null, 2),
            }],
            isError: true,
          };
        }

        // Run validation first
        const validation = validateComponentDetailed(code);
        if (!validation.valid) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    phase: 'validation',
                    error: formatValidationResultForClaude(validation),
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        try {
          const result = await esbuild.transform(code, {
            loader: 'tsx',
            target: 'es2020',
            format: 'esm',
            jsx: 'automatic',
            jsxImportSource: 'react',
            minify: true,
            sourcefile: filename,
          });

          const warnings = [
            ...result.warnings.map((w) => w.text),
            ...validation.warnings.map(
              (w: { type: string; message: string; suggestion: string }) =>
                `[${w.type}] ${w.message}: ${w.suggestion}`
            ),
          ];

          // Post-compilation: validate all contract (hard gate for errors)
          if (context.contract) {
            const contractIssues = validateAllContracts(code, context.contract);
            const errors = contractIssues.filter((i) => i.severity === 'error');
            const contractWarnings = contractIssues.filter((i) => i.severity === 'warning');

            if (errors.length > 0) {
              const report = errors
                .map((i) => `- [${i.field}] ${i.message}\n  Fix: ${i.fix}`)
                .join('\n');
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    success: false,
                    phase: 'contract_validation',
                    error: `Compilation succeeded but data contract validation failed:\n\n${report}\n\nFix the Props interface to match the data contract, then recompile.`,
                  }, null, 2),
                }],
                isError: true,
              };
            }

            warnings.push(...contractWarnings.map((i) => `[contract:${i.field}] ${i.message}`));
          }

          // Render smoke test — catches runtime errors tsc misses
          // Prefer explicit sampleProps (realistic data), fall back to contract-derived
          const sampleProps = context.sampleProps
            ?? (context.contract?.propsSpec ? generateSampleProps(context.contract.propsSpec) : undefined);
          const renderError = await tryRender(result.code, code, sampleProps);
          if (renderError) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  phase: 'render_smoke_test',
                  compiledCode: result.code,
                  error: `${renderError}\n\nThe component compiled but crashes at runtime. Fix the null/undefined access and recompile.`,
                  warnings,
                }, null, 2),
              }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    compiledCode: result.code,
                    warnings,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { success: false, phase: 'compilation', error: formatEsbuildError(error, code) },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
      },
    },
  ];

  return tools;
}

/**
 * Format an esbuild error into a readable error message with code context.
 */
function formatEsbuildError(error: unknown, sourceCode: string): string {
  const parts: string[] = [];

  if (
    error &&
    typeof error === 'object' &&
    'errors' in error &&
    Array.isArray((error as { errors: unknown[] }).errors)
  ) {
    const esbuildError = error as esbuild.TransformFailure;
    for (const err of esbuildError.errors) {
      const line = err.location?.line;
      const col = err.location?.column;
      parts.push(`**Error:** ${err.text}`);
      if (line) {
        parts.push(`**Location:** Line ${line}, Column ${col ?? 0}`);
        const lines = sourceCode.split('\n');
        const start = Math.max(0, line - 3);
        const end = Math.min(lines.length, line + 2);
        const context = lines
          .slice(start, end)
          .map((l, i) => {
            const ln = start + i + 1;
            return `${ln === line ? '>>> ' : '    '}${ln} | ${l}`;
          })
          .join('\n');
        parts.push(`**Code:**\n\`\`\`\n${context}\n\`\`\``);
      }
    }
  } else {
    parts.push(`**Error:** ${error instanceof Error ? error.message : 'Compilation failed'}`);
  }

  parts.push('\n**How to fix:** Review the error above, fix the code, then call compile_component again.');
  return parts.join('\n');
}

// =============================================================================
// Self-Check: Deterministic Quality Checks
// =============================================================================

export interface SelfCheckIssue {
  check: string;
  line: number;
  message: string;
  fix: string;
}

// =============================================================================
// AST-Based React Rules Checker
// =============================================================================

// Form components that require a label or aria-label prop for accessibility.
const LABELED_COMPONENTS = new Set(['Input', 'TextArea', 'Select']);

/**
 * AST-based JSX prop checker.
 * Parses TSX with TypeScript compiler to verify required props on form elements.
 * React hooks rules are handled by eslint-plugin-react-hooks (see react-linter.ts).
 */
function checkReactRules(code: string): SelfCheckIssue[] {
  const sf = ts.createSourceFile('component.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues: SelfCheckIssue[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName.getText(sf);
      if (LABELED_COMPONENTS.has(tagName)) {
        const propNames = new Set<string>();
        let hasSpread = false;
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr)) {
            propNames.add(attr.name.getText(sf));
          } else if (ts.isJsxSpreadAttribute(attr)) {
            hasSpread = true;
          }
        }
        if (!hasSpread && !propNames.has('label') && !propNames.has('aria-label')) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          issues.push({
            check: 'accessibility',
            line,
            message: `${tagName} missing label prop`,
            fix: `Add label="..." prop directly on the ${tagName} component. The label prop is built into the primitive.`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return issues;
}

/**
 * Run deterministic quality checks on component source code.
 * Returns actionable issues with line numbers and fix instructions.
 *
 * `contract` (optional) feeds the import allowlist: generated
 * code direct-imports gadget exports, so every gadget package the
 * contract declares is a permitted import source.
 */
export async function runSelfChecks(
  code: string,
  contract?: DataContract,
): Promise<{ issues: SelfCheckIssue[]; typeWarnings: SelfCheckIssue[] }> {
  const issues: SelfCheckIssue[] = [];
  const lines = code.split('\n');
  // Gadget packages the contract declares are import-allowlisted.
  // `clientCapabilities.gadgets` is package-keyed, so the map's
  // own keys ARE the allowlisted import sources.
  const allowedGadgetPackages = new Set<string>(
    Object.keys(contract?.clientCapabilities?.gadgets ?? {}),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check: hardcoded hex colors
    const hexMatch = line.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hexMatch && !line.includes('var(--ggui-') && !line.includes('// fallback')) {
      issues.push({
        check: 'hex-color',
        line: lineNum,
        message: `Hardcoded color "${hexMatch[0]}" — must use design tokens`,
        fix: `Replace with var(--ggui-color-*, ${hexMatch[0]})`,
      });
    }

    // Check: rgba()/hsl() hardcoded color functions
    const colorFnMatch = line.match(/\b(rgba?|hsla?)\s*\(/);
    if (colorFnMatch && !line.includes('var(--ggui-') && !line.includes('// fallback') && !line.includes('$value')) {
      issues.push({
        check: 'hardcoded-color-fn',
        line: lineNum,
        message: `Hardcoded ${colorFnMatch[1]}() — use design tokens instead`,
        fix: `Replace with semantic tokens: var(--ggui-color-surface), var(--ggui-color-onSurface), var(--ggui-color-outline), etc.`,
      });
    }

    // Check: neutral-50/900 used for background/text — suggest semantic tokens
    if (/--ggui-color-neutral-50[^0-9]/.test(line) && /background/i.test(line)) {
      issues.push({
        check: 'prefer-semantic',
        line: lineNum,
        message: `neutral-50 for background — prefer semantic token for dark-theme compatibility`,
        fix: `Replace with var(--ggui-color-surface) or var(--ggui-color-surfaceVariant)`,
      });
    }
    if (/--ggui-color-neutral-900[^0-9]/.test(line) && /color/i.test(line) && !/background/i.test(line)) {
      issues.push({
        check: 'prefer-semantic',
        line: lineNum,
        message: `neutral-900 for text color — prefer semantic token for dark-theme compatibility`,
        fix: `Replace with var(--ggui-color-onSurface) or var(--ggui-color-onSurfaceVariant)`,
      });
    }

    // Check: raw pixel values in padding/margin/gap (not in var() or calc())
    const pxMatch = line.match(/(?:padding|margin|gap|borderRadius)\s*:\s*['"]?\d+px/);
    if (pxMatch && !line.includes('var(--ggui-')) {
      issues.push({
        check: 'raw-pixels',
        line: lineNum,
        message: `Raw pixel value in spacing — must use design tokens`,
        fix: `Replace with var(--ggui-spacing-*, fallback)`,
      });
    }

    // Check: forbidden APIs
    if (/\beval\s*\(/.test(line)) {
      issues.push({ check: 'security', line: lineNum, message: 'eval() is forbidden', fix: 'Remove eval() call entirely' });
    }
    if (/\bfetch\s*\(/.test(line)) {
      issues.push({ check: 'security', line: lineNum, message: 'fetch() is forbidden — use props for data', fix: 'Remove fetch() and pass data via props' });
    }

    // Check: forbidden imports
    const importMatch = line.match(/import\s+.*from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const pkg = importMatch[1];
      // Import allowlist — single source of truth in
      // `validation/allowed-imports.ts`. Generated code
      // direct-imports gadget exports, so every gadget package the
      // contract declares is allowlisted alongside STDLIB `@ggui-ai/gadgets`.
      if (!isAllowedImport(pkg, allowedGadgetPackages)) {
        issues.push({
          check: 'import',
          line: lineNum,
          message: `Import from "${pkg}" is not allowed`,
          fix: `Only import from: ${describeAllowedImports()}`,
        });
      }
    }

    // NOTE: Input/TextArea/Select label checks moved to AST-based checkJsxProps() below
  }

  // ── AST-based JSX prop checks ──────────────────────────
  // Uses TypeScript compiler to parse JSX — handles multi-line, spread props, etc.
  try {
    const jsxIssues = checkReactRules(code);
    issues.push(...jsxIssues);
  } catch {
    // Parsing may fail on malformed code — fall through to other checks
  }

  // Check: no Props interface
  if (!code.includes('interface Props') && !code.includes('type Props')) {
    issues.push({
      check: 'props-interface',
      line: 1,
      message: 'No Props interface found — data is likely hardcoded',
      fix: 'Add interface Props { ... } with typed fields and default values in the function signature',
    });
  }

  // Check: no default export
  if (!code.includes('export default function')) {
    issues.push({
      check: 'export',
      line: 1,
      message: 'Missing default export function',
      fix: 'Add export default function GeneratedComponent(props: Props) { ... }',
    });
  }

  const typeWarnings: SelfCheckIssue[] = [];

  // Run TS type-checker + React hooks linter in parallel
  const [typeResult, reactResult] = await Promise.all([
    typecheck(code).catch((err) => {
      console.warn('[runSelfChecks] TypeChecker failed:', err instanceof Error ? err.message : String(err));
      return null;
    }),
    lintReactHooks(code).catch((err) => {
      console.warn('[runSelfChecks] React linter failed:', err instanceof Error ? err.message : String(err));
      return [] as import('../check/index.js').ReactLintDiagnostic[];
    }),
  ]);

  // TS type errors
  if (typeResult) {
    for (const error of typeResult.errors) {
      issues.push({
        check: `ts${error.code}`,
        line: error.line,
        message: error.message,
        fix: error.fix,
      });
    }
    for (const warning of typeResult.warnings) {
      typeWarnings.push({
        check: `ts${warning.code}`,
        line: warning.line,
        message: warning.message,
        fix: warning.fix,
      });
    }
  }

  // React hooks violations. Errors (rules-of-hooks, jsx-no-undef, direct-
  // mutation) always block. exhaustive-deps warnings are usually advisory —
  // except when the effect body mutates state (setState / setX / dispatch),
  // in which case a missing dep is a near-certain infinite-render loop once
  // the component renders at runtime. The happy-dom probe catches this only
  // AFTER burning CPU; we'd rather fail preflight.
  //
  // Narrow promotion heuristic: file has a setter-like call AND diagnostic
  // message indicates a missing-dep / unstable-ref class. Inline-object
  // warnings on effects that DON'T mutate state stay advisory to avoid
  // over-constraining.
  const hasStateSetter = /\b(set[A-Z]\w*|dispatch)\s*\(/.test(code);
  const isSetterLoopRisk = (diag: { rule: string; message: string }): boolean => {
    if (diag.rule !== 'react-hooks/exhaustive-deps') return false;
    if (!hasStateSetter) return false;
    // eslint-plugin-react-hooks message shapes for the loop-risk class:
    //   "React Hook useEffect has a missing dependency: 'x'. Either include it..."
    //   "The 'x' object / 'x' array makes the dependencies of useEffect Hook
    //    change on every render."
    return /missing dependenc|changes on every render|object makes the dependencies|array makes the dependencies/i.test(
      diag.message,
    );
  };

  for (const diag of reactResult) {
    const blocking = diag.severity === 'error' || isSetterLoopRisk(diag);
    if (blocking) {
      issues.push({
        check: diag.rule,
        line: diag.line,
        message: isSetterLoopRisk(diag)
          ? `${diag.message} (promoted to error: effect mutates state — missing/unstable deps cause infinite render loops)`
          : diag.message,
        fix: diag.fix,
      });
    } else {
      typeWarnings.push({
        check: diag.rule,
        line: diag.line,
        message: diag.message,
        fix: diag.fix,
      });
    }
  }

  // Merge overlapping issues: when multiple checkers flag the same line,
  // combine into one issue with the clearest actionable message.
  // e.g. AST says "Input missing label prop" + TS says "ts2786 type mismatch"
  // → single issue: "Input missing label prop [also: ts2786]"
  const lineMap = new Map<number, SelfCheckIssue[]>();
  for (const i of issues) {
    const list = lineMap.get(i.line) ?? [];
    list.push(i);
    lineMap.set(i.line, list);
  }

  const deduped: SelfCheckIssue[] = [];
  for (const [, group] of lineMap) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    // Prefer the non-TS issue (AST/ESLint) as primary — it's more actionable
    const primary = group.find(i => !i.check.startsWith('ts')) ?? group[0];
    const others = group.filter(i => i !== primary);
    if (others.length > 0) {
      const alsoTags = others.map(o => o.check).join(', ');
      deduped.push({
        ...primary,
        message: `${primary.message} [also flagged by: ${alsoTags}]`,
      });
    } else {
      deduped.push(primary);
    }
  }

  return { issues: deduped, typeWarnings };
}
