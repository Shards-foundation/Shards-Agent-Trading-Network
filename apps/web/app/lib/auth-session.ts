import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

const cookiePrefix = process.env.NODE_ENV === "production" ? "__Host-" : "";
export const SESSION_COOKIE = `${cookiePrefix}satn-session`;
export const OAUTH_STATE_COOKIE = `${cookiePrefix}satn-oauth-state`;
export const OAUTH_VERIFIER_COOKIE = `${cookiePrefix}satn-oauth-verifier`;
export const OAUTH_NONCE_COOKIE = `${cookiePrefix}satn-oauth-nonce`;
export const OAUTH_RETURN_COOKIE = `${cookiePrefix}satn-oauth-return`;

export function authConfig() {
  const { OIDC_CLIENT_ID, OIDC_AUTHORIZATION_ENDPOINT, OIDC_TOKEN_ENDPOINT,
    AUTH_PUBLIC_ORIGIN, SATN_SESSION_KEY } = process.env;
  if (!OIDC_CLIENT_ID || !OIDC_AUTHORIZATION_ENDPOINT || !OIDC_TOKEN_ENDPOINT || !AUTH_PUBLIC_ORIGIN || !SATN_SESSION_KEY) {
    throw new Error("Browser OIDC login is not configured.");
  }
  const endpoints = [OIDC_AUTHORIZATION_ENDPOINT, OIDC_TOKEN_ENDPOINT, AUTH_PUBLIC_ORIGIN].map((url) => new URL(url));
  if (endpoints.some((url) => url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost"))) {
    throw new Error("OIDC and public URLs must use HTTPS.");
  }
  const key = Buffer.from(SATN_SESSION_KEY, "base64url");
  if (key.length !== 32) throw new Error("SATN_SESSION_KEY must be 32 random bytes encoded as base64url.");
  return { clientId: OIDC_CLIENT_ID, authorise: endpoints[0]!, token: endpoints[1]!,
    origin: endpoints[2]!.origin, sessionKey: key };
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge };
}

export function encryptSession(token: string, expiresAt: number, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({ token, expiresAt }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function readSession(request: NextRequest): { token: string; expiresAt: number } | null {
  try {
    const input = request.cookies.get(SESSION_COOKIE)?.value;
    if (!input || input.length > 6000) return null;
    const raw = Buffer.from(input, "base64url");
    if (raw.length < 29) return null;
    const { sessionKey } = authConfig();
    const decipher = createDecipheriv("aes-256-gcm", sessionKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const decoded = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") return null;
    const { token, expiresAt } = decoded as Record<string, unknown>;
    return typeof token === "string" && token.length > 10 && typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) && expiresAt > Date.now() ? { token, expiresAt } : null;
  } catch { return null; }
}
