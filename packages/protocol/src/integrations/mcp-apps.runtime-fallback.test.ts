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

/** An `error` event as the listener sees it: a target, plus what a window-targeted ErrorEvent carries. */
interface ErrorEventLike {
  target: unknown;
  filename?: string;
  message?: string;
}

/** A non-script element the failure path builds (ggui#1518). */
interface FakeElement {
  tagName: string;
  type: string;
  textContent: string;
  style: { cssText: string };
  attrs: Record<string, string>;
  children: FakeElement[];
  onclick: (() => void) | null;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): void;
}

function fakeElement(tagName: string): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    type: "",
    textContent: "",
    style: { cssText: "" },
    attrs: {},
    children: [],
    onclick: null,
    setAttribute: (name, value) => {
      el.attrs[name] = value;
    },
    appendChild: (child) => {
      el.children.push(child);
    },
  };
  return el;
}

/** The shell's loading mark, as `[data-ggui-shell-loading]` finds it; removal is recorded. */
interface FakeMark {
  parentNode: { removeChild(el: FakeMark): void };
}

const textOf = (el: FakeElement): string => [el.textContent, ...el.children.map(textOf)].join(" ");

/**
 * Run every inline classic `<script>` of the shell except the meta one, as a
 * browser would before the module tag. `createScript` stands in for the
 * document's script factory, so a test can make adding the twin throw; any
 * other element is a plain fake. The document carries one loading mark.
 */
function runFallbackScript(html: string, createScript: () => FakeScript = () => fakeScript()) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  const listeners: Array<(ev: ErrorEventLike) => void> = [];
  const appended: FakeScript[] = [];
  const painted: FakeElement[] = [];
  const removedMarks: FakeMark[] = [];
  const warned: string[] = [];
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  let reloads = 0;
  const live: FakeMark[] = [];
  const mark: FakeMark = {
    parentNode: {
      removeChild: (el) => {
        removedMarks.push(el);
        live.splice(live.indexOf(el), 1);
      },
    },
  };
  live.push(mark);
  const win = {
    addEventListener: (type: string, fn: (ev: ErrorEventLike) => void, capture: boolean) => {
      if (type === "error" && capture === true) listeners.push(fn);
    },
    parent: {
      postMessage: (message: unknown, targetOrigin: string) => {
        posted.push({ message, targetOrigin });
      },
    },
  };
  const context = vm.createContext({
    window: win,
    location: {
      reload: () => {
        reloads += 1;
      },
    },
    document: {
      createElement: (tag: string) => (tag.toLowerCase() === "script" ? createScript() : fakeElement(tag)),
      querySelectorAll: (selector: string) => (selector === "[data-ggui-shell-loading]" ? [...live] : []),
      body: {
        appendChild: (el: FakeScript | FakeElement) => {
          if (el.tagName === "SCRIPT") appended.push(el as FakeScript);
          else painted.push(el as FakeElement);
        },
      },
    },
    console: { warn: (m: string) => warned.push(m) },
    globalThis: {},
  });
  for (const code of blocks) {
    if (code.includes("__GGUI_META__")) continue;
    vm.runInContext(code, context);
  }
  const fireEvent = (ev: ErrorEventLike): void => listeners.forEach((fn) => fn(ev));
  const fire = (target: unknown): void => fireEvent({ target });
  return {
    listeners,
    appended,
    painted,
    removedMarks,
    warned,
    posted,
    fire,
    fireEvent,
    window: win,
    reloads: () => reloads,
  };
}

const reasons = (posted: Array<{ message: unknown }>): string[] =>
  posted.map((p) => (p.message as { reason: string }).reason);

