import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findingAnnotations,
  maxAgeSeconds,
  registryUrls,
  renderReport,
  settle,
  waitVisible,
} from "./npm-visibility.mjs";

const T0 = Date.parse("2026-11-09T00:00:00.000Z");

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let now = T0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

/**
 * A registry for one version of each named package. `pkgs[name]` sets when,
 * after T0, the version document answers 200 (`docAt`), when the tarball
 * exists at the origin (`tarballAt`), the packument's `time[version]`
 * (`publishedAt`, an offset) and its `cacheControl`. With `negativeCacheMs`
 * set, the canonical tarball URL behaves like an edge that caches a 404:
 * once asked before the tarball exists, it keeps answering 404 until that
 * many ms after the first ask. A query-string URL that has answered 200
 * once answers HIT afterwards, as the edge does. Every answer carries the
 * registry's `date` header at one-second resolution, from a registry clock
 * `registryOffsetMs` ahead of the runner's (negative: behind), unless
 * `dateHeader` is false.
 */
function fakeRegistry(
  clock,
  pkgs,
  { negativeCacheMs = 0, registryOffsetMs = 0, dateHeader = true } = {}
) {
  const requests = [];
  const firstCanonicalAsk = new Map();
  const seen200 = new Set();
  const http = async (url, opts) => {
    const res = await answer(url, opts);
    const date = dateHeader ? new Date(clock.now() + registryOffsetMs).toUTCString() : null;
    return { ...res, date };
  };
  const answer = async (url, { method = "GET" } = {}) => {
    requests.push({ url, method, at: clock.now() });
    const t = clock.now() - T0;
    const u = new URL(url);
    const probe = u.searchParams.has("probe");
    const path = decodeURIComponent(u.pathname);
    const name = Object.keys(pkgs).find((n) => path === `/${n}` || path.startsWith(`/${n}/`));
    if (!name) return { status: 404, cache: null, cacheControl: null, body: null };
    const p = pkgs[name];
    const cacheOf = () => {
      if (!probe) return "HIT";
      if (seen200.has(url)) return "HIT";
      return "MISS";
    };
    if (path.endsWith(".tgz")) {
      if (!probe) {
        if (!firstCanonicalAsk.has(name)) firstCanonicalAsk.set(name, t);
        const first = firstCanonicalAsk.get(name);
        const pinned = negativeCacheMs > 0 && first < p.tarballAt && t < first + negativeCacheMs;
        if (pinned || t < p.tarballAt)
          return { status: 404, cache: pinned ? "HIT" : null, cacheControl: null, body: null };
        return { status: 200, cache: "HIT", cacheControl: "public, max-age=31557600", body: null };
      }
      if (t < p.tarballAt) return { status: 404, cache: null, cacheControl: null, body: null };
      const cache = cacheOf();
      seen200.add(url);
      return { status: 200, cache, cacheControl: "public, max-age=31557600", body: null };
    }
    if (path === `/${name}/${p.version}`) {
      return t < p.docAt
        ? { status: 404, cache: null, cacheControl: null, body: null }
        : { status: 200, cache: "DYNAMIC", cacheControl: null, body: null };
    }
    // the full packument
    const time = t < p.docAt ? {} : { [p.version]: new Date(T0 + p.publishedAt).toISOString() };
    const cache = cacheOf();
    seen200.add(url);
    return {
      status: 200,
      cache,
      cacheControl: p.cacheControl ?? "public, max-age=300",
      body: { time },
    };
  };
  return { http, requests };
}

const UI_GEN = { version: "1.2.0", docAt: 40_000, tarballAt: 40_000, publishedAt: 38_000 };

test("registryUrls: scoped name encodes in the document paths and stays plain in the tarball path", () => {
  const urls = registryUrls("@ggui-ai/ui-gen", "1.2.0");
  assert.equal(urls.versionDoc, "https://registry.npmjs.org/@ggui-ai%2Fui-gen/1.2.0");
  assert.equal(urls.packument, "https://registry.npmjs.org/@ggui-ai%2Fui-gen");
  assert.equal(urls.tarball, "https://registry.npmjs.org/@ggui-ai/ui-gen/-/ui-gen-1.2.0.tgz");
});

