"use client";
import { useState } from "react";
import {
  createAppKit,
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
} from "@reown/appkit/react";
import {
  mainnet,
  arbitrum,
  base,
  solana,
  type AppKitNetwork,
} from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import {
  SolanaAdapter,
  type Provider,
} from "@reown/appkit-adapter-solana/react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [
  mainnet,
  arbitrum,
  base,
  solana,
];
const wagmi = projectId
  ? new WagmiAdapter({ projectId, networks, ssr: true })
  : null;
const queryClient = new QueryClient();
if (wagmi) {
  createAppKit({
    adapters: [wagmi, new SolanaAdapter()],
    projectId,
    networks,
    metadata: {
      name: "Shards Agent Trading Network",
      description: "Governed AI-agent wallet ownership and market research",
      url: process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://satns.vercel.app",
      icons: [],
    },
    themeMode: "dark",
    themeVariables: { "--w3m-accent": "#d5b776" },
    features: { analytics: false, swaps: false, onramp: false },
  });
}
type Props = { onVerified: () => Promise<void> };
function Controls({ onVerified }: Props) {
  const { open } = useAppKit();
  const { address, caipAddress, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider<Provider>("solana");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const isSolana = Boolean(caipAddress?.startsWith("solana:"));
  async function verify() {
    if (!isConnected || !isSolana || !address || !walletProvider) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const begin = await fetch("/api/wallets/challenge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: "SOLANA", address }),
      });
      const challenge = await begin.json();
      if (!begin.ok) throw Error(challenge.error?.code ?? "CHALLENGE_FAILED");
      const raw = await walletProvider.signMessage(
        new TextEncoder().encode(challenge.message),
      );
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (bytes.length !== 64) throw Error("INVALID_SIGNATURE_LENGTH");
      const signature = btoa(
        Array.from(bytes, (x) => String.fromCharCode(x)).join(""),
      );
      const finish = await fetch("/api/wallets/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
      const verified = await finish.json();
      if (!finish.ok || verified.verified !== true)
        throw Error(verified.error?.code ?? "PROOF_REJECTED");
      await onVerified();
      setNote(
        "Server verified this Solana wallet. You can now assign it to a Shard; trading remains disabled.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Ownership verification failed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wallet-multi">
      <div className="wallet-step">REOWN APPKIT · MULTI-CHAIN</div>
      <h3>Browse supported wallets</h3>
      <p>
        Use the established WalletConnect catalogue, mobile deep links and
        installed-wallet discovery for Solana and EVM.
      </p>
      <button
        className="wallet-button"
        type="button"
        onClick={() => void open({ view: "Connect" })}
      >
        Choose wallet →
      </button>
      {isConnected && address && (
        <div className="wallet-connected">
          <span>CONNECTED THROUGH APPKIT</span>
          <strong>
            {caipAddress?.startsWith("solana:") ? "SOLANA" : "EVM / OTHER"}
          </strong>
          <code>
            {address.slice(0, 8)}…{address.slice(-6)}
          </code>
          <button
            className="wallet-minor-link"
            onClick={() => void open({ view: "Account" })}
          >
            Manage connection
          </button>
        </div>
      )}
      {isConnected && isSolana && (
        <button
          type="button"
          className="wallet-button"
          disabled={busy}
          onClick={() => void verify()}
        >
          {busy ? "Checking signature…" : "Verify Solana ownership"}
        </button>
      )}
      {isConnected && !isSolana && (
        <p className="wallet-detail">
          EVM transport connected. Server-side SIWE and EIP-1271 verification
          are not yet enabled, so it cannot be assigned to a Shard.
        </p>
      )}
      {error && (
        <p className="wallet-notice error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="wallet-notice" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
export default function WalletKit(props: Props) {
  if (!wagmi)
    return (
      <p role="status">
        Reown configuration unavailable. Set NEXT_PUBLIC_REOWN_PROJECT_ID in
        Vercel to enable the multichain wallet catalogue.
      </p>
    );
  return (
    <WagmiProvider config={wagmi.wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Controls {...props} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
