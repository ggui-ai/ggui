/**
 * ggui#843 — the generation-time import gate refuses the writer side of
 * the wire. `@ggui-ai/wire/internal` is where a deployment's runtime claims
 * the connection writer; generated component code may read
 * `useRender().isConnected` and must never reach the writer. The design
 * package's import rewriter refuses the same specifier at load time; this
 * gate refuses it at generation time, from the same list.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_IMPORT_SPECIFIERS } from '@ggui-ai/design/rendering';
import { describeAllowedImports, isAllowedImport } from './allowed-imports.js';

describe('isAllowedImport refuses the wire\'s internal entry (ggui#843)', () => {
  it('refuses @ggui-ai/wire/internal while the root barrel stays allowed', () => {
    expect(isAllowedImport('@ggui-ai/wire')).toBe(true);
    expect(isAllowedImport('@ggui-ai/wire/internal')).toBe(false);
    expect(isAllowedImport('@ggui-ai/wire/internal', new Set(['@ggui-ai/wire/internal']))).toBe(false);
  });

  it('refuses exactly the specifiers the load-time rewriter refuses — one list, two gates', () => {
    for (const specifier of FORBIDDEN_IMPORT_SPECIFIERS) expect(isAllowedImport(specifier)).toBe(false);
  });

  it('the fix text names the refusal', () => {
    expect(describeAllowedImports()).toContain('@ggui-ai/wire/internal');
    expect(describeAllowedImports()).toContain('never');
  });
});
