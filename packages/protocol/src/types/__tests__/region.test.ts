import { describe, it, expect } from 'vitest';
import {
  MARKETS,
  SERVING_REGIONS,
  SERVING_REGION_COUNTRY,
  isMarket,
  isServingRegion,
  type Market,
  type ServingRegion,
} from '../region';

describe('region types', () => {
  it('MARKETS includes exactly the launch-supported set', () => {
    expect([...MARKETS].sort()).toEqual(['GLOBAL', 'JP', 'KR', 'US']);
  });

  it('SERVING_REGIONS includes exactly the launch-supported set', () => {
    expect([...SERVING_REGIONS].sort()).toEqual([
      'ap-northeast-1',
      'ap-northeast-2',
      'us-east-1',
    ]);
  });

  it('isMarket validates correctly', () => {
    expect(isMarket('KR')).toBe(true);
    expect(isMarket('GLOBAL')).toBe(true);
    expect(isMarket('FR')).toBe(false);
    expect(isMarket(null)).toBe(false);
    expect(isMarket(undefined)).toBe(false);
    expect(isMarket(42)).toBe(false);
  });

  it('isServingRegion validates correctly', () => {
    expect(isServingRegion('ap-northeast-2')).toBe(true);
    expect(isServingRegion('eu-west-1')).toBe(false);
    expect(isServingRegion(null)).toBe(false);
    expect(isServingRegion('')).toBe(false);
  });

  it('SERVING_REGION_COUNTRY covers every ServingRegion', () => {
    for (const region of SERVING_REGIONS) {
      expect(SERVING_REGION_COUNTRY[region]).toBeTruthy();
      expect(typeof SERVING_REGION_COUNTRY[region]).toBe('string');
    }
  });

  it('Market type accepts the four launch values', () => {
    const a: Market = 'KR';
    const b: Market = 'JP';
    const c: Market = 'US';
    const d: Market = 'GLOBAL';
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('ServingRegion type accepts the three launch values', () => {
    const a: ServingRegion = 'ap-northeast-2';
    const b: ServingRegion = 'ap-northeast-1';
    const c: ServingRegion = 'us-east-1';
    expect([a, b, c]).toHaveLength(3);
  });
});
