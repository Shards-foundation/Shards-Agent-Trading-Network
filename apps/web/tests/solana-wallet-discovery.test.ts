import { describe, expect, it } from "vitest";
import { discoverSolanaWallets } from "../app/wallets/WalletConsole";

function provider() {
  return {
    connect: async () => ({
      publicKey: { toBase58: () => "11111111111111111111111111111111" },
    }),
    signMessage: async () => ({ signature: new Uint8Array(64) }),
  };
}

describe("explicit Solana wallet discovery", () => {
  it("lists Phantom and Solflare separately when both are installed", () => {
    const phantom = provider();
    const solflare = provider();
    const wallets = discoverSolanaWallets({
      phantom: { solana: phantom },
      solflare,
    });
    expect(wallets.map((w) => w.label)).toEqual(["Phantom", "Solflare"]);
    expect(wallets[0]?.provider).toBe(phantom);
    expect(wallets[1]?.provider).toBe(solflare);
  });

  it("deduplicates a legacy window.solana alias for Phantom", () => {
    const phantom = { ...provider(), isPhantom: true };
    const wallets = discoverSolanaWallets({
      phantom: { solana: phantom },
      solana: phantom,
    });
    expect(wallets).toHaveLength(1);
    expect(wallets[0]?.label).toBe("Phantom");
  });

  it("supports a single Solflare or generic injected Solana provider", () => {
    const solflare = { ...provider(), isSolflare: true };
    expect(
      discoverSolanaWallets({ solana: solflare }).map((w) => w.label),
    ).toEqual(["Solflare"]);
    expect(
      discoverSolanaWallets({ solana: provider() }).map((w) => w.label),
    ).toEqual(["Solana"]);
  });

  it("ignores malformed injection and never infers a connected session", () => {
    const bad = {
      connect: async () => ({ publicKey: undefined }),
    };
    expect(
      discoverSolanaWallets({
        solana: bad as unknown as ReturnType<typeof provider>,
      }),
    ).toEqual([]);
    expect(discoverSolanaWallets({})).toEqual([]);
  });
});
