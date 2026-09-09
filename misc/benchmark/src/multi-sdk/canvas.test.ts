import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CANVAS_CLASSES, CANVAS_VIEWPORTS, persistCanvasScreenshots } from './canvas';

describe('canvas vocabulary (#973 §4 F5 — ONE vocabulary, mirrors ui-gen when it lands)', () => {
  it('names the five classes with the agreed viewports', () => {
    expect(CANVAS_CLASSES).toEqual(['xs-chat-card', 'mobile-fullscreen-small', 'md', 'lg', 'xl']);
    expect(CANVAS_VIEWPORTS['xs-chat-card']).toEqual({ width: 400, height: 640 });
    expect(CANVAS_VIEWPORTS['mobile-fullscreen-small']).toEqual({ width: 390, height: 844 });
    expect(CANVAS_VIEWPORTS.md).toEqual({ width: 768, height: 1024 });
    expect(CANVAS_VIEWPORTS.lg).toEqual({ width: 1024, height: 768 });
    expect(CANVAS_VIEWPORTS.xl).toEqual({ width: 1440, height: 900 });
  });
});

describe('persistCanvasScreenshots — PNG beside source.tsx, hash + bytes in the report, never the image', () => {
  it('writes canvas-<class>.png per canvas and returns artefact refs with a relative path, sha256 and bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-canvas-'));
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const out = persistCanvasScreenshots(dir, [
      { canvas: 'md', viewport: CANVAS_VIEWPORTS.md, score: 81, passed: true, screenshotPng: png },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ canvas: 'md', viewport: { width: 768, height: 1024 }, score: 81, passed: true });
    expect(out[0]!.artefact.path).toBe('canvas-md.png');
    expect(out[0]!.artefact.bytes).toBe(png.length);
    expect(out[0]!.artefact.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(existsSync(join(dir, 'canvas-md.png'))).toBe(true);
    expect(readFileSync(join(dir, 'canvas-md.png')).equals(png)).toBe(true);
  });

  it('returns [] and writes nothing for an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-canvas-'));
    expect(persistCanvasScreenshots(dir, [])).toEqual([]);
  });
});
