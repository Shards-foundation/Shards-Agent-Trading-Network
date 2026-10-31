# SATNS — OpenTelemetry phase 1: optional, privacy-gated traces

**Status:** Implementation is opt-in, and export is **off by default**. This
document does not assert deployment, Sentry trace ingestion, or backend service
availability. The existing Sentry exception pipeline is preserved.

## Scope

- Uses the official `@opentelemetry/api` v1.10.0 (already present in the
  frozen dependency lock) to produce **manual** server-request and worker
  operation spans.
- Under Sentry JavaScript v11, `enableOpenTelemetrySetup: true` registers
  the lightweight OpenTelemetry-compatible tracer provider so these API spans
  can be captured as Sentry performance spans. **It is not an OTLP exporter,
  Collector, independent metrics service or full distributed tracer.**
- Existing Sentry error collection remains privacy-sanitised and enabled
  exactly as before if the DSN is present. Existing performance sampling
  remains **zero** unless the explicit opt-in is enabled.
- Changes to Next.js Sentry sampling, API-to-worker propagation, automatic
  HTTP/Prisma instrumentation and production Sentry configuration are
  deliberately excluded.

## Controls

| Setting | Default | Behaviour |
| --- | --- | --- |
| `SATNS_OTEL_ENABLED` | unset | Only literal `true` opts in; other values disable spans |
| `SENTRY_DSN` | existing backend secret | Required for opt-in; never commit or expose its value |
| `NODE_ENV=test` | tests only | Telemetry disabled to avoid real network export |
| Tracing sample rate | 0% | Fixed at **2%** when enabled; no override or high-volume surprise |
| Automatic integrations | disabled | Existing `defaultIntegrations: false` stays unchanged |

**Never set `SATNS_OTEL_ENABLED=true` in Vercel, Render, or another live
environment until the telemetry payload review and operator cost/privacy
approval have succeeded.** Merely merging this change activates no export.
No new SaaS account, infrastructure service or recurring expense is required.

## Captured spans (allowlist)

| Span | Allowed data | Explicit exclusions |
| --- | --- | --- |
| `satns.http.request` | HTTP method allowlist, Fastify **route template**, numeric HTTP status | Actual URL/path parameters, query, body, headers, cookies, access tokens, user/agent IDs, IP addresses, trade payloads |
| `satns.worker.system.healthcheck` | Fixed operation name and error status code | Queue payload, credential, job ID, exception description |
| `satns.worker.queue.stats` | Fixed operation name and error status code | Queue name, worker ID, connection details, values from stored task data |

The Sentry error exporter still runs its independent
`minimalSentryError` allowlist. Tracer/exporter errors must not affect
HTTP results, worker operations, risk limits or halt enforcement.

This first implementation produces **isolated, bounded spans**, not a
verified parent/child trace across Next.js, Fastify, PostgreSQL and Redis.
W3C propagation and process-local metrics remain a later separately tested
phase. Never propagate arbitrary public `traceparent` headers into
privileged agent or worker context without a defined trust policy.

## Test and rollout gate

1. Run frozen-lockfile install, typechecks, `pnpm test`, API/worker
   lifecycle smoke and browser E2E in GitHub CI on an exact reviewed SHA.
2. Unit-test literal opt-in, disabled-by-default, template-only route
   names, error privacy and nonblocking exporter failure.
3. Use a **disposable**, synthetic-data staging environment and a
   separately approved Sentry DSN. Enable `SATNS_OTEL_ENABLED=true`
   there only after privacy review.
4. Capture an actual Sentry performance trace and inspect the raw outbound
   envelope for URL query strings, bearer tokens, wallet keys, owner IDs and
   journal content. Confirm sampling is bounded and errors correlate.
5. Verify a disabled process produces no performance exports. Inject
   telemetry network failures and verify normal request/worker results.
6. Only after review of retention, processing region, quotas, alert policy and
   costs consider opt-in on production API/worker.

**No instrumentation provides immutable governance or trading audit logs.**
Maintain the existing controlled PostgreSQL audit and execution gates
separately. Live execution stays disabled.
