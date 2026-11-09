// Waits until a published package version is installable from the public
// npm registry, as a user's `npm install` would find it.
//
// `npm publish` returns before the registry makes the version visible: the
// registry ingests each publish asynchronously, and `time[<version>]` in the
// packument records when the version became visible, not when it was
// published. Publishing a wave in dependency order therefore does not make
// it visible in that order. The release workflow calls this before
// publishing each package, for the packages that package depends on, so a
// dependent never becomes visible before its dependencies.
//
// A version counts as installable after four reads, in this order:
//   1. its version document answers 200. That endpoint is not cached at the
//      edge, so it reads the registry's own state;
//   2. its tarball answers 200 at a cache-busted URL. The query string is
//      part of the edge's cache key, so a probe never touches the entry a
//      user's install reads, and every attempt uses a key never used before.
//      A probe answered from the edge cache (HIT) still passes, since the
//      tarball is there, and is recorded as a finding: a HIT on a key never
//      used before means the probe did not reach past the edge;
//   3. one GET of the canonical tarball URL answers 200. If it does not, the
//      wait continues on that URL and records the delay as a finding;
//   4. the packument (cache-busted) carries `time[<version>]`, and its
//      `cache-control: max-age` says how long an edge may keep serving a
//      copy that predates the version.
// The version is then SETTLED at `time[<version>] + max-age`: from that
// instant no edge can still serve a packument without it. A dependent
// published after its dependencies have settled cannot become visible
// before them anywhere. `time` is on the registry's clock and the wait runs
// on the runner's, so the settle instant is moved onto the runner's clock by
// the difference the packument's `date` header shows. A packument without
// one settles DATE_MARGIN_S late instead, and says so.
//
//   node npm-visibility.mjs deps  <packages-root> <dir>    --probe P --state F [--version V]
//   node npm-visibility.mjs all   <packages-root> <dir>... --probe P --state F [--version V]
//   node npm-visibility.mjs plant <packages-root> <dir>    --state F [--version V]
//   node npm-visibility.mjs report --state F
//
// Each package's version is the one in its package.json under the packages
// root, which is the version pnpm writes into a dependent's `workspace:*`
// pin at publish time. `--version` overrides it for every package, for a
// checkout whose package.json files carry a different version than the one
// published (a prerelease channel rewrites them only on the publishing
// runner).
// `deps` waits for, then settles, the internal dependencies of one package
// (the definition in publish-order.mjs); `all` does the same for the listed
// packages themselves. Waits already recorded in the state file are not
// repeated. `plant` makes one early GET of a package's canonical tarball
// URL, right after its publish, so the wave measures whether an early ask
// delays that URL. `report` renders the state as a Markdown table.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readPublishSet } from "./publish-order.mjs";

export const REGISTRY = "https://registry.npmjs.org";
export const DEFAULT_MAX_AGE_S = 300;
export const DATE_MARGIN_S = 30;

const STEP_LABEL = {
  version: "version document",
  probe: "tarball probe",
  canonical: "canonical tarball",
  packument: "packument",
};

/** The registry URLs read for `name@version`. */
export function registryUrls(name, version) {
  const encoded = name.replace("/", "%2F");
  const bare = name.split("/").pop();
  return {
    versionDoc: `${REGISTRY}/${encoded}/${version}`,
    packument: `${REGISTRY}/${encoded}`,
    tarball: `${REGISTRY}/${name}/-/${bare}-${version}.tgz`,
  };
}

/** `max-age` in seconds from a cache-control header, or null. */
export function maxAgeSeconds(cacheControl) {
  const match = /(?:^|[,\s])max-age=(\d+)/.exec(cacheControl ?? "");
  return match ? Number(match[1]) : null;
}

/** One registry read over the network: status, edge cache status, cache-control, date, and a JSON body when asked for. */
export async function fetchHttp(url, { method = "GET", json = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: json ? { accept: "application/json" } : {},
      redirect: "follow",
    });
  } catch (error) {
    // A network failure is an answer for this attempt (status 0), and the wait polls again.
    return {
      status: 0,
      cache: null,
      cacheControl: null,
      date: null,
      body: null,
      error: String(error),
    };
  }
  let body = null;
  if (method !== "HEAD") {
    if (res.ok && json) body = await res.json();
    else await res.arrayBuffer();
  }
  return {
    status: res.status,
    cache: res.headers.get("cf-cache-status"),
    cacheControl: res.headers.get("cache-control"),
    date: res.headers.get("date"),
    body,
  };
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Waits until `name@version` is installable (steps 1–4 above) and returns
 * what it read: every attempt, `publishedAt` (npm `time`), `maxAgeS`,
 * `registryOffsetMs` (how far the registry's clock runs ahead of the
 * runner's, or null without a date header), `settleAt` (ms, on the runner's
 * clock) and any findings. Throws past `budgetMs`.
 */
