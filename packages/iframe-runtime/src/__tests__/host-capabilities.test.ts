/**
 * Host-capability slot (ggui#440).
 *
 * Both capabilities are PRESENCE-keyed on `McpUiHostCapabilities`
 * (`serverTools?: {…}`, `message?: {…}`) — an empty object is a
 * positive advertisement, so these accessors test for presence, not
 * for a boolean value.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  hostCanReceiveMessages,
  hostCanRelayToolCalls,
  setHostCapabilities,
  __resetHostCapabilitiesForTest,
} from "../host-capabilities.js";

describe("host capability slot", () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
  });

  it("reports both false before any capture (pre-boot)", () => {
    expect(hostCanRelayToolCalls()).toBe(false);
    expect(hostCanReceiveMessages()).toBe(false);
  });

  it("treats an EMPTY object capability as advertised (presence-keyed)", () => {
    setHostCapabilities({ serverTools: {}, message: {} });
    expect(hostCanRelayToolCalls()).toBe(true);
    expect(hostCanReceiveMessages()).toBe(true);
  });

  it("reports false for a capability the host omitted", () => {
    setHostCapabilities({ serverTools: {} });
    expect(hostCanRelayToolCalls()).toBe(true);
    expect(hostCanReceiveMessages()).toBe(false);
  });

  it("handles a host that advertised nothing at all", () => {
    setHostCapabilities({});
    expect(hostCanRelayToolCalls()).toBe(false);
    expect(hostCanReceiveMessages()).toBe(false);
  });

  it("handles undefined (handshake never resolved)", () => {
    setHostCapabilities(undefined);
    expect(hostCanRelayToolCalls()).toBe(false);
    expect(hostCanReceiveMessages()).toBe(false);
  });
});
