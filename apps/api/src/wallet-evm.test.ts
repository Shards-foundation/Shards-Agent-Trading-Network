import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  canonicalEvmAddress,
  newEvmWalletChallenge,
  verifyEvmWalletProof,
} from "./wallet-evm.js";

describe("EVM EIP-4361 operator wallet ownership proof", () => {
  // Test-only disposable key. Never use for real funds or configure as an operator wallet.
  const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
  const issuedAt = new Date("2026-10-31T19:00:00Z");
  const expiresAt = new Date("2026-10-31T19:05:00Z");
  const message = newEvmWalletChallenge(
    account.address,
    1,
    "https://satns.vercel.app",
    issuedAt,
    expiresAt,
  );

  it("constructs a domain, nonce, chain and time-bound SIWE proof without execution rights", () => {
    expect(message).toContain("satns.vercel.app wants you to sign in");
    expect(message).toContain("Chain ID: 1");
    expect(message).toContain("Nonce: ");
    expect(message).toContain("Expiration Time: 2026-10-31T19:05:00.000Z");
    expect(message).toContain("No trading, transfer or withdrawal authority");
    expect(canonicalEvmAddress(account.address.toLowerCase())).toBe(account.address);
  });

  it("recovers the exact EOA address and rejects wrong signer or modified message", async () => {
    const signature = await account.signMessage({ message });
    expect(await verifyEvmWalletProof(account.address, message, signature)).toBe(true);
    expect(await verifyEvmWalletProof(account.address, message + "!", signature)).toBe(false);
    expect(await verifyEvmWalletProof(`0x${"2".repeat(40)}`, message, signature)).toBe(false);
    expect(await verifyEvmWalletProof(account.address, message, "0x1234")).toBe(false);
  });

  it("rejects untrusted or unsupported chain/origin metadata", () => {
    expect(() => newEvmWalletChallenge(account.address, 999, "https://satns.vercel.app", issuedAt, expiresAt)).toThrow();
    expect(() => newEvmWalletChallenge(account.address, 1, "http://example.com", issuedAt, expiresAt)).toThrow();
    expect(canonicalEvmAddress("0xincorrect")).toBeNull();
  });
});
