/**
 * ggui#1501: a shell whose content-hashed runtime bundle 404s retries the
 * bundle's unhashed twin ONCE, derived from the failed URL (same origin, same
 * path, `.<12 hex>` removed). A rolling deploy, a rollback or a replayed
 * envelope can name a hash no serving replica has; every replica serves the
 * unhashed name. A URL that is not the hashed runtime name gets no retry.
 */
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  gguiShellHtml,
  runtimeBundleHashedNameSource,
  runtimeBundlePlainTwin,
  type GguiRenderBootstrap,
} from "./mcp-apps.js";

const PLAIN = "iframe-runtime.js";
const HASH = "0123456789ab";

describe("runtimeBundlePlainTwin (ggui#1501)", () => {
  it("strips the content hash from a bare path, keeping the path", () => {
    expect(runtimeBundlePlainTwin(`/_ggui/iframe-runtime.${HASH}.js`, PLAIN)).toBe(
      "/_ggui/iframe-runtime.js"
    );
  });

  it("keeps an absolute URL on its own origin", () => {
    expect(
      runtimeBundlePlainTwin(`https://assets.example.com/_ggui/iframe-runtime.${HASH}.js`, PLAIN)
    ).toBe("https://assets.example.com/_ggui/iframe-runtime.js");
  });

  it("keeps a query and a fragment", () => {
    expect(
      runtimeBundlePlainTwin(`https://a.example/_ggui/iframe-runtime.${HASH}.js?v=2#x`, PLAIN)
    ).toBe("https://a.example/_ggui/iframe-runtime.js?v=2#x");
  });

  it("returns undefined for the unhashed name — control: nothing to retry", () => {
    expect(
      runtimeBundlePlainTwin("https://a.example/_ggui/iframe-runtime.js", PLAIN)
    ).toBeUndefined();
  });

  it("returns undefined for a foreign bundle that carries its own content hash", () => {
    expect(runtimeBundlePlainTwin(`https://cdn.example.com/app.${HASH}.js`, PLAIN)).toBeUndefined();
    expect(
      runtimeBundlePlainTwin(`https://cdn.example.com/x-iframe-runtime.${HASH}.js`, PLAIN)
    ).toBeUndefined();
  });

  it("returns undefined for a hash that is not 12 lowercase hex characters", () => {
    expect(runtimeBundlePlainTwin("/_ggui/iframe-runtime.0123456789a.js", PLAIN)).toBeUndefined();
    expect(runtimeBundlePlainTwin("/_ggui/iframe-runtime.0123456789abc.js", PLAIN)).toBeUndefined();
    expect(runtimeBundlePlainTwin("/_ggui/iframe-runtime.0123456789AB.js", PLAIN)).toBeUndefined();
  });

  it("escapes the plain name: its dot is a literal, not a wildcard", () => {
    // An unescaped `.js` would match `Xjs` here.
    expect(runtimeBundlePlainTwin(`/_ggui/iframe-runtime.${HASH}Xjs`, PLAIN)).toBeUndefined();
    expect(
      new RegExp(runtimeBundleHashedNameSource(PLAIN)).test(`/iframe-runtime.${HASH}Xjs`)
    ).toBe(false);
    expect(runtimeBundlePlainTwin(`/_ggui/iframe-runtimeXjs.${HASH}`, PLAIN)).toBeUndefined();
    expect(
      new RegExp(runtimeBundleHashedNameSource(PLAIN)).test(`/iframe-runtime.${HASH}.js`)
    ).toBe(true);
  });
});

const BOOTSTRAP = (runtimeUrl: string): GguiRenderBootstrap => ({
  runtimeUrl,
  slice: { sessionId: "s-1", appId: "app-1", runtimeUrl, codeUrl: "https://a.example/code/x.js" },
});

interface FakeScript {
  type: string;
  crossOrigin: string;
  src: string;
  tagName: string;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function fakeScript(attrs: Record<string, string> = {}): FakeScript {
  const s: FakeScript = {
    type: "",
    crossOrigin: "",
    src: "",
    tagName: "SCRIPT",
    attrs: { ...attrs },
    getAttribute: (name) => (name in s.attrs ? (s.attrs[name] ?? null) : null),
    setAttribute: (name, value) => {
      s.attrs[name] = value;
    },
  };
  return s;
}

/** Run every inline classic `<script>` of the shell except the meta one, as a browser would before the module tag. */
function runFallbackScript(html: string) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  const listeners: Array<(ev: { target: unknown }) => void> = [];
  const appended: FakeScript[] = [];
  const warned: string[] = [];
  const context = vm.createContext({
    window: {
      addEventListener: (type: string, fn: (ev: { target: unknown }) => void, capture: boolean) => {
        if (type === "error" && capture === true) listeners.push(fn);
      },
    },
    document: {
      createElement: () => fakeScript(),
      body: { appendChild: (el: FakeScript) => appended.push(el) },
    },
    console: { warn: (m: string) => warned.push(m) },
    globalThis: {},
  });
  for (const code of blocks) {
    if (code.includes("__GGUI_META__")) continue;
    vm.runInContext(code, context);
  }
  const fire = (target: unknown): void => listeners.forEach((fn) => fn({ target }));
  return { listeners, appended, warned, fire };
}

