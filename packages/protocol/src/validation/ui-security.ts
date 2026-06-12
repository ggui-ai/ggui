// packages/protocol/src/validation/ui-security.ts
//
// Shared UI security validation — single source of truth for dangerous
// patterns and UI classification. Used by:
//   - @ggui-ai/ui-gen src/validation/component-detailed.ts
//     (validateComponentDetailed — the generator/compiler validation
//     pipeline, consumes DANGEROUS_PATTERNS)
//   - @ggui-ai/ui-gen src/validation/ui-compiler.ts (standalone
//     compileUi/validateUi — consumes classifyUi + UiClass)
//   - @ggui-ai/project-config src/ui-manifest.ts (UiManifest schema —
//     validates against the UiClass vocabulary owned here)
//
// This module is PUBLIC (@ggui-ai/protocol) — keep it dependency-free.

// Browser-safe module: intentionally no `node:crypto` import here. The
// SHA-256 `contentHash` helper moved to `./content-hash` so it can stay
// synchronous without poisoning browser bundles via the protocol barrel.

/**
 * Classification of a UI component by its portability.
 *
 * - `sandboxed` — pure React + `@ggui-ai/design` primitives. Portable,
 *   publishable, runs in any ggui rendering context.
 * - `fullstack` — uses adapters (`@ggui-ai/react` hooks, server
 *   connectors). Requires a client bundle, app-scoped.
 *
 * Colocated with the classifier (`classifyUi`) because that's the
 * only runtime producer of this value — the `UiManifest` schema in
 * `@ggui-ai/project-config` imports this vocabulary and validates
 * against it.
 */
export type UiClass = 'sandboxed' | 'fullstack';

// ── Dangerous Patterns ──────────────────────────────────────────────
// Security checks for user-authored component code.
// Each pattern blocks a class of attacks (XSS, data exfiltration, sandbox escape).

export interface DangerousPattern {
  /** Regex to match against source/compiled code. */
  pattern: RegExp;
  /** Human-readable name of the pattern. */
  name: string;
  /** Why this is blocked and what to do instead. */
  suggestion: string;
}

/**
 * Patterns that are NEVER allowed in sandboxed UI components.
 * These are security-critical — changes here affect every validation consumer.
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  {
    pattern: /\beval\s*\(/,
    name: 'eval()',
    suggestion: 'Remove eval() - it allows arbitrary code execution. Use proper data handling instead.',
  },
  {
    pattern: /\bFunction\s*\(/,
    name: 'Function constructor',
    suggestion: 'Remove Function() constructor - it allows arbitrary code execution.',
  },
  {
    pattern: /\binnerHTML\s*=/,
    name: 'innerHTML',
    suggestion: 'Use React components instead of innerHTML to prevent XSS vulnerabilities.',
  },
  {
    pattern: /\bdangerouslySetInnerHTML\b/,
    name: 'dangerouslySetInnerHTML',
    suggestion: 'Avoid dangerouslySetInnerHTML - use React components for rendering.',
  },
  {
    pattern: /\bdocument\.\w+/,
    name: 'document access',
    suggestion: 'Do not access document directly - use React refs and state instead.',
  },
  {
    pattern: /\bwindow\.(?!__GGUI)/,
    name: 'window access',
    suggestion: 'Do not access window directly - use React patterns instead.',
  },
  {
    pattern: /\blocalStorage\b/,
    name: 'localStorage',
    suggestion: 'Do not use localStorage - pass data through props and onSubmit.',
  },
  {
    pattern: /\bsessionStorage\b/,
    name: 'sessionStorage',
    suggestion: 'Do not use sessionStorage - pass data through props and onSubmit.',
  },
  {
    pattern: /\bfetch\s*\(/,
    name: 'fetch()',
    suggestion: 'Do not make network requests - use adapters and onSubmit for data operations.',
  },
  {
    pattern: /\bXMLHttpRequest\b/,
    name: 'XMLHttpRequest',
    suggestion: 'Do not make network requests - use adapters and onSubmit for data operations.',
  },
  {
    pattern: /\bimport\s*\(/,
    name: 'dynamic import',
    suggestion: 'Do not use dynamic imports - all dependencies must be static imports.',
  },
  {
    pattern: /<script\b/i,
    name: 'script tag',
    suggestion: 'Do not include script tags - use React components only.',
  },
  {
    pattern: /\bnew\s+WebSocket\b/,
    name: 'WebSocket',
    suggestion: 'Do not create WebSocket connections - communication is handled by ggui.',
  },
  {
    pattern: /\bnavigator\./,
    name: 'navigator access',
    suggestion: 'Do not access navigator - use React patterns for user interactions.',
  },
  {
    pattern: /\blocation\./,
    name: 'location access',
    suggestion: 'Do not access location - routing is handled externally.',
  },
  {
    pattern: /\bhistory\./,
    name: 'history access',
    suggestion: 'Do not access history - navigation is handled externally.',
  },
];

// ── UI Classification ───────────────────────────────────────────────

/**
 * Import prefixes that indicate a fullstack UI (requires client bundle).
 * Internal input of {@link classifyUi} — not part of the published API.
 */
const FULLSTACK_IMPORT_PREFIXES = [
  '@ggui-ai/wire',
  '@ggui-ai/react',
  '@app/components',
] as const;

/**
 * Classify a component as sandboxed or fullstack based on its imports.
 *
 * - **sandboxed**: Pure React + @ggui-ai/design primitives. Portable, publishable.
 * - **fullstack**: Uses @ggui-ai/wire, @ggui-ai/react, or @app/components. Private.
 *
 * Works on both source (.tsx) and compiled (.js) code.
 */
export function classifyUi(code: string): UiClass {
  const importRegex = /(?:from|require\()\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const src = match[1];
    if (FULLSTACK_IMPORT_PREFIXES.some((prefix) => src === prefix || src.startsWith(prefix + '/'))) {
      return 'fullstack';
    }
  }
  return 'sandboxed';
}

// ── Content Hash ────────────────────────────────────────────────────
//
// Moved to `./content-hash` because it depends on `node:crypto`. Server-
// only callers import it via `@ggui-ai/protocol/content-hash` — see that
// file's header for rationale.
