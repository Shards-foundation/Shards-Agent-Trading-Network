"use client";
import { createAppKit, useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { mainnet, arbitrum, base, type AppKitNetwork } from "@reown/appkit/networks";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";
const networks: [AppKitNetwork, ...AppKitNetwork[]] = [mainnet, arbitrum, base];
const wagmi = projectId ? new WagmiAdapter({ projectId, networks, ssr: true }) : null;
const queryClient = new QueryClient();
if (wagmi) {
  createAppKit({
    // The installed SDK publishes a narrower runtime adapter shape than its
    // TypeScript interface under exactOptionalPropertyTypes.
    adapters: [wagmi as unknown as Parameters<typeof createAppKit>[0]["adapters"][number]],
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
function Controls() {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount();
  return (
    <div className="wallet-multi">
      <div className="wallet-step">REOWN APPKIT / EVM WALLETCONNECT</div>
      <h3>Browse supported wallets</h3>
      <p>Choose from the established wallet catalogue, installed wallets and mobile deep links for Ethereum, Arbitrum and Base.</p>
      <button type="button" className="wallet-button" onClick={() => void open({ view: "Connect" })}>Choose wallet →</button>
      {isConnected && address && (
        <div className="wallet-connected">
          <span>CONNECTED THROUGH APPKIT · NOT VERIFIED</span>
          <code>{address.slice(0, 8)}…{address.slice(-6)}</code>
          <button type="button" onClick={() => void open({ view: "Account" })}>Manage connection</button>
        </div>
      )}
      {isConnected && <p className="wallet-detail">EVM wallet transport is connected. Ownership verification via SIWE is pending; this wallet cannot yet be assigned to a Shard or trade. Solana owners can use the independently verified Solana connection below.</p>}
    </div>
  );
}
export default function WalletKit() {
  if (!wagmi) return <p role="status">Reown needs NEXT_PUBLIC_REOWN_PROJECT_ID in Vercel to enable its wallet catalogue.</p>;
  return <WagmiProvider config={wagmi.wagmiConfig}>
    <QueryClientProvider client={queryClient}><Controls /></QueryClientProvider>
  </WagmiProvider>;
}
