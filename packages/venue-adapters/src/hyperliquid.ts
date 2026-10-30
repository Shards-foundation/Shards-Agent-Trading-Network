import type { MarketSnapshot, VenueAdapter } from "./index.js";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DEFAULT_ENDPOINT = "https://api.hyperliquid.xyz/info";
const DEFAULT_MAX_AGE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 5_000;

type Fetcher = typeof fetch;

interface BookLevel {
  px: string;
  sz: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Hyperliquid returned an invalid market-data payload.");
  }
  return value as Record<string, unknown>;
}

function parseLevel(value: unknown): BookLevel {
  const level = asRecord(value);
  if (
    typeof level.px !== "string" ||
    !DECIMAL.test(level.px) ||
    typeof level.sz !== "string" ||
    !DECIMAL.test(level.sz) ||
    Number(level.px) <= 0 ||
    Number(level.sz) <= 0
  ) {
    throw new Error("Hyperliquid returned an invalid top-of-book level.");
  }
  return { px: level.px, sz: level.sz };
}

export interface HyperliquidAdapterOptions {
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => number;
  maxAgeMs?: number;
  timeoutMs?: number;
}

/**
 * Public, read-only Hyperliquid L2 market data.
 *
 * This adapter deliberately does not implement order submission, cancellation,
 * account access, signing, wallet management, or any write-capable endpoint.
 */
export class HyperliquidReadOnlyAdapter implements VenueAdapter {
  readonly descriptor = {
    id: "hyperliquid" as const,
    displayName: "Hyperliquid",
    status: "read-only" as const,
    capabilities: ["market-data", "paper-trading"] as const,
    documentationUrl: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint"
  };

  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly timeoutMs: number;

  constructor(options: HyperliquidAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isInteger(this.maxAgeMs) || this.maxAgeMs < 1) {
      throw new Error("maxAgeMs must be a positive integer.");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("timeoutMs must be a positive integer.");
    }
  }

  async getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot> {
    const coin = instrumentId.trim();
    if (!coin || coin.length > 64 || !/^[A-Za-z0-9@._/-]+$/.test(coin)) {
      throw new Error("Invalid Hyperliquid coin identifier.");
    }

    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid market-data request failed (HTTP ${response.status}).`);
    }

    const payload = asRecord(await response.json());
    if (
      payload.coin !== coin ||
      typeof payload.time !== "number" ||
      !Number.isSafeInteger(payload.time) ||
      payload.time <= 0 ||
      !Array.isArray(payload.levels) ||
      payload.levels.length < 2 ||
      !Array.isArray(payload.levels[0]) ||
      !Array.isArray(payload.levels[1]) ||
      payload.levels[0].length === 0 ||
      payload.levels[1].length === 0
    ) {
      throw new Error("Hyperliquid returned an incomplete or mismatched order book.");
    }

    const bestBid = parseLevel(payload.levels[0][0]);
    const bestAsk = parseLevel(payload.levels[1][0]);
    if (Number(bestAsk.px) < Number(bestBid.px)) {
      throw new Error("Hyperliquid returned an inverted top-of-book.");
    }

    const receivedMs = this.now();
    const ageMs = receivedMs - payload.time;
    const quality = ageMs >= 0 && ageMs <= this.maxAgeMs ? "LIVE" : "STALE";

    return {
      venue: "hyperliquid",
      instrumentId: coin,
      observedAt: new Date(payload.time).toISOString(),
      receivedAt: new Date(receivedMs).toISOString(),
      source: this.endpoint,
      sequence: String(payload.time),
      bid: bestBid.px,
      ask: bestAsk.px,
      dataQuality: quality
    };
  }
}