export async function waitVisible({
  name,
  version,
  probe,
  http = fetchHttp,
  clock = realClock,
  intervalMs = 10_000,
  budgetMs = 30 * 60_000,
  log = () => {},
}) {
  const urls = registryUrls(name, version);
  const bare = name.split("/").pop();
  const deadline = clock.now() + budgetMs;
  const attempts = [];
  const findings = [];
  let probeCount = 0;

  async function poll(step, request, isDone) {
    for (;;) {
      const { url, ...opts } = request();
      const res = await http(url, opts);
      const attempt = { step, status: res.status, cache: res.cache ?? null, at: clock.now() };
      attempts.push(attempt);
      log(
        `${name}@${version} ${STEP_LABEL[step]} ${res.status} (cf ${attempt.cache ?? "none"})${res.error ? ` ${res.error}` : ""}`
      );
      if (isDone(res, attempt)) return res;
      if (clock.now() >= deadline) {
        throw new Error(
          `${name}@${version} is not installable after ${Math.round(budgetMs / 1000)} s: ${STEP_LABEL[step]} answered ${res.status}`
        );
      }
      await clock.sleep(intervalMs);
    }
  }
  const probed = (base) => {
    probeCount += 1;
    return `${base}?probe=${encodeURIComponent(`${probe}-${bare}-${probeCount}`)}`;
  };

  await poll(
    "version",
    () => ({ url: urls.versionDoc, json: true }),
    (res) => res.status === 200
  );

  await poll(
    "probe",
    () => ({ url: probed(urls.tarball), method: "HEAD" }),
    (res, attempt) => {
      if (res.status !== 200) return false;
      if (attempt.cache === "HIT") {
        findings.push(
          `tarball probe for ${name}@${version} answered from the edge cache (HIT) on a never-used key`
        );
      }
      return true;
    }
  );

  let firstCanonical = true;
  await poll(
    "canonical",
    () => ({ url: urls.tarball }),
    (res, attempt) => {
      if (res.status !== 200 && firstCanonical) {
        findings.push(
          `canonical tarball answered ${res.status} (cf ${attempt.cache ?? "none"}) after the probe answered 200`
        );
      }
      firstCanonical = false;
      return res.status === 200;
    }
  );

  let packumentAt = null;
  const packument = await poll(
    "packument",
    () => ({ url: probed(urls.packument), json: true }),
    (res, attempt) => {
      packumentAt = attempt.at;
      return res.status === 200 && typeof res.body?.time?.[version] === "string";
    }
  );
  const publishedAt = packument.body.time[version];
  let maxAgeS = maxAgeSeconds(packument.cacheControl);
  if (maxAgeS === null) {
    findings.push(
      `packument cache-control "${packument.cacheControl ?? ""}" carries no max-age; settling on ${DEFAULT_MAX_AGE_S} s`
    );
    maxAgeS = DEFAULT_MAX_AGE_S;
  }
  // The date header is whole seconds, rounded down, so it can only make the
  // registry look further behind than it is: the settle errs late, never early.
  const registryDate = Date.parse(packument.date ?? "");
  let registryOffsetMs = null;
  let clockShiftMs;
  if (Number.isNaN(registryDate)) {
    findings.push(`packument carries no date header; settling ${DATE_MARGIN_S} s late`);
    clockShiftMs = DATE_MARGIN_S * 1000;
  } else {
    registryOffsetMs = registryDate - packumentAt;
    clockShiftMs = -registryOffsetMs;
  }
  return {
    name,
    version,
    attempts,
    publishedAt,
    maxAgeS,
    registryOffsetMs,
    settleAt: Date.parse(publishedAt) + maxAgeS * 1000 + clockShiftMs,
    findings,
  };
}

/** One GitHub `::warning::` annotation per finding, so a finding shows on the run page as well as in the step summary. */
export function findingAnnotations(key, record) {
  return record.findings.map((finding) => `::warning::${key}: ${finding}`);
}

/** Sleeps until the latest `settleAt` among `records`; returns the ms waited. */
export async function settle(records, clock = realClock) {
  const target = Math.max(-Infinity, ...records.map((r) => r.settleAt));
  const wait = Math.max(0, target - clock.now());
  if (wait > 0) await clock.sleep(wait);
  return wait;
}

