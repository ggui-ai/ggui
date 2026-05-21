import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { BenchmarkReportDisplay } from '@ggui-ai/shared';
import type { JsonObject } from '@ggui-ai/protocol';
import type { BenchmarkStorage } from './types.js';

/**
 * CloudStorage — writes benchmark reports to S3 + updates DynamoDB via data client.
 * Used by the Lambda runner.
 */
export class CloudStorage implements BenchmarkStorage {
  private s3: S3Client;
  private readonly prefix: string;

  constructor(
    private readonly bucket: string,
    private readonly dataClient: {
      models: {
        BenchmarkReport: {
          create: (input: JsonObject) => Promise<unknown>;
          update: (input: JsonObject) => Promise<unknown>;
        };
      };
    },
    options?: { prefix?: string },
  ) {
    this.s3 = new S3Client({});
    this.prefix = options?.prefix ? `${options.prefix}/` : '';
  }

  async createReport(params: {
    reportId: string;
    status: 'running';
    version: string;
    trigger: 'manual' | 'nightly' | 'ci';
  }): Promise<void> {
    await this.dataClient.models.BenchmarkReport.create({
      reportId: params.reportId,
      timestamp: new Date().toISOString(),
      status: params.status,
      visibility: 'hidden',
      trigger: params.trigger,
      version: params.version,
    });
  }

  async saveReport(params: {
    reportId: string;
    report: BenchmarkReportDisplay;
    compiledComponents: Map<string, { source: string; compiled: string }>;
  }): Promise<void> {
    const s3Key = `${this.prefix}reports/${params.reportId}.json`;

    // Upload full report JSON to S3
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: JSON.stringify(params.report),
        ContentType: 'application/json',
      }),
    );

    // Upload compiled components to S3
    // Key format: "variantId/commitId" to avoid collisions across variants
    for (const [key, { source, compiled }] of params.compiledComponents) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}components/${params.reportId}/${key}/source.tsx`,
          Body: source,
          ContentType: 'text/typescript',
        }),
      );
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}components/${params.reportId}/${key}/compiled.js`,
          Body: compiled,
          ContentType: 'application/javascript',
        }),
      );
    }

    // Update DynamoDB with denormalized metadata
    await this.dataClient.models.BenchmarkReport.update({
      reportId: params.reportId,
      status: 'completed',
      s3Key,
      totalVariants: params.report.meta.totalVariants,
      totalCommits: params.report.meta.totalCommits,
      totalRuns: params.report.meta.totalRuns,
      successRate: params.report.meta.successRate,
      durationMs: params.report.meta.durationMs,
      variants: JSON.stringify(params.report.variantSummaries),
      commits: JSON.stringify(params.report.commitSummaries),
    });
  }

  async updateStatus(params: {
    reportId: string;
    status: 'completed' | 'failed';
    error?: string;
  }): Promise<void> {
    const update: JsonObject = {
      reportId: params.reportId,
      status: params.status,
    };
    if (params.error) {
      update.error = params.error;
    }
    await this.dataClient.models.BenchmarkReport.update(update);
  }
}
