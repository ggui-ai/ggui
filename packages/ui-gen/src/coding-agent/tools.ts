// packages/ui-gen/src/coding-agent/tools.ts
//
// Tool schemas and executor for the coding agent.
//
// Key design: write and apply_diff include a commit_message field and
// auto-commit + auto-self-check after execution. The LLM never calls
// commit directly — it's implicit in every write/apply_diff.

import * as esbuild from 'esbuild';
import { AgentWorkspace } from './workspace';
// diff-processor imported dynamically in apply_diff case (legacy path)
import { getSoftWarnings } from './self-check';
import { runTier0Checks } from '../check/index.js';
import { PRIMITIVES_DOCUMENTATION } from '../validation/index.js';
import type { DataContract } from '@ggui-ai/protocol';
import type {
  ToolSchema,
  ToolResult,
  ToolCall,
  BatchResult,
  CommitMetadata,
} from './types';

/**
 * Extract documentation for a single component from the full primitives docs.
 * Returns ~200-500 tokens instead of 43K.
 */
function getComponentDocumentation(name: string): string {
  // The docs use "### ComponentName" as headers
  const marker = `### ${name}`;
  const startIdx = PRIMITIVES_DOCUMENTATION.indexOf(marker);
  if (startIdx === -1) {
    return `Component "${name}" not found. Available primitives: Container, Card, Stack, Row, Box, Text, Heading, Button, Input, Select, Checkbox, Toggle, Badge, Alert, Progress, Image, Icon, Divider, Tabs, Accordion, Table, Tooltip, Spinner, Avatar, Link`;
  }

  // Find the next ### (next component) to get just this one's docs
  const nextMarker = PRIMITIVES_DOCUMENTATION.indexOf('### ', startIdx + marker.length);
  const section = nextMarker === -1
    ? PRIMITIVES_DOCUMENTATION.slice(startIdx)
    : PRIMITIVES_DOCUMENTATION.slice(startIdx, nextMarker);

  // Unescape the string (it's stored with \\n)
  return section.replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 3000);
}

// =============================================================================
// Tool Schemas
// =============================================================================

const writeSchema: ToolSchema = {
  description:
    'Write the complete ui.tsx file, then auto-compile and validate. Use for initial generation or full rewrites.',
  input: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Complete TSX component source code' },
      commit_message: { type: 'string', description: 'Short description of what you wrote/changed' },
    },
    required: ['code', 'commit_message'],
  },
};

const applyDiffSchema: ToolSchema = {
  description:
    'Apply a unified diff patch to ui.tsx, then auto-compile and validate. Use for targeted fixes.',
  input: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'Unified diff format string' },
      commit_message: { type: 'string', description: 'Short description of what you fixed' },
    },
    required: ['diff', 'commit_message'],
  },
};

const catSchema: ToolSchema = {
  description: 'Read ui.tsx with line numbers. Optionally specify a line range.',
  input: {
    type: 'object',
    properties: {
      start_line: { type: 'number', description: 'Start line (1-indexed)' },
      end_line: { type: 'number', description: 'End line (inclusive)' },
    },
  },
};

const grepSchema: ToolSchema = {
  description: 'Search ui.tsx for a pattern. Returns matching lines with line numbers.',
  input: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex search pattern' },
      context: { type: 'number', description: 'Context lines around matches (default 0)' },
    },
    required: ['pattern'],
  },
};

const getComponentsInfoSchema: ToolSchema = {
  description:
    'Get detailed prop types and usage examples for design system components. Call once with all components you need before writing code.',
  input: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Component names, e.g., ["Stack", "Card", "Text", "Heading"]',
      },
    },
    required: ['names'],
  },
};

const diffSchema: ToolSchema = {
  description: 'Show uncommitted changes (working copy vs last commit).',
  input: { type: 'object', properties: {} },
};

const logSchema: ToolSchema = {
  description: 'Show commit history with OIDs and self-check status.',
  input: {
    type: 'object',
    properties: {
      depth: { type: 'number', description: 'Number of commits to show (default 10)' },
    },
  },
};

const showSchema: ToolSchema = {
  description: 'Show the diff of a specific commit (what changed).',
  input: {
    type: 'object',
    properties: {
      oid: { type: 'string', description: 'Commit OID from log output' },
    },
    required: ['oid'],
  },
};

