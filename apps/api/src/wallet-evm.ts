import { randomBytes } from "node:crypto";
import { getAddress, recoverMessageAddress } from "viem";

export const SUPPORTED_EVM_CHAINS = [1, 42161, 8453] as const;

export function canonicalEvmAddress(address: string): string | null {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    return getAddress(address);
  } catch {
    return null;
  }
}

/** EIP-4361 message, domain/URI, nonce and expiry minted exclusively by the server. */
export function newEvmWalletChallenge(
  address: string,
  chainId: number,
  origin: string,
  issuedAt: Date,
  expiresAt: Date,
): string {
  const canonical = canonicalEvmAddress(address);
  if (!canonical || !SUPPORTED_EVM_CHAINS.some(id => id === chainId))
    throw new Error("Unsupported EVM proof");
  const site = new URL(origin);
  if (site.protocol !== "https:" && !(site.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(site.hostname)))
    throw new Error("Non-secure SIWE origin");
  const nonce = randomBytes(16).toString("hex");
  return [
    `${site.host} wants you to sign in with your Ethereum account:`,
    canonical,
    "",
    "Verify wallet ownership for Shards only. No trading, transfer or withdrawal authority.",
    "",
    `URI: ${site.origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join("\n");
}

/** EOA signatures only. Contract-wallet ERC-1271 support requires trusted RPC and separate tests. */
export async function verifyEvmWalletProof(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const canonical = canonicalEvmAddress(address);
  if (!canonical || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return recovered === canonical;
  } catch {
    return false;
  }
}
