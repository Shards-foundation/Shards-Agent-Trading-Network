import { createPublicKey, randomBytes, verify } from "node:crypto";

/** Solana base58 address decode, with strict canonical round-trip validation. */
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeSolanaAddress(value: string): Buffer | null {
  if (typeof value !== "string" || value.length < 32 || value.length > 44)
    return null;
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  const prefix = value.match(/^1*/)?.[0].length ?? 0;
  const decoded = Buffer.from([...Array(prefix).fill(0), ...bytes]);
  if (decoded.length !== 32) return null;
  return encodeSolanaAddress(decoded) === value ? decoded : null;
}
export function encodeSolanaAddress(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let output = "";
  while (value > 0n) {
    output = alphabet[Number(value % 58n)] + output;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = "1" + output;
  }
  return output;
}
export function newWalletChallenge(
  address: string,
  origin: string,
  expiresAt: Date,
): string {
  const site = new URL(origin);
  const nonce = randomBytes(24).toString("base64url");
  return [
    "Shards Agent Trading Network",
    "Purpose: Prove wallet ownership only; NO trading or spending authority.",
    `Domain: ${site.host}`,
    `URI: ${site.origin}`,
    "Chain: SOLANA",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}
export function verifySolanaWalletProof(
  address: string,
  message: string,
  signature: string,
): boolean {
  try {
    const pubkey = decodeSolanaAddress(address);
    if (!pubkey || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const bytes = Buffer.from(signature, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== signature)
      return false;
    // Ed25519 RFC 8410 SubjectPublicKeyInfo prefix, verified by OpenSSL.
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        pubkey,
      ]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message, "utf8"), key, bytes);
  } catch {
    return false;
  }
}
