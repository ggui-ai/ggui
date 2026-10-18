// ggui#1930 — an arm runs its prompts concurrently, so `[v:<arm>]` alone cannot attribute a line to a
// cell. A cell that names its prompt gets `[c:<commit>]` after the arm tag; the arm tag's form is
// unchanged, so a reader matching `[v:<arm>] ` still matches.
import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { cellTagPrefix, installVariantConsoleTag, runWithVariantTag, variantTagPrefix } from './variant-log-tag';

function capturedConsole(): { console: Console; lines: () => string[] } {
  const out = new PassThrough();
  const chunks: string[] = [];
  out.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  return { console: new Console({ stdout: out, stderr: out }), lines: () => chunks.join('').split('\n').filter((l) => l.length > 0) };
}

describe('the cell tag (ggui#1930)', () => {
  it('two concurrent cells of one arm write lines a reader can tell apart, interleaved', async () => {
    const { console: c, lines } = capturedConsole();
    const restore = installVariantConsoleTag(c);
    try {
      const cell = (commit: string) =>
        runWithVariantTag('google-fast', async () => {
          for (let i = 0; i < 3; i++) {
            c.log(`turn ${i}`);
            await sleep(1);
          }
        }, commit);
      await Promise.all([cell('chat-interface'), cell('kanban-board')]);
    } finally {
      restore();
    }
    const out = lines();
    const chat = variantTagPrefix('google-fast') + cellTagPrefix('chat-interface');
    const kanban = variantTagPrefix('google-fast') + cellTagPrefix('kanban-board');
    expect(out.filter((l) => l.startsWith(chat))).toHaveLength(3);
    expect(out.filter((l) => l.startsWith(kanban))).toHaveLength(3);
    expect(out.every((l) => l.startsWith(variantTagPrefix('google-fast')))).toBe(true);
  });

  it('a cell that names no prompt keeps the arm tag alone, as before', async () => {
    const { console: c, lines } = capturedConsole();
    const restore = installVariantConsoleTag(c);
    try {
      await runWithVariantTag('claude-fast', async () => {
        c.log('x');
      });
    } finally {
      restore();
    }
    expect(lines()).toEqual([`${variantTagPrefix('claude-fast')}x`]);
  });
});
