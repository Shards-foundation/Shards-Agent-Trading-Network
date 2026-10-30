const DEFAULT_ENDPOINT = "https://gamma-api.polymarket.com/markets";
type Fetcher = typeof fetch;
export interface PolymarketMarket {
  id: string; question: string | null; slug: string | null; conditionId: string;
  outcomes: string[]; outcomePrices: string[]; active: boolean; closed: boolean;
  volume: number | null; liquidity: number | null; endDate: string | null;
  acceptingOrders: boolean; restricted: boolean;
}
export interface PolymarketMarketPage {
  venue: "polymarket"; source: string; retrievedAt: string; limit: number; offset: number;
  nextOffset: number | null; executionEnabled: false; items: PolymarketMarket[];
}
export interface PolymarketMarketQuery { limit: number; offset: number; }
export interface PolymarketMarketDiscoveryProvider {
  listMarkets(query: PolymarketMarketQuery): Promise<PolymarketMarketPage>;
}
export interface PolymarketReadOnlyDiscoveryOptions {
  endpoint?: string; fetcher?: Fetcher; now?: () => number; timeoutMs?: number;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Polymarket returned an invalid market payload.");
  return value as Record<string, unknown>;
}
function nullableString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Polymarket returned an invalid string field.");
  return value;
}
function stringArray(value: unknown, field: string): string[] {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown; }
    catch { throw new Error(`Polymarket returned malformed ${field} JSON.`); }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Polymarket returned an invalid ${field} array.`);
  return parsed;
}
function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function parseMarket(value: unknown): PolymarketMarket {
  const row = record(value);
  const id = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : "";
  if (!id || typeof row.conditionId !== "string" || !row.conditionId ||
      typeof row.active !== "boolean" || typeof row.closed !== "boolean" ||
      typeof row.acceptingOrders !== "boolean" || typeof row.restricted !== "boolean") {
    throw new Error("Polymarket returned a market missing required identity or state fields.");
  }
  const outcomes = stringArray(row.outcomes, "outcomes");
  const outcomePrices = stringArray(row.outcomePrices, "outcomePrices");
  if (!outcomes.length || outcomes.length !== outcomePrices.length ||
      outcomePrices.some((p) => !/^(?:0|1)(?:\.\d+)?$|^0?\.\d+$/.test(p) || Number(p) < 0 || Number(p) > 1)) {
    throw new Error("Polymarket returned invalid outcome prices.");
  }
  const endDate = nullableString(row.endDate);
  if (endDate !== null && !Number.isFinite(Date.parse(endDate))) throw new Error("Polymarket returned an invalid market end date.");
  return {
    id, question: nullableString(row.question), slug: nullableString(row.slug), conditionId: row.conditionId,
    outcomes, outcomePrices, active: row.active, closed: row.closed,
    volume: nullableNumber(row.volumeNum ?? row.volume), liquidity: nullableNumber(row.liquidityNum ?? row.liquidity),
    endDate, acceptingOrders: row.acceptingOrders, restricted: row.restricted
  };
}
/** Public Gamma market discovery only. No CLOB order submission, signing or wallet methods. */
export class PolymarketReadOnlyDiscoveryAdapter implements PolymarketMarketDiscoveryProvider {
  readonly descriptor = {
    id: "polymarket" as const, status: "read-only" as const, capabilities: ["market-discovery"] as const,
    documentationUrl: "https://docs.polymarket.com/api-reference/predictions/overview"
  };
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(options: PolymarketReadOnlyDiscoveryOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer.");
    const url = new URL(this.endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
      throw new Error("Polymarket endpoint must use HTTPS except for localhost tests.");
    }
  }
  async listMarkets(query: PolymarketMarketQuery): Promise<PolymarketMarketPage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw new Error("limit must be an integer between 1 and 50.");
    if (!Number.isInteger(query.offset) || query.offset < 0 || query.offset > 10_000) throw new Error("offset must be an integer between 0 and 10000.");
    const url = new URL(this.endpoint);
    url.searchParams.set("limit", String(query.limit));
    url.searchParams.set("offset", String(query.offset));
    url.searchParams.set("closed", "false");
    url.searchParams.set("order", "volumeNum");
    url.searchParams.set("ascending", "false");
    const response = await this.fetcher(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Polymarket market discovery failed (HTTP ${response.status}).`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Polymarket returned an invalid market list.");
    const items = payload.map(parseMarket);
    return {
      venue: "polymarket", source: this.endpoint, retrievedAt: new Date(this.now()).toISOString(),
      limit: query.limit, offset: query.offset, nextOffset: items.length === query.limit ? query.offset + query.limit : null,
      executionEnabled: false, items
    };
  }
}
