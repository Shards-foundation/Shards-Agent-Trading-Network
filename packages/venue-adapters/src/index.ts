export type VenueId = "hyperliquid" | "polymarket" | "pump-fun" | "uniswap" | (string & {});

export type VenueCapability =
  | "market-data"
  | "market-discovery"
  | "paper-trading"
  | "order-submit"
  | "order-cancel"
  | "wallet-quote"
  | "unsigned-transaction";

export interface VenueDescriptor {
  id: VenueId;
  displayName: string;
  status: "planned" | "read-only" | "testnet" | "live-restricted" | "disabled";
  capabilities: readonly VenueCapability[];
  documentationUrl: string;
}

export interface MarketSnapshot {
  venue: VenueId;
  instrumentId: string;
  observedAt: string;
  receivedAt: string;
  source: string;
  sequence?: string;
  bid?: string;
  ask?: string;
  last?: string;
  dataQuality: "LIVE" | "DELAYED" | "STALE" | "UNKNOWN";
}

export interface NormalisedTradeIntent {
  intentId: string;
  clientOrderId: string;
  instrumentId: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quantity: string;
  limitPrice?: string;
  reduceOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
}

export type VenueOrderState =
  | "ACKNOWLEDGED"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED"
  | "UNKNOWN";

export interface VenueOrderResult {
  venue: VenueId;
  clientOrderId: string;
  venueOrderId?: string;
  state: VenueOrderState;
  acceptedAt?: string;
  reasonCode?: string;
  rawEvidenceHash?: string;
}

export interface VenueAdapter {
  readonly descriptor: VenueDescriptor;
  getMarketSnapshot(instrumentId: string): Promise<MarketSnapshot>;
  submitOrder?(intent: NormalisedTradeIntent): Promise<VenueOrderResult>;
  cancelOrder?(clientOrderId: string): Promise<VenueOrderResult>;
}

export class UnsupportedVenueCapabilityError extends Error {
  constructor(
    public readonly venue: VenueId,
    public readonly capability: VenueCapability
  ) {
    super(`Venue "${venue}" does not implement required capability "${capability}".`);
    this.name = "UnsupportedVenueCapabilityError";
  }
}

export function requireCapability(adapter: VenueAdapter, capability: VenueCapability): void {
  if (!adapter.descriptor.capabilities.includes(capability)) {
    throw new UnsupportedVenueCapabilityError(adapter.descriptor.id, capability);
  }
}

export function requireOrderSubmission(adapter: VenueAdapter): NonNullable<VenueAdapter["submitOrder"]> {
  requireCapability(adapter, "order-submit");
  if (!adapter.submitOrder) {
    throw new UnsupportedVenueCapabilityError(adapter.descriptor.id, "order-submit");
  }
  return adapter.submitOrder.bind(adapter);
}

export function assertFreshSnapshot(
  snapshot: MarketSnapshot,
  nowMs: number,
  maxAgeMs: number
): void {
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedMs) || nowMs - observedMs > maxAgeMs ||
      snapshot.dataQuality === "STALE" || snapshot.dataQuality === "UNKNOWN") {
    throw new Error("Market snapshot is stale or has unknown quality.");
  }
}