test("maxAgeSeconds: reads max-age out of a cache-control header", () => {
  assert.equal(maxAgeSeconds("public, max-age=300"), 300);
  assert.equal(maxAgeSeconds("max-age=0, must-revalidate"), 0);
  assert.equal(maxAgeSeconds("public, s-maxage=60"), null);
  assert.equal(maxAgeSeconds(null), null);
});

test("waitVisible: version document, then a fresh-keyed tarball probe, then one canonical GET, then the packument for npm time and max-age", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": UI_GEN });
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http: reg.http,
    clock,
    intervalMs: 10_000,
  });

  assert.equal(r.publishedAt, new Date(T0 + 38_000).toISOString());
  assert.equal(r.maxAgeS, 300);
  assert.equal(r.settleAt, T0 + 38_000 + 300_000);
  assert.deepEqual(r.findings, []);

  // The canonical tarball URL is asked exactly once, and only after a probe answered 200.
  const canonical = reg.requests.filter((q) => q.url.endsWith(".tgz"));
  assert.equal(canonical.length, 1);
  const probes = reg.requests.filter((q) => q.url.includes(".tgz?probe="));
  assert.ok(probes.length >= 1);
  assert.ok(canonical[0].at >= probes.at(-1).at);
  // Every probe uses a key it has never used before.
  assert.equal(new Set(probes.map((q) => q.url)).size, probes.length);
  // No tarball URL of either kind is asked before the version document answers 200.
  const firstDoc200 = r.attempts.find((a) => a.step === "version" && a.status === 200).at;
  assert.ok(reg.requests.filter((q) => q.url.includes(".tgz")).every((q) => q.at >= firstDoc200));
});

test("waitVisible: while the tarball is still missing, every probe attempt uses a key never used before", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": { ...UI_GEN, tarballAt: 95_000 } });
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http: reg.http,
    clock,
  });
  const probes = reg.requests.filter((q) => q.url.includes(".tgz?probe="));
  assert.ok(probes.length >= 5, `expected repeated probes, saw ${probes.length}`);
  assert.equal(new Set(probes.map((q) => q.url)).size, probes.length);
  assert.ok(r.attempts.filter((a) => a.step === "probe").every((a) => a.cache !== "HIT"));
});

test("waitVisible: a probe answered from the edge cache passes, since the tarball is there, and is recorded as a finding", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": UI_GEN });
  const http = async (url, opts) => {
    const res = await reg.http(url, opts);
    return url.includes(".tgz?probe=") ? { ...res, cache: "HIT" } : res;
  };
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http,
    clock,
  });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /tarball probe .* answered from the edge cache \(HIT\)/);
  assert.equal(r.settleAt, T0 + 38_000 + 300_000);
});

test("waitVisible: a canonical tarball that still answers 404 after the probe answered 200 is waited for and recorded as a finding", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": UI_GEN }, { negativeCacheMs: 300_000 });
  // Plant an early canonical ask, as the control package's publish step does.
  await clock.sleep(5_000);
  await reg.http(registryUrls("@ggui-ai/ui-gen", "1.2.0").tarball);
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http: reg.http,
    clock,
  });
  const canon = r.attempts.filter((a) => a.step === "canonical");
  assert.equal(canon[0].status, 404);
  assert.equal(canon.at(-1).status, 200);
  assert.ok(canon.at(-1).at >= T0 + 5_000 + 300_000);
  assert.match(
    r.findings[0],
    /canonical tarball answered 404 \(cf HIT\) after the probe answered 200/
  );
});

test("waitVisible: a packument without max-age settles on the default and says so", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": { ...UI_GEN, cacheControl: "public" } });
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http: reg.http,
    clock,
  });
  assert.equal(r.maxAgeS, 300);
  assert.match(r.findings[0], /cache-control "public" carries no max-age; settling on 300 s/);
});

