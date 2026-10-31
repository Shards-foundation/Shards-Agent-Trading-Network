"use client";
import { createAppKit, useAppKit, useAppKitAccount } from "@reown/appkit/react";
import {
  mainnet,
  arbitrum,
  base,
  type AppKitNetwork,
} from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { WagmiProvider, useAccount, useSignMessage } from "wagmi";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [mainnet, arbitrum, base];
const wagmi = projectId
  ? new WagmiAdapter({ projectId, networks, ssr: true })
  : null;
const queryClient = new QueryClient();
if (wagmi) {
  createAppKit({
    // The installed SDK publishes a narrower runtime adapter shape than its
    // TypeScript interface under exactOptionalPropertyTypes.
    adapters: [
      wagmi as unknown as NonNullable<
        Parameters<typeof createAppKit>[0]["adapters"]
      >[number],
    ],
    projectId,
    networks,
    metadata: {
      name: "Shards Agent Trading Network",
      description: "Governed AI-agent wallet ownership and market research",
      url:
        typeof window === "undefined"
          ? "https://satns.vercel.app"
          : window.location.origin,
      icons: [],
    },
    themeMode: "dark",
    themeVariables: { "--w3m-accent": "#d5b776" },
    features: { analytics: false, swaps: false, onramp: false },
  });
}
type Props = {
  authenticated: boolean;
  onVerified: () => Promise<void>;
  onConnectionChange: (connection: { address: string; chainId: number } | null) => void;
};
function Controls({ authenticated, onVerified, onConnectionChange }: Props) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  const account = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (isConnected && account.address && account.chainId !== undefined) {
      onConnectionChange({ address: account.address, chainId: account.chainId });
    } else {
      onConnectionChange(null);
    }
  }, [isConnected, account.address, account.chainId, onConnectionChange]);
  async function prove() {
    const signingAddress = account.address;
    if (!authenticated || !isConnected || !signingAddress) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (
        account.chainId === undefined ||
        ![1, 42161, 8453].includes(account.chainId)
      )
        throw new Error(
          "Connect Ethereum, Arbitrum or Base before verification.",
        );
      const first = await fetch("/api/wallets/challenge", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: "EVM",
          chainId: account.chainId,
          address: signingAddress,
        }),
      });
      const challenge = await first.json();
      if (!first.ok)
        throw new Error(challenge.error?.code ?? "Challenge unavailable");
      const signature = await signMessageAsync({ message: challenge.message });
      const last = await fetch("/api/wallets/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
      const proof = await last.json();
      if (!last.ok || proof.verified !== true || proof.tradingEnabled !== false)
        throw new Error(proof.error?.code ?? "Signature rejected");
      await onVerified();
      setNotice(
        "Wallet ownership verified. Assign to a Shard below; live execution is disabled.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Wallet verification failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wallet-multi">
      <div className="wallet-step">REOWN APPKIT / EVM WALLETCONNECT</div>
      <h3>Browse supported wallets</h3>
      <p>
        Choose from the established wallet catalogue, installed wallets and
        mobile deep links for Ethereum, Arbitrum and Base.
      </p>
      <button
        type="button"
        className="wallet-button"
        onClick={() => void open({ view: "Connect" })}
      >
        Choose wallet →
      </button>
      {isConnected && address && (
        <div className="wallet-connected">
          <span>CONNECTED THROUGH APPKIT · NOT VERIFIED</span>
          <code>
            {address.slice(0, 8)}…{address.slice(-6)}
          </code>
          <button type="button" onClick={() => void open({ view: "Account" })}>
            Manage connection
          </button>
        </div>
      )}
      {isConnected && !authenticated && (
        <p className="wallet-detail">
          Sign in as a human operator before signing an EVM ownership proof.
        </p>
      )}
      {isConnected && authenticated && (
        <button
          type="button"
          className="wallet-button"
          disabled={busy}
          onClick={() => void prove()}
        >
          {busy ? "Verifying…" : "Verify wallet ownership"}
        </button>
      )}
      {error && (
        <p role="alert" className="wallet-notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="wallet-notice">
          {notice}
        </p>
      )}
      <p className="wallet-detail">
        Verification never enables withdrawals or live trading. ERC-1271
        contract-wallet signatures are not yet supported.
      </p>
    </div>
  );
}
export default function WalletKit(props: Props) {
  if (!wagmi)
    return (
      <p role="status">
        Reown needs NEXT_PUBLIC_REOWN_PROJECT_ID in Vercel to enable its wallet
        catalogue.
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
