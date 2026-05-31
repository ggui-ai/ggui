// packages/protocol/src/gadgets/stdlib-gadgets.ts
//
// `STDLIB_GADGETS` — the canonical list of browser-capability
// gadget hooks shipped by the first-party `@ggui-ai/gadgets`
// package. Each entry is a `GadgetDescriptor` declaration that an app
// MAY use as-is (default `App.gadgets`) or filter / extend via
// the per-app gadget list.
//
// **Why protocol owns this list:**
//
//   - The protocol layer is the source of truth for the four-spec
//     surface (`DataContract.clientCapabilities.gadgets`). The list
//     of available stdlib hooks is part of the contract surface
//     agents reason about — so it belongs alongside the type
//     definitions, not in the runtime package.
//   - Descriptors are strings + JSON only — no runtime deps. The
//     protocol package stays free of `@ggui-ai/gadgets` as
//     a workspace dependency (which would create a cycle: protocol →
//     gadgets → protocol).
//
// **Parity guarantee:** `@ggui-ai/gadgets` ships a cross-
// package contract test (`stdlib-parity.test.ts`) that imports both
// this list and the actual hook exports, then asserts the hook names
// match exactly. Drift fails the test on CI; the protocol package
// cannot ship a stale descriptor list without the runtime side
// catching it.

import type { GadgetDescriptor } from '../types/data-contract';

/**
 * The first-party `@ggui-ai/gadgets` package name. Used as
 * the default `package` for every entry in {@link STDLIB_GADGETS}
 * and as the `DEFAULT_GADGET_PACKAGE` literal in the hygiene linter.
 */
export const STDLIB_GADGETS_PACKAGE = '@ggui-ai/gadgets';

/**
 * Pinned semver of the stdlib gadgets every descriptor declares on
 * its `version` field. Mirrors
 * `packages/gadgets/package.json#version`; a cross-package parity test
 * in `@ggui-ai/gadgets` asserts the two stay in sync, so a release-time
 * bump to the runtime package without updating this constant fails CI.
 */
export const STDLIB_GADGETS_VERSION = '0.2.0';

/**
 * v1 catalog of stdlib gadget descriptors. Every entry's
 * `package` defaults to {@link STDLIB_GADGETS_PACKAGE}; the
 * `permission` field, where present, mirrors the Web Permissions API
 * name and lines up with the hygiene linter's
 * `KNOWN_PERMISSION_HOOKS` table.
 *
 * **Ordering:** alphabetical by hook name. Stable so consumers can
 * diff the list across protocol minor bumps without false positives
 * from re-ordering.
 *
 * **Shape note:** entries are typed `Readonly<GadgetDescriptor>` so
 * downstream consumers (App.gadgets default-on-read, the LLM
 * generator's catalog, the `ggui_list_gadgets` handler)
 * can structurally clone without mutating the source. Callers that
 * need a mutable copy should `structuredClone` explicitly.
 */
export const STDLIB_GADGETS: readonly Readonly<GadgetDescriptor>[] = [
  {
    package: STDLIB_GADGETS_PACKAGE,
    version: STDLIB_GADGETS_VERSION,
    exports: [
      {
        hook: 'useCamera',
        permission: 'camera',
        description: 'Capture stills or live video from the device camera.',
        usage:
          'Mount when the intent names photo capture, QR / barcode scanning, video recording, or anything that requires a camera feed. The hook returns a stream once `start()` resolves; thread the resulting blob or stream URL into a contextSpec slot or an actionSpec payload to surface it to the agent.',
        example: {
          call: 'const cam = useCamera();',
          returns: {
            status: 'ready',
            value: { stream: '<MediaStream>', kind: 'video' },
          },
        },
      },
      {
        hook: 'useClipboardPaste',
        permission: 'clipboard-read',
        description: 'Read the system clipboard contents on user gesture.',
        usage:
          'Mount when the intent involves importing copied content (paste-into-form, paste-image-to-upload, paste-link). The Permissions API requires a user gesture; gate `start()` behind a button click. Returned value lands in a contextSpec slot or an actionSpec payload.',
        example: {
          call: 'const paste = useClipboardPaste();',
          returns: { status: 'ready', value: 'pasted clipboard text' },
        },
      },
      {
        hook: 'useClipboardWrite',
        permission: 'clipboard-write',
        description: 'Write to the system clipboard on user gesture.',
        usage:
          'Mount when the intent includes copying generated text, share links, codes, or transcripts to the system clipboard. Fire an actionSpec event so the agent observes the act (it does not see the written value — that stays component-local).',
        example: {
          call: "const write = useClipboardWrite(); write.write('hello');",
          returns: { status: 'ready' },
        },
      },
      {
        hook: 'useFilePicker',
        description: 'Open the native file picker and read selected files.',
        usage:
          'Mount when the intent names file upload, attachment selection, or document import. No permission required. The hook returns the picked files plus metadata; thread file refs / data URLs into a contextSpec slot or actionSpec payload.',
        example: {
          call: 'const picker = useFilePicker({ accept: "image/*" });',
          returns: {
            status: 'ready',
            value: [{ name: 'photo.png', type: 'image/png', size: 12345 }],
          },
        },
      },
      {
        hook: 'useGeolocation',
        permission: 'geolocation',
        description: "Resolve the device's current geolocation.",
        usage:
          'Mount when the intent names "current location", maps, nearby search, location-aware UI. Browser prompts the user on `start()`; the hook returns coordinates once granted. Thread the resolved coords into a contextSpec slot so the agent observes the latest fix.',
        example: {
          call: 'const geo = useGeolocation();',
          returns: {
            status: 'ready',
            value: { latitude: 37.7749, longitude: -122.4194, accuracy: 20 },
          },
        },
      },
      {
        hook: 'useMicrophone',
        permission: 'microphone',
        description: 'Capture audio from the device microphone.',
        usage:
          'Mount when the intent names voice memos, audio messages, dictation, voice-driven UI. Returns an audio stream / blob; thread it into an actionSpec payload at recording-stop, or into a contextSpec slot for live transcription pipelines.',
        example: {
          call: 'const mic = useMicrophone();',
          returns: {
            status: 'ready',
            value: { stream: '<MediaStream>', kind: 'audio' },
          },
        },
      },
      {
        hook: 'useNotifications',
        permission: 'notifications',
        description: 'Show system / browser notifications to the user.',
        usage:
          'Mount when the intent involves alerting the user about something (reminders, completion of long tasks, incoming messages) and the UI may be in the background. Permission is prompted on first `start()`; the agent does NOT see notification dismissal directly — surface it via an actionSpec if needed.',
        example: {
          call: "const notify = useNotifications(); notify.show({ title: 'Done' });",
          returns: { status: 'ready', value: { granted: true } },
        },
      },
    ],
  },
];

/**
 * Hook-name index over {@link STDLIB_GADGETS}. Lazily
 * constructed for callers that need O(1) "is hook X part of the
 * stdlib?" checks (the hygiene linter, the per-app gadget validator,
 * the `ggui_list_gadgets` handler).
 *
 * Frozen so accidental mutation is loud, not silent.
 */
export const STDLIB_GADGET_HOOKS: ReadonlySet<string> = Object.freeze(
  new Set(
    STDLIB_GADGETS.flatMap((pkg) => pkg.exports)
      // `GadgetExport` is a type-exclusive union (`hook?: never` on the
      // component member), so `hook` is an optional key of both members
      // and `'hook' in exp` no longer narrows. Discriminate by VALUE
      // presence and collect only defined hook names.
      .map((exp) => exp.hook)
      .filter((hook): hook is string => hook !== undefined),
  ),
);