describe("gguiShellHtml runtime-bundle fallback (ggui#1501)", () => {
  const hashedUrl = `https://assets.example.com/_ggui/iframe-runtime.${HASH}.js`;

  it("without the option, a runtime that fails to load posts ONE BUNDLE_FETCH_FAILED, with no retry (ggui#1503)", () => {
    const html = gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface" });
    expect(html).toContain(
      `<script type="module" crossorigin="anonymous" data-ggui-runtime="src" src="${hashedUrl}"></script>`
    );
    const run = runFallbackScript(html);
    expect(run.listeners).toHaveLength(1);
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(0);
    expect(run.posted).toEqual([
      {
        message: {
          type: "ggui:bootstrap-failed",
          reason: "BUNDLE_FETCH_FAILED",
          message: "Runtime bundle failed to load: script error",
        },
        targetOrigin: "*",
      },
    ]);
    // A second error on the same element posts nothing more.
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.posted).toHaveLength(1);
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
    // The retry is not a failure yet: nothing is posted until the twin fails too.
    expect(run.posted).toHaveLength(0);

    // The twin failing too posts ONE BUNDLE_FETCH_FAILED (ggui#1503), from
    // the twin's own error: nothing else has fired yet.
    if (twin) run.fire(twin);
    expect(run.posted).toEqual([
      {
        message: {
          type: "ggui:bootstrap-failed",
          reason: "BUNDLE_FETCH_FAILED",
          message: "Runtime bundle failed to load: script error",
        },
        targetOrigin: "*",
      },
    ]);
    // The original erroring again appends and posts nothing more.
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(1);
    expect(run.posted).toHaveLength(1);
  });

  it("a twin that cannot be added (a Trusted Types policy refusing a plain src) is reported at once, once", () => {
    const refusing = (): FakeScript => {
      const s = fakeScript();
      Object.defineProperty(s, "src", {
        get: () => "",
        set: () => {
          throw new TypeError("This document requires 'TrustedScriptURL' assignment.");
        },
      });
      return s;
    };
    const run = runFallbackScript(
      gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", runtimeBundlePlainName: PLAIN }),
      refusing
    );
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(0);
    expect(run.posted).toEqual([
      {
        message: {
          type: "ggui:bootstrap-failed",
          reason: "BUNDLE_FETCH_FAILED",
          message:
            "Runtime bundle failed to load: its twin could not be added: This document requires 'TrustedScriptURL' assignment.",
        },
        targetOrigin: "*",
      },
    ]);
    // Nothing is retried and nothing more is posted.
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(0);
    expect(run.posted).toHaveLength(1);
  });

  it("an evaluation error in a runtime that loaded (an ErrorEvent targeted at window) is never a fetch failure", () => {
    for (const options of [
      { background: "surface" as const },
      { background: "surface" as const, runtimeBundlePlainName: PLAIN },
    ]) {
      const run = runFallbackScript(gguiShellHtml(BOOTSTRAP(hashedUrl), options));
      run.fireEvent({ target: run.window, filename: hashedUrl, message: "Uncaught Error: boom" });
      expect(run.appended).toHaveLength(0);
      expect(run.posted).toHaveLength(0);
    }
    // Nor once the twin is in: its evaluation throw is not its fetch failure.
    const run = runFallbackScript(
      gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", runtimeBundlePlainName: PLAIN })
    );
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    run.fireEvent({
      target: run.window,
      filename: "https://assets.example.com/_ggui/iframe-runtime.js",
      message: "Uncaught Error: boom",
    });
    expect(run.appended).toHaveLength(1);
    expect(run.posted).toHaveLength(0);
  });

  it("an error on anything else (an image, an unmarked script) is ignored", () => {
    const run = runFallbackScript(
      gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", runtimeBundlePlainName: PLAIN })
    );
    run.fire({ tagName: "IMG", getAttribute: () => null });
    run.fire(fakeScript());
    run.fire(null);
    expect(run.appended).toHaveLength(0);
    expect(run.posted).toHaveLength(0);
  });

  it("an unhashed or foreign URL gets no retry, and posts ONE BUNDLE_FETCH_FAILED at once (ggui#1503)", () => {
    for (const url of [
      "https://a.example/_ggui/iframe-runtime.js",
      `https://cdn.example.com/app.${HASH}.js`,
    ]) {
      const html = gguiShellHtml(BOOTSTRAP(url), {
        background: "surface",
        runtimeBundlePlainName: PLAIN,
      });
      const run = runFallbackScript(html);
      expect(run.listeners).toHaveLength(1);
      run.fire(fakeScript({ "data-ggui-runtime": "src" }));
      expect(run.appended).toHaveLength(0);
      expect(reasons(run.posted)).toEqual(["BUNDLE_FETCH_FAILED"]);
    }
  });

  it("an inlined runtime gets no listener: there is nothing to fetch", () => {
    const html = gguiShellHtml(BOOTSTRAP(hashedUrl), {
      background: "surface",
      runtimeBundlePlainName: PLAIN,
      runtimeInlineSource: "globalThis.__rt = 1;",
    });
    expect(runFallbackScript(html).listeners).toHaveLength(0);
    expect(html).not.toContain('data-ggui-runtime="src"');
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

  it("once nothing is left to try, the loading mark goes and a failure line with Retry is painted, once (ggui#1518)", () => {
    const run = runFallbackScript(gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface" }));
    expect(run.removedMarks).toHaveLength(0);
    expect(run.painted).toHaveLength(0);
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(reasons(run.posted)).toEqual(["BUNDLE_FETCH_FAILED"]);
    expect(run.removedMarks).toHaveLength(1);
    expect(run.painted).toHaveLength(1);
    const card = run.painted[0];
    expect(card?.attrs["data-ggui-shell-failure"]).toBe("");
    expect(card?.attrs["role"]).toBe("alert");
    expect(card === undefined ? "" : textOf(card)).toContain("This view could not load");
    const retry = card?.children.find((c) => c.tagName === "BUTTON");
    expect(retry?.textContent).toBe("Retry");
    retry?.onclick?.();
    expect(run.reloads()).toBe(1);
    // A later error paints nothing more.
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.painted).toHaveLength(1);
  });

  it("with the loading mark disabled, the failure still paints, and the shell never names the mark (ggui#1518, #667)", () => {
    const html = gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", loadingIndicator: null });
    expect(html).not.toContain("data-ggui-shell-loading");
    const run = runFallbackScript(html);
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(reasons(run.posted)).toEqual(["BUNDLE_FETCH_FAILED"]);
    expect(run.removedMarks).toHaveLength(0);
    expect(run.painted).toHaveLength(1);
  });

  it("while the twin is being tried, the loading mark stays and nothing is painted (ggui#1518)", () => {
    const run = runFallbackScript(
      gguiShellHtml(BOOTSTRAP(hashedUrl), { background: "surface", runtimeBundlePlainName: PLAIN })
    );
    run.fire(fakeScript({ "data-ggui-runtime": "src" }));
    expect(run.appended).toHaveLength(1);
    expect(run.removedMarks).toHaveLength(0);
    expect(run.painted).toHaveLength(0);
    run.fire(fakeScript({ "data-ggui-runtime": "fallback" }));
    expect(reasons(run.posted)).toEqual(["BUNDLE_FETCH_FAILED"]);
    expect(run.removedMarks).toHaveLength(1);
    expect(run.painted).toHaveLength(1);
  });
});
