/**
 * Data source abstraction for the benchmark viewer.
 *
 * The viewer doesn't know or care WHERE its JSON lives. Pass it any
 * implementation of `BenchmarkDataSource` and the dashboard renders
 * against it — production points at a public S3 URL, local dev at a
 * static file server (`npx serve`), tests at an in-memory fixture.
 */

import type { BenchmarkIndex, BenchmarkReport, BenchmarkRunMeta } from './types';

export interface BenchmarkDataSource {
  /** Fetch the top-level index (list of available runs). */
  getIndex(): Promise<BenchmarkIndex>;
  /** Fetch a single multi-sdk report by date. `runMeta` is the index entry; the source uses `runMeta.multiSdk.reportPath` to resolve the URL. */
  getMultiSdkReport(runMeta: BenchmarkRunMeta): Promise<BenchmarkReport>;
}

/**
 * HTTP-URL-based data source.
 *
 * Resolves all paths against `baseUrl`. Works against:
 *   - public S3 bucket: `https://bench.ggui.ai/data/`
 *   - GitHub raw: `https://raw.githubusercontent.com/foo/bar/data/`
 *   - local static server: `http://localhost:8080/`
 *
 * `baseUrl` MUST end with a trailing slash for path resolution to compose correctly.
 */
/**
 * The href of a data set's run index, for the reader-facing "raw data" link.
 *
 * `base` is the directory the index lives in: absolute
 * (`https://example.com/data/`) or root-relative (`/data/`). A root-relative
 * base keeps the link on the page's own origin, which is what a reader
 * should cite. Like {@link httpJsonSource}, `base` MUST end with a slash.
 */
export function rawDataIndexHref(base: string): string {
  if (!base.endsWith('/')) {
    throw new Error(`rawDataIndexHref: base must end with a slash, got "${base}".`);
  }
  return `${base}index.json`;
}

export function httpJsonSource(baseUrl: string): BenchmarkDataSource {
  if (!baseUrl.endsWith('/')) {
    throw new Error(
      `httpJsonSource: baseUrl must end with a slash, got "${baseUrl}". This catches the path-resolution bug class early.`,
    );
  }

  return {
    async getIndex() {
      const res = await fetch(new URL('index.json', baseUrl).toString(), {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(
          `httpJsonSource: failed to fetch index.json (${res.status} ${res.statusText})`,
        );
      }
      return (await res.json()) as BenchmarkIndex;
    },

    async getMultiSdkReport(runMeta) {
      if (!runMeta.multiSdk) {
        throw new Error(
          `httpJsonSource: run ${runMeta.date} has no multi-sdk report — caller should not have invoked this`,
        );
      }
      const res = await fetch(new URL(runMeta.multiSdk.reportPath, baseUrl).toString(), {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(
          `httpJsonSource: failed to fetch ${runMeta.multiSdk.reportPath} (${res.status} ${res.statusText})`,
        );
      }
      return (await res.json()) as BenchmarkReport;
    },
  };
}
