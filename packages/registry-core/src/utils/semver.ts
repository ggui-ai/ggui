/**
 * Local semver comparison — supports `MAJOR.MINOR.PATCH` + optional
 * `-pre.release` + (ignored) `+build.metadata`. Implemented locally to
 * avoid a `semver` runtime dep for the very narrow comparison
 * registry-core needs (decide whether a newly-published version is
 * the latest).
 *
 * Returns `-1` / `0` / `1` matching `Array.prototype.sort`. Pre-release
 * versions sort lower than the corresponding non-pre version
 * (`1.0.0-alpha < 1.0.0`) per semver.org. Build metadata is ignored.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (
    v: string,
  ): { core: [number, number, number]; pre: readonly (string | number)[] } => {
    const [coreAndPre] = v.split('+');
    const [core, pre = ''] = (coreAndPre ?? '').split('-');
    const [maj = '0', min = '0', pat = '0'] = (core ?? '').split('.');
    return {
      core: [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10)],
      pre:
        pre.length === 0
          ? []
          : pre.split('.').map((seg) => {
              const n = Number(seg);
              return Number.isInteger(n) && /^[0-9]+$/.test(seg) ? n : seg;
            }),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const av = pa.core[i] ?? 0;
    const bv = pb.core[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  if (pa.pre.length === 0 && pb.pre.length > 0) return 1;
  if (pa.pre.length > 0 && pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const av = pa.pre[i];
    const bv = pb.pre[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av < bv) return -1;
      if (av > bv) return 1;
    } else if (typeof av === 'number') {
      return -1;
    } else if (typeof bv === 'number') {
      return 1;
    } else if (av < bv) {
      return -1;
    } else if (av > bv) {
      return 1;
    }
  }
  return 0;
}
