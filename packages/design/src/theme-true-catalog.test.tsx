/**
 * Pin (ggui#1036 — the theme-blind catalog): a design-package component paints
 * ONLY `var(--ggui-*)` roles — never a value from `tokens/colors`, which is the
 * DEFAULT theme's source (the un-themed fallback inside `var(…, #hex)`) and not a
 * paint. Source scan over components/ + compositions/ + primitives/ (tests and
 * stories excluded): no runtime import of `tokens/colors`, no `colors.<family>[…]`
 * paint site. The RED list on 2026-09-12 is the fixture (twenty files); each file
 * leaves `KNOWN_THEME_BLIND` as it goes green, and a green file can never regress.
 * `Tag` — the first cut — is also rendered and read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tag } from './components/Tag';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIRS = ['primitives', 'components', 'compositions'];

/** Files still painting from `tokens/colors` on 2026-09-12 — shrink this list, never grow it. */
const KNOWN_THEME_BLIND: ReadonlySet<string> = new Set([
  'components/Autocomplete.tsx',
  'components/Breadcrumb.tsx',
  'components/Dropdown.tsx',
  'components/FormField.tsx',
  'components/MenuItem.tsx',
  'components/Pagination.tsx',
  'components/SearchField.tsx',
  'compositions/ChatWindow.tsx',
  'compositions/CommentThread.tsx',
  'compositions/FileUploader.tsx',
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of DIRS) {
    const abs = join(ROOT, dir);
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (!statSync(p).isFile()) continue;
      if (!/\.tsx?$/.test(name) || /\.(test|stories)\.tsx?$/.test(name) || name === 'types.ts' || name === 'index.ts') continue;
      out.push(`${dir}/${name}`);
    }
  }
  return out.sort();
}

const IMPORT_RX = /from\s+['"](?:\.\.\/)+tokens\/colors['"]/;
const PAINT_RX = /\bcolors\.(?:gray|neutral|primary|tertiary|success|warning|error|info)\[/g;

describe('theme-true catalog (ggui#1036) — no paint from tokens/colors', () => {
  const files = sourceFiles();
  it('scans the catalog', () => {
    expect(files.length).toBeGreaterThan(40);
  });
  for (const rel of files) {
    it(rel, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const paints = [...src.matchAll(PAINT_RX)].length;
      const imports = IMPORT_RX.test(src);
      if (KNOWN_THEME_BLIND.has(rel)) {
        // still on the list: it must still be blind — a fixed file leaves the list in the same commit
        expect(paints > 0 || imports, `${rel} is theme-true now — remove it from KNOWN_THEME_BLIND`).toBe(true);
        return;
      }
      expect(paints, `${rel} paints from tokens/colors (${paints} sites)`).toBe(0);
      expect(imports, `${rel} imports tokens/colors at runtime`).toBe(false);
    });
  }
  it('Tag renders every variant through the theme\'s tone container pairs, with the default palette as fallback only', () => {
    for (const variant of ['default', 'primary', 'success', 'warning', 'error', 'info'] as const) {
      const html = renderToStaticMarkup(<Tag variant={variant}>clients</Tag>);
      const stripped = html.replace(/var\(--ggui-[a-zA-Z0-9-]+,\s*#[0-9a-fA-F]{3,8}\)/g, 'var(--ggui-x)');
      expect(stripped, `Tag ${variant} paints a literal`).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(html).toContain('background-color:var(--ggui-color-');
      expect(html).toContain('color:var(--ggui-color-');
    }
  });
});
