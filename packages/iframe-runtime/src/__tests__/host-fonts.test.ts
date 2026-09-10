import { describe, it, expect, vi, beforeEach } from 'vitest';

const posted: unknown[] = [];
vi.mock('../observability', () => ({ postObservabilityToParent: (e: unknown) => posted.push(e) }));
import { installHostFonts, HOST_FONTS_STYLE_ID, __resetHostFontsForTest } from '../host-fonts';

// ggui#987 §5 — the card installs the faces it is handed, replace-on-payload, and reports a blocked src once.
describe('installHostFonts', () => {
  beforeEach(() => {
    __resetHostFontsForTest();
    posted.length = 0;
  });

  it('installs the rules under one <style id="ggui-host-fonts">', () => {
    installHostFonts("@font-face { font-family: 'A'; src: url('https://f.example.com/a.woff2'); }");
    const el = document.getElementById(HOST_FONTS_STYLE_ID);
    expect(el?.tagName).toBe('STYLE');
    expect(el?.textContent).toContain("font-family: 'A'");
    expect(document.querySelectorAll(`#${HOST_FONTS_STYLE_ID}`).length).toBe(1);
  });

  it('a later payload REPLACES the rules (not appended, not ignored)', () => {
    installHostFonts("@font-face { font-family: 'A'; src: url('https://f.example.com/a.woff2'); }");
    installHostFonts("@font-face { font-family: 'B'; src: url('https://f.example.com/b.woff2'); }");
    const el = document.getElementById(HOST_FONTS_STYLE_ID);
    expect(el?.textContent).toContain("'B'");
    expect(el?.textContent).not.toContain("'A'");
    expect(document.querySelectorAll(`#${HOST_FONTS_STYLE_ID}`).length).toBe(1);
  });

  it('a font-src CSP violation is reported ONCE per (family, host) as font-face-blocked', () => {
    installHostFonts("@font-face { font-family: 'Blocked Sans'; src: url('https://cdn.blocked.example/x.woff2'); }");
    const fire = () =>
      document.dispatchEvent(
        new Event('securitypolicyviolation') as Event & { effectiveDirective?: string; blockedURI?: string },
      );
    const ev = new Event('securitypolicyviolation');
    Object.assign(ev, { effectiveDirective: 'font-src', blockedURI: 'https://cdn.blocked.example/x.woff2' });
    document.dispatchEvent(ev);
    document.dispatchEvent(ev);
    fire();
    expect(posted).toEqual([{ kind: 'font-face-blocked', family: 'Blocked Sans', host: 'cdn.blocked.example' }]);
  });

  it('a full-URL blockedURI (same-origin report) must match an installed src — another file on the same host is not ours', () => {
    installHostFonts("@font-face { font-family: 'Acme'; src: url('https://cdn.acme.example/acme.woff2'); }");
    const other = new Event('securitypolicyviolation');
    Object.assign(other, { effectiveDirective: 'font-src', blockedURI: 'https://cdn.acme.example/component-font.woff2' });
    document.dispatchEvent(other);
    expect(posted).toEqual([]);
    const ours = new Event('securitypolicyviolation');
    Object.assign(ours, { effectiveDirective: 'font-src', blockedURI: 'https://cdn.acme.example/acme.woff2' });
    document.dispatchEvent(ours);
    expect(posted).toEqual([{ kind: 'font-face-blocked', family: 'Acme', host: 'cdn.acme.example' }]);
  });
});
