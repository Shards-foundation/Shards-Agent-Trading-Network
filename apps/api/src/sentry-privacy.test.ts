import { describe, expect, it } from "vitest";
import { minimalSentryError } from "./sentry-privacy.js";

describe("privacy-first Sentry event allowlist", () => {
  it("retains only safe exception type, basename and line numbers", () => {
    const secret = "SATNS_SECRET_DO_NOT_SEND";
    const result = minimalSentryError({
      event_id: "123",
      timestamp: 1,
      message: secret,
      user: { email: "private@example.com" },
      request: { url: "/claim/" + secret, headers: { authorization: secret } },
      breadcrumbs: [{ message: secret }],
      extra: { journal: secret },
      contexts: { trace: { data: secret } },
      exception: {
        values: [{
          type: "TypeError",
          value: secret,
          stacktrace: { frames: [
            { filename: "/app/src/index.ts", lineno: 23, colno: 11 },
            { filename: "https://site.example/claim?token=" + secret, lineno: 2 },
          ] },
        }],
      },
    });
    expect(result?.exception?.values?.[0].type).toBe("TypeError");
    expect(result?.exception?.values?.[0].stacktrace?.frames?.[0].filename).toBe("index.ts");
    expect(result?.exception?.values?.[0].stacktrace?.frames?.[1].filename).toBeUndefined();
    const output = JSON.stringify(result);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private@example.com");
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("/claim/");
  });

  it("discards non-exception messages, traces, feedback, and forged types", () => {
    expect(minimalSentryError({ message: "private journal" })).toBeNull();
    const result = minimalSentryError({
      exception: { values: [{ type: "Error?password=abc", value: "wallet key" }] },
    });
    expect(result?.exception?.values?.[0].type).toBe("Error");
    expect(JSON.stringify(result)).not.toContain("wallet key");
  });
});