function counted(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([v, n]) => `${v}×${n}`).join(", ");
}

function statusRun(attempts) {
  if (attempts.length === 0) return "—";
  const first = attempts[0].status;
  const last = attempts.at(-1).status;
  return `${first === last ? first : `${first}→${last}`} (${attempts.length})`;
}

/** The state file as Markdown: one row per package, findings, and the control comparison. */
export function renderReport({ records = {}, planted = {} }) {
  const lines = [
    "| package | version document | tarball probe (cf) | canonical tarball | npm time | max-age | settles at |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const findings = [];
  for (const [key, r] of Object.entries(records)) {
    const of = (step) => r.attempts.filter((a) => a.step === step);
    lines.push(
      `| \`${key}\` | 200 after ${of("version").length} | ${counted(of("probe").map((a) => a.cache ?? "none"))} | ${statusRun(of("canonical"))} | ${r.publishedAt} | ${r.maxAgeS} s | ${new Date(r.settleAt).toISOString()} |`
    );
    for (const f of r.findings) findings.push(`- \`${key}\`: ${f}`);
  }
  const out = [lines.join("\n")];
  if (findings.length > 0) out.push(["**Findings**", ...findings].join("\n"));
  for (const [key, p] of Object.entries(planted)) {
    const r = records[key];
    const probe200 = r?.attempts.find((a) => a.step === "probe" && a.status === 200);
    const canonical200 = r?.attempts.find((a) => a.step === "canonical" && a.status === 200);
    const lag =
      probe200 && canonical200
        ? `canonical 200 came ${Math.round((canonical200.at - probe200.at) / 1000)} s after the probe's 200`
        : "no completed wait recorded for it";
    out.push(
      `**Control** \`${key}\`: early canonical ask at ${new Date(p.at).toISOString()} answered ${p.status} (cf ${p.cache ?? "none"}); ${lag}.`
    );
  }
  return out.join("\n\n") + "\n";
}

function loadState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { records: {}, planted: {} };
}

/** One line of normal output on stdout. */
const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: "string" }, probe: { type: "string" }, state: { type: "string" } },
  });
  const [command, packagesRoot, ...dirs] = positionals;
  if (!values.state) throw new Error("--state <file> is required");
  const state = loadState(values.state);
  const save = () => writeFileSync(values.state, JSON.stringify(state, null, 2));

  if (command === "report") {
    process.stdout.write(renderReport(state));
    return;
  }
  if (!["deps", "all", "plant"].includes(command) || !packagesRoot || dirs.length === 0) {
    throw new Error(
      "usage: npm-visibility.mjs deps|all|plant <packages-root> <dir>... [--probe P] --state F [--version V] | report --state F"
    );
  }
  const set = readPublishSet(packagesRoot);
  const pkgOf = (dir) => {
    const pkg = set.get(dir);
    if (!pkg) throw new Error(`${dir} is not a publishable package under ${packagesRoot}`);
    return pkg;
  };
  const byName = new Map([...set.values()].map((pkg) => [pkg.name, pkg]));
  const versionOf = (name) => {
    if (values.version) return values.version;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`${name} is not a publishable package under ${packagesRoot}`);
    return pkg.version;
  };
  const key = (name) => `${name}@${versionOf(name)}`;

  if (command === "plant") {
    for (const dir of dirs) {
      const { name } = pkgOf(dir);
      const res = await fetchHttp(registryUrls(name, versionOf(name)).tarball);
      state.planted[key(name)] = { status: res.status, cache: res.cache, at: Date.now() };
      save();
      say(`${key(name)} early canonical tarball ask: ${res.status} (cf ${res.cache ?? "none"})`);
    }
    return;
  }

  if (!values.probe) throw new Error("--probe <prefix> is required");
  const names = command === "deps" ? pkgOf(dirs[0]).deps : dirs.map((dir) => pkgOf(dir).name);
  for (const name of names) {
    if (state.records[key(name)]) continue;
    state.records[key(name)] = await waitVisible({
      name,
      version: versionOf(name),
      probe: values.probe,
      log: (line) => say(line),
    });
    save();
    for (const line of findingAnnotations(key(name), state.records[key(name)])) say(line);
  }
  const waited = await settle(names.map((name) => state.records[key(name)]));
  say(
    names.length === 0
      ? `${command === "deps" ? dirs[0] : "nothing"}: no internal dependencies to wait for`
      : `${names.length} package(s) installable and settled${waited > 0 ? ` after a further ${Math.round(waited / 1000)} s` : ""}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