const revertSchema: ToolSchema = {
  description: 'Revert working copy to a previous commit.',
  input: {
    type: 'object',
    properties: {
      oid: { type: 'string', description: 'Commit OID to revert to' },
    },
    required: ['oid'],
  },
};

/** Phase 1: write only (auto-commits) */
export const initialToolSchemas: Record<string, ToolSchema> = {
  write: writeSchema,
};

/** Phase 2: write + apply_diff (both auto-commit) + read-only tools */
export const fullToolSchemas: Record<string, ToolSchema> = {
  write: writeSchema,
  apply_diff: applyDiffSchema,
  get_components_info: getComponentsInfoSchema,
  cat: catSchema,
  grep: grepSchema,
  diff: diffSchema,
  log: logSchema,
  show: showSchema,
  revert: revertSchema,
};

// =============================================================================
// Auto-commit helper (shared by write and apply_diff)
// =============================================================================

async function autoCommit(
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
  message: string,
  contract?: DataContract,
  /**
   * Optional ContextPolicy — when `labeledTier0` is true, the self-check
   * violation formatter prefixes `[P0-*]` / `[P1-*]` priority tags so the
   * LLM can rank retry feedback against the prompt's P0/P1/P2 schema.
   * Defaults to unlabeled.
   */
  contextPolicy?: import("../harness/policy.js").ContextPolicy,
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * Threaded into `runTier0Checks` → `typecheck`, which overlays each
   * wrapper `.d.ts` at `node_modules/<package>/index.d.ts` so a
   * generated direct import `import { useLeafletMap } from
   * '@scope/leaflet'` resolves against the real declaration (strict
   * option/return narrowing). Without it, third-party hooks narrow to
   * `any` (no option/return typechecking). Standard-library-only
   * callers omit it; the shipped `@ggui-ai/gadgets` `.d.ts` covers the
   * stdlib hooks unconditionally.
   */
  gadgetTypes?: Readonly<Record<string, string>>,
): Promise<ToolResult> {
  const commitStart = Date.now();
  const raw = workspace.read();
  if (!raw && raw !== '') {
    return { result: 'FAILED: no file to compile', error: true };
  }

  // Temporarily disabled — testing without Prettier to confirm it's causing regressions
  // Auto-format with Prettier — normalizes line lengths and indentation
  // so the agent sees consistent formatting on next turn.
  const formatted = raw;
  // try {
  //   const prettier = await import('prettier');
  //   formatted = await prettier.format(raw, {
  //     parser: 'typescript',       // TSX is handled by the typescript parser
  //     filepath: 'ui.tsx',         // hint to Prettier that this is TSX (enables JSX formatting)
  //     printWidth: 80,             // short lines → LLM targets lines accurately
  //     tabWidth: 2,                // compact indentation
  //     semi: true,                 // explicit semicolons — less ambiguity
  //     singleQuote: true,          // consistent JS quotes
  //     jsxSingleQuote: false,      // JSX uses double quotes (React convention)
  //     trailingComma: 'all',       // reduces diff noise on additions
  //     bracketSameLine: false,     // closing > on new line → clear tag boundaries
  //     singleAttributePerLine: true, // one JSX prop per line → precise line targeting
  //     arrowParens: 'always',      // (x) => {} — consistent, less ambiguous
  //     bracketSpacing: true,       // { x } not {x} — easier to read
  //     jsxBracketSameLine: false,  // same as bracketSameLine for JSX
  //   });
  //   if (formatted !== raw) {
  //     workspace.write(formatted);
  //   }
  // } catch {
  //   // Prettier can fail on malformed code — continue with unformatted
  // }

  // Build with esbuild — keep all imports (react, @ggui-ai/design)
  // esbuild.transform() passes them through as-is, the runtime resolves them
  const buildStart = Date.now();
  let buildSuccess = false;
  let compiledCode = '';
  const buildErrors: string[] = [];
  try {
    const result = await esbuild.transform(formatted, {
      loader: 'tsx',
      target: 'es2020',
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'react',
      minify: true,
      keepNames: true,
    });
    compiledCode = result.code;
    buildSuccess = true;
  } catch (e) {
    buildErrors.push(e instanceof Error ? e.message : String(e));
  }
  const buildMs = Date.now() - buildStart;

  const buildResult = {
    success: buildSuccess,
    compiledCode: buildSuccess ? compiledCode : undefined,
    errors: buildErrors.length > 0 ? buildErrors : undefined,
  };

  // Tier 0 checks (replaces self-check — includes build, security, imports,
  // tokens, types, contract, TS type checking, React hooks linting)
  const selfCheckStart = Date.now();
  const tier0Issues = await runTier0Checks(
    formatted,
    buildResult.compiledCode ?? null,
    contract,
    buildResult.errors,
    gadgetTypes,
  );
  const tier0Fails = tier0Issues.filter(i => i.result === 'fail');
  const selfCheckPassed = tier0Fails.length === 0;
  // When contextPolicy.labeledTier0 is set, prefix each violation with
  // its P0/P1/P2 priority so the LLM can rank against the prompt's
  // schema. The default (off) emits unlabeled feedback.
  const violations = tier0Issues
    .filter(i => i.result === 'fail')
    .map(i => contextPolicy?.labeledTier0
      ? `[${i.priority ?? 'P0'}-${i.category}] ${i.description}\n  Fix: ${i.fix}`
      : `[${i.category}] ${i.description}\n  Fix: ${i.fix}`);
  const softWarnings = getSoftWarnings(raw);
  const selfCheckMs = Date.now() - selfCheckStart;

  // Always commit (preserves history)
  const gitStart = Date.now();
  const oid = await workspace.commit(message);
  commitMeta.set(oid, { build: buildResult, selfCheck: { passed: selfCheckPassed, violations } });
  const gitMs = Date.now() - gitStart;

  const status = buildSuccess && selfCheckPassed ? 'PASS' : 'FAIL';
  console.log(
    `[coding-agent] auto-commit: ${status} | build=${buildMs}ms self-check=${selfCheckMs}ms git=${gitMs}ms total=${Date.now() - commitStart}ms | violations=${violations.length}`,
  );
  if (violations.length > 0) {
    for (const v of violations) {
      console.log(`[coding-agent]   ✗ ${v}`);
    }
  }

  if (buildSuccess && selfCheckPassed) {
    const warnStr = softWarnings.length > 0
      ? `\nWarnings (non-blocking): ${softWarnings.join('; ')}`
      : '';
    return {
      result: `Committed ${oid.slice(0, 7)}: "${message}"\nBuild: OK\nSelf-check: PASS${warnStr}`,
      done: true,
      compiledCode,
    };
  }

  const errors = [
    ...(buildErrors.length > 0 ? [`Build errors:\n${buildErrors.join('\n')}`] : []),
    ...(!selfCheckPassed ? [`Self-check violations:\n${violations.join('\n')}`] : []),
  ];
  return {
    result: `Committed ${oid.slice(0, 7)}: "${message}"\n${errors.join('\n')}\nFix the issues.`,
  };
}