test("waitVisible: past the budget it throws, naming the step it was stuck on and the last answer", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": { ...UI_GEN, docAt: 10 * 60_000 } });
  await assert.rejects(
    waitVisible({
      name: "@ggui-ai/ui-gen",
      version: "1.2.0",
      probe: "run7",
      http: reg.http,
      clock,
      budgetMs: 60_000,
    }),
    /@ggui-ai\/ui-gen@1\.2\.0 is not installable after 60 s: version document answered 404/
  );
});

test("waitVisible: settles on the runner's clock, shifted by how far it runs ahead of the registry's", async () => {
  for (const [registryOffsetMs, expected] of [
    [-20_000, T0 + 38_000 + 300_000 + 20_000],
    [15_000, T0 + 38_000 + 300_000 - 15_000],
  ]) {
    const clock = fakeClock();
    const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": UI_GEN }, { registryOffsetMs });
    const r = await waitVisible({
      name: "@ggui-ai/ui-gen",
      version: "1.2.0",
      probe: "run7",
      http: reg.http,
      clock,
    });
    assert.equal(r.settleAt, expected, `registry offset ${registryOffsetMs} ms`);
    assert.equal(r.registryOffsetMs, registryOffsetMs);
    assert.deepEqual(r.findings, []);
  }
});

test("waitVisible: a packument without a date header settles with a fixed margin and says so", async () => {
  const clock = fakeClock();
  const reg = fakeRegistry(clock, { "@ggui-ai/ui-gen": UI_GEN }, { dateHeader: false });
  const r = await waitVisible({
    name: "@ggui-ai/ui-gen",
    version: "1.2.0",
    probe: "run7",
    http: reg.http,
    clock,
  });
  assert.equal(r.settleAt, T0 + 38_000 + 300_000 + 30_000);
  assert.equal(r.registryOffsetMs, null);
  assert.match(r.findings[0], /no date header; settling 30 s late/);
});

test("findingAnnotations: one ::warning:: line per finding, naming the package", () => {
  assert.deepEqual(findingAnnotations("@ggui-ai/ui-gen@1.2.0", { findings: ["a", "b"] }), [
    "::warning::@ggui-ai/ui-gen@1.2.0: a",
    "::warning::@ggui-ai/ui-gen@1.2.0: b",
  ]);
  assert.deepEqual(findingAnnotations("@ggui-ai/ui-gen@1.2.0", { findings: [] }), []);
});

test("settle: waits until the latest settle instant among the records, and not at all once it has passed", async () => {
  const clock = fakeClock();
  const waited = await settle([{ settleAt: T0 + 90_000 }, { settleAt: T0 + 300_000 }], clock);
  assert.equal(waited, 300_000);
  assert.equal(clock.now(), T0 + 300_000);
  assert.equal(await settle([{ settleAt: T0 + 1 }], clock), 0);
  assert.equal(await settle([], clock), 0);
});

test("renderReport: one row per package, the probe cache column, findings, and the control comparison", () => {
  const md = renderReport({
    records: {
      "@ggui-ai/ui-gen@1.2.0": {
        name: "@ggui-ai/ui-gen",
        version: "1.2.0",
        attempts: [
          { step: "version", status: 404, cache: null, at: T0 },
          { step: "version", status: 200, cache: "DYNAMIC", at: T0 + 10_000 },
          { step: "probe", status: 200, cache: "MISS", at: T0 + 10_000 },
          { step: "canonical", status: 404, cache: "HIT", at: T0 + 10_000 },
          { step: "canonical", status: 200, cache: "HIT", at: T0 + 250_000 },
        ],
        publishedAt: new Date(T0 + 8_000).toISOString(),
        maxAgeS: 300,
        settleAt: T0 + 308_000,
        findings: ["canonical tarball answered 404 (cf HIT) after the probe answered 200"],
      },
    },
    planted: { "@ggui-ai/ui-gen@1.2.0": { status: 404, cache: null, at: T0 + 1_000 } },
  });
  assert.match(md, /\| `@ggui-ai\/ui-gen@1\.2\.0` \| 200 after 2 \| MISS×1 \| 404→200 \(2\) \|/);
  assert.match(md, /canonical tarball answered 404/);
  assert.match(
    md,
    /early canonical ask .* answered 404 .* canonical 200 came 240 s after the probe's 200/
  );
});
