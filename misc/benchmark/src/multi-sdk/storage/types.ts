import type { BenchmarkReportDisplay } from '@ggui-ai/shared';
import type { ContractFeedbackRecord } from '@ggui-ai/ui-gen/evaluation';

/**
 * One cell's saved component: the final source and bundle, plus — only on
 * cells where the harness's contract-feedback round fired — the record of
 * that round (`sourceBefore` = the component as it stood when the model was
 * told; `source` above is the after). Saved beside the component so a
 * before/after read of the round needs nothing but the cell's directory.
 */
export interface SavedComponent {
  readonly source: string;
  readonly compiled: string;
  readonly contractFeedback?: ContractFeedbackRecord;
}

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
    compiledComponents: ReadonlyMap<string, SavedComponent>;
  }): Promise<void>;

  /** Update report status (e.g., running → completed or failed) */
  updateStatus(params: {
    reportId: string;
    status: 'completed' | 'failed';
    error?: string;
  }): Promise<void>;
}