// =============================================================================
// Tool Executor
// =============================================================================

export async function executeTool(
  workspace: AgentWorkspace,
  tool: string,
  input: Record<string, unknown>,
  commitMeta: Map<string, CommitMetadata>,
  contract?: DataContract,
  applyPatch?: import("../harness/types-public.js").PatchFn,
  /**
   * Optional context policy — when provided, `apply_changes` preflight
   * renders the PATCH_INVALID retry message according to policy. Callers
   * that don't pass one get the legacy unlabeled feedback, preserving
   * back-compat for the legacy coding-agent/agent.ts path and existing
   * tests. Harness-driven callers (run-coding-turn) should pass
   * `harness.policy.context` so the resolved policy wins.
   */
  contextPolicy?: import("../harness/policy.js").ContextPolicy,
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * Forwarded to `autoCommit` → `runTier0Checks` → `typecheck` so the
   * TS sandbox overlays each wrapper's real `.d.ts` and a generated
   * direct import `import { useX } from '<package>'` gets strict
   * option/return narrowing instead of `any`. Standard-library-only
   * callers omit it.
   */
  gadgetTypes?: Readonly<Record<string, string>>,
): Promise<ToolResult> {
  switch (tool) {
    case 'write':
    case 'rewrite': {
      const code = input.code as string | undefined;
      if (!code && code !== '') {
        console.warn(
          `[coding-agent] write: no "code" field. Keys: [${Object.keys(input).join(', ')}]`,
        );
        return {
          result: `FAILED: write requires a "code" field. Received: [${Object.keys(input).join(', ')}]`,
          error: true,
        };
      }
      workspace.write(code);
      await workspace.stage();
      const lineCount = code.split('\n').length;
      const message = (input.commit_message as string) || `write ${lineCount} lines`;

      console.log(`[coding-agent] write: ${lineCount} lines → auto-commit`);
      return autoCommit(workspace, commitMeta, message, contract, contextPolicy, gadgetTypes);
    }

    case 'apply_diff': {
      // Legacy unified diff path — kept for coding agent
      const currentFile = workspace.read();
      if (!currentFile && currentFile !== '') {
        return { result: 'FAILED: No file exists.', error: true };
      }
      const { preProcessDiff: ppd, applyDiffToFile: adf } = await import('./diff-processor');
      const diffStr = input.diff as string;
      const preResult = ppd(diffStr, currentFile);
      if (!preResult.success) {
        return { result: `DIFF PRE-PROCESS FAILED:\n${preResult.error}`, error: true };
      }
      const applyResult = adf(currentFile, preResult.cleanDiff, preResult.parsed);
      if (!applyResult.success) {
        return { result: `DIFF APPLY FAILED:\n${applyResult.error}`, error: true };
      }
      workspace.write(applyResult.result);
      await workspace.stage();
      const diffMsg = (input.commit_message as string) || 'apply diff';
      console.log(`[coding-agent] apply_diff: applied → auto-commit`);
      return autoCommit(workspace, commitMeta, diffMsg, contract, contextPolicy, gadgetTypes);
    }

    case 'apply_changes': {
      const currentFile = workspace.read();
      if (!currentFile && currentFile !== '') {
        return { result: 'FAILED: No file exists.', error: true };
      }

      type RawChange = {
        startLine: number | string;
        endLine: number | string;
        code: string[] | string;
        description?: string;
      };
      // `input.changes` can legitimately arrive as either a single
      // RawChange (LLM forgot the array wrapper) or RawChange[]. Normalize
      // up front so downstream code only sees the array shape.
      const inputChanges = input.changes as RawChange | RawChange[] | undefined;
      const rawChanges: RawChange[] = inputChanges
        ? Array.isArray(inputChanges)
          ? inputChanges
          : [inputChanges]
        : [];
      // Option C: opt-in "allowBroken" — LLM deliberately commits a patch
      // that may fail syntax preflight, planning to finish the repair
      // across follow-up turns. The workspace is updated + a warning is
      // returned so the LLM sees the error location without the patch
      // being reverted.
      const allowBroken = input.allowBroken === true;

      // Shape-normalize each change. `startLine` / `endLine` may arrive as:
      //   - number (numeric-line schema)
      //   - string like "47:a3" (hashline schema) — parse into line
      //     number + expected hash so we can validate against the
      //     current file before applying.
      const { parseHashlineRef, validateHashlineRefs, formatHashlineStaleMessage } =
        await import('../harness/hashline.js');
      const normalizedChanges: Array<{
        startLine: number;
        endLine: number;
        code: string[];
        description: string;
        expectedStartHash?: string;
        expectedEndHash?: string;
      }> = [];
      for (let i = 0; i < (rawChanges ?? []).length; i++) {
        const c = rawChanges![i]!;
        let startLine: number;
        let expectedStartHash: string | undefined;
        if (typeof c.startLine === 'string') {
          const parsed = parseHashlineRef(c.startLine);
          if (!parsed) {
            return {
              result: `FAILED: change[${i}].startLine = ${JSON.stringify(c.startLine)} is not a valid hashline ref (expected "N:hh" format).`,
              error: true,
            };
          }
          startLine = parsed.line;
          expectedStartHash = parsed.expectedHash;
        } else {
          startLine = c.startLine;
        }
        let endLine: number;
        let expectedEndHash: string | undefined;
        if (typeof c.endLine === 'string') {
          const parsed = parseHashlineRef(c.endLine);
          if (!parsed) {
            return {
              result: `FAILED: change[${i}].endLine = ${JSON.stringify(c.endLine)} is not a valid hashline ref (expected "N:hh" format).`,
              error: true,
            };
          }
          endLine = parsed.line;
          expectedEndHash = parsed.expectedHash;
        } else {
          endLine = c.endLine;
        }
        normalizedChanges.push({
          startLine,
          endLine,
          code: Array.isArray(c.code) ? c.code : typeof c.code === 'string' ? c.code.split('\n') : [],
          description: c.description ?? `change ${i + 1}`,
          expectedStartHash,
          expectedEndHash,
        });
      }

      // ── Hashline validation — any change with expected hashes must match
      //    the current file BEFORE we apply. Mismatch = LLM's view is stale
      //    (file drifted under it) → reject with HASHLINE_STALE + current
      //    content so the LLM can re-orient. This is the ONE case where we
      //    still reject-and-revert under the never-revert default: patching
      //    based on stale hashes would corrupt the file silently.
      const hashlineIssues = validateHashlineRefs(currentFile, normalizedChanges);
      if (hashlineIssues.length > 0) {
        const ranges = normalizedChanges
          .map((c) => `${c.startLine}-${c.endLine}`)
          .join(', ');
        console.log(
          `[coding-agent] apply_changes: HASHLINE_STALE | ranges=${ranges} | ${hashlineIssues.length} mismatch(es)`,
        );
        return {
          result: formatHashlineStaleMessage(hashlineIssues),
          error: true,
        };
      }

      // ── Patch application — via harness.what.applyPatch when provided,
      // else fall back to the default pure engine. Both enforce the same
      // invariants (sort, non-overlap, line bounds, reverse apply).
      const { defaultApplyPatch } = await import('../patch.js');
      const patcher = applyPatch ?? defaultApplyPatch;
      const patchResult = await patcher({
        sourceBefore: currentFile,
        changes: normalizedChanges,
      });
      if (!patchResult.ok) {
        return { result: `FAILED: ${patchResult.error}`, error: true };
      }
      const candidate = patchResult.sourceAfter ?? currentFile;

      // Log each applied change for traceability (matches prior output shape).
      const changes = [...normalizedChanges].sort((a, b) => a.startLine - b.startLine);
      for (const c of changes) {
        console.log(
          `[coding-agent] change: lines ${c.startLine}-${c.endLine} → ${c.code.length} lines | ${c.description}`,
        );
      }

      // `candidate` already set above from patchResult.sourceAfter.
      const resultLines = candidate.split('\n');

      // ── Structural tag-balance DIAGNOSTIC ──
      // Counts per-tag (opens, closes, self-closes) across the whole
      // patch and logs any net imbalance. This is NOT a gate — esbuild
      // remains the gate.
      //
      // The balance check is deliberately not used as a rejection gate:
      // an abstract summary message ("you have 1 unclosed <Stack>")
      // gives the LLM less to work with than esbuild's line-specific
      // error ("Unexpected closing Container at line 183").
      //
      // Instead, the imbalance summary is appended as SUPPLEMENTARY
      // context to the PATCH_APPLIED_BROKEN message when esbuild also
      // fails. esbuild's precise line stays the primary signal; the
      // imbalance counts become a hint.
      let tagImbalanceSummary: string | null = null;
      {
        const { checkPatchTagBalance } = await import('./tag-balance.js');
        const imbalance = checkPatchTagBalance(currentFile, changes);
        if (imbalance.imbalanced) {
          const ranges = changes
            .map((c) => `${c.startLine}-${c.endLine}`)
            .join(', ');
          const totalsSummary = imbalance.totals
            .map((d) => `${d.tag}${d.netDelta >= 0 ? '+' : ''}${d.netDelta}`)
            .join(' ');
          console.log(
            `[coding-agent] apply_changes: tag-balance-diag | ranges=${ranges} | ${totalsSummary}`,
          );
          tagImbalanceSummary = totalsSummary;
        }
      }

      // ── Step 6: Syntax preflight — parse candidate before mutating workspace ──
      // Catches broken JSX/TSX from the patch (mismatched tags, stray braces, etc.)
      // BEFORE we write/stage/commit. On failure: keep last-good file, return
      // PATCH_INVALID so the LLM can retry from stable ground (distinct from
      // SELF_CHECK_FAIL, which means valid TSX but rejected by tier-0 checks).
      // esbuild settings must match the real build path in autoCommit().
      try {
        await esbuild.transform(candidate, {
          loader: 'tsx',
          target: 'es2020',
          format: 'esm',
          jsx: 'automatic',
          jsxImportSource: 'react',
          minify: true,
          keepNames: true,
        });
      } catch (e) {
        // esbuild throws a TransformFailure with structured `errors[]` including
        // { text, location: { line, column, lineText } }. Center the retry slice
        // on the ACTUAL error line (first error), not the first changed range.
        // If the error has no location (rare), fall back to first change.
        const errMsg = e instanceof Error ? e.message : String(e);
        const esErrs = (e as { errors?: Array<{ text?: string; location?: { line?: number; column?: number; lineText?: string } }> }).errors ?? [];
        const firstErr = esErrs[0];
        const errLine = firstErr?.location?.line;
        const errCol = firstErr?.location?.column;
        const errText = firstErr?.text ?? errMsg.split('\n')[0];

        const ranges = changes
          .map(c => `${c.startLine}-${c.endLine}`)
          .join(', ');

        // Pick slice center: esbuild's error line if available, else first change.
        let sliceStart: number;
        let sliceEnd: number;
        let sliceLabel: string;
        if (typeof errLine === 'number' && errLine > 0) {
          sliceStart = Math.max(0, errLine - 6);
          sliceEnd = Math.min(resultLines.length, errLine + 5);
          sliceLabel = `Candidate slice (±5 lines around esbuild error at line ${errLine}${typeof errCol === 'number' ? `:${errCol}` : ''})`;
        } else {
          const first = changes[0];
          sliceStart = Math.max(0, first.startLine - 6);
          sliceEnd = Math.min(resultLines.length, first.endLine + 5);
          sliceLabel = `Candidate slice (around first changed range)`;
        }
        const slice = resultLines
          .slice(sliceStart, sliceEnd)
          .map((l, i) => {
            const lineNum = sliceStart + i + 1;
            const marker = lineNum === errLine ? ' ◄── esbuild error here' : '';
            return `${lineNum}│${l}${marker}`;
          })
          .join('\n');

        // ── Apply-and-warn on syntax failure ──
        // An earlier approach reverted the workspace + returned a
        // PATCH_INVALID error. The problem: the LLM never saw its own
        // broken patch persisted, so across retries it replayed from
        // the prior-good file and often re-emitted variations of the
        // same broken patch ("chasing a moving target").
        //
        // Now: ALWAYS write the candidate to workspace; DON'T git-commit
        // (the prior-good commit stays as the eval ancestor, and
        // compiledCode only updates when esbuild passes). The LLM sees its
        // broken patch on the next turn and iterates forward from broken
        // state toward a fixed one — matches how an engineer actually
        // debugs. The final eval gate is the compile/render at eval time:
        // if the workspace never converges to a compilable state, the
        // compiledCode stays at prior-good (or empty) and eval fails
        // naturally — no need to block per-turn.
        //
        // The `allowBroken` input field is retained for back-compat but
        // is now a no-op (behavior is always apply-and-warn).
        workspace.write(candidate);
        console.log(
          `[coding-agent] apply_changes: APPLIED-BROKEN (preflight failed)${allowBroken ? ' [allowBroken]' : ''} | ranges=${ranges} | line=${errLine ?? '?'} | ${errText}`,
        );
        const preflightPrefix = contextPolicy?.labeledPreflight
          ? `[P0-compile] `
          : ``;
        const imbalanceHint = tagImbalanceSummary
          ? `\n\nPatch tag-balance imbalance: ${tagImbalanceSummary}\n` +
            `(Net opens vs closes inside your edit ranges. If a tag has +N, you opened N more than you closed within the patch — verify each <Tag> has a matching </Tag> in your changes, or that the surrounding scaffold provides the closer.)`
          : '';
        return {
          result:
            `${preflightPrefix}PATCH_APPLIED_BROKEN: patch applied but file has a syntax error. Workspace updated; no git commit yet.\n` +
            `Changed ranges: ${ranges}\n` +
            `esbuild error: ${errText}${typeof errLine === 'number' ? ` (line ${errLine}${typeof errCol === 'number' ? `, col ${errCol}` : ''})` : ''}\n\n` +
            `${sliceLabel}:\n${slice}\n\n` +
            `The file now reflects your latest patch. Submit a follow-up apply_changes targeting the error location above to converge toward a compilable file.${imbalanceHint}`,
          error: false,
        };
      }

      workspace.write(candidate);
      await workspace.stage();
      const message = (input.commit_message as string) || 'apply changes';

      console.log(`[coding-agent] apply_changes: ${changes.length} changes applied → auto-commit`);
      return autoCommit(workspace, commitMeta, message, contract, contextPolicy, gadgetTypes);
    }

    case 'get_components_info': {
      const names = (input.names as string[]) ?? [];
      const docs = names.map((name) => getComponentDocumentation(name));
      return { result: docs.join('\n\n---\n\n') };
    }

    case 'write_plan': {
      // Plan-commitment. Echo the plan back so it stays visible in
      // conversation history for subsequent turns.
      const components = (input.components as string[]) ?? [];
      const structure = (input.structure as string) ?? '';
      const wiring = (input.wiring as string) ?? '';
      const summary =
        `PLAN_COMMITTED\n\n` +
        `Components: ${components.join(', ')}\n\n` +
        `Structure: ${structure}\n\n` +
        `Wiring: ${wiring}\n\n` +
        `On the next turn, use apply_changes to write the code. Fetch more component docs only if needed.`;
      return { result: summary };
    }

    // `cat` is NOT advertised on the bench's coding-turn tool list —
    // `run-coding-turn.ts::selectTurnTools` omits it because every turn's
    // prompt already injects the current file as a `## Current File`
    // block, so no read-tool is needed there. The case stays for the
    // legacy `fullToolSchemas` registry (dev-agent workflows that don't
    // auto-inject file content).
    case 'cat':
      return {
        result: workspace.cat(
          input.start_line as number | undefined,
          input.end_line as number | undefined,
        ),
      };

    case 'grep':
      return {
        result: workspace.grep(
          input.pattern as string,
          input.context as number | undefined,
        ),
      };

    case 'diff':
      return { result: await workspace.diffWorking() };

    case 'log': {
      const commits = await workspace.log(input.depth as number | undefined);
      if (commits.length === 0) return { result: '(no commits)' };
      const lines = commits.map((c) => {
        const meta = commitMeta.get(c.oid);
        const status = meta?.selfCheck.passed
          ? 'PASS'
          : meta?.selfCheck
            ? 'FAIL'
            : '—';
        return `${c.oid.slice(0, 7)} [${status}] ${c.commit.message.trim()}`;
      });
      return { result: lines.join('\n') };
    }

    case 'show': {
      const oidPrefix = input.oid as string;
      const commits = await workspace.log();
      const idx = commits.findIndex((c) => c.oid.startsWith(oidPrefix));
      if (idx === -1) {
        return { result: `Commit not found: ${oidPrefix}`, error: true };
      }
      const thisOid = commits[idx].oid;
      const parentOid = idx + 1 < commits.length ? commits[idx + 1].oid : null;
      if (!parentOid) {
        const content = await workspace.readFileAtCommit(thisOid);
        return { result: `(initial commit)\n${content}` };
      }
      return { result: await workspace.diffBetween(parentOid, thisOid) };
    }

    case 'revert': {
      const oidPrefix = input.oid as string;
      const commits = await workspace.log();
      const match = commits.find((c) => c.oid.startsWith(oidPrefix));
      if (!match) {
        const available = commits.map((c) => c.oid.slice(0, 7)).join(', ');
        return {
          result: `OID not found: ${oidPrefix}. Available: ${available || '(none)'}`,
          error: true,
        };
      }
      await workspace.checkout(match.oid);
      return { result: `Reverted working copy to ${match.oid.slice(0, 7)}` };
    }

    default:
      return { result: `Unknown tool: ${tool}`, error: true };
  }
}

// =============================================================================
// Batch Executor
// =============================================================================

export async function executeToolBatch(
  calls: ToolCall[],
  workspace: AgentWorkspace,
  commitMeta: Map<string, CommitMetadata>,
): Promise<BatchResult> {
  const results: ToolResult[] = [];

  for (const call of calls) {
    const result = await executeTool(workspace, call.tool, call.input, commitMeta);
    results.push(result);

    // Short-circuit: auto-commit passed → generation complete
    if (result.done) {
      return { results, done: true, compiledCode: result.compiledCode };
    }

    // Short-circuit: tool failed → LLM needs to see the error
    if (result.error) {
      return { results, done: false };
    }
  }

  return { results, done: false };
}
