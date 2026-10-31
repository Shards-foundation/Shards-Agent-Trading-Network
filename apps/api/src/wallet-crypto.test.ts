import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeSolanaAddress,
  encodeSolanaAddress,
  newWalletChallenge,
  verifySolanaWalletProof,
} from "./wallet-crypto.js";

describe("Solana wallet cryptographic proof", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = encodeSolanaAddress(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  );
  const message = newWalletChallenge(
    address,
    "https://satns.vercel.app",
    new Date("2026-11-01T00:00:00Z"),
  );
  const signature = sign(null, Buffer.from(message), privateKey).toString(
    "base64",
  );
  it("accepts an exact Ed25519 signature tied to the address and challenge", () => {
    expect(decodeSolanaAddress(address)).toHaveLength(32);
    expect(verifySolanaWalletProof(address, message, signature)).toBe(true);
  });
  it("rejects replay content changes, wrong address and corrupted signatures", () => {
    const other = generateKeyPairSync("ed25519");
    const otherAddress = encodeSolanaAddress(
      other.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    );
    expect(verifySolanaWalletProof(address, message + "!", signature)).toBe(
      false,
    );
    expect(verifySolanaWalletProof(otherAddress, message, signature)).toBe(
      false,
    );
    expect(verifySolanaWalletProof(address, message, "bad")).toBe(false);
  });
  it("rejects noncanonical Solana addresses", () => {
    expect(decodeSolanaAddress("O0Ilnotbase58")).toBeNull();
    expect(decodeSolanaAddress("1".repeat(33))).toBeNull();
    expect(decodeSolanaAddress("1".repeat(32))).toHaveLength(32);
  });
});
