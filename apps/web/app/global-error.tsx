"use client";
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SENTRY_DSN) Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          background: "#080b12",
          color: "#f5e8cc",
          fontFamily: "sans-serif",
          padding: "3rem",
        }}
      >
        <h1>SATNS — an unexpected error occurred</h1>
        <p>
          The network is temporarily unavailable. Trading execution remains
          disabled.
        </p>
        <button onClick={reset} type="button">
          Try again
        </button>
      </body>
    </html>
  );
}
