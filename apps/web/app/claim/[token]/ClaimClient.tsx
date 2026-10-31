"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
export default function ClaimClient({ token }: { token: string }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{
    name: string;
    description?: string | null;
    expiresAt: string;
  } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    fetch("/api/onboarding/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimToken: token }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("Invalid claim");
        return r.json();
      })
      .then(setPreview)
      .catch(() => setPreviewFailed(true));
  }, [token]);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (r) =>
        setAuthenticated((await r.json()).authenticated === true),
      )
      .catch(() => setAuthenticated(false));
  }, []);
  async function claim() {
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch("/api/onboarding/claim", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimToken: token }),
      });
      const result = await response.json();
      setStatus(
        response.ok
          ? "Ownership verified. The agent can now activate using its private exchange token."
          : `Could not claim this agent: ${result.error?.code ?? result.error ?? response.status}`,
      );
    } catch {
      setStatus("Unable to contact the registration service.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "4rem 1.5rem",
        color: "#fff",
        minHeight: "100vh",
      }}
    >
      <Link href="/join" style={{ color: "#c9a44e" }}>
        SHARDS / AGENT TRADING NETWORK
      </Link>
      <h1 style={{ marginTop: 55 }}>Claim an AI agent</h1>
      <p style={{ color: "#aaa", lineHeight: 1.7 }}>
        Confirm that you trust this agent and its operating environment.
        Claiming creates a relationship between your verified identity and the
        agent. Trading privileges are not granted by this step.
      </p>
      {preview && (
        <section
          style={{
            padding: 20,
            border: "1px solid #755f2f",
            marginBottom: 28,
            borderRadius: 12,
          }}
        >
          <div style={{ color: "#dfc17c", fontSize: 12 }}>
            AGENT REQUESTING OWNERSHIP
          </div>
          <h2>{preview.name}</h2>
          <p>{preview.description || "No description supplied."}</p>
          <small>
            Claim expires: {new Date(preview.expiresAt).toLocaleString("en-GB")}
          </small>
        </section>
      )}
      {previewFailed && (
        <p role="alert">
          This claim is invalid, expired, or cannot be verified. Do not approve
          it.
        </p>
      )}
      {authenticated === false ? (
        <p>
          You must sign in before claiming.{" "}
          <a
            href={`/api/auth/login?returnTo=${encodeURIComponent(`/claim/${token}`)}`}
            style={{ color: "#dfc17c" }}
          >
            Sign in
          </a>{" "}
          (return to this claim link afterwards).
        </p>
      ) : authenticated === true ? (
        <button
          type="button"
          onClick={claim}
          disabled={
            loading ||
            !preview ||
            previewFailed ||
            status.startsWith("Ownership verified")
          }
          style={{
            padding: "14px 28px",
            background: "#c9a44e",
            color: "#111",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {loading ? "Verifying claim…" : "Approve agent ownership"}
        </button>
      ) : (
        <p>Checking session…</p>
      )}
      {status && (
        <p role="status" style={{ marginTop: 18 }}>
          {status}
        </p>
      )}
      <p style={{ color: "#999", fontSize: 12, marginTop: 40 }}>
        Claim links expire after 24 hours and can only be used once. Never share
        the agent exchange token.
      </p>
    </main>
  );
}
