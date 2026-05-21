import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BenchmarkReportDisplay } from '@ggui-ai/shared';
import type { BenchmarkStorage } from './types.js';

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
    compiledComponents: Map<string, { source: string; compiled: string }>;
  }): Promise<void> {
    const reportPath = join(this.outputDir, `${params.reportId}.json`);
    writeFileSync(reportPath, JSON.stringify(params.report, null, 2));
    console.log(`[storage] Report saved to ${reportPath}`);

    for (const [commitId, { source, compiled }] of params.compiledComponents) {
      const compDir = join(this.outputDir, params.reportId, commitId);
      mkdirSync(compDir, { recursive: true });
      writeFileSync(join(compDir, 'source.tsx'), source);
      writeFileSync(join(compDir, 'compiled.js'), compiled);
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
