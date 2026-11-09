import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  byDepth,
  checkPublishOrder,
  internalDeps,
  readPublishSet,
  releaseOrder,
} from "./publish-order.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** A packages root in a temp dir: { dir: package.json } → path. */
function tree(pkgs) {
  const root = mkdtempSync(join(tmpdir(), "publish-order-"));
  for (const [dir, pj] of Object.entries(pkgs)) {
    mkdirSync(join(root, dir));
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pj));
  }
  return root;
}

const BASE = {
  protocol: { name: "@ggui-ai/protocol", version: "1.0.0" },
  wire: {
    name: "@ggui-ai/wire",
    version: "1.0.0",
    dependencies: { "@ggui-ai/protocol": "workspace:*", zod: "^4" },
  },
  "ggui-cli": {
    name: "@ggui-ai/cli",
    version: "1.0.0",
    dependencies: { "@ggui-ai/wire": "workspace:*" },
    peerDependencies: { "@ggui-ai/protocol": "workspace:*" },
  },
  brand: { name: "@ggui-ai/brand", private: true, version: "0.0.0" },
  "not-a-package": null,
};

function baseTree() {
  const pkgs = { ...BASE };
  delete pkgs["not-a-package"];
  const root = tree(pkgs);
  mkdirSync(join(root, "not-a-package"));
  return root;
}

test("internalDeps: @ggui-ai/* names from dependencies and peerDependencies only, in that order, deduplicated", () => {
  assert.deepEqual(internalDeps(BASE["ggui-cli"]), ["@ggui-ai/wire", "@ggui-ai/protocol"]);
  assert.deepEqual(internalDeps(BASE.wire), ["@ggui-ai/protocol"]);
  assert.deepEqual(
    internalDeps({
      dependencies: { "@ggui-ai/a": "1" },
      peerDependencies: { "@ggui-ai/a": "1" },
      devDependencies: { "@ggui-ai/dev": "1" },
      optionalDependencies: { "@ggui-ai/opt": "1" },
    }),
    ["@ggui-ai/a"]
  );
  assert.deepEqual(internalDeps({}), []);
});

test("readPublishSet: skips private packages and directories without a package.json", () => {
  const root = baseTree();
  try {
    const set = readPublishSet(root);
    assert.deepEqual([...set.keys()].sort(), ["ggui-cli", "protocol", "wire"]);
    assert.deepEqual(set.get("ggui-cli"), {
      dir: "ggui-cli",
      name: "@ggui-ai/cli",
      version: "1.0.0",
      deps: ["@ggui-ai/wire", "@ggui-ai/protocol"],
      excludedFields: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPublishOrder: a dependency-first order passes", () => {
  const root = baseTree();
  try {
    assert.deepEqual(checkPublishOrder(["protocol", "wire", "ggui-cli"], readPublishSet(root)), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPublishOrder: a package listed before one it depends on is refused, naming both positions", () => {
  const root = baseTree();
  try {
    const problems = checkPublishOrder(["wire", "protocol", "ggui-cli"], readPublishSet(root));
    assert.deepEqual(problems, [
      "wire (position 1) depends on @ggui-ai/protocol, which is published later (position 2)",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPublishOrder: a dependency missing from the order, an unknown directory and a publishable package left out are each refused", () => {
  const root = baseTree();
  try {
    const problems = checkPublishOrder(["wire", "ggui-cli", "ghost"], readPublishSet(root));
    assert.deepEqual(problems, [
      "wire depends on @ggui-ai/protocol, which is not in the publish order",
      "ggui-cli depends on @ggui-ai/protocol, which is not in the publish order",
      "ghost is in the publish order but is not a publishable package",
      "protocol is a publishable package but is not in the publish order",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPublishOrder: an @ggui-ai/* entry in optionalDependencies or bundleDependencies is refused — the wait reads dependencies and peerDependencies only", () => {
  const root = tree({
    ...Object.fromEntries(Object.entries(BASE).filter(([, v]) => v)),
    wire: {
      ...BASE.wire,
      optionalDependencies: { "@ggui-ai/protocol": "workspace:*", fsevents: "^2" },
      bundleDependencies: ["@ggui-ai/protocol"],
    },
  });
  try {
    assert.deepEqual(checkPublishOrder(["protocol", "wire", "ggui-cli"], readPublishSet(root)), [
      "wire lists @ggui-ai/protocol in optionalDependencies; an internal dependency belongs in dependencies or peerDependencies",
      "wire lists @ggui-ai/protocol in bundleDependencies; an internal dependency belongs in dependencies or peerDependencies",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("byDepth: sorts by dependency depth, keeping the given order inside a depth", () => {
  const root = tree({
    ...Object.fromEntries(Object.entries(BASE).filter(([, v]) => v)),
    zeta: { name: "@ggui-ai/zeta", version: "1.0.0" },
    gadgets: {
      name: "@ggui-ai/gadgets",
      version: "1.0.0",
      peerDependencies: { "@ggui-ai/protocol": "workspace:*" },
    },
  });
  try {
    const set = readPublishSet(root);
    // depths: protocol 0, zeta 0, wire 1, gadgets 1, ggui-cli 2
    assert.deepEqual(byDepth(["protocol", "wire", "zeta", "ggui-cli", "gadgets"], set), [
      "protocol",
      "zeta",
      "wire",
      "gadgets",
      "ggui-cli",
    ]);
    // A dependency-first input stays dependency-first.
    assert.deepEqual(
      checkPublishOrder(byDepth(["protocol", "wire", "zeta", "ggui-cli", "gadgets"], set), set),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("releaseOrder: reads the ORDER array out of the release workflow text", () => {
  const yml = [
    "steps:",
    "  - run: |",
    "          ORDER=(",
    "            protocol",
    "            wire",
    "            ggui-cli",
    "          )",
    "          echo done",
  ].join("\n");
  assert.deepEqual(releaseOrder(yml), ["protocol", "wire", "ggui-cli"]);
  assert.throws(() => releaseOrder("no array here"), /no ORDER=\( array/);
});

test("the release workflow ORDER is dependency-first over the packages in this tree", () => {
  const yml = readFileSync(join(here, "..", "..", ".github", "workflows", "release.yml"), "utf8");
  const order = releaseOrder(yml);
  assert.ok(order.length > 20, `expected the full wave, read ${order.length} entries`);
  assert.deepEqual(checkPublishOrder(order, readPublishSet(join(here, ".."))), []);
});
