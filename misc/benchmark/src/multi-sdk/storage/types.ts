import type { BenchmarkReportDisplay } from '@ggui-ai/shared';

/**
 * Storage interface for benchmark reports.
 * Implemented by LocalStorage (the CLI runner). Publishing to S3 is a
 * separate concern handled by `scripts/run-and-publish.mjs`.
 */
export interface BenchmarkStorage {
  /** Create a new report entry with initial status */
  createReport(params: {
    reportId: string;
    status: 'running';
    version: string;
    trigger: 'manual' | 'nightly' | 'ci';
  }): Promise<void>;

  /** Save completed report (full JSON + compiled components) */
  saveReport(params: {
    reportId: string;
    report: BenchmarkReportDisplay;
    compiledComponents: Map<string, { source: string; compiled: string }>;
  }): Promise<void>;

  /** Update report status (e.g., running → completed or failed) */
  updateStatus(params: {
    reportId: string;
    status: 'completed' | 'failed';
    error?: string;
  }): Promise<void>;
}