describe("gguiShellHtml runtime-bundle fallback (ggui#1501)", () => {
  const hashedUrl = `https://assets.example.com/_ggui/iframe-runtime.${HASH}.js`;

  it("without the option, the shell is byte-identical to today — control", () => {
    const before = gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface" });
    expect(before).toContain(
      `<script type="module" crossorigin="anonymous" src="${hashedUrl}"></script>`
    );
    expect(before).not.toContain('data-ggui-runtime="src"');
    expect(runFallbackScript(before).listeners).toHaveLength(0);
  });

  it("a hashed URL gets one capture listener that appends the twin, on the same origin, once", () => {
    const html = gguiShellHtml(BOOTSTRAP(hashedUrl), {
      background: "surface",
      runtimeBundlePlainName: PLAIN,
    });
    expect(html).toContain(
      `<script type="module" crossorigin="anonymous" data-ggui-runtime="src" src="${hashedUrl}"></script>`
    );
    const run = runFallbackScript(html);
    expect(run.listeners).toHaveLength(1);

    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(1);
    const twin = run.appended[0];
    expect(twin?.src).toBe("https://assets.example.com/_ggui/iframe-runtime.js");
    expect(twin?.type).toBe("module");
    expect(twin?.crossOrigin).toBe("anonymous");
    expect(twin?.getAttribute("data-ggui-runtime")).toBe("fallback");
    expect(run.warned).toHaveLength(1);

    // The twin failing too, or the original erroring again, appends nothing more.
    if (twin) run.fire(twin);
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(1);
  });

  it("an error on anything else (an image, an unmarked script) is ignored", () => {
    const run = runFallbackScript(
      gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", runtimeBundlePlainName: PLAIN })
    );
    run.fire({ tagName: "IMG", getAttribute: () => null });
    run.fire(fakeScript());
    run.fire(null);
    expect(run.appended).toHaveLength(0);
  });

  it("an unhashed or foreign URL gets no listener, even with the option", () => {
    for (const url of [
      "https://a.example/_ggui/iframe-runtime.js",
      `https://cdn.example.com/app.${HASH}.js`,
    ]) {
      const html = gguiShellHtml(BOOTSTRAP(url), {
        background: "surface",
        runtimeBundlePlainName: PLAIN,
      });
      expect(runFallbackScript(html).listeners).toHaveLength(0);
      expect(html).not.toContain('data-ggui-runtime="src"');
    }
  });

  it("an inlined runtime gets no listener: there is nothing to fetch", () => {
    const html = gguiShellHtml(BOOTSTRAP(hashedUrl), {
      background: "surface",
      runtimeBundlePlainName: PLAIN,
      runtimeInlineSource: "globalThis.__rt = 1;",
    });
    expect(runFallbackScript(html).listeners).toHaveLength(0);
  });

  it("the twin is embedded escaped: a hostile path cannot close the script element", () => {
    const hostile = `https://a.example/</script><b>/iframe-runtime.${HASH}.js`;
    const html = gguiShellHtml(BOOTSTRAP(hostile), {
      background: "surface",
      runtimeBundlePlainName: PLAIN,
    });
    // The whole document: a raw `</script><b>` can come only from an unescaped
    // twin (the meta slice is JSON-escaped, the module tag's src HTML-escaped),
    // and every element that opens a script closes exactly once.
    expect(html).not.toContain("</script><b>");
    expect(html.match(/<\/script/gi)?.length).toBe(html.match(/<script[\s>]/gi)?.length);
    // Executed: an unescaped `</script>` would cut the block short, and the vm
    // would throw on the fragment instead of appending the exact twin.
    const run = runFallbackScript(html);
    expect(run.listeners).toHaveLength(1);
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended[0]?.src).toBe("https://a.example/</script><b>/iframe-runtime.js");
  });
});
