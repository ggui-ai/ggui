// packages/ui-gen/src/coding-agent/workspace.ts
//
// In-memory git workspace for single-file UI component management.
// Uses isomorphic-git + memfs + diff package.

import git, { type ReadCommitResult } from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { createPatch, applyPatch } from 'diff';
import type { ApplyResult } from './types';

const FILE = 'ui.tsx';
const DIR = '/workspace';
const FILEPATH = `${DIR}/${FILE}`;
const AUTHOR = { name: 'ggui-agent', email: 'agent@ggui.ai' };

export { type ReadCommitResult };

export class AgentWorkspace {
  private vol: InstanceType<typeof Volume>;
  private fs: ReturnType<typeof createFsFromVolume>;

  constructor() {
    this.vol = new Volume();
    this.fs = createFsFromVolume(this.vol);
  }

  async init(): Promise<void> {
    this.fs.mkdirSync(DIR, { recursive: true });
    await git.init({ fs: this.fs, dir: DIR });
  }

  // ── File Operations ────────────────────────────────

  read(): string | null {
    try {
      return this.fs.readFileSync(FILEPATH, 'utf-8') as string;
    } catch {
      return null;
    }
  }

  write(code: string): void {
    this.fs.writeFileSync(FILEPATH, code);
  }

  cat(startLine?: number, endLine?: number): string {
    const content = this.read();
    if (!content) return '(no file yet — use `write` to create it)';

    const lines = content.split('\n');
    const start = (startLine ?? 1) - 1;
    const end = endLine ?? lines.length;
    const padWidth = String(end).length;

    return lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(padWidth)}│ ${line}`)
      .join('\n');
  }

  grep(pattern: string, contextLines: number = 0): string {
    const content = this.read();
    if (!content) return '(no file)';

    const lines = content.split('\n');
    const matchedIndices = new Set<number>();
    const matchLines = new Set<number>();

    // Find matching lines
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(pattern, 'gi').test(lines[i])) {
        matchLines.add(i);
        for (
          let j = Math.max(0, i - contextLines);
          j <= Math.min(lines.length - 1, i + contextLines);
          j++
        ) {
          matchedIndices.add(j);
        }
      }
    }

    if (matchedIndices.size === 0) return '(no matches)';

    const padWidth = String(lines.length).length;
    return [...matchedIndices]
      .sort((a, b) => a - b)
      .map((i) => {
        const prefix = matchLines.has(i) ? '>' : ' ';
        return `${prefix} ${String(i + 1).padStart(padWidth)}│ ${lines[i]}`;
      })
      .join('\n');
  }

  // ── Git Operations ─────────────────────────────────

  async stage(): Promise<void> {
    await git.add({ fs: this.fs, dir: DIR, filepath: FILE });
  }

  async commit(message: string): Promise<string> {
    await this.stage();
    return git.commit({
      fs: this.fs,
      dir: DIR,
      message,
      author: AUTHOR,
    });
  }

  async log(depth?: number): Promise<ReadCommitResult[]> {
    try {
      return await git.log({ fs: this.fs, dir: DIR, depth: depth ?? 20 });
    } catch {
      return [];
    }
  }

  async readFileAtCommit(oid: string): Promise<string> {
    const { blob } = await git.readBlob({
      fs: this.fs,
      dir: DIR,
      oid,
      filepath: FILE,
    });
    return new TextDecoder().decode(blob);
  }

  async checkout(oid: string): Promise<void> {
    const content = await this.readFileAtCommit(oid);
    this.write(content);
  }

  // ── Diff Operations ────────────────────────────────

  async diffWorking(): Promise<string> {
    const commits = await this.log(1);
    if (commits.length === 0) return '(no commits yet — new file)';

    const committed = await this.readFileAtCommit(commits[0].oid);
    const working = this.read() ?? '';
    return createPatch(FILE, committed, working, 'committed', 'working', {
      context: 3,
    });
  }

  async diffBetween(oldOid: string, newOid: string): Promise<string> {
    const oldContent = await this.readFileAtCommit(oldOid);
    const newContent = await this.readFileAtCommit(newOid);
    return createPatch(
      FILE,
      oldContent,
      newContent,
      oldOid.slice(0, 7),
      newOid.slice(0, 7),
      { context: 3 },
    );
  }

  applyDiff(patch: string): ApplyResult {
    const current = this.read() ?? '';

    // Validate patch has at least one hunk header
    if (!patch.includes('@@')) {
      return {
        success: false,
        error:
          'Invalid diff format — missing @@ hunk headers. Use standard unified diff format.',
      };
    }

    // Try to apply with fuzz matching
    const result = applyPatch(current, patch, {
      fuzzFactor: 2,
      compareLine: (
        _lineNum: number,
        line: string,
        _op: string,
        patchContent: string,
      ) => {
        return line.trimEnd() === patchContent.trimEnd();
      },
    });

    if (result === false) {
      return {
        success: false,
        error:
          'Patch failed to apply — context lines in your diff do not match the current file. Re-read the current file provided in the prompt and produce a corrected diff.',
      };
    }

    this.write(result);
    return { success: true };
  }
}
