/**
 * SATNS error-telemetry allowlist.
 * This is intentionally stricter than standard PII scrubbing. Unknown event
 * types are discarded, not forwarded; never add user input or trade payloads.
 */
type Frame = { filename?: string; lineno?: number; colno?: number };
type Exception = { type?: string; value?: string; stacktrace?: { frames?: Frame[] } };
type ErrorLike = {
  event_id?: string;
  timestamp?: number;
  exception?: { values?: Exception[] };
};
const safeType = (input: unknown): string =>
  typeof input === "string" && /^[A-Za-z_$][A-Za-z0-9_.$-]{0,80}$/.test(input)
    ? input
    : "Error";
const safeFile = (input: unknown): string | undefined => {
  if (typeof input !== "string" || /[?#]/.test(input)) return undefined;
  const name = input.split(/[\\/]/).pop();
  return name && /^[A-Za-z0-9_.-]{1,90}$/.test(name) ? name : undefined;
};
const safePosition = (input: unknown): number | undefined =>
  typeof input === "number" && Number.isSafeInteger(input) && input >= 0
    ? input
    : undefined;

export function minimalSentryError<T extends ErrorLike>(event: T): T | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  return {
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: "error",
    exception: {
      values: values.slice(0, 3).map((entry) => ({
        type: safeType(entry.type),
        value: "Application error: private details withheld",
        stacktrace: {
          frames: (entry.stacktrace?.frames ?? []).slice(-30).map((frame) => ({
            filename: safeFile(frame.filename),
            lineno: safePosition(frame.lineno),
            colno: safePosition(frame.colno),
          })),
        },
      })),
    },
  } as T;
}
