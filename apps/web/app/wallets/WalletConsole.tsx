"use client";
import { useCallback, useEffect, useState } from "react";

interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, callback: (...args: any[]) => void): void;
  removeListener?(event: string, callback: (...args: any[]) => void): void;
}
interface SolanaProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey?: { toBase58(): string } }>;
  signMessage(
    message: Uint8Array,
    display?: string,
  ): Promise<{ signature: Uint8Array }>;
  disconnect?(): Promise<void>;
}
declare global {
  interface Window {
    ethereum?: EvmProvider;
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
    solflare?: SolanaProvider;
  }
}
type Active = {
  chain: "SOLANA" | "EVM";
  address: string;
  label: string;
  chainId?: string | undefined;
};
type OwnerWallet = {
  id: string;
  chain: string;
  address: string;
  status: string;
  verifiedAt: string;
  agentLinks: Array<{ agentId: string; status: string; tradeEnabled: boolean }>;
};
type OwnerAgent = { id: string; name: string; mode: string };
type Registry = { wallets: OwnerWallet[]; agents: OwnerAgent[] };
function short(value: string) {
  return value.length < 20 ? value : `${value.slice(0, 7)}…${value.slice(-6)}`;
}
function getSolana(): SolanaProvider | undefined {
  return window.phantom?.solana ?? window.solflare ?? window.solana;
}
async function post(path: string, data: unknown) {
  const response = await fetch(`/api/wallets/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(
      json.error?.code ?? `Request rejected (${response.status})`,
    );
  return json;
}

export default function WalletConsole() {
  const [active, setActive] = useState<Active | null>(null);
  const [solProvider, setSolProvider] = useState<SolanaProvider | null>(null);
  const [evmProvider, setEvmProvider] = useState<EvmProvider | null>(null);
  const [connected, setConnected] = useState<{ evm: boolean; sol: boolean }>({
    evm: false,
    sol: false,
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/wallets/registered", {
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(`Wallet registry unavailable (${response.status})`);
    const data: Registry = await response.json();
    setRegistry(data);
    setSelectedAgent((current) => current || data.agents[0]?.id || "");
  }, []);

  useEffect(() => {
    setConnected({ evm: Boolean(window.ethereum), sol: Boolean(getSolana()) });
    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (data.authenticated === true) {
          setAuthenticated(true);
          await refresh().catch(() =>
            setError("Operator wallet registry is currently unavailable."),
          );
        }
      })
      .catch(() => {});
  }, [refresh]);

  useEffect(() => {
    if (!evmProvider) return;
    const onAccounts = (...args: any[]) => {
      const accounts = args[0];
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
        setActive(null);
      else
        setActive((current) =>
          current?.chain === "EVM"
            ? { ...current, address: accounts[0] }
            : current,
        );
    };
    const onChain = (...args: any[]) => {
      const id = args[0];
      setActive((current) =>
        current?.chain === "EVM"
          ? { ...current, chainId: typeof id === "string" ? id : undefined }
          : current,
      );
    };
    const onDisconnect = () => setActive(null);
    evmProvider.on?.("accountsChanged", onAccounts);
    evmProvider.on?.("chainChanged", onChain);
    evmProvider.on?.("disconnect", onDisconnect);
    return () => {
      evmProvider.removeListener?.("accountsChanged", onAccounts);
      evmProvider.removeListener?.("chainChanged", onChain);
      evmProvider.removeListener?.("disconnect", onDisconnect);
    };
  }, [evmProvider]);

  async function connectEvm() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const provider = window.ethereum;
      if (!provider)
        throw new Error(
          "No EVM wallet was detected. Open this site in your wallet browser.",
        );
      const accounts = await provider.request({
        method: "eth_requestAccounts",
      });
      const chainId = await provider.request({ method: "eth_chainId" });
      if (!Array.isArray(accounts) || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0]))
        throw new Error("The wallet did not return a valid EVM address.");
      setEvmProvider(provider);
      setSolProvider(null);
      setActive({
        chain: "EVM",
        address: accounts[0],
        label: "Ethereum / EVM",
        chainId: typeof chainId === "string" ? chainId : undefined,
      });
      setMessage(
        "EVM transport connected. Cryptographic ownership proof is not available yet; no wallet has been registered.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection declined.");
    } finally {
      setBusy(false);
    }
  }
  async function connectSolana() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const provider = getSolana();
      if (!provider)
        throw new Error(
          "No Solana wallet was detected. Open in Phantom or Solflare wallet browser.",
        );
      const result = await provider.connect();
      const address =
        result.publicKey?.toBase58() ?? provider.publicKey?.toBase58();
      if (!address || address.length < 32 || address.length > 44)
        throw new Error("The wallet did not return a valid Solana address.");
      setSolProvider(provider);
      setEvmProvider(null);
      setActive({
        chain: "SOLANA",
        address,
        label: provider.isPhantom
          ? "Phantom"
          : provider.isSolflare
            ? "Solflare"
            : "Solana",
      });
      setMessage(
        "Connected locally. Sign a separate ownership challenge to link this wallet to your Shards identity.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection declined.");
    } finally {
      setBusy(false);
    }
  }
  async function verifySolana() {
    if (!active || active.chain !== "SOLANA" || !solProvider || !authenticated)
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { challengeId, message: text } = await post("challenge", {
        chain: "SOLANA",
        address: active.address,
      });
      const result = await solProvider.signMessage(
        new TextEncoder().encode(text),
        "utf8",
      );
      const bytes = result.signature;
      if (!(bytes instanceof Uint8Array) || bytes.length !== 64)
        throw new Error("Wallet returned an invalid signature.");
      const signature = btoa(
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
      );
      await post("verify", { challengeId, signature });
      await refresh();
      setMessage(
        "Cryptographic ownership verified. Wallet is now registered to your operator account. Trading remains disabled.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Wallet ownership verification failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function assign(walletId: string) {
    if (!selectedAgent) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post(`${walletId}/assign`, { agentId: selectedAgent });
      await refresh();
      setMessage(
        "Wallet linked to Shard. This does NOT authorise execution, withdrawals or delegation.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Assignment failed.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(walletId: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await post(`${walletId}/revoke`, {});
      await refresh();
      setMessage(
        "Shards wallet association revoked. Any separately approved venue keys must also be revoked at their venue.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revocation failed.");
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (active?.chain === "SOLANA")
      await solProvider?.disconnect?.().catch(() => {});
    setActive(null);
    setSolProvider(null);
    setEvmProvider(null);
    setMessage("");
  }
  const verifiedActive = active
    ? (registry?.wallets.some(
        (w) =>
          w.status === "ACTIVE" &&
          w.chain === active.chain &&
          w.address.toLowerCase() === active.address.toLowerCase(),
      ) ?? false)
    : false;

  return (
    <main className="wallet-page">
      <header className="wallet-top">
        <a href="/" className="wallet-wordmark">
          <span className="wallet-glyph">◇</span> SHARDS{" "}
          <span className="wallet-dim">/ WALLET CONTROL</span>
        </a>
        <a href="/terminal" className="wallet-navlink">
          Market terminal ↗
        </a>
      </header>
      <div className="wallet-heading">
        <div className="wallet-eyebrow">OPERATOR CONTROL PLANE / 01</div>
        <h1>
          Connect with <em>control.</em>
        </h1>
        <p>
          One verified operator. Multiple governed Shards. Wallet connection,
          ownership, assignment and trading permission are independent controls.
        </p>
        <span className="wallet-state-tag">
          ● PAPER ONLY — LIVE EXECUTION OFF
        </span>
      </div>
      <section className="wallet-grid" aria-label="Wallet onboarding">
        <article className="wallet-card wallet-connect">
          <div className="wallet-step">01 / CONNECT</div>
          <h2>Choose a wallet</h2>
          <p>
            Your keys remain in your wallet. Shards never asks for seed phrases,
            private keys or unrestricted signatures.
          </p>
          <div className="wallet-choices">
            <button
              onClick={() => void connectSolana()}
              disabled={busy}
              type="button"
              className="wallet-choice"
            >
              <span className="wallet-chain-icon sol">◎</span>
              <span>
                <strong>Solana</strong>
                <small>
                  {connected.sol
                    ? "Wallet available"
                    : "Phantom / Solflare in-app browser"}
                </small>
              </span>
              <span aria-hidden>↗</span>
            </button>
            <button
              onClick={() => void connectEvm()}
              disabled={busy}
              type="button"
              className="wallet-choice"
            >
              <span className="wallet-chain-icon evm">◇</span>
              <span>
                <strong>Ethereum & EVM</strong>
                <small>
                  {connected.evm
                    ? "Wallet available"
                    : "Injected wallet required"}
                </small>
              </span>
              <span aria-hidden>↗</span>
            </button>
          </div>
          {active ? (
            <div className="wallet-connected">
              <span>CONNECTED SESSION · NOT AUTOMATICALLY VERIFIED</span>
              <strong>{active.label}</strong>
              <code>{short(active.address)}</code>
              <div className="wallet-connected-actions">
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(active.address)
                  }
                >
                  Copy address
                </button>
                <button type="button" onClick={() => void clear()}>
                  Clear session
                </button>
              </div>
            </div>
          ) : (
            <p className="wallet-detail">
              Mobile: use an installed wallet's in-app browser. Cross-app
              WalletConnect support is a separate integration.
            </p>
          )}
        </article>
        <article className="wallet-card">
          <div className="wallet-step">02 / VERIFY</div>
          <h2>Prove ownership</h2>
          <p>
            Wallet access alone is not proof. A time-limited message signature
            binds your public address to your authenticated operator identity.
          </p>
          <div className="wallet-check">
            <span>01</span>
            <strong>Human identity</strong>
            <em>{authenticated ? "Signed in" : "Sign-in required"}</em>
          </div>
          <div className="wallet-check">
            <span>02</span>
            <strong>Wallet transport</strong>
            <em>{active ? "Connected" : "Not connected"}</em>
          </div>
          <div className="wallet-check">
            <span>03</span>
            <strong>Ownership proof</strong>
            <em>{verifiedActive ? "Verified" : "Not verified"}</em>
          </div>
          {!authenticated ? (
            <a className="wallet-button" href="/join">
              Sign in to verify →
            </a>
          ) : active?.chain === "SOLANA" ? (
            <button
              className="wallet-button"
              type="button"
              disabled={busy || verifiedActive}
              onClick={() => void verifySolana()}
            >
              {verifiedActive
                ? "Ownership verified"
                : busy
                  ? "Processing…"
                  : "Sign verification message"}
            </button>
          ) : (
            <div className="wallet-disabled-action">
              {active?.chain === "EVM"
                ? "EVM signature verification not enabled yet."
                : "Connect a Solana wallet to verify."}
            </div>
          )}
          <p className="wallet-detail">
            A verification signature never grants trade or withdrawal
            privileges.
          </p>
        </article>
        <article className="wallet-card">
          <div className="wallet-step">03 / ASSIGN</div>
          <h2>Govern your Shards</h2>
          <p>
            Only cryptographically verified wallets can be assigned to agents
            owned by this operator.
          </p>
          <label className="wallet-label" htmlFor="agent-select">
            Select an active Shard
          </label>
          <select
            id="agent-select"
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            disabled={!registry?.agents.length}
          >
            {!registry?.agents.length ? (
              <option value="">No active Shards</option>
            ) : (
              registry.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.mode}
                </option>
              ))
            )}
          </select>
          <div className="wallet-permission">
            <span>Execution authority</span>
            <strong>DISABLED</strong>
          </div>
          <div className="wallet-permission">
            <span>Withdrawal authority</span>
            <strong>NONE</strong>
          </div>
          <div className="wallet-permission">
            <span>Automatic trading</span>
            <strong>NONE</strong>
          </div>
          <a className="wallet-minor-link" href="/skill.md">
            Agent registration instructions ↗
          </a>
        </article>
      </section>
      {error ? (
        <div className="wallet-notice error" role="alert">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="wallet-notice" role="status">
          {message}
        </div>
      ) : null}
      <section className="wallet-registry">
        <div>
          <div className="wallet-eyebrow">OPERATOR REGISTRY / 02</div>
          <h2>Verified wallets</h2>
          <p>
            Server-verified addresses only. Local connections are never silently
            registered.
          </p>
        </div>
        {!authenticated ? (
          <p className="wallet-registry-empty">
            Sign in to view your verified wallets and Shard assignments.
          </p>
        ) : !registry ? (
          <p className="wallet-registry-empty">
            Wallet registry unavailable or loading. No balances or links are
            invented.
          </p>
        ) : registry.wallets.length === 0 ? (
          <p className="wallet-registry-empty">
            No verified wallets yet. Connect and sign a Solana ownership
            challenge above.
          </p>
        ) : (
          <div className="wallet-rows">
            {registry.wallets.map((wallet) => (
              <div key={wallet.id} className="wallet-record">
                <div>
                  <div className="wallet-record-title">
                    <strong>{wallet.chain}</strong>
                    <span>{wallet.status}</span>
                  </div>
                  <code>{short(wallet.address)}</code>
                  <small>
                    {
                      wallet.agentLinks.filter((l) => l.status === "ACTIVE")
                        .length
                    }{" "}
                    linked Shards · No live permissions
                  </small>
                </div>
                <div className="wallet-record-actions">
                  <button
                    type="button"
                    onClick={() => void assign(wallet.id)}
                    disabled={
                      busy || wallet.status !== "ACTIVE" || !selectedAgent
                    }
                  >
                    Assign to Shard
                  </button>
                  <button
                    type="button"
                    onClick={() => void revoke(wallet.id)}
                    disabled={busy || wallet.status !== "ACTIVE"}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <footer className="wallet-footer">
        <span>Shards Agent Trading Network</span>
        <span>Non-custodial · Verifiable · Fail-closed</span>
      </footer>
    </main>
  );
}
