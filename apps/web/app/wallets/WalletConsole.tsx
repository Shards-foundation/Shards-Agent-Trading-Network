"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
const WalletKit = dynamic(() => import("./WalletKit"), { ssr: false });

interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, callback: (...args: any[]) => void): void;
  removeListener?(event: string, callback: (...args: any[]) => void): void;
}
interface AnnouncedEvmWallet {
  id: string;
  name: string;
  provider: EvmProvider;
}
export function parseEip6963Provider(
  detail: unknown,
): AnnouncedEvmWallet | null {
  if (!detail || typeof detail !== "object") return null;
  const supplied = detail as { info?: unknown; provider?: unknown };
  if (!supplied.info || typeof supplied.info !== "object") return null;
  const info = supplied.info as Record<string, unknown>;
  const provider = supplied.provider;
  if (
    typeof info.uuid !== "string" ||
    !/^[0-9a-fA-F-]{36}$/.test(info.uuid) ||
    typeof info.name !== "string" ||
    info.name.trim().length < 1 ||
    info.name.length > 64 ||
    !provider ||
    typeof provider !== "object" ||
    typeof (provider as { request?: unknown }).request !== "function"
  )
    return null;
  return {
    id: info.uuid.toLowerCase(),
    name: info.name.trim(),
    provider: provider as EvmProvider,
  };
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
    ethereum?: Record<string, unknown>;
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

type ReownConnection = { address: string; chainId: number } | null;
export default function WalletConsole({
  operatorSignInReady,
}: {
  operatorSignInReady: boolean;
}) {
  const [active, setActive] = useState<Active | null>(null);
  const [installedEvmWallets, setInstalledEvmWallets] = useState<
    AnnouncedEvmWallet[]
  >([]);
  const [solProvider, setSolProvider] = useState<SolanaProvider | null>(null);
  const [evmProvider, setEvmProvider] = useState<EvmProvider | null>(null);
  const [connected, setConnected] = useState<{ evm: boolean; sol: boolean }>({
    evm: false,
    sol: false,
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
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
    const announce = (event: Event) => {
      const detail = (event as Event & { detail?: unknown }).detail;
      const discovered = parseEip6963Provider(detail);
      if (!discovered) return;
      setInstalledEvmWallets((existing) => {
        if (
          existing.some((wallet) => wallet.id === discovered.id) ||
          existing.length >= 24
        )
          return existing;
        return [...existing, discovered];
      });
      setConnected((existing) => ({ ...existing, evm: true }));
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () =>
      window.removeEventListener("eip6963:announceProvider", announce);
  }, []);

  useEffect(() => {
    setConnected((previous) => ({
      evm: previous.evm || Boolean(window.ethereum),
      sol: Boolean(getSolana()),
    }));
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
      .catch(() => {})
      .finally(() => setAuthChecked(true));
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

  const onReownConnection = useCallback((connection: ReownConnection) => {
    setActive((current) => {
      if (!connection) {
        return current?.label === "Reown / WalletConnect" ? null : current;
      }
      return {
        chain: "EVM",
        address: connection.address,
        chainId: `0x${connection.chainId.toString(16)}`,
        label: "Reown / WalletConnect",
      };
    });
  }, []);

  async function connectEvm(wallet?: AnnouncedEvmWallet) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const provider =
        wallet?.provider ?? (window.ethereum as EvmProvider | undefined);
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
        label: wallet?.name ?? "Ethereum / EVM",
        chainId: typeof chainId === "string" ? chainId : undefined,
      });
      setMessage(
        "EVM transport connected. Sign a separate ownership challenge to register it; trading remains disabled.",
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
  async function verifyEvm() {
    if (!active || active.chain !== "EVM" || !evmProvider || !authenticated)
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const originalAddress = active.address;
      const currentAccounts = await evmProvider.request({
        method: "eth_accounts",
      });
      if (
        !Array.isArray(currentAccounts) ||
        !currentAccounts.some(
          (value) =>
            typeof value === "string" &&
            value.toLowerCase() === originalAddress.toLowerCase(),
        )
      )
        throw new Error("Wallet account changed. Reconnect before verifying.");
      const rawChain = await evmProvider.request({ method: "eth_chainId" });
      if (typeof rawChain !== "string" || !/^0x[0-9a-fA-F]+$/.test(rawChain))
        throw new Error("The wallet returned an invalid chain.");
      const chainId = Number.parseInt(rawChain, 16);
      if (![1, 42161, 8453].includes(chainId))
        throw new Error(
          "Select Ethereum, Arbitrum or Base before verifying ownership.",
        );
      const { challengeId, message: text } = await post("challenge", {
        chain: "EVM",
        address: originalAddress,
        chainId,
      });
      const encoded = `0x${Array.from(new TextEncoder().encode(text), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("")}`;
      const signature = await evmProvider.request({
        method: "personal_sign",
        params: [encoded, originalAddress],
      });
      if (
        typeof signature !== "string" ||
        !/^0x[0-9a-fA-F]{130}$/.test(signature)
      )
        throw new Error("Wallet did not provide a valid EOA signature.");
      const proof = await post("verify", { challengeId, signature });
      if (proof.verified !== true || proof.tradingEnabled !== false)
        throw new Error("Wallet verification was not confirmed.");
      await refresh();
      setMessage(
        "EVM wallet ownership verified and linked to your operator identity. Trading remains disabled.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EVM proof rejected.");
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
          {process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ? (
            <WalletKit
              authenticated={authenticated}
              onVerified={refresh}
              onConnectionChange={onReownConnection}
            />
          ) : (
            <div className="wallet-multi">
              <strong>Full wallet catalogue</strong>
              <p>
                Reown AppKit requires a Shards Reown project ID. Until
                configured, use an injected wallet below.
              </p>
            </div>
          )}
          {installedEvmWallets.length > 0 && (
            <div
              className="wallet-discovered"
              role="group"
              aria-label="Installed EVM wallets"
            >
              <div className="wallet-step">INSTALLED EVM WALLETS</div>
              <p>
                Choose a detected wallet. Names are provider-reported;
                connections are not ownership proof.
              </p>
              {installedEvmWallets.map((wallet) => (
                <button
                  key={wallet.id}
                  className="wallet-discovered-choice"
                  type="button"
                  onClick={() => void connectEvm(wallet)}
                  disabled={busy}
                >
                  <span>{wallet.name}</span>
                  <span aria-hidden="true">Connect ↗</span>
                </button>
              ))}
            </div>
          )}
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
              Mobile: use installed wallets in their in-app browser. The Reown
              catalogue supports EVM cross-app connections once its project is
              configured.
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
            <em>
              {authenticated
                ? "Signed in"
                : !operatorSignInReady
                  ? "Not configured"
                  : !authChecked
                    ? "Checking…"
                    : "Sign-in required"}
            </em>
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
          {!authenticated && !operatorSignInReady ? (
            <div className="wallet-disabled-action" role="status">
              Operator sign-in is not configured on this deployment. You can
              browse wallets, but ownership verification and Shard assignment
              are unavailable until the identity provider and API are enabled.
            </div>
          ) : !authenticated ? (
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
          ) : active?.chain === "EVM" &&
            active.label === "Reown / WalletConnect" ? (
            <div className="wallet-disabled-action">
              Use the Reown wallet's Verify wallet ownership action in the
              connection panel. The same server-side proof applies.
            </div>
          ) : active?.chain === "EVM" ? (
            <button
              className="wallet-button"
              type="button"
              disabled={busy || verifiedActive}
              onClick={() => void verifyEvm()}
            >
              {verifiedActive
                ? "Ownership verified"
                : busy
                  ? "Processing…"
                  : "Sign EVM ownership message"}
            </button>
          ) : (
            <div className="wallet-disabled-action">
              Connect a Solana or EVM wallet to verify ownership.
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
