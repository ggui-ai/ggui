/**
 * Two-axis region model:
 *
 * - `Market` is user-facing. Drives Discover visibility, editorial curation,
 *   and compliance copy. Users see flags / country names, never AWS regions.
 * - `ServingRegion` is infra-facing. Drives compute, storage, routing, and
 *   residency. Surfaced in UI only as "Data processed in {country}" when
 *   userMarket ≠ servingRegion locality, and only inside a details section.
 *
 * A `Thread` is pinned to a single `servingRegion` at creation time.
 * Write-once, immutable, enforced via DynamoDB conditional write.
 *
 * Do NOT use ad-hoc strings for either axis in app code — import from here.
 */

export const MARKETS = ['KR', 'JP', 'US', 'GLOBAL'] as const;
export type Market = (typeof MARKETS)[number];

export const SERVING_REGIONS = [
  'ap-northeast-2', // Seoul
  'ap-northeast-1', // Tokyo
  'us-east-1', // N. Virginia
] as const;
export type ServingRegion = (typeof SERVING_REGIONS)[number];

export function isMarket(value: unknown): value is Market {
  return typeof value === 'string' && (MARKETS as readonly string[]).includes(value);
}

export function isServingRegion(value: unknown): value is ServingRegion {
  return (
    typeof value === 'string' &&
    (SERVING_REGIONS as readonly string[]).includes(value)
  );
}

/**
 * Human-facing country display for a ServingRegion. Used only in the
 * "Data processed in {country}" disclosure on Agent Profile.
 */
export const SERVING_REGION_COUNTRY: Record<ServingRegion, string> = {
  'ap-northeast-2': 'South Korea',
  'ap-northeast-1': 'Japan',
  'us-east-1': 'United States',
};
