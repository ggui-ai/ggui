import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BenchmarkReportDisplay } from '@ggui-ai/shared';
import type { BenchmarkRunResult } from '../types.js';
import type { BenchmarkStorage, SavedComponent } from './types.js';

/** File names beside `source.tsx` on a cell where the contract-feedback round fired. */
export const SOURCE_BEFORE_ROUND_FILE = 'source.before-round.tsx';
export const CONTRACT_FEEDBACK_FILE = 'contract-feedback.json';

/**
 * The cells a run saves, keyed `<variantId>-<commitId>`: every result that
 * produced a bundle, carrying the harness's contract-feedback record when
 * that cell's round fired (`tierEvaluation.contractFeedback`, ggui#1261).
 */
export function savedComponentsFromResults(
  results: readonly BenchmarkRunResult[],
): Map<string, SavedComponent> {
  const out = new Map<string, SavedComponent>();
  for (const r of results) {
    const compiled = r.generation?.compiledCode;
    if (!compiled) continue;
    const contractFeedback = r.tierEvaluation?.contractFeedback;
    out.set(`${r.variant.id}-${r.commit.id}`, {
      source: r.generation?.sourceCode || '',
      compiled,
      ...(contractFeedback !== undefined ? { contractFeedback } : {}),
    });
  }
  return out;
}

/**
 * LocalStorage — writes benchmark reports to the local filesystem.
 * Used by the CLI runner.
 */
export class LocalStorage implements BenchmarkStorage {
  constructor(private readonly outputDir: string) {
    mkdirSync(outputDir, { recursive: true });
  }

  async createReport(params: {
    reportId: string;
    status: 'running';
    version: string;
    trigger: 'manual' | 'nightly' | 'ci';
  }): Promise<void> {
    console.log(`[storage] Creating report ${params.reportId} (${params.version})`);
  }

  async saveReport(params: {
    reportId: string;
    report: BenchmarkReportDisplay;
    compiledComponents: ReadonlyMap<string, SavedComponent>;
  }): Promise<void> {
    const reportPath = join(this.outputDir, `${params.reportId}.json`);
    writeFileSync(reportPath, JSON.stringify(params.report, null, 2));
    console.log(`[storage] Report saved to ${reportPath}`);

    for (const [commitId, { source, compiled, contractFeedback }] of params.compiledComponents) {
      const compDir = join(this.outputDir, params.reportId, commitId);
      mkdirSync(compDir, { recursive: true });
      writeFileSync(join(compDir, 'source.tsx'), source);
      writeFileSync(join(compDir, 'compiled.js'), compiled);
      if (contractFeedback !== undefined) {
        writeFileSync(join(compDir, SOURCE_BEFORE_ROUND_FILE), contractFeedback.sourceBefore);
        writeFileSync(
          join(compDir, CONTRACT_FEEDBACK_FILE),
          JSON.stringify({ firedOn: contractFeedback.firedOn }, null, 2),
        );
      }
    }
  }

  async updateStatus(params: {
    reportId: string;
    status: 'completed' | 'failed';
    error?: string;
  }): Promise<void> {
    if (params.status === 'failed') {
      console.error(`[storage] Report ${params.reportId} failed: ${params.error}`);
    } else {
      console.log(`[storage] Report ${params.reportId} completed`);
    }
  }
}
