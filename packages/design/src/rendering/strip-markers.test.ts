import { describe, it, expect } from 'vitest';
import { stripMarkers } from './strip-markers';

describe('stripMarkers', () => {
  it('removes __GGUI_META__ blocks', () => {
    const code = `const x = 1;\n__GGUI_META__\n{"component":"Foo"}\n__GGUI_META_END__\nexport default x;`;
    expect(stripMarkers(code)).toBe('const x = 1;\n\nexport default x;');
  });

  it('removes __GGUI_STREAM_SPEC__ blocks', () => {
    const code = `const y = 2;\n__GGUI_STREAM_SPEC__\n{"fields":["name"]}\n__GGUI_STREAM_SPEC_END__\nexport default y;`;
    expect(stripMarkers(code)).toBe('const y = 2;\n\nexport default y;');
  });

  it('removes both marker types in the same code', () => {
    const code = [
      'const a = 1;',
      '__GGUI_META__{"name":"Test"}__GGUI_META_END__',
      'const b = 2;',
      '__GGUI_STREAM_SPEC__{"spec":true}__GGUI_STREAM_SPEC_END__',
      'export { a, b };',
    ].join('\n');
    const result = stripMarkers(code);
    expect(result).not.toContain('__GGUI_META__');
    expect(result).not.toContain('__GGUI_STREAM_SPEC__');
    expect(result).toContain('const a = 1;');
    expect(result).toContain('const b = 2;');
    expect(result).toContain('export { a, b };');
  });

  it('handles multiple meta blocks', () => {
    const code = '__GGUI_META__a__GGUI_META_END__hello__GGUI_META__b__GGUI_META_END__world';
    expect(stripMarkers(code)).toBe('helloworld');
  });

  it('returns code unchanged when no markers present', () => {
    const code = 'export default function App() { return null; }';
    expect(stripMarkers(code)).toBe(code);
  });

  it('handles empty string', () => {
    expect(stripMarkers('')).toBe('');
  });

  it('handles multiline content inside markers', () => {
    const code = [
      'before',
      '__GGUI_META__',
      '{',
      '  "name": "Test",',
      '  "version": 1',
      '}',
      '__GGUI_META_END__',
      'after',
    ].join('\n');
    const result = stripMarkers(code);
    expect(result).toContain('before');
    expect(result).toContain('after');
    expect(result).not.toContain('__GGUI_META__');
  });
});
