"use client";

import { useState } from "react";

type Position = {
  coin: string;
  size: string;
  entryPrice: string | null;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPrice: string | null;
  leverage: number;
  leverageType: "cross" | "isolated";
};
type OpenOrder = {
  coin: string;
  direction: "BUY" | "SELL";
  limitPrice: string;
  size: string;
  orderId: number;
};
type AccountResponse = {
  venue: "hyperliquid";
  walletAddress: string;
  account: {
    equity: string;
    marginUsed: string;
    positionNotional: string;
    positions: Position[];
  };
  openOrders: OpenOrder[];
  mode: "PUBLIC_READ_ONLY";
  executionEnabled: false;
  retrievedAt: string;
};

function usd(value: string | null): string {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(Math.trunc(number))) {
    return `$${value}`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

export default function HyperliquidAccount() {
  const [address, setAddress] = useState("");
  const [account, setAccount] = useState<AccountResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function inspect() {
    setBusy(true);
    setAccount(null);
    setError("");
    try {
      const wallet = address.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        throw new Error("Enter a valid EVM wallet address (0x followed by 40 hex characters).");
      }
      const response = await fetch(
        `/api/venues/hyperliquid/account?address=${encodeURIComponent(wallet)}`,
        { cache: "no-store", signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error("Hyperliquid account data is unavailable.");
      const data = (await response.json()) as AccountResponse;
      if (
        data.venue !== "hyperliquid" ||
        data.walletAddress.toLowerCase() !== wallet.toLowerCase() ||
        data.mode !== "PUBLIC_READ_ONLY" ||
        data.executionEnabled !== false ||
        !Array.isArray(data.account?.positions) ||
        !Array.isArray(data.openOrders)
      ) {
        throw new Error("The venue returned unexpected account data.");
      }
      setAccount(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="venue-account" aria-labelledby="hyperliquid-account-heading">
      <div className="venue-account-header">
        <div>
          <small>HYPERLIQUID / ON-CHAIN ACCOUNT INSPECTOR</small>
          <h3 id="hyperliquid-account-heading">Inspect live positions</h3>
          <p>Look up public Hyperliquid positions and open orders by EVM address. No wallet connection or signing required.</p>
        </div>
        <span>PUBLIC · READ ONLY</span>
      </div>
      <form
        className="venue-account-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label htmlFor="hyperliquid-account-address">Account wallet address</label>
        <div>
          <input
            id="hyperliquid-account-address"
            type="text"
            placeholder="0x… (EVM master or subaccount address)"
            autoComplete="off"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            maxLength={42}
            spellCheck={false}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Inspecting…" : "Inspect account"}
          </button>
        </div>
      </form>
      {error && <p className="venue-error" role="alert">{error}</p>}
      {account && (
        <div className="venue-account-results">
          <div className="venue-account-metrics">
            <div><small>Account equity</small><strong>{usd(account.account.equity)}</strong></div>
            <div><small>Margin in use</small><strong>{usd(account.account.marginUsed)}</strong></div>
            <div><small>Position notional</small><strong>{usd(account.account.positionNotional)}</strong></div>
            <div><small>Open orders</small><strong>{account.openOrders.length}</strong></div>
          </div>
          <h4>Current perpetual positions</h4>
          {account.account.positions.length === 0 ? (
            <p className="venue-account-empty">No current positions reported for this account.</p>
          ) : (
            <div className="venue-table-wrap">
              <table className="venue-table">
                <thead>
                  <tr><th>Market</th><th>Size</th><th>Entry price</th><th>Position value</th><th>Unrealised PnL</th><th>Leverage</th></tr>
                </thead>
                <tbody>{account.account.positions.map((position) => (
                  <tr key={position.coin}>
                    <td>{position.coin}</td>
                    <td>{position.size}</td>
                    <td>{usd(position.entryPrice)}</td>
                    <td>{usd(position.positionValue)}</td>
                    <td className={Number(position.unrealizedPnl) >= 0 ? "positive" : "negative"}>{usd(position.unrealizedPnl)}</td>
                    <td>{position.leverage}× {position.leverageType}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <h4>Open orders</h4>
          {account.openOrders.length === 0 ? (
            <p className="venue-account-empty">No current open orders reported for this account.</p>
          ) : (
            <div className="venue-table-wrap">
              <table className="venue-table">
                <thead><tr><th>Market</th><th>Direction</th><th>Limit price</th><th>Remaining size</th></tr></thead>
                <tbody>{account.openOrders.map((order) => (
                  <tr key={order.orderId}>
                    <td>{order.coin}</td><td>{order.direction}</td>
                    <td>{usd(order.limitPrice)}</td><td>{order.size}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <p className="venue-account-asof">Source: Hyperliquid public info API · Retrieved {new Date(account.retrievedAt).toLocaleString("en-GB")}</p>
        </div>
      )}
      <p className="venue-account-disclaimer">
        Lookup is public and does not verify ownership. Agent wallet assignment, trading authority and withdrawal permissions remain separate, server-governed controls.
      </p>
    </section>
  );
}
