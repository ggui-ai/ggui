/**
 * ggui#880 — every Plane-2 domain error a data-plane handler throws is a
 * `DomainError` over the protocol's closed `DOMAIN_ERROR_CODES` registry:
 * ONE composer for the wire text (`<code>: <detail>`), a marker a reader can
 * detect across realms, a `code` typed to the registered literal, and a
 * detail that never begins with a registered code (the base refuses it).
 * These are the classes `ggui_render` / `ggui_consume` / `ggui_get_session`
 * / `ggui_update` / `ggui_amend` / `ggui_emit` throw today.
 */
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  isDomainError,
  isDomainErrorCode,
  parseDomainErrorText,
} from '@ggui-ai/protocol';
import {
  ChannelNotDeclaredError,
  GguiSessionNotFoundError,
  InvalidCompleteError,
} from './errors.js';
import { HandshakeNotFoundError } from './handshake.js';
import { GadgetNotRegisteredError, GadgetPackageMismatchError } from './assert-gadgets.js';
import { GadgetPublicEnvMissingError } from './assert-public-env.js';
import { DuplicateGadgetHookError } from './assert-no-duplicate-gadget-hooks.js';
import { GadgetTypesFetchError } from './fetch-gadget-types.js';
import { BlueprintRejectedError } from './blueprint-registry.js';
import { OverrideContractInvalidError } from './render.js';

interface Case {
  readonly name: string;
  readonly code: string;
  readonly make: () => Error;
}

const CASES: readonly Case[] = [
  { name: 'GguiSessionNotFoundError', code: 'session_not_found', make: () => new GguiSessionNotFoundError('s_1') },
  {
    name: 'ChannelNotDeclaredError',
    code: 'channel_not_declared',
    make: () => new ChannelNotDeclaredError('chat', ['progress'], 's_1'),
  },
  { name: 'InvalidCompleteError', code: 'invalid_complete', make: () => new InvalidCompleteError('chat') },
  { name: 'HandshakeNotFoundError', code: 'handshake_not_found', make: () => new HandshakeNotFoundError('h_1') },
  {
    name: 'GadgetNotRegisteredError',
    code: 'gadget_not_registered',
    make: () => new GadgetNotRegisteredError([{ hook: 'useFoo', package: '@x/gadgets', suggestion: null }]),
  },
  {
    name: 'GadgetPackageMismatchError',
    code: 'gadget_package_mismatch',
    make: () =>
      new GadgetPackageMismatchError([
        { hook: 'useFoo', requestedPackage: '@x/gadgets', registered: ['@y/gadgets'] },
      ]),
  },
  {
    name: 'GadgetPublicEnvMissingError',
    code: 'gadget_public_env_missing',
    make: () =>
      new GadgetPublicEnvMissingError([
        { hook: 'useFoo', package: '@x/gadgets', missingKey: 'FOO_URL', suggestion: null },
      ]),
  },
  {
    name: 'DuplicateGadgetHookError',
    code: 'duplicate_gadget_hook',
    make: () =>
      new DuplicateGadgetHookError([{ package: '@x/gadgets', firstSeenPackage: '@y/gadgets', hook: 'useFoo' }]),
  },
  {
    name: 'GadgetTypesFetchError',
    code: 'gadget_types_fetch_failed',
    make: () =>
      new GadgetTypesFetchError([{ package: '@x/gadgets', typesUrl: 'https://x/types.d.ts', reason: '404' }]),
  },
  {
    name: 'BlueprintRejectedError',
    code: 'blueprint_rejected',
    make: () => new BlueprintRejectedError([{ kind: 'novel-shape', severity: 'error', hint: 'no data surface' }]),
  },
  {
    name: 'OverrideContractInvalidError',
    code: 'override_contract_invalid',
    make: () => new OverrideContractInvalidError('propsSpec.properties.x is a flat schema, not a wrapper'),
  },
];

describe.each(CASES)('$name is a DomainError over the registry (ggui#880)', ({ name, code, make }) => {
  it('carries the registered code, composes `<code>: <detail>`, is detectable and parseable', () => {
    expect(isDomainErrorCode(code)).toBe(true);
    const err = make();
    expect(isDomainError(err)).toBe(true);
    if (!isDomainError(err)) return;
    expect(err.code).toBe(code);
    expect(err.name).toBe(name);
    expect(err.detail.length).toBeGreaterThan(0);
    expect(err.message).toBe(`${code}: ${err.detail}`);
    for (const registered of DOMAIN_ERROR_CODES) {
      expect(err.detail.startsWith(`${registered}: `)).toBe(false);
    }
    expect(parseDomainErrorText(err.message)).toEqual({ code, detail: err.detail });
  });
});
