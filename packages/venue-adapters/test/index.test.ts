import { describe, expect, it } from "vitest";
import {
  assertFreshSnapshot,
  requireOrderSubmission,
  type VenueAdapter,
  type VenueDescriptor
} from "../src/index.js";

const descriptor: VenueDescriptor = {
  id: "pump-fun",
  displayName: "pump.fun",
  status: "read-only",
  capabilities: ["market-discovery"],
  documentationUrl: "https://docs.pump.fun/"
};

const readOnlyAdapter: VenueAdapter = {
  descriptor,
  async getMarketSnapshot(instrumentId) {
    return {
      venue: "pump-fun",
      instrumentId,
      observedAt: new Date(1_700_000_000_000).toISOString(),
      receivedAt: new Date(1_700_000_000_010).toISOString(),
      source: "fixture",
      dataQuality: "LIVE"
    };
  }
};

describe("venue adapter contract", () => {
  it("does not pretend a read-only adapter can submit orders", () => {
    expect(() => requireOrderSubmission(readOnlyAdapter)).toThrow(/does not implement/);
  });

  it("rejects stale market snapshots", () => {
    const snapshot = {
      venue: "pump-fun" as const,
      instrumentId: "token-1",
      observedAt: new Date(1_700_000_000_000).toISOString(),
      receivedAt: new Date(1_700_000_000_010).toISOString(),
      source: "fixture",
      dataQuality: "LIVE" as const
    };
    expect(() => assertFreshSnapshot(snapshot, 1_700_000_002_000, 1000)).toThrow(/stale/);
  });

  it("accepts a fresh, known-quality snapshot", () => {
    const snapshot = {
      venue: "pump-fun" as const,
      instrumentId: "token-1",
      observedAt: new Date(1_700_000_000_000).toISOString(),
      receivedAt: new Date(1_700_000_000_010).toISOString(),
      source: "fixture",
      dataQuality: "LIVE" as const
    };
    expect(() => assertFreshSnapshot(snapshot, 1_700_000_000_500, 1000)).not.toThrow();
  });
});
